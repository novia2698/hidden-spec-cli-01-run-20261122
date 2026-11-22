// mend: one patch tool for every AI edit format.
//
// Reads a patch (unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits),
// applies its edits to the tree rooted at the working directory, and prints
// what changed or why it failed. See SPEC.md for the whole contract.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, this file hands the trial over to runner.ts.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runTrial } from "./runner.ts";

// ---------------------------------------------------------------------------
// Small types
// ---------------------------------------------------------------------------

type Fail = { code: string; path: string };

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

interface Edit {
  /** Paths the edit names, in the order they are checked for safety. */
  paths: string[];
  apply(tree: Tree): Fail | null;
}

// ---------------------------------------------------------------------------
// Text: files and patch lines (SPEC.md section 3)
// ---------------------------------------------------------------------------

interface FileState {
  raw: string;
  lines: string[];
  eol: "\r\n" | "\n";
  endsBreak: boolean;
}

function parseFile(raw: string): FileState {
  if (raw === "") return { raw, lines: [], eol: "\n", endsBreak: false };
  const nl = raw.indexOf("\n");
  const eol: "\r\n" | "\n" = nl > 0 && raw[nl - 1] === "\r" ? "\r\n" : "\n";
  const endsBreak = raw.endsWith(eol);
  const parts = raw.split(eol);
  if (endsBreak) parts.pop();
  return { raw, lines: parts, eol, endsBreak };
}

function serializeFile(state: FileState): string {
  if (state.lines.length === 0) return "";
  return state.lines.join(state.eol) + (state.endsBreak ? state.eol : "");
}

function withLines(state: FileState, lines: string[], endsBreak?: boolean): FileState {
  const next: FileState = {
    raw: "",
    lines,
    eol: state.eol,
    endsBreak: endsBreak === undefined ? state.endsBreak : endsBreak,
  };
  next.raw = serializeFile(next);
  return next;
}

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function trimEndWs(line: string): string {
  return line.replace(/[ \t\r]+$/, "");
}

// ---------------------------------------------------------------------------
// Paths (SPEC.md section 3)
// ---------------------------------------------------------------------------

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function stripBothWs(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

function findOccurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!lineMatches(lines[i + j], oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 with --strict) at which O occurs. */
function findTier(
  lines: string[],
  oldLines: string[],
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = findOccurrences(lines, oldLines, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

interface NewLine {
  text: string;
  /** True for a context line: written as the file's own matched line. */
  ctx: boolean;
  /** Index into O of the context line this N line mirrors. */
  oIndex: number;
}

/**
 * Build the replacement lines for a matched occurrence at `pos`.
 * Context lines come from the file; other lines are re-indented at tier 2.
 */
function buildNewLines(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  newLines: NewLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  const f = oldLines.length > 0 ? leadingWs(fileLines[pos]) : "";
  const p = oldLines.length > 0 ? leadingWs(oldLines[0]) : "";
  for (const nl of newLines) {
    if (nl.ctx) {
      out.push(fileLines[pos + nl.oIndex]);
      continue;
    }
    let text = nl.text;
    if (tier === 2 && text !== "" && text.trim() !== "" && text.startsWith(p)) {
      text = f + text.slice(p.length);
    }
    out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The working tree (SPEC.md section 10)
// ---------------------------------------------------------------------------

class Tree {
  /** Current state per path; null means the file is gone. */
  private states = new Map<string, FileState | null>();
  /** Raw bytes each path had when first observed; null means it did not exist. */
  private origRaw = new Map<string, string | null>();
  /** Moves that succeeded, for the R lines of the output. */
  moves: { oldPath: string; newPath: string }[] = [];
  strict = false;

  private ensure(path: string): FileState | null {
    if (!this.states.has(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        this.states.set(path, parseFile(raw));
        this.origRaw.set(path, raw);
      } catch {
        this.states.set(path, null);
        this.origRaw.set(path, null);
      }
    }
    return this.states.get(path) ?? null;
  }

  exists(path: string): boolean {
    return this.ensure(path) !== null;
  }

  read(path: string): FileState | null {
    return this.ensure(path);
  }

  /** Register a path that an edit may create, so the output sees it. */
  touch(path: string): void {
    this.ensure(path);
  }

  write(path: string, state: FileState): void {
    this.ensure(path);
    this.states.set(path, state);
  }

  writeRaw(path: string, raw: string): void {
    this.write(path, parseFile(raw));
  }

  remove(path: string): void {
    this.ensure(path);
    this.states.set(path, null);
  }

  /** A shallow copy is enough: file states are never mutated in place. */
  snapshot(): { states: Map<string, FileState | null>; moves: number } {
    return { states: new Map(this.states), moves: this.moves.length };
  }

  restore(snap: { states: Map<string, FileState | null>; moves: number }): void {
    this.states = new Map(snap.states);
    this.moves.length = snap.moves;
  }

  /** Lines for the exit-0 output, in byte order of the paths (R lines by new path). */
  outputLines(): { key: string; line: string }[] {
    const out: { key: string; line: string }[] = [];
    const covered = new Set<string>();
    for (const m of this.moves) {
      const oldOrig = this.origRaw.get(m.oldPath);
      const newOrig = this.origRaw.get(m.newPath);
      const oldCur = this.states.get(m.oldPath);
      const newCur = this.states.get(m.newPath);
      if (
        oldOrig !== null &&
        oldOrig !== undefined &&
        oldCur === null &&
        (newOrig === null || newOrig === undefined) &&
        newCur !== null
      ) {
        out.push({ key: m.newPath, line: `R ${m.oldPath} -> ${m.newPath}` });
        covered.add(m.oldPath);
        covered.add(m.newPath);
      }
    }
    for (const [p, orig] of this.origRaw) {
      if (covered.has(p)) continue;
      const cur = this.states.get(p) ?? null;
      const curRaw = cur === null ? null : cur.raw;
      if (curRaw === orig) continue;
      if (orig === null) out.push({ key: p, line: `A ${p}` });
      else if (curRaw === null) out.push({ key: p, line: `D ${p}` });
      else out.push({ key: p, line: `M ${p}` });
    }
    out.sort((a, b) =>
      Buffer.compare(Buffer.from(a.key, "utf8"), Buffer.from(b.key, "utf8")),
    );
    return out;
  }

  /** Write every change to disk; files whose bytes did not change are untouched. */
  flush(): void {
    for (const [p, orig] of this.origRaw) {
      const cur = this.states.get(p) ?? null;
      const curRaw = cur === null ? null : cur.raw;
      if (curRaw === orig) continue;
      if (curRaw === null) {
        if (existsSync(p)) rmSync(p);
      } else {
        const dir = dirname(p);
        if (dir !== "" && dir !== ".") mkdirSync(dir, { recursive: true });
        writeFileSync(p, curRaw, "utf8");
      }
    }
  }
}

/** First unsafe path among `paths`, or null when every one is safe. */
function firstUnsafe(paths: string[]): string | null {
  for (const p of paths) {
    if (!isSafePath(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

type BodyKind = "ctx" | "del" | "add" | "bs";
interface BodyLine {
  kind: BodyKind;
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  /** True when a `\` line follows the hunk's last context or `+` line. */
  noNewlineAtEnd: boolean;
}

interface UnifiedSection {
  oldPath: string;
  newPath: string;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
  startLine: number;
}

function parseDiffPath(line: string, lineNo: number): string {
  const text = line.slice(4);
  const tab = text.indexOf("\t");
  const raw = (tab >= 0 ? text.slice(0, tab) : text).trim();
  let p = raw;
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

function parseDiffGit(line: string, lineNo: number): { oldPath: string; newPath: string } {
  const rest = line.slice("diff --git ".length);
  if (!rest.startsWith("a/")) throw new ParseError(lineNo);
  const sep = rest.indexOf(" b/", 2);
  if (sep < 0) throw new ParseError(lineNo);
  const oldPath = rest.slice(2, sep);
  const newPath = rest.slice(sep + 3);
  if (oldPath === "" || newPath === "") throw new ParseError(lineNo);
  return { oldPath, newPath };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function isBodyLine(line: string): boolean {
  return (
    line === "" ||
    line.startsWith(" ") ||
    line.startsWith("-") ||
    line.startsWith("+") ||
    line.startsWith("\\")
  );
}

function parseHunk(lines: string, start: number): { hunk: Hunk; next: number } {
  const head = lines[start];
  const m = HUNK_HEAD.exec(head);
  if (!m) throw new ParseError(start + 1);
  const a = parseInt(m[1], 10);
  const body: BodyLine[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) break;
    if (line.startsWith("@@")) break;
    if (line.startsWith("--- ") && lines[i + 1] !== undefined && lines[i + 1].startsWith("+++ ")) break;
    if (!isBodyLine(line)) break;
    if (line === "") body.push({ kind: "ctx", text: "" });
    else if (line.startsWith(" ")) body.push({ kind: "ctx", text: line.slice(1) });
    else if (line.startsWith("-")) body.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith("+")) body.push({ kind: "add", text: line.slice(1) });
    else body.push({ kind: "bs", text: line.slice(1) });
    i++;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === "ctx" && last.text === "" && lines[start + 1 + body.length - 1] === "") {
      body.pop();
    } else break;
  }
  let noNewlineAtEnd = false;
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j].kind === "ctx" || body[j].kind === "add") {
      noNewlineAtEnd = j + 1 < body.length && body[j + 1].kind === "bs";
      break;
    }
  }
  return { hunk: { a, body, noNewlineAtEnd }, next: i };
}

function parseUnifiedSection(
  lines: string[],
  start: number,
): { section: UnifiedSection; next: number } {
  let i = start;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  if (lines[i].startsWith("diff --git ")) {
    const d = parseDiffGit(lines[i], i + 1);
    diffOld = d.oldPath;
    diffNew = d.newPath;
    i++;
  }
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let create = false;
  let remove = false;
  // Header: before the first hunk.
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("@@")) break;
    if (line.startsWith("diff --git ")) break;
    if (line.startsWith("--- ")) {
      if (lines[i + 1] === undefined || !lines[i + 1].startsWith("+++ ")) {
        throw new ParseError(i + 2);
      }
      oldPath = parseDiffPath(line, i + 1);
      newPath = parseDiffPath(lines[i + 1], i + 2);
      i += 2;
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = parseDiffPath(line, i + 1);
      i++;
      continue;
    }
    if (line.startsWith("rename from ")) {
      renameFrom = line.slice("rename from ".length).trim();
      i++;
      continue;
    }
    if (line.startsWith("rename to ")) {
      renameTo = line.slice("rename to ".length).trim();
      i++;
      continue;
    }
    if (line === "new file mode" || line.startsWith("new file mode ")) {
      create = true;
      i++;
      continue;
    }
    if (line === "deleted file mode" || line.startsWith("deleted file mode ")) {
      remove = true;
      i++;
      continue;
    }
    i++;
  }
  // Hunks, with prose between them ignored.
  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("@@")) {
      const parsed = parseHunk(lines, i);
      hunks.push(parsed.hunk);
      i = parsed.next;
      continue;
    }
    if (line.startsWith("diff --git ")) break;
    if (line.startsWith("--- ") && lines[i + 1] !== undefined && lines[i + 1].startsWith("+++ ")) break;
    i++;
  }
  const resolvedOld = oldPath ?? renameFrom ?? diffOld;
  const resolvedNew = newPath ?? renameTo ?? diffNew;
  if (resolvedOld === null || resolvedNew === null) throw new ParseError(start + 1);
  if (resolvedOld === "/dev/null") create = true;
  if (resolvedNew === "/dev/null") remove = true;
  return {
    section: {
      oldPath: resolvedOld,
      newPath: resolvedNew,
      create,
      remove,
      hunks,
      startLine: start + 1,
    },
    next: i,
  };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const parsed = parseUnifiedSection(lines, i);
      sections.push(parsed.section);
      i = parsed.next;
      continue;
    }
    if (line.startsWith("--- ") && lines[i + 1] !== undefined && lines[i + 1].startsWith("+++ ")) {
      const parsed = parseUnifiedSection(lines, i);
      sections.push(parsed.section);
      i = parsed.next;
      continue;
    }
    if (line.startsWith("@@")) throw new ParseError(i + 1);
    i++;
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections.map((s) => unifiedEdit(s));
}

/** Split a hunk body into its old lines O and new lines N (with context marks). */
function hunkOldNew(hunk: Hunk): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const b of hunk.body) {
    if (b.kind === "bs") continue;
    if (b.kind === "ctx") {
      const oIndex = oldLines.length;
      oldLines.push(b.text);
      newLines.push({ text: b.text, ctx: true, oIndex });
    } else if (b.kind === "del") {
      oldLines.push(b.text);
    } else {
      newLines.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { oldLines, newLines };
}

/** Apply one hunk to a file's lines; returns the new state or a failure. */
function applyHunk(
  state: FileState,
  hunk: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { state: FileState; d: number } | Fail {
  const { oldLines, newLines } = hunkOldNew(hunk);
  const lines = state.lines;
  if (oldLines.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, lines.length));
    const built = buildNewLines(lines, at, oldLines, newLines, 0);
    const next = [...lines.slice(0, at), ...built, ...lines.slice(at)];
    let endsBreak = state.endsBreak;
    if (at === lines.length) endsBreak = !hunk.noNewlineAtEnd;
    return { state: withLines(state, next, endsBreak), d: d + newLines.length };
  }
  const found = findTier(lines, oldLines, strict);
  if (found === null) return { code: "no-match", path };
  const target = hunk.a - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const pos of found.occ) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const built = buildNewLines(lines, best, oldLines, newLines, found.tier);
  const next = [...lines.slice(0, best), ...built, ...lines.slice(best + oldLines.length)];
  let endsBreak = state.endsBreak;
  if (best + oldLines.length === lines.length) endsBreak = !hunk.noNewlineAtEnd;
  return { state: withLines(state, next, endsBreak), d: d + newLines.length - oldLines.length };
}

function unifiedEdit(section: UnifiedSection): Edit {
  const realOld = section.oldPath === "/dev/null" ? null : section.oldPath;
  const realNew = section.newPath === "/dev/null" ? null : section.newPath;
  const paths: string[] = [];
  if (realOld !== null) paths.push(realOld);
  if (realNew !== null && realNew !== realOld) paths.push(realNew);
  return {
    paths,
    apply(tree: Tree): Fail | null {
      const unsafe = firstUnsafe(paths);
      if (unsafe !== null) return { code: "unsafe", path: unsafe };
      const strict = tree.strict;
      if (section.create && realNew !== null) {
        if (tree.exists(realNew)) return { code: "exists", path: realNew };
        const added: string[] = [];
        let endsBreak = true;
        for (const hunk of section.hunks) {
          for (const b of hunk.body) {
            if (b.kind === "add") added.push(b.text);
          }
          if (hunk.body.some((b) => b.kind === "add")) {
            endsBreak = !hunk.noNewlineAtEnd;
          }
        }
        tree.touch(realNew);
        tree.write(realNew, withLines(parseFile(""), added, endsBreak));
        return null;
      }
      if (section.remove && realOld !== null) {
        if (!tree.exists(realOld)) return { code: "missing", path: realOld };
        tree.remove(realOld);
        return null;
      }
      if (realOld !== null && realNew !== null && realOld !== realNew) {
        if (!tree.exists(realOld)) return { code: "missing", path: realOld };
        if (tree.exists(realNew)) return { code: "exists", path: realNew };
        let state = tree.read(realOld);
        if (state === null) return { code: "missing", path: realOld };
        let d = 0;
        for (const hunk of section.hunks) {
          const res = applyHunk(state, hunk, d, strict, realOld);
          if ("code" in res) return res;
          state = res.state;
          d = res.d;
        }
        tree.remove(realOld);
        tree.touch(realNew);
        tree.write(realNew, state);
        tree.moves.push({ oldPath: realOld, newPath: realNew });
        return null;
      }
      const path = realOld ?? realNew;
      if (path === null) return { code: "missing", path: section.oldPath };
      if (!tree.exists(path)) return { code: "missing", path };
      let state = tree.read(path);
      if (state === null) return { code: "missing", path };
      let d = 0;
      for (const hunk of section.hunks) {
        const res = applyHunk(state, hunk, d, strict, path);
        if ("code" in res) return res;
        state = res.state;
        d = res.d;
      }
      tree.write(path, state);
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLine: number;
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  while (i < lines.length) {
    if (trimEndWs(lines[i]) !== "<<<<<<< SEARCH") {
      i++;
      continue;
    }
    const searchLine = i;
    let j = i + 1;
    while (j < lines.length && trimEndWs(lines[j]) !== "=======") j++;
    if (j >= lines.length) throw new ParseError(searchLine + 1);
    let k = j + 1;
    while (k < lines.length && trimEndWs(lines[k]) !== ">>>>>>> REPLACE") k++;
    if (k >= lines.length) throw new ParseError(searchLine + 1);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let p = i - 1; p > prevEnd; p--) {
      const line = lines[p];
      if (isBlank(line)) continue;
      if (line.trim().startsWith("```")) continue;
      path = line.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new ParseError(searchLine + 1);
      path = blocks[blocks.length - 1].path;
    }
    blocks.push({ path, oldLines, newLines, searchLine: searchLine + 1 });
    prevEnd = k;
    i = k + 1;
  }
  if (blocks.length === 0) throw new ParseError(1);
  return blocks.map((b) => searchReplaceEdit(b));
}

function searchReplaceEdit(block: SearchReplaceBlock): Edit {
  return {
    paths: [block.path],
    apply(tree: Tree): Fail | null {
      const unsafe = firstUnsafe([block.path]);
      if (unsafe !== null) return { code: "unsafe", path: unsafe };
      if (block.oldLines.length === 0) {
        if (tree.exists(block.path)) return { code: "exists", path: block.path };
        tree.touch(block.path);
        tree.write(
          block.path,
          withLines(parseFile(""), [...block.newLines], true),
        );
        return null;
      }
      if (!tree.exists(block.path)) return { code: "missing", path: block.path };
      const state = tree.read(block.path);
      if (state === null) return { code: "missing", path: block.path };
      const found = findTier(state.lines, block.oldLines, tree.strict);
      if (found === null) return { code: "no-match", path: block.path };
      if (found.occ.length > 1) return { code: "ambiguous", path: block.path };
      const pos = found.occ[0];
      const newLines: NewLine[] = block.newLines.map((text) => ({
        text,
        ctx: false,
        oIndex: -1,
      }));
      const built = buildNewLines(state.lines, pos, block.oldLines, newLines, found.tier);
      const next = [
        ...state.lines.slice(0, pos),
        ...built,
        ...state.lines.slice(pos + block.oldLines.length),
      ];
      tree.write(block.path, withLines(state, next));
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

type V4ASection =
  | { kind: "add"; path: string; fileLines: string[]; line: number }
  | { kind: "delete"; path: string; line: number }
  | {
      kind: "update";
      path: string;
      moveTo: string | null;
      chunks: V4AChunk[];
      line: number;
    };

interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new ParseError(1);
  if (lines[first].trim() !== "*** Begin Patch") throw new ParseError(first + 1);
  if (lines[last].trim() !== "*** End Patch") throw new ParseError(lines.length + 1);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      const start = i;
      i++;
      const raw: { text: string; lineNo: number }[] = [];
      while (i < last && !isSectionStart(lines[i])) {
        raw.push({ text: lines[i], lineNo: i + 1 });
        i++;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === "") fileLines.push("");
        else if (r.text.startsWith("+")) fileLines.push(r.text.slice(1));
        else throw new ParseError(r.lineNo);
      }
      sections.push({ kind: "add", path, fileLines, line: start + 1 });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      const start = i;
      i++;
      const raw: { text: string; lineNo: number }[] = [];
      while (i < last && !isSectionStart(lines[i])) {
        raw.push({ text: lines[i], lineNo: i + 1 });
        i++;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
      for (const r of raw) throw new ParseError(r.lineNo);
      sections.push({ kind: "delete", path, line: start + 1 });
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      const start = i;
      i++;
      const raw: { text: string; lineNo: number }[] = [];
      while (i < last && !isSectionStart(lines[i])) {
        raw.push({ text: lines[i], lineNo: i + 1 });
        i++;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
      const section = parseV4AUpdate(path, raw, start + 1);
      sections.push(section);
      continue;
    }
    throw new ParseError(i + 1);
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections.map((s) => v4aEdit(s));
}

function isSectionStart(line: string): boolean {
  return (
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ") ||
    line.trim() === "*** End Patch"
  );
}

function parseV4AUpdate(
  path: string,
  raw: { text: string; lineNo: number }[],
  lineNo: number,
): V4ASection {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0].text.startsWith("*** Move to: ")) {
    moveTo = raw[0].text.slice("*** Move to: ".length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let current: V4AChunk | null = null;
  let afterEof = false;
  const isBody = (t: string): boolean =>
    t === "" || t.startsWith(" ") || t.startsWith("-") || t.startsWith("+");
  for (; idx < raw.length; idx++) {
    const { text, lineNo: ln } = raw[idx];
    if (text.startsWith("@@")) {
      if (current !== null) chunks.push(current);
      const anchor = text.slice(2).trim();
      current = { anchor: anchor === "" ? null : anchor, body: [], eof: false };
      afterEof = false;
      continue;
    }
    if (text.trim() === "*** End of File") {
      if (current === null) throw new ParseError(ln);
      current.eof = true;
      chunks.push(current);
      current = null;
      afterEof = true;
      continue;
    }
    if (isBody(text)) {
      if (current === null) {
        if (chunks.length === 0 && !afterEof) {
          current = { anchor: null, body: [], eof: false };
        } else {
          throw new ParseError(ln);
        }
      }
      if (text === "") current.body.push({ kind: "ctx", text: "" });
      else if (text.startsWith(" ")) current.body.push({ kind: "ctx", text: text.slice(1) });
      else if (text.startsWith("-")) current.body.push({ kind: "del", text: text.slice(1) });
      else current.body.push({ kind: "add", text: text.slice(1) });
      continue;
    }
    throw new ParseError(ln);
  }
  if (current !== null) chunks.push(current);
  if (chunks.length === 0 && moveTo === null) throw new ParseError(lineNo);
  return { kind: "update", path, moveTo, chunks, line: lineNo };
}

/** First line at or after `cursor` equal to `anchor` at the first tier with one. */
function findAnchor(
  lines: string[],
  cursor: number,
  anchor: string,
  strict: boolean,
): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let j = cursor; j < lines.length; j++) {
      if (lineMatches(lines[j], anchor, tier)) return j;
    }
  }
  return null;
}

function v4aEdit(section: V4ASection): Edit {
  if (section.kind === "add") {
    return {
      paths: [section.path],
      apply(tree: Tree): Fail | null {
        const unsafe = firstUnsafe([section.path]);
        if (unsafe !== null) return { code: "unsafe", path: unsafe };
        if (tree.exists(section.path)) return { code: "exists", path: section.path };
        tree.touch(section.path);
        tree.write(
          section.path,
          withLines(parseFile(""), [...section.fileLines], true),
        );
        return null;
      },
    };
  }
  if (section.kind === "delete") {
    return {
      paths: [section.path],
      apply(tree: Tree): Fail | null {
        const unsafe = firstUnsafe([section.path]);
        if (unsafe !== null) return { code: "unsafe", path: unsafe };
        if (!tree.exists(section.path)) return { code: "missing", path: section.path };
        tree.remove(section.path);
        return null;
      },
    };
  }
  const paths: string[] = [section.path];
  if (section.moveTo !== null) paths.push(section.moveTo);
  return {
    paths,
    apply(tree: Tree): Fail | null {
      const unsafe = firstUnsafe(paths);
      if (unsafe !== null) return { code: "unsafe", path: unsafe };
      if (!tree.exists(section.path)) return { code: "missing", path: section.path };
      if (section.moveTo !== null && tree.exists(section.moveTo)) {
        return { code: "exists", path: section.moveTo };
      }
      let state = tree.read(section.path);
      if (state === null) return { code: "missing", path: section.path };
      let cursor = 0;
      for (const chunk of section.chunks) {
        if (chunk.anchor !== null) {
          const found = findAnchor(state.lines, cursor, chunk.anchor, tree.strict);
          if (found === null) return { code: "no-match", path: section.path };
          cursor = found + 1;
        }
        const oldLines: string[] = [];
        const newLines: NewLine[] = [];
        for (const b of chunk.body) {
          if (b.kind === "ctx") {
            const oIndex = oldLines.length;
            oldLines.push(b.text);
            newLines.push({ text: b.text, ctx: true, oIndex });
          } else if (b.kind === "del") {
            oldLines.push(b.text);
          } else {
            newLines.push({ text: b.text, ctx: false, oIndex: -1 });
          }
        }
        if (oldLines.length === 0) {
          const at = chunk.eof ? state.lines.length : cursor;
          const built = buildNewLines(state.lines, at, oldLines, newLines, 0);
          const next = [
            ...state.lines.slice(0, at),
            ...built,
            ...state.lines.slice(at),
          ];
          state = withLines(state, next);
          cursor = at + built.length;
          continue;
        }
        const found = findTierFrom(state.lines, oldLines, cursor, tree.strict);
        if (found === null) return { code: "no-match", path: section.path };
        let pos = found.occ[0];
        if (chunk.eof) {
          const atEnd = found.occ.find((p) => p + oldLines.length === state.lines.length);
          if (atEnd === undefined) return { code: "no-match", path: section.path };
          pos = atEnd;
        }
        const built = buildNewLines(state.lines, pos, oldLines, newLines, found.tier);
        const next = [
          ...state.lines.slice(0, pos),
          ...built,
          ...state.lines.slice(pos + oldLines.length),
        ];
        state = withLines(state, next);
        cursor = pos + built.length;
      }
      if (section.moveTo !== null) {
        tree.remove(section.path);
        tree.touch(section.moveTo);
        tree.write(section.moveTo, state);
        tree.moves.push({ oldPath: section.path, newPath: section.moveTo });
      } else {
        tree.write(section.path, state);
      }
      return null;
    },
  };
}

/** First tier at which O occurs at or after `from`; occurrences limited to there. */
function findTierFrom(
  lines: string[],
  oldLines: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = findOccurrences(lines, oldLines, tier).filter((p) => p >= from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

type JsonEditData =
  | { command: "create"; path: string; fileText: string }
  | { command: "str_replace"; path: string; oldStr: string; newStr: string }
  | { command: "insert"; path: string; insertLine: number; newStr: string };

function validateJsonEdit(value: unknown): JsonEditData | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.command !== "string") return null;
  if (typeof obj.path !== "string") return null;
  if (obj.command === "create") {
    if (typeof obj.file_text !== "string") return null;
    return { command: "create", path: obj.path, fileText: obj.file_text };
  }
  if (obj.command === "str_replace") {
    if (typeof obj.old_str !== "string" || obj.old_str === "") return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== "string") return null;
    return {
      command: "str_replace",
      path: obj.path,
      oldStr: obj.old_str,
      newStr: typeof obj.new_str === "string" ? obj.new_str : "",
    };
  }
  if (obj.command === "insert") {
    if (typeof obj.insert_line !== "number" || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== "string") return null;
    return {
      command: "insert",
      path: obj.path,
      insertLine: obj.insert_line,
      newStr: obj.new_str,
    };
  }
  return null;
}

function parseJson(text: string): Edit[] {
  const lines = splitPatchLines(text);
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank < 0) throw new ParseError(1);
  const firstChar = lines[firstNonBlank].trim()[0];
  if (firstChar === "[") {
    const arrayStartLine = firstNonBlank + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseError(arrayStartLine);
    }
    if (!Array.isArray(parsed)) throw new ParseError(arrayStartLine);
    if (parsed.length === 0) throw new ParseError(1);
    const edits: Edit[] = [];
    for (const item of parsed) {
      const data = validateJsonEdit(item);
      if (data === null) throw new ParseError(arrayStartLine);
      edits.push(jsonEdit(data));
    }
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    const data = validateJsonEdit(parsed);
    if (data === null) throw new ParseError(i + 1);
    edits.push(jsonEdit(data));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

/** Split new_str the way section 9 says: at \n, one trailing \r removed. */
function splitNewStr(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (s.endsWith("\n")) parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function countOccurrences(hay: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + 1;
  }
}

function jsonEdit(data: JsonEditData): Edit {
  return {
    paths: [data.path],
    apply(tree: Tree): Fail | null {
      const unsafe = firstUnsafe([data.path]);
      if (unsafe !== null) return { code: "unsafe", path: unsafe };
      if (data.command === "create") {
        if (tree.exists(data.path)) return { code: "exists", path: data.path };
        tree.touch(data.path);
        tree.writeRaw(data.path, data.fileText);
        return null;
      }
      if (!tree.exists(data.path)) return { code: "missing", path: data.path };
      const state = tree.read(data.path);
      if (state === null) return { code: "missing", path: data.path };
      if (data.command === "str_replace") {
        const crlf = state.eol === "\r\n";
        const text = crlf ? state.raw.replace(/\r\n/g, "\n") : state.raw;
        const oldStr = crlf ? data.oldStr.replace(/\r\n/g, "\n") : data.oldStr;
        const newStr = crlf ? data.newStr.replace(/\r\n/g, "\n") : data.newStr;
        const count = countOccurrences(text, oldStr);
        if (count === 0) return { code: "no-match", path: data.path };
        if (count > 1) return { code: "ambiguous", path: data.path };
        let result = text.replace(oldStr, newStr);
        if (crlf) result = result.replace(/\n/g, "\r\n");
        tree.writeRaw(data.path, result);
        return null;
      }
      const lines = state.lines;
      if (data.insertLine < 0 || data.insertLine > lines.length) {
        return { code: "no-match", path: data.path };
      }
      const added = splitNewStr(data.newStr);
      const next = [
        ...lines.slice(0, data.insertLine),
        ...added,
        ...lines.slice(data.insertLine),
      ];
      tree.write(data.path, withLines(state, next));
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4) and the command line (section 1)
// ---------------------------------------------------------------------------

const FORMATS = ["unified", "search-replace", "v4a", "json", "auto"];

function detectFormat(lines: string[]): string | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank < 0) return null;
  if (lines[firstNonBlank].trim() === "*** Begin Patch") return "v4a";
  const firstChar = lines[firstNonBlank].trimStart()[0];
  if (firstChar === "[" || firstChar === "{") return "json";
  for (let i = 0; i < lines.length; i++) {
    if (trimEndWs(lines[i]) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (
      lines[i].startsWith("--- ") &&
      lines[i + 1] !== undefined &&
      lines[i + 1].startsWith("+++ ")
    ) {
      return "unified";
    }
  }
  return null;
}

function outLine(text: string): void {
  process.stdout.write(text + "\n");
}

function main(): number {
  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  const seen = new Set<string>();
  let endOpts = false;
  let usage = false;
  for (const a of args) {
    if (!endOpts && a === "--") {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith("-") && a !== "-") {
      if (a === "--check") {
        if (seen.has("check")) usage = true;
        seen.add("check");
        check = true;
      } else if (a === "--strict") {
        if (seen.has("strict")) usage = true;
        seen.add("strict");
        strict = true;
      } else if (a.startsWith("--format=")) {
        if (seen.has("format")) usage = true;
        seen.add("format");
        format = a.slice("--format=".length);
        if (!FORMATS.includes(format)) usage = true;
      } else {
        usage = true;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) usage = true;
  if (usage) {
    outLine("error: usage");
    return 2;
  }
  const patchArg = positional.length === 1 ? positional[0] : null;
  let patchText: string;
  if (patchArg === null || patchArg === "-") {
    patchText = readFileSync(0, "utf8");
  } else {
    try {
      patchText = readFileSync(patchArg, "utf8");
    } catch {
      outLine("error: no-patch");
      return 2;
    }
  }
  const lines = splitPatchLines(patchText);
  let formatName = format;
  if (formatName === null || formatName === "auto") {
    formatName = detectFormat(lines);
    if (formatName === null) {
      outLine("error: format");
      return 2;
    }
  }
  let edits: Edit[];
  try {
    if (formatName === "unified") edits = parseUnified(lines);
    else if (formatName === "search-replace") edits = parseSearchReplace(lines);
    else if (formatName === "v4a") edits = parseV4A(lines);
    else edits = parseJson(patchText);
  } catch (err) {
    if (err instanceof ParseError) {
      outLine(`error: parse ${err.line}`);
      return 2;
    }
    throw err;
  }
  if (edits.length === 0) {
    outLine("error: parse 1");
    return 2;
  }
  const tree = new Tree();
  tree.strict = strict;
  const failures: Fail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    const fail = edit.apply(tree);
    if (fail !== null) {
      tree.restore(snap);
      failures.push(fail);
    }
  }
  if (failures.length > 0) {
    for (const f of failures) outLine(`error: ${f.code} ${f.path}`);
    outLine(`failed: ${failures.length} of ${edits.length} edits`);
    return 1;
  }
  const changed = tree.outputLines();
  if (!check) tree.flush();
  for (const c of changed) outLine(c.line);
  outLine(changed.length === 1 ? "ok: 1 file" : `ok: ${changed.length} files`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point (kept last: class declarations below the call would not exist yet)
// ---------------------------------------------------------------------------

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl) {
  await runTrial(envUrl);
} else {
  process.exitCode = main();
}
