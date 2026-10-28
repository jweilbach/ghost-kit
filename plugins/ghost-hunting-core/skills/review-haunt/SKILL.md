---
name: review-haunt
description: Review code changes for a ghost (task) against its acceptance criteria, run tests, and post a structured EVP. Use when the user says "review haunt", "review ghost", "code review", "check my work", or "review changes" followed by a ghost ID or title fragment.
---

# Review Haunt

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Review code changes against a Ghost's acceptance criteria, run tests, launch an adversarial review, and post a structured EVP with findings.

**CRITICAL: This skill has 5 phases (0-4). All phases must complete, including posting the review EVP.**

## Arguments

The user provides a **ghost ID** (full UUID or short prefix), a **title fragment**, or nothing (auto-detect from current assignments).

**Invocation input** means the user's text after `/review-haunt` (Claude) or
`$review-haunt` (Codex). On a host that expands `$ARGUMENTS`, that expansion is
the same input. Never require literal `$ARGUMENTS` expansion.

## Flags

Check the invocation input for these optional flags:

- **`--local`** — Target the local API (`cfg '.api.local_base'`). Honored **only** when the repo's `.ghost/config.json` sets `api.allow_local_switch: true`: set `GK_LOCAL=1` in the environment **before** running the Phase-0 block. Otherwise ignore the flag and tell the user why.
- **`--no-tests`** — Skip running tests (code review only).
- **`--base=BRANCH`** — Override the base branch for diffing. Default: auto-detect.
- **`--force-panel`** — Always run the `ghost-hunting-core:panel` review even if a recent "Spectral Review" / "Adversarial Review" EVP exists (overrides the Phase 0d/3d skip). Used by `ghost-hunting-core:commence-haunt`'s diff gate and by orchestrators that re-review every cycle, so each review gets a fresh, full panel.
- **`--panel-reasoning-fable`** — Forward the optional `reasoning-fable` directive when the active host and panel support it. Other hosts ignore this flag and use the inherited model.

## Phase 0 — Bootstrap & Resolve

### 0a. Config, credentials, preflight

Run the canonical ghost-kit Phase-0 block (if `--local` was requested and the config allows it, `export GK_LOCAL=1` first):

```bash
# ── Ghost-kit Phase 0 (canonical — edit PHASE0.md first) ──
# A line starting "STOP:" (exit code 3) means STOP: relay that line to the user as-is and run
# nothing else. Never go looking for an API key anywhere this block did not look.
command -v jq >/dev/null 2>&1 || { echo "STOP: ghost-kit needs jq, which is not installed on this computer. Install it (macOS: brew install jq; Linux: your package manager), then try again."; exit 3; }
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CFG="$REPO_ROOT/.ghost/config.json"
cfg() { [ -f "$CFG" ] && jq -r "$* // empty" "$CFG" 2>/dev/null || true; }

GK_AUTH=prod
API_BASE=$(cfg '.api.base'); API_BASE=${API_BASE:-https://backend-production-ea01.up.railway.app}
if [ "${GK_LOCAL:-0}" = "1" ] && [ "$(cfg '.api.allow_local_switch')" = "true" ]; then
  GK_AUTH=local; API_BASE=$(cfg '.api.local_base'); API_BASE=${API_BASE:-http://localhost:8000}
fi
KEY_VAR=$(cfg ".auth.$GK_AUTH.env_var"); KEY_VAR=${KEY_VAR:-GHOST_HUNTING_API_KEY}
ENV_FILES=$(cfg ".auth.$GK_AUTH.env_files[]"); ENV_FILES=${ENV_FILES:-.env}
CFG_ORG_ID=$(cfg ".auth.$GK_AUTH.org_id"); CFG_ORG_NAME=$(cfg ".auth.$GK_AUTH.org_name")

# Key lookup, in the SAME order as runtime/project.mjs credential() and the engines:
# 1 the env var, 2 this checkout's env_files, 3 the main checkout's (same key name only),
# 4 ONLY when the config names org_id: the per-user file, by GHOST_HUNTING_API_KEY__<ORG8>.
# A config without org_id keeps the legacy ~/.claude/.env instead. Never evaluate .env as shell.
gk_key() { sed -n -e 's/^[[:space:]]*//' -e 's/^export[[:space:]][[:space:]]*//' -e "s/^$GK_K=//p" "$*" 2>/dev/null | head -n 1 | tr -d "\"'[:space:]"; }
TALISMAN=$(printenv "$KEY_VAR" 2>/dev/null || true); KEY_SRC=${TALISMAN:+the $KEY_VAR environment variable}
GK_K=$KEY_VAR
for f in $(printf '%s\n' "$ENV_FILES"); do
  [ -z "$TALISMAN" ] && TALISMAN=$(gk_key "$REPO_ROOT/$f") && [ -n "$TALISMAN" ] && KEY_SRC="$REPO_ROOT/$f"
done
# Linked worktrees do not carry ignored .env files. Only fall back to THIS git
# repository's main checkout, and only if it configures the same key name.
MAIN_ROOT=$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
MAIN_KEY=$(jq -r --arg local "${GK_LOCAL:-0}" 'if $local == "1" and .api.allow_local_switch then .auth.local.env_var else .auth.prod.env_var end // empty' "$MAIN_ROOT/.ghost/config.json" 2>/dev/null)
if [ -z "$TALISMAN" ] && [ "$MAIN_KEY" = "$KEY_VAR" ] && [ "$MAIN_ROOT" != "$REPO_ROOT" ]; then
  for f in $(printf '%s\n' "$ENV_FILES"); do
    [ -z "$TALISMAN" ] && TALISMAN=$(gk_key "$MAIN_ROOT/$f") && [ -n "$TALISMAN" ] && KEY_SRC="$MAIN_ROOT/$f"
  done
fi
GHOST_USER_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/ghost-hunting/.env"
ORG8=$(printf '%s' "$CFG_ORG_ID" | cut -c1-8 | tr '[:lower:]' '[:upper:]')
if [ -z "$TALISMAN" ] && [ -n "$CFG_ORG_ID" ]; then
  GK_K="GHOST_HUNTING_API_KEY__$ORG8"; TALISMAN=$(gk_key "$GHOST_USER_ENV"); [ -n "$TALISMAN" ] && KEY_SRC="$GHOST_USER_ENV"
fi
if [ -z "$TALISMAN" ] && [ -z "$CFG_ORG_ID" ]; then
  GK_K=$KEY_VAR; TALISMAN=$(gk_key "$HOME/.claude/.env"); [ -n "$TALISMAN" ] && KEY_SRC="$HOME/.claude/.env"
fi
AUTH="Authorization: Bearer $TALISMAN"
KEY_SHOW=$KEY_SRC
case "$KEY_SRC" in "$REPO_ROOT"/*) KEY_SHOW="./${KEY_SRC#"$REPO_ROOT"/}" ;; "$HOME"/*) KEY_SHOW="~/${KEY_SRC#"$HOME"/}" ;; esac

# The version of the PROSE you are executing — stamped at release by
# scripts/ghost-kit-release.sh. Deliberately NOT read from disk: a session loads skill
# text once at start and holds it, so a runtime read reports what is on disk NOW, not
# what is running. That is how a session executing v1.3.7 reported plugin/1.4.0.
PLUGIN_VERSION="1.10.0"
GK_ROOT="${GHOST_KIT_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}}"
[ -z "$GK_ROOT" ] && [ -x "$REPO_ROOT/.ghost/bin/resolve-plugin" ] && GK_ROOT=$("$REPO_ROOT/.ghost/bin/resolve-plugin" 2>/dev/null)
GK_SRC=$(jq -r '.["ghost-kit"].installLocation // empty' "$HOME/.claude/plugins/known_marketplaces.json" 2>/dev/null)
# Loud, local, and it CAN fire: prose (above) vs the newest ghost-kit on disk.
GK_DISK=$(setopt nonomatch 2>/dev/null || true
  jq -r '.version // empty' \
  "$GK_ROOT/.claude-plugin/plugin.json" \
  "$REPO_ROOT/plugins/ghost-hunting-core/.claude-plugin/plugin.json" \
  "$GK_SRC/plugins/ghost-hunting-core/.claude-plugin/plugin.json" \
  "$HOME"/.claude/plugins/cache/ghost-kit/ghost-hunting-core/*/.claude-plugin/plugin.json \
  "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/.codex-plugin/plugin.json \
  "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/.claude-plugin/plugin.json \
  "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/plugin.json \
  2>/dev/null | sed 's/+.*//' | sort -V | tail -1)
[ -n "$GK_DISK" ] && [ "$GK_DISK" != "$PLUGIN_VERSION" ] && \
  echo "⚠ ghost-kit: this session runs v$PLUGIN_VERSION prose; v$GK_DISK is on disk — refresh ghost-hunting-core for this host, then RESTART"
REPO_SLUG=$(cfg '.repo'); REPO_SLUG=${REPO_SLUG:-$(basename "$REPO_ROOT")}
WF_STAMP=$(jq -r '.bundle // empty' "$REPO_ROOT/.ghost/sync-state.json" 2>/dev/null)
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/review-haunt${WF_STAMP:+ wf/$WF_STAMP}"

[ -n "$TALISMAN" ] || { echo "STOP: There is no Ghost Hunting API key on this computer for this repo${CFG_ORG_NAME:+ ($CFG_ORG_NAME)}. Type /ghost-onboard to connect."; exit 3; }
ME_RAW=$(curl -s --max-time 30 -w '\n%{http_code}' "$API_BASE/api/agent/me" -H "$AUTH" -H "$GH_CLIENT")
ME_HTTP=$(printf '%s' "$ME_RAW" | tail -n 1); ME=$(printf '%s' "$ME_RAW" | sed '$d')
case "$ME_HTTP" in
  401|403) echo "STOP: Ghost Hunting rejected the API key from $KEY_SHOW — revoked or expired. Type /ghost-onboard to reconnect."; exit 3 ;;
  000) echo "STOP: Could not reach Ghost Hunting at $API_BASE. Check your connection, then try again."; exit 3 ;;
  200) ;;
  *) echo "⚠ Ghost Hunting answered HTTP $ME_HTTP for the identity check; continuing." ;;
esac
ME_ORG=$(printf '%s' "$ME" | jq -r '.org_id // empty' 2>/dev/null)
if [ "$ME_HTTP" = 200 ] && [ -n "$CFG_ORG_ID" ] && [ "$ME_ORG" != "$CFG_ORG_ID" ]; then
  echo "STOP: You're signed in to $(printf '%s' "$ME" | jq -r '.org_name // "a different Coven"' 2>/dev/null), but this repo belongs to ${CFG_ORG_NAME:-Coven $CFG_ORG_ID}. The API key from $KEY_SHOW is for the wrong Coven (organization). Type /ghost-onboard to connect to ${CFG_ORG_NAME:-the right one}."; exit 3
fi
echo "$ME" | jq -r '"agent: \(.name)  contract: \(.client_contract.status // "unknown")"'
echo "$ME" | jq -r '.client_contract.message // empty'
# ── End Ghost-kit Phase 0 ──
```

**Preflight verdict:** if `client_contract.status` is `unsupported`, STOP — tell the user to update ghost-kit before continuing. If `outdated`, print the message and continue. `current`/`unknown` → proceed silently.

**Generic mode (no `.ghost/config.json`):** everything still works via the block's defaults — prod API, `GHOST_HUNTING_API_KEY` from `$REPO_ROOT/.env`, then the legacy `~/.claude/.env` (a config naming `auth.prod.org_id` reads the signed-in `GHOST_HUNTING_API_KEY__<ORG8>` from `~/.config/ghost-hunting/.env` instead — see Phase 0); `isolation.mode=none`, `browser.tool=none` (skip browser verify and note it), tests skipped with a warning unless `scripts/test.sh` exists at the repo root.

**Worktree note:** the Phase-0 `REPO_ROOT` is the toplevel of the tree your cwd is in. When this skill is invoked inside an isolated worktree (see Phase 1), that IS the tree under review — correct. Never substitute the session's original project-directory hint for it.

**Use `$API_BASE`, `$AUTH`, and `$GH_CLIENT` on every API call in this skill.**

Fetch the manifest:

```bash
curl -s "$API_BASE/api/agent/manifest" | jq .
```

### 0b. Resolve the ghost

**If a UUID or title fragment is provided in the invocation input:**

UUID: `curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}" -H "$AUTH" -H "$GH_CLIENT"`

Title fragment: `curl -s "$API_BASE/api/agent/search?q={QUERY}" -H "$AUTH" -H "$GH_CLIENT"` — pick from the `tasks` array. If multiple matches, prefer ghosts whose haunting belongs to this repo's séance — **except in `coven` scope** (`cfg '.seance.scope'` = `coven`), where the backlog spans the whole coven, so there is no séance to prefer: disambiguate coven-wide and SKIP the resolution below. In `seance` scope (or absent), use `cfg '.seance.id'` directly when present, otherwise resolve once via

```bash
SEANCE_ID=$(cfg '.seance.id')
[ -z "$SEANCE_ID" ] && SEANCE_ID=$(curl -s "$API_BASE/api/agent/seances" -H "$AUTH" -H "$GH_CLIENT" \
  | jq -r --arg re "$(cfg '.seance.selector')" '.items[] | select(.name | test($re; "i")) | .id')
```

(empty selector → fuzzy-match the repo name; interactive: confirm the fuzzy match with the user before writing anything; autonomous/orchestrated: abort on fuzzy match; suggest pinning the UUID into `.ghost/config.json`). Still ambiguous → ask the user.

**If no argument provided:**

Check agent's current assignments for `active_haunt` or `purgatory` ghosts:

```bash
curl -s "$API_BASE/api/agent/my-assignments" -H "$AUTH" -H "$GH_CLIENT"
```

If exactly one `active_haunt` or `purgatory` ghost: use it.
If multiple: list them and ask the user to clarify.
If none: report "No active or in-review ghosts to review" and stop.

### 0c. Read context payload

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/context" -H "$AUTH" -H "$GH_CLIENT"
```

Extract: `objective`, `acceptance_criteria`, `constraints`, `files`.

If `acceptance_criteria` is empty/missing/null, note this — the review will be general code quality only (no per-criterion pass/fail).

### 0d. Check for existing review EVPs

```bash
curl -s "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" -H "$AUTH" -H "$GH_CLIENT"
```

Normalize the response before inspecting it: current list endpoints return
`{items: [...]}`, while older deployments may return a bare array for EVPs.
Treat either shape as the same list. If a recent EVP (last hour) contains
"Spectral Review" or "Adversarial Review", note it. Skip the panel in Phase 3d
— **unless `--force-panel` is set, then always run it.**

> **CHECKPOINT — Phase 0 complete.** Proceed to Phase 1.

---

## Phase 1 — Gather Changes

### 1a. Anchor to the tree under review

This skill may run inside an **isolated worktree** rather than the main checkout — repos with `cfg '.isolation.mode'` = `worktree` run `commence-haunt` (and orchestrated lanes) in per-ghost worktrees, and the diff gate invokes this skill from there. The session's original project directory may still point at the MAIN checkout — **ignore it**. Anchor every git command, file read, and script invocation to:

```bash
GITROOT=$(git rev-parse --show-toplevel)
```

evaluated in the directory the caller pointed you at. When `cfg '.isolation.mode'` is `none` (or config is absent), `$GITROOT` is simply the main checkout and this is a no-op — nothing to skip or configure.

### 1b. Detect the base branch

If `--base=BRANCH` flag is present, use that branch.

Otherwise, auto-detect:

```bash
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/origin/@@'
```

If that fails, fall back to `main`. Store as `$BASE_BRANCH`. (Inside a worktree, `origin/main...HEAD` is a real, non-empty diff scoped to this ghost only — no other session's uncommitted changes leak in.)

### 1c. Get the diff

```bash
git diff $BASE_BRANCH...HEAD --name-only
```

If no diff (e.g., on the base branch), try:

```bash
git diff HEAD~1 --name-only
```

If still no diff, check for unstaged/staged changes:

```bash
git diff --name-only
git diff --cached --name-only
```

If NO changes found at all: report "No changes to review" and stop.

### 1d. Cap and read changed files

Collect the list of changed files. **Cap at 30 files.** If more than 30 files changed:

- Sort by change size (most lines changed first): `git diff $BASE_BRANCH...HEAD --stat`
- Read the top 30 most-changed files
- Summarize the remaining files by name only

Read each changed file using the host's file-reading capability (absolute paths under `$GITROOT`). Also read any files in the context payload `files` field that aren't already in the diff.

### 1e. Find and read related test files

For each changed file, locate its tests per the active project guidance (`AGENTS.md` when present, otherwise a configured fallback such as `CLAUDE.md`) — typically a test directory file matching the module name (e.g. `test_<module>.*`) or a co-located `*.test.*` / `*.spec.*` file. Read the discovered test files.

> **CHECKPOINT — Phase 1 complete.** Proceed to Phase 2.

---

## Phase 2 — Run Tests (unless `--no-tests`)

If `--no-tests` flag is present, skip to Phase 3.

### 2a. Pick the suites and commands from config

Run only the suite(s) the Phase-1 diff touches. Commands come from the repo's config and run **from the root of the tree under review** (`$GITROOT`):

```bash
T_BACKEND=$(cfg '.tests.backend'); T_FRONTEND=$(cfg '.tests.frontend'); T_ALL=$(cfg '.tests.all')
```

**Know your test runner's flag conventions:** some runners treat an unrecognized bare word as a filter/filename arg and, matching nothing, silently fall back to running the *whole* suite anyway — so a command like `test.sh backend` can run everything (sometimes twice) under a bogus filter. Verify the repo's `.tests.*` commands use the runner's real mode flags (e.g. `--backend`), not bare words.

- Diff touches only backend code → run `$T_BACKEND`.
- Diff touches only frontend code → run `$T_FRONTEND`.
- Diff touches both, or the split is unclear → run `$T_ALL` (or both individual commands if `.tests.all` is empty).
- **If the needed key is empty** (and `.tests.all` can't cover it): skip that gate and print a clear warning line, e.g. `WARN: test gate skipped — no '.tests.backend' command in .ghost/config.json`. Record the skipped gate in the Phase-4 EVP's Test Results ("skipped — not configured"). Generic-mode fallback: if there is no config at all but `$GITROOT/scripts/test.sh` exists, use it; otherwise skip with the warning.

### 2b. Run — with scratch-DB isolation when configured

**Config-gated:** only when `cfg '.isolation.mode'` = `worktree` AND `cfg '.isolation.db_script'` is set, run backend tests against a per-session scratch DB so concurrent review/implement sessions never collide on the shared test database:

```bash
MODE=$(cfg '.isolation.mode')
DB_SCRIPT=$(cfg '.isolation.db_script'); DB_PREFIX=$(cfg '.isolation.db_prefix')
if [ "$MODE" = "worktree" ] && [ -n "$DB_SCRIPT" ]; then
  SLUG="rev$(printf '%s' "{GHOST_ID}" | tr -dc 'a-z0-9' | cut -c1-14)"
  "$GITROOT/$DB_SCRIPT" create "${DB_PREFIX}_${SLUG}_test"
  ( cd "$GITROOT" && DATABASE_URL=$("$GITROOT/$DB_SCRIPT" url "$SLUG") sh -c "$T_BACKEND" )
  "$GITROOT/$DB_SCRIPT" drop "${DB_PREFIX}_${SLUG}_test"   # ALWAYS drop, even on test failure
else
  ( cd "$GITROOT" && sh -c "$T_BACKEND" )                  # isolation.mode=none → run directly; no ceremony
fi
```

(The exact `create`/`url`/`drop` argument shapes are the contract of the repo's own db script named in config — follow that script's usage output if it differs.) Frontend tests don't need the scratch DB — run `$T_FRONTEND` directly from `$GITROOT` in either mode.

When `isolation.mode` is `none` or absent, skip the scratch-DB branch cleanly — no warnings needed; just run the configured commands from `$GITROOT`.

### 2c. Record results

Record:

- Total tests run
- Pass count
- Fail count
- Specific failures: file, test name, error message
- Any suite skipped for lack of a configured command (carry the warning into the EVP)

Use a generous timeout (up to 10 minutes for a full suite). If tests hang, report "Tests timed out" as a concern.

> **CHECKPOINT — Phase 2 complete.** Proceed to Phase 3.

---

## Phase 3 — Code Review Analysis

### 3a. Acceptance criteria compliance

If acceptance criteria exist in the context payload, evaluate each one:

- **Met** — Code clearly satisfies it. Cite the specific file:line as evidence.
- **Partially Met** — Some aspects addressed, others missing. Explain what's missing.
- **Not Met** — No evidence in the diff that this criterion is addressed.
- **Not Applicable** — Criterion doesn't apply to the changes made.

### 3b. Code quality analysis

Check for these categories. Only report actual findings, not a clean bill of health per category:

**Security:**

- SQL injection (raw queries without parameterization)
- XSS (unsanitized user input in frontend rendering)
- Auth bypass (missing auth dependencies/guards on new endpoints)
- Secrets in code (hardcoded keys, passwords)

**Conventions:**

- Violations of the active project guidance (naming, layering, UI-string/terminology helpers, field-name conventions)
- Test-runner usage (use the repo's configured test commands, not ad-hoc invocations)
- Import ordering, unused imports

**Performance:**

- N+1 query patterns (loops with individual DB queries)
- Missing pagination on list endpoints
- Unbounded loops or recursion
- Large payloads without limits

**Architecture:**

- Does the change follow the repo's layering conventions (per the active project guidance and `cfg '.implement.notes'`)?
- Are new endpoints/routes registered where the repo expects them?
- Frontend: are hooks/context/component patterns used consistently?

**Repo lint gate (runs REGARDLESS of `--no-tests`):** if `cfg '.review.lint'` is non-empty, run it here — **CI enforces these linters/ratchets but the test commands don't run them, and the interactive diff-review path always passes `--no-tests`** (`commence-haunt`'s Phase 3.5 diff gate invokes `review-haunt … --no-tests`), so Phase 3b is the ONLY place they can gate. Anchor to the tree under review — never the session's original project-directory hint (that may be MAIN; on the commence-haunt Phase 3.5 path this skill runs inside the ghost's worktree), and run it from the repo root:

```bash
GITROOT=$(git rev-parse --show-toplevel)
LINT=$(cfg '.review.lint')
[ -n "$LINT" ] && ( cd "$GITROOT" && sh -c "$LINT" )
```

Lint failures are **findings** — fold each into the categories above, mapping the lint class to its review category (style/format linters → **Conventions**; a security / multi-tenancy / org-scoping ratchet → **Security**; a typecheck → **Architecture**). `.review.lint` is the **sanctioned mechanism** for repo-specific lint — do NOT hand-roll repo-specific lint invocations here; a repo that enforces linters/ratchets in CI puts the `--no-tests`-surviving ones in `.review.lint`, and any that its test command already runs in `.tests.*`. If a config test command surfaced lint failures in Phase 2, fold those in too.

### 3c. Test coverage analysis

- Are all new code paths covered by tests?
- Are edge cases tested (empty inputs, invalid IDs, auth failures)?
- Are there missing test scenarios?

**E2E coverage (UI-facing diffs):** if the repo maintains an E2E suite, do a **coverage check only** — does a UI-facing diff carry an authored/updated E2E spec? If not, that's a coverage gap → **NEEDS WORK** (see Verdict rules). E2E **execution** is the merge gate's job (`ghost-hunting-core:merge-haunt`), not review-haunt's — never boot a server stack or run the E2E suite here.

### 3d. Adversarial review (`ghost-hunting-core:panel`)

Skip if a recent "Spectral Review" / "Adversarial Review" EVP already exists (from Phase 0d) — **unless `--force-panel` is set, then always run it** (orchestrators re-reviewing each cycle rely on a fresh full panel).

If the `ghost-hunting-core:panel` skill and agent delegation are available, run it on the diff with `staff-engineer` always, plus `senior-ux` and the fitting user-persona lens for frontend changes. If panel/delegation is unavailable, apply the staff-engineer rubric inline and add the senior-UX rubric for frontend changes. Merge findings into the same severity-tagged report. `--panel-reasoning-fable` is honored only on hosts that provide that option. Panel availability must never block the core review.

Pass the panel the ghost's objective and acceptance criteria from the context payload alongside the diff.

Incorporate the merged panel findings into the Phase 4 "Spectral Review" report — the panel's `blocker` / `concern` / `nitpick` tags map straight onto the report's Code Quality section. Treat any panel `blocker` as a FAIL condition for the verdict.

### 3e. Browser verification (config-gated)

For UI-facing diffs only. The tool comes from config:

```bash
BROWSER_TOOL=$(cfg '.browser.tool')   # playwright | claude-in-chrome | none (default)
```

- **`playwright`** — prefer the `mcp__playwright__*` tools when available; otherwise use the host's available browser/computer-use capability. If neither exists, record an explicit capability skip.
- **`claude-in-chrome`** — use the claude-in-chrome tools when available; otherwise use another available browser/computer-use capability or record an explicit capability skip.
- **`none` or empty** — skip, and record in the EVP: "Browser verification: skipped (`browser.tool=none`)."

**Worktree caveat:** dev servers typically serve the MAIN checkout, not the worktree — under `isolation.mode=worktree` a browser pass cannot verify *unmerged worktree frontend changes*. Record "Browser verification: deferred to post-merge (worktree)" rather than reporting a false pass, and rely on the E2E coverage check (3c) instead. Never start/stop the app stack from inside this skill.

> **CHECKPOINT — Phase 3 complete.** Proceed to Phase 4.

---

## Phase 4 — Post Review EVP

### 4a. Format the review

**If acceptance criteria exist, use this template:**

```markdown
## Spectral Review — [Ghost Title]

### Acceptance Criteria

- [x] [Criterion 1] — Met. [evidence: file:line]
- [ ] [Criterion 2] — Not met. [what's missing]
- [~] [Criterion 3] — Partially met. [details]

### Code Quality

- **Blocker:** [issue] ([file:line])
- **Concern:** [issue] ([file:line])
- **Nitpick:** [suggestion]

### Test Results

- Tests: X passing, Y failing [or: "skipped — no '.tests.<suite>' command configured"]
- Coverage gaps: [list]

### Browser Verification

- [what was checked and outcome / "skipped (browser.tool=none)" / "deferred to post-merge (worktree)"]

### Verdict: [PASS / NEEDS WORK / FAIL]

[1-2 sentence summary explaining the verdict]
```

**If NO acceptance criteria, use this alternate template:**

```markdown
## Spectral Review — [Ghost Title]

### Code Quality Review

[No acceptance criteria defined — general quality review only.]

- **Blocker:** [issue] ([file:line])
- **Concern:** [issue] ([file:line])
- **Nitpick:** [suggestion]

### Test Results

- Tests: X passing, Y failing [or: "skipped — no '.tests.<suite>' command configured"]

### Browser Verification

- [outcome / skipped / deferred, as above]

### Files Reviewed

[list of changed files]

### Verdict: [PASS / NEEDS WORK / FAIL]

[1-2 sentence summary]
```

**Verdict rules:**

- **PASS** — All criteria met (or none defined), all executed tests pass, and the panel found **no `blocker`s**.
- **NEEDS WORK** — No blockers, but criteria only partially met, `concern`/`nitpick` findings to address, or a UI-facing diff with no authored/updated E2E spec in a repo that maintains an E2E suite (a coverage gap).
- **FAIL** — **Any panel `blocker`**, test failures, or acceptance criteria clearly not met.

A skipped test gate (no configured command) does not by itself change the verdict, but it MUST appear in Test Results so humans can weigh it.

### 4b. Post the EVP

Write the review to a temp file and post with `jq --rawfile` (never inline `\n` in shell strings — it renders as one escaped line):

```bash
REVIEW_MD=$(mktemp)
# ... write the formatted review markdown to "$REVIEW_MD" ...
curl -s -X POST "$API_BASE/api/agent/ghosts/{GHOST_ID}/evps" \
  -H "$AUTH" -H "$GH_CLIENT" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile content "$REVIEW_MD" '{content: $content}')"
```

(EVP body field is `content`, not `body`.)

**Imprint write-back (one call, alongside this EVP):** if the review surfaced a durable, non-obvious learning — a `gotcha` the diff tripped, a `convention` you enforced, a `fact` or `procedure` about the test / verify path, **never a decision** (raise an Augury) — record it via `POST /api/agent/imprints/batch` with scope `project` + the ghost's `project_id`, `source_task_id` = `{GHOST_ID}`, a `links` citation to the ghost, and `idempotency_key` = `writeback:review:{GHOST_ID}` (retry-safe; distinct from the planner's and implementer's keys — suffix `:2` on a later review cycle that learned something new), after recalling your key phrase (`POST /api/agent/imprints/recall` with `project_id`) so you supersede (`supersedes_id`) or skip an existing Imprint rather than duplicate it (a covering hit from another Haunting or at org scope takes an org replacement — keep or widen, never sideways: that item is `"scope": "org"` with NO `project_id`) — the full idiom is `ghost-hunting-core:commence-haunt` Phase 4b-bis; the findings themselves stay in the EVP, and nothing durable learned → skip silently.

### 4c. Present to user

Display the full review in the conversation.

If verdict is **PASS** and all acceptance criteria met: ask "All criteria met and tests pass. Would you like to exorcise this ghost?"

If verdict is **NEEDS WORK** or **FAIL**: summarize what needs to be fixed.

## Error Handling

- **No ghost found:** Report and stop.
- **No diff found:** Report "No changes to review" and stop.
- **No acceptance criteria:** Proceed with general quality review using the alternate template.
- **No configured test command for a needed suite:** Skip that gate with a warning line; record "skipped — not configured" in the EVP.
- **Scratch-DB script fails (worktree mode):** Report the error, fall back to running the test command directly, and note the isolation loss as a concern in the review.
- **Test failures:** Include in review as findings. Do not block the review itself.
- **Tests time out:** Report as a concern in the review.
- **Very large diff (50+ files):** Review the 30 most-changed files, note remaining files as "not reviewed."
- **EVP content too long:** Truncate the nitpicks section first, then concerns. Always keep blockers and verdict.
- **API errors posting EVP:** Display review in conversation and warn that the EVP could not be posted.

## Key Reminders

- **EVP body field is `content`** not `body`; normalize EVP lists from either `{items: [...]}` or the legacy bare-array response.
- **`PUT /context` REPLACES** the whole payload — this skill only READS context; never write it back partially.
- **`pipeline_stage` has its own endpoint** — it is NOT part of the context payload.
- **JSON field names are standard** (`project_id`, not `haunting_id`) even though URLs use spooky names.
- **Anchor to `git rev-parse --show-toplevel`**, never the session's original project-directory hint — the tree under review may be a worktree.
- **Isolation is config-gated** — scratch-DB/worktree behavior activates only when `cfg '.isolation.mode'` = `worktree`; with `none` it degrades cleanly to plain repo-root commands.
