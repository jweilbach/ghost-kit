---
name: ghost-sync
description: Vendor/refresh ghost-kit workflow files (.claude/workflows/*.js) in this repo from the plugin's templates, rendered with this repo's .ghost/config.json. Use when the user says "ghost sync", "ghost-sync", "sync workflows", "update workflows", or when the SessionStart drift check reports vendored workflows are out of date.
---

# Ghost Sync

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Renders the ghost-kit workflow templates into this repo's
`.claude/workflows/` and records the sync state. The vendored files are plain
committed files — this skill is the ONLY thing that should write them.

## Steps

1. Locate the plugin source and run the renderer:

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
"$GK_ROOT/scripts/render-workflows.sh"
```

2. Report what happened:
   - `wrote: ...` lines — list the refreshed workflows AND any vendored payload
     scripts (e.g. `wrote: scripts/pg-smoke.sh`). Payload scripts are non-template
     artifacts copied verbatim by path: when a repo sets `.isolation.pg_smoke`,
     the renderer vendors the plugin's canonical `scripts-payload/pg-smoke.sh`
     (the genuine-Postgres ORM smoke gate for the rite-cadence backend track) to
     that path and records its sha256 under `.ghost/sync-state.json` → `scripts`.
   - No output before the `sync-state:` line — everything was already in sync; say so.
   - "exit 0 with no sync-state line" — this repo has no `.ghost/config.json`
     or vendors no workflows (`workflows.vendor` empty). Say so and stop —
     don't create config the repo didn't opt into.

3. If files were written, remind the user to **commit them before invoking any
   ritual**, and say why: the vendored `.js` files and `.ghost/sync-state.json`
   are what cloud/CI sessions read (no plugin source there), and the committed
   `sync-state.json` bundle is the `wf/` token skills send in `X-Ghost-Client`.
   `ghost-hunting-core:invoke-ritual` compares a workflow's header stamp against
   that file and REFUSES to execute on a mismatch, so an uncommitted refresh
   leaves the stamps disagreeing. Do NOT commit yourself unless asked.

4. Then report readiness — a successful sync says the files are current, NOT
   that the repo can actually run a rite (a hollowed-out `isolation` block
   renders deterministically and syncs perfectly clean):

```bash
"$GK_ROOT/scripts/ghost-doctor.sh"
```

   Show its capability matrix. If it exits 3, surface the BLOCK lines — those
   are things `/ghost-sync` cannot fix and the repo owner must. Use
   `ghost-hunting-core:ghost-fleet` for the same view across every repo.

## What this does NOT refresh

`/ghost-sync` vendors **workflows and payload scripts** into the repo. It does
**not** update the ghost-kit **skills** — those are served from the installed
plugin cache (`~/.claude/plugins/cache/ghost-kit/...`) and are refreshed by a
separate CLI step. This matters because behavior lives in skill prose, not only
in the engine: `ghost-hunting-core:invoke-ritual` is what pins engine resolution
to the main checkout and verifies the vendored bundle stamp. A repo that syncs
but runs year-old `invoke-ritual` prose gets fresh workflows executed under stale
semantics.

If the plugin version in `.ghost/sync-state.json` is newer than the installed
plugin, tell the user to **restart the session** — this marketplace is a
`directory` source loaded in place, so a restart alone picks up the current
plugin. Only if a restart does not move it is an install actually behind:

```bash
claude plugin update ghost-hunting-core@ghost-kit   # then RESTART the session
```

That command compares **version strings only** — it is a no-op, reporting
success, when content shipped under an unchanged version.

**`claude plugin marketplace update ghost-kit` is not sufficient** — it refreshes
marketplace metadata only, leaves the installed plugin at its old version, and
reports success, so it reads as though it worked. What is on disk:

```bash
jq -r .version ~/.claude/plugins/cache/ghost-kit/ghost-hunting-core/*/.claude-plugin/plugin.json | sort -V | tail -1
```

That listing proves what is **installed**, not what is **running** — a session
holds the prose it loaded at start, so a **restart** is required before an update
applies. The running version is the `PLUGIN_VERSION` literal in the Phase-0 block
of the skill that is executing; when it disagrees with what is on disk, the block
says so itself:

```
⚠ ghost-kit: this session runs v1.3.7 prose; v1.4.0 is on disk — ...RESTART
```

Confirm an update by restarting and reading that, never by a green `ghost doctor`.

## Notes

- Never hand-edit `.claude/workflows/ghost-lane.js` etc. in consumer repos —
  the header marks them DO NOT EDIT; changes belong in
  `ghosthunting/plugins/ghost-hunting-core/workflows/*.js.tmpl`, then re-sync.
- Vendored payload scripts (e.g. `scripts/pg-smoke.sh`) are ALSO DO-NOT-EDIT
  copies — edit the plugin's `scripts-payload/pg-smoke.sh`, then re-sync. The
  SessionStart drift check flags a tampered/stale vendored script the same way
  it flags a stale workflow.
- `.ghost/sync-state.json` (written by the renderer) carries the template
  bundle hash that skills report as `wf/` in the `X-Ghost-Client` header — the
  server compares it against its expected bundle and flags drift.
