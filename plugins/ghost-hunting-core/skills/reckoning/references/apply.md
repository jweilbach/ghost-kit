# Applying a reckoning plan

`scripts/reckoning-apply.mjs` is the only thing that writes a reckoning's results to the Ghost
Hunting API, and only what the Hunter approved. It writes what the ENGINE sealed — the plan seal's
validated drafts and the Imprint seal's replacement text — never a stub file. Run it through a
subagent, then verify. `--local` is remembered from `init`; a local reckoning never writes to prod.

```bash
node "$APPLY" plan    --run "$RUN"                               # numbered, grouped, with "applied" flags
node "$APPLY" apply   --run "$RUN" --select all|additive|1,4,7 [--dry-run]
node "$APPLY" publish --run "$RUN"                               # Scroll + appendix (child Scroll) + one Tolling
```

## What each item does

| Item | API | Additive |
|---|---|---|
| Imprint supersede | `POST /imprints/batch` item with `supersedes_id` (the target fades atomically) | yes |
| Imprint merge | the supersede above, then `POST /imprints/{dup}/retire` once the replacement landed | no |
| Imprint retire | re-read, then `POST /imprints/{id}/retire` (any Medium may retire where retire parity is deployed; a 403 is reported as "a Hunter can retire it at /imprints") | no |
| New Imprint | `POST /imprints/batch` item (fact / convention / gotcha / preference / procedure) | yes |
| fix_batch | ONE `POST /hauntings/{id}/ghosts` with every small fix as a checklist line | yes |
| enrich_existing | `POST /ghosts/{id}/evps` with the new evidence | yes |
| file_ghost | `POST /hauntings/{project_id}/ghosts` (the judge's draft; Haunting must be in scope) | no |
| raise_augury | `POST /auguries` (a question for the Hunter; server-idempotent on task + title) | no |
| reopen_ghost | EVP with the evidence, then `PUT /ghosts/{id}/status {"status": "ether"}` | no |
| close_done | EVP with the evidence, then `PUT /ghosts/{id}/status {"status": "exorcised"}` | no |
| mark_obsolete | EVP, then the `obsolete` Sigil (`POST /ghosts/{id}/sigils`) — **never** exorcised | no |

Imprint rules the engine already enforced, and the server re-checks: a replacement may
keep or widen, never sideways — an org Imprint stays org; a project Imprint stays in its
Haunting or widens to org, and an org item is sent with NO `project_id`. A merge's replacement covers BOTH
Imprints. Content is a fact about the code today — never a recommendation or a decision.

## Why it is safe to re-run

- **Journal:** `<run>/applied.jsonl` gets a line after each CONFIRMED response, keyed by the verdict
  generation + item; journaled steps are never sent again. A merge is two steps (supersede, retire),
  so a failed retire is retried on the next run. Inspect it to see exactly what reached prod.
- **Decisions:** what a selection leaves out is recorded as declined in `<run>/decisions.json`, so the
  Tolling stops asking about it.
- **Markers:** created ghosts carry `context_payload.reckoning = "<run>:<k>"`; EVPs, Auguries and the
  Scroll carry `<!-- reckoning:<run>:<k> -->`. Before creating, the script looks for the marker —
  a crash between a POST and its journal line does not duplicate anything.
- **Re-read first:** every Imprint target is re-read and skipped unless still vivid; every ghost's
  status is re-read before a reopen / close / obsolete (the world moved since the snapshot).
- **Imprint writes:** each is its own batch under a stable key (run + generation + item), so a lost
  response replays on the server instead of writing twice; a supersede keeps the old Imprint's tags,
  citations and source ghost.
- **Status changes are verified** against the status the API returns — `PUT /ghosts/{id}` silently
  ignores `status`; only `PUT /ghosts/{id}/status` changes it.

## Verifying (the orchestrating session)

1. Every selected item is `ok: true`, or carries a `skipped` / `error` you report verbatim.
2. Spot-check two items with a GET (a created ghost, a superseded Imprint's `superseded_by`).
3. `publish` posts the Tolling once; when a later apply leaves nothing pending, the Tolling is
   acknowledged, so the needs_action queue clears itself.
