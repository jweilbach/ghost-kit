# Reckoning principles (Layer A)

Universal and stack-agnostic: they apply to every repo the reckoning runs in.
Examples name common stacks; apply them by analogy to yours.

**Finders.** Report a finding only when it violates at least one standard:
a principle id below, a persona key (Layer B) or a repo tenet id `T-…`
(Layer C). The engine drops a finding that cites none of them. One finding may
cite several ids, so cite every id that applies.
- **Evidence:** `path:line`, relative to the pinned tree root named in your
  task, plus the smallest excerpt that proves the point. When an instrument
  measures it (statements per request, bytes, tokens, LOC, churn), include the
  number.
- **Severity:**
  - **blocker:** wrong or corrupting behaviour, or a security hole, that a
    user or agent actually hits.
  - **major:** a real defect, or a structural cost that compounds.
  - **minor:** a latent hazard or a local cleanup.
- Check a principle's **Not a violation** list before you report against it.

**Refuters.** A finding that matches a **Not a violation** bullet is refuted
unless it shows why the bullet does not apply. A repo tenet's **Deliberate
exceptions**, an answered Augury, and a code comment that states the reason
all settle a point, so a finding that re-argues one is refuted.

**Kinds:** backend, frontend, agent-surface, plugin, migrations, tests, infra.

---

## correctness_safety

### P-correct — Correctness
Code does what its contract says for every input it can actually receive,
including empty, boundary and error cases.

**A violation looks like**
- empty, null, zero or boundary input handled wrongly: an off-by-one, a truthiness check that rejects a valid `0` or `""`, or an attribute read with no null guard
- an error path that reports success, uses the wrong status, or returns partial data as if it were complete
- a state transition the domain forbids is reachable, or a required transition is unreachable
- time and money bugs: naive and aware datetimes mixed, a date-only string parsed as UTC midnight, floats used for money
- two paths for one operation disagree, e.g. the bulk path skips validation the single path runs
- a type or identity mismatch (a string compared to a UUID), a mutable default argument, a shadowed variable

**Not a violation**
- an input that schema validation, types or the only caller already excludes. To report it, show the path that reaches the code
- surprising behaviour that the repo documents as intended

**Applies to kinds:** backend, frontend, agent-surface, plugin, migrations, infra

### P-secure — Security
Every request is authenticated, authorized for the specific resource and
tenant, and cannot inject, leak or escalate.

**A violation looks like**
- a read or write that fetches by id with no tenant or owner scope (IDOR), or one API surface that skips a check its twin enforces
- authentication without authorization: any signed-in principal can act on someone else's data, or a role check is missing
- SQL, shell, HTML or a filesystem path built from user input; untrusted markdown or HTML rendered unsanitized; an open redirect; a server-side fetch of an address the user supplied (SSRF)
- secrets, tokens or PII in code, logs, error bodies, events or the client bundle; a secret compared without a constant-time comparison
- mass assignment: a request schema accepts fields the caller must not set (owner, tenant, role, or a status that bypasses a gate)
- an inbound webhook with no signature check, or a credential or token endpoint with no rate limit

**Not a violation**
- an endpoint that is deliberately public and documented (health, manifest, OAuth callback) and exposes nothing tenant-scoped
- defence in depth on a path that an enforced upstream check already covers, provided you cite the check

**Applies to kinds:** backend, frontend, agent-surface, plugin, infra

### P-integrity — Data integrity
Stored data stays valid. The database enforces what it can, transactions cover
multi-step writes, and migrations never corrupt data silently.

**A violation looks like**
- an invariant held only in application code when a NOT NULL, UNIQUE, CHECK or FK constraint could hold it, or an invariant held nowhere
- a multi-row or multi-table write outside one transaction, so a failure part-way leaves partial state
- a read-modify-write with no version check, row lock or atomic UPDATE (a lost update)
- `ON DELETE` rules that orphan rows or cascade too far; soft-deleted rows leaking into reads or uniqueness checks
- a data-rewriting migration that silently drops or nulls values it does not recognise instead of counting them, or a downgrade that does not restore the schema
- enum or vocabulary drift between the database, the backend and the frontend, leaving stored values that no reader handles

**Not a violation**
- a one-way data migration with a counted, no-op downgrade, when the repo documents that as its pattern
- lossy telemetry or counters that are documented as best-effort

**Applies to kinds:** backend, agent-surface, migrations, tests

---

## runtime

### P-reliable — Reliability
Failures of dependencies, networks and processes are expected, bounded and
recoverable. None of them corrupts state or loses work that was acknowledged.

**A violation looks like**
- an outbound call (HTTP, SMTP, a cloud API) with no timeout, or a retry with no backoff or cap
- a mutation that clients or jobs repeat, with no idempotency key or natural-key upsert, so a retry duplicates rows or charges twice
- a side effect (email, webhook, push) sent before the commit, so a rollback still emits it; or work after the commit whose failure fails the whole request
- a crash mid-job that leaves state a restart can neither detect nor resume, or a job that is unsafe to re-run
- one bad item aborts a batch that should degrade per item, or an optional dependency failing turns a core read into a 500
- startup succeeds with required config missing, and the failure only appears on first use

**Not a violation**
- no retry on a call whose failure is shown to a human who can retry, when nothing is left half-written
- a path documented as best-effort that logs what it drops

**Applies to kinds:** backend, agent-surface, plugin, infra

### P-concurrency — Concurrency and resource lifecycle
Concurrent work cannot race, deadlock or starve, and every acquired resource is
released on every path.

**A violation looks like**
- blocking I/O or CPU-heavy work inside an async handler or event loop: a sync HTTP client, `sleep`, password hashing, a large parse
- a lock held across an await or a network call, or locks taken in inconsistent order on different paths
- check-then-act with no unique constraint or lock behind it; a counter incremented outside an atomic statement
- a DB session, connection or other non-thread-safe object shared across concurrent tasks
- a background loop that can die silently or sleep forever with no watchdog; a fire-and-forget task with no reference held and no error observed
- a resource not released on the error path: connections, file handles, subscriptions, listeners, timers, a UI effect with no cleanup

**Not a violation**
- a short transactional lock that does no network I/O while held and serializes a write for a reason the code states
- sync code that the framework already runs off the loop (a thread pool or worker)

**Applies to kinds:** backend, frontend, agent-surface, plugin, infra

### P-efficient — Efficiency
Each request does only the work it needs: few round trips, bounded payloads,
nothing recomputed.

**A violation looks like**
- a query inside a loop over rows (N+1), or a lazy relationship loaded once per item
- a request handler issuing many round trips where one batched or joined query would do. Cite the statement count per request that the instrument measured
- an unbounded list read with no pagination or limit, or whole rows fetched where a projection would do
- invariant work repeated on every request or render, e.g. a static document regenerated on each call
- a count, existence check or total that carries ordering, joins or columns its answer does not need, e.g. a paginated COUNT wrapped around the ordered list query, which sorts every row it counts
- a request-path aggregate over a tenant's whole history (an all-time total, a chart over every month) recomputed on every load, where a bounded window or a maintained rollup would answer it
- frontend: refetching on every render, request waterfalls, long lists rendered without virtualization, heavy imports in the initial bundle
- a cache with no invalidation that serves stale data, or one whose cost has no measured hit rate to justify it

**Not a violation**
- one extra query on a cold admin path or one-off path
- a fixture-level statement count that does not grow with the number of items. This settles round trips only: fixture tables hold a few rows, so the count says nothing about what each statement costs on a large tenant

**Applies to kinds:** backend, frontend, agent-surface, plugin, migrations

### P-scale — Scalability
Behaviour stays correct and bounded as data, tenants and replicas grow.

**A violation looks like**
- in-process state (a cache, lock, rate limiter or socket fan-out) that is wrong once a second replica or worker runs, with no single-instance assumption stated
- unbounded growth: a table, log or queue with no retention; an array column appended per event; a response that grows with everything the tenant owns
- a filter or sort on a growing tenant-scoped table that no index serves with the tenant key leading (a bare tenant index plus a sort still sorts every row the tenant owns), an index whose column order or NULLS ordering does not match the query's, or deep offset scans on a hot path
- fan-out of one call per member (per notification, per email) with no batching or backpressure
- a cap that silently truncates results and never tells the caller (`truncated`, `has_more`)

**Not a violation**
- a single-instance assumption the repo documents alongside its deploy topology
- growth beyond the reference scale the repo states (`reckoning.reference_scale` in `.ghost/config.json`, or a tenet or doc), when the code is otherwise sound. With no stated scale this cannot be claimed for a table that grows with activity (a row per event, order, message or log). A table that grows only with configuration (settings, roles, records a person creates by hand) is not a growing table

**Applies to kinds:** backend, agent-surface, migrations, infra

---

## design

### P-simple — Simplicity (YAGNI / KISS)
Every mechanism exists because a current need requires it, and the simplest
design that meets the need wins.

**A violation looks like**
- a queue, worker, cache, retry layer or event bus with no demonstrated need, where a direct call would do
- an abstraction (interface, factory, base class, registry, plugin point) with exactly one caller or one implementation
- config knobs, flags or options nobody sets, or parameters that are always passed the same value
- speculative generality: paths for cases the product declares out of scope, or compat shims for callers that do not exist
- the wrong altitude: a framework for a one-screen problem, or a hand-rolled version of what the stdlib or framework provides
- several new tables or entities where one table plus links would model the concept

**Not a violation**
- an abstraction that removes real duplication across two or more callers, or isolates a swap seam the repo documents
- a mechanism whose comment or doc cites the measured problem it solves

**Applies to kinds:** backend, frontend, agent-surface, plugin, migrations, tests, infra

### P-cohesion — Cohesion and coupling
Each module has one reason to change, depends downward through the declared
layers, and hides its internals.

**A violation looks like**
- logic in the wrong layer: a router that queries and applies rules, or a component that shapes data a hook or service should own
- a reversed dependency: a lower layer imports an upper one, or a shared utility imports a feature
- a god file mixing unrelated concerns. Cite its LOC and churn from the instruments
- a caller reaching into another module's internals (private attributes, its tables, its DOM) instead of its interface
- a leaky abstraction: callers must know an implementation detail (a column list, a key format) to use it correctly

**Not a violation**
- a layering exception the repo documents, together with its reason
- a file that is long but cohesive

**Applies to kinds:** backend, frontend, agent-surface, plugin

### P-dry — One implementation per concept
Each piece of knowledge has one authoritative implementation, and existing
utilities get reused.

**A violation looks like**
- copy-pasted logic that must change together (validation, permission checks, serialization) in two or more places
- a new helper, component or endpoint that re-implements an existing one. Cite both
- parallel implementations of one concept: two pagination helpers, or human and agent handlers duplicating one body instead of sharing a service
- the same constant, enum or list hard-coded in several files
- a document restating a contract that another document owns, which is drift waiting to happen

**Not a violation**
- duplication across a deliberate boundary, such as two independently versioned public APIs, when the repo documents it
- test setup repeated for readability, or two snippets that only look alike

**Applies to kinds:** backend, frontend, agent-surface, plugin, migrations, tests, infra

### P-consistent — Consistency
Like things are done one way (naming, idioms, error shapes, file placement), so
a reader can predict the next file.

**A violation looks like**
- two error shapes or status codes for the same failure on different endpoints
- names that break the repo's convention for fields, route nouns, casing or files
- one job done in two idioms (two HTTP clients, two state libraries, mixed async styles) with no migration underway
- a file outside the directory its kind lives in, or a test outside the repo's test taxonomy
- UI that bypasses the design tokens or primitives that its siblings use

**Not a violation**
- a migration from one idiom to another that is documented and underway
- legacy code with no demonstrable cost, which is minor at most

**Applies to kinds:** backend, frontend, agent-surface, plugin, migrations, tests, infra

### P-contract — API contract design
Interfaces are minimal, stable, discoverable and unsurprising, and their errors
are machine-readable and actionable.

**A violation looks like**
- an error with no stable machine code and no hint what to fix: a bare 400 or 500, or prose-only detail
- a list endpoint with no stated pagination or ordering, or a response whose shape changes with its input and has no discriminator
- a response, field or event shape changed while its existing readers still depend on the old one (find those readers)
- a PUT or DELETE that is not idempotent, or a create that cannot be retried safely after a timeout
- sibling endpoints that disagree on input conventions (id in the path vs the body, filter names)
- two endpoints exposing one operation, or endpoints nobody calls

**Not a violation**
- a divergence the repo documents and pins as a convention
- internal function signatures (use P-cohesion for those)

**Applies to kinds:** backend, agent-surface, plugin, frontend

---

## quality

### P-tested — Tests that prove behaviour
Tests cover the critical paths at the right level, run deterministically, and
fail when the behaviour breaks.

**A violation looks like**
- a critical path (auth, tenancy, money, deletion, a state transition) with no test
- a test that cannot fail: it asserts only on mocks it configured, compares a value to itself, or passes having found zero items
- a test that "proves" behaviour its engine cannot exhibit, such as FK cascades, row locks or dialect-specific SQL run on a different database
- flakiness: sleeps, wall-clock time, test-order coupling, shared state, live network
- tests pinned to implementation details while the observable behaviour goes untested

**Not a violation**
- trivial glue with no unit test when an integration test covers it
- an engine gap that the repo closes with another gate, provided you cite that gate

**Applies to kinds:** tests, backend, frontend, plugin, migrations

### P-observable — Observability and operability
Failures are visible and diagnosable from logs, metrics and health checks, and
config and deploys are explicit.

**A violation looks like**
- a swallowed error (`except: pass`, an empty catch, `.catch(() => {})`), or an error logged without context (ids, operation)
- a background job or integration that can fail with no log, metric or visible state
- secrets or PII in logs, or unbounded log spam inside a hot loop
- a health check that reports green while a required dependency is down
- config read ad hoc from the environment in many places, or defaults that silently differ between environments

**Not a violation**
- a deliberately swallowed error whose comment says why that is safe
- verbose logging on dev-only paths

**Applies to kinds:** backend, frontend, agent-surface, plugin, infra

### P-maintainable — Maintainability
Code is easy to read and change: small units, honest names, comments that say
why, and no dead code.

**A violation looks like**
- a function or component far larger or more branched than its peers, especially one that is also a churn hotspot. Cite the numbers
- dead code: unreachable branches, unused exports, endpoints or flags, commented-out blocks
- a misleading name, such as a `get_` that writes or a boolean named for its opposite
- comments that narrate what the code does instead of why, or a TODO with no owner or ticket
- magic numbers or strings with no name

**Not a violation**
- a long file whose parts are cohesive and well named
- a style preference with no cost, which is not worth reporting

**Applies to kinds:** backend, frontend, agent-surface, plugin, migrations, tests, infra

### P-truthful-docs — Truthful docs
Docs, manifests, comments, schemas and help text describe what the code does
now.

**A violation looks like**
- a doc or manifest that claims an endpoint, field, default, limit or behaviour the code lacks. Cite both sides
- a comment that contradicts the code beneath it
- stale counts, sizes, paths, ids or version numbers in docs
- a documented command or script that no longer exists or no longer works
- a generated or copied doc that has drifted from its source

**Not a violation**
- historical records such as changelogs, dated plans and ADRs
- forward-looking docs that are clearly marked as plans

**Applies to kinds:** backend, frontend, agent-surface, plugin, migrations, tests, infra

### P-deps — Dependencies and supply chain
Dependencies are few, pinned, maintained and trusted, and nothing ships with a
known vulnerability or an unused package.

**A violation looks like**
- a dependency with no lockfile, or a lockfile out of sync with its manifest
- a known advisory on a shipped path with no documented allowlist entry
- an unused dependency, or two libraries doing one job
- a heavy package pulled in for a trivial function
- remote code fetched and executed with no pinned version or checksum, or unpinned CI actions

**Not a violation**
- an allowlisted advisory with a recorded reason
- version ranges in the manifest when the lockfile pins exact versions

**Applies to kinds:** backend, frontend, plugin, infra

---

## experience

### P-ux — User experience
Every screen makes its primary action obvious, handles every state, is
accessible, and is built from the design system.

**A violation looks like**
- a data view without designed empty, loading and error states: a blank screen, an endless spinner, or a raw error
- an inaccessible control: a clickable div with no role or key handler, a missing label, no visible focus, meaning carried by colour alone, failing contrast
- internal values shown to users: enum keys, ids, stack traces, untranslated message keys
- a destructive action with no confirmation or undo, or input lost on navigation or on error
- repeated UI copy-pasted instead of made a component, raw colours or spacing instead of tokens, or a raw control where a primitive exists
- a layout that breaks at phone width, or motion that ignores reduced-motion settings

**Not a violation**
- a taste ruling or a reverted experiment that the repo records
- pixel polish with no user impact

**Applies to kinds:** frontend

### P-agent-ux — Agent-facing experience
Machine interfaces (API manifests, tool descriptions, skills, agent docs) are
lean, truthful, consistent and progressively disclosed. Agent context is a
budget.

**A violation looks like**
- a manifest, tool text or skill that repeats one contract in several places, or inlines detail that a link or an endpoint could disclose on demand. Cite bytes or tokens
- agent-facing text that describes behaviour the endpoint does not honour
- inputs, enums, defaults, pagination or error codes that an agent cannot discover from the agent-facing description
- an agent path with weaker checks than its human twin, or an operation the agent docs promise that does not exist
- a behavioural rule that exists only in prose an agent must remember, where a script or engine could enforce it
- text loaded by every agent that matters only to a few

**Not a violation**
- detail kept because a test or consumer demonstrably needs it at load time
- human-only surfaces that the repo deliberately keeps from agents

**Applies to kinds:** agent-surface, plugin
