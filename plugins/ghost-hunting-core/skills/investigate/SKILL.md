---
name: investigate
description: Deep research a topic by exploring the codebase and searching the web for best practices, reliability, and scaling concerns. Produces a Scroll (document) on the Ghost Hunting platform with findings. This is the Ghost Hunting research skill — repos whose product ships its own "investigate" (e.g. a product research/API skill) shadow this one by design. Use when the user says "investigate", "research", "deep dive", "explore", "analyze", or "look into" followed by a topic.
---

# Investigate

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Perform deep research on a topic by exploring the codebase and the web, then produce a structured Scroll (document) with findings including best practices, reliability concerns, and scaling considerations.

**This skill produces a Scroll (document) in the Ghost Hunting platform with structured research findings.**

## Arguments

The user provides:

- **topic/question** — The subject to investigate (required)
- **ghost ID** — Optional UUID to link the research Scroll and attach findings as an EVP
- **`--ghost=<uuid>` / `--augury=<uuid>`** — Explicit Ghost or Augury to link in the Scroll body (at most one of each)
- **haunting ID** — Optional UUID for where to create the Scroll

Arguments provided: `$ARGUMENTS`

## Flags

Check `$ARGUMENTS` for these optional flags:

- **`--local`** — Target the local API (`cfg '.api.local_base'`). Honored **only** when the repo's `.ghost/config.json` sets `api.allow_local_switch: true`: set `GK_LOCAL=1` in the environment **before** running the Phase-0 block. Otherwise ignore the flag and tell the user why.
- **`--no-scroll`** — Skip creating a Scroll, just report findings in conversation.
- **`--no-web`** — Skip web search, codebase exploration only.

## Phase 0 — Bootstrap

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/investigate${WF_STAMP:+ wf/$WF_STAMP}"

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

Fetch the manifest:

```bash
curl -s "$API_BASE/api/agent/manifest" | jq .
```

### 0b. Parse arguments

Strip flags from `$ARGUMENTS`. The remaining text is the topic/question.

Resolve explicit `--ghost=<uuid>` and `--augury=<uuid>` first, then legacy bare UUIDs. Normalize UUIDs to lowercase before sending. Deduplicate repeated IDs. At most one distinct Ghost and one distinct Augury: if two of a kind resolve, ask which is in scope before research or any writes. Keep successful response files for the entire run; a later non-Ghost MUST NOT clear or overwrite an earlier Ghost. An Augury's `task_id` does **not** implicitly set `GHOST_ID` or enable Ghost EVP/Imprint write-back.

For each candidate, set `CANDIDATE_ID` to its validated UUID and `CANDIDATE_KIND` to `ghost`, `augury`, or `bare`. Explicit kinds query **only** their own endpoint. Bare UUIDs try Ghost → Augury → the existing Haunting list. **Only HTTP 404 falls through**; transport errors, authentication failures, 5xx, malformed success JSON, and a returned ID different from the requested UUID STOP resolution with an error. Never turn them into a different scope.

Use this request shape for each attempted kind (substitute `ghosts` or `auguries` in `CANDIDATE_PATH`):

```bash
CANDIDATE_JSON=$(mktemp)
CANDIDATE_CODE=$(curl -sS "$API_BASE/api/agent/$CANDIDATE_PATH/$CANDIDATE_ID" \
  -H "$AUTH" -H "$GH_CLIENT" -o "$CANDIDATE_JSON" -w '%{http_code}')
# A failed curl MUST stop; do not inspect a partial body as a successful record.
# On 200, require this check BEFORE adopting it:
jq -e --arg id "$CANDIDATE_ID" '.id == $id and (.title | type == "string")' "$CANDIDATE_JSON" >/dev/null
```

After a successful **Ghost** check and the single-Ghost conflict check, preserve it independently:

```bash
GHOST_REAL_JSON="/tmp/ghost.{UUID}.json"  # replace {UUID} with the validated CANDIDATE_ID
cp "$CANDIDATE_JSON" "$GHOST_REAL_JSON"
GHOST_ID=$(jq -r '.id' "$GHOST_REAL_JSON")
HAUNTING_ID=${HAUNTING_ID:-$(jq -r '.project_id // empty' "$GHOST_REAL_JSON")}
```

For an **Augury**, keep `AUGURY_REAL_JSON` in its own `/tmp/augury.<uuid>.json` and set `AUGURY_ID` from its `.id`. Do not derive a Ghost or Haunting from that record: Augury-only runs retain 0c's existing placement rules. For a bare UUID that received 404 from both detail endpoints, check it against the authenticated, paginated `/api/agent/hauntings` list (`{items: [...]}`), then record `HAUNTING_ID`; unknown IDs require clarification. A supplied Haunting and resolved Ghost from different projects require a placement clarification instead of silent overwriting.

**The topic** is `$ARGUMENTS` minus every flag and every UUID, capped at ~30 words (the recall query is capped at 500 chars server-side). Keep it in `$TOPIC`. Set `RUN_TAG="${GHOST_ID:-$(date +%s)}"` for recall temp files; create-response files below use a separate unique directory and survive retries.

**Vagueness gate (runs on every path, `--no-scroll` included):** if the topic is too vague (under 5 words with no specific technical term), ask the user to narrow the scope before proceeding — a one-word topic would recall and search on noise.

### 0c. Determine Scroll target (unless `--no-scroll`)

The Scroll's parent is a haunting resolved via this repo's séance:

1. If `HAUNTING_ID` is set: use it.
2. If `GHOST_ID` is set: 0b already set `HAUNTING_ID` from the ghost's `project_id` — nothing to do.
3. If neither: resolve the séance, then pick a haunting inside it.

**Séance resolution:** first read the posture — `cfg '.seance.scope'` (default `seance`).

- **`coven`:** SKIP séance resolution (`seance.id`/`seance.selector` are ignored). Because the Scroll must be PLACED under some haunting, list hauntings **coven-wide** (below, with `SEANCE_ID` empty — do not filter by `portfolio_id`), keyword-match the topic, and CONFIRM the target haunting with the user before creating the Scroll. In autonomous/`--yes` mode, REQUIRE an explicit haunting or ghost UUID in the arguments (or `--no-scroll`, which needs no placement) and ABORT rather than guess a coven-wide Scroll parent.
- **`seance` (or absent):** use `cfg '.seance.id'` directly when present. Otherwise resolve once:

  ```bash
  SEANCE_ID=$(cfg '.seance.id')
  [ -z "$SEANCE_ID" ] && SEANCE_ID=$(curl -s "$API_BASE/api/agent/seances" -H "$AUTH" -H "$GH_CLIENT" \
    | jq -r --arg re "$(cfg '.seance.selector')" '.items[] | select(.name | test($re; "i")) | .id')
  ```

  If the selector is empty, fall back to fuzzy-matching the repo name against séance names. In interactive use, confirm a fuzzy match with the user before writing anything; in autonomous/`--yes` mode, ABORT on a fuzzy match instead. After resolving, suggest pinning the UUID into `.ghost/config.json`.

Then list hauntings and match the topic keywords against haunting names/descriptions. In `seance` scope, keep only hauntings under the resolved séance; in `coven` scope, consider all hauntings (drop the `select` filter):

```bash
curl -s "$API_BASE/api/agent/hauntings?limit=200" -H "$AUTH" -H "$GH_CLIENT" \
  | jq --arg sid "$SEANCE_ID" '[.items[] | select($sid == "" or .portfolio_id == $sid)]'
```

Pick the best match. If no clear match, ask the user which haunting to create the Scroll under.

### 0d. Recall — feature axis (the Coven's memory, before you read any code)

Before exploring, recall what the Coven already learned about this topic. The recall reads a **synthetic ghost file**: the topic as its title, the resolved ghost's `context_payload.files` (or none) as its files, the target Haunting (or `null`) as its project. Build it with `jq -n` — never hand-write JSON, and never point the recall at `$GHOST_REAL_JSON` (that would recall the ghost's title, not the topic):

```bash
GHOST_JSON="/tmp/investigate.$RUN_TAG.json"   # the SYNTHETIC ghost; the two recall jq lines below read THIS file
jq -n --arg t "$TOPIC" --arg pid "$HAUNTING_ID" --slurpfile g "${GHOST_REAL_JSON:-/dev/null}" \
  '{id: ($g[0].id // "investigate"), title: $t, context_payload: {files: ($g[0].context_payload.files // [])}, project_id: (if $pid != "" then $pid else ($g[0].project_id // null) end)}' > "$GHOST_JSON"
```

With `project_id` null (no ghost and no Haunting — `--no-scroll` without a UUID) the recall still returns Coven-wide and your own agent-scope Imprints: run it; do not pick a Haunting just to have one.

```bash
RECALL_JSON="/tmp/recall.$RUN_TAG.json"
RECALL_MECH_JSON="/tmp/recall-mech.$RUN_TAG.json"
CITED_JSON="/tmp/cited.$RUN_TAG.json"
: > "$RECALL_JSON"; : > "$RECALL_MECH_JSON"; : > "$CITED_JSON"

# FEATURE axis — the topic's words OR-ed. This line is BYTE-IDENTICAL to commence-haunt Phase 1a
# (backend/tests/test_client_contract.py pins it); copy it with sed, never retype it. The MECHANISM
# axis is a second call in Phase 1d, after you know which files you read — never merged into this
# one (ts_rank has no IDF, so one merged query lets generic topic words outrank the rare mechanism term).
RECALL_BODY=$(jq '{query: ([.title | scan("[[:alnum:]]{2,}")] | map(ascii_downcase) | unique | join(" OR ")), project_id: .project_id}' "$GHOST_JSON")

# An EMPTY query is not a narrow query: the server maps "" to None and returns the NEWEST imprints
# at match 1.0, which would print as if they were hits. An axis with no terms is not called.
if [ -n "$(printf '%s' "$RECALL_BODY" | jq -r '.query')" ]; then
  RECALL_CODE=$(curl -s -X POST "$API_BASE/api/agent/imprints/recall" \
    -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d "$RECALL_BODY" \
    -o "$RECALL_JSON" -w '%{http_code}')
else
  RECALL_CODE="skipped (no topic terms)"
fi
jq -e '.items | type == "array"' "$RECALL_JSON" >/dev/null 2>&1 \
  && echo "recall (feature): $(jq '.items | length' "$RECALL_JSON") hit(s)" \
  || echo "RECALL FAILED (feature HTTP $RECALL_CODE) — do NOT read this as an empty Coven: $(head -c 300 "$RECALL_JSON")"
```

**When a ghost was given**, also list the Imprints already tied to it — the Cited-by browse filter (`?task_id=`: cited in `links[]` OR recorded on it). It lands with rite 1a's backend wave; on a backend that does not serve it yet the route answers a 400 whose `detail` names the unknown parameter and *suggests* `source_task_id` — **do not take that suggestion** (`source_task_id` is provenance, not citation): skip the section and say so.

```bash
if [ -n "${GHOST_ID:-}" ]; then
  CITED_CODE=$(curl -s -G "$API_BASE/api/agent/imprints" --data-urlencode "task_id=$GHOST_ID" -d status=vivid -d limit=20 \
    -H "$AUTH" -H "$GH_CLIENT" -o "$CITED_JSON" -w '%{http_code}')
  if [ "$CITED_CODE" = "400" ] && jq -e '(.detail | type) == "string" and (.detail | test("task_id"))' "$CITED_JSON" >/dev/null 2>&1; then
    echo "cited-by: this backend does not serve ?task_id yet — section skipped (do NOT substitute source_task_id: that is provenance, not citation)"; : > "$CITED_JSON"
  elif jq -e '.items | type == "array"' "$CITED_JSON" >/dev/null 2>&1; then
    echo "cited-by: $(jq '.items | length' "$CITED_JSON") Imprint(s) already tied to this Ghost"
  else
    echo "CITED-BY FAILED (HTTP $CITED_CODE) — not 'nothing cited': $(head -c 300 "$CITED_JSON")"; : > "$CITED_JSON"
  fi
fi
```

Rendering waits for Phase 1d, where the mechanism axis joins and one dedupe covers all three sources.

> **CHECKPOINT — Phase 0 complete.** Proceed to Phase 1.

---

## Phase 1 — Codebase Exploration

### 1a. Search for relevant code

Use Glob and Grep to find all files related to the topic:

- Glob for file names matching topic keywords (e.g., `**/*auth*`, `**/*pagination*`)
- Grep for code patterns, function names, class names, comments mentioning the topic
- Read the repo's CLAUDE.md and any architecture docs/manifests it points to for context

### 1b. Trace code paths

For implementation-related topics, trace the full path through the repo's layers (typical shapes):

- **Backend:** API route → service → repository → model → database
- **Frontend:** Page/component → hook → API client → context

Identify:

- Entry points (routes, event handlers, UI components)
- Data flow (how data moves through the system)
- Configuration and environment dependencies
- Related tests and their coverage

### 1c. Read all discovered files

Read each relevant file using the Read tool. Build a mental model of:

- How the feature/subsystem works today
- Current limitations or tech debt
- Where the code diverges from common patterns

### 1d. Recall — mechanism axis (from the files you actually read)

Imprints are written in MECHANISM vocabulary (file and symbol names) while topics name FEATURES, so the 0d recall cannot reach the gotcha it most needs. Rebuild the synthetic ghost's `context_payload.files` from **the files you opened with Read in 1c** — at most 12, the most load-bearing ones, repo-relative (the jq keeps only the basename; a Grep/Glob hit you did not open does not count; CLAUDE.md and `manifests/*.md` read for orientation do not count). The ghost's own files from 0d are kept (union). The jq sorts terms before its 500-char cap, so an over-long list is truncated alphabetically, not by importance — that is why the list is short and chosen by hand:

```bash
jq --args '.context_payload.files = ((.context_payload.files // []) + $ARGS.positional | unique)' \
  backend/app/services/example_service.py frontend/src/pages/Example.jsx \
  < "$GHOST_JSON" > "$GHOST_JSON.tmp" && mv "$GHOST_JSON.tmp" "$GHOST_JSON"

# MECHANISM axis — BYTE-IDENTICAL to commence-haunt Phase 1a (pinned); reads the same synthetic file.
RECALL_MECH_BODY=$(jq '{query: (([.title | scan("[[:alnum:]]{2,}")] | map(ascii_downcase) | unique) as $feat | [(.context_payload // {}) | if (.files? | type) == "array" then (.files[] | tostring) else (tostring | scan("[A-Za-z0-9]+_[A-Za-z0-9_]+|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+")) end] | map(split("/") | (.[-1] | sub("\\.[^.]*$";"")) as $s | (if ($s | ascii_downcase | test("^(index|main|init|app|mod|types|utils|helpers|constants)$")) then ((.[-2] // "") + " " + $s) else $s end)) | map(gsub("(?<a>[a-z0-9])(?<b>[A-Z])";"\(.a) \(.b)") | ascii_downcase) | map(scan("[a-z0-9]+")) | map(select(length >= 3)) | map(. as $w | select((["js","jsx","ts","tsx","mjs","cjs","py","md","mdx","json","sh","bash","yml","yaml","toml","ini","sql","css","scss","html","txt","test","tests","spec","specs","and","not"] | index($w)) == null and ($feat | index($w)) == null)) | unique | reduce .[] as $w ([]; if ((. + [$w]) | join(" OR ") | length) <= 500 then . + [$w] else . end) | join(" OR ")), project_id: .project_id}' "$GHOST_JSON")

if [ -n "$(printf '%s' "$RECALL_MECH_BODY" | jq -r '.query')" ]; then
  RECALL_MECH_CODE=$(curl -s -X POST "$API_BASE/api/agent/imprints/recall" \
    -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d "$RECALL_MECH_BODY" \
    -o "$RECALL_MECH_JSON" -w '%{http_code}')
else
  RECALL_MECH_CODE="skipped (no mechanism terms)"
fi
jq -e '.items | type == "array"' "$RECALL_MECH_JSON" >/dev/null 2>&1 \
  && echo "recall (mechanism): $(jq '.items | length' "$RECALL_MECH_JSON") hit(s)" \
  || echo "RECALL FAILED (mechanism HTTP $RECALL_MECH_CODE) — do NOT read this as an empty Coven: $(head -c 300 "$RECALL_MECH_JSON")"

# ONE render shape for all three sources, ONE dedupe. Cited-by rows come first (an Imprint that cites
# THIS ghost outranks a term match); the recall block then holds only what the first list did not.
CITED_MD="/tmp/cited.$RUN_TAG.md"; RECALL_MD="/tmp/recall.$RUN_TAG.md"
RENDER='select((.items|type)=="array") | .items[] | "- [\(.memory_type) · \(.scope)] **\(.title)** — \(.content) _(imprint \(.id[0:8]); learned on: \(.source_task_title // "—"))_"'
jq -r "$RENDER" "$CITED_JSON" 2>/dev/null | awk "NF && !seen[\$0]++" > "$CITED_MD"
{ jq -r "$RENDER" "$RECALL_JSON" 2>/dev/null; jq -r "$RENDER" "$RECALL_MECH_JSON" 2>/dev/null; } | awk "NF && !seen[\$0]++" \
  | { [ -s "$CITED_MD" ] && grep -vxF -f "$CITED_MD" || cat; } > "$RECALL_MD"
[ -s "$CITED_MD" ] && { echo "### What the Coven already learned on this Ghost"; cat "$CITED_MD"; }
[ -s "$RECALL_MD" ] && { echo "### Recalled imprints"; cat "$RECALL_MD"; }
[ -s "$CITED_MD" ] || [ -s "$RECALL_MD" ] || echo "recall: empty (nothing recorded for these terms)"
```

Read every hit before Phase 2 — a `gotcha` or `convention` here changes what you research and what you recommend. Both blocks go into the analysis (3g) and the Scroll.

> **CHECKPOINT — Phase 1 complete.** Proceed to Phase 2.

---

## Phase 2 — Web Research (unless `--no-web`)

If `--no-web` flag is present, skip to Phase 3.

### 2a. Load web research tools

**CRITICAL:** WebSearch and WebFetch are deferred tools. You MUST load them first:

Use the host's available web search and page-retrieval tools. On Claude, use ToolSearch to load WebSearch/WebFetch if needed; on Codex, use its web tools directly.

### 2b. Search for best practices

Run 3-4 targeted web searches, substituting the relevant technologies from this repo's stack:

1. **Best practices:** "[topic] best practices [relevant technology from the repo's stack]"
2. **Common issues:** "[topic] common pitfalls production" or "[topic] anti-patterns"
3. **Scaling:** "[topic] at scale" or "[topic] performance optimization"
4. **Alternatives:** "[topic] alternatives comparison [year]"

### 2c. Fetch and synthesize

Use WebFetch to read the top 2-3 results from each search.

**IMPORTANT:** Synthesize findings — extract actionable insights and recommendations. Do NOT paste raw page content. Cite sources by name (e.g., "According to the framework's documentation...").

> **CHECKPOINT — Phase 2 complete.** Proceed to Phase 3.

---

## Phase 3 — Analysis

Compile all findings into these sections:

### 3a. Current Implementation

How the codebase handles this topic today:

- Key files and their roles (with paths)
- Data flow diagram (text-based)
- Current behavior and capabilities
- Existing tests

### 3b. Best Practices (from web research)

What the industry recommends:

- Cited recommendations with source attribution
- Patterns that are widely adopted
- Standards or specifications to follow

### 3c. Gap Analysis

Where current implementation diverges from best practices:

- Missing features or behaviors
- Anti-patterns in use
- Opportunities for improvement

### 3d. Reliability Concerns

Failure modes and resilience issues:

- What happens when things go wrong (DB down, API timeout, invalid input)
- Error handling gaps
- Race conditions or concurrency issues
- Data integrity risks
- Missing retries, circuit breakers, or graceful degradation

### 3e. Scaling Considerations

What breaks at 10x, 100x usage:

- Database query performance (missing indexes, N+1 queries)
- Memory usage patterns
- External service dependencies
- Pagination and batch processing limits
- Caching opportunities

### 3f. Recommendations

Prioritized list of actions:

- **Quick Win** (low effort, high impact) — Can be done in a single PR
- **Medium Effort** (moderate effort, high impact) — Requires planning
- **Major Refactor** (high effort, high impact) — Significant architectural change

Each recommendation should include: what to do, why, and estimated scope.

### 3g. What the Coven already knew

The two blocks from 1d, verbatim and in that order: "What the Coven already learned on this Ghost" (Cited-by rows, only when a ghost was given and the filter is served) then "Recalled imprints". Omit the section only when both are empty. Where a recalled Imprint confirms or contradicts a finding above, say so beside the finding — that is the point of recalling before writing.

> **CHECKPOINT — Phase 3 complete.** Proceed to Phase 4.

---

## Phase 4 — Create Scroll & Report

### 4a. Format the Scroll content

```markdown
# Investigation: [Topic]

[PROVENANCE_MD verbatim — generated below; omit when no Ghost/Augury]

**Investigated:** [date]
**Scope:** [what was examined — files, endpoints, subsystems]
**Sources:** [web sources consulted, if any]

## Current Implementation

[findings from 3a]

## Best Practices

[findings from 3b — with citations]

## Gap Analysis

[findings from 3c]

## Reliability Concerns

[findings from 3d]

## Scaling Considerations

[findings from 3e]

## What the Coven already knew

[3g — both blocks, Cited-by first; omit when empty]

## Related Scrolls

[4a-bis — `- [title](/scrolls/<id>) (<short id>)` rows; omit when empty]

## Recommendations

### Quick Wins

1. **[Action]** — [why] (effort: low, impact: high)

### Medium Effort

2. **[Action]** — [why] (effort: medium, impact: high)

### Major Refactors

3. **[Action]** — [why] (effort: high, impact: high)
```

### 4a-provenance. Link the work this research belongs to

**Required whenever a Ghost or explicit Augury resolved.** Render the following with the helper shipped beside the **loaded** skill (plugin root `GK_ROOT`, not a hard-coded consumer checkout). Do not hand-escape titles or interpolate API titles into shell code. The helper validates UUIDs, normalizes title whitespace, and encodes Markdown control characters and slashes as HTML entities: the existing raw-body parser must see only the intended destination, even if a title contains another entity URL or paired backticks.

```bash
PROVENANCE_MD=$(mktemp)
PROVENANCE_ARGS=()
[ -n "${GHOST_ID:-}" ] && PROVENANCE_ARGS+=(--ghost "$GHOST_REAL_JSON")
[ -n "${AUGURY_ID:-}" ] && PROVENANCE_ARGS+=(--augury "$AUGURY_REAL_JSON")
python3 "$GK_ROOT/scripts/investigate-provenance.py" "${PROVENANCE_ARGS[@]}" > "$PROVENANCE_MD"
# Nonzero exit: STOP. Do not publish a Scroll without its promised provenance.
```

Insert the file's exact bytes directly under the Scroll heading before its date/scope. It emits `**Investigated for:** [title](/ghosts/<id>)` and, when in scope, `**Augury in scope:** [title](/auguries/<id>)`. With neither record it emits nothing. Under `--no-scroll`, no Scroll is created. This does not backfill old research or alter Imprint/EVP write-back semantics.

### 4a-bis. Related Scrolls

Find Scrolls the Coven already holds on this topic with the ranked search — never the Library `?search=` substring filter (a five-word topic matches nothing there). The search ANDs a plain phrase, so send the **feature-axis query from 0d** (`a OR b OR c` — websearch syntax honours `OR`), URL-encoded; the server ranks, caps at 10 per type and does not paginate. Take the top 5 Scroll hits as id links (clickable in-app after rite 1a's frontend wave; graph edges after rite 1b). Brackets and parentheses are stripped from the link text so a title cannot break the link:

```bash
Q=$(printf '%s' "$RECALL_BODY" | jq -r '.query')
RELATED_JSON="/tmp/related.$RUN_TAG.json"; RELATED_MD="/tmp/related.$RUN_TAG.md"; : > "$RELATED_MD"
RELATED_CODE=$(curl -s -G "$API_BASE/api/agent/search" --data-urlencode "q=$Q" -H "$AUTH" -H "$GH_CLIENT" -o "$RELATED_JSON" -w '%{http_code}')
if jq -e '.documents | type == "array"' "$RELATED_JSON" >/dev/null 2>&1; then
  jq -r '.documents[] | select(.type == "scroll") | "- [\(.title | gsub("[\\[\\]()]"; " "))](/scrolls/\(.id)) (\(.id[0:8]))"' "$RELATED_JSON" | head -5 > "$RELATED_MD"
  [ -s "$RELATED_MD" ] && cat "$RELATED_MD" || echo "related scrolls: none"
else
  echo "RELATED-SCROLLS FAILED (HTTP $RELATED_CODE) — not 'none': $(head -c 300 "$RELATED_JSON")"
fi
```

Expect noise when a topic word is Coven-common (`OR` matches any word, and ranking has no IDF) — keep the section honest, not curated. Related rows show the short id; the EVP and the 4d summary show the full id.

**Content cap:** Keep Scroll content under 400KB (the platform caps Scrolls at 500KB). If findings are extensive, summarize web research results rather than including full quotes. If still over 400KB, split into multiple Scrolls (e.g., "Investigation: [Topic] — Part 1: Analysis", "Part 2: Recommendations").

### 4b. Create the Scroll (unless `--no-scroll`)

Write the markdown to a temp file and build the payload with `jq --rawfile` (never inline `\n` escapes in shell strings — the Scroll would render as one escaped line):

```bash
# Retain this directory AND payload until the investigation is complete.
# On a resumed run, reuse it; do not rerun mktemp or create a second Scroll.
INVESTIGATION_DIR=$(mktemp -d)
SCROLL_MD="$INVESTIGATION_DIR/scroll.md"
# ... write the full markdown content, including PROVENANCE_MD, to "$SCROLL_MD" ...
SCROLL_TITLE="Investigation: $TOPIC"
jq -n --rawfile content "$SCROLL_MD" --arg title "$SCROLL_TITLE" \
  '{title: $title, content: $content}' > "$INVESTIGATION_DIR/payload.json"
SCROLL_CODE=$(curl -sS -X POST "$API_BASE/api/agent/hauntings/$HAUNTING_ID/scrolls" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  --data-binary "@$INVESTIGATION_DIR/payload.json" \
  -o "$INVESTIGATION_DIR/response.json" -w '%{http_code}')
SCROLL_RESP=$(cat "$INVESTIGATION_DIR/response.json")
SCROLL_ID=$(printf '%s' "$SCROLL_RESP" | jq -r '.id // empty')
# Continue only on a successful HTTP response with a valid Scroll id.
```

**Create is non-idempotent.** On retry, reuse the saved successful response and `SCROLL_ID`. After a timeout, lost response, or other uncertain outcome, do not blindly repeat the POST or start write-back: inspect paginated Scrolls under the exact parent, read candidates, and recover only a **unique exact title + parent + body** match. Match the server’s `CreateDocumentRequest` normalization: apply Python `str.strip()` to the expected title and body before comparison (outer whitespace only; do not collapse internal whitespace, decode entities, or lowercase). Preserve the exact project/portfolio/parent-document identity. If recovery is ambiguous or unavailable, report the uncertain outcome and stop writes. A definite rejected create can be corrected; an intentional new investigation is a new run. EVP POST is also non-idempotent: recover its existing exact comment before retrying, separately from Scroll creation.

### 4b-proof. Read back the generated links

Before write-back, GET the created Scroll and verify its body contains the exact generated provenance. Then:

1. `GET /api/agent/scrolls/$SCROLL_ID/links`: require every expected Ghost/Augury ID with `reason: null`; the provenance rows must not introduce incidental targets from their titles.
2. `GET /api/agent/ghosts/$GHOST_ID/backlinks` and/or `/auguries/$AUGURY_ID/backlinks`: page until the created Scroll is found or `has_more: false`. A first-page miss is not proof of failure.
3. `GET /api/agent/graph?root=scroll:$SCROLL_ID&hops=1`: require `links_to` edges with source `SCROLL_ID` and each expected target. A truncated response cannot prove absence; use the exact `/links` + `/backlinks` evidence and report incomplete graph proof honestly.

No Ghost/Augury → no provenance proof needed. `--no-scroll` → no create/read-back. Missing proof is an explicit failure in the report, never a claim that the graph is connected. When validating a changed skill, a **fresh session** must load that skill and record its literal version, source path/hash, generated Scroll id/body, and these responses. A manually composed test body is parser coverage, not proof that the new skill generated it.

### 4b-bis. Write back Imprints (memory)

Hand the Coven what this investigation VERIFIED. An investigation Imprint is something you confirmed about the code **as it is today** — a `fact` / `gotcha` / `convention` / `procedure` you can cite with a path — **never something the Scroll recommends**: nothing from 3c Gap Analysis or 3f Recommendations is an Imprint (a recommendation is a decision no Hunter has ruled on — it stays in the Scroll or becomes an Augury, `POST /api/agent/auguries`), and "this Scroll exists" is not an Imprint either (that is what `links` and Cited-by are for). Test: if the sentence contains *should*, *could* or *recommend*, or would be false if the Scroll were deleted, it is not an Imprint. Aim for 1-3; nothing durable → skip and say so in the EVP.

1. **Key derivation — one rule.** The idempotency key needs a unit-of-work id:
   - `SCROLL_ID` set → `writeback:investigate:$SCROLL_ID` (a fresh Scroll per run makes it retry-safe with no attempt suffix);
   - else `GHOST_ID` set (no Scroll: `--no-scroll`, or the create failed) → `writeback:investigate:$GHOST_ID:<digest>` where the digest is the first 16 hex of the SHA-256 of the items (computed below — modeled on `backend/mcp_server/workflows.py::writeback_idempotency_key`, not byte-equal to it and it need not be: only your own retry must agree);
   - else (no Scroll and no ghost — including a Scroll create that failed with no ghost) → **skip** the write-back and report `Imprints: none — no Scroll or Ghost to key on`. A Haunting id alone is never a key.

   Scope: `project` with `project_id = $HAUNTING_ID` in both branches; `org` only for a truth that holds Coven-wide; if `HAUNTING_ID` is empty, write no project-scope item (an org-scope item is still fine).
2. **Supersede idiom — recall each candidate's key phrase first** (default recall is vivid-only, so a stale Imprint left standing beside yours keeps being recalled next to it):

   ```bash
   KEY_PHRASE="<key phrase of the learning>"
   SUP_JSON="/tmp/supersede-recall.$RUN_TAG.json"
   SUP_CODE=$(curl -s -X POST "$API_BASE/api/agent/imprints/recall" \
     -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
     -d "$(jq -n --arg q "$KEY_PHRASE" --arg p "$HAUNTING_ID" '{query: $q, project_id: (if $p == "" then null else $p end), limit: 5}')" \
     -o "$SUP_JSON" -w '%{http_code}')
   if jq -e '.items | type == "array"' "$SUP_JSON" >/dev/null 2>&1; then
     jq -r '.items[] | "\(.id)  [\(.memory_type) · \(.scope) · \(.status)] \(.title)"' "$SUP_JSON"
   else
     echo "SUPERSEDE-RECALL FAILED (HTTP $SUP_CODE) — do NOT read this as 'nothing covers it': $(head -c 300 "$SUP_JSON")"
   fi
   ```

   Covered and still right → **SKIP** yours. Covered but yours is the correction → **SUPERSEDE** (`supersedes_id` on your item; the target fades atomically; two items naming one target fail the batch). A covering hit whose `project_id` is not `$HAUNTING_ID`, or an org-scoped one, can only be superseded at **org** scope — keep or widen, never sideways: that item becomes `"scope": "org"` with NO `project_id`. Nothing covers it → write it. A failed recall here is not a clean slate: write without `supersedes_id` and note the failed check in the EVP.
3. **Build the items file, then the key, then POST** (the digest never includes the key — it is set after). Paste the block DEDENTED: an indented `IMPEOF` never terminates the heredoc and bash silently swallows the key derivation and the POST.

   ```bash
   IMP="/tmp/imprints.$RUN_TAG.json"
   cat > "$IMP" << 'IMPEOF'
   {
     "items": [
       {
         "memory_type": "gotcha",
         "title": "<the verified learning in one line>",
         "content": "<the fact itself — what, where (path), why it bites; not an essay>",
         "scope": "project",
         "project_id": "{HAUNTING_ID}",
         "links": [{"kind": "document", "id": "{SCROLL_ID}"}],
         "tags": ["<topic word>", "<subsystem>"]
       }
     ]
   }
   IMPEOF
   # When a ghost was given, cite it too: add {"kind": "task", "id": "{GHOST_ID}"} to links and
   # "source_task_id": "{GHOST_ID}" to each item. When SCROLL_ID is empty (--no-scroll, or the
   # create failed) drop the document link from every item — a dead link 404s the whole batch.
   if [ -n "${SCROLL_ID:-}" ]; then
     KEY="writeback:investigate:$SCROLL_ID"
   elif [ -n "${GHOST_ID:-}" ]; then
     DIGEST=$(jq -cS '.items' "$IMP" | shasum -a 256 | cut -c1-16)
     KEY="writeback:investigate:$GHOST_ID:$DIGEST"
   else
     KEY=""
   fi
   if [ -n "$KEY" ]; then
     jq --arg k "$KEY" '.idempotency_key = $k' "$IMP" > "$IMP.tmp" && mv "$IMP.tmp" "$IMP"
     curl -s -X POST "$API_BASE/api/agent/imprints/batch" \
       -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" -d @"$IMP" \
       | jq '{memory_ids, replayed, error: .detail}'
   else
     echo "Imprints: none — no Scroll or Ghost to key on"
   fi
   ```

   `replayed: true` means an earlier run already wrote under that key and nothing from this call was inserted — report it as such, never as "N recorded". A `400 IMPRINT_BATCH_ITEM_INVALID` lists every failing item in `failing_indexes`: fix them all and resend (editing an item changes the ghost-keyed digest — fine, a 400 recorded nothing). A failed write-back never blocks the report; say what happened in the EVP.

### 4c. Post EVP on ghost (if ghost ID was provided)

```bash
EVP_MD=$(mktemp)
cat > "$EVP_MD" << 'EOF'
Investigation complete: [Topic]

Key findings:
- [bullet 1]
- [bullet 2]
- [bullet 3]

Full Scroll: [Investigation: Topic — brackets and parentheses stripped from the link text](/scrolls/<SCROLL_ID>) (<SCROLL_ID>) in [Haunting Name] | none — --no-scroll | none — create failed: HTTP n
Related Scrolls: <n> linked in the Scroll | <n> listed above (no Scroll) | none
Imprints: <n> recorded (<ids>) | replayed — nothing new inserted (<ids>) | none — <reason: nothing durable / batch failed: HTTP n>
EOF
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile content "$EVP_MD" '{content: $content}')"
```

(EVP body field is `content`, not `body`.)

### 4d. Present to user

Display the full investigation findings in the conversation.

If a Scroll was created, include: "Scroll created: [title](/scrolls/<id>) (<id>) in [Haunting Name]", then the Related Scrolls count and the Imprint write-back result (ids, `replayed`, or the explicit skip / failure reason).

If a ghost EVP was posted, include: "Summary posted as EVP on ghost [Ghost Title]"

## Error Handling

- **Topic too vague (< 5 words, no technical terms):** Ask the user to narrow the scope.
- **No matching code found:** Report that the topic does not appear in the codebase. If `--no-web` is not set, proceed with web research only.
- **Web search fails or returns no results:** Proceed with codebase-only findings. Note: "Web research was attempted but yielded no relevant results."
- **Séance cannot be resolved (no config, no confident fuzzy match):** Ask the user which séance/haunting to target; with `--no-scroll` this doesn't block the research itself.
- **Scroll creation fails (API error):** Display full findings in the conversation instead and report the API error. `SCROLL_ID` stays empty, so 4b-bis keys on the Ghost id + digest when a ghost was given (drop the `document` link from every item) and is skipped otherwise; the EVP's Full Scroll line reads `none — create failed: HTTP n`.
- **Scroll content exceeds 400KB:** Split into multiple Scrolls with sequential titles.
- **No target haunting identified and user doesn't respond:** Create the Scroll under the first available haunting in the resolved séance and note this in the output (séance scope only — coven scope aborts per 0c).
- **ToolSearch for WebSearch/WebFetch fails:** Proceed with `--no-web` behavior. Report: "Web research tools unavailable — codebase-only analysis."

## Key Reminders

- **EVP body field is `content`** not `body`; Scroll create takes `{title, content}`.
- **List endpoints return `{items: [...]}`.**
- **JSON field names are standard** (`project_id`, `portfolio_id` — not `haunting_id`/`seance_id`) even though URLs use spooky names.
- **`PUT /context` REPLACES** the whole payload — if you ever write intermediate state to a ghost's context, GET-merge-PUT.
- **Use `jq --rawfile` for all multi-line API payloads** — never inline `\n` in shell strings.
- **Recall before you read code, write back after the Scroll exists** (0d / 1d / 4b-bis): the two recall jq lines are byte-identical to commence-haunt's and read the SYNTHETIC ghost file (`$GHOST_JSON`), never the real one (`$GHOST_REAL_JSON`); an Imprint is a verified fact about the code, never a recommendation; the key is the Scroll id, else the Ghost id + digest, else skip.
- **Never a bare positional parameter (dollar-zero, dollar-one) in this file** — the harness rewrites them; awk's record variable is written `\$0` inside double quotes, and shell functions take no positionals here. Any snippet that uses `read -r ... path ...` runs under `bash -c` (zsh ties `$path` to `$PATH`).
