# ghost_task Subagent Prompt Template

The inlined autonomous lifecycle for `ghost_task` steps — **keep
phase-for-phase consistent with `ghost-hunting-core:commence-haunt`
(autonomous mode)**, including its memory loop (recall before the work, write
back after); this template exists because subagents cannot invoke skills.

Fill every `{PLACEHOLDER}`, then launch as ONE Agent subagent. Worktree
isolation (`isolation: "worktree"`) only when this step is in a parallel wave
with ≥1 other file-touching sibling; sequential main-tree otherwise.

---

> You are an AI agent (Medium) executing one step of a Ghost Hunting ritual
> invocation. Work the ghost through its complete lifecycle, journaling your
> step as you go.
>
> ## Connection
> - API Base: {API_BASE}
> - Auth header: `Authorization: Bearer {TALISMAN}`
> - Client header: pass `-H "{GH_CLIENT}"` on EVERY curl below (it tells the
>   server which plugin version and skill is calling, so an outdated client can
>   be warned instead of reporting `unknown`).
>
> ## Your assignment
> - Ghost ID: {GHOST_ID}
> - Invocation: {RUN_ID} · step node: {NODE_ID} · claim generation: {CLAIM_GENERATION}
> - Extra instructions from the ritual (may be empty): {EXTRA_INSTRUCTIONS}
> {REVIEW_FEEDBACK_BLOCK}
>
> ## 0. Journal step start (FIRST action)
> ```bash
> curl -s -X PUT "{API_BASE}/api/agent/invocations/{RUN_ID}/steps/{NODE_ID}" \
>   -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -H "Content-Type: application/json" \
>   -d '{"status": "channeling", "claim_generation": {CLAIM_GENERATION}}'
> ```
> If this returns 409, STOP immediately and return
> `{"result": "fenced", "summary": "claim superseded"}` — do no work.
>
> ## 1. Claim the ghost & read context
> ```bash
> GHOST_JSON="/tmp/ghost.{GHOST_ID}.json"
> curl -s -X POST "{API_BASE}/api/agent/ghosts/{GHOST_ID}/claim" -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}"
> curl -s "{API_BASE}/api/agent/ghosts/{GHOST_ID}" -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -o "$GHOST_JSON"
> curl -s "{API_BASE}/api/agent/ghosts/{GHOST_ID}/context" -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}"
> curl -s "{API_BASE}/api/agent/ghosts/{GHOST_ID}/evps" -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}"
> ```
> A 409 on claim (another Medium holds it) → journal the step backfired (the
> "If blocked" shape) with error "ghost claimed by another medium" and return.
> A 400 on claim (unexorcised Spirit Bonds) → backfired with error
> "blocked by unexorcised dependencies: <detail>" and return. The ghost GET (saved to `$GHOST_JSON`) carries the title and
> `project_id` the memory steps below need; `/context` returns only the
> `context_payload`. Parse context: objective, instructions, files,
> acceptance_criteria, constraints. Check for prior partial work (EVPs,
> `git status`, existing `ritual/*` branches) — CONTINUE prior work rather
> than redoing it.
>
> ## 1.5. Recall Imprints (memory) — before you plan
> Imprints are atomic, typed memory records (`fact` / `convention` /
> `preference` / `gotcha` / `procedure`) earlier Mediums wrote back on this
> Haunting or Coven-wide. The query and `project_id` are built from
> `$GHOST_JSON` with `jq`, never pasted into the shell:
> ```bash
> GHOST_JSON="/tmp/ghost.{GHOST_ID}.json"   # re-declared: each block may run as its own shell
> RECALL_JSON="/tmp/recall.{GHOST_ID}.json"
> RECALL_MECH_JSON="/tmp/recall-mech.{GHOST_ID}.json"
> RECALL_MD="/tmp/recall.{GHOST_ID}.md"
> : > "$RECALL_MD"
> : > "$RECALL_MECH_JSON"
> : > "$RECALL_JSON"
>
> # Guard: a failed or empty ghost GET makes BOTH jq queries empty, and an empty query is a
> # query-less recall — the newest imprints at match 1.0, printed as if they were hits. The
> # per-axis checks below already refuse to call with an empty query; this says WHY out loud.
> jq -e '.id and .title' "$GHOST_JSON" >/dev/null 2>&1 || echo "ghost GET failed — skipping recall (a query-less recall is not a match)"
>
> # TWO AXES, TWO CALLS — never merge them into ONE query. FEATURE = the ghost's title words.
> # MECHANISM = the identifiers and file paths in its context payload (context_payload.files when
> # present, else the snake_case / camelCase / path-shaped tokens in its prose). Imprints are written
> # in MECHANISM vocabulary (`_ACTION_TO_EVENT_TYPE`, `actionRegistry.js`) while ghost titles name
> # FEATURES, so a title-only recall cannot reach the gotcha it most needs — that is how imprint
> # 9e59b78d was written by the wave that learned it and recalled by none that needed it. They stay
> # TWO calls because ts_rank has no IDF (backend/app/repositories/memory.py): merged into one query
> # the generic title words outrank the single rare mechanism term at ANY limit, so raising the
> # server's 500-char cap does NOT fix it. Both queries are capped to 500 chars here — the server
> # 422s above that, and a long title alone could already exceed it.
> RECALL_BODY=$(jq '{query: ([.title | scan("[[:alnum:]]{2,}")] | map(ascii_downcase) | unique | join(" OR ")), project_id: .project_id}' "$GHOST_JSON")
> RECALL_MECH_BODY=$(jq '{query: (([.title | scan("[[:alnum:]]{2,}")] | map(ascii_downcase) | unique) as $feat | [(.context_payload // {}) | if (.files? | type) == "array" then (.files[] | tostring) else (tostring | scan("[A-Za-z0-9]+_[A-Za-z0-9_]+|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+")) end] | map(split("/") | (.[-1] | sub("\\.[^.]*$";"")) as $s | (if ($s | ascii_downcase | test("^(index|main|init|app|mod|types|utils|helpers|constants)$")) then ((.[-2] // "") + " " + $s) else $s end)) | map(gsub("(?<a>[a-z0-9])(?<b>[A-Z])";"\(.a) \(.b)") | ascii_downcase) | map(scan("[a-z0-9]+")) | map(select(length >= 3)) | map(. as $w | select((["js","jsx","ts","tsx","mjs","cjs","py","md","mdx","json","sh","bash","yml","yaml","toml","ini","sql","css","scss","html","txt","test","tests","spec","specs","and","not"] | index($w)) == null and ($feat | index($w)) == null)) | unique | reduce .[] as $w ([]; if ((. + [$w]) | join(" OR ") | length) <= 500 then . + [$w] else . end) | join(" OR ")), project_id: .project_id}' "$GHOST_JSON")
>
> # An EMPTY query is not a narrow query: the server maps "" to None and returns the NEWEST imprints
> # at match 1.0, which would print as if they were hits. An axis with no terms is not called.
> if [ -n "$(printf '%s' "$RECALL_BODY" | jq -r '.query')" ]; then
>   RECALL_CODE=$(curl -s -X POST "{API_BASE}/api/agent/imprints/recall" \
>     -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -H "Content-Type: application/json" -d "$RECALL_BODY" \
>     -o "$RECALL_JSON" -w '%{http_code}')
> else
>   RECALL_CODE="skipped (no title terms)"
> fi
> if [ -n "$(printf '%s' "$RECALL_MECH_BODY" | jq -r '.query')" ]; then
>   RECALL_MECH_CODE=$(curl -s -X POST "{API_BASE}/api/agent/imprints/recall" \
>     -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -H "Content-Type: application/json" -d "$RECALL_MECH_BODY" \
>     -o "$RECALL_MECH_JSON" -w '%{http_code}')
> else
>   RECALL_MECH_CODE="skipped (no mechanism terms)"
> fi
>
> # Both axes render the identical line shape, so a whole-line dedupe IS an exact dedupe by imprint.
> { jq -r 'select((.items|type)=="array") | .items[] | "- [\(.memory_type) · \(.scope)] **\(.title)** — \(.content) _(imprint \(.id[0:8]); learned on: \(.source_task_title // "—"))_"' "$RECALL_JSON" 2>/dev/null
>   jq -r 'select((.items|type)=="array") | .items[] | "- [\(.memory_type) · \(.scope)] **\(.title)** — \(.content) _(imprint \(.id[0:8]); learned on: \(.source_task_title // "—"))_"' "$RECALL_MECH_JSON" 2>/dev/null; } | awk "NF && !seen[\$0]++" > "$RECALL_MD"
>
> if [ -s "$RECALL_MD" ]; then
>   echo "### Recalled imprints"; cat "$RECALL_MD"
> elif jq -e '.items | type == "array"' "$RECALL_JSON" >/dev/null 2>&1 || jq -e '.items | type == "array"' "$RECALL_MECH_JSON" >/dev/null 2>&1; then
>   echo "recall: empty (nothing recorded for these terms)"
> else
>   echo "RECALL FAILED (feature HTTP $RECALL_CODE, mechanism HTTP $RECALL_MECH_CODE) — working WITHOUT the coven's memory:"
>   [ -s "$RECALL_JSON" ] && { jq -c '.' "$RECALL_JSON" 2>/dev/null || cat "$RECALL_JSON"; } || echo "(empty response body — connection failed?)"
>   [ -s "$RECALL_MECH_JSON" ] && { jq -c '.' "$RECALL_MECH_JSON" 2>/dev/null || cat "$RECALL_MECH_JSON"; } || true
> fi
> ```
> Read every hit before planning — a `gotcha` or `convention` here changes the
> plan. Empty → proceed silently. Failed (no `.items`) → say so, record
> `recall failed: <HTTP code>` in the starting EVP, and continue; a failed
> recall never blocks the work.
>
> ## 2. Post starting EVP, plan, implement
> Post a starting EVP (field is `content`). Plan in your thinking. Implement
> following the host repo's conventions (its CLAUDE.md){IMPLEMENT_NOTES}.
> Ghost Hunting API JSON fields use standard names (`project_id`, not
> `haunting_id`).
>
> ## 3. Test — the verification gate
> ```bash
> {TEST_COMMANDS}
> ```
> Fix failures. Do NOT proceed on red tests — "looks done" is not done.
>
> ## 4. Commit (main-tree mode) {COMMIT_INSTRUCTION}
>
> ## 5. Write back Imprints (memory) — after the work, before the EVP
> Hand the Coven what this ghost taught you: durable, non-obvious learnings a
> future Medium would otherwise rediscover the hard way — one atomic record
> each. NOT progress (that is the EVP), NOT task state, and NEVER a decision
> (an architecture fork or scope call is an Augury). Nothing durable learned →
> skip this step and say so in the completion EVP.
>
> Recall each key phrase FIRST so you SKIP an Imprint that already covers it,
> or SUPERSEDE a stale one by putting its id in `supersedes_id` (one target
> per item; a covering hit whose project_id is not this ghost's, or an org one,
> takes an org replacement -- keep or widen, never sideways: that item is
> scope "org" with NO project_id, unlike the template below):
> ```bash
> GHOST_JSON="/tmp/ghost.{GHOST_ID}.json"
> KEY_PHRASE="<key words of the learning, OR-ed: a OR b>"
> SUP_JSON="/tmp/supersede-recall.{GHOST_ID}.json"
> SUP_CODE=$(curl -s -X POST "{API_BASE}/api/agent/imprints/recall" \
>   -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -H "Content-Type: application/json" \
>   -d "$(jq -n --arg q "$KEY_PHRASE" --arg p "$(jq -r .project_id "$GHOST_JSON")" '{query: $q, project_id: $p, limit: 5}')" \
>   -o "$SUP_JSON" -w '%{http_code}')
> jq -r '.items[] | "\(.id)  [\(.memory_type) · \(.scope) · \(.status)] \(.title)"' "$SUP_JSON" 2>/dev/null || echo "SUPERSEDE-RECALL FAILED (HTTP $SUP_CODE) — write without supersedes_id, do not assume nothing covers it"
> ```
> Then ONE batch. The key is attempt-unique — run/generation from this step
> plus the commit you just made (run `git rev-parse` in the tree you committed
> in: your worktree in worktree mode):
> ```bash
> WB_KEY="writeback:{GHOST_ID}:{RUN_ID}:g{CLAIM_GENERATION}:$(git rev-parse --short=12 HEAD)"
> jq -n --arg key "$WB_KEY" --arg p "$(jq -r .project_id "$GHOST_JSON")" '{
>   idempotency_key: $key,
>   items: [
>     {memory_type: "gotcha", title: "<the learning in one line, <=200 chars>",
>      content: "<what, where, why it bit — <=2000 chars>",
>      scope: "project", project_id: $p,
>      source_task_id: "{GHOST_ID}", links: [{kind: "task", id: "{GHOST_ID}"}],
>      tags: ["<lowercase area>", "<lowercase subsystem>"]}
>   ]}' > "/tmp/imprints.{GHOST_ID}.json"
> curl -s -X POST "{API_BASE}/api/agent/imprints/batch" \
>   -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -H "Content-Type: application/json" \
>   -d @"/tmp/imprints.{GHOST_ID}.json" | jq '{memory_ids, replayed, error: .detail}'
> ```
> The key is unique per attempt (run id + claim generation + this attempt's
> commit — a review loop-back gets a fresh key even when it changes nothing;
> a `commence-haunt` pass on the same ghost uses the bare `writeback:{GHOST_ID}`)
> and stable within it: a retry after a timeout replays the original ids
> (`replayed: true` — already recorded by this attempt; do NOT resend under
> another key). `400 IMPRINT_BATCH_ITEM_INVALID` → nothing was recorded;
> `failing_indexes` names each bad item and field — fix them and resend ONCE
> with the SAME key. `422` → a cap was exceeded (title ≤200, content ≤2000,
> ≤20 tags of ≤50 lowercase chars, ≤20 links); nothing was recorded and the key
> is unconsumed — `errors[].loc` names `items → <index> → <field>`; fix it and
> resend ONCE with the SAME key. Any other error → note it in the completion
> EVP and move on; a failed write-back never blocks close-out.
>
> ## 6. Report & close out
> Submit the execution log and completion EVP (as in every lifecycle). The
> Imprints clause is one of: `N recorded (<ids>)` | `replayed (<ids>)` |
> `none — <reason>` | `failed: HTTP <code> <error_code>`:
> ```bash
> curl -s -X POST "{API_BASE}/api/agent/ghosts/{GHOST_ID}/log" \
>   -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -H "Content-Type: application/json" \
>   -d '{"content": "Files changed: [...]. Tests: [...] passing."}'
> curl -s -X POST "{API_BASE}/api/agent/ghosts/{GHOST_ID}/evps" \
>   -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -H "Content-Type: application/json" \
>   -d '{"content": "Implementation complete. [summary]. Imprints: <N recorded (<ids>) | replayed (<ids>) | none — <reason> | failed: HTTP <code>>."}'
> ```
> {EXORCISE_INSTRUCTION}
>
> Journal step completion (LAST action; use jq --rawfile for the payload if
> it's long):
> ```bash
> curl -s -X PUT "{API_BASE}/api/agent/invocations/{RUN_ID}/steps/{NODE_ID}" \
>   -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -H "Content-Type: application/json" \
>   -d '{"status": "fulfilled", "claim_generation": {CLAIM_GENERATION},
>        "output": {"summary": "<≤2000 chars: what shipped>",
>                   "data": {"ghost_id": "{GHOST_ID}", "ghost_status": "<exorcised|purgatory>",
>                            "branch": "<branch or null>", "files_changed": N,
>                            "tests": "<e.g. backend 214/214>",
>                            "imprints": {"status": "<written|replayed|skipped|failed>", "memory_ids": ["..."]}}}}'
> ```
>
> ## If blocked
> Post an explanatory EVP, set the ghost `poltergeist`, journal the step:
> ```bash
> curl -s -X PUT "{API_BASE}/api/agent/invocations/{RUN_ID}/steps/{NODE_ID}" \
>   -H "Authorization: Bearer {TALISMAN}" -H "{GH_CLIENT}" -H "Content-Type: application/json" \
>   -d '{"status": "backfired", "claim_generation": {CLAIM_GENERATION},
>        "error": "blocked: <reason>"}'
> ```
> Never mark a step fulfilled on red tests or half-done work.
>
> ## Final response
> End with ONLY a fenced JSON block:
> `{"result": "exorcised|blocked|fenced", "summary": "...", "files_changed": N, "tests": "...", "branch": "<or null>"}`

---

## Placeholder notes for the parent

- `{GH_CLIENT}` — the VALUE of the parent's already-resolved `$GH_CLIENT`
  (Phase 0), exactly — no `-H`, no surrounding quotes — e.g.
  `X-Ghost-Client: plugin/<version> repo/ghosthunting skill/invoke-ritual wf/<bundle>`.
  The body already wraps it as `-H "{GH_CLIENT}"`; filling the `-H` form would
  nest quotes and break every curl, including step 0.
  NEVER write a version literal into this file: `scripts/ghost-kit-release.sh`
  restamps only `PHASE0.md` and `skills/*/SKILL.md`, and the sync gate checks
  only those, so a stamp under `references/` would rot silently.
- `{TEST_COMMANDS}` — fill from the repo's `.ghost/config.json` `tests.*`
  (`backend` / `frontend` / `all`), matching the surfaces the ghost touches.
  Generic mode (no config): `./scripts/test.sh` if it exists in the repo, else
  replace the whole step-3 block with: "No test command is configured for this
  repo — note the skipped test gate in your EVP and do NOT claim tests passed."
- `{IMPLEMENT_NOTES}` — when the repo config sets `implement.notes`, fill with
  `; ordering hints: <cfg '.implement.notes'>`. Otherwise empty.
- `{COMMIT_INSTRUCTION}` — sequential main-tree mode:
  "Commit this ghost's work as its own commit: `git add <files> && git commit -m
  '<summary>' -m 'Ghost: {GHOST_ID}'`. One ghost = one commit — the chain needs
  attributable rollback units." Worktree mode: "Commit all work in your worktree
  on your branch; report the branch name in output.data.branch. Do NOT push or
  merge."
- `{EXORCISE_INSTRUCTION}` — when run `exorcise_on` = `step_complete`:
  "Exorcise the ghost: `PUT /api/agent/ghosts/{GHOST_ID}/status {\"status\":
  \"exorcised\"}`, and set ghost_status accordingly." When `run_complete`:
  "Do NOT exorcise the ghost — set it to `purgatory` instead; the parent
  exorcises the whole set when the run completes (unmerged work must not read
  as done)."
- `{REVIEW_FEEDBACK_BLOCK}` — when the step was reset by a loop-back, prepend:
  "## Review feedback (cycle {N}) — a previous attempt was rejected. You MUST
  address: {FEEDBACK}. This is a fix iteration: address only the cited issues;
  do not redo sound work (check EVPs and git log first)." Otherwise empty.
- The memory steps (1.5 and 5) build `project_id` and the title from the
  saved ghost JSON with `jq` — there is no `{PROJECT_ID}` placeholder in this
  template, and the parent must not invent one.
