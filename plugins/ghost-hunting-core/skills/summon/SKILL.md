---
name: summon
description: Create a well-structured ghost (task) from a natural language description with full context payload. Use when the user says "summon", "create ghost", "new ghost", "new task", "add task", or "summon ghost" followed by a description.
allowed-tools: Bash, Read, Grep, Glob
---

# Summon

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Create a fully-structured Ghost (task) from a natural language description, complete with context payload, duplicate checking, optional spirit bonds, and one-shot rite (milestone) / sigil (label) attachment.

## Arguments

The user provides a natural language description of what they want done.

**Invocation input** means the user's text after `/summon` (Claude) or
`$summon` (Codex). On a host that expands `$ARGUMENTS`, that expansion is the
same input. Never require literal `$ARGUMENTS` expansion.

## Flags

Check the invocation input for these optional flags:

- **`--local`** — Target the local API. Only honored when config allows it (see Conventions).
- **`--claim`** — Auto-claim the ghost after creation (uses built-in `claim: true` in the creation payload).
- **`--priority=LEVEL`** — Override auto-detected priority (whisper/moan/scream/banshee).
- **`--haunting=ID`** — Target a specific haunting (project) by UUID.
- **`--rite=ID_OR_NAME`** — Attach the ghost to a Rite (milestone) at creation time via `milestone_id` in the create payload (one shot — no follow-up call).
- **`--sigil=NAME[,NAME...]`** — Attach one or more Sigils (labels) right after creation.

## Phase 0 — Bootstrap (canonical)

If `--local` is in the invocation input, set `GK_LOCAL=1` before running this block.

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/summon${WF_STAMP:+ wf/$WF_STAMP}"

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

If unsure about an endpoint or schema, fetch the manifest — source of truth:

```bash
curl -s "$API_BASE/api/agent/manifest" | jq .
```

### Conventions

- **Preflight verdict:** if `client_contract.status` is `unsupported`, STOP — tell the user to update ghost-kit before continuing. If `outdated`, print the message and continue. `current`/`unknown` → proceed silently.
- **`--local` flag:** only honored when the repo's config sets `api.allow_local_switch: true` (set `GK_LOCAL=1` before the block). Otherwise ignore the flag and say so.
- **Séance resolution:** first read the posture — `SCOPE=$(cfg '.seance.scope')` (default `seance` when absent).
  - **`coven`:** the repo's backlog spans the whole coven, so there is no single séance to scope to — SKIP séance resolution and leave `SEANCE_ID` empty. Because summon must PLACE the new ghost in a haunting, list live hauntings **coven-wide** (no `portfolio_id` filter), keyword-match the description, and CONFIRM the target interactively before creating. In autonomous/`--yes` mode, REQUIRE an explicit `--haunting=ID` (or a `--rite` whose haunting is unambiguous) and ABORT rather than guess placement. See Phase 2b.
  - **`seance` (or absent):** use `cfg '.seance.id'` directly when present. Otherwise resolve once via:

    ```bash
    SEANCE_ID=$(cfg '.seance.id')
    [ -z "$SEANCE_ID" ] && SEANCE_ID=$(curl -s "$API_BASE/api/agent/seances" -H "$AUTH" -H "$GH_CLIENT" \
      | jq -r --arg re "$(cfg '.seance.selector')" '.items[] | select(.name | test($re; "i")) | .id' | head -1)
    ```

    If the selector is empty, fall back to fuzzy-matching the repo name (`$REPO_SLUG`) against séance names. In interactive use, confirm a fuzzy match with the user before writing anything; in autonomous/`--yes` mode, ABORT on fuzzy match instead. After resolving, suggest pinning the UUID into `.ghost/config.json` (`seance.id`). Never hardcode a séance name, regex, or UUID in this skill.
- **Generic mode (no `.ghost/config.json`):** everything still works via defaults — prod API, `GHOST_HUNTING_API_KEY` from `$REPO_ROOT/.env`, then the legacy `~/.claude/.env` (a config naming `auth.prod.org_id` reads the signed-in `GHOST_HUNTING_API_KEY__<ORG8>` from `~/.config/ghost-hunting/.env` instead — see Phase 0); séance fuzzy-matched from the repo dir name (confirm first).
- **API gotchas:** list endpoints return `{items: [...], total, limit, offset, has_more}` — always parse `.items[]`, never `.[]`. EVP body field is `content`. `PUT /ghosts/{id}/context` REPLACES the payload (GET → merge → PUT) — at creation time, `context_payload` in the POST body is fine. `pipeline_stage` has its own endpoint. JSON field names are standard (`project_id`, `milestone_id`, `portfolio_id` — not `haunting_id`/`rite_id`/`seance_id`).

## Phase 1 — Parse Intent

### 1a. Extract structured fields from the invocation input

Strip any flags (`--local`, `--claim`, `--priority=X`, `--haunting=X`, `--rite=X`, `--sigil=X`) from the arguments. The remaining text is the natural language description.

From the description, extract:

- **Title** — Concise, action-oriented (e.g., "Add pagination to ghost list endpoint"). Max ~80 characters.
- **Description** — Expanded explanation of what needs to be done and why.
- **Category** — One of: bug fix, new feature, enhancement, refactor, test, docs, DevOps.

### 1b. Determine priority

If `--priority=LEVEL` flag is present, use that value exactly.

Otherwise, infer from the description using this calibration table:

| Priority | Signal words/phrases |
|----------|---------------------|
| `banshee` | "critical", "urgent", "crash", "data loss", "security vulnerability", "ASAP", "breaking production" |
| `scream` | "important", "bug", "broken", "needed soon", "high priority", "regression" |
| `moan` | Neutral — no urgency cues, general improvements, enhancements (this is the **default**) |
| `whisper` | "nice to have", "someday", "minor", "low priority", "when you get a chance", "cosmetic" |

**Default to `moan` when uncertain.** Never infer `banshee` without strong urgency signals. Priority order: `banshee` > `scream` > `moan` > `whisper`.

## Phase 2 — Determine Target Haunting

### 2a. Check for `--haunting=ID` flag

If provided, use that UUID directly. Verify it exists:

```bash
curl -s "$API_BASE/api/agent/hauntings?limit=200" -H "$AUTH" -H "$GH_CLIENT" | jq '.items'
```

### 2b. If no flag, resolve from the live API

Consult the posture (Conventions). In **`coven`** scope, skip séance resolution and list hauntings **coven-wide** (omit the `portfolio_id` param). In **`seance`** scope, resolve the séance per the Conventions, then list hauntings scoped to it:

```bash
curl -s "$API_BASE/api/agent/hauntings?portfolio_id=$SEANCE_ID&limit=200" -H "$AUTH" -H "$GH_CLIENT"
```

- If the (séance- or coven-scoped) list has exactly **one** haunting, use it — no branching needed.
- Otherwise, match the description's topic/keywords against the live haunting names and descriptions (e.g., UI/dashboard topics → hauntings with "UI"/"UX" in the name; API/agent topics → hauntings with "API"/"Agent"; tests/infra → "Testing"/"Infrastructure").

**Do not hardcode a haunting map** — always list the live hauntings first and match against what the coven actually has. If a clear match is found, use it. If multiple matches or no match, present the haunting list to the user and ask which one to use.

**Placement in `coven` scope is deliberate, never guessed:** a keyword match across the whole coven is broader, so CONFIRM the chosen haunting with the user before creating. In autonomous/`--yes` mode there is no one to confirm with — REQUIRE an explicit `--haunting=ID` (or a `--rite` that pins the haunting) and ABORT with a clear message if neither is given, rather than guessing a coven-wide placement.

## Phase 3 — Duplicate Check

### 3a. Search for similar ghosts

Extract the 2-3 most distinctive words from the title (avoid generic words like "add", "fix", "update"). Search:

```bash
curl -s "$API_BASE/api/agent/search?q=DISTINCTIVE_WORDS" -H "$AUTH" -H "$GH_CLIENT"
```

Note: search returns max 10 results per type (`tasks`, `projects`, `portfolios`, `milestones`). Acknowledge this limitation.

### 3b. Evaluate matches

For each ghost in the `tasks` results:
- Compare title and description similarity
- Check status — if an identical ghost is already `active_haunt`, `purgatory`, or `exorcised`, warn the user

If a strong match is found:
- Show the potential duplicate: title, status, priority, haunting
- Ask: "This looks similar to ghost '[title]' (status: [status]). Create anyway, add as spirit bond, or work on the existing one?"
- If user says use existing, stop and report the existing ghost ID
- If user says spirit bond, proceed with creation and add the bond in Phase 5

If no matches or user confirms, proceed.

## Phase 4 — Build Context Payload

### 4a. Identify relevant files

Use the host's repository search and file-listing capabilities to find files related to the ghost's subject; when using a shell, prefer `rg` and `rg --files`:

- Search for keywords from the title/description in the codebase
- Look for related models, routes, components, tests
- Select the top 5-10 most relevant files

### 4b. Construct the context payload

Build a complete `context_payload` with these fields:

```json
{
  "objective": "[Single sentence rewrite of user's intent — clear and specific]",
  "instructions": [
    "[Numbered step 1 — specific action]",
    "[Numbered step 2 — specific action]",
    "[...]"
  ],
  "repository": "[Repo URL or path — use $REPO_SLUG / the git remote when known]",
  "files": [
    "[path/to/relevant/file1]",
    "[path/to/relevant/file2]"
  ],
  "acceptance_criteria": [
    "[Testable boolean assertion 1 — e.g., 'GET /api/agent/ghosts returns paginated results with has_more field']",
    "[Testable boolean assertion 2]",
    "[All existing tests continue to pass]"
  ],
  "constraints": [
    "Follow the active project guidance",
    "[Domain-specific constraint from the description]"
  ],
  "resources": [],
  "output_format": "Post EVP with files changed and test results",
  "agent_notes": null
}
```

**Rules for each field:**
- `objective` — Single sentence. Rewrite the user's words into a clear, specific goal. Not a quote.
- `instructions` — Numbered steps. Be specific about what to create/modify. Reference file paths.
- `repository` — The repo this work happens in; helps agents picking the ghost up from another context.
- `files` — Paths from Phase 4a. Only include files that will actually be touched or are critical reference.
- `acceptance_criteria` — Each must be a testable yes/no assertion. Always include "All existing tests continue to pass."
- `constraints` — Include "Follow the active project guidance" always. Add others from the description.

## Phase 5 — Create the Ghost

### 5a. Resolve the rite (if `--rite` given)

If the value is a UUID, use it directly. Otherwise resolve by name against the coven's rites (read your coven id from the Phase-0 `$ME` response, field `org_id`):

```bash
ORG_ID=$(echo "$ME" | jq -r '.org_id')
curl -s "$API_BASE/api/agent/covens/$ORG_ID/rites" -H "$AUTH" -H "$GH_CLIENT" | jq '.items'
```

Case-insensitive match on rite name. If no match, list the rites and ask the user — never silently create a new rite.

### 5b. Create via API

```bash
curl -s -X POST "$API_BASE/api/agent/hauntings/{HAUNTING_ID}/ghosts" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{
    "title": "[title]",
    "description": "[description]",
    "priority": "[priority]",
    "context_payload": { ... },
    "milestone_id": "[RITE_UUID — only if --rite was given]",
    "claim": [true if --claim flag present, false otherwise]
  }'
```

`milestone_id` in the create payload attaches the rite in the same call — no follow-up needed. (Hauntings may carry a `default_milestone_id`; new ghosts auto-inherit it when you send none.)

Record the returned ghost ID.

### 5c. Attach sigils (if `--sigil` given)

Resolve each name against existing sigils, creating missing ones:

```bash
curl -s "$API_BASE/api/agent/sigils" -H "$AUTH" -H "$GH_CLIENT"          # list — match name case-insensitively
curl -s -X POST "$API_BASE/api/agent/sigils" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"name": "[name]", "color": "[#hex]"}'                              # create if missing
curl -s -X POST "$API_BASE/api/agent/ghosts/{NEW_GHOST_ID}/sigils" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"label_id": "[SIGIL_UUID]"}'                                       # attach
```

### 5d. Add spirit bonds (if related ghosts identified in Phase 3)

If the user chose to add a spirit bond to a related ghost:

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{NEW_GHOST_ID}/dependencies" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"depends_on_id": "[RELATED_GHOST_ID]"}'
```

**Directionality:** The new ghost `depends_on` the related ghost (the new ghost cannot be claimed until the related ghost is exorcised). Only add this if the new ghost genuinely depends on the other — don't create bonds just because they're related.

### 5e. Report to user

```
GHOST SUMMONED
==============

Title:    [title]
ID:       [ghost_id]
Priority: [priority] ([whisper=Low / moan=Medium / scream=High / banshee=Critical])
Haunting: [project name]
Status:   [ether / active_haunt if claimed / purgatory if planned]
Rite:     [rite name / none]
Sigils:   [names / none]

Objective: [objective from context payload]

Acceptance Criteria:
- [criterion 1]
- [criterion 2]
- [criterion 3]

Files to Touch:
- [file 1]
- [file 2]

Spirit Bonds: [none / depends on: "[ghost title]"]
```

If `--claim` was used, note: "Ghost is claimed and ready for `/commence-haunt [ID]` in Claude or `$commence-haunt [ID]` in Codex."

## Error Handling

- **No hauntings available:** Report error — at least one haunting must exist to create a ghost.
- **Description too vague (under 10 words, no actionable intent):** Ask the user for more detail before creating.
- **Description implies multiple distinct tasks:** Suggest creating multiple ghosts. Ask user to confirm or pick one.
- **Duplicate found and user declines creation:** Stop gracefully, report the existing ghost.
- **API creation fails:** Report the error with full response body.
- **Cannot determine target haunting:** Ask the user explicitly — never guess.
- **`--rite` name matches nothing:** List available rites and ask; do not create one silently.
- **Sigil attach fails:** Ghost is still created. Report which sigils failed to attach.
- **`--claim` fails (e.g., Spirit Bonds block it):** Ghost is still created but unclaimed. Report the claim error.
