---
name: invoke-ritual
description: Execute or resume a Ritual (workflow) — walks the stored DAG, spawns agent subagents for machine steps, spawns real ghosts for human steps, pauses on gates, and resumes idempotently across sessions. Also runs ad-hoc ghost chains ("bang through these 8 ghosts"). Use when the user says "invoke ritual", "run workflow", "resume ritual", "run ritual", "run these ghosts in order", or "invoke" followed by a workflow name — or with no arguments to browse available rituals and in-flight invocations.
---

# Invoke Ritual

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Execute a stored workflow (Ritual) or an ad-hoc ghost chain as a multi-agent
run (Invocation). **The backend is the state store; YOU are the engine.** Every
decision you make is journaled to the API the moment it happens — any later
session (including one that isn't you) can resume from exactly that state.

Arguments provided: `$ARGUMENTS`

## Modes & flags

| Invocation | Meaning |
|---|---|
| `/invoke-ritual` | **Browse**: list rituals + in-flight invocations; offer resume first |
| `/invoke-ritual <name\|id> [--input k=v ...]` | Run a ritual (auto-resumes an active invocation of it) |
| `/invoke-ritual --resume [run_id]` | Resume a specific (or most recent) paused invocation |
| `/invoke-ritual --ghosts id1,id2,... [--mode sequential\|parallel]` | Ad-hoc chain over explicit ghosts (order = execution order) |
| `/invoke-ritual --top N [priority]` | Ad-hoc over the top-N claimable ether ghosts (priority-sorted, oldest first). Confirm the picks with the user before creating |
| `/invoke-ritual --haunting <id> [--mode ...]` | Ad-hoc over a haunting's active ether ghosts |
| `/invoke-ritual --retry <run_id>` | Reset backfired steps to pending and resume a failed run |
| `/invoke-ritual --cancel <run_id>` | Cancel an invocation (+ EVPs on open spawned ghosts) |
| `/invoke-ritual --watch` | **Dispatch mode**: find ONE summoned or resumable invocation, channel it to its next pause/completion, then exit. Pair with `/loop` (e.g. `/loop 5m /invoke-ritual --watch`) to make the UI's Summon button real: runs queued from the app get picked up automatically |

Flags: `--local` (target the repo's local API — honored only when the repo's
`.ghost/config.json` sets `api.allow_local_switch: true`; set `GK_LOCAL=1`
before running the Phase 0 block. Otherwise ignore the flag and say so),
`--dry-run` (resolve + print the DAG and execution plan, create nothing),
`--new` (ignore resumable runs, start fresh), `--serial` (force max_parallel=1
— debugging escape hatch).

**Graph-size ceiling:** this markdown engine is proven to ~8 nodes / 1 active
gate. Larger authored graphs → warn the user and suggest splitting the ritual
(the deterministic `ritual-engine` Workflow script is the planned successor for
big graphs).

## Phase 0 — Bootstrap

```bash
# ── Ghost-kit Phase 0 (canonical — edit PHASE0.md first) ──
# A line starting "STOP:" (exit code 3) means STOP: relay that line to the user as-is and run
# nothing else. Never go looking for an API key anywhere this block did not look.
command -v jq >/dev/null 2>&1 || { echo "STOP: ghost-kit needs jq, which is not installed on this computer. Install it (macOS: brew install jq; Linux: your package manager), then try again."; exit 3; }
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CFG="$REPO_ROOT/.ghost/config.json"
cfg() { [ -f "$CFG" ] && jq -r "$* // empty" "$CFG" 2>/dev/null || true; }

GK_AUTH=prod
API_BASE=$(cfg '.api.base'); API_BASE=${API_BASE:-https://backend-production-ea01.up.railway.app}
if [ "${GK_LOCAL:-0}" = "1" ] && [ "$(cfg '.api.allow_local_switch')" = "true" ]; then
  GK_AUTH=local; API_BASE=$(cfg '.api.local_base'); API_BASE=${API_BASE:-http://localhost:8000}
fi
KEY_VAR=$(cfg ".auth.$GK_AUTH.env_var"); KEY_VAR=${KEY_VAR:-GHOST_HUNTING_API_KEY}
ENV_FILES=$(cfg ".auth.$GK_AUTH.env_files[]"); ENV_FILES=${ENV_FILES:-.env}
CFG_ORG_ID=$(cfg ".auth.$GK_AUTH.org_id"); CFG_ORG_NAME=$(cfg ".auth.$GK_AUTH.org_name")

# Key lookup, in the SAME order as runtime/project.mjs credential() and the engines:
# 1 the env var, 2 this checkout's env_files, 3 the main checkout's (same key name only),
# 4 ONLY when the config names org_id: the per-user file, by GHOST_HUNTING_API_KEY__<ORG8>.
# A config without org_id keeps the legacy ~/.claude/.env instead. Never evaluate .env as shell.
gk_key() { sed -n -e 's/^[[:space:]]*//' -e 's/^export[[:space:]][[:space:]]*//' -e "s/^$GK_K=//p" "$*" 2>/dev/null | head -n 1 | tr -d "\"'[:space:]"; }
TALISMAN=$(printenv "$KEY_VAR" 2>/dev/null || true); KEY_SRC=${TALISMAN:+the $KEY_VAR environment variable}
GK_K=$KEY_VAR
for f in $(printf '%s\n' "$ENV_FILES"); do
  [ -z "$TALISMAN" ] && TALISMAN=$(gk_key "$REPO_ROOT/$f") && [ -n "$TALISMAN" ] && KEY_SRC="$REPO_ROOT/$f"
done
# Linked worktrees do not carry ignored .env files. Only fall back to THIS git
# repository's main checkout, and only if it configures the same key name.
MAIN_ROOT=$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
MAIN_KEY=$(jq -r --arg local "${GK_LOCAL:-0}" 'if $local == "1" and .api.allow_local_switch then .auth.local.env_var else .auth.prod.env_var end // empty' "$MAIN_ROOT/.ghost/config.json" 2>/dev/null)
if [ -z "$TALISMAN" ] && [ "$MAIN_KEY" = "$KEY_VAR" ] && [ "$MAIN_ROOT" != "$REPO_ROOT" ]; then
  for f in $(printf '%s\n' "$ENV_FILES"); do
    [ -z "$TALISMAN" ] && TALISMAN=$(gk_key "$MAIN_ROOT/$f") && [ -n "$TALISMAN" ] && KEY_SRC="$MAIN_ROOT/$f"
  done
fi
GHOST_USER_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/ghost-hunting/.env"
ORG8=$(printf '%s' "$CFG_ORG_ID" | cut -c1-8 | tr '[:lower:]' '[:upper:]')
if [ -z "$TALISMAN" ] && [ -n "$CFG_ORG_ID" ]; then
  GK_K="GHOST_HUNTING_API_KEY__$ORG8"; TALISMAN=$(gk_key "$GHOST_USER_ENV"); [ -n "$TALISMAN" ] && KEY_SRC="$GHOST_USER_ENV"
fi
if [ -z "$TALISMAN" ] && [ -z "$CFG_ORG_ID" ]; then
  GK_K=$KEY_VAR; TALISMAN=$(gk_key "$HOME/.claude/.env"); [ -n "$TALISMAN" ] && KEY_SRC="$HOME/.claude/.env"
fi
AUTH="Authorization: Bearer $TALISMAN"
KEY_SHOW=$KEY_SRC
case "$KEY_SRC" in "$REPO_ROOT"/*) KEY_SHOW="./${KEY_SRC#"$REPO_ROOT"/}" ;; "$HOME"/*) KEY_SHOW="~/${KEY_SRC#"$HOME"/}" ;; esac

# The version of the PROSE you are executing — stamped at release by
# scripts/ghost-kit-release.sh. Deliberately NOT read from disk: a session loads skill
# text once at start and holds it, so a runtime read reports what is on disk NOW, not
# what is running. That is how a session executing v1.3.7 reported plugin/1.4.0.
PLUGIN_VERSION="1.10.0"
GK_ROOT="${GHOST_KIT_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}}"
[ -z "$GK_ROOT" ] && [ -x "$REPO_ROOT/.ghost/bin/resolve-plugin" ] && GK_ROOT=$("$REPO_ROOT/.ghost/bin/resolve-plugin" 2>/dev/null)
GK_SRC=$(jq -r '.["ghost-kit"].installLocation // empty' "$HOME/.claude/plugins/known_marketplaces.json" 2>/dev/null)
# Loud, local, and it CAN fire: prose (above) vs the newest ghost-kit on disk.
GK_DISK=$(setopt nonomatch 2>/dev/null || true
  jq -r '.version // empty' \
  "$GK_ROOT/.claude-plugin/plugin.json" \
  "$REPO_ROOT/plugins/ghost-hunting-core/.claude-plugin/plugin.json" \
  "$GK_SRC/plugins/ghost-hunting-core/.claude-plugin/plugin.json" \
  "$HOME"/.claude/plugins/cache/ghost-kit/ghost-hunting-core/*/.claude-plugin/plugin.json \
  "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/.codex-plugin/plugin.json \
  "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/.claude-plugin/plugin.json \
  "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/plugin.json \
  2>/dev/null | sed 's/+.*//' | sort -V | tail -1)
[ -n "$GK_DISK" ] && [ "$GK_DISK" != "$PLUGIN_VERSION" ] && \
  echo "⚠ ghost-kit: this session runs v$PLUGIN_VERSION prose; v$GK_DISK is on disk — refresh ghost-hunting-core for this host, then RESTART"
REPO_SLUG=$(cfg '.repo'); REPO_SLUG=${REPO_SLUG:-$(basename "$REPO_ROOT")}
WF_STAMP=$(jq -r '.bundle // empty' "$REPO_ROOT/.ghost/sync-state.json" 2>/dev/null)
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/invoke-ritual${WF_STAMP:+ wf/$WF_STAMP}"

[ -n "$TALISMAN" ] || { echo "STOP: There is no Ghost Hunting API key on this computer for this repo${CFG_ORG_NAME:+ ($CFG_ORG_NAME)}. Type /ghost-onboard to connect."; exit 3; }
ME_RAW=$(curl -s --max-time 30 -w '\n%{http_code}' "$API_BASE/api/agent/me" -H "$AUTH" -H "$GH_CLIENT")
ME_HTTP=$(printf '%s' "$ME_RAW" | tail -n 1); ME=$(printf '%s' "$ME_RAW" | sed '$d')
case "$ME_HTTP" in
  401|403) echo "STOP: Ghost Hunting rejected the API key from $KEY_SHOW — revoked or expired. Type /ghost-onboard to reconnect."; exit 3 ;;
  000) echo "STOP: Could not reach Ghost Hunting at $API_BASE. Check your connection, then try again."; exit 3 ;;
  200) ;;
  *) echo "⚠ Ghost Hunting answered HTTP $ME_HTTP for the identity check; continuing." ;;
esac
ME_ORG=$(printf '%s' "$ME" | jq -r '.org_id // empty' 2>/dev/null)
if [ "$ME_HTTP" = 200 ] && [ -n "$CFG_ORG_ID" ] && [ "$ME_ORG" != "$CFG_ORG_ID" ]; then
  echo "STOP: You're signed in to $(printf '%s' "$ME" | jq -r '.org_name // "a different Coven"' 2>/dev/null), but this repo belongs to ${CFG_ORG_NAME:-Coven $CFG_ORG_ID}. The API key from $KEY_SHOW is for the wrong Coven (organization). Type /ghost-onboard to connect to ${CFG_ORG_NAME:-the right one}."; exit 3
fi
echo "$ME" | jq -r '"agent: \(.name)  contract: \(.client_contract.status // "unknown")"'
echo "$ME" | jq -r '.client_contract.message // empty'
# ── End Ghost-kit Phase 0 ──

# ── invoke-ritual additions ──
ORG_ID=$(echo "$ME" | jq -r .org_id)
```

- **Preflight verdict:** if `client_contract.status` is `unsupported`, STOP —
  tell the user to update ghost-kit before continuing. If `outdated`, print
  the message and continue. `current`/`unknown` → proceed silently.
- **Generic mode (no `.ghost/config.json`):** the block still works via
  defaults — prod API, `GHOST_HUNTING_API_KEY` from `$REPO_ROOT/.env` then
  `~/.claude/.env` (a config naming `auth.prod.org_id` reads the signed-in
  `GHOST_HUNTING_API_KEY__<ORG8>` from `~/.config/ghost-hunting/.env` instead; the
  rite-cadence engine follows the same rule in every worktree). Subagent test gates fall back to `./scripts/test.sh` if it
  exists, else are skipped with a warning (see the references); a
  `script_workflow` node will backfire unless the repo has vendored workflows.
- **Contract probe:** `curl -s "$API_BASE/api/agent/covens/$ORG_ID/rituals" -H "$AUTH" -H "$GH_CLIENT"`
  — a 404 means the workflow endpoints aren't deployed on this backend; stop
  and say so.

**Read `references/api-contract.md` now.** Read
`references/node-execution.md` before Phase 4.

## Phase 1 — Mode resolution

Parse `$ARGUMENTS` per the table above.

**Browse (no args):** fetch rituals + active invocations:
```bash
curl -s "$API_BASE/api/agent/covens/$ORG_ID/rituals" -H "$AUTH" -H "$GH_CLIENT"
curl -s "$API_BASE/api/agent/covens/$ORG_ID/invocations?status=summoned,channeling,awaiting_hunter" -H "$AUTH" -H "$GH_CLIENT"
```
Print a ═══-boxed table: rituals (name, node count, node-type mix, last run) and
in-flight invocations (title — `[ad-hoc]`-tagged for workflow-less runs,
status, `resumable`, updated). Offer: resume a resumable run (first), claim a
summoned run, or start a ritual. Then continue as that mode.

**Name/id:** resolve exact id → name substring against the ritual list;
multiple matches → ask the user.

**Watch / dispatch (`--watch`):** one bounded unit of work per invocation of the
skill — the /loop harness provides the recurrence (fresh session each tick, no
context accumulation):
```bash
curl -s "$API_BASE/api/agent/covens/$ORG_ID/invocations?status=summoned,awaiting_hunter" -H "$AUTH" -H "$GH_CLIENT"
```
Pick, in order of preference: (1) the oldest `summoned` run, (2) the oldest
`awaiting_hunter` run with `resumable: true`. Nothing eligible → print "nothing
to channel" and exit quietly (a /loop tick with no work must be cheap). Never
take over `channeling` runs in watch mode (no stale-takeover without a human).
Announce what was picked, then proceed to Phase 2 claim → Phase 4 as normal;
when the run pauses or completes, report and EXIT — do not loop yourself.

**Ad-hoc (`--ghosts` / `--top` / `--haunting`):** build the ordered set, then
validate it: GET each ghost + `/with-dependencies`. Report already-exorcised
(server pre-completes them), warn-and-drop poltergeists, order intra-set Spirit
Bonds dependency-first, drop out-of-set-blocked ghosts with a warning. For
`--top N`: filter ether, sort banshee>scream>moan>whisper then oldest, take N,
warn on `context.files` overlaps between picks, and CONFIRM with the user.
Then `POST /api/agent/invocations/ad-hoc {task_ids, mode, claim: true}` and
jump to Phase 4.

## Phase 2 — Run acquisition (resume detection)

For a named ritual, check for an active invocation first:
```bash
curl -s "$API_BASE/api/agent/covens/$ORG_ID/invocations?workflow_id=$WF_ID&status=summoned,channeling,awaiting_hunter" -H "$AUTH" -H "$GH_CLIENT"
```

| Found | Action |
|---|---|
| `awaiting_hunter` | Resume it (announce; `--input` on a resume is an error) |
| `summoned` | Claim it |
| `channeling`, updated recently | Another live runner. Refuse: "invocation <id> is being channeled (updated <t>). Use --new for a fresh run." |
| `channeling`, updated ≥2h ago | Likely orphaned. **Ask the user** before taking over; on yes, claim with `{"force": true}` |
| none / `--new` | Phase 3 then create with `claim: true` |

Claim exactly once: `POST .../claim` → store `claim_generation` (GEN). 409 →
report who/when and stop. **Never re-claim mid-run.**

## Phase 3 — Input collection

Read the ritual's declared `inputs[]`. Fill from `--input k=v` args; apply
defaults; **ask the user** for any missing required input (show its label).
Never invent a value. `--dry-run` prints the DAG (topo order, node types,
configs, inputs) and stops here.

## Phase 4 — The scheduler (wave loop)

Read `references/node-execution.md` first. Then loop:

```
LOOP:
  1. FETCH: GET /invocations/{RUN} — the server is the ONLY truth.
     (status abandoned/backfired underneath you → stop, report)
  2. RECONCILE waiting/orphaned steps:
     - awaiting_hunter steps: linked ghost exorcised → fulfill with human_notes;
       poltergeist → backfire; resolved gates are already terminal server-side
     - orphaned channeling steps (no live subagent of OURS): ghost_task → the
       strict derivation table in node-execution.md; agent_task → PUT pending
       (lost result; warn that side effects may repeat)
  3. GATE MECHANICS on ready gates: review verdicts → loop-back or on_exhaust;
     loop nodes → evaluate condition. (These mutate the frontier — do them first)
  4. HUMAN-READY steps: spawn ghosts / park ghost-less steps NOW (all of them —
     humans start working while machine branches continue)
  5. MACHINE-READY steps: launch up to max_parallel as Agent subagents IN ONE
     MESSAGE (self-journaling, worktree rules + dependent-wave guard per
     node-execution.md). Wait for the whole wave; verify each step's journaling.
  6. Nothing launched?
     - all steps terminal-or-fulfilled → POST /complete {fulfilled} → Phase 6
     - any backfired → POST /pause (error naming the step) → print the resume box
       naming `--retry <run_id>` → EXIT SESSION. Do NOT complete the run as
       backfired here: `backfired` is TERMINAL (`core/enums.py` terminal_statuses),
       POST /claim rejects a terminal run with 400 "Invocation is backfired — not
       claimable", `force` cannot bypass it (the check precedes it), and there is
       no reopen endpoint. Completing as backfired makes `--retry` impossible and
       contradicts Phase 5's "a failed run is a resumable artifact". Complete as
       backfired ONLY when the user has decided the run is dead.
     - waiting steps remain → POST /pause → print the resume box → EXIT SESSION
  7. goto LOOP
```

Narrate every transition: `▶ [3/7] Implement (agent_task) — spawning…` /
`✓ [3/7] fulfilled — 12 files, tests green` / `↻ Plan review FAIL (cycle 1/2)
— looping back` / `⏸ waiting on hunters`.

### Idempotency invariants (MUSTs)

1. Every transition hits the API before the next dependent action — never
   batched, never from memory.
2. Fulfilled steps never re-execute; only the loop-back endpoint resets them.
3. Ghost spawns are idempotent (check `steps[].task_id`, endpoint guards too).
4. All state re-reads come from the run detail at loop entry.
5. A 409 on ANY write = a newer session owns the run. Stop writing. Report.
6. `exorcise_on: run_complete` → at fulfillment, the PARENT exorcises every
   bound purgatory ghost, then completes the run.

### Pause box (Phase 4 exit 6c)

```
⏸ Ritual paused — waiting on the living.
   <ghost/gate list: what's needed, who's assigned>
   Resume with: /invoke-ritual --resume <RUN_ID>
   (or just /invoke-ritual <ritual name> — it finds the paused run)
```

## Phase 5 — Retry & cancel modes

`--retry <run_id>`: claim (fresh generation) → for each backfired step:
ghost_task → derive from ghost state first (exorcised auto-fulfills; still
poltergeist → tell the user to unblock it first); else PUT pending → PUT run
status via claim (already channeling) → Phase 4. Untouched steps were never
lost — a failed run is a resumable artifact, which holds ONLY because Phase 4
pauses on a backfired step instead of completing the run as backfired.

`--cancel <run_id>`: confirm with the user → POST the human cancel is not
yours to call — instead: post EVPs on open spawned ghosts ("run being
cancelled"), then `POST /complete {backfired, error: "cancelled by operator"}`
if you hold the claim, or tell the user to cancel from the UI if you don't.

## Phase 6 — Report

═══ summary box: per-step table (status, attempts, duration), spawned ghosts
(ids + assignees), worktree branches with EXACT merge commands (until collation
lands, the human merges), total duration, and — for backfired — the failing
step's error + `--retry` line. Post closing EVPs on every ghost the run spawned.

## Error handling

| Scenario | Action |
|---|---|
| 409 on claim | Another medium owns it — report and stop |
| 409 on any write | Newer session took over (or cancel) — stop writing, report |
| Subagent returns garbage | One re-spawn; then journal backfired |
| Auth/credit FATAL from a subagent | No retry — surface to the user immediately |
| Endpoint 404s at probe | Workflow API not deployed here — stop |
| Ghost deleted mid-run (`ghost: null`, snapshot has task_id) | Journal the step backfired: "bound ghost deleted" |
| `script_workflow` names a file missing from `$ENGINE_ROOT/.claude/workflows/` | Journal the step backfired (no retry); if the repo's config lists that workflow under `workflows.vendor`, suggest running `ghost-hunting-core:ghost-sync`, **committing**, then `--retry` |
| `script_workflow` engine stamp disagrees with `.ghost/sync-state.json` | Journal backfired naming both stamps and the direction of drift — NEVER execute a stale engine; `/ghost-sync` + commit + `--retry` |
| Wave partially fails | Finish draining ALL siblings' journaling first, then handle the failure |

## Key reminders

- EVP field is `content`; list endpoints return `{items: [...]}`; use
  `jq --rawfile` for multi-line payloads.
- Subagents don't inherit skills — templates in `references/` get inlined.
- `{GH_CLIENT}` in `references/ghost-lifecycle-prompt.md` is filled with THIS
  session's `$GH_CLIENT` (Phase 0) verbatim, so every subagent curl carries
  `X-Ghost-Client`; the template itself carries no version literal (the release
  script and the sync gate only stamp/check `PHASE0.md` + `skills/*/SKILL.md`).
  The lifecycle prompt recalls Imprints before the work and writes back after,
  under `writeback:<ghost>:<commit sha>` — parity with `commence-haunt`.
- One claim per session; `claim_generation` on every write.
- Never PUT a step fulfilled on red tests. Verification gates are the point.
- Sequential main-tree chains: one ghost = one commit (`Ghost:` trailer);
  refuse to start on a dirty tree (or stash with the user's OK).
- `script_workflow` nodes bridge to the HOST repo's vendored Workflow scripts.
  Resolve them from the MAIN checkout —
  `ENGINE_ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")` —
  and invoke by ABSOLUTE path. A relative path resolves against CWD, so a runner
  sitting in an `ext/*` worktree would execute that branch's last *committed*
  bundle instead of the synced one. Verify the file's vendored header stamp
  against `$ENGINE_ROOT/.ghost/sync-state.json` and refuse on mismatch. The files
  arrive via `ghost-hunting-core:ghost-sync` (config `workflows.vendor`). Full
  bridge semantics (resolution, freshness, sentinel returns, empty-ship guard):
  `references/node-execution.md`.
- Human-step assignee default: node `assignee_hunter_id` first, else
  `cfg '.human_hunter_id'`, else unassigned.
