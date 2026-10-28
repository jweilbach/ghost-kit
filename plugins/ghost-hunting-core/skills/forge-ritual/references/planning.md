# Plan — Rite → Waves (the W4 playbook)

Convert a scoped rite (its unexorcised ghosts) into a `waves[]` array that passes
rite-cadence's own `validatePlan`, plus a **guard bundle** Forge bakes into the
ritual. **The schema authority is the repo's vendored `.claude/workflows/rite-cadence.js`
(`validatePlan`)** — when this document and that function disagree, the function
wins. The worked wave example ships with ghost-kit at
`workflows/examples/rite-cadence.example.json` (frontend + backend/migration
waves, with the authoring rules inline).

## Inputs & outputs

- **In:** a rite id whose ghosts are readable, plus `$API_BASE`/`$AUTH`/`$GH_CLIENT`/`$REPO_ROOT`
  from SKILL.md Phase 0.
- **Out:** `waves[]` (dry_run-`validated`) + the **guard bundle**:

```json
{
  "planning_base_sha": "<git sha>",
  "slug": "<kebab>",
  "edits": ["paths that exist at base"],
  "creates": ["paths that do not exist at base"],
  "planned_ghost_ids": ["uuid", "..."],
  "routed_out": [{"id": "...", "title": "...", "reason": "..."}],
  "human_gates": [{"ghost_id": "... or null", "title": "...", "position": "before-ship | after-wave <name>"}],
  "intra_set_bonds": [{"ghost": "...", "depends_on": "..."}],
  "has_backend_wave": true
}
```

## P1 — Read the rite

```bash
curl -s "$API_BASE/api/agent/rites/$RITE_ID/ghosts" -H "$AUTH" -H "$GH_CLIENT"
# per ghost:
curl -s "$API_BASE/api/agent/ghosts/$GID" -H "$AUTH" -H "$GH_CLIENT" > "ghost-${GID:0:8}.json"   # title + project_id + context_payload — P1c builds its recall bodies from these files
curl -s "$API_BASE/api/agent/ghosts/$GID/context" -H "$AUTH" -H "$GH_CLIENT"        # files, acceptance criteria
curl -s "$API_BASE/api/agent/ghosts/$GID/dependencies" -H "$AUTH" -H "$GH_CLIENT"   # [{depends_on_id, depends_on_title, depends_on_status}]
```

Exclude already-`exorcised` ghosts from planning (note them in the report). If ALL
are exorcised → nothing to plan, nothing to forge — report and stop. A ghost whose
context declares no `files` needs them derived: read its instructions and the repo,
propose the file set, and confirm with the user before it enters a wave.

## P1b — Ground (claims → anchors)

Everything P1 read is a **claim**, not a fact: `files`, `instructions` and
`acceptance_criteria` were written by whoever summoned the ghost, often without
opening the code. Rite 4's payloads shipped a subtree-flattening `UPDATE`, a
parity claim against an endpoint that did not exist, and "owner/admin + agent
parity" (a contradiction in that repo) — and Plan transcribed all three into
waves that passed `validatePlan` clean. Only reading the code catches this. So
before P2, for **every** ghost:

1. Read the repo's `CLAUDE.md`, `cfg '.implement.notes'`, and whatever manifest
   `CLAUDE.md` routes the ghost's area to.
2. Open **every declared file** and **every precedent the payload cites** — both
   halves of any "do it like X" parity claim.
3. For each **mechanism clause** — a SQL shape, an FK / cascade / lock, a role or
   permission, a precedent, a new query param, a new column, an event name —
   record ONE anchor in that wave's `grounding[]` (scratchpad `grounding.json`):

   ```json
   [{"wave": "hierarchy-service", "anchors": [
     {"path": "backend/app/repositories/document.py", "line": 24, "needle": "_LIST_COLUMNS",
      "claim": "list rows are a load_only projection — a new column joins this tuple or every list row raises MissingGreenlet"}
   ]}]
   ```

   `needle` is a verbatim identifier or snippet **from that line**, so an anchor
   is satisfied only by the line that really carries it — never by `README.md:1`.
   Anchors point at precedents that **exist at `PLAN_SHA`**; a path this plan
   creates (`creates[]`) cannot be anchored and is skipped by the check (and
   counted, so a wave of pure creates still needs an anchor into the code it
   builds on). `grounding.json` is a plan-time artifact: it never enters the
   ritual or the guard bundle.
4. A clause whose anchor **contradicts** it is rewritten NOW, and the ghost's
   payload is corrected in the tracker (`PUT /api/agent/ghosts/{id}`) before P2 —
   Gather-born errors do not get transcribed into waves.
5. Every projection, allowlist, action→event map, or test file the anchors reveal
   **joins that wave's owned files** — that is where the "13 filters silently
   dropped" class of miss lives.
6. **Readers of every changed contract, not just its callers.** Step 5 finds the
   files; this finds the values. For each contract a wave changes — a response
   shape, a return type, an event payload, a cache/placeholder behavior — enumerate
   who READS it downstream. Grep for what exists at `PLAN_SHA` (the route path, the
   old key, the held object's fields), never the new name: a grep for a key the wave
   introduces finds nothing, and a run over only the wave's own tests stays green.
   The two readers that get missed:
   - **Exact-equality assertions** on the old shape (`resp.json() == {…}`,
     `toEqual({…})`, snapshots) anywhere in the suite. The test file joins the owned
     files (step 5), or the ownership check stops the wave over a four-line fix.
   - **Sibling fields on a held object.** Holding stale data (`keepPreviousData`, a
     placeholder, an optimistic cache) holds *everything* on it — `total`, counts,
     cursors — not just the rows the plan reasoned about. Grep the field itself, not
     the first usage pattern you find: rite 429a9580's `pagination.total` reached a
     confirm through a shared helper AND a second hand-written handler on each page,
     and a grep for the helper's expression found half of them.

   Record each reader as an anchor whose `claim` names what the value gates. A
   reader that feeds a **destructive or irreversible** action — a confirm dialog's
   count, a cap pre-check, a mutation payload — makes its file owned, and the
   implementer prompt says exactly what must stay correct. "Acceptable staleness" is
   ruled per reader, never per contract. (Rite 429a9580 escalated twice on this
   class: a response-shape change broke four exact-equality assertions in a file no
   wave owned, and `keepPreviousData` held a previous filter's `pagination.total`
   into a bulk-cancel confirm.)
7. Inside implementer prompts, cite `path` + identifier rather than `path:line`:
   line numbers rot across serial waves (rite 4's wave 3 cited
   `agent_api.py:2442` after wave 2 had rewritten that file).

**Anchor check** — run before P5 and again after any P6 rewrite. It resolves
every anchor at `PLAN_SHA`, prints the source line beside each claim, and
**exits 3** if any anchor is empty, any needle is missing from its line, or any
wave has zero anchors. Paste its output into the P6 panel scratchpad under
`## Grounding`, so the lenses review each claim beside the code it rests on.

```bash
# NOTE: the loop variable is `apath`, NOT `path`. In zsh `$path` is tied to `$PATH`, so
# `read -r ... path ...` WIPES PATH on the first iteration; `sed`/`grep` then vanish and
# EVERY anchor falsely reports "no such line at PLAN_SHA" — a tooling failure that reads
# exactly like a total grounding failure. `fpath` is special too; do not use it either.
# P1b anchor check — needs $REPO_ROOT, $PLAN_SHA (P4), $CREATES (the guard bundle's creates[],
# one path per line) and grounding.json. `done < <(...)`, not a pipe, so RC survives the loop.
RC=0; N=0
while IFS=$'\t' read -r wave apath line needle claim; do
  if [ -z "$apath" ]; then echo "FAIL  $wave  — zero anchors"; RC=3; continue; fi
  if printf '%s\n' "$CREATES" | grep -qxF -- "$apath"; then echo "skip  $wave  $apath (created by this plan)"; continue; fi
  N=$((N+1))
  src=$(git -C "$REPO_ROOT" show "$PLAN_SHA:$apath" 2>/dev/null | sed -n "${line}p")
  if [ -z "$src" ]; then echo "FAIL  $wave  $apath:$line  (no such line at $PLAN_SHA)  — $claim"; RC=3
  elif ! printf '%s\n' "$src" | grep -qF -- "$needle"; then echo "FAIL  $wave  $apath:$line  needle '$needle' is not on that line  — $claim"; printf '      │ %s\n' "$src"; RC=3
  else printf 'ok    %s  %s:%s  %s\n      │ %s\n' "$wave" "$apath" "$line" "$claim" "$src"; fi
done < <(jq -r '.[] | .wave as $w | (.anchors // []) | if length == 0 then [$w, "", "", "", ""] else .[] | [$w, .path, (.line|tostring), .needle, .claim] end | @tsv' grounding.json)
echo "anchors resolved: $N (exit $RC)"; exit $RC
```

The exit code proves anchor **existence** at `PLAN_SHA` — a real line with that
identifier backs each claim. It cannot prove the planner *understood* the line:
coverage ("every mechanism clause has an anchor") stays prose, and that is the
honest limit. Roughly a third of rite 4's blockers were in the class this
closes; the rest still needed the panel.

## P1c — Recall (the Coven's memory, before the waves exist)

P1b grounds the plan in the **code**. This grounds it in what the Coven has already
**learned** — and it is a separate step because the two fail differently: P1b catches a
payload that misdescribes the repo, P1c catches a plan that repeats a mistake this repo
already paid for.

The planner is the only actor that can act on a whole class of Imprint. "Declare
`frontend/src/lib/actionRegistry.js` in the wave's owned files **and** add the frontend
suite to its `gate_cmds`" is an instruction to *whoever authors the wave* — no implementer
can amend its own declared files at runtime, and no reviewer can add a gate after the fact.
Imprint `9e59b78d` said exactly that, was written by the wave that learned it, and was
recalled by none of the waves that needed it. A rite that skips this step re-learns it.

1. For **each distinct Haunting** across the rite's ghosts, recall on **both axes** — the
   same two calls the engine and `commence-haunt` make, for the same reason (ts_rank has no
   IDF, so a merged query lets generic title words outrank the one rare mechanism term):

   ```bash
   # FEATURE axis: the ghosts' title words. MECHANISM axis: the identifiers and paths in
   # their context payloads. Never merged. An axis with no terms is not called at all --
   # the server maps an empty query to None and returns the NEWEST imprints at match 1.0.
   #
   # Run this block ONCE PER HAUNTING (H8 = the first 8 chars of that Haunting's id; the ghost
   # files are the P1 saves, ghost-<id8>.json = the first 8 chars of each ghost id). Every output
   # is suffixed with $H8 so the second Haunting never overwrites the first. The bodies come from
   # ONE synthetic ghost per Haunting: its title is the Haunting's unique lowercase title words
   # capped with the same 500-char reduce the mechanism jq uses (the pinned feature jq has NO cap
   # and the server 422s over 500 -- 6 raw titles measured 490), its files the union of the ghosts'
   # context_payload.files (non-arrays ignored), its project_id the Haunting. The two jq lines are
   # commence-haunt Phase 1a's, byte for byte -- copy them with sed, never retype
   # (backend/tests/test_client_contract.py pins them equal).
   H8=<haunting8>; HID=<haunting id>
   GHOST_JSON="recall-ghost.$H8.json"
   jq -s --arg pid "$HID" '{id: $pid, title: ([.[].title | scan("[[:alnum:]]{2,}")] | map(ascii_downcase) | unique | reduce .[] as $w ([]; if ((. + [$w]) | join(" OR ") | length) <= 500 then . + [$w] else . end) | join(" ")), context_payload: {files: ([.[] | .context_payload.files? | arrays | .[]] | unique)}, project_id: $pid}' ghost-<id8>.json ghost-<id8>.json > "$GHOST_JSON"
   FEATURE_BODY=$(jq '{query: ([.title | scan("[[:alnum:]]{2,}")] | map(ascii_downcase) | unique | join(" OR ")), project_id: .project_id}' "$GHOST_JSON")
   MECH_BODY=$(jq '{query: (([.title | scan("[[:alnum:]]{2,}")] | map(ascii_downcase) | unique) as $feat | [(.context_payload // {}) | if (.files? | type) == "array" then (.files[] | tostring) else (tostring | scan("[A-Za-z0-9]+_[A-Za-z0-9_]+|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+")) end] | map(split("/") | (.[-1] | sub("\\.[^.]*$";"")) as $s | (if ($s | ascii_downcase | test("^(index|main|init|app|mod|types|utils|helpers|constants)$")) then ((.[-2] // "") + " " + $s) else $s end)) | map(gsub("(?<a>[a-z0-9])(?<b>[A-Z])";"\(.a) \(.b)") | ascii_downcase) | map(scan("[a-z0-9]+")) | map(select(length >= 3)) | map(. as $w | select((["js","jsx","ts","tsx","mjs","cjs","py","md","mdx","json","sh","bash","yml","yaml","toml","ini","sql","css","scss","html","txt","test","tests","spec","specs","and","not"] | index($w)) == null and ($feat | index($w)) == null)) | unique | reduce .[] as $w ([]; if ((. + [$w]) | join(" OR ") | length) <= 500 then . + [$w] else . end) | join(" OR ")), project_id: .project_id}' "$GHOST_JSON")
   : > "recall-feature.$H8.json"; : > "recall-mech.$H8.json"
   if [ -n "$(printf '%s' "$FEATURE_BODY" | jq -r .query)" ]; then
     FEATURE_CODE=$(curl -s -X POST "$API_BASE/api/agent/imprints/recall" -H "$AUTH" -H "$GH_CLIENT" \
       -H "Content-Type: application/json" -d "$FEATURE_BODY" -o "recall-feature.$H8.json" -w '%{http_code}' || echo 000)
   else FEATURE_CODE=skipped; fi
   if [ -n "$(printf '%s' "$MECH_BODY" | jq -r .query)" ]; then
     MECH_CODE=$(curl -s -X POST "$API_BASE/api/agent/imprints/recall" -H "$AUTH" -H "$GH_CLIENT" \
       -H "Content-Type: application/json" -d "$MECH_BODY" -o "recall-mech.$H8.json" -w '%{http_code}' || echo 000)
   else MECH_CODE=skipped; fi
   # A non-2xx (or a 000 transport failure) is NOT an empty Coven: a failed recall is not a clean
   # slate -- it is keyed on the CODE, never on file size, it neutralises the body so an HTML 5xx
   # cannot poison the merge, and it fails the gate (exit 3) like the imprint check below.
   RC=0
   for axis in feature mechanism; do
     code=$FEATURE_CODE; f="recall-feature.$H8.json"; [ "$axis" = mechanism ] && { code=$MECH_CODE; f="recall-mech.$H8.json"; }
     case "$code" in skipped|2??) ;; *) echo "RECALL FAILED ($axis axis, Haunting $H8, HTTP $code): $(head -c 200 "$f")"; : > "$f"; RC=3;; esac
   done
   [ "$RC" = 0 ] || exit $RC
   jq -s '{items: (map(select((.items | type) == "array") | .items) | add // [] | unique_by(.id))}' "recall-feature.$H8.json" "recall-mech.$H8.json" > "recall.$H8.json"
   # After the LAST Haunting: one recall.json for the imprint check and the panel.
   jq -s '{items: (map(.items // []) | add // [] | unique_by(.id)), acknowledged_imprints: []}' recall.*.json > recall.json
   jq -e '.items | type == "array"' recall.json >/dev/null || { echo "P1c: recall.json is not a recall result"; exit 3; }
   ```

   `/invoke-ritual --dry-run` prints the exact `recall_queries` the engine will post per
   wave; once waves exist, prefer those strings over hand-built ones.
2. **Read every hit before P2.** A `gotcha` here changes wave grouping, owned files and
   gates — all three are decided in P2/P3 and are expensive to revisit after P4.
3. An Imprint you deliberately do **not** act on goes in `recall.json`'s top-level
   `acknowledged_imprints: [{"id": "<uuid>", "reason": "…"}]` **with a reason** (`recall.json` is
   a plan-time artifact — it never enters the guard bundle; the check below reads ids from it, and
   accepts bare id strings too). Copy the same list into the guard bundle for the record if you
   like, but the CHECK reads `recall.json`. Acknowledging is cheap and auditable; ignoring is not.

**Imprint check** — run before P5 and again after any P6 rewrite. Every recalled Imprint
that names a file which **exists at `PLAN_SHA`** must have that file in some wave's declared
set, or be acknowledged; and a wave that owns a frontend path must run the frontend suite.
**Exits 3** otherwise. Paste its output into the P6 panel scratchpad under `## Recall`.

```bash
# NOTE: the loop variable is `apath`, NOT `path`. In zsh `$path` is tied to `$PATH`, so
# `read -r ... path ...` WIPES PATH on the first iteration; `sed`/`grep` then vanish and
# EVERY anchor falsely reports "no such line at PLAN_SHA" — a tooling failure that reads
# exactly like a total grounding failure. `fpath` is special too; do not use it either.
# P1c imprint check — needs $REPO_ROOT, $PLAN_SHA (P4), recall.json and waves.json.
# `done < <(...)`, not a pipe, so RC survives the loop.
RC=0; N=0
DECLARED=$(jq -r '[.[] | ((.ghosts // [])[].files // [])[], ((.implementers // [])[].files // [])[]] | unique[]' waves.json)
ACK=$(jq -r '(.acknowledged_imprints // [])[] | if type == "object" then .id else . end' recall.json)
jq -e '.items | type == "array"' recall.json >/dev/null 2>&1 || { echo "FAIL  recall.json is not a recall result (a failed or skipped P1c is not a clean slate)"; exit 3; }
FE=$(cfg '.tests.frontend'); FEDIR=$(cfg '.paths.frontend // "frontend/"')
while IFS=$'\t' read -r id apath; do
  if printf '%s\n' "$ACK" | grep -qxF -- "$id"; then echo "ack   ${id:0:8}  $apath (acknowledged)"; continue; fi
  git -C "$REPO_ROOT" cat-file -e "$PLAN_SHA:$apath" 2>/dev/null || { echo "skip  ${id:0:8}  $apath (not a file at $PLAN_SHA)"; continue; }
  N=$((N+1))
  if printf '%s\n' "$DECLARED" | grep -qxF -- "$apath"; then echo "ok    ${id:0:8}  $apath is declared"
  else echo "FAIL  ${id:0:8}  names $apath, which EXISTS at $PLAN_SHA and NO wave declares it — declare it, or add the imprint id to acknowledged_imprints[] with a reason"; RC=3; fi
done < <(jq -r '.items[]? as $i | ((($i.title // "") + " " + ($i.content // "")) | [scan("[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]*[A-Za-z0-9_-]\\.[A-Za-z0-9]+")] | unique[]) as $p | [$i.id, $p] | @tsv' recall.json)
# The other half of 9e59b78d: owning a frontend file on a wave that never runs the frontend
# suite is how a wave dies AFTER a full build. Declaring the file is not enough.
while IFS=$'\t' read -r wave apath gates; do
  case "$apath" in
    "$FEDIR"*) N=$((N+1)); case "$gates" in *"$FE"*) echo "ok    $wave owns $apath and runs $FE";; *) echo "FAIL  $wave owns frontend path $apath but its gate_cmds never run '$FE' — it would ship with zero frontend gates"; RC=3;; esac ;;
  esac
done < <(jq -r '.[] | . as $w | [((.ghosts // [])[].files // [])[], ((.implementers // [])[].files // [])[]] | unique[] | [$w.name, ., (($w.gate_cmds // []) | join(" "))] | @tsv' waves.json)
echo "imprint claims checked: $N (exit $RC)"; exit $RC
```

The exit code proves a recalled Imprint's **named files are owned** and that a frontend file
is **gated**. It cannot prove the plan understood the Imprint's reasoning — that stays prose,
and stays the panel's job in P6. It is the half that was silently skipped for three releases.

## P2 — Classification (iterate to FIXPOINT)

Sort every unexorcised ghost into exactly one bucket. **After ANY route-out,
re-evaluate the remaining ghosts** — removing a ghost can turn a sibling's in-set
dependency into an out-of-set one. Repeat until a full pass changes nothing.
(Cascade at plan time; the prep node's run-time re-check must never be the first
to discover it.)

1. **REFUSE OUT** (stays in the rite, out of this ritual; each with a reason):
   - Any Spirit Bond on an **out-of-set ghost that is not exorcised** — refusal
     names the blocker: *"`<title>` is blocked by `<dep_id>` `<dep title>`
     (<status>), which is outside this ritual's set."*
2. **BACKEND WAVES** (the backend track): ghosts whose declared paths touch
   `backend/` route into waves flagged **`backend: true`** — they get a
   runner-owned scratch Postgres (`{{db_url}}`), the engine-appended pg-smoke
   (when configured) + migration-gate gates, and the HARD ownership check
   (realized ⊆ declared). Within backend routing:
   - A **migration-producing ghost** (new/changed models, seed migrations) gets
     its **own wave** with **`migration: true`** and **exactly ONE implementer**
     (`validatePlan` enforces both). **Never declare paths under a migrations
     `versions/` directory** (e.g. `backend/migrations/versions/` or
     `backend/alembic/versions/`) — the revision number depends on the live head
     at build time; the runner detects the generated file at runtime and commits
     it under the primary ghost. Declare everything else the ghost touches
     normally.
   - Strip annotation suffixes like `" (NEW)"` from ghost-declared paths — the
     whitespace rule rejects them loudly at dry_run.
   - **Routing rule:** forged rites route backend work through rite-cadence
     backend waves. The `extermination` workflow is **DEPRECATED (sunsetting)** —
     it survives only for ad-hoc ghost sets outside a forged rite during the
     sunset; never route a forged rite's backend work to it.
3. **HUMAN GATE**: ghosts with no code files and human verbs (playtest / review /
   approve / sign off), or assigned to a hunter. Route to a ritual `human_task`
   node (Forge does the composition — see forging.md §5): record
   `{ghost_id, title, position}` in the guard bundle. Default position
   `before-ship`; use `after-wave <name>` only when bonds force work AFTER the
   gate (that forces a DAG-split — flag it).
4. **WAVES**: everything else (frontend/visual — unflagged).

**BE-before-FE ordering:** waves containing backend work sort before frontend
waves (frontend consumes the APIs the backend waves ship; intra-set bonds
usually force this anyway — make it explicit regardless).

## P3 — Wave grouping rules

- Within a wave, implementers' `files` are **pairwise DISJOINT** — that is what
  makes the shared worktree safe. A file two ghosts genuinely share is OWNED by
  exactly ONE implementer; the other implementer's prompt says explicitly
  *"do NOT touch `<file>` — the other implementer owns it; route your need through
  the module it exposes"* (the `generateDialogue.js` pattern in the example).
- Ghosts with overlapping file sets → same wave under one implementer, or
  separate waves.
- Files may repeat freely **across** waves — ownership is per wave, and serial
  waves see each other's commits. Never derive a cross-wave coupling ("wave 3
  owns `terminology.js`, so wave 4 must not touch it") from the intra-wave
  rule; rite 4's first plan did exactly that and invented a dependency.
- Intra-set Spirit Bonds → the dependency's ghost lands in a **strictly earlier
  wave** than the dependent's.
- **Fewest waves that the dependencies force.** Disjoint, dependency-free ghosts
  belong in ONE wave as parallel implementers — every extra wave costs a full
  gate run plus a full harden pass. Split waves only for intra-set bonds,
  file overlaps, or a deliberate isolation choice (say why).
- Waves need: unique `name` (kebab, short); `primary_ghost_id` ∈ the wave's ghost
  ids (it absorbs reconcile-sweep, runtime-detected migration, and harden
  commits); per ghost `{id, files, title, commit_message, commit_body:
  "Ghost: <uuid>"}`; per implementer `{label, files, prompt}` — the prompt is the
  full task spec (contract sections, behaviors, test expectations,
  edit-ONLY-these-files); non-empty `gate_cmds`. Use the repo's own test commands
  from `.ghost/config.json` (`.tests.frontend` / `.tests.backend`). House
  defaults (pipefail so the pipe can't mask the exit code) plus a targeted lint
  pass over the wave's owned source files — frontend wave:

  ```json
  "gate_cmds": [
    "bash -o pipefail -c '<tests.frontend> 2>&1 | tail -6'",
    "(cd frontend && npx eslint <the wave's owned src files>)"
  ]
  ```

  (e.g. `<tests.frontend>` = `./scripts/test.sh frontend`.) Backend wave
  (`backend: true` / `migration: true`) — `{{db_url}}` is a RUNNER-INJECTED
  placeholder for the wave's scratch Postgres (validatePlan requires it on
  backend waves, rejects it elsewhere); the engine auto-appends the repo's
  migration-gate (and pg-smoke when `.isolation.pg_smoke` is set) to every
  backend wave's effective gates, so do NOT declare those:

  ```json
  "gate_cmds": [
    "bash -o pipefail -c 'cd <WT> && DATABASE_URL={{db_url}} TIMEOUT_SECS=1500 <tests.backend> 2>&1 | tail -8'",
    "(cd <WT>/backend && venv/bin/python -m ruff check <the wave's owned backend files>)"
  ]
  ```

  (e.g. `<tests.backend>` = `./scripts/test.sh backend`. The backend pytest suite
  is often hermetic in-memory sqlite — the scratch DB is what migrate / seed /
  pg-smoke / reversibility exercise, not pytest.) Add byte-gate/art checks only
  if the contract names them. Optional per wave: `integration_gate_prompt`,
  `harden: {mode: "scoped"}`.
- **Every owned-file path is FULL repo-relative** (`frontend/src/...`) — the plan
  is baked verbatim into the ritual and the commit stage passes `--files` straight
  through from the worktree root; a bare basename is a bad pathspec that fails
  AFTER the build work is done.
- No path may contain whitespace (this is what rejects un-stripped `" (NEW)"`
  annotations). Backend paths require the wave's `backend: true` flag; paths under
  a migrations `versions/` directory are never declared anywhere (runtime-detected
  — see P2 step 2).
- Prompts executed verbatim tolerate no forks: an "either (a) or (b)" in an
  implementer prompt is nondeterministic UX — the PLAN picks, with exact copy
  strings where copy is the fix.

## P4 — Plan-time guards

Run these while authoring, not after:

```bash
git -C "$REPO_ROOT" fetch origin
PLAN_SHA=$(git -C "$REPO_ROOT" rev-parse origin/main)
# Split every declared path across all waves:
git -C "$REPO_ROOT" cat-file -e "$PLAN_SHA:<path>" 2>/dev/null  # exit 0 → edits[], else creates[]
```

- **Spirit-Bond guard** — already enforced at P2 fixpoint; the same check is baked
  into the prep node for run time (forging.md §2 guard f).
- **Base-SHA snapshot** — `PLAN_SHA` + the `edits[]`/`creates[]` split go into the
  guard bundle; the prep node re-asserts them at run time (forging.md §2 guards b–e).
- **Slug fixed here**: derive from the rite name — lowercase kebab, `[a-z0-9-]`,
  ≤20 chars, MUST match `^[a-z0-9][a-z0-9_-]{0,63}$` after the `prep_`/`run_`/
  `ship_` prefixes. Confirm it with the user. It drives worktree path, branch,
  and node ids everywhere — never derive it twice.
- **Backend DB slug**: rite-cadence derives its scratch-DB slug from the branch
  (`ext/<slug>` → `rc<slug>`), so if the plan has a backend/migration wave, the
  slug must survive `[^A-Za-z0-9_]` stripping non-empty (validatePlan R6). Note
  `has_backend_wave: true` in the guard bundle so the prep node adds the DB
  reachability guard (forging.md §2 guard 9).

- **Gate-red-at-base probe** — a gate command that is ALREADY red on the
  planning base is not a gate. Run every wave's `gate_cmds` at `PLAN_SHA` now,
  while the table can still be changed. rite-cadence will excuse *some* such
  gates at run time (see **Keep** below for the ones it will not), but an excused
  gate proves nothing about the wave, so the honest fix is to replace it here.
  This is the guard whose absence escalated rite 1a wave cb-ui **after a full
  green build**: `npm run lint` was red on `origin/main` for 175 inherited
  errors, a linter names no test ids, and nothing had ever run the command at the
  base.

  **Exit codes — three, and only 3 is a ruling surface:**
  `0` every probed gate is green at `PLAN_SHA` ·
  `3` at least one `GATE RED AT BASE` — rulings are owed (below) ·
  `2` the probe could not run, a gate could not run (124/126/127 or a signal), a
  gate is malformed, or the call was killed: fix the named line and re-run.
  **2 beats 3 — never rule on a 2.** The plan is ready when the FINAL run — after
  every Replace and Drop is written into `waves.json` — exits 0, or exits 3 and
  every `GATE RED AT BASE` line it still prints is listed in
  `gate_probe.kept_red`. A Replace is proven by its own line reading `ok` on that
  run, a Drop by its absence, and a knowingly-kept gate holds the exit at 3
  forever, which is expected. An `ONLY=` run's exit code speaks only for the
  gates it probed: the verdict is the UNION of the runs' lines.

```bash
# P4 gate probe — self-locating and self-contained: it assigns everything it reads.
# Run from ANYWHERE inside the repo (a worktree session is fine — it resolves the MAIN checkout
# and probes THAT), as ONE Bash call with an EXPLICIT timeout of 600000 ms:
#     WAVES=<absolute path to waves.json> bash <<'EOF' … EOF
# Treat a KILLED call as exit 2. If it is killed, re-run once per long gate with
# ONLY='<substring of that gate>' and record the union of the lines.
# The loop variable is `gcmd`, never `path`/`fpath` — in zsh those are tied to $PATH and assigning
# one wipes it mid-loop, after which every probe "fails" for want of a shell.
[ -n "${BASH_VERSION:-}" ] || { echo "SKIP  gate probe: run this block under bash"; exit 2; }
set -o pipefail
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "SKIP  gate probe: cwd $PWD is not inside the repo (or git < 2.31) — cd into the main checkout or any worktree of it; WAVES= carries the plan and may live anywhere"; exit 2; }
REPO_ROOT=$(dirname "$COMMON")
WAVES=${WAVES:-$PWD/waves.json}
ONLY=${ONLY:-}
[ -s "$WAVES" ] || { echo "SKIP  gate probe: no plan at $WAVES — pass WAVES=<absolute path to waves.json>"; exit 2; }
jq -e 'type == "array"' "$WAVES" >/dev/null 2>&1 || { echo "SKIP  gate probe: $WAVES is not a JSON array of waves (invalid JSON — a hand-written gate's inner quotes need escaping — or the whole plan object instead of its waves[])"; exit 2; }
git -C "$REPO_ROOT" fetch -q origin || { echo "SKIP  gate probe: cannot fetch origin — PLAN_SHA would be stale"; exit 2; }
PLAN_SHA=$(git -C "$REPO_ROOT" rev-parse origin/main 2>/dev/null) || { echo "SKIP  gate probe: cannot resolve origin/main"; exit 2; }
HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
# -uno: untracked files must NOT count. `.haunt-wt/` (any live worktree) and the planner's own
# scratch files are untracked, so a plain --porcelain makes EVERY checkout look dirty and the
# probe skips itself forever — exactly how this guard would otherwise ship dead.
DIRTY=$(git -C "$REPO_ROOT" status --porcelain -uno | head -1)
if [ "$HEAD_SHA" != "$PLAN_SHA" ] || [ -n "$DIRTY" ]; then
  echo "SKIP  gate probe: main checkout $REPO_ROOT is at ${HEAD_SHA:0:8} on $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)${DIRTY:+ (tracked files modified)}, not PLAN_SHA ${PLAN_SHA:0:8}"
  echo "      on main and merely lagging: git -C \"$REPO_ROOT\" pull --ff-only, then re-run — and note the base MOVED: re-split edits[]/creates[] and re-run P1b/P1c against the new PLAN_SHA."
  echo "      on another branch, or dirty: STOP and ask — this block never checks out or stashes."
  exit 2
fi
# A gate the engine can NEVER excuse (see the Keep ruling): the repo's own test commands.
CFG_J="$REPO_ROOT/.ghost/config.json"
SUITES=$(jq -r '[.tests.backend, .tests.frontend, .tests.all] | map(select(. != null and . != "")) | .[]' "$CFG_J" 2>/dev/null)
OUT=$(mktemp -t gateprobe.XXXXXX); trap 'rm -f "$OUT"' EXIT
export CI=1                     # vitest/npx/eslint go non-interactive
RC=0; PROBED=0; SKIPPED=0; RED=0; BROKEN=0; BAD=0; REACHED=0
while IFS= read -r gcmd; do
  # Counted on EVERY path below — it exists only to prove the loop saw every gate, so a `continue`
  # that forgets it turns a real verdict into a false "short count".
  REACHED=$((REACHED+1))
  [ -z "$gcmd" ] && { echo "MALFORMED gate (empty gate_cmd)"; BAD=$((BAD+1)); continue; }
  [ -n "$ONLY" ] && case "$gcmd" in *"$ONLY"*) ;; *) echo "skip  (ONLY=$ONLY)  $gcmd"; SKIPPED=$((SKIPPED+1)); continue;; esac
  # A gate still carrying a template placeholder cannot run anywhere — a PLAN defect, not a base.
  # Checked BEFORE the {{db_url}} skip: the shipped backend example carries both.
  case "$gcmd" in *'<WT>'*|*'<tests.'*|*'<the wave'*|*'<files this'*|*'<owned '*|*'<N>'*) echo "MALFORMED gate (unfilled placeholder): $gcmd"; BAD=$((BAD+1)); continue;; esac
  # A hardcoded run-time worktree path is wrong in waves.json regardless — the engine prefixes its
  # own `cd "${WT}" &&` at run time. Never silently rewritten: rewriting hid it, and a path that
  # differs only in case (macOS APFS) or belongs to another machine survived and read as a red base.
  case "$gcmd" in *"/.haunt-wt/"*) echo "MALFORMED gate (hardcoded worktree path — the engine supplies the worktree at run time): $gcmd"; BAD=$((BAD+1)); continue;; esac
  case "$gcmd" in *'{{db_url}}'*) echo "skip  (carries {{db_url}}: not probed here — the engine measures it at run time, and if it is tests.backend the test BASELINE runs it and escalates the rite before wave 0. Run it once by hand on the main checkout before P5.)  $gcmd"; SKIPPED=$((SKIPPED+1)); continue;; esac
  PROBED=$((PROBED+1))
  # </dev/null: without it `eval` inherits the loop's stdin (the process substitution) and an
  # interactive gate silently EATS the remaining gate lines.
  ( cd "$REPO_ROOT" && eval "$gcmd" ) </dev/null >"$OUT" 2>&1
  EC=$?
  IS_SUITE=""
  while IFS= read -r t; do t=${t#./}; [ -n "$t" ] && case "$gcmd" in *"$t"*) IS_SUITE=" — TEST SUITE: the engine never excuses a suite, so Keep is NOT an option";; esac; done <<< "$SUITES"
  if [ "$EC" -eq 0 ]; then echo "ok    $gcmd"
  elif [ "$EC" -ge 128 ] || [ "$EC" -eq 124 ] || [ "$EC" -eq 126 ] || [ "$EC" -eq 127 ]; then
    echo "GATE COULD NOT RUN: $gcmd (exit $EC — killed, missing, or not executable; a 127 here is usually PATH/nvm in this non-login shell rather than the gate itself. NOT a red base, and the engine never excuses it.)"
    tail -3 "$OUT" | sed 's/^/      │ /'; BROKEN=$((BROKEN+1))
  else
    echo "GATE RED AT BASE: $gcmd (exit $EC)$IS_SUITE"
    tail -3 "$OUT" | sed 's/^/      │ /'; RED=$((RED+1))
  fi
done < <(jq -r '[.[] | (.gate_cmds // [])[]] | unique[]' "$WAVES")
EXPECTED=$(jq -r '[.[] | (.gate_cmds // [])[]] | unique | length' "$WAVES")
# A gate that ate stdin ends the loop early; without this the summary reports a short count as success.
[ "$REACHED" -eq "$EXPECTED" ] || { echo "gate probe: only $REACHED of $EXPECTED gates reached — a gate consumed stdin or the loop died"; BROKEN=$((BROKEN+1)); }
[ -z "$ONLY" ] || [ "$PROBED" -gt 0 ] || { echo "gate probe: ONLY=$ONLY matched no gate — nothing was probed"; BAD=$((BAD+1)); }
[ "$RED" -gt 0 ] && RC=3
{ [ "$BROKEN" -eq 0 ] && [ "$BAD" -eq 0 ]; } || RC=2      # 2 beats 3: a partial run is not a ruling surface
echo "gate probe: $REACHED of $EXPECTED reached — $PROBED probed, $SKIPPED skipped, $RED red at base, $BROKEN could not run, $BAD malformed (exit $RC)"
exit $RC
```

**Exit 3 means a decision is owed, not that the plan is invalid.** For each
`GATE RED AT BASE` line, the user picks one — never the agent, silently:

- **Replace** (preferred) with a *differential* command measuring only the wave's
  own files. Measure the base count NOW and bake the number in as a literal — the
  gate string in `waves.json` has no shell to expand a variable later:
  ```bash
  N=$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/frontend" \
      && npx eslint -f json <owned files that EXIST at PLAN_SHA, relative to frontend/> \
      | jq '[.[].messages|length]|add // 0')
  ```
  (`waves.json` lists `frontend/src/x.jsx`; after the `cd` that is `src/x.jsx`.)
  The wave's `gate_cmd` is then:
  ```bash
  bash -o pipefail -c 'cd frontend && npx eslint --max-warnings 0 --no-error-on-unmatched-pattern <files this wave CREATES, relative to frontend/> && [ "$(npx eslint -f json <owned existing files, relative to frontend/> | jq "[.[].messages|length]|add // 0")" -le <N> ]'
  ```
  `--no-error-on-unmatched-pattern` is **load-bearing**: the created files do not
  exist on the untouched base, and without it eslint exits 2 there — the engine's
  probe would file this very gate as inherited-red and then excuse the wave's own
  lint errors after the build, manufacturing the exact hole the probe closes.
  A wave that creates no files drops the first clause; one that owns no existing
  files drops the `&& [ … ]` clause and the `N=` line. Never leave either list
  empty — an argument-less eslint lints the whole tree.
  A replacement gate MUST make its own line read `ok` when this block is re-run.
  The honest verdict for a wave is "no new messages in the files it owns", never "repo-wide green".
- **Drop** it — an always-red gate contributes nothing and costs a full build.
- **Keep** it knowingly — but ONLY for a gate the engine can actually excuse.
  **Not** the repo's test suite (`tests.backend` / `tests.frontend` / `tests.all`
  from `.ghost/config.json`): the engine never probes a suite and never excuses
  one, because a suite that exits nonzero while naming no test ids is a *broken*
  suite, and excusing it would ship a wave untested — a suite red at base is
  fixed on `main` before forging, full stop. **Not** an exit 124/126/127 or a
  signal death: a gate that never ran is never excused. For any other gate the
  engine excuses it at run time and the wave completes with an `inherited-red
  gate` warning in `completed[].warnings`, the ledger and the completion EVP —
  provided the engine's own probe still finds it red on the run-time base. A base
  that has since gone green makes a later red the wave's, which is correct.
  Choose this only when the command still has diagnostic value in the run log.

Record the outcome in the guard bundle — a kept gate with no recorded ruling is a
silent keep — and paste the probe output into the P6 panel scratchpad under
`## Gate probe`:
`gate_probe: {probed: N, kept_red: ["<cmd>"], replaced: ["<old> -> <new>"], dropped: ["<cmd>"]}`

## P5 — dry_run (the exit gate)

Validate through the engine's own validator — invoke the Workflow tool locally
(NO API call, no agents spawned; pure JS). Resolve the engine from the MAIN
checkout, exactly as `ghost-hunting-core:invoke-ritual` does, so a session
running in an `ext/*` worktree validates against the SAME engine that will later
execute the plan rather than that branch's last committed bundle:

```bash
ENGINE_ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
```

```
Workflow({
  scriptPath: "$ENGINE_ROOT/.claude/workflows/rite-cadence.js",
  args: {
    "worktree_path": "<REPO_ROOT>/.haunt-wt/<slug>",   // planned value — required arg, throws if absent; dry_run does no live checks
    "branch": "ext/<slug>",
    "contract_path": "<manifest path or ''>",
    "rite_id": "<rite uuid>",
    "dry_run": true,
    "waves": [ /* the full plan */ ]
  }
})
```

Expect `{status: "validated", issues: [], sequence: [...]}`. Print the `sequence`
lines to the user (backend/migration waves are tagged). Any `issues` → fix the
plan and re-run. **Forge is unreachable while `status` is `"invalid"`** — no
exceptions, including user-supplied wave plans and resumed drafts (re-validate
them in-session).

## P6 — Adversarial panel (proportional)

- **Mandatory** when the scope was freshly Gathered this session, the plan has
  ≥2 waves, or the plan contains a backend/migration wave. For a pre-reviewed rite
  with a 1-wave frontend plan, offer to skip — but a plan with any wave whose
  `grounding[]` is empty is **never** skip-eligible.
- Write the waves JSON + routing rationale (routed_out, human_gates, bonds) to a
  scratchpad file, with the P1b anchor-check output under `## Grounding`, and
  invoke `ghost-hunting-core:panel` on that path.
- **Model directive:** if THIS session runs on Opus, pass `reasoning-fable` in the
  panel args (imperative — do not re-derive). On Fable/other sessions, pass nothing.
- Address every CRITICAL/HIGH finding. If the waves changed, **re-run P5** (and
  the P1b anchor check). If blockers changed wave structure or file sets, re-run
  the panel with `staff-engineer` only on the revised plan (cap 2 cycles) — rite 4
  went from 5 single-implementer waves to 4 waves + a 2-implementer wave + a DAG
  split with nothing adversarial reading the result.
- Present the final wave table (wave → ghosts → files → gates, plus routed-out and
  human-gate lists) and get the user's explicit approval.

## P7 — Handoff

- `--plan-only`: STOP here. Print the wave table, the guard bundle, and the
  rendered prep guard block (forging.md §2) for inspection. **Persist nothing.**
- Otherwise: hand the waves + guard bundle to Forge **F1 immediately** (same
  conversational beat — the draft POST is the persistence; do not pause for input
  between P7 and F1).
