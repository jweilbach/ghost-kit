---
name: haunt-status
description: Report my Ghost Hunting workload — identity and assigned ghosts grouped by status. Use when the user says "haunt status", "my ghosts", "what am I hunting", or "my assignments".
allowed-tools: Bash
---

# Haunt Status

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Report the Medium's identity and current Ghost Hunting workload by calling `/api/agent/me` and `/api/agent/my-assignments`.

This is **not** a local-ops health check — for service up/down status use the repo's own status skill (if it has one).

## Arguments

- Pass `--local` to target the local backend instead of production (only honored when config allows it — see Conventions).

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/haunt-status${WF_STAMP:+ wf/$WF_STAMP}"

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
- **Séance resolution:** assignments are agent-scoped and span séances, so no séance is needed for the default report. If the user asks to scope to *this repo's* backlog, first check the posture — `cfg '.seance.scope'` (default `seance`). In **`coven`** scope, "this repo's backlog" IS the whole coven, so there is nothing to narrow: report all assignments coven-wide (skip the resolution below). In **`seance`** scope (or absent), resolve the séance the standard way — `cfg '.seance.id'` when present, otherwise:

  ```bash
  SEANCE_ID=$(cfg '.seance.id')
  [ -z "$SEANCE_ID" ] && SEANCE_ID=$(curl -s "$API_BASE/api/agent/seances" -H "$AUTH" -H "$GH_CLIENT" \
    | jq -r --arg re "$(cfg '.seance.selector')" '.items[] | select(.name | test($re; "i")) | .id' | head -1)
  ```

  If the selector is empty, fall back to fuzzy-matching the repo name (`$REPO_SLUG`); confirm a fuzzy match with the user before acting on it, and suggest pinning the UUID into `.ghost/config.json` (`seance.id`). Never hardcode a séance name, regex, or UUID in this skill.
- **Generic mode (no `.ghost/config.json`):** everything still works via defaults — prod API, `GHOST_HUNTING_API_KEY` from `$REPO_ROOT/.env` then `~/.claude/.env`.
- **API gotchas:** list endpoints return `{items: [...], total, limit, offset, has_more}` — always parse `.items[]`, never `.[]` (`/my-assignments` is the exception: it returns status-keyed groups, not a flat list). EVP body field is `content`. JSON field names are standard (`project_id`, not `haunting_id`).

## Instructions

### 1. Verify identity

Phase 0 already fetched `/api/agent/me` into `$ME`. Show: agent name (`.name`), coven name (`.org_name` — your Coven/organization's name), any declared capabilities (`.capabilities`). `.org_name` may be null on older backends that predate the field — omit the `COVEN:` line if so.

- If Phase 0 printed a `STOP:` line (no key, a rejected key, or a key for another Coven), relay that line — it names the key's source file and `/ghost-onboard` — and stop.
- If the call returned 401, the talisman is invalid or expired — stop and tell the user.

### 2. Fetch assignments

```bash
curl -s "$API_BASE/api/agent/my-assignments" -H "$AUTH" -H "$GH_CLIENT"
```

The response groups ghosts by status (`active_haunt`, `purgatory`, `ether`, `poltergeist`, `exorcised`) with summary counts, sorted by priority (banshee > scream > moan > whisper) within each group.

For a flat, filterable list instead (e.g., only `purgatory`, or a single project), use the paginated endpoint — results are in `.items`:

```bash
curl -s "$API_BASE/api/agent/my-ghosts?status=purgatory" -H "$AUTH" -H "$GH_CLIENT"
```

**Repo scoping (optional):** if the user asks for "my ghosts in this repo/séance", resolve the séance per the Conventions, list its hauntings (`GET /api/agent/hauntings?portfolio_id=$SEANCE_ID`, parse `.items`), and keep only assignments whose `project_id` is one of those hauntings.

### 3. Present the workload

Format like:

```
MEDIUM: [agent_name]
COVEN:  [coven_name]

ASSIGNMENTS
===========
Active (active_haunt):  N
  - [banshee] [title] — [id]
  - [scream]  [title] — [id]
In Review (purgatory):  N
  - ...
Backlog (ether):        N
Blocked (poltergeist):  N
Completed (exorcised):  N (last 10)
```

Show at most the top ~5 per group. If a group is empty, show "(none)".

### 4. Suggest next action

- If `active_haunt` is non-empty, suggest: `"Top priority: run /commence-haunt <id> to continue [title]."`
- Else if `purgatory` is non-empty, suggest: `"Ready for review: run /review-haunt <id> on [title]."`
- Else if `ether` is non-empty and assigned to you, suggest: `"Ready to start: run /commence-haunt <id> on [title]."`
- Else: `"Inbox is clear. Run /haunt to pick up a new ghost from this repo's backlog."`

## Error Handling

- **Missing talisman:** Tell the user `$KEY_VAR` is missing from the configured env files. Stop.
- **401 Unauthorized:** Tell the user the talisman is invalid or expired. Stop.
- **Network error:** Report the failure and suggest retrying.
