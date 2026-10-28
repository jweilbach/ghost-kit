# Node Execution Playbook

Per-type semantics for the Phase 4 scheduler. Read this at Phase 4 start.

## Output contract (all machine steps)

Step `output` JSON: `{"summary": "≤2000 chars human digest", "data": {machine
fields, ≤8KB}, "artifacts": {"branch"?, "files_changed"?, "pr_url"?,
"scroll_id"?}}`. Large content goes to a **Scroll** (create via the agent API)
and is passed by `scroll_id` — never inline big payloads.

## Context passing

- Downstream `agent_task` prompts get a **Workflow Context block**: run inputs
  (always) + direct parents' full `summary`+`data` (≤4KB each) + transitive
  ancestors' summaries one line each. Total budget ~24KB; overflow degrades to
  summaries-only. Always re-fetch outputs from the run detail at injection time
  (resume-safe) — never from session memory.
- `ghost_task` steps get NO upstream context by default (the ghost's own
  context_payload is its instruction source — keeps 8-ghost chains flat).
  Node config `include_upstream_context: true` opts in.
- Interpolate `{{inputs.<key>}}` in any node instruction text before use.

## ghost_task — `{task_id, instructions?}`

Execution: fill `references/ghost-lifecycle-prompt.md` (every `{PLACEHOLDER}`,
including `{GH_CLIENT}` = this session's `$GH_CLIENT` verbatim), launch as one
Agent subagent. The step's ghost link is intrinsic (`step.task_id`).

**Pre-execution derivation (MUST, before every spawn):** GET the bound ghost —
- `exorcised` → journal the step fulfilled yourself with
  `output {"summary": "ghost already exorcised outside this run", "data": {"ghost_id": ..., "external": true}}`.
  No subagent. (Loop-backs reopen ghosts server-side, so a reset ghost_task
  will NOT appear exorcised — feedback re-runs are automatic.)
- `poltergeist` → journal backfired with the ghost's latest EVP as error.
  NEVER silently re-claim a poltergeist — a prior executor declared it blocked;
  the human unblocks it, then `--retry`.
- `active_haunt` assigned to another medium → backfired, "claimed by another
  medium".
- else → execute normally.

**Orphaned `channeling` ghost_task step** (found at reconcile): stricter than
agent_task — repo+ghost mutations aren't idempotent. Ghost `exorcised` → the
subagent finished but journaling died; reconstruct-complete the step. Ghost
`poltergeist` → backfired. Ghost `active_haunt` under our talisman → journal
backfired: "orphaned mid-implementation — inspect the tree/branch, then
--retry"; do NOT blindly replay.

## agent_task — `{instructions, capabilities?, spawn_ghost?, haunting_id?, worktree?, include_upstream_context?}`

Model: forged prep/ship agent_task nodes (from `ghost-hunting-core:forge-ritual`)
are **sonnet-safe** — strict-contract guard/push steps with schema'd outputs and
safe refusal failure modes; pick the model at spawn time. Heavier bespoke
agent_tasks inherit the session model as before.

1. Parent PUTs nothing — the SUBAGENT self-journals (channeling first action,
   fulfilled/backfired last action, carrying the claim_generation). Prompt =
   connection block + step ids/generation + Workflow Context block + node
   instructions + the journaling contract + final-response contract:
   *"End with ONLY a fenced JSON block {summary, data?, artifacts?}."*
2. Worktree isolation per the wave rules (SKILL.md Phase 4). Worktree steps
   report their branch in `output.artifacts.branch` and never push/merge.
3. On return: verify the step was journaled (GET run detail); if the subagent
   died without journaling, journal it yourself from its final response — or
   backfired with the failure.
4. **Retry policy:** ONE automatic re-spawn on transient failure (no/garbled
   JSON, 5xx). FATAL classification — auth failures, out-of-credits, permission
   denials — fail fast, no retry, surface to the user.

## human_task — `{instructions, spawn_ghost=true, assignee_hunter_id?, title?, priority?, haunting_id?}`

- Assignee: node `assignee_hunter_id` first, else the repo config's
  `cfg '.human_hunter_id'`, else unassigned.
- `spawn_ghost: true` (default): `POST .../spawn-ghost` (idempotent; check
  `steps[].task_id` first anyway). Then post an EVP on the new ghost with the
  upstream summaries + "Exorcise this ghost to let the ritual proceed; resume
  with `/invoke-ritual --resume {RUN_ID}`." The endpoint already sets the step
  awaiting_hunter and notifies the assignee.
- `spawn_ghost: false` (lightweight ask — "review this PR"): PUT the step
  `awaiting_hunter` with `output {"summary": "<the instructions>"}` so the
  invocation view shows what's being asked. The hunter clicks Mark complete
  (resolve endpoint).
- Resume check (reconcile): linked ghost `exorcised` → PUT fulfilled with
  `output {"summary": "Human completed '<name>'", "data": {"ghost_id": ...,
  "human_notes": "<last human EVP content, if any>"}}` (the last EVP is the
  human's handoff downstream). Ghost `poltergeist` → backfired. Ghost-less
  steps resolve server-side — nothing to derive.

## approval_gate — `{prompt, approver_hunter_id?, on_reject}`

Step-record only, no ghost. PUT the step `awaiting_hunter` with
`output {"summary": "<the prompt + a 1-line digest of upstream results>"}`,
then the run pauses (Phase 5). Humans resolve in the UI. Resume: step
`fulfilled` (approved — note in output) → continue; step `backfired` or run
`backfired` (rejected, fail mode — server already backfired the run) → report;
gate reset to `pending` with feedback (rejected, loop_back_to mode — server
applied the loop-back) → the scheduler naturally re-runs the region.

## review_gate — `{instructions, target_node_id?, max_cycles=2, on_exhaust}`

1. Spawn an adversarial reviewer subagent (self-journals the gate step like an
   agent_task). Input: the target step's full output + Workflow Context + the
   node's instructions. Template stance: *"You are an adversarial reviewer. Be
   conservative — a blocker loops an expensive cycle. FAIL only on defects that
   matter."* Required final JSON: `{"verdict": "PASS"|"FAIL", "blockers": [],
   "concerns": [], "notes": ""}`.
2. **PASS** → subagent journals the gate fulfilled with the verdict in output
   (concerns ride downstream as context).
3. **FAIL and `attempts` < max_cycles** → the PARENT calls the atomic
   `loop-back` endpoint with the blockers as feedback. Done — the server resets
   the region, bumps attempts, reopens ghosts. The scheduler re-reaches the
   target with `{REVIEW_FEEDBACK_BLOCK}` filled from the gate's stored
   feedback, then re-reviews.
4. **FAIL at cap** → `on_exhaust`:
   - `escalate_human` (default): PUT the gate `awaiting_hunter` with
     `output {"summary": "Review exhausted after N cycles", "data": {"blockers": [...]}}`.
     Humans force-pass or fail it in the UI.
   - `fail`: PUT the gate backfired → run backfired (Phase 4 failure path).

## loop — `{target_node_id, condition, max_iterations=3, on_exhaust}`

When ready (its subgraph completed), spawn a small evaluator subagent:
condition + the subgraph's outputs → `{"done": bool, "verdict": "..."}`.
- done → journal the loop step fulfilled (iteration history in output).
- not done + `attempts` < max_iterations → parent calls `loop-back` with the
  verdict as feedback.
- exhausted → `on_exhaust`, same shapes as review_gate.

## Codex execution of script workflows

In Codex, write the step's args as JSON and call `.ghost/bin/run-workflow
--workflow <absolute-engine-path> --args-file <path>`. Keep the engine-root,
freshness, journaling, and returned-sentinel checks below. The runner invokes
Codex children and applies host model mappings; do not launch Claude.

## script_workflow — `{workflow_name, args, description?}`

The extermination bridge: the ritual stores the plan; a Workflow-tool script
vendored into the HOST repo is the engine, rendered by
`ghost-hunting-core:ghost-sync` from the plugin's templates (per the repo
config's `workflows.vendor` list).

**Resolve the engine from the MAIN checkout, never from CWD.** A relative
`scriptPath` resolves against the runner's working directory — and when that is
an `ext/*` worktree, it loads the bundle `main` last *committed* to that
branch, not the freshly synced one. This has already nearly executed a stale
engine on a resume leg.

1. **Pin `ENGINE_ROOT`,** then verify the file exists there:
   ```bash
   ENGINE_ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
   ```
   In a worktree this yields the main checkout; in the main tree it is a no-op.
   **Refuse loudly** (PUT the step backfired, no retry) if any of these hold —
   never silently fall back to a relative path:
   - `ENGINE_ROOT` is empty or not absolute. `--path-format` requires git ≥2.31;
     on older git the substitution is empty and `dirname ""` returns `.`, which
     restores the exact CWD-relative bug this step exists to prevent.
   - `ENGINE_ROOT` contains `.git/modules/` (submodule layout — the main
     checkout is not `dirname` of the common dir there).
   - `$ENGINE_ROOT/.claude/workflows/{workflow_name}.js` does not exist. If the
     repo's `.ghost/config.json` lists it under `workflows.vendor`, tell the
     user to run `ghost-hunting-core:ghost-sync`, **commit**, then `--retry`.
2. **Verify freshness from the file's own stamp — fail closed.** Read the
   vendored header (`// vendored from ghost-kit/ghost-hunting-core vX (bundle B)
   — DO NOT EDIT`) and compare it against `$ENGINE_ROOT/.ghost/sync-state.json`
   (`plugin_version`, `bundle`). Mismatch → backfire the step naming both
   stamps and the **direction** of drift, and stop.
   - Do this **only for `{workflow_name}`** — a stale deprecated `ghost-lane.js`
     must not refuse an unrelated rite-cadence run.
   - Use the header/sync-state comparison, **not**
     `render-workflows.sh --check`. That script resolves ghost-kit through
     `known_marketplaces.json` to the plugin's live working tree, so any
     in-progress template edit would refuse every ritual in every consumer repo;
     and with no marketplace installed (cloud/CI) it cannot run at all, breaking
     the property that committed `.js` files work standalone.
   - If the stamps cannot be read at all, that is **not** a pass: backfire with
     `engine_freshness_unverifiable` rather than proceeding.
3. Interpolate `{{inputs.*}}` into `args` values.
4. **Pin the child engine too.** `rite-cadence.js` resolves its `harden` child
   by plain *name* unless told otherwise, which leaves the same staleness hole
   one level down. Pass it explicitly:
   `args.harden_script = "$ENGINE_ROOT/.claude/workflows/harden.js"` (when that
   file exists).
5. **If you need a DERIVED engine** (model override, debug instrumentation),
   never copy "whatever engine is nearest" — in a worktree that is the stale one,
   which is the failure this whole section exists to prevent. Derive only from a
   file you have already resolved and freshness-verified in steps 1-2: copy that
   exact file, assert the diff against it is only the delta you intended, log
   BOTH stamps (canonical and derived), and pin the child by absolute path.
   Prefer a supported input over a derived file whenever one exists —
   `rite-cadence` takes `args.model_overrides` (e.g. `{fable: "opus"}`) precisely
   so that a quota problem never becomes a reason to fork the engine.
6. PUT the step `channeling`, **log the resolved absolute path and bundle
   stamp**, then invoke via the **Workflow tool**:
   `Workflow({scriptPath: "$ENGINE_ROOT/.claude/workflows/{workflow_name}.js", args: {...}})`.
   A multi-hour script is simply a long channeling step; its internal machinery
   (worktrees, collation) is opaque to the ritual by design. Repeat the path and
   bundle stamp in any resume payload you report — a concurrent `/ghost-sync`
   can swap the engine between a run and its resume leg, and the stamp is the
   only way that becomes visible.
7. On return → **INSPECT the returned object before journaling.** The bridged
   workflows (`extermination.js`, `rite-cadence.js`) signal failure by RETURNING
   a sentinel, not by throwing — so "the Workflow tool did not throw" is NOT
   success. PUT the step **backfired** (never fulfill), error = the sentinel's
   `stage`/`phase`/`reason`, when the return matches any:
   - `{aborted: true}` — extermination bailed (resolve/analyze/gate/collate).
   - `{status: "escalated"}` or `{status: "paused"}` — rite-cadence hit a
     build/gate escalation or a gate-stop with humans/fixes still owed.
   - `{status: "invalid"}` — a `dry_run` plan-validation that failed
     (`issues[]` non-empty).
   A thrown error → PUT backfired with its message (unchanged).
   **On any backfired/escalated return, name the TRUE cause from the harness log, not just the
   sentinel.** The engine collapses every subagent death to `null` before it can see why, so a
   stall (host asleep → the per-agent stall watchdog fires after 180s of no stream progress, 5
   retries) and a quota death (`You've hit your session limit`) both surface as a bare failed
   stage. The cause is in the Workflow harness's own record, which the engine cannot read (no fs)
   but you can: read the `<output-file>` handed to you in the task-notification (else glob
   `ls -t ~/.claude/projects/<cwd-slug>/*/workflows/<runId>.json | head -1`, confirming
   `workflowName`/`args`) and grep its `logs`/`workflowProgress` for `[stall] agent "…" stalled`
   (a slept/hung host) vs `[…] failed: <apiError>` (quota/API). rite-cadence now also relays
   harden's own `fixer_death_reason`/`gate_death_reason` in the escalation `reason`. Put the true
   cause in the report. **If it is a stall: the host almost certainly went to sleep mid-run** — a
   long Workflow on a sleeping laptop cannot make progress and its longest stages (harden's fixer
   and gate) get orphaned. Keep the host awake for multi-hour runs (`caffeinate -i`, verify with
   `pmset -g assertions | grep caffeinate`; lid-close still sleeps). This is operator guidance,
   not something the skill automates.
   **A `complete` run can still carry warnings.** rite-cadence returns `warnings[]` (today: a wave
   whose ghosts are committed in git but were never closed in the tracker, and a wave whose
   memory writeback failed or was replayed) and `skipped_capabilities[]` (a wave that ran with
   no secret scan, no Postgres smoke gate, or no reversibility proof). If either is non-empty,
   journal the step fulfilled but put them VERBATIM at the top of `output.summary` and say so in
   the report — a green box over "the tracker does not reflect this committed wave" is the
   tracker lying, which is the one thing this product must never do. Likewise surface
   `parked.patch_path` when present: that is where an escalated wave's uncommitted work went,
   and a human needs the path to decide whether to `git apply` it.

   Otherwise it's genuine success (incl. a `dry_run` `{status:"validated"}`) →
   PUT fulfilled with `output.summary` = a digest of the return (full result to
   a Scroll if large, via `artifacts.scroll_id`); lift any PR url into
   `output.artifacts.pr_url`. **Empty-ship guard (advisory):** for a NON-dry-run
   ship expected to produce a PR (extermination, or a rite-cadence ship step)
   that returns success but carries no `pr_url`/`branch`, WARN and confirm with
   the user before continuing — a run that shipped nothing must not silently
   read as done. (A `dry_run` legitimately has none — never flag it.)

## Wave rules (Phase 4)

- READY frontier = the server's `ready_node_ids`, minus human-shaped nodes
  (those get spawned/parked immediately, never block machine work).
- Gate mechanics FIRST (review verdict handling, loop evaluation, loop-backs) —
  they mutate the frontier.
- Launch up to `max_parallel` machine steps as Agent calls IN ONE MESSAGE.
  Worktree isolation for every file-touching step when the launched wave has
  ≥2 of them; a solo step runs in the main tree.
- **Dependent-wave guard:** never launch a file-touching step whose ancestor's
  work sits on an unmerged `ritual/*` branch — warn and ask the user (merge it,
  or continue anyway). Until collation lands, parallel branches are merged by
  the human; the final report prints exact merge commands.
- **Drain before terminal:** collect every wave subagent's result and verify
  its journaling BEFORE any run-level transition. On a 409 anywhere: STOP,
  degrade to EVPs + report.
