# ghost-hunting-core (ghost-kit)

The canonical Ghost Hunting integration for coding agents: one shared copy of
the lifecycle skills that used to be forked across every repo, parameterized
per repo by a committed `.ghost/config.json`.

## Get started

```bash
curl -fsSL https://github.com/jweilbach/ghost-kit/releases/latest/download/install.sh | bash
```

Then open Claude Code in your repo (restart it if it's already open) and type
**`/ghost-onboard`** (Codex: `$ghost-onboard`).

The installer adds the `ghost-kit` marketplace (auto-update on), installs this
plugin at user scope, and signs the computer in through the browser — create an
account or sign in, check the code, click **Connect**. No API key is ever copied
or pasted. `/ghost-onboard` then links the repo to a Séance (portfolio) after one
confirmation and writes `.ghost/config.json` plus a merged `.claude/settings.json`.
Commit both: a teammate who clones the repo is prompted to install the plugin and
told to type `/ghost-onboard` — one browser click and they're in.

Manual install, without the script:

```bash
claude plugin marketplace add https://github.com/jweilbach/ghost-kit.git
claude plugin install ghost-hunting-core@ghost-kit
```

then `/ghost-onboard` in Claude Code (it runs the browser sign-in itself).

### The `ghost-kit` helper

`scripts/ghost-kit` (bash + curl + jq, no npm) is what `/ghost-onboard` drives; you
can run it yourself in a terminal:

| Command | Does |
|---|---|
| `ghost-kit login` | browser sign-in; stores the key for that Coven (organization) |
| `ghost-kit status` | the Coven, the agent identity, which key a repo uses and from which file, and any `.env` line that shadows the signed-in key |
| `ghost-kit covens` | every Coven this computer is signed in to |
| `ghost-kit logout` | removes this computer's key for the repo's Coven (then revoke it on the web app's Mediums page) |
| `ghost-kit doctor [--tools]` | tools (git 2.31+, curl, jq; gh and Node 22+ optional), plugin, sign-in, then the repo readiness check below |
| `ghost-kit init …` | writes a minimal `.ghost/config.json` and merges the plugin into `.claude/settings.json` without clobbering (`--force` switches Séance/Coven, `--rites` vendors the rite engines) |

### Credentials: bound to a Coven, never to login order

`ghost-kit login` writes the key to `~/.config/ghost-hunting/.env` (directory 700,
file 600) under `GHOST_HUNTING_API_KEY__<ORG8>` — the first eight hex characters of
the Coven's id, uppercased — and touches no other line. It never writes the bare
`GHOST_HUNTING_API_KEY`: a bare name cannot say which Coven its key belongs to.

Every skill's Phase 0, `runtime/project.mjs` `credential()` and the workflow
engines resolve a repo's key in the same order:

1. the configured `auth.prod.env_var` environment variable;
2. the repo's `auth.prod.env_files`;
3. the same git repository's main checkout (only with the same `env_var`);
4. **only when the config names `auth.prod.org_id`**: the per-user
   `GHOST_HUNTING_API_KEY__<ORG8>` line.

A config without `org_id` (every repo connected before 1.10.0) ends at the legacy
`~/.claude/.env` instead and otherwise resolves exactly as before. With `org_id`,
Phase 0 also checks `GET /api/agent/me` and stops with one plain line — naming the
file the key came from — when the key is missing, rejected (401), or belongs to a
different Coven. Worktree runs of a Coven-bound repo need no per-worktree key copy.

### Codex CLI

The same canonical skills run in both hosts. Clone the mirror once per machine,
then install the native Codex plugin and generate each repo's adapters (Node 22+,
Codex CLI 0.155.1 tested):

```bash
git clone https://github.com/jweilbach/ghost-kit.git ~/ghost-kit
~/ghost-kit/plugins/ghost-hunting-core/scripts/ghost-setup.sh --install --write --repo /path/to/repo
```

Without `--write`, setup previews changes. It preserves unrelated config, exposes
repo skills through relative links, generates Codex personas from Claude agent
files, and refuses to overwrite manually edited generated files. Re-run it after
changing a canonical persona, skill catalog, MCP configuration or host policy.

Start a **new Codex CLI session** after installing or updating, then `$ghost-onboard`.
Use `$haunt`, `$summon`, `$commence-haunt`, etc. Repo `CLAUDE.md` remains canonical
through the Codex fallback setting; an existing `AGENTS.md` still takes precedence.
Active workflows run through `.ghost/bin/run-workflow` using native Codex child
sessions. Claude's workflow bodies and `/...` entry points stay intact. Readiness
is `.ghost/bin/ghost-doctor --host both --online`.

**Multi-séance covens.** By default a repo maps to one séance (`seance.id` /
`seance.selector`). A repo whose backlog spans a whole coven reorganized into
several domain séances can instead set `seance.scope: "coven"`: séance
resolution is skipped, listing/reporting skills (haunt, seance, haunt-triage,
haunt-status) operate coven-wide, and placement skills (summon, investigate,
forge-ritual) resolve a target haunting per run — keyword-matched across the
coven and confirmed interactively, or required as an explicit `--haunting`
argument in autonomous mode. `seance.id`/`seance.selector` are ignored in this
mode; `seance.qa_seance_id` still applies.

## How updates propagate

**A running session never picks up an edit — and a restart is usually all it
takes.** Skills are resident from session start: the prose executing is whatever
was loaded then, whatever the files on disk say afterwards.

**Claude, installed from the mirror** (a `git` marketplace with auto-update on):
after a session starts, Claude Code refreshes the marketplace and updates the
on-disk plugin; the **next** session runs the new version. A repo that commits the
`/ghost-onboard` settings block pins its users to this released mirror.

**Claude, from a local checkout** (a `directory` marketplace): the plugin loads
from the checkout in place, so an edit there reaches every repo on its next
session restart, with nothing to install.

Two traps when looking at the plugin cache of a `git` marketplace:

- `claude plugin update ghost-hunting-core@ghost-kit` compares **version strings
  only**. Content shipped under an unchanged version prints `already at the latest
  version` and copies nothing — which is why every plugin change ships a bump.
- `claude plugin marketplace update ghost-kit` refreshes marketplace metadata,
  leaves the installed plugin where it was, and reports success either way.

Both report success while doing nothing, so **never treat either as evidence**.
`ghost-kit update-hint` prints the right command for how this computer installed it.

The version a skill reports is a **literal stamped into the Phase-0 block**
(`PLUGIN_VERSION="..."`), never a value read from disk at runtime. A runtime read
reports the version installed *now* while the session executes older prose — which
is how a v1.3.7 session once reported `plugin/1.4.0` and the server answered
"current". Because the stamp travels with the text, a stale session reports itself
as stale, and the block prints its own warning before the first request goes out.

**So the acceptance test for an update is what a skill reports after a restart —
never `ghost doctor`'s headline, and never a cache listing.** The doctor is a
separate process that re-reads disk on every run, and a cache listing describes
what is installed; both can read current while your session is not.

**Codex:** the native plugin is cached. Pull the mirror clone, reinstall with
`ghost-setup.sh --install` (or `codex plugin add ghost-hunting-core@ghost-kit`)
after a version change, then start a new session. A session restart alone does
not refresh its cache. The doctor compares installed skill contents with source.

Claude discovers workflows in the repo, so `/ghost-sync` renders
`workflows/*.js.tmpl` (with `__CFG_*__` tokens from the repo's config) into
the repo's `.claude/workflows/` as committed DO-NOT-EDIT files.

## SessionStart

One read-only, offline hook (`scripts/session-start.sh`, `startup` sessions only)
that always exits 0 and speaks only when there is something to do:

- the repo names a Coven (`auth.prod.org_id`) but this computer holds no key for
  it → *"This repo tracks its work in Ghost Hunting (Acme), but this computer isn't
  signed in. Type /ghost-onboard to connect."*
- no config here and no Ghost Hunting key anywhere on this computer → a first-time
  pointer to `/ghost-onboard`, at most once a day;
- a connected repo → the vendored-workflow drift nudge and `ghost-doctor.sh
  --check`, both silent unless something needs doing.

An unrelated repo on a signed-in computer hears nothing.

## Freshness enforcement

Every skill's Phase-0 block (canonical source: `PHASE0.md`) sends
`X-Ghost-Client: plugin/<v> repo/<slug> skill/<name> wf/<bundle>` — where `<v>` is
the stamped literal, i.e. the version of the prose sending it — and checks
the `client_contract` verdict on `GET /api/agent/me`: `outdated` → warn and
continue; `unsupported` → stop. The server tracks per-repo versions and can
hard-block stale writes when its client enforcement is set to block.

## Readiness (is this repo actually able to run a rite?)

Freshness and readiness are different questions. `/ghost-sync` answers the first
and is deliberately silent about the second: a repo with a hollowed-out
`isolation` block renders deterministically and syncs perfectly clean.

`scripts/ghost-doctor.sh` answers the second. Read-only, bash + jq, no validator
dependency. Per capability — frontend wave, backend wave, migration wave,
merge-haunt — it reports `READY` / `DEGRADED` / `BLOCKED` / `n/a` by checking:

- `.ghost/config.json` parses, and every key is one `config.schema.json` knows
  (a typo like `isolaton` otherwise renders empty and syncs clean)
- every configured isolation script **exists and is executable** — the engine
  only ever tests these for an empty string before interpolating them into agent
  shell text, so a missing one surfaces mid-run, after agents have spawned
- `--probe` (opt-in): actually runs `db_script url` and checks the DSN parses
- engine rule R7 (`db_script` + `migration_gate` required for the backend track),
  hoisted from run-time — where it fires only once a wave plan is validated.
  Backend and migration waves count only when the repo vendors `rite-cadence`.
- version agreement between installed skills and vendored workflows: a plugin
  that auto-updated past the vendored engines is a WARN naming who runs
  `/ghost-sync`; vendored engines newer than the plugin are a BLOCK

`scripts/ghost-fleet.sh` runs it across every repo with a `.ghost/config.json`
and prints one matrix; the `ghost-hunting-core:ghost-fleet` skill wraps it.

`n/a` is a real verdict: a repo that declares no backend is not "failing" backend
waves.

## What stays in each repo

- `.ghost/config.json` (the contract) + `.ghost/sync-state.json` (written by
  /ghost-sync) + vendored `.claude/workflows/*.js` + vendored payload scripts
  (e.g. `scripts/pg-smoke.sh` when `.isolation.pg_smoke` is set — DO NOT EDIT,
  edit the plugin's `scripts-payload/`)
- Product skills (the repo's own task, domain, and service start/stop
  skills) and repo persona agents for /panel
- Helper scripts referenced by config: `ghost-wt.sh`, `ghost-db.sh`,
  `ghost-commit.sh`, `migration-gate.sh`, test runners

## Workflows & rituals (routing)

The primary batch path is **forge-ritual (author) → invoke-ritual (run) →
rite-cadence (engine)**: `forge-ritual` turns a rite's ghosts into a
`validatePlan`-checked wave plan and bakes it into a consecrated ritual;
`invoke-ritual` runs that ritual, provisioning the worktree and driving
**rite-cadence**, the engine that carries a wave plan through validate → build →
ownership → gate → commit → reconcile → reversibility → harden → writeback → exorcise for
**both frontend/visual AND backend/migration waves** (backend waves get a
runner-owned scratch Postgres, pg-smoke + migration-gate drift gates, and a
migration reversibility roundtrip). **`harden`** is rite-cadence's one child
workflow — the reusable adversarial review→fix pass; it is fail-loud, returning
`{green:false, aborted:true, reason}` when fewer than `min_finders` (default:
all lenses) finders survive, so a dead finder wave can never be mistaken for a
clean range. `ghost-lane` and
`extermination` are **DEPRECATED (sunsetting)**: they remain only for ad-hoc
ghost sets outside a forged rite during the sunset. All of these are vendored
per-repo by `/ghost-sync` (config `workflows.vendor`); `rite-cadence` also
vendors the canonical `pg-smoke.sh` when a repo sets `.isolation.pg_smoke`.

> **Keep the host awake for long runs.** A multi-hour Workflow (a full rite, or a
> standalone `harden` over a large range) makes no progress while the machine
> sleeps, and the harness's per-agent stall watchdog (180s of no stream progress,
> 5 retries) then orphans the longest stages — harden's fixer and gate. On a
> laptop, run it on AC power with `caffeinate -i` (verify: `pmset -g assertions |
> grep caffeinate`; lid-close still sleeps). If a run does stall, harden now
> records the cause in `fixer_death_reason`/`gate_death_reason` and the harness
> logs it as `[stall] agent "…" stalled`.

## Skill inventory

ghost-onboard · haunt · summon · seance · commence-haunt · plan-haunt · review-haunt ·
merge-haunt · haunt-triage · investigate · panel · forge-ritual · invoke-ritual ·
haunt-status · ghost-fleet · reckoning · batch-haunt (deprecated stub → forge-ritual/invoke-ritual) ·
ghost-sync

(The legacy patrol system was retired when ghost-kit was created — batch
execution now runs through the forge-ritual → invoke-ritual → rite-cadence path,
with the deprecated /extermination workflow kept for ad-hoc ghost sets.)
