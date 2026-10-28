# Reckoning personas (Layer B)

The personas are the repo's own review lenses, listed in `.ghost/config.json`
under `panel.lenses`. Each key resolves first to `<repo>/.claude/agents/<key>.md`
and then to the plugin's `agents/<key>.md`. If a listed lens has no file, the
run stops: a lens is never dropped silently.

Each persona reviews **in its own voice**, and only over the surfaces it owns:
- **P2 Health:** one pass over the shards of its kinds.
- **P1 Fidelity:** it walks each delivered Rite or Haunting feature that
  touches its surfaces, against the confirmed intent.

## Default map

The first three are plugin personas. The last three are Ghost Hunting's repo
personas, included as the worked example.

| Persona | P2 shard kinds | P1 walks | Voice |
|---|---|---|---|
| `staff-engineer` | backend, agent-surface, migrations, plugin, infra, tests | behavioural claims: traces the code path and the test behind each one | What breaks in production? Failure, concurrency, tenancy, integrity, scale, layering. |
| `product-manager` | every kind, in one pass per domain shard, judging scope and value only | each Rite or Haunting as a whole: over-build, the missing half, what misses the point | Is this worth its upkeep? Dead surface, over-build, features on only one surface. |
| `senior-ux` | frontend | every delivered screen and flow | States, hierarchy, accessibility, copy, and use of the design system. |
| `user-hunter` | frontend shards for the board, ghost detail, triage and bulk actions | delivered high-frequency Ghost flows | How many clicks is this on the 80th time? Bulk actions, keyboard, phone. |
| `user-lead` | frontend shards for dashboards, Séance and Rite reports, and the journal | delivered reporting and status surfaces | Does this show where things really stand? Could it misreport, or do something irreversible? |
| `user-medium` | agent-surface: agent routers, the manifest, MCP tools | every delivered agent endpoint or manifest change | Could I execute this without guessing? Opaque errors, a manifest that lies, retries that aren't safe. |

## Mapping an unknown persona

For a repo persona not in the table, the skill reads the `description` in its
frontmatter and applies the first rule that matches. It then prints every
derived mapping in the launch confirmation, where the human can edit it.

1. **A human who uses the UI.** The description names a role and talks about
   walking a flow, screen, page or clicks.
   - Kinds: frontend.
   - P1 walks: the delivered UI features in that role's domain.
   - Narrow the frontend shards by the role's own words:
     - "daily", "high-frequency", "data entry": the working screens;
     - "strategic", "report", "board", "stakeholders": the dashboards and reports;
     - "public", "donation", "visitor", "checkout": the public pages.
2. **A programmatic consumer.** The description says API, agent, SDK, MCP,
   manifest, webhook or integration.
   - Kinds: agent-surface. Use the backend routers when the repo has no
     agent-surface shard.
   - P1 walks: the delivered endpoints.
3. **An operator.** The description says deploy, on-call, incident or ops.
   - Kinds: infra and backend, reviewed for observability and reliability.
   - No P1 walks.
4. **A technical rubric lens** (security, performance, data).
   - Kinds: the kinds its rubric names, defaulting to backend.
   - P1 walks: behavioural claims.
5. **A product or business lens** (scope, value, priority).
   - Kinds: every kind, in one pass per domain, judging scope and value only.
6. **No rule matches.** The persona is unmapped. Show it as unmapped at
   launch; never guess.

Worked example, from an online storefront app:
- `user-merchant` ("daily power user … catalog edits and order handling")
  follows rule 1 and takes the working screens.
- `user-owner` ("does this help me grow sales and look credible to my
  investors") follows rule 1 and takes the dashboards and reports.
- `user-shopper` ("public storefront") follows rule 1 and takes the public
  pages.

## Output contract for a persona pass

- **Field names come from your task.** Return exactly the schema your task
  gives. This file defines what the fields mean, not what they are called.
- **Cite the persona.** Every finding cites the persona key, plus every
  `P-…` principle id and `T-…` tenet id that also applies. Persona severity
  maps onto the reckoning scale as follows:

  | Persona tag | Reckoning severity |
  |---|---|
  | `blocker` | blocker |
  | `concern` | major |
  | `nitpick` | minor |

- **Evidence is code.** A character persona speaks about its workday, not
  about code, but its finding still names the `path:line` where the friction
  lives: the component, the endpoint, or the manifest entry. The path is
  relative to the pinned tree root.
- **`applicable: false` is a valid answer.** When a shard or unit has nothing
  in it for this persona, return `applicable: false` with a one-line reason.
  It is cheap and honest, and it is not a failure.
- **Wishes are not findings.** Feature requests in the persona's voice ("I'd
  also like…") go in a note, not in findings. A lens's wish is not a defect;
  a human decides whether it is wanted.
- **P1 misses are questions.** A P1 walk that concludes the delivery misses
  the point returns a `misses_point` observation. It is quoted against the
  confirmed intent and goes to the human as a question, never as a ghost.
- **Voice is capped.** Keep the in-character walkthrough to a few lines, and
  only when the task asks for one. The structured findings are the output.
