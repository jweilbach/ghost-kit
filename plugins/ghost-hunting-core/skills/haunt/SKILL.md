---
name: haunt
description: Find a ghost (task) to work on from the Ghost Hunting backlog. Use when the user says "ghost hunting", "haunt", or a priority level like "whisper", "moan", "scream", or "banshee".
allowed-tools: Bash, Read
---

# Find a Ghost to Haunt

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Use the Ghost Hunting Agent API to find an available task from this repo's séance (the development backlog), resolved from `.ghost/config.json`.

## Arguments

The user may provide a priority level: `whisper`, `moan`, `scream`, or `banshee`.
- If no argument is provided, find any available task (prioritize higher urgency)
- If a priority is specified, filter to only that level
- Pass `--local` to target the local backend instead of production (only honored when config allows it — see below)

Arguments provided: `$ARGUMENTS`

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/haunt${WF_STAMP:+ wf/$WF_STAMP}"

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
  - **`coven`:** SKIP séance resolution — leave `SEANCE_ID` empty and operate **coven-wide**. Drop the `portfolio_id` filter on the ghost fetch below (the endpoint returns coven-scoped data with no filter), and show each ghost's séance + haunting attribution in the output so the user can see where things live.
  - **`seance` (or absent):** use `cfg '.seance.id'` directly when present. Otherwise resolve once via:

    ```bash
    SEANCE_ID=$(cfg '.seance.id')
    [ -z "$SEANCE_ID" ] && SEANCE_ID=$(curl -s "$API_BASE/api/agent/seances" -H "$AUTH" -H "$GH_CLIENT" \
      | jq -r --arg re "$(cfg '.seance.selector')" '.items[] | select(.name | test($re; "i")) | .id' | head -1)
    ```

    If the selector is empty, fall back to fuzzy-matching the repo name (`$REPO_SLUG`) against séance names. In interactive use, confirm a fuzzy match with the user before writing anything; in autonomous/`--yes` mode, ABORT on fuzzy match instead. After resolving, suggest pinning the UUID into `.ghost/config.json` (`seance.id`). Never hardcode a séance name, regex, or UUID in this skill.
- **Generic mode (no `.ghost/config.json`):** everything still works via defaults — prod API, `GHOST_HUNTING_API_KEY` from `$REPO_ROOT/.env` then `~/.claude/.env`, séance fuzzy-matched from the repo dir name (confirm first).
- **API gotchas:** list endpoints return `{items: [...], total, limit, offset, has_more}` — always parse `.items[]`, never `.[]`. EVP body field is `content`. `PUT /ghosts/{id}/context` REPLACES the payload (GET → merge → PUT). `pipeline_stage` has its own endpoint. JSON field names are standard (`project_id`, not `haunting_id`).

## Instructions

1. **Resolve the séance** per the Conventions above. In `seance` scope, if no séance can be resolved, list the available séances (`.items[].name`) so the user can clarify. In `coven` scope (`cfg '.seance.scope'` = `coven`), there is no séance to resolve — skip straight to the coven-wide fetch below.

2. **Fetch ghosts using query param filters** (single efficient API call). **In `coven` scope, omit the `portfolio_id=$SEANCE_ID` param entirely** so the fetch spans the whole coven; otherwise keep it:

If a priority is specified (whisper/moan/scream/banshee):
```bash
curl -s "$API_BASE/api/agent/ghosts?portfolio_id=$SEANCE_ID&status=ether&priority=PRIORITY" \
  -H "$AUTH" -H "$GH_CLIENT"
```

If no priority is specified (get all ether ghosts, sorted by priority):
```bash
curl -s "$API_BASE/api/agent/ghosts?portfolio_id=$SEANCE_ID&status=ether" \
  -H "$AUTH" -H "$GH_CLIENT"
```

The response is paginated — the ghosts are in `.items`.

3. **Select ONE ghost** from the results:
   - Results are already sorted by priority (banshee > scream > moan > whisper)
   - Pick the first one (highest priority)

4. **Get the ghost's full details** including context_payload:

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}" \
  -H "$AUTH" -H "$GH_CLIENT"
```

5. **Check for Spirit Bonds (dependencies)**:

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/with-dependencies" \
  -H "$AUTH" -H "$GH_CLIENT"
```

6. **Present the ghost to the user** with:
   - Title and priority
   - Description
   - Project (Haunting) it belongs to, within its séance (in `coven` scope, always show BOTH the séance and haunting so the user sees where it lives)
   - Context payload (if any) — the structured instructions
   - Dependencies status (blocked or clear)
   - Ask if they want to claim it and start working

## Query Param Reference

The `/api/agent/ghosts` endpoint supports these filters:
- `portfolio_id` — Filter to ghosts in hauntings within a specific séance
- `project_id` — Filter to ghosts in a specific haunting
- `priority` — Filter by priority: whisper, moan, scream, banshee
- `status` — Filter by status: ether, active_haunt, purgatory, poltergeist, exorcised

Filters can be combined, e.g.: `?portfolio_id=X&status=ether&priority=scream`

## Priority Mapping

| Level | DB Value | Urgency |
|-------|----------|---------|
| Whisper | `whisper` | Low |
| Moan | `moan` | Medium |
| Scream | `scream` | High |
| Banshee | `banshee` | Critical |

## Status Reference

`ether` (backlog) → `active_haunt` (in progress) → `purgatory` (in review) / `poltergeist` (blocked) → `exorcised` (done)

## Example Output

When presenting the ghost, format it like:

---

**Ghost Found: [Title]**

- **Priority:** Scream (High)
- **Séance:** [Séance Name]
- **Haunting:** [Project Name]
- **Status:** In the Ether (unclaimed)

**Description:**
[Description text]

**Context Payload:**
- Objective: [objective]
- Files: [list of files]
- Acceptance Criteria: [criteria]

**Spirit Bonds:** None / Blocked by: [dependency titles]

Would you like me to claim this ghost and start working on it?

---

If no ghosts match the criteria, inform the user that the Ether is clear at that priority level (or for the entire séance — or the entire coven, in `coven` scope).
