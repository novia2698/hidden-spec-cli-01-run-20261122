# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/novia2698/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/novia2698/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every edit format an AI agent
writes. Feed it a unified diff, a SEARCH/REPLACE block, a V4A patch, or a
JSON tool call, and it applies the edits to the tree of text files in the
working directory — finding the lines each edit names even when the model
drifted their whitespace or indentation, and writing every change or none
at all when any single edit fails.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a file holding the patch; without it, the patch is read from
standard input. `--format` picks `unified`, `search-replace`, `v4a`, or
`json` (default `auto` detects the format). `--check` validates and reports
without writing anything. `--strict` matches lines exactly, with no fuzzy
fallback.

## How it works

Each edit locates its target at the first matching tier that finds it:
exact lines, then whitespace-tolerant matching, then matching that also
tolerates blank-line drift. Every edit is validated against the original
tree before anything is written, so a failed patch leaves the tree exactly
as it was. Paths are confined to the working tree, and exit codes and
stdout follow SPEC.md exactly: `ok` lines and `applied: <n> edits` on
success, one `error: <code> <path>` per failed edit plus a `failed:` summary
on failure, and a single `error:` line for usage, missing-patch, format, and
parse errors.

Practice score on the kit's 100 public checks: 100/100.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bpr1tvsc&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
