---
name: reckoning
description: Holistic codebase audit — review the WHOLE codebase against universal engineering principles, the repo's own personas and its stated tenets, check what a Rite / Haunting / Séance / the Coven claimed against the code it actually shipped, reconcile the Coven's Imprints with the code as it is now, and turn only what survives adversarial verification into ONE approved action plan and a decision-first Scroll. Use when the user says "reckoning", "reckon", "audit the codebase", "holistic review", "whole-codebase review", "how close are we", "codebase health", "what did this rite actually deliver", or names a rite/haunting/séance/coven to reckon.
---

# Reckoning

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.

A reckoning runs up to four **Parts**, each a run of the vendored `reckoning` workflow:

| Part | What it answers |
|---|---|
| **health** | How healthy is the code in scope? Shard × principle group, persona passes, cross-cutting (or, for a named scope, fit-and-reuse) passes — every finding cites a principle (P-*), persona, or tenet (T-*) |
| **fidelity** | Did the ghosts deliver what they claimed? Where does it miss the point? Which open ghosts are already done or obsolete? |
| **imprints** | Do the Imprints still describe the code? keep / edit / supersede / retire / merge / promote — **on in every run**, scoped to what the run touches |
| **verdict** | One action plan under the backlog's filing bars, and the Scroll |

Sizes (this repo, standard depth, calibrated on pilot C): a whole-séance reckoning ~690 agents, a
codebase-only one ~460, one Rite ~100 — Opus for the bulk, Fable only for the synthesis roles and the plugin's reasoning
personas (about 1 agent in 8). No agent copies bytes: each Part returns its sealed decisions and
`record` writes them.

**Guarantees:** the workflow never writes to the API or the code (leaves write only their own
artifacts into a bus inside a pinned, detached tree); every finding survived adversarial
verification or is labelled as not having; every cap, demotion and dead agent is reported; nothing
is applied without ONE approval from the Hunter.

**Invocation input** means the user's text after `/reckoning` (Claude) or
`$reckoning` (Codex). On a host that expands `$ARGUMENTS`, that expansion is the
same input. Never require literal `$ARGUMENTS` expansion.

Arguments provided: `$ARGUMENTS`

## Forms and flags

| Command | Code reviewed | Ghosts claim-checked | Imprints |
|---|---|---|---|
| `/reckoning` | the **whole repo** | **all** of this repo's ghosts (its posture scope, below) | all of this repo's |
| `/reckoning coven` | the whole repo | every ghost in the Coven (another repo's work is excluded and counted) | all in the Coven (another repo's project Imprints excluded and counted) |
| `/reckoning repo` | the whole repo | none | all of this repo's |
| `/reckoning seance <id\|name>` | **only that séance's code**: what its ghosts touched + adjacent | that séance's ghosts | related to it in any way |
| `/reckoning haunting <id\|name>` | only that Haunting's footprint + adjacent | its ghosts | related to it |
| `/reckoning rite <id\|name>` | only that Rite's footprint + adjacent | its ghosts | related to it |
| `/reckoning apply <run-id>` | — approve/apply a finished reckoning's plan later | | |

A named scope never audits unrelated code. Its **footprint** is what its ghosts changed — their
declared files, their linked PRs and the PRs their EVPs mention, commits naming them, paths their
EVPs cite — and **adjacent** is one hop on the import graph (imports, importers, tests), reviewed
only as context.

- `--depth survey|standard` (default standard). survey = one finder per shard, one persona pass per group, sampled skeptics, no walkthroughs.
- `--parts fidelity,health` — narrow the run; the Imprint check stays on regardless (`--no-imprints` turns it off).
- `--parts imprints` alone — the **bare Imprint reckoning**, at any scope: only the Imprint check runs
  (keep / edit / supersede / retire / merge / promote), with NO instruments and NO verdict step — the
  check's sealed ops are the plan, and the Scroll is generated from them. It never creates a
  brand-new Imprint (those come only from verified claims-check and code-review findings); it does
  write the replacement a supersede or merge needs. ~6 agents for a Rite, ~33 for the whole repo.
- `--history all|open|<N>d` — which ghosts get their claims checked. Asked at launch when the claims check would go over budget.
- `--models role=model,…` — move a role or one lens to another model (e.g. `finder.runtime=fable`, `reasoning_persona=opus`).
- `--lenses a,b` — keep only these principle groups (`correctness_safety`, `runtime`, `design`, `quality`, `experience`), persona keys, or `cross`. The Scroll says the review was partial.
- `--reason "…"` — why this reckoning; it becomes a goal and the verdict answers it first.
- `--resume <run-id>` — continue an interrupted reckoning (finished Parts are skipped).
- `--report-only` — publish the Scroll, apply nothing (the plan stays approvable via `apply`).
- `--budget N` — per-run spawn budget (default 350); the whole-reckoning target is 700 (`reckoning.target_agents`).
- `--local` — target the local API. Honored **only** when `.ghost/config.json` sets `api.allow_local_switch: true`: `export GK_LOCAL=1` **before** the Phase-0 block; otherwise ignore it and say so.

**Posture.** The default scope follows `.ghost/config.json` `seance.scope` (absent = `seance`),
exactly as Phase 0's séance resolution defines it: a `seance` repo (e.g. ghosthunting — one séance
in a Coven shared with other repos) reckons its séance, and its org Imprints first get a
jurisdiction check (another repo's Imprint is never judged against this code); a `coven` repo
(e.g. a repo whose Coven *is* the repo) reckons the whole Coven and skips that check.

## Phase 0 — Bootstrap

Run the canonical Phase-0 block (if `--local` was given and is allowed, `export GK_LOCAL=1` first):

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/reckoning${WF_STAMP:+ wf/$WF_STAMP}"

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
```

Preflight verdict: `unsupported` → STOP and tell the user to update ghost-kit; `outdated` → print
the message and continue.

Then locate the engine and the plugin's scripts — refuse loudly, never fall back:

```bash
MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
ENGINE="$MAIN/.claude/workflows/reckoning.js"
[ -n "$GK_ROOT" ] && [ -f "$GK_ROOT/scripts/reckoning-prep.mjs" ] || echo "STOP: ghost-kit root not found (GK_ROOT='$GK_ROOT')"
PREP="$GK_ROOT/scripts/reckoning-prep.mjs"; APPLY="$GK_ROOT/scripts/reckoning-apply.mjs"
BUS="$GK_ROOT/scripts/reckoning-bus.sh"; INSTR="$GK_ROOT/scripts/reckoning-instruments.sh"
[ -f "$ENGINE" ] || echo "STOP: $ENGINE missing — add \"reckoning\" to .ghost/config.json workflows.vendor, run ghost-hunting-core:ghost-sync, commit"
HDR=$(sed -n '1p' "$ENGINE"); SYNC=$(jq -r '"v\(.plugin_version) (bundle \(.bundle))"' "$MAIN/.ghost/sync-state.json" 2>/dev/null)
case "$HDR" in *"$SYNC"*) echo "engine: $HDR";; *) echo "STOP: engine stamp '$HDR' does not match sync-state $SYNC — run ghost-sync";; esac
command -v node >/dev/null && command -v jq >/dev/null || echo "STOP: node and jq are required"
```

Any `STOP` line ends the skill with that message. `apply <run-id>` jumps to **Phase 7**;
`--resume <run-id>` sets `RUN="$MAIN/.ghost/reckonings/<run-id>"`, re-attaches the tree if it is
gone (`git -C "$MAIN" worktree add --detach "$RUN/tree" "$(jq -r .sha "$RUN/state.json")"`),
acquires the lock, shows `node "$PREP" status --run "$RUN"`, and jumps to **Phase 5**.

## Phase 1 — Pin the tree

The audit reads ONE frozen commit for hours while other sessions keep committing, so every
`path:line` stays true. Created directly — never through the repo's worktree script, whose `reap`
deletes every tree it manages.

```bash
git -C "$MAIN" fetch -q origin
DEF=$(git -C "$MAIN" symbolic-ref -q --short refs/remotes/origin/HEAD | sed 's#^origin/##'); DEF=${DEF:-main}
SHA=$(git -C "$MAIN" rev-parse "origin/$DEF")
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-<scope-slug>"          # e.g. …-seance, …-rite-wiki-structure
mkdir -p "$MAIN/.ghost/reckonings" && printf '*\n' > "$MAIN/.ghost/reckonings/.gitignore"
RUN="$MAIN/.ghost/reckonings/$RUN_ID"
bash "$BUS" lock "$RUN" acquire || echo "STOP: run is locked"
git -C "$MAIN" worktree add --detach "$RUN/tree" "$SHA"
```

Dependencies for the instruments: for each `.ghost/config.json` `reckoning.deps[]` entry
`{lock, dir}`, symlink `$MAIN/<dir>` into the tree **only** when `shasum` of `$MAIN/<lock>` equals the
tree's `<lock>`; otherwise leave it absent and let the dependent instrument report SKIPPED. Never
copy `.env` into the tree.

## Phase 2 — Snapshot

```bash
node "$PREP" init --run "$RUN" --tree "$RUN/tree" --scope <whole|coven|seance|haunting|rite|repo> \
  [--target "<id or name>"] [--depth …] [--parts …] [--lenses …] [--reason "…"] [--budget N] [--local]
```

It resolves the scope, writes the snapshot (scope, backlog, Imprints, Auguries, fidelity batches,
unit files) into `$RUN/snapshot/`, assigns every tracked code file to exactly one shard, records the
tree tripwire baseline (after the dependency links, so they never read as a leaf's edit), and prints
counts, `shard_coverage`, `warnings` and an estimate.
- **Exit 5** (ambiguous target): show the candidates, ask which, re-run with its id.
- **Exit 7** (API calls failed after retries): STOP and show the errors — a snapshot with holes
  would silently read "no EVPs / no Wisps" as facts. Retry later.
- **`warnings`**: show every one at the launch confirmation (e.g. `coven` named in a séance-posture repo,
  a missing `reckoning.reference_scale`, stale tenet pointers).
- **`reference_scale`**: the largest tenant the repo designs for (`.ghost/config.json`
  `reckoning.reference_scale`). The code review judges growth and per-statement cost at that size.
  Show it at the launch confirmation, or say "none stated".
- **Named scope:** `footprint` (ghosts with a code footprint / touched / adjacent files) and
  `imprints_related` (by Haunting, by link to its ghosts, by naming its files) — show them. A thin
  footprint (few ghosts with one) means a thin code review; the claims check still searches the
  whole repo. An EMPTY footprint drops the code review from `parts` (a warning says so) — say that
  plainly at the launch confirmation rather than run a review of nothing.
- **`out_of_jurisdiction` / `foreign_imprints_skipped`**: ghosts and project Imprints that belong to
  another repo's Hauntings (séance posture). They are never judged against this code — show the counts.
- **`shard_coverage.auto_shards`**: code no configured shard claims was put in `unsharded-*` shards —
  say so, and suggest adding it to `reckoning.shards`.
- **`unmapped_personas`**: read each one's definition file, decide its shard kinds (see
  `references/personas.md`), write `$RUN/personas.json` `{"<key>": ["frontend", …]}`, re-run `init`.
- **`no_shards: true`** (only when the code review is in `parts`): propose shards for this repo (name, kind ∈ backend / frontend /
  agent-surface / plugin / migrations / tests / infra, paths, group — about 15–30 shards covering
  every tracked source file; a plugin/infra/docs group gets the cross-cutting pass), write them to
  `$RUN/shards.json`, re-run `init`, and suggest pinning them in `.ghost/config.json` `reckoning.shards`.

## Phase 3 — Instruments

Skip this phase for an imprints-only run (`imprints_only: true` in the init output) — nothing reads them.

Deterministic measurements the finders cite (read `references/instruments.md`):

```bash
RECKONING_API_BASE="$API_BASE" RECKONING_AUTH="$AUTH" RECKONING_CLIENT="$GH_CLIENT" \
  RECKONING_INSTRUMENTS_CONFIG="$RUN/instruments.config.json" bash "$INSTR" --tree "$RUN/tree" --out "$RUN/instruments" --snapshot "$RUN/snapshot"
```

A FAILED or SKIPPED instrument is reported as such — never read as a clean measurement.

## Phase 4 — Launch confirmation (the only question before the run)

For every unit (each Rite and Haunting in scope) draft its **point** — one paragraph: the problem
it was meant to solve and for whom — from its description in `$RUN/intents.draft.json` and the ghost
titles in its unit file. If a description links a plan Scroll, read it and prefer it. Then show,
once: scope, pinned SHA, the counts, each Part's estimated agents with the Fable / Opus split
(`models`) and the per-host hours, the drafted intents, and whether the host is kept awake (`pgrep -x caffeinate` on macOS — if not,
suggest `caffeinate -dimsu &`; a sleeping host kills a multi-hour run). Ask ONE question: **Launch** /
**Edit the intents** / **Change depth or Parts** / **Cancel**. When `estimate.over_target` is true
(or a fidelity slice would exceed 250 agents), the question also offers the history windows from
`history_windows`, each with its cost — **all N ghosts (~X agents)** / **open + last 90 days (~Y)** /
**open only (~Z)**; on a choice other than `all`, re-run `init` with `--history <window>`. Write the confirmed intents to
`$RUN/intents.json` as `{"<unit key>": {"intent": "…"}}` — "misses the point" is judged against
the Hunter's confirmed intent, never an LLM's reconstruction.

## Phase 5 — Run the Parts, one at a time

Order: `imprints`, then `fidelity` (or `fidelity-1`, `fidelity-2`, … when the estimate split it),
then `health-<group>` for every shard group, skipping keys `status` already shows complete. For
each KEY:

1. `node "$PREP" args --run "$RUN" --part KEY --engine "$ENGINE"` — prints `script` (the vendored
   engine with its args embedded by `reckoning-bus.sh compose`: the only difference from the
   verified file is one `const` line after `meta`) and `args_file`. If the agent type
   `ghost-hunting-core:reckoning-leaf` is not available in this session, add `--leaf-agent-type ''`.
2. Run it. **Claude:** `Workflow({scriptPath: "<script>"})` — no args (they are embedded); it runs
   in the background, wait for its notification. **Codex:** `.ghost/bin/run-workflow --workflow
   reckoning --args-file "<args_file>" --repo "$RUN/tree" > "$RUN/results/KEY.g<gen>.json"` (the bus
   lives inside the tree so its children can write it). ALWAYS redirect stdout: the result carries the
   whole seal and is far longer than the tool output you are shown — the redirect IS the verbatim
   save. Progress goes to stderr, whose `run_end` line names the runner's own lossless `result.json`
   (copy that if the redirect was lost).
3. Save the returned object **verbatim** to `$RUN/results/KEY.g<gen>.json`. It carries the Part's
   sealed decisions (`seal_content`) with the engine's checksum, and `record` is what writes the seal
   file — so never retype or summarise it. **Claude:** take it from the Workflow task's output file
   (`jq '.result | if type=="string" then fromjson else . end' <output file>`), never from the
   notification text, which is truncated and HTML-escapes `<`. **Codex:** step 2's redirect already
   wrote it.
4. `node "$PREP" record --run "$RUN" --key KEY --result "$RUN/results/KEY.g<gen>.json"`
   - **exit 6** — status `tampered`: the pinned tree changed since the baseline. STOP, show the paths;
     a leaf broke the read-only rule and this Part's results cannot be trusted (re-run it).
   - **exit 4** — status `invalid` (the returned seal does not match its checksum): re-save the result
     verbatim — from the Workflow output file (Claude) or the runner's `result.json` named on stderr
     (Codex) — before re-running anything; only if that fails, re-run the Part (step 1 again makes a
     new generation).
   - On success `record` copies the Part's bus to `$RUN/parts/`, so nothing is lost with the tree.
5. Report one line: status, counts, caps, dead agents. The engine RETURNS failure, it does not
   throw — read `status`:
   - `aborted` → the Part is unreviewed; give the reason and coverage; offer ONE re-run.
   - `budget_exhausted` → coverage has gaps (listed); offer a re-run with a larger `--budget`.
   - `complete` with `coverage.dead_count` > 0 → complete but partial; say so in the Scroll.

## Phase 6 — Verdict

**Imprints-only run:** there is no verdict. Run `finalize`, remove the tree and release the lock (the
two commands below), show `node "$APPLY" plan --run "$RUN"`, and go to Phase 7.

Otherwise, the same loop with KEY `verdict` (`args` refuses while a requested Part is not `complete` —
`budget_exhausted`, `aborted`, `invalid` and `tampered` all count as incomplete; pass `--force` only
after the Hunter accepts a verdict without it, and the Scroll must say which Part is missing). Then:

```bash
node "$PREP" finalize --run "$RUN"            # copies seals, stubs, Scroll, instruments, snapshot to $RUN/out
git -C "$MAIN" worktree remove --force "$RUN/tree" && bash "$BUS" lock "$RUN" release
```

Show the user the Scroll's **Verdict + decisions needed** section (not the whole Scroll) and the
path to `$RUN/out/verdict/scroll.md`.

## Phase 7 — One approval, then apply, then publish

Read `references/apply.md`. Then `node "$APPLY" plan --run "$RUN"` and show the numbered plan grouped
as **additive** (EVPs on existing ghosts, Imprint supersedes, new Imprints, the one fix_batch ghost)
and **state-changing** (new ghosts, Auguries, reopen / close / obsolete, Imprint retirements). Ask
ONE question — **Apply all** / **Apply additive only** / **Pick by number** (then ask for the
numbers) / **Later**. `--report-only` means Later, without asking.

Unless Later, apply through a subagent (mechanical Ghost Hunting API work is delegated, then
verified): have it run `node "$APPLY" apply --run "$RUN" --select <all|additive|n,n> --dry-run`,
then the same without `--dry-run`, and return the JSON. Verify: every selected item is `ok` or has a
stated `skipped` / `error` (a 403 on a retire means the backend lacks retire parity — a Hunter can
retire it in the UI); spot-check two with a GET. Re-running apply is always safe (journal, markers,
stable Imprint keys); what was not selected is recorded as declined.

Then publish, in every case: `node "$APPLY" publish --run "$RUN"` — the Scroll, its appendix (a child
Scroll) and one Tolling. An imprints-only run's Scroll is generated from the sealed ops and the apply
journal (each change with its reason and state: applied / skipped / awaiting approval / declined),
with no appendix. The Tolling is `needs_action` only while approved-but-unapplied or
not-yet-decided items remain; a later `/reckoning apply <run-id>` acknowledges it once nothing is
pending. Report what was applied, skipped and why, and the Scroll link.

## Error handling

- API 401/403 at init → the talisman is wrong for this repo; never borrow another repo's key.
- A Part that aborts twice → finish the other Parts, then offer a verdict with `--force`; the Scroll
  must say which Part is missing.
- A lost lock (`lock acquire` exit 4) → another session may be running this reckoning; never pass
  `--force` to the lock without confirming that session is dead.
- Never edit files in the pinned tree, never run the engine against the live checkout, never apply
  a plan the Hunter did not approve.

## Key reminders

- The code review is **general**: universal principles + personas + tenets. The Hunter's named
  concerns are tenets every finder checks — not the limit of the review.
- Findings name what they violate; settled decisions (answered Auguries, tenet exceptions) are not
  findings.
- The backlog is scarce: at most 7 new ghosts, small fixes as ONE batch ghost, `misses_point` only
  ever as an Augury question, obsolete ghosts get a Sigil — never an exorcise.
- A verified major-or-worse violation of a stated tenet has already met "someone would prioritise
  it" — the Hunter wrote the tenet — so "not felt at today's scale" never leaves it a note. It still
  competes for the 7 slots; any that stays a note is capped `tenet-not-filed` and listed in the Scroll.
- An `aborted` or `budget_exhausted` Part is NOT a clean one.
