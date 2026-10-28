---
name: ghost-fleet
description: Report ghost-kit readiness across every consumer repo on this machine — one matrix showing, per repo, which capabilities (frontend wave, backend wave, migration wave, merge-haunt) are READY, DEGRADED, BLOCKED or n/a, and why. Use when the user says "ghost fleet", "fleet status", "which repos are ready", "ghost doctor", "check my repos", or asks whether a repo can run a rite.
---

# Ghost Fleet

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Read-only. Runs `ghost-doctor.sh` in every repo that has a `.ghost/config.json`
and prints one matrix. Nothing is written anywhere.

## Steps

1. Locate the plugin and run the fleet report:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
GK_ROOT="${GHOST_KIT_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}}"
if [ -z "$GK_ROOT" ] && [ -x "$REPO_ROOT/.ghost/bin/resolve-plugin" ]; then
  GK_ROOT=$("$REPO_ROOT/.ghost/bin/resolve-plugin")
fi
if [ -z "$GK_ROOT" ]; then
  GK_SRC=$(jq -r '.["ghost-kit"].installLocation // empty' "$HOME/.claude/plugins/known_marketplaces.json" 2>/dev/null)
  GK_ROOT="$GK_SRC/plugins/ghost-hunting-core"
fi
"$GK_ROOT/scripts/ghost-fleet.sh"
```

   Add `--probe` to additionally RUN each repo's `db_script url` and check it
   returns a parseable DSN. Off by default because it executes repo scripts.
   Add `--root <dir>` (repeatable) if repos live outside the default search root.

2. Show the matrix verbatim, then explain only the rows that are not READY.
   Exit 3 means at least one repo is BLOCKED; exit 0 means none are.

3. For a single repo, run the doctor directly instead:

```bash
"$GK_ROOT/scripts/ghost-doctor.sh" --repo-root <path>   # add --probe / --json
```

## Reading the verdicts

| Verdict | Meaning |
|---|---|
| `READY` | every gate this capability needs is configured and present |
| `DEGRADED` | it will run, but a gate is silently skipped (e.g. no `db_migrate` → migration reversibility is never proven) |
| `BLOCKED` | it cannot run, or would run against the wrong engine |
| `n/a` | this repo never declared the capability — not a problem |

A **version skew** block (`skills are vX but vendored workflows are vY`) blocks
every capability on purpose: the engine that would execute is not the engine the
skills expect. Fix with `/ghost-sync`, then commit.

## Notes

- `n/a` is a real answer, not a failure. a frontend-only repo has no backend;
  some repos vendor no workflows at all.
- The same check runs automatically at session start (`--check` mode), which is
  silent unless something is BLOCKED.
- ghost doctor hoists engine rule R7 (`db_script` + `migration_gate` are required
  for the backend track) from run-time — where it fires only after ghosts are
  gathered and waves authored — to now.
