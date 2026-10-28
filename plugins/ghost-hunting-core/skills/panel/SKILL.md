---
name: panel
description: Run an adversarial review panel — route an artifact to the relevant review-lens agents, run them in parallel, and merge their findings into one ranked report. Use when the user says "panel", "run the panel", "adversarial review", "review panel", or asks for a multi-lens review of a plan, diff, or screen.
allowed-tools: Agent, Read, Grep, Glob, Bash
---

# Panel — Adversarial Review

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Route an artifact to the review-lens agents that actually matter for it, run
them in parallel, and fuse their findings into **one** severity-ranked
report. This skill needs no Ghost Hunting API access — it is local review
only.

## Phase 0 — Discover the lens roster

The roster is per-repo config, not a hardcoded list:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CFG="$REPO_ROOT/.ghost/config.json"
cfg() { [ -f "$CFG" ] && jq -r "$* // empty" "$CFG" 2>/dev/null || true; }
LENSES=$(cfg '.panel.lenses[]')
[ -z "$LENSES" ] && LENSES="staff-engineer product-manager senior-ux"

# Lens-name resolution: plugin-shipped agents are NAMESPACED in the Agent
# tool's registry. For each lens name, spawn the bare name if it appears in
# your available agent types; otherwise use `ghost-hunting-core:<name>` (the
# shared trio ships in this plugin, so the qualified form is the one that
# exists unless the repo carries its own copy). Repo persona agents in
# .claude/agents/ always resolve bare. If neither form exists, warn and drop
# that lens.
```

- The **shared trio** — `staff-engineer`, `product-manager`, `senior-ux` —
  ships with this plugin (its `agents/` dir) and is the default roster when
  the config lists none. These are the **reasoning lenses**.
- Any additional names in `panel.lenses` are the repo's own **persona
  lenses** (end-user reality-check agents living in that repo's
  `.claude/agents/`). Read each persona agent's frontmatter `description` to
  learn which surfaces it owns — that drives routing in Phase 2.
- A configured lens whose agent file doesn't resolve → warn, drop it from
  the roster, continue.

## Arguments

`$ARGUMENTS` may contain an artifact reference and/or explicit lens names.

- **Artifact:** a plan file path, `diff` (the current branch diff), or a
  named screen/route.
- **Lenses (optional):** any names from the discovered roster. If the user
  names lenses, use exactly those.
- **Model directive (optional):** `reasoning-fable` — an imperative flag
  (passed by ghost-hunting-core:commence-haunt /
  ghost-hunting-core:review-haunt) meaning "run the reasoning lenses on
  Fable." See Phase 3. Absent it, every lens inherits the session model.

## Phase 1 — Resolve the artifact

Determine what is being reviewed:

- An explicit plan file path → read it.
- `diff` or nothing, in a git repo with changes → diff against the default
  branch:
  ```bash
  git diff "$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/origin/@@' || echo main)"...HEAD
  ```
  Read the changed files (cap at 30; summarize the rest by name).
- A named screen/route → Grep/Glob for the component(s) and read them.

If nothing can be resolved, ask the user what to review and stop.

## Phase 2 — Pick the lenses

If the user named lenses, use exactly those. Otherwise route by artifact
type — run **only what is relevant, never the whole roster blindly**:

| Artifact | Lenses |
|----------|--------|
| Implementation plan / architecture decision | `staff-engineer` + `product-manager` |
| Backend-only code diff | `staff-engineer` |
| Migration / data-model change | `staff-engineer` (data-integrity + migration-safety focus) |
| Frontend / UI code diff or screen | `senior-ux` + `staff-engineer` (if logic changed) + the fitting persona lens |
| User-facing page or flow | the fitting persona lens + `senior-ux` |
| API / programmatic surface with a persona consumer | that persona + `staff-engineer` |

**Picking the persona:** match the artifact's audience against each persona
agent's frontmatter description (who touches this surface — leadership /
reporting, high-frequency daily work, a public visitor, a machine consumer,
…). When the roster has no personas (default trio), user-facing artifacts
route to `senior-ux` (+ `staff-engineer` when logic changed).

State which lenses you chose, and the one-line reason, before running them.

## Phase 3 — Run in parallel

Launch the chosen lens agents **in a single message with multiple Agent tool
calls** so they run concurrently. Give each agent:

- The artifact in full (plan text, diff, or component code — paste it;
  subagents do not share your context).
- Relevant context: objective, acceptance criteria, constraints, if known.
- The instruction to follow its own output contract.

**Model selection.** By default every lens inherits the session model. If
`$ARGUMENTS` contains the `reasoning-fable` directive, spawn the **reasoning**
lenses — `staff-engineer`, `product-manager`, `senior-ux` — with
`model: "fable"` on their Agent tool calls (this overrides their
`model: inherit` frontmatter; `fable` is a valid Agent `model` value), so a
peer model reviews the session model's work. The **persona** lenses always
inherit. The directive is **imperative**: apply it as given, do **not**
re-derive the session model (the caller already gated on it). So the routing
is observable rather than a silent no-op: **state which lenses you put on
Fable** before launching (e.g. `Model selection: staff-engineer,
product-manager → fable`), and tell each Fable-routed lens to **report its
own model on its first output line**. Without the directive, every lens
inherits — manual `/panel` and orchestrator cycles are unchanged.

## Phase 4 — Merge

Collect every agent's tagged findings and produce ONE report:

- Dedupe findings raised by multiple lenses; keep the sharpest wording and
  attribute it (e.g. `[staff-engineer, senior-ux]`).
- Rank: all `blocker`s first, then `concern`s, then `nitpick`s.
- Quote persona walkthroughs only as short snippets where they add color; do
  not reproduce them in full.
- End with a single overall verdict.

Output format:

```markdown
## Panel Review — <artifact>

Lenses: <list, with the one-line reason for the selection>

### Blockers
- [<lenses>] <finding> — <why> — <fix>

### Concerns
- [<lenses>] <finding> — <why> — <fix>

### Nitpicks
- [<lenses>] <finding> — <fix>

### Verdict
<one or two sentences>
```

## Phase 5 — Surface

Present the merged report. Surface **every blocker to the user unfiltered** —
do not drop or soften findings based on your own judgment of importance. The
user decides what to fold in.
