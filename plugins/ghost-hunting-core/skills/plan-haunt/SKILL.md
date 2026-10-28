---
name: plan-haunt
description: Plan a ghost's implementation with adversarial review, post the plan, and move to purgatory. Use when the user says "plan haunt", "plan ghost", or "plan" followed by a ghost ID or title fragment.
---

# Plan Haunt

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Plan a Ghost's implementation **without executing it**. Produces a Spectral Plan (full implementation blueprint), posts it as an EVP, saves it to context for later use by `ghost-hunting-core:commence-haunt`, and moves the ghost to Purgatory (In Review).

**This skill has 5 phases (0-4). Phase 4 (Publish) is MANDATORY. Never stop after Phase 3.**

## Arguments

The user provides a **ghost ID** (full UUID or short prefix) or a **title fragment** to search for.

Arguments provided: `$ARGUMENTS`

## Flags

Check `$ARGUMENTS` for these optional flags:

- **`--autonomous`** — Skip plan mode and adversarial-review user approval (for non-interactive `claude -p` execution). Default: interactive with plan approval.
- **`--local`** — Target the local API (`cfg '.api.local_base'`). Honored **only** when the repo's `.ghost/config.json` sets `api.allow_local_switch: true`: set `GK_LOCAL=1` in the environment **before** running the Phase-0 block. Otherwise ignore the flag and tell the user why.
- **`--no-review`** — Skip adversarial review (for trivial/obvious plans).

## Phase 0 — Bootstrap & Validate

### 0a. Config, credentials, preflight

Run the canonical ghost-kit Phase-0 block (if `--local` was requested and the config allows it, `export GK_LOCAL=1` first):

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/plan-haunt${WF_STAMP:+ wf/$WF_STAMP}"

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

**Generic mode (no `.ghost/config.json`):** everything still works via the block's defaults — prod API, `GHOST_HUNTING_API_KEY` from `$REPO_ROOT/.env` then `~/.claude/.env`, séance fuzzy-matched from the repo dir name (confirm first).

**Use `$API_BASE`, `$AUTH`, and `$GH_CLIENT` on every API call in this skill.**

Fetch and read the manifest — it is the source of truth for all endpoints, schemas, and workflows:

```bash
curl -s "$API_BASE/api/agent/manifest" | jq .
```

### 0b. Resolve the ghost

If UUID (or prefix): `curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}" -H "$AUTH" -H "$GH_CLIENT"`

If title fragment: `curl -s "$API_BASE/api/agent/search?q={QUERY}" -H "$AUTH" -H "$GH_CLIENT"` — pick from the `tasks` array.

If multiple matches, prefer ghosts whose haunting belongs to this repo's séance (resolved below) — **except in `coven` scope**, where the backlog spans the whole coven, so there is no séance to prefer: disambiguate across the whole coven. Still ambiguous → ask the user to clarify (interactive) or abort (`--autonomous`). If no match, report and stop.

**Séance resolution (only when needed for disambiguation):** first read the posture — `cfg '.seance.scope'` (default `seance`). In **`coven`** scope, SKIP this resolution entirely (`seance.id`/`seance.selector` are ignored) and disambiguate coven-wide. In **`seance`** scope (or absent), use `cfg '.seance.id'` directly when present. Otherwise resolve once:

```bash
SEANCE_ID=$(cfg '.seance.id')
[ -z "$SEANCE_ID" ] && SEANCE_ID=$(curl -s "$API_BASE/api/agent/seances" -H "$AUTH" -H "$GH_CLIENT" \
  | jq -r --arg re "$(cfg '.seance.selector')" '.items[] | select(.name | test($re; "i")) | .id')
```

If the selector is empty, fall back to fuzzy-matching the repo name against séance names. Interactive: confirm a fuzzy match with the user before writing anything; `--autonomous`: ABORT on a fuzzy match instead. After resolving, suggest pinning the UUID into `.ghost/config.json`.

### 0c. Check for existing plan

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" -H "$AUTH" -H "$GH_CLIENT"
```

Check if `agent_notes` contains `<!-- plan_version:`. If an existing plan is found:

- Display the plan date, complexity, and overview
- Ask the user: **Overwrite** (continue planning), **View** (display existing plan and stop), or **Cancel** (stop)
- If `--autonomous`: overwrite automatically without prompting

### 0d. Check ghost status

Handle based on current status:

- **`exorcised`** — Stop: "Ghost is already exorcised. Nothing to plan."
- **`purgatory`** — Warn: "Ghost is already in Purgatory (In Review). Planning will overwrite existing context. Continue?" (autonomous: continue)
- **`active_haunt`** claimed by another agent — Stop: "Ghost is claimed by another medium."
- **`active_haunt`** claimed by self — Warn: "Ghost is already in progress. Continue?" (autonomous: continue)
- **`ether`** or **`poltergeist`** — Proceed normally

### 0e. Check Spirit Bonds (dependencies)

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/with-dependencies" -H "$AUTH" -H "$GH_CLIENT"
```

If `blocked_by_incomplete` is `true`:

- **Do NOT stop.** Plans can be made for blocked ghosts.
- Set a flag: `GHOST_IS_BLOCKED=true`
- Record the blocking ghost titles/IDs for inclusion in the plan
- **Skip claiming** (claim will fail for blocked ghosts)
- Later: skip the purgatory status change, post the plan as EVP + agent_notes only

If not blocked: proceed to claim.

### 0f. Claim the ghost (if not blocked)

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/claim" -H "$AUTH" -H "$GH_CLIENT"
```

If claim fails (already claimed by another agent), report and stop. If already claimed by self, continue.

### 0g. Post "Claimed for planning" EVP

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"content": "Ghost claimed for planning. Exploring codebase and designing implementation."}'
```

If blocked (not claimed), post instead: "Beginning plan for blocked ghost. Spirit Bonds pending: [list]."

### 0h. Read existing EVPs

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" -H "$AUTH" -H "$GH_CLIENT"
```

(List endpoints return `{items: [...]}` — read the `items` array.)

### 0i. Display ghost summary

Show the user: title, priority, haunting (project), description, context payload, existing EVPs, Spirit Bonds status (including blocked-by list if applicable).

> **CHECKPOINT — Phase 0 complete.** Proceed to Phase 1.

---

## Phase 1 — Explore

### 1a. Recall Imprints (memory) — before anything else

Before you explore, recall what the Coven already learned. Imprints are atomic, typed memory records — `fact` / `convention` / `preference` / `gotcha` / `procedure` — that earlier Mediums wrote back on this Haunting or Coven-wide. A `gotcha` recorded by a previous run has to reach the plan BEFORE it is approved, not after (the 4d write-back only recalls to dedupe). The query and `project_id` are built from the ghost JSON with `jq`, never pasted into the shell (this is `ghost-hunting-core:commence-haunt` Phase 1a, verbatim, with its own ghost GET):

```bash
GHOST_JSON="/tmp/ghost.{GHOST_ID}.json"
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}" -H "$AUTH" -H "$GH_CLIENT" -o "$GHOST_JSON"
RECALL_JSON="/tmp/recall.{GHOST_ID}.json"
RECALL_MECH_JSON="/tmp/recall-mech.{GHOST_ID}.json"
RECALL_MD="/tmp/recall.{GHOST_ID}.md"
: > "$RECALL_MD"
: > "$RECALL_MECH_JSON"
: > "$RECALL_JSON"
# Guard: a failed or empty ghost GET makes BOTH jq queries empty, and an empty query is a
# query-less recall — the newest imprints at match 1.0, printed as if they were hits. The
# per-axis checks below already refuse to call with an empty query; this says WHY out loud.
jq -e '.id and .title' "$GHOST_JSON" >/dev/null 2>&1 || echo "ghost GET failed — skipping recall (a query-less recall is not a match)"

# TWO AXES, TWO CALLS — never merge them into ONE query. FEATURE = the ghost's title words.
# MECHANISM = the identifiers and file paths in its context payload (context_payload.files when
# present, else the snake_case / camelCase / path-shaped tokens in its prose). Imprints are written
# in MECHANISM vocabulary (`_ACTION_TO_EVENT_TYPE`, `actionRegistry.js`) while ghost titles name
# FEATURES, so a title-only recall cannot reach the gotcha it most needs — that is how imprint
# 9e59b78d was written by the wave that learned it and recalled by none that needed it. They stay
# TWO calls because ts_rank has no IDF (backend/app/repositories/memory.py): merged into one query
# the generic title words outrank the single rare mechanism term at ANY limit, so raising the
# server's 500-char cap does NOT fix it. Both queries are capped to 500 chars here — the server
# 422s above that, and a long title alone could already exceed it.
RECALL_BODY=$(jq '{query: ([.title | scan("[[:alnum:]]{2,}")] | map(ascii_downcase) | unique | join(" OR ")), project_id: .project_id}' "$GHOST_JSON")
RECALL_MECH_BODY=$(jq '{query: (([.title | scan("[[:alnum:]]{2,}")] | map(ascii_downcase) | unique) as $feat | [(.context_payload // {}) | if (.files? | type) == "array" then (.files[] | tostring) else (tostring | scan("[A-Za-z0-9]+_[A-Za-z0-9_]+|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+")) end] | map(split("/") | (.[-1] | sub("\\.[^.]*$";"")) as $s | (if ($s | ascii_downcase | test("^(index|main|init|app|mod|types|utils|helpers|constants)$")) then ((.[-2] // "") + " " + $s) else $s end)) | map(gsub("(?<a>[a-z0-9])(?<b>[A-Z])";"\(.a) \(.b)") | ascii_downcase) | map(scan("[a-z0-9]+")) | map(select(length >= 3)) | map(. as $w | select((["js","jsx","ts","tsx","mjs","cjs","py","md","mdx","json","sh","bash","yml","yaml","toml","ini","sql","css","scss","html","txt","test","tests","spec","specs","and","not"] | index($w)) == null and ($feat | index($w)) == null)) | unique | reduce .[] as $w ([]; if ((. + [$w]) | join(" OR ") | length) <= 500 then . + [$w] else . end) | join(" OR ")), project_id: .project_id}' "$GHOST_JSON")

# An EMPTY query is not a narrow query: the server maps "" to None and returns the NEWEST imprints
# at match 1.0, which would print as if they were hits. An axis with no terms is not called.
if [ -n "$(printf '%s' "$RECALL_BODY" | jq -r '.query')" ]; then
  RECALL_CODE=$(curl -s -X POST "$API_BASE/api/agent/imprints/recall" \
    -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d "$RECALL_BODY" \
    -o "$RECALL_JSON" -w '%{http_code}')
else
  RECALL_CODE="skipped (no title terms)"
fi
if [ -n "$(printf '%s' "$RECALL_MECH_BODY" | jq -r '.query')" ]; then
  RECALL_MECH_CODE=$(curl -s -X POST "$API_BASE/api/agent/imprints/recall" \
    -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d "$RECALL_MECH_BODY" \
    -o "$RECALL_MECH_JSON" -w '%{http_code}')
else
  RECALL_MECH_CODE="skipped (no mechanism terms)"
fi

# Both axes render the identical line shape, so a whole-line dedupe IS an exact dedupe by imprint.
{ jq -r 'select((.items|type)=="array") | .items[] | "- [\(.memory_type) · \(.scope)] **\(.title)** — \(.content) _(imprint \(.id[0:8]); learned on: \(.source_task_title // "—"))_"' "$RECALL_JSON" 2>/dev/null
  jq -r 'select((.items|type)=="array") | .items[] | "- [\(.memory_type) · \(.scope)] **\(.title)** — \(.content) _(imprint \(.id[0:8]); learned on: \(.source_task_title // "—"))_"' "$RECALL_MECH_JSON" 2>/dev/null; } | awk "NF && !seen[\$0]++" > "$RECALL_MD"

if [ -s "$RECALL_MD" ]; then
  echo "### Recalled imprints"; cat "$RECALL_MD"
elif jq -e '.items | type == "array"' "$RECALL_JSON" >/dev/null 2>&1 || jq -e '.items | type == "array"' "$RECALL_MECH_JSON" >/dev/null 2>&1; then
  echo "recall: empty (nothing recorded for these terms)"
else
  echo "RECALL FAILED (feature HTTP $RECALL_CODE, mechanism HTTP $RECALL_MECH_CODE) — planning WITHOUT the coven's memory:"
  [ -s "$RECALL_JSON" ] && { jq -c '.' "$RECALL_JSON" 2>/dev/null || cat "$RECALL_JSON"; } || echo "(empty response body — connection failed?)"
  [ -s "$RECALL_MECH_JSON" ] && { jq -c '.' "$RECALL_MECH_JSON" 2>/dev/null || cat "$RECALL_MECH_JSON"; } || true
fi
```

- Hits come back in rank order with **full content** — read every one; a `gotcha` or `convention` here changes the plan. `relevance` is opaque (0..1, comparable only with the other hits of this one response): sort by it, never threshold on it or store it.
- **Non-empty:** surface the block as **"Recalled imprints"** to the user (interactive), and carry it into the plan under a `### Recalled imprints` heading (see the Spectral Plan template) so `commence-haunt` and the Review Mediums inherit it from `agent_notes`.
- **Empty (`items: []`):** proceed silently — no block, no EVP, no note.
- **Failed (no `items` in the response):** this is NOT "nothing recorded" — say so out loud and record `recall failed: <HTTP code>` in the plan EVP (4b), so the missing memory is diagnosable from the EVP trail rather than looking like an empty Coven. Then plan without it; a failed recall never blocks the plan.
- Recall is a read (never journaled; safe to repeat) — recall again with a narrower key phrase before planning an unfamiliar subsystem.

### 1b. Explore

1. Read context payload fields: `objective`, `instructions`, `files`, `acceptance_criteria`, `constraints`
2. **Explore all files** listed in context `files`, plus related files discovered via Glob/Grep
3. Understand existing patterns, utilities, and code that can be reused
4. Note the repo's conventions relevant to this ghost's scope — read the repo's CLAUDE.md and check `cfg '.implement.notes'` for stack-specific ordering hints

> **CHECKPOINT — Phase 1 complete.** Proceed to Phase 2.

---

## Phase 2 — Plan

**Check if `--autonomous` is in the arguments.**

### If `--autonomous` is present:

**DO NOT use EnterPlanMode or ExitPlanMode.** Plan in your thinking and proceed directly to Phase 3.

### If `--autonomous` is NOT present (default interactive mode):

**Enter plan mode** using `EnterPlanMode`. Design the plan, then **exit plan mode** via `ExitPlanMode` for user review BEFORE the adversarial review step (gives the user early feedback opportunity).

### Plan contents — use the Spectral Plan template:

```markdown
## Spectral Plan — [Ghost Title]

### Overview
[1-3 sentences: what approach and why]

### Complexity: [rating] | Confidence: [rating]

Complexity calibration:
- **trivial**: 1-3 files, no schema changes, single-concern fix
- **moderate**: 3-10 files, may include schema/migration, touches backend + frontend within existing patterns
- **complex**: 10-20 files, new endpoints + components, schema changes, cross-cutting concerns
- **ambitious**: 20+ files, new subsystems, architectural changes

Confidence calibration:
- **high**: Clear requirements, well-understood code area, strong existing patterns
- **medium**: Some ambiguity, touching less-familiar areas
- **low**: Vague requirements, architectural uncertainty, critical auth/data paths

### Recalled imprints
[the Phase 1a block, verbatim — drop this heading entirely when recall was empty]

### Files to Modify
| File | Action | Description |
|------|--------|-------------|
| `path/to/file` | create/modify/delete | What changes |

### Implementation Steps
1. [Ordered steps with specific file paths and function signatures]
2. [Follow dependency order: schema/data layer → domain/services → API surface → frontend. Apply the repo's stack-specific ordering hints from `cfg '.implement.notes'` when present.]

### Test Plan
| Test File | Functions | What's Tested |
|-----------|-----------|---------------|
| `[backend test path per repo conventions]` | `test_a`, `test_b` | Endpoint CRUD, edge cases |
| `[frontend test path per repo conventions]` | `test_c` | Component rendering, interactions |

### Acceptance Criteria Coverage
| Criterion | Implementation Step | Test |
|-----------|-------------------|------|
| [criterion from context] | Step N | test_foo |
| [criterion from context] | Step M | test_bar |

### Risks & Concerns
- [Risk items, dependencies, areas of uncertainty]

### Spirit Bond Warning (if blocked)
> **This ghost is blocked by incomplete Spirit Bonds:** [list with titles/IDs].
> The plan cannot be executed until these are exorcised.
```

### Planning steps (both modes):

1. **Design the implementation** — Plan all changes following the repo's conventions (CLAUDE.md): data models, migrations, services, API endpoints, components, hooks, pages, routes.

2. **Design the test plan** — Plan ALL tests, following the repo's test layout and naming conventions. List every test file and function. The plan must be runnable via the repo's configured test commands (`cfg '.tests.backend'` / `'.tests.frontend'` / `'.tests.all'`); if a needed command is missing from `.ghost/config.json`, flag it under Risks — the implement/review gates will skip that suite with a warning.

3. **Map acceptance criteria** — For every acceptance criterion in the context, identify which implementation step addresses it and which test verifies it. Flag any criteria with no coverage.

4. **Assess complexity and confidence** — Rate using the calibration tables.

5. **Write the full plan** — Use the Spectral Plan template above. Include specific file paths, function signatures, and test cases. When the Phase 1a recall was non-empty, include its block verbatim under `### Recalled imprints` (omit the heading entirely when it was empty) — that is how it reaches `agent_notes`, which `commence-haunt` reads.

> **CHECKPOINT — Phase 2 complete.** Proceed to Phase 3.

---

## Phase 3 — Adversarial Review

**Skip this phase if `--no-review` flag is set.** Proceed directly to Phase 4.

Run the **`ghost-hunting-core:panel`** adversarial review on the plan. Invoke it with the plan file; for an implementation plan it routes to the `staff-engineer` + `product-manager` lenses (the shared lens trio ships in this plugin; extra repo persona lenses come from `cfg '.panel.lenses'` and live in the repo's `.claude/agents/`), runs them in parallel, and returns one merged, severity-tagged report.

**If this session is running an Opus model,** append the `reasoning-fable` directive so the reasoning lenses run on **Fable** (a peer model reviewing an Opus-authored plan). On any non-Opus session, invoke the panel normally.

Pass the panel the ghost's objective, acceptance criteria, and constraints from the context payload alongside the plan. The panel returns `blocker` / `concern` / `nitpick` findings — handle them exactly as below.

### Handle review results:

**If blockers found:**

- Interactive: re-enter plan mode via `EnterPlanMode`, revise the plan to address blockers, exit via `ExitPlanMode`
- Autonomous: revise the plan in thinking

**Append all findings** to the plan under a `### Adversarial Review` heading:

```markdown
### Adversarial Review

**Blockers:** [none / list with descriptions]

**Concerns:**
- [concern]: [description and recommendation]

**Nitpicks:**
- [nitpick]: [description]
```

> **CHECKPOINT — Phase 3 complete. You MUST now execute Phase 4 (Publish). Do NOT stop or summarize to the user yet.**

---

## Phase 4 — Publish

This is the critical phase that differentiates plan-haunt from commence-haunt. Instead of implementing, we publish the plan and move to purgatory.

### 4a. Write plan to agent_notes (GET-merge-PUT)

Save the full Spectral Plan to `agent_notes` with machine-readable metadata in HTML comments. This allows `ghost-hunting-core:commence-haunt` to detect and reuse the plan later.

**`PUT /context` REPLACES the entire `context_payload`** — never PUT a bare `{"agent_notes": ...}` or you wipe `objective`/`acceptance_criteria`/`files` that later stages need. Always GET-merge-PUT:

```bash
PLAN_MD=$(mktemp); CTX_JSON=$(mktemp)
cat > "$PLAN_MD" << 'PLANEOF'
<!-- plan_version: 1 -->
<!-- planned_at: [ISO timestamp] -->
<!-- complexity: [rating] -->
<!-- confidence: [rating] -->

[Full Spectral Plan markdown including Adversarial Review section]
PLANEOF

curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" -H "$AUTH" -H "$GH_CLIENT" \
  | jq '.context_payload' > "$CTX_JSON"
jq --rawfile notes "$PLAN_MD" '.agent_notes = $notes' "$CTX_JSON" \
  | curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" \
      -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d @-
```

The `<!-- plan_version: N -->` comment is the sentinel that `ghost-hunting-core:commence-haunt` checks to detect an existing plan.

### 4b. Post full plan as EVP

Post the complete Spectral Plan as an EVP so it's visible in the Ghost Hunting UI (reuse `$PLAN_MD`, minus the sentinel comments if you prefer):

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile content "$PLAN_MD" '{content: $content}')"
```

### 4c. Set status to purgatory (if ghost was claimed)

Only do this if the ghost was successfully claimed (not blocked by Spirit Bonds):

```bash
curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}/status" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"status": "purgatory"}'
```

**Do NOT release the ghost.** It stays claimed + in purgatory. This signals "plan ready for review" in the UI.

If the ghost is blocked (was never claimed), skip this step. The plan lives in agent_notes and the EVP only.

### 4d. Post next-steps EVP

```bash
NEXT_MD=$(mktemp)
cat > "$NEXT_MD" << 'EOF'
Spectral Plan complete. Ghost is now in Purgatory (In Review).

Next steps:
- Review the Spectral Plan above
- To execute: `/commence-haunt {GHOST_ID}` (will detect and offer to use the existing plan)
- To request changes: post feedback EVP
- Ghost remains claimed in Purgatory until executed or manually released
EOF
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile content "$NEXT_MD" '{content: $content}')"
```

If blocked, adjust the message: "Spectral Plan complete (ghost is blocked by Spirit Bonds — plan saved to context and EVP but status unchanged). Resolve blockers, then `/commence-haunt {GHOST_ID}` to execute."

**Imprint write-back (one call, before this EVP):** if exploring surfaced a durable, non-obvious learning — a `gotcha`, `convention`, `fact`, `procedure` or `preference`, **never a decision** (that is an Augury) — record it via `POST /api/agent/imprints/batch` with scope `project` + the ghost's `project_id`, `source_task_id` = `{GHOST_ID}`, a `links` citation to the ghost, and `idempotency_key` = `writeback:plan:{GHOST_ID}` (retry-safe; distinct from commence-haunt's `writeback:{GHOST_ID}`), after recalling your key phrase (`POST /api/agent/imprints/recall` with `project_id`) so you supersede (`supersedes_id`) or skip an existing Imprint rather than duplicate it (a covering hit from another Haunting or at org scope takes an org replacement — keep or widen, never sideways: that item is `"scope": "org"` with NO `project_id`) — the full idiom is `ghost-hunting-core:commence-haunt` Phase 4b-bis; nothing durable learned → skip silently.

### 4e. Confirm to user

Display a summary:

- Ghost title and ID
- Status: Purgatory (In Review) — or Blocked (unchanged) if Spirit Bonds
- Complexity and confidence ratings
- Number of files to modify
- Number of tests planned
- Adversarial review verdict (blockers resolved? concerns noted?)
- Next step: `ghost-hunting-core:commence-haunt {GHOST_ID}` to execute

---

## Error Handling

- **Ghost not found / API errors:** Report and stop.
- **Claim fails (another agent):** Report and stop.
- **Ghost is exorcised:** Report and stop.
- **Blocked by Spirit Bonds:** Plan anyway (skip claim, skip purgatory, post plan).
- **Existing plan found:** Ask overwrite/view/cancel (autonomous: overwrite).

## Posting Multi-Line Markdown via API

**Never build JSON payloads with inline `\n` escape sequences in shell strings.** This produces a single escaped line instead of readable markdown — both in the UI and when read back by agents.

Instead, write the markdown to a temp file and use `jq --rawfile` to embed it as a properly-encoded JSON string:

```bash
# 1. Write markdown to a temp file (preserves real newlines)
EVP_MD=$(mktemp)
cat > "$EVP_MD" << 'PLANEOF'
## Spectral Plan — [Title]

### Overview
[content with real newlines...]
PLANEOF

# 2. Use jq --rawfile to build the JSON payload
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile content "$EVP_MD" '{content: $content}')"
```

For `agent_notes`, use the GET-merge-PUT pattern from Phase 4a — never a bare PUT.

This ensures the content renders as proper markdown in the Ghost Hunting UI and is human-readable when fetched via API.

## EVP Content Must Match the Plan

When posting the Spectral Plan as an EVP (Phase 4b), the EVP content **must be the exact same plan** shown to the user — not a condensed summary. The EVP is the primary way humans review the plan in the UI. If it differs from what the user approved, it creates confusion and breaks the review workflow.

## Key Reminders

- **Always read the manifest first** — source of truth for API behavior.
- **EVP body field is `content`** not `body`.
- **List endpoints return `{items: [...]}`.**
- **`PUT /context` REPLACES** the whole payload — always GET-merge-PUT.
- **`pipeline_stage` has its own endpoint** — it is NOT part of the context payload.
- **JSON field names are standard** (`project_id`, not `haunting_id`) even though URLs use spooky names.
- **Do NOT implement anything** — this skill only plans. Implementation is done by `ghost-hunting-core:commence-haunt`.
- **Do NOT release the ghost** — `release()` resets status to ether, losing the purgatory signal.
- **Follow all conventions in the repo's CLAUDE.md** — terminology, patterns, field names, etc.
- **The Spectral Plan template is mandatory** — always use the standardized format for consistency.
- **`plan_version` in agent_notes is the integration sentinel** — `ghost-hunting-core:commence-haunt` looks for `<!-- plan_version:` to detect existing plans.
- **Use `jq --rawfile` for all multi-line API payloads** — never inline `\n` in shell strings (see section above).
