---
name: haunt-triage
description: Bulk triage backlog Ghost Hunting ghosts — find duplicate ghosts, suggest ghost priorities, flag vague context payloads, and group ghosts into rites (milestones). This triages GHOST HUNTING ghosts via the Agent API; repos that ship their own product /triage skill keep that name, and this skill is always reachable as ghost-hunting-core:haunt-triage. Use when the user says "haunt triage", "triage ghosts", "triage backlog", "clean up the ghost backlog", "prioritize ghosts", or "organize ether".
allowed-tools: Bash, Read
---

# Haunt Triage

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Bulk triage of backlog (ether) ghosts in Ghost Hunting: identify duplicates, suggest priorities, flag context quality gaps, and group into rites (milestones).

> **Not to be confused with a product `/triage`.** Some repos ship their own `/triage` skill that triages that product's OWN tasks (e.g. a life-management app's task lists) via that product's API. This skill, `/haunt-triage`, triages **Ghost Hunting ghosts** via the Agent API — the dev backlog for the repo you're in. If the user means the product's backlog, use the repo's `/triage` instead. This skill never collides with it: it is always invocable as `ghost-hunting-core:haunt-triage`.

## Arguments

Optional filters from `$ARGUMENTS`:

- **séance name or ID** — Limit to a specific portfolio
- **haunting name or ID** — Limit to a specific project
- **`all` / `coven`** — Triage all ether ghosts across the entire coven

If no argument is given, default to this repo's séance (resolved per Phase 0b below).

Arguments provided: `$ARGUMENTS`

## Flags

Check `$ARGUMENTS` for these optional flags:

- **`--local`** — Target the local API instead of production. Only honored when the repo's `.ghost/config.json` sets `api.allow_local_switch: true`; set `GK_LOCAL=1` before running the Phase 0 block. Otherwise ignore the flag and say so.
- **`--execute`** — Apply recommended changes (with per-batch user confirmation). Without this flag, report-only mode.
- **`--priority-only`** — Only analyze priorities, skip duplicate/rite analysis.

## Phase 0 — Bootstrap

### 0a. Config, credentials, preflight

If `$ARGUMENTS` contains `--local`, first:

```bash
export GK_LOCAL=1
```

Then run the canonical ghost-kit Phase 0 block:

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/haunt-triage${WF_STAMP:+ wf/$WF_STAMP}"

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

**Preflight verdict:** if `client_contract.status` is `unsupported`, STOP — tell the user to update ghost-kit before continuing. If `outdated`, print the message and continue. `current`/`unknown` → proceed silently.

**Use `$API_BASE`, `-H "$AUTH"`, and `-H "$GH_CLIENT"` on every API call throughout this skill.**

### 0b. Resolve scope

Strip flags from `$ARGUMENTS`. Check the remaining text:

- **`all` / `coven`** → no séance/haunting filter; triage all ether ghosts across the coven.
- **A UUID** → try matching it against séances and hauntings:

  ```bash
  curl -s "$API_BASE/api/agent/seances?limit=200" -H "$AUTH" -H "$GH_CLIENT"
  curl -s "$API_BASE/api/agent/hauntings?limit=200" -H "$AUTH" -H "$GH_CLIENT"
  ```

- **A name fragment** → fuzzy match against séance/haunting names from the same two lists.
- **No argument** → consult the posture first, `cfg '.seance.scope'` (default `seance`):
  - **`coven`** → the repo's backlog spans the whole coven, so the default triage scope IS the coven: set neither `SEANCE_ID` nor `HAUNTING_ID` and triage all ether ghosts coven-wide. (An explicit séance/haunting argument above still narrows.)
  - **`seance` (or absent)** → default to this repo's séance, resolved the canonical way: use `cfg '.seance.id'` directly when present. Otherwise resolve once via

    ```bash
    curl -s "$API_BASE/api/agent/seances" -H "$AUTH" -H "$GH_CLIENT" | jq -r --arg re "$(cfg '.seance.selector')" '.items[] | select(.name | test($re; "i")) | .id'
    ```

    — if the selector is empty, fall back to fuzzy-matching the repo name. In interactive use, confirm a fuzzy match with the user before writing anything; in autonomous/`--yes` mode, ABORT on fuzzy match instead. After resolving, suggest pinning the UUID into `.ghost/config.json`. If nothing resolves, ask the user whether to triage coven-wide.

Record `SEANCE_ID` or `HAUNTING_ID` for filtering (or neither, for coven-wide).

### 0c. Get coven ID

Extract `org_id` from the `$ME` response already fetched in 0a — this is the coven ID needed for rite operations:

```bash
COVEN_ID=$(echo "$ME" | jq -r '.org_id')
```

### 0d. Fetch existing rites

```bash
curl -s "$API_BASE/api/agent/covens/$COVEN_ID/rites?limit=200" -H "$AUTH" -H "$GH_CLIENT"
```

Rite statuses: `foretold` (planned) → `invoked` (active) → `sealed` (completed) or `unraveled` (cancelled).

> **CHECKPOINT — Phase 0 complete.** Proceed to Phase 1.

---

## Phase 1 — Fetch All Ether Ghosts

### 1a. Fetch with pagination

Build the query URL:

- Base: `$API_BASE/api/agent/ghosts?status=ether&limit=200`
- If `SEANCE_ID` set: add `&portfolio_id=$SEANCE_ID`
- If `HAUNTING_ID` set: add `&project_id=$HAUNTING_ID`

```bash
curl -s "$API_BASE/api/agent/ghosts?status=ether&limit=200[&filters]" -H "$AUTH" -H "$GH_CLIENT"
```

List endpoints return `{items: [...], total, limit, offset, has_more}`. **Implement full pagination:** check `has_more` and continue with `&offset=200`, `&offset=400`, etc. until all ether ghosts are collected.

### 1b. Report scope

Tell the user: "Found X ether ghosts [in séance/haunting name]. Analyzing..."

If 0 ghosts found: report "The ether is clear — no ghosts awaiting triage." and stop.

> **CHECKPOINT — Phase 1 complete.** Proceed to Phase 2.

---

## Phase 2 — Duplicate Detection (skip if `--priority-only`)

### 2a. Search-based duplicate detection

For each ghost, extract the 2-3 most distinctive words from its title (skip generic words like "add", "fix", "update", "implement", "create").

Search for potential duplicates:

```bash
curl -s "$API_BASE/api/agent/search?q=DISTINCTIVE_WORDS" -H "$AUTH" -H "$GH_CLIENT"
```

Note: Returns max 10 results per type. This is a known limitation — acknowledge it.

### 2b. Classify matches

For each ghost that returns matches in `tasks`:

- **Skip self-matches** (same ghost ID)
- **Skip non-ether matches** (different status = already being worked on, not a duplicate concern)

For remaining matches between ether ghosts, classify:

- **Exact duplicate** — Nearly identical title AND description. Recommend archiving one.
- **Near duplicate** — Very similar intent, likely the same work phrased differently. Recommend merging (keep the one with better context, archive the other).
- **Related** — Similar area but distinct work. Suggest adding a spirit bond.

### 2c. Collect findings

Record all duplicate pairs with classification and recommendation.

> **CHECKPOINT — Phase 2 complete.** Proceed to Phase 3.

---

## Phase 3 — Priority Analysis

### 3a. Analyze each ghost's priority

For each ghost, compare its current priority against its title and description using this calibration table:

| Priority | Signal words/phrases |
|----------|---------------------|
| `banshee` | "critical", "urgent", "crash", "data loss", "security vulnerability", "ASAP", "breaking production" |
| `scream` | "important", "bug", "broken", "needed soon", "high priority", "regression" |
| `moan` | Neutral — no urgency cues (default) |
| `whisper` | "nice to have", "someday", "minor", "low priority", "cosmetic" |

### 3b. Flag mismatches

Record ghosts where priority seems wrong:

- `whisper` ghost with urgent language → suggest upgrade
- `banshee` ghost with "nice to have" language → suggest downgrade
- No urgency cues at all → leave as-is (don't suggest changes for ambiguous cases)

> **CHECKPOINT — Phase 3 complete.** Proceed to Phase 4.

---

## Phase 4 — Context Quality Audit

### 4a. Fetch context for non-duplicate ghosts

Only fetch context for ghosts that survived duplicate detection (not flagged as "archive" candidates):

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" -H "$AUTH" -H "$GH_CLIENT"
```

### 4b. Score each ghost's context quality

Use this rubric:

| Score | Criteria |
|-------|----------|
| **Complete** | Has `objective` + `acceptance_criteria` (non-empty) + `files` (non-empty) + `instructions` (non-empty) |
| **Partial** | Has `objective` + at least one other field populated |
| **Minimal** | Has description > 20 characters but no context payload, OR context payload with only `objective` |
| **Empty** | No context payload AND description < 20 characters, OR context payload is null/empty |

### 4c. Collect findings

Record:

- Count per quality tier
- List of ghosts needing enrichment (Minimal + Empty) with what's missing

> **CHECKPOINT — Phase 4 complete.** Proceed to Phase 5.

---

## Phase 5 — Rite Grouping (skip if `--priority-only`)

### 5a. Cluster ghosts by theme

Analyze titles and descriptions to identify natural groupings. Common themes:

- UI/UX improvements
- API enhancements
- Infrastructure/DevOps
- Bug fixes
- Documentation
- Testing
- Performance
- Security

### 5b. Map to existing rites

Compare clusters to existing rites (from Phase 0d). Suggest:

- Assigning uncategorized ghosts to existing rites (by matching theme to rite name/description)
- Creating new rites for clusters that don't match any existing rite

If a ghost could fit multiple rites, note the ambiguity.

> **CHECKPOINT — Phase 5 complete.** Proceed to Phase 6.

---

## Phase 6 — Present Report & Execute

### 6a. Triage report

Present to the user:

```
═══════════════════════════════════════════
  SPECTRAL TRIAGE REPORT
═══════════════════════════════════════════

  Scope: [séance/haunting name or "Full Coven"]
  Ghosts analyzed: XX

  DUPLICATES FOUND (X pairs)
  ─────────────────────────────
  ⚠ "[Ghost A]" ~ "[Ghost B]" — [exact/near] duplicate
    → Recommend: Archive "[Ghost B]" (less detail)

  🔗 "[Ghost C]" ~ "[Ghost D]" — related (not duplicate)
    → Recommend: Add spirit bond

  PRIORITY ADJUSTMENTS (X ghosts)
  ─────────────────────────────
  ↑ "[Ghost Title]" — current: whisper → suggested: scream
    Reason: Description mentions "breaking change"
  ↓ "[Ghost Title]" — current: banshee → suggested: moan
    Reason: Description says "nice to have"

  CONTEXT QUALITY
  ─────────────────────────────
  Complete:  XX ghosts ████████████████████
  Partial:   XX ghosts ████████░░░░░░░░░░░░
  Minimal:   XX ghosts ████░░░░░░░░░░░░░░░░
  Empty:     XX ghosts ██░░░░░░░░░░░░░░░░░░

  Ghosts needing enrichment:
  - "[Ghost Title]" — missing: objective, acceptance_criteria, files
  - "[Ghost Title]" — missing: acceptance_criteria

  SUGGESTED RITE GROUPINGS
  ─────────────────────────────
  Existing Rite "[Rite Name]":
    + "[Ghost Title]" (currently unassigned to any rite)
    + "[Ghost Title]"

  New Rite "Infrastructure Hardening":
    + "[Ghost Title]"
    + "[Ghost Title]"

═══════════════════════════════════════════
```

### 6b. Execute changes (only if `--execute` flag is present)

If `--execute` is NOT set: stop after presenting the report.

If `--execute` IS set, process each category with user confirmation:

**Priority updates:**

Present the list of priority changes. Ask: "Apply these X priority changes? (y/n)"

If confirmed, use the bulk endpoint (max 100 IDs per call):

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/bulk/priority" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"task_ids": ["id1", "id2"], "priority": "scream"}'
```

Group by target priority and make one bulk call per priority level.

**Duplicate archival:**

For each confirmed duplicate pair, present them and ask: "Archive '[Ghost B]' as duplicate of '[Ghost A]'? (y/n)"

If confirmed:

```bash
# Post dedup EVP (the body field is `content`)
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_B_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"content": "Archived as duplicate of [Ghost A Title] ([Ghost A ID])"}'

# Set status to exorcised
curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_B_ID}/status" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"status": "exorcised"}'
```

**CRITICAL:** Never auto-archive. Always ask per duplicate pair.

**Rite creation and assignment:**

For each new rite suggestion, ask: "Create rite '[Name]' and assign X ghosts? (y/n)"

If confirmed:

```bash
# Create the rite
curl -s -X POST "$API_BASE/api/agent/covens/$COVEN_ID/rites" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"name": "[Rite Name]", "description": "[description]", "status": "foretold"}'
```

Then assign ghosts to the rite by updating each ghost's `milestone_id` (the JSON field is `milestone_id`, not `rite_id`):

```bash
curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"milestone_id": "[RITE_ID]"}'
```

For existing rite assignments, ask: "Assign X ghosts to existing rite '[Rite Name]'? (y/n)"

**Partial application is expected.** If the user confirms some changes and rejects others, that's fine. Report what was applied at the end.

### 6c. Execution summary

After all changes are applied (or skipped), report:

```
TRIAGE EXECUTION SUMMARY
─────────────────────────
Priority changes applied: X of Y
Duplicates archived: X of Y
Rites created: X
Ghosts assigned to rites: X
```

## API Gotchas

- EVP body field is `content`.
- List endpoints return `{items: [...]}` — not a bare array.
- JSON field names are standard even though URLs are spooky: `project_id` (not `haunting_id`), `portfolio_id` (not `seance_id`), `org_id` (not `coven_id`), `milestone_id` (not `rite_id`). Status/priority VALUES do use the spooky terms (`ether`, `banshee`, ...).
- Bulk endpoints (`POST /api/agent/ghosts/bulk/status` and `/bulk/priority`) accept up to 100 `task_ids` per call.

## Error Handling

- **No ether ghosts found:** Report "The ether is clear — no ghosts awaiting triage." and stop.
- **Large backlog (100+ ghosts):** Process in batches of 50 for duplicate detection. Show progress: "Analyzing ghosts 1-50 of 150..."
- **Bulk priority update fails:** Report the error, continue with other changes.
- **Rite creation fails:** Report the error, skip ghost assignment for that rite, continue with others.
- **Ghost status update fails (archival):** Report the error, continue with other duplicates.
- **Search endpoint returns no results:** Note that duplicate detection may be incomplete due to search limitations.
- **`--execute` without changes to make:** Report "No changes recommended — backlog looks healthy."
