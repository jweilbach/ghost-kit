---
name: seance
description: Display a sprint/portfolio dashboard with velocity, blockers, and priority distribution. Use when the user says "séance", "seance", "dashboard", "sprint status", "portfolio status", or "velocity".
allowed-tools: Bash, Read
---

# Séance Dashboard

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Pull a comprehensive dashboard for a Séance (portfolio) showing ghost status distribution, velocity, blockers, and priority breakdown.

## Arguments

The user provides a **séance name** (partial match OK), a **séance ID** (UUID), or nothing — with no argument, default to this repo's configured séance (resolved from `.ghost/config.json`, see Conventions).

Arguments provided: `$ARGUMENTS`

## Flags

Check `$ARGUMENTS` for these optional flags:

- **`--local`** — Target the local API. Only honored when config allows it (see Conventions).
- **`--all`** — Show a summary table across all séances, not just one.

## Phase 0 — Bootstrap (canonical)

If `--local` is in `$ARGUMENTS`, set `GK_LOCAL=1` before running this block.

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/seance${WF_STAMP:+ wf/$WF_STAMP}"

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

**Use `$API_BASE`, `$AUTH`, and `$GH_CLIENT` on every API call in this skill.**

### Conventions

- **Preflight verdict:** if `client_contract.status` is `unsupported`, STOP — tell the user to update ghost-kit before continuing. If `outdated`, print the message and continue. `current`/`unknown` → proceed silently.
- **`--local` flag:** only honored when the repo's config sets `api.allow_local_switch: true` (set `GK_LOCAL=1` before the block). Otherwise ignore the flag and say so.
- **Séance resolution:** first read the posture — `SCOPE=$(cfg '.seance.scope')` (default `seance` when absent).
  - **`coven`:** the repo's backlog spans the whole coven, so a no-argument invocation defaults to the **coven-wide `--all` dashboard** (Phase 3b) — skip séance resolution entirely. An explicit séance-name or séance-ID argument still narrows to that one séance (resolve it in Phase 0b the normal way).
  - **`seance` (or absent):** use `cfg '.seance.id'` directly when present. Otherwise resolve once via:

    ```bash
    SEANCE_ID=$(cfg '.seance.id')
    [ -z "$SEANCE_ID" ] && SEANCE_ID=$(curl -s "$API_BASE/api/agent/seances" -H "$AUTH" -H "$GH_CLIENT" \
      | jq -r --arg re "$(cfg '.seance.selector')" '.items[] | select(.name | test($re; "i")) | .id' | head -1)
    ```

    If the selector is empty, fall back to fuzzy-matching the repo name (`$REPO_SLUG`) against séance names. In interactive use, confirm a fuzzy match with the user before writing anything; in autonomous/`--yes` mode, ABORT on fuzzy match instead. After resolving, suggest pinning the UUID into `.ghost/config.json` (`seance.id`). Never hardcode a séance name, regex, or UUID in this skill.
- **Generic mode (no `.ghost/config.json`):** everything still works via defaults — prod API, `GHOST_HUNTING_API_KEY` from `$REPO_ROOT/.env` then `~/.claude/.env`, séance fuzzy-matched from the repo dir name (confirm first).
- **API gotchas:** list endpoints return `{items: [...], total, limit, offset, has_more}` — always parse `.items[]`, never `.[]`. JSON field names are standard (`project_id`, `portfolio_id` — not `haunting_id`/`seance_id`).

### 0b. Resolve the séance to report on

Fetch all séances:

```bash
curl -s "$API_BASE/api/agent/seances?limit=200" -H "$AUTH" -H "$GH_CLIENT"
```

- If `$ARGUMENTS` contains a UUID: match against séance IDs.
- If `$ARGUMENTS` contains a name fragment: case-insensitive match against séance names (`.items[].name`).
- If `--all` flag: iterate over all séances and produce a summary table (see Phase 3b).
- If no argument and no `--all`: consult the posture (Conventions above). In `coven` scope, treat this exactly like `--all` — render the coven-wide summary table (Phase 3b) across every séance. In `seance` scope, use the config-resolved séance per the Conventions; if none resolves, list séance names and ask the user to pick one.
- If multiple matches: present options and ask user to clarify.

## Phase 1 — Gather Data

### 1a. Fetch all ghosts for the séance (paginated)

```bash
curl -s "$API_BASE/api/agent/ghosts?portfolio_id={SEANCE_ID}&limit=200" -H "$AUTH" -H "$GH_CLIENT"
```

**CRITICAL: Implement full pagination.** Ghosts are in `.items`; check the `has_more` field in the response. If `true`, fetch the next page:

```bash
curl -s "$API_BASE/api/agent/ghosts?portfolio_id={SEANCE_ID}&limit=200&offset=200" -H "$AUTH" -H "$GH_CLIENT"
```

Continue until `has_more` is `false`. Collect ALL ghosts before computing any metrics.

### 1b. Fetch hauntings in the séance

```bash
curl -s "$API_BASE/api/agent/hauntings?portfolio_id={SEANCE_ID}&limit=200" -H "$AUTH" -H "$GH_CLIENT"
```

### 1c. Fetch dependencies for poltergeist (blocked) ghosts

For each ghost with `status == "poltergeist"`, fetch its dependency details:

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/with-dependencies" -H "$AUTH" -H "$GH_CLIENT"
```

Note: This is one API call per blocked ghost. If there are more than 20 poltergeist ghosts, warn the user that fetching blockers will take a moment.

## Phase 2 — Compute Metrics

### 2a. Status distribution

Count ghosts by status:
- `ether` (backlog)
- `active_haunt` (in progress)
- `purgatory` (in review)
- `poltergeist` (blocked)
- `exorcised` (done)

### 2b. Priority distribution

Count ghosts by priority (order: banshee > scream > moan > whisper):
- `banshee` (critical)
- `scream` (high)
- `moan` (medium)
- `whisper` (low)

### 2c. Velocity calculation

**Use the `completed_at` field** (NOT `updated_at`) from exorcised ghosts.

Group exorcised ghosts by ISO week based on their `completed_at` timestamp. Calculate:
- Ghosts exorcised per week for the last 4 weeks
- Average velocity (ghosts/week)
- Trend: compare last 2 weeks vs previous 2 weeks → increasing / decreasing / stable

If no exorcised ghosts have `completed_at`, report "No velocity data — no ghosts have been exorcised yet."

### 2d. Backlog clearance estimate

If velocity > 0:
- Remaining = count of `ether` + `active_haunt` + `purgatory` + `poltergeist` ghosts
- Estimated weeks = Remaining / average velocity
- Report: "At current velocity, backlog clears in ~X weeks"

### 2e. Blocker analysis

For each poltergeist ghost (from Phase 1c data):
- What ghost(s) are blocking it? (from `blocked_by` in dependencies response)
- How long blocked? (current time minus `updated_at` on the poltergeist ghost)
- Is the blocker assigned? (check `assigned_agent_id` or `assigned_user_id` on the blocking ghost)

### 2f. Per-haunting breakdown

For each haunting in the séance:
- Count ghosts by status
- Completion % = exorcised / total * 100

## Phase 3 — Render Dashboard

### 3a. Single séance dashboard

Present to the user:

```
═══════════════════════════════════════════
  SÉANCE DASHBOARD: [Séance Name]
═══════════════════════════════════════════

  SPECTRAL CENSUS
  ether (backlog):       XX  ░░░░░░░░░░░░░░░░░
  active_haunt (wip):    XX  ████░░░░░░░░░░░░░
  purgatory (review):    XX  ███░░░░░░░░░░░░░░
  poltergeist (blocked):  XX  ██░░░░░░░░░░░░░░░
  exorcised (done):      XX  ████████████░░░░░

  Total: XX ghosts | XX% exorcised

  VELOCITY (ghosts exorcised per week)
  Week -4: XX
  Week -3: XX
  Week -2: XX
  Week -1: XX
  Avg: X.X/week | Trend: [⬆ increasing / ➡ stable / ⬇ decreasing]
  At current velocity, backlog clears in ~X weeks

  PRIORITY BREAKDOWN
  banshee (critical): XX
  scream (high):      XX
  moan (medium):      XX
  whisper (low):      XX

  ACTIVE BLOCKERS
  ⛓ "[Ghost Title]" blocked by "[Blocking Ghost]" ([X days], [assigned to: name / unassigned])
  ⛓ "[Ghost Title]" blocked by "[Blocking Ghost]" ([X days], [unassigned])

  HAUNTING BREAKDOWN
  [Project 1]:  XX total | ████████░░ XX% done
  [Project 2]:  XX total | ██████████ XX% done
  ...

═══════════════════════════════════════════
```

**ASCII bar chart sizing:** Scale bars proportionally. Use `█` for filled and `░` for empty. Max bar width: 20 characters.

### 3b. Multi-séance summary (`--all` flag)

If `--all` is set, render a compact summary table instead of full dashboards:

```
═══════════════════════════════════════════════════════════════
  COVEN SÉANCE OVERVIEW
═══════════════════════════════════════════════════════════════

  Séance                  | Total | Done | WIP | Blocked | Backlog | Velocity
  ─────────────────────────────────────────────────────────────
  [Séance A]              |   42  |  18  |  5  |    2    |   17   | 3.2/wk
  [Séance B]              |   15  |   8  |  3  |    0    |    4   | 1.5/wk
  ...

═══════════════════════════════════════════════════════════════
```

For `--all`, skip the blocker details and per-haunting breakdown. The user can run `/seance [name]` for a deep dive on any specific séance.

## Error Handling

- **No séances found:** Report "Your coven has no séances. Create one first."
- **Séance has no ghosts:** Report "The séance is silent — no ghosts to report on."
- **No exorcised ghosts (velocity = 0):** Show dashboard but note "No velocity data yet."
- **API errors:** Report the error and stop.
- **Name fragment matches nothing:** List available séances and ask user to pick.
- **Pagination incomplete:** If an API call fails mid-pagination, report partial data with a warning.
