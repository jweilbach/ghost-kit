---
name: batch-haunt
description: DEPRECATED — do not use. Legacy parallel ghost runner. For batch execution, forge a rite into a ritual with /forge-ritual, then run it with /invoke-ritual (which drives the rite-cadence engine). The older /extermination workflow remains only for ad-hoc ghost sets during the sunset.
---

# Batch Haunt — DEPRECATED

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


> **DEPRECATED.** This skill was the legacy batch mechanism: it optimistically
> claimed arbitrary ether ghosts by priority, and its worktree subagents
> **self-exorcised with no PR, no review gates, and no collation** — bypassing
> the one-PR-per-run / human-merge model. It also predates the per-repo
> worktree + scratch-DB isolation tooling, so its parallel edits could collide.
>
> **Do not run this skill.**

## Use the forge-ritual → invoke-ritual → rite-cadence path instead

The current way to run a set of ghosts as a reviewed, collated batch is to
**author a rite and forge it into a ritual, then invoke it**:

1. **`ghost-hunting-core:forge-ritual`** — scopes the work into a rite, converts
   its ghosts into a `validatePlan`-validated **rite-cadence wave plan** (parallel
   implementers over disjoint files; backend/migration waves get a scratch
   Postgres + drift/pg-smoke gates + reversibility), and bakes it into a
   consecrated ritual DAG (`prep → run → ship`). It never runs anything.
2. **`ghost-hunting-core:invoke-ritual`** — runs that ritual: provisions the
   worktree, drives the **rite-cadence** engine (validate → per wave: build →
   ownership → gate → commit → reconcile → reversibility → harden → writeback → exorcise),
   and ships **one PR** on `ext/<slug>`. A human merges; nothing self-exorcises
   without gates.

This is the primary batch path for both **frontend and backend/migration** work.

## The deprecated ad-hoc path (`/extermination`)

The **`extermination` workflow** is itself **DEPRECATED (sunsetting)** and
survives only for **ad-hoc ghost sets outside a forged rite**: an explicit,
reviewed set of ghost ids run in parallel waves over disjoint files, collated
onto one integration branch, one PR, one QA tree. Prefer the forge-ritual path;
reach for extermination only when you have a loose ghost set and no rite.
`extermination` is vendored by `ghost-hunting-core:ghost-sync` when a repo lists
`"extermination"` in `workflows.vendor`.

## If you reached this skill

Stop and tell the user this skill is deprecated, then point them at
`ghost-hunting-core:forge-ritual` → `ghost-hunting-core:invoke-ritual` (or the
deprecated `/extermination` for a loose ad-hoc set). Do not claim ghosts, launch
worktree subagents, self-exorcise, or call the Ghost Hunting API from here.
