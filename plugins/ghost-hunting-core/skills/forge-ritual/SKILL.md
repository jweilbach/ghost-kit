---
name: forge-ritual
description: Forge a CONSECRATED ritual from a rite (Ghost Hunting milestone) — a resumable Gather → Plan → Forge conversation that scopes work into a rite, converts its ghosts into a validated rite-cadence wave plan, and bakes it into a runnable ritual DAG. It NEVER runs the ritual (that is the ghost-hunting-core:invoke-ritual skill). Use when the user says "forge ritual", "forge a ritual", "forge the rite", "build a ritual for", "turn this rite into a ritual", "plan and forge", or "make these ghosts a ritual".
---

# Forge Ritual

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Walk **Gather → Plan → Forge** and stop at a **consecrated ritual** the user
runs later with `ghost-hunting-core:invoke-ritual`. **The backend is the state
store; the DRAFT ritual is the only persistence between Plan and Forge.** This
skill forges and STOPS — it never calls any `/invocations` endpoint. The output
of a successful run is a consecrated ritual plus one line: `/invoke-ritual <name>`.

Arguments provided: `$ARGUMENTS`

## Modes & flags

| Invocation | Meaning |
|---|---|
| `/forge-ritual` | Full conversation from scratch (enter at Gather) |
| `/forge-ritual <rite name\|id>` | Enter at the first incomplete stage for that rite |
| `--plan-only` | Stop after Plan: print the wave table + guard bundle + rendered prep guards; **persist nothing** |
| `--human-gate [before-ship]` | Insert a human gate (before-ship is the default and only flag position; mid-rite gates come from gate ghosts in the rite) |
| `--remove-gates` | Strip human gates from the mapped ritual, rewire edges, re-consecrate |
| `--replan` | Discard the draft's waves; redo Plan against the current rite state (PUTs the SAME draft) |
| `--local` | Local API (honored only when the repo's config sets `api.allow_local_switch: true`; set `GK_LOCAL=1` before the Phase 0 block — same resolution as invoke-ritual, so the hand-off points at the store the ritual is actually in) |

Handled **conversationally**, not by flag: attaching loose ghosts to a rite
(Gather), a hand-authored waves file as input (guards + dry_run still mandatory),
mid-rite human gates (summon a gate ghost into the rite; Plan classifies it), and
re-forging after the rite gained ghosts (entry detection offers it).

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/forge-ritual${WF_STAMP:+ wf/$WF_STAMP}"

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

# ── forge-ritual additions ──
ORG_ID=$(echo "$ME" | jq -r .org_id)   # REPO_ROOT (above) gets baked into forged args as absolute paths
```

- **Preflight verdict:** if `client_contract.status` is `unsupported`, STOP —
  tell the user to update ghost-kit before continuing. If `outdated`, print the
  message and continue. `current`/`unknown` → proceed silently.
- **Contract probe:** `curl -s "$API_BASE/api/agent/covens/$ORG_ID/rituals" -H "$AUTH" -H "$GH_CLIENT"`
  — a 404 means the workflow endpoints aren't deployed on this backend; stop and
  say so.
- **Generic mode (no `.ghost/config.json`):** the block still works via defaults
  — prod API, `GHOST_HUNTING_API_KEY` from `$REPO_ROOT/.env` then `~/.claude/.env`,
  séance fuzzy-matched from the repo dir name (confirm first). The forged prep
  node needs the repo's isolation scripts (`.isolation.worktree_script` etc.); a
  repo with none can still forge a plan but its ritual will fail to provision —
  say so.

**Read `references/planning.md` before Phase 3 and `references/forging.md`
before Phase 4.** Pass `-H "$GH_CLIENT"` on EVERY curl below.

## Phase 1 — Entry detection

Resolve the rite, then map stored state to a stage. Everything keys off `rite_id`.

```bash
# rite: uuid → GET /api/agent/rites/{id};  name → substring match against:
curl -s "$API_BASE/api/agent/covens/$ORG_ID/rites?limit=200" -H "$AUTH" -H "$GH_CLIENT"
# rituals mapped to the rite — scan ALL THREE status lists:
curl -s "$API_BASE/api/agent/covens/$ORG_ID/rituals" -H "$AUTH" -H "$GH_CLIENT"                    # consecrated (default)
curl -s "$API_BASE/api/agent/covens/$ORG_ID/rituals?status=draft" -H "$AUTH" -H "$GH_CLIENT"
curl -s "$API_BASE/api/agent/covens/$ORG_ID/rituals?status=entombed" -H "$AUTH" -H "$GH_CLIENT"
```

A ritual **maps to the rite** when its `description` contains `rite:<rite_id>`;
fallback (pre-convention rituals): `GET /api/agent/rituals/{id}` and scan for a
`script_workflow` node with `config.args.rite_id == <rite_id>`.

| Found | Enter at |
|---|---|
| Consecrated match | Diff the ritual's planned ghost ids vs the rite's current unexorcised ghosts: **no delta** → print the hand-off box → EXIT (nothing to forge). **Delta** → offer a re-forge (Plan over the delta → atomic PUT → re-consecrate) |
| Draft match | Forge **F0** staleness re-check → resume F2 (`--replan` → fresh Plan over the same draft) |
| Entombed match | Surface it; ask: revive (re-consecrate) vs dispel + forge anew |
| No match, rite has unexorcised ghosts | **Plan** (Phase 3) — this is the skip-Gather path |
| No match, rite empty / all exorcised | Offer Gather-attach, or report there is nothing to do |
| No rite resolvable | **Gather** (Phase 2) |
| Multiple matches | Prefer the consecrated one; list all; offer to dispel extras; NEVER forge another |

## Phase 2 — Gather

Scope the work conversationally, then write it to the tracker — **never before
an explicit yes**.

1. Scope with the user: what work, which haunting, rite name, and per-ghost
   title/files/acceptance criteria. Resolve the target **séance** per the Phase-0
   conventions, honoring the posture `cfg '.seance.scope'` (default `seance`):
   in **`seance`** scope use `cfg '.seance.id'` when set, else the
   `.seance.selector` regex against the séance list, else fuzzy-match the repo
   name (confirm a fuzzy match before writing); in **`coven`** scope SKIP séance
   resolution entirely and list hauntings **coven-wide**. Either way, then list
   the candidate hauntings and confirm the target haunting with the user (never a
   hardcoded default — and in `coven` scope the coven-wide list makes the confirm
   essential):
   ```bash
   SEANCE_ID=$(cfg '.seance.id')   # seance scope: else resolve via selector/fuzzy per PHASE0.md; coven scope: leave empty
   curl -s "$API_BASE/api/agent/hauntings" -H "$AUTH" -H "$GH_CLIENT"   # seance: pick the one under $SEANCE_ID; coven: all hauntings; confirm
   ```
2. **Preview table** (titles, files, AC one-liners) → explicit confirm.
3. Find-or-create the rite (case-insensitive name probe of
   `/covens/$ORG_ID/rites` first):
   `POST /api/agent/covens/$ORG_ID/rites {"name", "description"}`.
4. Per ghost — idempotency probe FIRST: a title match among
   `GET /api/agent/rites/$RITE_ID/ghosts` → skip (attach model: ghosts are born
   attached, so the rite list is the only place to probe). Then:
   ```bash
   curl -s -X POST -H "$AUTH" -H "$GH_CLIENT" -H 'Content-Type: application/json' --data-binary @- \
     "$API_BASE/api/agent/hauntings/$HAUNTING_ID/ghosts" <<'JSON'
   {"title": "...", "description": "...", "priority": "moan",
    "milestone_id": "<rite uuid>",
    "context_payload": {"objective": "...", "instructions": ["..."],
      "files": ["frontend/src/..."], "acceptance_criteria": ["...", "All existing tests continue to pass."],
      "constraints": ["Follow existing patterns per CLAUDE.md"]}}
   JSON
   ```
   (`milestone_id` inline — no separate attach step, no unattached window.)
5. Assembling pre-existing loose ghosts instead: confirm the set, then
   `POST /api/agent/ghosts/bulk/milestone {"task_ids": [...], "milestone_id": "<rite>"}`.
6. Verify: `GET /rites/$RITE_ID/ghosts` count matches the preview. → Phase 3.

## Phase 3 — Plan

Read `references/planning.md` and execute P1→P7: read the rite → **ground every
claim** (P1b: open every declared file and cited precedent; the anchor check exits
3 on an unresolved anchor or an unanchored wave) → **recall the Coven's memory**
(P1c: both recall axes per Haunting; the imprint check exits 3 when a recalled
Imprint names a file no wave declares, or a wave owns a frontend path it never
gates) → classify to
fixpoint (blocked-by-out-of-set ghosts route OUT; backend/migration ghosts route
to backend/migration WAVES; human-gate ghosts route to `human_task`) → group
disjoint-file waves → plan-time guards (base SHA, slug) → **dry_run via the local
rite-cadence `validatePlan`** → proportional `ghost-hunting-core:panel` review →
user-approved wave table.

**Exit condition:** dry_run returned `status:"validated"` with zero issues AND
the P1b anchor check exited 0 on the final plan AND the P1c imprint check
exited 0 AND panel findings addressed AND
the user approved the wave table. Then **fall
through to Forge F1 in the same beat** — no pause (`--plan-only` stops here
instead, persisting nothing).

## Phase 4 — Forge

Read `references/forging.md` and execute F0→F5: compose the DAG (size asserts) →
`POST` draft → gates on request → `POST /validate {definition}` fix loop → `PUT
{status:"consecrated"}` fix loop → report. Fix-loop cap-outs leave the draft and
persist a `last-error:` digest into its description.

## Idempotency invariants (MUSTs)

1. Everything keys off `rite_id` — never off names alone.
2. Never create a ghost whose exact title already exists among the rite's ghosts.
3. Never a second ritual for a rite — draft → resume it; consecrated → nothing to
   forge (or the delta re-forge); entombed → surface and ask.
4. No waves reach Forge without a `status:"validated"` dry_run **in this
   session** — including hand-authored waves and resumed drafts.
5. This skill never calls any `/invocations` endpoint. Ever.
6. Human gates over existing ghosts use `spawn_ghost: false` (never mint
   duplicates at run time).
7. Every tracker write is preceded by an explicit user confirm (Gather preview,
   wave-table approval, gate changes).

## The hand-off box (Forge F5 / consecrated-match exit)

```
═══════════════════════════════════════════
  RITUAL FORGED & CONSECRATED
═══════════════════════════════════════════
  Ritual:  <name>  (<id>)  — consecrated, v<N>
  Rite:    <rite name>  (<rite_id>)
  Nodes:   prep_<s> → run_<s> [→ gate…] → ship_<s>
  Waves:   <n> wave(s) · <m> ghost(s) · files disjoint · dry_run VALIDATED
  Routed out: <ghosts refused, with reasons — or "none">
  Human gates: <list or "none — autonomous">

  ⚠ Running this ritual is a REAL build: hours of wall-clock, significant
    tokens, and it ends by pushing ext/<slug> and opening a real PR.
  ⚠ If main has moved a lot since forging, the prep guards will fail fast —
    re-forge with: /forge-ritual <rite> --replan

  This skill forges; it does not invoke.
  ▶ Run it with:  /invoke-ritual <name>
═══════════════════════════════════════════
```

## Error handling

| Scenario | Action |
|---|---|
| Talisman missing / 401 / wrong Coven | Phase 0 prints a `STOP:` line naming the key's source file (lookup: `auth.prod.env_var` across `auth.prod.env_files`, the main checkout, then — with `auth.prod.org_id` — the signed-in `GHOST_HUNTING_API_KEY__<ORG8>` in `~/.config/ghost-hunting/.env`, else the legacy `~/.claude/.env`); relay it (the fix is `/ghost-onboard`) and stop |
| Rituals endpoint 404s at probe | Workflow API not deployed here — stop |
| Rite name → multiple matches | Ask the user |
| Rite empty / all ghosts exorcised | Offer Gather-attach or report done |
| ALL ghosts routed out at P2 | Refuse entirely; no ritual; report every reason |
| dry_run `invalid` | Iterate the plan; Forge is unreachable until `validated` |
| `args` > 32KB / prep instructions > 10k | Externalize (contract_path / Scroll) → split run nodes; never trim implementer prompts |
| POST ritual name collision (coven-unique, verified) | Suffix ` (2)`, retry once; then ask |
| validate errors / consecrate 400 | Node-anchored fix loop, cap 3 → leave draft + `last-error:` digest in its description + resume hint |
| Stale draft (ghost set changed / dry_run now invalid) | F0 detects → offer `--replan` (same draft) |
| Consecrated ritual + rite gained ghosts | Entry diff → offer re-forge |
| Entombed ritual for the rite | Surface; ask revive-vs-dispel |
| Multiple rituals map to one rite | Prefer consecrated; list; offer to dispel extras |
| Partial Gather (some ghosts created) | Ghosts are born attached — the rite-ghost title probe recovers; a ghost retitled mid-gather may duplicate (visible, deletable) |
| Prior run left unshipped commits on `ext/<slug>` | The forged prep guard refuses before the reap — point the user at `--retry` / shipping the branch |
| 409 on any ritual write | A newer session owns it — stop writing, report |
| Session dies between Plan-approval and F1 | Nothing persisted — re-plan (one conversational beat, accepted cost) |

## Key reminders

- EVP field is `content`; list endpoints return `{items: [...]}`; URL paths use
  spooky names, JSON fields use standard names (`project_id`, `milestone_id`).
- The waves schema authority is `validatePlan` in
  `$ENGINE_ROOT/.claude/workflows/rite-cadence.js` (the MAIN checkout's vendored
  copy, resolved via `git rev-parse --path-format=absolute --git-common-dir` —
  not CWD, which in a worktree is a different, possibly older bundle) — not this
  skill's prose.
- Never bake `stop_before` into a forged ritual (the runner journals rite-cadence's
  pause sentinel as backfired) — mid-rite gates are DAG-splits (forging.md §5).
- The forged prep node carries the plan's run-time guards; keep them intact when
  editing definitions.
- Backend/migration rites route through rite-cadence backend waves (this skill
  plans them; the engine runs them). The deprecated `extermination` workflow
  survives ONLY for ad-hoc ghost sets outside a forged rite during the sunset.
