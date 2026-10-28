# Instruments

Deterministic P0 measures, taken before agents read code.

```
scripts/reckoning-instruments.sh --tree <TREE> --out <RUN>/instruments [--only a,b] [--snapshot <RUN>/snapshot]
```

Each writes `<name>.json` (tmp → mv): `{name, status, reason, sha, config_source, data}`; it prints `data.summary`. `--out` must be outside the tree. Exit 0 unless the usage is wrong (2).

Env: `RECKONING_API_BASE`, `RECKONING_AUTH` (full `Authorization: Bearer …` line; never printed or passed on), `RECKONING_CLIENT` (full `X-Ghost-Client: …` line). `RECKONING_INSTRUMENTS_CONFIG=<file.json>` replaces the config block (try before committing).

## Honest status

- `ok` — measured. `reason` names any skipped sub-measure.
- `skipped` — a tool or config is missing; the primary measure was not taken. Not evidence of health.
- `failed` — the run crashed, was killed or failed its self-check; `data` is partial.

Never read `skipped`/`failed` as "no problem": write "not measured".

## Config: `.reckoning.instruments` (defaults in parentheses)

- **churn:** `churn.since_days` (180), `.top` (40), `.exclude` (globs).
- **ui-bypass:** `ui_bypass.src` (`frontend/src`), `.ui_dir` (`frontend/src/components/ui`), `.token_files` (a name heuristic), `.terms` (none), `.allow_phrases` (`["Ghost Hunting"]`).
- **agent-context:** `agent_context.manifest_cmd`, `.manifest_path` (`/api/agent/manifest`), `.mcp_tools_cmd`, `.files` (`CLAUDE.md`, `AGENTS.md`, `agent-claude-md-snippet.md`, `plugins/*/skills/*/SKILL.md`), `.min_sentence_chars` (100), `.timeout_s` (180).
- **sql-per-request:** `sql_probe` must be present (`{}` = all defaults): `.cmd_dir` (`backend`), `.python` (`<cmd_dir>/venv/bin/python`), `.test_args` (`["tests","-q"]`), `.timeout_s` (5400), `.env` ({}).
- **loose-ends:** `loose_ends.stale_days` (7). Scope comes from `.seance.id` and `.seance.scope`; the posture is `seance` when an id is set, otherwise `coven`.

## What each measures

**churn** counts lines of code (LOC) per tracked file, plus churn from `git log --numstat -M --no-merges`.
- Skips lockfiles, binaries, dist/vendored paths, and `.claude/workflows/*.js`.
- Gives totals per top-level directory and hotspots ranked by churn × LOC.
- `created_in_window: true` marks a file whose churn is mostly its own creation.

**ui-bypass** greps tracked files under `src`, outside `ui_dir`, excluding tests.
- Raw `<button|select|input|textarea` in .jsx/.tsx.
- Hex colours in .jsx/.tsx/.js, excluding token files and comment/import lines.
- `t_bypass` (needs `terms`): toggled words hard-coded in JSX text, label-like props, or `toast()` literals.
- Heuristics: read the file first (a sprite palette is legitimate hex).

**agent-context** reports sizes, with tokens ≈ bytes/4.
- **manifest:**
  - From `manifest_cmd` in the pinned tree, else `GET $RECKONING_API_BASE$manifest_path`, labelled "measured from the live API, not the pinned tree".
  - Reports bytes per section and the 15 largest `endpoints[]`.
  - `repeated_contracts`: sentences of ≥100 chars that appear ≥2×, with wasted bytes.
  - `near_duplicate_passages`: paraphrase clusters (shingle overlap); bytes are an estimate.
  - Without a manifest the instrument is `skipped`.
- **files:** sizes of the files matched by the `files` globs.
- **mcp_tools:** name + description + inputSchema of each tool printed by `mcp_tools_cmd`.

**sql-per-request** runs the suite through `scripts/probes/run_suite.py` with `-p sqlcount` (loaded via `PYTHONPATH`; nothing is added to the repo).
- The argv never contains the runner's name (a sibling `pkill -f` cannot match it); `DATABASE_URL` is unset.
- It counts completed statements inside HTTP requests only, keyed by `(method, path_format)`.
- Each key: calls, min/mean/max statements, status codes, item counts, and `n_plus_one.max_repeat` (most runs of one identical normalized statement in one request).
- `grows_with_items`: counts that rise with item count (zero-item calls excluded).
- `aborted_statements`: statements that raised. `MissingGreenlet` = an async lazy load that never ran; its field is silently empty (a bug, not a cost).
- Status:
  - `failed`: an exit of ≥128, a timeout, an exit of 2–5, or a failed self-check (0 statements attributed).
  - `ok`: an exit of 1 (tests failed), with the failures reported.
- Caveats (also in the JSON):
  - The suite's own database(s) (`attributed_by_dialect`) at fixture cardinality.
  - Round trips only, never per-statement cost: a sort no index serves, a count over an ordered query or a whole-history aggregate is invisible at fixture size, so a low count never refutes a plan-cost finding.
  - Post-commit work is not measured.
  - One row mixes every test that hit that route.

**loose-ends** checks the API and git, read-only. It needs `RECKONING_API_BASE` and `RECKONING_AUTH`. Each check has its own status:
- `rites_ready_to_seal`: Rites still `invoked` whose top-level ghosts are all, or all but one, exorcised.
- `purgatory_with_merged_pr`; `invocations_awaiting_hunter` (whole Coven).
- `stale_haunt_worktrees`: `<main>/.haunt-wt/*` with no open PR and a last commit older than `stale_days`.
- `ext_branches_without_open_pr`; `stale_parked_patches` (`<git-common-dir>/rite-cadence-parked/`).

The PR checks need `gh`; without it they are `skipped`.

**`snapshot/scope.json`** (optional; else the API is queried by the config posture):

```
{ "kind": "seance|coven|haunting|rite|repo", "org_id": "…",
  "rites":  [{ "id", "name", "status", "total_tasks", "ghost_status_counts": {"exorcised": n} }],
  "ghosts": [{ "id", "title", "status", "project_id", "milestone_id", "parent_task_id",
               "apparitions": [{ "pr_number", "pr_url", "status", "merged_at" }] }] }
```

Missing rite counts come from top-level `ghosts`; missing `apparitions` are fetched.

## Citing

Cite in brackets as `[instrument: key = number]`, exactly as measured:

- `[sql-per-request: GET /api/agent/rites/{rite_id}/ghosts = 14 stmts/call, 9× identical]`
- `[agent-context: manifest 242.6 KB ≈ 62k tok]`
- `[churn: backend/app/api/agent_api.py 5883 LOC × 4500 churn]`

Rules:
- On first citing sql-per-request, quote its `label` (e.g. "sqlite, fixture cardinality").
- A number is a cost, not a defect. Confirm it at `file:line` before it becomes a finding.
- Never cite an instrument that is not `ok`.
