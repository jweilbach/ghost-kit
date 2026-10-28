# Ghost-kit Codex host adapter

Follow the repository's current product instructions and the canonical skill/agent bodies.
The host substitutions below change execution mechanics, never acceptance gates or product rules.

- `/skill args`, `$skill args`, and `Skill(tool, skill="ghost-hunting-core:skill")`
  mean load the matching available skill and execute its instructions with that input.
  When discovery lacks a named skill, read its SKILL.md from the plugin's `skills/`
  or the repo's `.claude/skills/`; do not invent a missing tool or silently skip a gate.
- `$ARGUMENTS` means the invocation's text. `CLAUDE_PROJECT_DIR` means the working
  checkout (resolve it with git); it is not a requirement to run Claude.
- Agent/Task with a named type means an independent Codex subagent using the
  generated persona, or read its canonical `.claude/agents/<name>.md` / plugin
  `agents/<name>.md` and include that role verbatim in a fresh subagent prompt.
  Honor read-only restrictions, ownership, foreground/serial execution and result
  contracts. Missing review lenses are failures, never successful empty reviews.
- Workflow(scriptPath, args) means `.ghost/bin/run-workflow --workflow <scriptPath>
  --args-file <json-file>`. The runner uses independent Codex CLI sessions; never
  launch Claude as a fallback. Deprecated ghost-lane/extermination shipping stays
  Claude-only. Use forge-ritual → invoke-ritual → rite-cadence for active batches.
- Run `.ghost/bin/ghost-doctor --host codex` at session start and before a workflow.
  A configured integration is not proof it is usable. Report pending hook trust,
  authentication, browser capability and backend setup separately.
- Use `.ghost/bin/ghost-api METHOD /api/agent/path [body.json]` for authenticated
  Ghost requests when working in a worktree. It reads that repo's configured key
  and same-repository credential fallback; never print the key or borrow another
  coven's key. Fetch the live manifest when endpoint details are unclear.
- Prefer available native computer/browser tools for interactive inspection.
  Read the tool's documentation before using it. Use Playwright when a test needs
  its isolated authenticated browser, console/network evidence, or repeatability.
  `browser.tool=none` means no browser verification was requested. Never call a
  screenshot an automated test, and never mark required missing verification passed.
- Repo-specific rules (capture requirements, other products' APIs and credentials,
  paid-generation guards) live in that repo's own CLAUDE.md / AGENTS.md. Follow them;
  never carry one repo's rule, credential or task id into another.
- Before finalizing a nontrivial plan, run the review panel and address blockers.
  Do not bypass human gates, hook trust, permissions, or failed test evidence.
