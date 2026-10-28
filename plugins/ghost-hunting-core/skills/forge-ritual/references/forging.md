# Forge — Waves → Consecrated Ritual

Bake a validated wave plan into a consecrated ritual DAG via the agent API.
Target shape = a 3-node, autonomous ritual: `prep → run (script_workflow
rite-cadence) → ship`. This file owns the node templates, the F0–F5 sequence,
and the human-gate recipes.

## 1. The DAG template

```json
{
  "schema_version": 1,
  "inputs": [],
  "nodes": [
    { "id": "prep_<s>", "type": "agent_task", "name": "Provision worktree + guards",
      "position": {"x": 80, "y": 200},
      "config": {"instructions": "<PREP TEMPLATE — §2>"} },
    { "id": "run_<s>", "type": "script_workflow", "name": "rite-cadence — <rite name>",
      "position": {"x": 340, "y": 200},
      "config": {"workflow_name": "rite-cadence",
                 "args": {"worktree_path": "<REPO_ROOT>/.haunt-wt/<slug>",
                          "branch": "ext/<slug>",
                          "contract_path": "<manifest path or ''>",
                          "rite_id": "<rite uuid>",
                          "waves": ["<the FULL validated waves array, inline>"]}} },
    { "id": "ship_<s>", "type": "agent_task", "name": "Push + open PR",
      "position": {"x": 600, "y": 200},
      "config": {"instructions": "<SHIP TEMPLATE — §3>"} }
  ],
  "edges": [
    {"source": "prep_<s>", "target": "run_<s>"},
    {"source": "run_<s>", "target": "ship_<s>"}
  ]
}
```

Constraints (assert at compose time, BEFORE any POST):

- Node ids match `^[a-z0-9][a-z0-9_-]{0,63}$`; `workflow_name` matches
  `^[a-z0-9][a-z0-9_-]*$`; `inputs` stays `[]` (fully baked — invoke-ritual
  asks nothing).
- `JSON.stringify(run node config.args)` **≤ 32768 bytes** and every agent_task
  `instructions` **≤ 10000 chars** (both server-validated). Overflow remedies IN
  ORDER: (1) externalize shared detail — point implementer prompts at ghost ids +
  `contract_path` sections, or move long file lists to a Scroll whose id the prep
  node fetches; (2) split into two run nodes (§5 DAG-split); (3) **never silently
  trim implementer prompts** — they ARE the wave contract.
- All paths absolute in args (`REPO_ROOT` from Phase 0); the ritual runs from
  whatever CWD the runner has.
- `workflow_name: "rite-cadence"` requires the host repo to vendor rite-cadence
  (`workflows.vendor` includes `"rite-cadence"`, then `ghost-hunting-core:ghost-sync`).
  If it isn't vendored, invoke-ritual backfires the script_workflow step — note
  this in the hand-off if the repo's config doesn't list it.

## 2. The PREP node template (run-time guards — load-bearing)

The engine cannot be changed, so the plan's staleness/dependency guards live in
the forged DAG and execute at RUN time. Fill from the guard bundle. The talisman
is read from the repo's `.env` at run time — **never embed a key in the stored
definition**. Forge substitutes `<WORKTREE_SCRIPT>` with the repo's
`.isolation.worktree_script`, and `<KEY_VAR>`/`<ENV_FILE>` with the Phase-0
resolved credential source.

```
You provision the worktree for the "<ritual name>" ritual (rite <rite_id>).
PLANNING SNAPSHOT: base <PLAN_SHA> (origin/main at plan time, <YYYY-MM-DD>).

GUARDS — run in order BEFORE provisioning; on any REFUSE set data.ok=false with the reason and do NOT provision:
1. git -C <REPO_ROOT> fetch origin
2. Ancestry: git -C <REPO_ROOT> merge-base --is-ancestor <PLAN_SHA> origin/main
   — fails → REFUSE "planning base not an ancestor of origin/main (history rewritten): replan with /forge-ritual --replan".
3. Drift count (WARN only): N=$(git -C <REPO_ROOT> rev-list --count <PLAN_SHA>..origin/main)
   — N > 30 → add "base drifted N commits since planning" to data.warnings. Never refuse on count alone.
4. Planned EDITS still exist: for EACH of [<edits[]>]:
   git -C <REPO_ROOT> cat-file -e origin/main:<path>
   — missing → REFUSE "planned edit target <path> no longer exists upstream: replan".
5. Planned CREATES still absent: for EACH of [<creates[]>]:
   git -C <REPO_ROOT> cat-file -e origin/main:<path>
   — EXISTS → REFUSE "planned create <path> now exists upstream: replan".
6. Planned-file drift: git -C <REPO_ROOT> diff --name-only <PLAN_SHA> origin/main -- <edits[] paths>
   — any output → REFUSE "these planned files changed upstream since planning: <list> — replan or explicitly re-forge".
7. Spirit-Bond re-check: TALISMAN=$(sed -n 's/^<KEY_VAR>=//p' <REPO_ROOT>/<ENV_FILE> | head -n 1 | tr -d '"[:space:]')
   — then, ONLY when .ghost/config.json names auth.prod.org_id (<ORG_ID>, first 8 hex uppercased = <ORG8>):
   [ -z "$TALISMAN" ] && TALISMAN=$(sed -n 's/^GHOST_HUNTING_API_KEY__<ORG8>=//p' "${XDG_CONFIG_HOME:-$HOME/.config}/ghost-hunting/.env" | head -n 1 | tr -d '"[:space:]')
   — otherwise (no org_id) the legacy last resort:
   [ -z "$TALISMAN" ] && TALISMAN=$(sed -n 's/^<KEY_VAR>=//p' "$HOME/.claude/.env" | head -n 1 | tr -d '"[:space:]')
   (the same order as the skills' Phase 0; never read ~/.config/ghost-hunting/.env by the bare <KEY_VAR>)
   For EACH planned ghost id in [<planned_ghost_ids[]>]:
     curl -s -H "Authorization: Bearer $TALISMAN" <API_BASE>/api/agent/ghosts/<id>/dependencies
   — any dependency whose depends_on_id is NOT in the planned set AND depends_on_status != "exorcised"
     → REFUSE "ghost <id> is blocked by out-of-set unexorcised <dep_id> <dep title>".
8. PRE-PROVISION SAFETY: if git -C <REPO_ROOT> rev-parse --verify ext/<slug> succeeds
   AND [ $(git -C <REPO_ROOT> rev-list --count origin/main..ext/<slug>) -gt 0 ]:
   - if origin/ext/<slug> exists AND [ $(git -C <REPO_ROOT> rev-list --count origin/ext/<slug>..ext/<slug>) -eq 0 ]
     → the commits all exist on the remote; WARN "reaping local ext/<slug> (fully pushed)" and continue.
   - else → REFUSE "branch ext/<slug> holds UNPUSHED commits from a prior run — --retry the old
     invocation, push/ship that branch, or explicitly confirm destruction first"
     (the worktree-provision script REAPS the worktree AND force-deletes the branch; unpushed
     commits exist nowhere else).
9. DB REACHABILITY (ONLY when the plan has a backend/migration wave — include this guard iff
   the guard bundle notes has_backend_wave): pg_isready -h 127.0.0.1 -p 5432 (or:
   psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc 'SELECT 1')
   — fails → REFUSE "Postgres is not reachable on 127.0.0.1:5432 — start it before invoking
   (the backend track's scratch DBs, migration gate, and reversibility all need it); wave 0
   would otherwise die mid-run at db-provision."

PROVISION (only if every guard passed):
  git -C <REPO_ROOT> fetch origin && <REPO_ROOT>/<WORKTREE_SCRIPT> provision <slug> origin/main
ASSERT: worktree exists at <REPO_ROOT>/.haunt-wt/<slug>; git -C it rev-parse --abbrev-ref HEAD == "ext/<slug>";
git -C it status --porcelain empty; frontend deps present inside it (the provision script builds them); AND
(backend rites only) backend/venv present inside it.
End with ONLY a fenced JSON block:
{"summary": "...", "data": {"worktree_path": "<REPO_ROOT>/.haunt-wt/<slug>", "branch": "ext/<slug>",
 "clean": true, "node_modules": true, "base_drift": N, "warnings": [...], "ok": true},
 "artifacts": {"branch": "ext/<slug>"}}
On any refusal: data.ok=false and the specific guard's reason in summary.
```

**Model note:** forged prep/ship `agent_task` nodes are **sonnet-safe** — they are
strict-contract guard/push steps with schema'd outputs and safe refusal failure
modes; the ghost-hunting-core:invoke-ritual runner picks the model at spawn time. (The heavy stages
inside the `script_workflow` node pin their own models in the engine.)

## 3. The SHIP node template

```
You ship the "<ritual name>" ritual (rite <rite_id>). rite-cadence has committed each ghost
to branch ext/<slug> in <REPO_ROOT>/.haunt-wt/<slug> but did NOT push or open a PR. From that worktree:
1. git -C <REPO_ROOT>/.haunt-wt/<slug> push -u --force-with-lease origin ext/<slug>
   (--force-with-lease covers a re-ship after a previously failed attempt; it never clobbers foreign work)
2. gh pr create --head ext/<slug> --base main --title "<PR title>" \
   --body "<one-line what shipped> (rite <rite_id>): <wave names>. Ghosts: <short ids>."
End with ONLY a fenced JSON block:
{"summary": "...", "data": {"pushed": true, "ok": true},
 "artifacts": {"branch": "ext/<slug>", "pr_url": "<url>"}}
artifacts.pr_url is MANDATORY on success — the runner's empty-ship guard keys on it.
If push or PR creation fails: data.ok=false with the error in summary.
```

## 4. The Forge sequence

- **F0 (draft resume only):** `GET /api/agent/rituals/{draft_id}` → extract
  `waves` from the run node's `config.args` → re-run the P5 dry_run locally →
  compare `planned_ghost_ids` vs the rite's CURRENT unexorcised ghosts. Mismatch
  or `invalid` → offer `--replan`; else continue at F2.
- **F1 Compose + persist:** fill the template; run the §1 size asserts;
  `POST $API_BASE/api/agent/covens/$ORG_ID/rituals` with
  `{"name": "<rite name> forge", "description": "rite:<rite_id> — forged by /forge-ritual <YYYY-MM-DD>; autonomous", "definition": {...}}`.
  Read the validation report in the response. Name collision (the coven enforces
  unique ritual names) → suffix ` (2)` and retry ONCE, then ask the user.
- **F2 Gates (conversational):** default is the autonomous 3-node — announce it.
  Insert/remove human gates only on request, per §5; each change is one
  `PUT {definition}`.
- **F3 Validate:** `POST /api/agent/rituals/{id}/validate` with body
  `{"definition": {...}}` (the definition you are validating — REQUIRED; the
  endpoint validates the POSTED definition, never the stored one, so a bodyless
  POST is a 422, not a validation result) → fix every `{node_id, message}` error
  → PUT → re-validate. Cap 3 cycles.
- **F4 Consecrate:** `PUT /api/agent/rituals/{id} {"status": "consecrated"}`
  (strict validation; 400 carries node-anchored errors) → fix → retry. Cap 3.
- **Cap-out (F3 or F4):** leave the draft AND persist the failure durably —
  append `  last-error: <YYYY-MM-DD> <one-line digest>` to the draft's
  `description` via PUT — then report with the resume hint
  (`/forge-ritual <rite>` finds the draft and resumes at F0).
- **F5 Report:** print the hand-off box (SKILL.md). **Never call any
  `/invocations` endpoint.** STOP.

Editing a consecrated ritual (verified live): `PUT {definition}` works directly
and bumps the version; prefer the **atomic** `PUT {"definition": ..., "status": "consecrated"}`
so strict validation always runs with the edit.

## 5. Human-gate recipes

**Insert before-ship** (the default position) — a `human_task` node between
`run_<s>` and `ship_<s>` (drop the run→ship edge, add run→gate→ship):

- Fresh gate (no existing ghost): `{"instructions": "<what to check + where>",
  "spawn_ghost": true, "title": "<gate title>", "priority": "moan",
  "haunting_id": "<haunting>", "assignee_hunter_id": "<hunter or cfg '.human_hunter_id'>"}`.
- **Existing human-gate ghost** (e.g. a PLAYTEST ghost classified at P2):
  `"spawn_ghost": false` — spawn_ghost:true would MINT A DUPLICATE at run time.
  Instructions: *"Play-test per ghost `<id>` (`<title>`). Exorcise that ghost,
  then Mark Complete on this step."*
- **Gate reviewability**: at the gate, all work is LOCAL commits on an unpushed
  `ext/<slug>`. The gate instructions MUST name the worktree path and the review
  range (`git -C <worktree> log <PLAN_SHA>..ext/<slug> --oneline`). Reject path:
  poltergeist the gate's ghost → the step backfires → the run backfires
  (retryable). For remote review, make the PRECEDING node push the branch sans PR.

**Mid-rite gate → DAG-split.** NEVER bake `stop_before` into a forged ritual:
rite-cadence returns `{status:"paused"}`, which the ghost-hunting-core:invoke-ritual runner journals
as **backfired**, and `--retry` replays the ORIGINAL args from wave 0.
(`stop_before` stays a manual, outside-a-ritual rite-cadence facility.) Instead:

1. dry_run the COMBINED wave list first (planning.md P5).
2. Split waves `[0..k-1]` → `run_<s>_a` and `[k..]` → `run_<s>_b` (same
   `worktree_path`/`branch`/`rite_id`), gate between them; edges
   prep → run_a → gate → run_b → ship (5 nodes — under the ~8-node ceiling).
3. dry_run EACH subset separately, and **assert the two subsets partition the
   combined ghost set** — `validatePlan` cannot see duplicates across nodes.

**Split-run recovery** (document in the gate EVP too): a backfired run node's
`--retry` replays its whole subset and rite-cadence's wave setup hard-requires a
clean tree — a build/gate escalation leaves the worktree DIRTY, so retry
insta-escalates until a human cleans it. Escape hatch: run rite-cadence directly
(`Workflow` tool) with `resume_from: "<wave>"` from the worktree, then resolve
the step via the supervisor endpoint.

**Removal** (`--remove-gates`): fetch the definition → drop the gate node(s) →
rewire each in-edge's source to each out-edge's target → atomic
`PUT {definition, status:"consecrated"}`. If the PUT is refused: demote
(`PUT {status:"draft"}`) → edit → re-consecrate; if that also fails, escalate to
the user offering DELETE + re-forge (past invocations survive deletion).

## 6. Update vs create

- Draft exists for the rite → resume it (F0); `--replan` PUTs a fresh definition
  over the SAME draft.
- Consecrated exists → nothing to forge; if the rite's unexorcised ghost set no
  longer matches the ritual's planned ghosts, offer a re-forge (Plan over the
  delta → atomic PUT → re-consecrated, version bumps).
- **Never a parallel second ritual for the same rite.**
