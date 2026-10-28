# Ritual Runner — API Contract

The implemented backend contract for the workflow engine (live source of
truth: `GET /api/agent/manifest`). All endpoints under agent auth:
`Authorization: Bearer $TALISMAN` (+ the Phase-0 `$GH_CLIENT` header).

**Architecture:** the backend is a STATE STORE. It never advances a run. You
(the runner) are the engine: claim → execute `ready_node_ids` → journal
transitions → pause on humans → resume via re-claim.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agent/covens/{org_id}/rituals?status=` | List rituals (default: consecrated). Items: `{id, name, description, status, version, node_count, last_run}` |
| GET | `/api/agent/rituals/{id}` | Full definition: `{nodes: [{id, type, name, config, position}], edges: [{source, target}], inputs: [{key, label, type, required, default}]}` |
| POST | `/api/agent/covens/{org_id}/rituals` | Author a ritual: `{name, description?, definition?}` → draft. Response carries the strict validation report |
| PUT | `/api/agent/rituals/{id}` | `{name?, description?, definition?, status?}`. Definition change bumps version; `status: "consecrated"` strict-validates (400 with node-anchored errors otherwise). Draft→consecrated→entombed |
| DELETE | `/api/agent/rituals/{id}` | Dispel. Past invocations preserved (`workflow_id` → null) |
| POST | `/api/agent/rituals/{id}/validate` | `{definition}` → `{errors: [{node_id, message}], warnings}`. Dry run, nothing saved. Preflight before consecrating |
| POST | `/api/agent/rituals/{id}/invocations` | `{inputs?, title?, claim?: bool, max_parallel?, exorcise_on?}` → InvocationDetail. `claim: true` = created already channeling, `claim_generation: 1` |
| POST | `/api/agent/invocations/ad-hoc` | `{task_ids: [uuid], mode: "sequential"\|"parallel", title?, claim?}` → server-generated ghost_task chain, `workflow_id: null`. Order = execution order. Parallel + intra-set Spirit Bonds → 400. Parallel forces `exorcise_on: run_complete` |
| GET | `/api/agent/covens/{org_id}/invocations?status=&workflow_id=&is_ad_hoc=` | Find work. `status` takes a comma list (`summoned,awaiting_hunter,channeling`). Items include `resumable` + `step_counts` |
| GET | `/api/agent/invocations/{id}` | **Re-read this at every scheduler pass.** Returns run + `steps[]` (each with live `ghost` summary) + `ready_node_ids` + `resumable` + `claim_generation` + `definition_snapshot` + `max_parallel` + `exorcise_on` |
| POST | `/api/agent/invocations/{id}/claim` | `{force?: bool}`. Atomic. 409 = another medium owns it. `force: true` takes over a `channeling` run stale ≥2h (ASK THE HUMAN FIRST). Every claim **increments claim_generation** |
| PUT | `/api/agent/invocations/{id}/steps/{node_id}` | `{status, output?, error?, task_id?, claim_generation}`. Omitted `output` = preserved; explicit `null` = cleared. Fulfilled steps can't restart here (409) — that's loop-back's job. `channeling → pending` allowed (orphan reset) |
| POST | `/api/agent/invocations/{id}/steps/{node_id}/loop-back` | `{feedback, claim_generation}`. ATOMIC: resets the gate's reset-set to pending (outputs preserved), increments the gate's `attempts`, stores feedback on the gate's output, **reopens exorcised bound ghosts in the set** (back to ether, unassigned) |
| POST | `/api/agent/invocations/{id}/steps/{node_id}/spawn-ghost` | `{haunting_id?, title?, description?, assignee_hunter_id?, priority?, claim_generation}`. Creates + links a ghost, step → awaiting_hunter, assignee gets a Whisper. IDEMPOTENT — safe to re-call |
| POST | `/api/agent/invocations/{id}/pause` | `{reason?, claim_generation}` → run awaiting_hunter. Exit your session after this |
| POST | `/api/agent/invocations/{id}/complete` | `{status: "fulfilled"\|"backfired", output?, error?, claim_generation}`. fulfilled 409s unless ALL steps are terminal |

Supervisor endpoints — un-fenced (no `claim_generation`), and available to
agents at `/api/agent/...` as well as humans, though the runner itself rarely
needs them: `POST /api/agent/invocations/{id}/steps/{node_id}/resolve`
(`{approved, note?}` — approve/reject a gate or mark a ghost-less human task
complete; sets the step fulfilled/backfired; a reject on a fail-mode gate
backfires the whole run server-side; unlike a hunter, an agent may resolve ANY
gate regardless of a configured `approver_hunter_id`) and `POST
/api/agent/invocations/{id}/cancel` (abandons the run; a claiming runner's next
write 409s). The human forms live at `/api/invocations/{id}/...`.

## Statuses

- Ritual: `draft` (editable, not invocable) → `consecrated` (invocable) →
  `entombed` (archived).
- Run: `summoned` (created, unclaimed) → `channeling` (you) → `awaiting_hunter`
  (paused) → `fulfilled` / `backfired` (retryable) / `abandoned` (cancelled).
- Step: `pending` / `channeling` / `awaiting_hunter` / `fulfilled` /
  `backfired` / `skipped`.

## The fencing rules (MUSTs)

1. **Claim exactly once per session.** The response's `claim_generation` is your
   write token; pass it on every mutation. Never re-claim mid-run — it would
   invalidate your own in-flight subagents' tokens.
2. **A 409 on any write means a newer session (or a cancel) owns the run. STOP
   writing immediately.** Degrade to EVPs + a final report; do not retry.
3. **Subagents journal their own step only** (channeling at start,
   fulfilled/backfired at finish), carrying your claim_generation. The parent
   owns run-level transitions, loop-backs, and reconciliation.
4. `attempts` on a gate step is the server-owned cycle counter — compare it
   against the node's `max_cycles`/`max_iterations` to decide `on_exhaust`.
5. `exorcise_on: run_complete` means ghost_task subagents must NOT exorcise
   their ghost at step end — the parent exorcises all of them at run
   completion. `step_complete` (sequential default) = exorcise per step.
