---
name: commence-haunt
description: Claim a ghost and execute the full implementation lifecycle — plan, implement, test, EVP, exorcise. Use when the user says "commence haunt" followed by a ghost ID or title fragment.
---

# Commence Haunt

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Claim a Ghost (task) from Ghost Hunting and execute the **complete implementation lifecycle**: plan → implement → test → report → exorcise.

**CRITICAL: This skill has 6 phases (0, 1, 2, 3, 3.5, 4). Phase 4 (Report & Exorcise) is MANDATORY — never stop after Phase 3 or 3.5 — with ONE sanctioned exception: if the Phase 3.5 diff review surfaces a blocker you cannot resolve, post an EVP, set the ghost `poltergeist`, and stop WITHOUT exorcising (that is a deliberate stop, not a silent skip).**

Repo-specific behavior (worktree isolation, scratch DBs, test commands, browser tooling, stack ordering) comes from the repo's committed `.ghost/config.json`, read via the `cfg()` helper defined in Phase 0. Never hardcode script paths, séance UUIDs, or org names — if a repo needs different behavior, it belongs in that repo's config, not in this skill.

## Arguments

The user provides a **ghost ID** (full UUID or short prefix) or a **title fragment** to search for.

**Invocation input** means the user's text after `/commence-haunt` (Claude) or
`$commence-haunt` (Codex). On a host that expands `$ARGUMENTS`, that expansion
is the same input. Never require literal `$ARGUMENTS` expansion.

## Flags

Check the invocation input for these optional flags:

- **`--autonomous`** — Skip interactive plan approval and adversarial review for non-interactive execution. Default: interactive with plan approval.
- **`--stage=plan|implement`** — Run only part of the lifecycle, for orchestrators (e.g. a ghost-lane / extermination workflow or a ritual) that drive the phases externally. Implies `--autonomous` for the phases it runs.
  - `--stage=plan` → run **Phase 0–1 only** (bootstrap, claim, explore, design + write the plan to `agent_notes`, post the plan EVP), then **STOP**. Do **not** implement, test, report, or exorcise.
  - `--stage=implement` → **skip Phase 1 except its 1a Imprint recall** (the plan already exists in `agent_notes` from a prior `--stage=plan` or `ghost-hunting-core:plan-haunt` run); do a minimal bootstrap (read context + read the plan from `agent_notes`; do **not** re-claim), then run **Phase 2–3** (implement + test + browser verify) and **STOP**. Do **not** exorcise or hand off.
  - Omit to run the full lifecycle (Phases 0–4).
- **`--no-exorcise`** — Run reporting (Phase 4a–4c) but **skip Phase 4d (exorcise)** and any handoff, leaving the ghost's final state to an external orchestrator. Implied by `--stage`.
- **`--local`** — Target the repo's local API (`cfg '.api.local_base'`) with local creds instead of production. Only honored when the repo's config sets `api.allow_local_switch: true` — set `GK_LOCAL=1` before running the Phase-0 block. If the config does not allow the switch, ignore the flag and tell the user why.

## Phase 0 — Bootstrap & Validate

### 0a. Config, credentials, preflight

If `--local` was passed (and only then), export `GK_LOCAL=1` first. Then run the canonical ghost-kit Phase-0 block:

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/commence-haunt${WF_STAMP:+ wf/$WF_STAMP}"

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

**Use `$API_BASE`, `$AUTH`, and `-H "$GH_CLIENT"` on every API call throughout this skill.**

Conventions the block establishes:

- **Preflight verdict:** if `client_contract.status` is `unsupported`, STOP — tell the user to update ghost-kit before continuing. If `outdated`, print the message and continue. `current`/`unknown` → proceed silently.
- **`--local` flag:** only honored when the repo's config sets `api.allow_local_switch: true`; set `GK_LOCAL=1` before the block. Otherwise ignore the flag and say so.
- **Séance resolution** (only if a later step needs the séance UUID — e.g. scoping a search): first read the posture — `cfg '.seance.scope'` (default `seance`). In **`coven`** scope, SKIP resolution — the backlog spans the whole coven, so any such search runs coven-wide (`seance.id`/`seance.selector` are ignored). In **`seance`** scope (or absent), use `cfg '.seance.id'` directly when present. Otherwise resolve once via
  `curl -s "$API_BASE/api/agent/seances" -H "$AUTH" -H "$GH_CLIENT" | jq -r --arg re "$(cfg '.seance.selector')" '.items[] | select(.name | test($re; "i")) | .id'`
  — if the selector is empty, fall back to fuzzy-matching the repo name. In interactive use, confirm a fuzzy match with the user before writing anything; in autonomous/`--yes` mode, ABORT on fuzzy match instead. After resolving, suggest pinning the UUID into `.ghost/config.json`.
- **Generic mode (no `.ghost/config.json`):** everything still works via defaults — prod API, `GHOST_HUNTING_API_KEY` from `$REPO_ROOT/.env`, then the legacy `~/.claude/.env` (a config naming `auth.prod.org_id` reads the signed-in `GHOST_HUNTING_API_KEY__<ORG8>` from `~/.config/ghost-hunting/.env` instead — see Phase 0); séance fuzzy-matched from the repo dir name (confirm first), `isolation.mode=none`, `browser.tool=none` (skip browser verify and note it), tests skipped with a warning unless `scripts/test.sh` exists.

Then fetch and read the manifest — source of truth for all endpoints, schemas, and workflows:

```bash
curl -s "$API_BASE/api/agent/manifest" | jq .
```

### 0b. Resolve the ghost

If UUID (or prefix): `curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}" -H "$AUTH" -H "$GH_CLIENT"`

If title fragment: `curl -s "$API_BASE/api/agent/search?q={QUERY}" -H "$AUTH" -H "$GH_CLIENT"`

(Search returns `{tasks: [...], projects: [...], ...}`; other list endpoints return `{items: [...]}` — never assume a bare array.)

If multiple matches, ask the user to clarify. If no match, report and stop.

Once resolved, **save the ghost to a file** — later phases build payloads from it with `jq` instead of pasting its title into a shell string (titles routinely contain backticks, `$` and `"`, which inside double quotes are command substitution and a string terminator):

```bash
GHOST_JSON="/tmp/ghost.{GHOST_ID}.json"
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}" -H "$AUTH" -H "$GH_CLIENT" > "$GHOST_JSON"
jq -e '.id and .title' "$GHOST_JSON" >/dev/null || { echo "Could not resolve the ghost:"; cat "$GHOST_JSON"; }
```

`{PROJECT_ID}` below is `.project_id` from this file.

### 0c. Check Spirit Bonds (dependencies)

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/with-dependencies" -H "$AUTH" -H "$GH_CLIENT"
```

If `blocked_by_incomplete` is `true`, report blocking dependencies and **stop**.

### 0d. Read context payload

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" -H "$AUTH" -H "$GH_CLIENT"
```

Parse all fields: `objective`, `instructions`, `files`, `acceptance_criteria`, `constraints`, `resources`, `output_format`, `agent_notes`.

> **⚠️ Context writes REPLACE the whole payload — always GET-merge-PUT.**
> `PUT /context` **replaces** the entire `context_payload`. PUTting a bare `{"agent_notes": …}` **wipes** `objective` / `instructions` / `acceptance_criteria` / `files` that later phases (and future agents) rely on. Every context write below GET-merges first — never send a bare `agent_notes` body. (`pipeline_stage` is NOT part of context — it has its own endpoint, `PUT /ghosts/{id}/pipeline-stage`.) The reusable pattern (write the markdown to a temp file, then merge it in — ghost-scoped temp names so concurrent sessions never collide):
>
> ```bash
> # $NOTES_FILE holds the new agent_notes markdown (real newlines).
> curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" -H "$AUTH" -H "$GH_CLIENT" \
>   | jq '.context_payload // {}' > "/tmp/ctx.{GHOST_ID}.json"
> jq --rawfile notes "$NOTES_FILE" '.agent_notes = $notes' "/tmp/ctx.{GHOST_ID}.json" \
>   | curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" \
>       -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d @-
> ```

### 0e. Fetch Figma designs (if referenced)

Check the context payload's `resources` field for Figma URLs (any URL containing `figma.com`). If found, fetch the design references — these are the **visual source of truth** for all frontend work.

**For Figma Make URLs** (`figma.com/make/{fileKey}/...`):
1. Call `mcp__figma__get_design_context` with the `fileKey` and `nodeId: ""` to get resource links
2. Use `ReadMcpResourceTool` to read each returned source file
3. These files contain the reference React code showing the intended layout

**For standard Figma design URLs** (`figma.com/design/{fileKey}/...?node-id={nodeId}`):
1. Extract `fileKey` and `nodeId` from the URL (convert `-` to `:` in nodeId)
2. Call `mcp__figma__get_design_context` with both parameters

**Important:** Figma designs define the visual structure. Adapt to the repo's existing component library, hooks, and active project guidance plus `cfg '.implement.notes'` — do NOT copy code verbatim. If the Figma integration is not configured in this session, note the URLs as unread references in the plan and continue.

Store fetched designs for Phase 1 (planning) and Phase 2 (implementation). If no Figma URLs, skip this step.

### 0f. Read existing EVPs

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" -H "$AUTH" -H "$GH_CLIENT"
```

### 0g. Auto-claim the ghost

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/claim" -H "$AUTH" -H "$GH_CLIENT"
```

If claim fails, report the error and stop. Note: claiming a ghost already in `purgatory` (e.g. one planned by `ghost-hunting-core:plan-haunt` and awaiting plan review) **preserves** its `purgatory` status — that is expected; Phase 2 moves it to `active_haunt` when implementation actually begins.

### 0h. Post "Claimed" EVP

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"content": "Ghost claimed. Reading context and entering planning phase."}'
```

(The EVP body field is `content`, not `body`.)

### 0i. Display ghost summary

Show the user: title, priority, haunting (project), description, context payload, Figma designs found (if any), existing EVPs, Spirit Bonds status.

### 0j. Provision an isolated worktree (interactive mode, worktree repos only)

**Skip this step entirely if `--autonomous` or `--stage` is set** — an orchestrator (a ghost-lane / extermination workflow or a ritual) already owns the tree and branch; honor theirs, do NOT provision your own.

**Config gate:** read `ISO_MODE=$(cfg '.isolation.mode')` (default `none`).

- **`none` (or unset)** → print one line — `isolation.mode=none — working in the main checkout on the current branch` — and skip the rest of this step. All later "worktree mode" branches in this skill are skipped the same way.
- **`worktree`** → isolate this session so it is safe to run **several windows at once**: concurrent sessions must not commingle edits in one shared working tree, and their Phase-3 test runs must not collide on a shared test DB. **Reuse the repo's provisioning primitive — do NOT hand-roll `git worktree`** (this is the same isolation the repo's orchestrated workflows use):

```bash
WT_SCRIPT=$(cfg '.isolation.worktree_script')
DB_SCRIPT=$(cfg '.isolation.db_script')
COMMIT_SCRIPT=$(cfg '.isolation.commit_script')
MIGRATION_GATE=$(cfg '.isolation.migration_gate')
DB_PREFIX=$(cfg '.isolation.db_prefix'); DB_PREFIX=${DB_PREFIX:-$REPO_SLUG}
DEF_BRANCH=$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||'); DEF_BRANCH=${DEF_BRANCH:-main}

SLUG="ch$(printf '%s' "{GHOST_ID}" | tr -dc 'a-z0-9' | cut -c1-14)"
"$REPO_ROOT/$WT_SCRIPT" provision "$SLUG" "origin/$DEF_BRANCH"
```

If `isolation.mode` is `worktree` but `worktree_script` is empty, the repo's config is incomplete — report the gap and stop (do not improvise isolation).

Parse stdout for the line beginning `  worktree:` → that absolute path is **`$WT`**; the branch is **`ext/$SLUG`**. If the provision script exits nonzero (e.g. a missing repo-root `.env`, or the `origin/$DEF_BRANCH` base ref is absent — `git fetch origin` first if so), report the error and **stop** — do NOT fall back to working in the main checkout (that reintroduces the multi-window hazard).

**For the rest of this skill you run IN-SESSION: the session's original working directory may still point at the MAIN checkout — IGNORE it.** Every file edit, `git`, test, commit, and diff from here on targets **`$WT`** by absolute path. Tests use a per-session scratch DB named for `$SLUG` (Phase 3b), created/dropped via `"$WT/$DB_SCRIPT"`. Report `$WT` and the branch `ext/$SLUG` to the user.

> **CHECKPOINT — Phase 0 complete.** Proceed to Phase 1.

---

## Phase 1 — Plan

**Stage gate:** If `--stage=implement` is set, **skip this phase except 1a (recall)** — the plan already lives in `agent_notes`. Run the recall (one cheap read — the plan may predate an Imprint a sibling Medium wrote back since), read the plan from the context payload (`agent_notes`) and the `files` list, then jump straight to Phase 2. Do not re-plan and do not re-claim.

### 1a. Recall Imprints (memory)

Before you plan, recall what the Coven already learned. Imprints are atomic, typed memory records — `fact` / `convention` / `preference` / `gotcha` / `procedure` — that earlier Mediums wrote back on this Haunting or Coven-wide. The query and `project_id` are built **from `$GHOST_JSON`** (Phase 0b) with `jq`, never pasted into the shell:

```bash
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

- Hits come back in rank order with **full content** — read every one; a `gotcha` or `convention` here changes the plan. `relevance` is opaque (0..1, comparable only with the other hits of this one response): sort by it, never threshold on it or store it. The default `limit` (8) is a context-budget choice — narrow with `memory_type` / `tags` before raising it.
- **Non-empty:** surface the block as **"Recalled imprints"** in the plan context — show it to the user (interactive), and carry it into the plan written to `agent_notes` under a `### Recalled imprints` heading (see "Write plan to context") so the Worker / Review Mediums inherit it. When an existing plan is reused (1b), print the block in the conversation only — do not rewrite `agent_notes` for it.
- **Empty (`items: []`):** proceed silently — no block, no EVP, no note.
- **Failed (no `items` in the response):** this is NOT "nothing recorded" — say so out loud and record `recall failed: <HTTP code> <error_code>` in the plan EVP, so the missing memory is diagnosable from the EVP trail rather than looking like an empty Coven. Then plan without it; a failed recall never blocks the haunt. A `404 HAUNTING_NOT_FOUND` means `.project_id` is not a Haunting in your Coven: re-check Phase 0b rather than dropping `project_id`. A `401` / `426` is a Talisman / client-version problem — fix it before planning.
- Recall is a read (never journaled; safe to repeat) — recall again with a narrower key phrase before touching an unfamiliar subsystem.

### 1b. Check for an existing Spectral Plan

Before planning, check whether `agent_notes` (read in Phase 0d) contains `<!-- plan_version:` — the sentinel left by `ghost-hunting-core:plan-haunt`.

**If an existing plan is found:**

- **If `--autonomous`:** Use the existing plan automatically. Post EVP: "Using existing Spectral Plan. Proceeding to implementation." **Skip the rest of Phase 1, go directly to Phase 2.**
- **If interactive:** Display the existing plan summary (complexity, confidence, file count, overview). Ask the user:
  - **Use existing plan** — Skip the rest of Phase 1, proceed to Phase 2.
  - **Re-plan from scratch** — Clear `agent_notes` via the GET-merge-PUT pattern (set `.agent_notes = null` on the fetched payload; **never** PUT a bare `{"agent_notes": null}` — it wipes the rest of the context), then run Phase 1 normally below.
  - **Modify** — Use the host's native planning surface when available, with the existing plan pre-loaded for editing. Otherwise revise it conversationally and wait for explicit approval. After approval, write the updated plan to context and post an EVP.

**If no existing plan found:** continue with Phase 1 below.

### 1c. Plan the implementation

**Check whether `--autonomous` is in the invocation input.**

**If `--autonomous` is present:** do not enter an interactive planning surface. Plan, post the plan as an EVP, and proceed directly to implementation.

**If `--autonomous` is NOT present (default interactive mode):** use the host's native planning surface when available. If the current host/session is already non-mutating plan-only, deliver the plan and stop; resume implementation only in a later execution-mode turn. Otherwise present the completed plan and wait for explicit user approval before any implementation or API plan write.

### Planning steps (both modes):

1. **Explore the codebase** — Read all files listed in context `files`, plus related files using the host's repository search and file-listing tools (prefer `rg` / `rg --files` when using a shell). If Figma designs were fetched in Phase 0, review them alongside the codebase.

2. **Design the implementation** — Plan all changes following the active project guidance (`AGENTS.md` when present, otherwise a configured fallback such as `CLAUDE.md`) and the stack hints in `cfg '.implement.notes'`: data layer (models, migrations), services, schemas, API routers, frontend (components, hooks, pages, routes), agent-facing API surfaces — whatever the repo's stack actually has.

3. **Design the test plan** — Plan ALL tests: backend endpoints, services, and edge cases; frontend components and hooks; e2e specs for new pages/workflows if the repo has an e2e suite. List every test file and function. If the plan adds or alters a migration that **rewrites existing row values** (a backfill/`op.execute` UPDATE, an enum canonicalization), the test plan MUST include an integration test that seeds legacy rows and drives the backfill — check the active project guidance for the repo's template and any CI lint that enforces it.

4. **Write the plan** — Include specific file paths, function signatures, and test cases. When the 1a recall was non-empty, include its block verbatim under `### Recalled imprints` (omit the heading entirely when it was empty).

### Adversarial review (interactive only, skip for `--autonomous`)

If the `ghost-hunting-core:panel` skill and agent delegation are available, run that adversarial review on the plan with the `staff-engineer` + `product-manager` lenses (plus configured repo lenses). Otherwise perform those two rubrics inline and merge their findings into the same `blocker` / `concern` / `nitpick` format. Panel availability must never block the core lifecycle.

Pass the panel the ghost's objective, acceptance criteria, and constraints from the context payload alongside the plan.

Append the merged review to the plan file under an `## Adversarial Review` heading. If any **blockers** are found, revise the plan before requesting approval. Concerns and nitpicks are presented for the user's judgment.

### Finalize the plan

- **Autonomous mode:** Write plan to context, post EVP, proceed to Phase 2.
- **Interactive mode:** Exit plan mode (user sees plan + critique). After approval, write plan to context and post EVP.

### Write plan to context

**GET-merge-PUT** (see the ⚠️ callout in Phase 0d) — write the plan markdown to a temp file, then merge it into the existing payload so `objective` / `acceptance_criteria` / `files` survive:

```bash
cat > "/tmp/plan.{GHOST_ID}.md" << 'PLANEOF'
## Plan

### Changes
- [file]: [what]

### Tests
- [test file]: [functions]

### Approach
[strategy]

### Recalled imprints
[the 1a block, verbatim — drop this heading when recall was empty]
PLANEOF

curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" -H "$AUTH" -H "$GH_CLIENT" \
  | jq '.context_payload // {}' > "/tmp/ctx.{GHOST_ID}.json"
jq --rawfile notes "/tmp/plan.{GHOST_ID}.md" '.agent_notes = $notes' "/tmp/ctx.{GHOST_ID}.json" \
  | curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" \
      -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d @-
```

### Post short "Plan" EVP

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"content": "Plan finalized. X backend files, Y frontend files, Z tests planned. Beginning implementation."}'
```

> **CHECKPOINT — Phase 1 complete.** Proceed to Phase 2.

**Stage gate:** If `--stage=plan` is set, **STOP HERE.** The plan is written to `agent_notes` and the plan EVP is posted — that is the complete deliverable for this stage. Do **not** implement, test, report, or exorcise. Return a short summary of the plan (files, test plan) for the orchestrator.

---

## Phase 2 — Implement

Execute the approved plan. Follow the active project guidance.

If the ghost is still in `purgatory` (preserved from a plan-haunt handoff), set it to `active_haunt` now:

```bash
curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}/status" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"status": "active_haunt"}'
```

**If Phase 0j provisioned a worktree, make ALL file edits inside `$WT`** (your in-session CWD is the MAIN checkout — ignore it; write to the worktree's absolute paths).

**Implementation order:** follow `cfg '.implement.notes'` if set (e.g. "backend-first; migrations before seeds"). Default for a full-stack repo: migrations → models → repositories → services → schemas → API routers → agent-facing API → frontend (API client → hooks → components → pages → routes → navigation).

**Figma designs are the visual source of truth** — if designs were fetched in Phase 0, match the layout structure from the design, adapted to the repo's component library and hooks.

> **CHECKPOINT — Phase 2 complete.** Proceed to Phase 3.

---

## Phase 3 — Test

Write and run ALL tests. No ghost gets exorcised without passing tests.

### 3a. Write tests

Write tests per the test plan from Phase 1. Follow the active project guidance for test structure, fixtures, and file naming.

### 3b. Run tests

Test commands come from config: `T_BACKEND=$(cfg '.tests.backend')`, `T_FRONTEND=$(cfg '.tests.frontend')`, `T_ALL=$(cfg '.tests.all')` — commands are written to run from the repo root. **If a key is empty, skip that gate with an explicit warning** ("no `tests.backend` configured — backend test gate skipped") and record the skip in the Phase-4 log. In generic mode (no config), fall back to `./scripts/test.sh` if it exists; otherwise skip all test gates with a warning.

**Long suites:** a full backend suite can take many minutes. Give the shell command a generous timeout (600000ms) to avoid background routing; if a run does get routed to background, do NOT retry — wait for completion and read the output. Never run the same suite twice concurrently.

**Interactive worktree mode** (`isolation.mode=worktree`, Phase 0j ran) — run against this session's own scratch DB(s) so concurrent windows never collide on a shared test DB, and run the commands from `$WT`, not the main checkout (the inline `DATABASE_URL=` reaches the test runner).

**Dual scratch-DB convention — create BOTH, drop BOTH.** Many `db_script`s derive the test DB from a base DB: `url <slug>` points `DATABASE_URL` at `${DB_PREFIX}_${SLUG}`, and the test harness (e.g. a conftest) appends `_test`, so the suite actually runs against `${DB_PREFIX}_${SLUG}_test`. When that's the repo's convention, create BOTH before the run and drop BOTH after:

```bash
"$WT/$DB_SCRIPT" create "${DB_PREFIX}_${SLUG}"        # base DB that `url` points at
"$WT/$DB_SCRIPT" create "${DB_PREFIX}_${SLUG}_test"   # the DB the suite actually uses
( cd "$WT" && DATABASE_URL=$("$WT/$DB_SCRIPT" url "$SLUG") $T_BACKEND )
( cd "$WT" && $T_FRONTEND )   # only if the plan touched frontend — no DB needed
"$WT/$DB_SCRIPT" drop "${DB_PREFIX}_${SLUG}_test"     # always, even on failure
"$WT/$DB_SCRIPT" drop "${DB_PREFIX}_${SLUG}"          # always, even on failure
```

**Single-DB path:** for a repo whose `db_script` only needs the `_test` DB (no base DB), create and drop just `${DB_PREFIX}_${SLUG}_test`. Follow the script's own usage output either way.

**Targeted while iterating, full once as the gate.** While fixing a specific failure, iterate with a filter appended to the configured command (e.g. `$T_BACKEND -k "<module_or_test>"` — seconds, not minutes) — then run the **full** suite **once** as the green gate before Phase 3.5. That single full run is the point: it catches cross-cutting regressions from shared-code changes the plan didn't anticipate. Don't burn a second full run per fix; the merge gate (`ghost-hunting-core:merge-haunt`) runs the full suite again on the *merged* tree, so the full run here is the isolation check, not the only one.

**Non-worktree mode (`isolation.mode=none`) or orchestrated (`--stage` / `--autonomous`) mode** — the main checkout (or the orchestrator's tree) owns the DB; run the configured commands directly from the repo root:

```bash
( cd "$REPO_ROOT" && $T_BACKEND )
( cd "$REPO_ROOT" && $T_FRONTEND )
```

### 3c. Browser verification

**Config gate:** read `BROWSER=$(cfg '.browser.tool')` (default `none`).

**Before navigating (config-gated):** if `cfg '.e2e.lock_dir'` is non-empty and that lock dir exists in the MAIN checkout — or the gate worktree's e2e state dir exists (e.g. `$WT/.ext-serve`) — the fixed dev ports are currently serving a **merge-gate preview tree, NOT this branch's code** (the merge gate holds the e2e stack; ports are a machine-global lock). Wait for the lock to clear before driving a browser, rather than verifying against the wrong code. (Empty `.e2e.lock_dir` / no such dir → no e2e-stack contention; proceed normally.)

- **`none` (or unset)** → skip browser verification with a one-line note, and record it explicitly in the Phase-4 log and completion EVP ("browser verification skipped — browser.tool=none"). Do not silently omit it.
- **`playwright`** → prefer the Playwright MCP tools (`mcp__playwright__*`) when available; otherwise use the host's available browser/computer-use capability. If neither exists, record an explicit capability skip. Flow:
  1. Navigate to the new/changed page. If bounced to a login page, authenticate with the repo's seeded dev credentials from the active project guidance — the browser session persists for the rest of the agent session
  2. `browser_snapshot` — accessibility tree with element refs; confirm elements and layout (the refs feed the interaction tools)
  3. Interact via `browser_click` / `browser_fill_form` / `browser_type`; use `browser_wait_for` for async UI, and `browser_evaluate` / `browser_run_code` for anything the discrete tools can't express
  4. `browser_console_messages` to catch console errors
  5. `browser_take_screenshot` before/after key interactions — keep screenshots out of the repo's working tree, and attach the evidence to the completion EVP (upload as Relics via `POST /api/agent/ghosts/{id}/relics`, multipart, or reference the paths)
- **`claude-in-chrome`** → use the claude-in-chrome tools when available; otherwise use another available browser/computer-use capability or record an explicit capability skip. Flow:
  1. `tabs_context_mcp` — list current tabs first; reuse an existing tab only if the user asks, otherwise `tabs_create_mcp`
  2. `navigate` to new/changed pages
  3. `read_page` / `find` to confirm elements and layout
  4. `form_input` to fill inputs; trigger interactions via `javascript_tool` or the appropriate event tool
  5. `read_console_messages` to catch console errors

**Interactive worktree caveat:** the repo's dev servers serve the **MAIN** checkout, not `$WT` — an in-lane browser check cannot verify *unmerged worktree frontend changes*. For a frontend ghost, author/extend an e2e spec (if the repo has an e2e suite) and do the browser verification **post-merge** (or after checking out `ext/$SLUG` on the dev servers); do not rely on an in-lane browser pass. Backend-only ghosts are unaffected — skip this step. In orchestrated (`--stage`/`--autonomous`) mode there is no self-provisioned worktree, so verify normally. If the repo runs its e2e suite at the merge gate (`ghost-hunting-core:merge-haunt`), keep authoring/extending specs here but never boot an in-lane server stack or run the full e2e suite yourself unless the user explicitly asks.

Browser verification is a **serialized critical section**: one browser per session — parallel subagents must never interleave browser steps.

Fix any issues discovered before proceeding. If this verification exercised a user-visible flow not already covered by the repo's e2e suite, promote it into a spec — the ad-hoc steps translate directly.

### 3d. Fix failures

If ANY tests fail: analyze, fix the code (not the test unless the test is wrong), re-run, repeat until all pass. Run the FULL suite to confirm no regressions. Do NOT proceed until all tests pass.

> **CHECKPOINT — Phase 3 complete.** Proceed to Phase 3.5 (interactive) or straight to Phase 4 (orchestrated). Do NOT stop or summarize to the user yet.

---

## Phase 3.5 — Diff Review Gate

**Skip this entire phase if `--autonomous` or `--stage` is set** — the orchestrated paths run their own code-review gate. This gate exists to give the **bare interactive** path a diff-level review it otherwise never gets — Phase 1 panels only the *plan*, never the built diff.

### Worktree mode (`isolation.mode=worktree`)

If the diff includes a DB migration and `cfg '.isolation.migration_gate'` is set, run that gate first and fix anything it flags:

```bash
( cd "$WT" && "$WT/$MIGRATION_GATE" )
```

Commit this ghost's work on the branch via the repo's commit script (it typically secret-scans, stages an explicit pathspec, embeds the ghost ID, and commits no-push on `ext/$SLUG`, refusing the default branch — check its `--help` for the exact flag shape):

```bash
( cd "$WT" && "$WT/$COMMIT_SCRIPT" --message "ghost {GHOST_ID}: <one-line summary>" )
```

If `commit_script` is empty, stage **only this ghost's files** by explicit pathspec and `git -C "$WT" commit` on `ext/$SLUG` — never `git add -A`, never commit on the default branch.

Then invoke the available review skill as **`ghost-hunting-core:review-haunt {GHOST_ID} --force-panel --no-tests --base=origin/$DEF_BRANCH`** in Claude or **`$review-haunt {GHOST_ID} --force-panel --no-tests --base=origin/$DEF_BRANCH`** in Codex. Inside `$WT`, `origin/$DEF_BRANCH...HEAD` is a real, non-empty diff scoped to THIS ghost only — no other window's uncommitted changes leak in.

### Non-worktree mode (`isolation.mode=none`)

You worked on the current branch in the main checkout and have NOT committed — this gate reviews the **uncommitted working-tree diff**. Invoke the available review skill as **`ghost-hunting-core:review-haunt {GHOST_ID} --force-panel --no-tests`** in Claude or **`$review-haunt {GHOST_ID} --force-panel --no-tests`** in Codex. Review-haunt's diff resolution falls back to `git diff` / `git diff --cached` when there is no branch/commit to diff against. (Pass `--local` too if this run used it.)

### Both modes

Append **`--panel-reasoning-fable`** only on a host where that model-specific panel option exists. Other hosts omit it and use the inherited model.

Reuse review-haunt rather than paneling by hand — it already encodes the `/panel` invocation on the diff, the lens routing (`staff-engineer` always; UX + user-persona lenses for frontend surfaces), and the **PASS / NEEDS WORK / FAIL** verdict. `--no-tests` because Phase 3 just ran the suite (re-running risks a phantom failure under load); `--force-panel` so every gate run gets a fresh panel.

Act on the verdict:

- **Blockers / FAIL** → fix (in `$WT` if worktree mode; re-commit via the commit script), re-review until the panel returns no blockers.
  - **Re-verifying those fixes:** re-run only the **targeted** tests for the files you touched (the configured test command with a filter), plus the repo's linters/typecheckers on the changed files — **not** the full suite again. Escalate to one more full run **only** when a fix touches broadly-shared code (a repository/service/model used across domains); the merge gate re-runs the full suite on the merged tree regardless. Phase 3 already spent the one full-suite gate.
- **PASS / NEEDS WORK with concerns only** → surface the concerns to the user (not a hard stop) and proceed to Phase 4.
- **Unresolvable blocker** → post an EVP with the finding, set the ghost `poltergeist`, and STOP without exorcising (the sanctioned exception to "Phase 4 is mandatory").

The embedded review-haunt's own "exorcise?" prompt does NOT drive this flow — its verdict feeds THIS gate; the exorcise decision belongs to Phase 4 below.

> **CHECKPOINT — Phase 3.5 complete.** Proceed to Phase 4.

---

## Phase 4 — Report & Exorcise

**Stage gate:** If `--stage=implement` or `--no-exorcise` is set, run **4a–4c** (log, context update, Imprint write-back, completion EVP) so the orchestrator can read the result, then **STOP before 4d** — do **not** exorcise and do **not** hand off. Return a summary (files changed, test counts, commit shas) for the orchestrator. The orchestrator owns the ghost's final state.

### 4a. Submit execution log

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/log" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"content": "Files changed: [list]. Tests added: [count]. All passing: backend X/X, frontend Y/Y. Verification: [browser tool used + result | e2e spec path added/extended | skipped because <reason, e.g. browser.tool=none / tests.backend unset>]."}'
```

The `Verification:` field is **required** — name the browser tool and outcome, the e2e spec this ghost added/extended, or an explicit skip reason. Never omit it silently.

### 4b. Update context with completion details

**GET-merge-PUT** (see the ⚠️ callout in Phase 0d) — write the completion notes to a temp file, then merge so the rest of `context_payload` survives:

```bash
cat > "/tmp/done.{GHOST_ID}.md" << 'DONEEOF'
## Completed

### Files Changed
- [file]: [desc]

### Tests
- Backend: X in [files]
- Frontend: Y in [files]

### Acceptance Criteria
- [criterion]: Met
DONEEOF

curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" -H "$AUTH" -H "$GH_CLIENT" \
  | jq '.context_payload // {}' > "/tmp/ctx.{GHOST_ID}.json"
jq --rawfile notes "/tmp/done.{GHOST_ID}.md" '.agent_notes = $notes' "/tmp/ctx.{GHOST_ID}.json" \
  | curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" \
      -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d @-
```

### 4b-bis. Write back Imprints (memory)

Before the completion EVP, hand the Coven what this haunt taught you. Imprints are **durable, non-obvious learnings** a future Medium (or you, next week) would otherwise rediscover the hard way — one atomic record each, typed `fact` / `convention` / `preference` / `gotcha` / `procedure`. NOT progress (that is the EVP), NOT task state (`context_payload`), NOT the plan (`agent_notes`), and **NEVER a decision** — an architecture fork, a scope call, a tradeoff is an Augury (`POST /api/agent/auguries`): raise one instead. If it will be false by next sprint, it is not an Imprint. Nothing durable learned → skip this step entirely and say so in the 4c EVP (an empty batch is a 422).

1. **Gather** the candidates from the haunt: the trap that cost time (`gotcha` — the highest-value type), the house rule a reviewer would enforce (`convention`), the environment truth (`fact`), the multi-step how-to you had to work out (`procedure` — the gist plus a pointer, not an essay), the stated taste that changed what you did (`preference`).
2. **Supersede idiom — recall each key phrase first.** Default recall is vivid-only, so a stale Imprint left standing beside yours keeps being recalled next to it:

   ```bash
   # Multi-word key phrases are AND-ed by the server; OR the words (`a OR b`) when you
   # want anything touching the area. Same fail-loud branch as Phase 1a — an error
   # envelope has no `.items`, and `.items[]?` would silently read as "nothing covers it".
   KEY_PHRASE="<key phrase of the learning>"
   SUP_JSON="/tmp/supersede-recall.{GHOST_ID}.json"
   SUP_CODE=$(curl -s -X POST "$API_BASE/api/agent/imprints/recall" \
     -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
     -d "$(jq -n --arg q "$KEY_PHRASE" --arg p "{PROJECT_ID}" '{query: $q, project_id: $p, limit: 5}')" \
     -o "$SUP_JSON" -w '%{http_code}')
   if jq -e '.items | type == "array"' "$SUP_JSON" >/dev/null 2>&1; then
     jq -r '.items[] | "\(.id)  [\(.memory_type) · \(.scope) · \(.status)] \(.title)"' "$SUP_JSON"
   else
     echo "SUPERSEDE-RECALL FAILED (HTTP $SUP_CODE) — do NOT read this as 'nothing covers it':"
     [ -s "$SUP_JSON" ] && { jq -c '.' "$SUP_JSON" 2>/dev/null || cat "$SUP_JSON"; } || echo "(empty response body)"
   fi
   ```

   A failed recall here is not a clean slate: write your Imprint without `supersedes_id` and note the failed check in the 4c EVP, rather than assuming nothing exists.

   - An existing Imprint already covers it and is still right → **SKIP** yours.
   - It covers it but yours is the correction → **SUPERSEDE**: put its id in `supersedes_id` on your item — the target fades atomically in the same transaction (the only way an Imprint fades). Two items naming one target fail the batch. A covering hit whose `project_id` is not this ghost's Haunting, or an org-scoped one, can only be superseded at **org** scope — keep or widen, never sideways: that item becomes `"scope": "org"` with NO `project_id` (an org item that still carries `project_id` is a 422; a sideways project item is a `400 IMPRINT_BATCH_ITEM_INVALID` whose `failing_indexes[].field` is `scope`, and the whole batch is refused).
   - Nothing covers it → write it.
3. **Batch write** — up to 20 items, one transaction, all-or-nothing, one Spirit Journal entry. Default scope is **`project`** (`project_id` = the ghost's `{PROJECT_ID}`) so the Plan / Worker / Review Mediums on this Haunting share it; `org` only for Coven-wide truths, `agent` (omit `agent_id` — yours is filled in) only for what changes *your* behaviour alone. Cite the source ghost twice — `source_task_id` (provenance) **and** a `links` entry (a citation a Hunter can follow) — plus any Scroll holding the evidence (`{"kind": "document", "id": …}`). `title` <= 200 chars, `content` <= 2000 chars, `tags` lowercase (<= 20, each <= 50 chars).

   ```bash
   cat > "/tmp/imprints.{GHOST_ID}.json" << 'IMPEOF'
   {
     "idempotency_key": "writeback:{GHOST_ID}",
     "items": [
       {
         "memory_type": "gotcha",
         "title": "<the learning in one line>",
         "content": "<the fact itself — what, where, why it bit; not an essay>",
         "scope": "project",
         "project_id": "{PROJECT_ID}",
         "source_task_id": "{GHOST_ID}",
         "links": [{"kind": "task", "id": "{GHOST_ID}"}],
         "tags": ["<area>", "<subsystem>"]
       }
     ]
   }
   IMPEOF
   curl -s -X POST "$API_BASE/api/agent/imprints/batch" \
     -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
     -d @"/tmp/imprints.{GHOST_ID}.json" \
     | jq '{memory_ids, replayed, error: .detail}'
   ```

   Add `"supersedes_id": "<id>"` to an item only when step 2 said supersede.
4. **Idempotency is the retry story.** `idempotency_key` is derived from the ghost id (`writeback:{GHOST_ID}`; per Coven, per Medium), so a retry after a timeout replays the original ids (`replayed: true`) instead of minting duplicates — **never** blind-retry a keyless batch. `replayed: true` on a *first* attempt means an earlier pass of this ghost (a review loop-back) already wrote back under that key and your items were **not** inserted: browse `GET /api/agent/imprints?source_task_id={GHOST_ID}` to see what landed, then resend only the genuinely new items under a pass-suffixed key (`writeback:{GHOST_ID}:2`). `ghost-hunting-core:plan-haunt` / `review-haunt` write back under `writeback:plan:…` / `writeback:review:…`, so one Medium running all three never replays across skills.
5. **Errors — nothing was recorded; fix and resend with the SAME key:** `400 IMPRINT_BATCH_ITEM_INVALID` lists *every* failing item in `failing_indexes` (all items are validated before any insert); `409 SUPERSEDE_CONFLICT` means a supersede target lost a race (`superseded_by` = the winner) — re-recall, then supersede the winner or skip; `404` (`GHOST_NOT_FOUND` / `SCROLL_NOT_FOUND` / `HAUNTING_NOT_FOUND`, sibling `field`) means a cited id is not live in your Coven. A failed write-back never blocks Phase 4 — record the failure in the 4c EVP and continue.

Keep the returned `memory_ids` for the 4c EVP.

### 4c. Post completion EVP

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"content": "Implementation complete. X files changed, Y tests added, all passing. Imprints: N recorded (<ids>) | none — nothing durable learned. Ready for review."}'
```

Include the browser-verification evidence (or its explicit skip note) and the Imprint write-back result (ids, `replayed`, or the explicit skip / failure reason) in this EVP.

### 4c-bis. Open a PR (interactive worktree mode only)

**Only when Phase 0j provisioned a worktree; skip if `--autonomous` / `--stage` (the orchestrator ships the PR) and in `isolation.mode=none` (the user owns commit/PR timing on their branch — offer, don't force).** The work is committed on `ext/$SLUG` in `$WT` (Phase 3.5). Push it and open a PR (or invoke a repo wrap-up skill if one exists — it typically handles push + PR + QA tree):

```bash
git -C "$WT" push -u origin "ext/$SLUG"
gh pr create --head "ext/$SLUG" --base "$DEF_BRANCH" --title "<ghost title>" \
  --body "<summary of changes> · Ghost: {GHOST_ID} · reviewed via the Phase 3.5 panel"
```

Report the PR URL. This PR is later swept into the default branch by **`ghost-hunting-core:merge-haunt`** (its `^ext/` discovery finds it) — or the user can merge it directly on GitHub.

**Leave the worktree standing** for the user's inspection; clean it up when done, **name-scoped only** (never a broad reap/prune — sibling windows share the worktree root):

```bash
"$REPO_ROOT/$WT_SCRIPT" remove "$SLUG"
```

### 4d. Exorcise the ghost

**Binding Circle check first:** if the ghost has `requires_approval=true`, it cannot be exorcised until a Hunter approves. Request approval and park it in review instead:

```bash
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/request-approval" -H "$AUTH" -H "$GH_CLIENT"
curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}/status" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"status": "purgatory"}'
```

Likewise use `purgatory` (done, awaiting human review/QA/sign-off — say so in the EVP) whenever the ghost's context or the user's instructions call for a human gate before completion. Otherwise, exorcise:

```bash
curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}/status" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d '{"status": "exorcised"}'
```

### 4e. Confirm to user

Display: ghost title/ID, final status (Exorcised, or Purgatory awaiting approval), files changed, test counts, acceptance criteria met, PR URL (if opened), any skipped gates (tests/browser) with their reasons.

---

## Error Handling

- **Preflight `unsupported` verdict:** stop immediately; tell the user to update ghost-kit.
- **Ghost not found / Claim fails / API errors:** Report and stop.
- **Blocked by Spirit Bonds:** List blocking ghosts and stop.
- **Worktree provision fails** (worktree mode: missing `.env`, absent base ref, incomplete `isolation.*` config): Report and stop — do NOT fall back to the main checkout.
- **Tests fail:** Fix them. Only go `poltergeist` if truly unresolvable after exhaustive attempts — post an EVP explaining the blocker.
- **Phase 3.5 blocker unresolvable:** post an EVP with the panel finding, set the ghost `poltergeist`, and STOP without exorcising — the sanctioned exception to "Phase 4 is mandatory". In worktree mode, leave the worktree standing for the human.

## Posting Multi-Line Markdown via API

**Never build JSON payloads with inline `\n` escape sequences in shell strings.** This produces a single escaped line instead of readable markdown — both in the UI and when read back by agents.

Instead, write the markdown to a temp file and use `jq --rawfile` to embed it as a properly-encoded JSON string:

```bash
# 1. Write markdown to a temp file (preserves real newlines)
cat > "/tmp/evp.{GHOST_ID}.md" << 'EVPEOF'
## Implementation Complete

### Files Changed
- `path/to/file`: what changed
[content with real newlines...]
EVPEOF

# 2. Use jq --rawfile to build the JSON payload
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile content "/tmp/evp.{GHOST_ID}.md" '{content: $content}')"

# For agent_notes, GET-merge-PUT (a bare {agent_notes: …} would REPLACE the whole
# payload — see the ⚠️ callout in Phase 0d):
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" -H "$AUTH" -H "$GH_CLIENT" \
  | jq '.context_payload // {}' > "/tmp/ctx.{GHOST_ID}.json"
jq --rawfile agent_notes "/tmp/notes.{GHOST_ID}.md" '.agent_notes = $agent_notes' "/tmp/ctx.{GHOST_ID}.json" \
  | curl -s -X PUT "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" \
      -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d @-
```

This ensures the content renders as proper markdown in the Ghost Hunting UI and is human-readable when fetched via API.

## Key Reminders

- **Always read the manifest first** — source of truth for API behavior.
- **EVP field is `content`** not `body`.
- **List endpoints return `{items: [...]}`** — never assume a bare array.
- **`PUT /context` REPLACES — always GET-merge-PUT** (Phase 0d ⚠️): a bare `{"agent_notes": …}` wipes `objective` / `acceptance_criteria` / `files`.
- **`pipeline_stage` has its own endpoint** (`PUT /ghosts/{id}/pipeline-stage`) — it is not part of the context payload.
- **JSON field names are standard** (`project_id`, `org_id`, `assigned_agent_id`) even though URL paths use spooky names; status/priority *values* (`ether`, `banshee`, …) DO use the spooky terms.
- **Post EVPs at milestones** — claimed, plan approved, implementation complete.
- **Recall before you plan, write back before you exorcise** (Phase 1a / 4b-bis): Imprints are durable, non-obvious learnings — `fact` / `convention` / `preference` / `gotcha` / `procedure` — default scope `project`, `idempotency_key` derived from the ghost id, recall your key phrase first and supersede (`supersedes_id`) rather than duplicate. Decisions are Auguries, never Imprints.
- **Follow all active project guidance** — terminology, patterns, file extensions, test runner, etc. — plus `cfg '.implement.notes'`.
- **Use `jq --rawfile` for all multi-line API payloads** — never inline `\n` in shell strings (see section above).
- **Config gates, not assumptions:** worktree/scratch-DB steps only when `cfg '.isolation.mode'` = `worktree`; test gates only for configured `cfg '.tests.*'` commands (warn on skip); browser verification per `cfg '.browser.tool'` (note explicitly in the EVP when `none`).
- **Use host-appropriate sibling-skill invocation** — Claude uses plugin-qualified names such as `ghost-hunting-core:review-haunt`; Codex uses exposed repo skills such as `$review-haunt`. If an optional sibling skill is unavailable, use the documented inline fallback instead of blocking the lifecycle.
- **Phase 3.5 diff gate is mandatory in interactive mode** — review the built diff through the host's available `review-haunt` invocation with `--force-panel --no-tests` before exorcising; skip only for `--autonomous` / `--stage`.
