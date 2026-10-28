---
name: merge-haunt
description: Sweep open ext/* worktree PRs into the default branch — merge-preview each against fresh main in an isolated gate worktree, run targeted local test gates (CI-independent), autonomously fix conflicts and red gates, then squash-merge with head pinning. Explicit PR-number arguments may also name non-ext/* branches (never bot PRs). Use when the user says "merge haunt", "merge haunts", "merge the prs", "land the prs", or "pr sweep". Designed to be looped: `/loop /merge-haunt` or `/loop 30m /merge-haunt`.
allowed-tools: Bash, Read, Grep, Glob
---

# Merge Haunt

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.


Merge every open PR in the discovered set into the default branch, one at a
time, gating each on **local** suites run against the merged-preview tree.
Without arguments the set is open PRs whose head matches `ext/*` (the
ghost-hunting-core:commence-haunt / extermination-workflow worktree
convention); explicit PR-number arguments may extend it to any non-draft,
non-bot head branch. CI may be billing-dead (checks "fail" in ~2s with zero
steps executed) — **local gates are authoritative.** Conflicts and red gates
get **actually fixed** on the PR branch, not escalated.

Single-pass and idempotent: one invocation processes the current PR set and
exits. Run it on a loop for continuous merging. A no-op pass (no open `ext/*`
PRs) costs one `gh` call and a few seconds.

**Scope guard: NEVER touch PRs outside the discovered set.** Bot-authored PRs
(dependabot etc.) never qualify, even when their numbers are passed as
arguments. This skill never modifies the primary checkout's working tree and
never calls any worktree/DB script's `reap`. Its Ghost Hunting surface is the
Phase-0 contract preflight only — no EVPs, no exorcism; ghost status updates
are the caller's concern. Its write surface is git/GitHub plus Phase 3's
verification probes; **prod is strictly read-only.**

## Arguments

Arguments provided: $ARGUMENTS

Optional: a list of PR numbers to restrict the sweep to (e.g. `139 141`).
Default: all open `ext/*` PRs.

Explicitly-listed PR numbers are the user's consent to sweep those PRs even
when their heads are NOT `ext/*` (e.g. `feat/whatever`, `fix/thing`).
Bot-authored PRs are refused regardless. Without arguments, discovery stays
`ext/*`-only.

**Branch/slug rule for non-ext heads:** everywhere this skill says
`ext/<slug>`, read the PR's real head branch `<branch>`. Resolve the worktree
slug **lookup-first**: check `git worktree list --porcelain` for a worktree
already holding `<branch>` and use its existing path (house worktrees don't
always follow a derivable naming rule, and git refuses a second checkout of
the same branch). Only when no worktree holds the branch, derive a fresh
slug: `<slug>=$(printf %s "<branch>" | tr '/' '-')`.

## Phase 0 — Preflight

**0a. Ghost-kit Phase 0.**

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
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/merge-haunt${WF_STAMP:+ wf/$WF_STAMP}"

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

- **Preflight verdict:** if `client_contract.status` is `unsupported`, STOP —
  tell the user to update ghost-kit before continuing. If `outdated`, print
  the message and continue. `current`/`unknown` → proceed silently.
- That preflight is this skill's ONLY Ghost Hunting API touch. No séance
  resolution, no writes. A `--local` flag (only honored when the config sets
  `api.allow_local_switch: true`; set `GK_LOCAL=1` before the block) affects
  the preflight target only — gates and merges are local git either way.

**0b. Config reads (this skill's parameters).**

```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/origin/@@')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
TEST_BACKEND=$(cfg '.tests.backend'); TEST_FRONTEND=$(cfg '.tests.frontend'); TEST_ALL=$(cfg '.tests.all')
ISO_MODE=$(cfg '.isolation.mode'); ISO_MODE=${ISO_MODE:-none}
WT_SCRIPT=$(cfg '.isolation.worktree_script')
DB_SCRIPT=$(cfg '.isolation.db_script')
MIG_GATE=$(cfg '.isolation.migration_gate')
DB_PREFIX=$(cfg '.isolation.db_prefix'); DB_PREFIX=${DB_PREFIX:-ghost}

# Optional e2e stack (all empty in repos without a merged-tree e2e runner → the
# entire e2e execution machinery below no-ops; only the coverage-check policy applies):
E2E_UP=$(cfg '.e2e.up_script')          # e.g. scripts/ext-serve.sh (the MAIN copy is always the one invoked)
E2E_SLUG=$(cfg '.e2e.slug')             # e.g. mge2e — the e2e leg's DB slug
E2E_GATE_SLUG=$(cfg '.e2e.gate_slug')   # e.g. mggate — the pytest leg's slug (MUST differ from E2E_SLUG)
E2E_PORTS=$(cfg '.e2e.ports[]')         # e.g. 9000 3005 — fixed ports the stack binds
E2E_LOCK=$(cfg '.e2e.lock_dir')         # e.g. .claude/state/e2e-stack.lock.d (in the MAIN checkout)
E2E_DEBT=$(cfg '.e2e.debt_file')        # e.g. .claude/state/merge-haunt-e2e-debt
```

Generic mode (no `.ghost/config.json`, or empty `tests.*`): if
`scripts/test.sh` exists, use `scripts/test.sh backend` / `scripts/test.sh
frontend` / `scripts/test.sh` as the three gate commands. Otherwise the test
gates are **skipped with a LOUD warning** — say so per PR and in the final
report; the merge bar degrades to a clean merge preview plus whatever
migration/lint checks still apply. Never silently pretend a gate ran.

**0c. Lock (atomic).** From the MAIN checkout (`git rev-parse --git-dir` ==
`--git-common-dir`):

```bash
mkdir -p .claude/state
LOCK=.claude/state/merge-haunt.lock.d
if mkdir "$LOCK" 2>/dev/null; then
  date -u +%Y-%m-%dT%H:%M:%SZ > "$LOCK/started"; uuidgen > "$LOCK/run-id"
else
  # Held. Stale only if older than 3h (a multi-PR run with backend suites can be long).
  # Do NOT use PID-liveness — every Bash call is a transient shell.
  # < 3h old → report "another merge-haunt run holds the lock" and STOP.
  # ≥ 3h old → stale takeover: rm -rf "$LOCK", re-acquire via mkdir.
  :
fi
```

Release the lock (`rm -rf "$LOCK"`) on EVERY exit path, including no-op and
error STOPs. Refresh `$LOCK/started` after each PR so a long legitimate run
is never stolen.

**0d. Fetch + discover.**

```bash
git fetch origin --quiet
gh pr list --state open --base "$DEFAULT_BRANCH" --limit 100 \
  --json number,title,headRefName,baseRefName,isDraft,files,author
```

Keep PRs where `isDraft` is false and either `headRefName` matches `^ext/`
(default mode) or the number was explicitly listed in $ARGUMENTS (any head,
but never `author.is_bot`). **Assert `baseRefName == $DEFAULT_BRANCH` for
every kept PR** — a PR based on another PR's head means squash-merge +
branch-delete of the parent would auto-close it; retarget it
(`gh pr edit N --base "$DEFAULT_BRANCH"`) before merging its parent, or STOP
and report. **Empty set → opportunistic crash-leak cleanup, then STOP**
("nothing to merge"), in this order:

1. **E2E stack reconciliation FIRST** (config-gated — ordering matters):
   when `E2E_UP` is set and the gate worktree's e2e state dir exists (the
   up-script's per-worktree state, e.g. `$WT/.ext-serve`), run the
   port-ownership assertion (see Phase 1c-e2e) then
   `"$REPO_ROOT/$E2E_UP" down "$WT"` (the MAIN checkout's copy) **before**
   removing the worktree — reaping first deletes the PID state and orphans
   running servers, making every future leg exit "ports busy" and silently
   disabling e2e forever.
2. Remove the leaked `mggate` gate worktree and drop its scratch DBs per the
   teardown recipe in Phase 2 (all idempotent) — including the e2e scratch DB
   `${DB_PREFIX}_${E2E_SLUG}` when `E2E_UP` is set.
3. **E2E-debt clearing** (config-gated): if `E2E_DEBT` is set and non-empty
   and the e2e ports are free, run ONE full e2e leg against
   `origin/$DEFAULT_BRANCH` (provision `mggate` → up/test/down per Phase
   1c-e2e). Green → clear the debt file ("e2e debt cleared (N PRs)"). Red →
   LEAVE the debt file and report loudly — that red is on merged main; surface
   it, do NOT auto-fix main.
4. Release the lock, report.

**0e. Sibling-suite check.** If `pgrep -f 'pytest|vitest|playwright'` shows a
suite already running (another session's lane), STOP and report "deferring —
a test suite is running elsewhere". Machine-load phantom failures would
trigger bogus autonomous "fixes".

**0f. Overlap map.** From the `files` lists, note which pending PRs share
files — those clusters are where conflicts and semantic collisions are
expected after the first cluster member merges. Record for the report.

**0g. Dependency-touchers.** Any PR whose diff touches a dependency manifest
(`package.json`, `package-lock.json`, `requirements.txt`, `pyproject.toml`,
lockfiles) needs the gate worktree's installed deps to include the PR's
additions after EVERY provision (provision rebuilds or re-links deps off the
default branch, which predates the PR's new deps). How depends on how the
gate got its deps:

- **Gate owns real deps** (the worktree script installs a real venv /
  node_modules per worktree): plain re-install inside the gate after each
  merge-preview —

  ```bash
  ( cd "$WT/backend" && venv/bin/pip install -q -r requirements.txt )   # if the Python manifest changed
  ( cd "$WT/frontend" && npm install --silent --no-audit --no-fund )    # if the Node manifest changed
  ```

- **Gate shares deps by symlink** (the plain-checkout fallback, or scripts
  that symlink): Node side takes the **real-install gate path** — unlink then
  install for real:

  ```bash
  rm "$WT/frontend/node_modules"   # exact unlink form. NEVER `rm -rf`, NEVER a
                                   # trailing slash — `node_modules/` dereferences
                                   # the symlink on macOS and deletes the PRIMARY
                                   # checkout's node_modules.
  ( cd "$WT/frontend" && npm ci )
  ```

  Python side: a `pip install` into a **shared** symlinked venv would mutate
  every checkout — such PRs are **SKIPPED with a PR comment**. That is the
  one sanctioned escalation; a human lands the dependency bump.

Forgetting the re-install after a re-provision makes cycle-2 gates run
against deps missing the PR's additions — the module-not-found red then gets
misdiagnosed as a product regression inside the fix loop.

> **CHECKPOINT — Phase 0 complete.** You hold the lock and have an ordered PR
> list (ascending PR number). Process strictly serially — never two gates,
> two suites, or two merges at once.

## Gate worktree mechanics (both isolation modes)

The gate worktree is always the literal slug **`mggate`** — never a PR's
slug.

**`isolation.mode: worktree`** (repo ships a worktree script):

```bash
"$REPO_ROOT/$WT_SCRIPT" provision mggate "origin/$DEFAULT_BRANCH"   # ONLY ever the literal slug "mggate"
WT=$(git worktree list --porcelain | awk '/^worktree .*\/mggate$/{sub(/^worktree /,""); print}')
```

`provision` is **reap-first for its slug** — calling it with a PR's slug
would DELETE that PR branch. It is only ever invoked with `mggate`. The
script owns dep setup (real installs or symlinks — check its header; it
determines which Dependency-toucher path applies) and env-file copying.

Scratch DBs (when `DB_SCRIPT` is set): the backend gate runs against a
per-gate scratch DB, never the shared dev/test DB —

```bash
"$REPO_ROOT/$DB_SCRIPT" drop "${DB_PREFIX}_mggate_test"     # drop-first — a crashed run leaves partial schema
"$REPO_ROOT/$DB_SCRIPT" create "${DB_PREFIX}_mggate_test"
GATE_DB_URL=$("$REPO_ROOT/$DB_SCRIPT" url mggate)
```

If the repo's db script names differently, follow the script's own
convention — the invariants are drop-first, a name unique to this gate
(`mggate`), and never the shared dev/test DB.

**`isolation.mode: none`** (plain-checkout fallback — no house scripts):

```bash
MAIN=$(git rev-parse --show-toplevel)
WT="$(dirname "$MAIN")/.gh-merge-wt/mggate"     # OUTSIDE the repo — the main tree stays clean
git worktree remove --force "$WT" 2>/dev/null; rm -rf "$WT"; git worktree prune
git worktree add --detach "$WT" "origin/$DEFAULT_BRANCH"
for d in backend/venv backend/.venv frontend/node_modules node_modules; do   # share deps best-effort
  [ -e "$MAIN/$d" ] && [ ! -e "$WT/$d" ] && ln -sfn "$MAIN/$d" "$WT/$d"
done
for f in .env backend/.env frontend/.env; do                                # copy env files the app needs
  [ -f "$MAIN/$f" ] && cp "$MAIN/$f" "$WT/$f"
done
```

Re-create the symlinks + env copies after **every** re-provision — a fresh
worktree has none. No `DB_SCRIPT` in this mode means: run suites exactly as
the repo's test command does (self-contained suites need nothing), and never
point a gate at the shared dev database.

## Phase 1 — Per-PR loop (ascending PR number)

For each PR `N` with head branch `<branch>` (worktree slug `<slug>` per the
lookup-first rule in Arguments; for `ext/*` heads the two coincide):

**1a. Refresh.** `gh pr view N --json state,mergeable,title`. Merged/closed →
skip. Count prior merge-haunt failure comments on the PR: **≥3 → quiescent**
(skip + report; prevents `/loop` fix-ping-pong on a stuck PR — the human
takes it from there).

**1b. Merge preview.** **E2E-stack guard BEFORE the reap-first provision**
(config-gated): when `E2E_UP` is set and the gate worktree's e2e state dir
exists (a crashed prior e2e leg's PID state lives there, e.g. `$WT/.ext-serve`),
run the port-ownership assertion (Phase 1c-e2e) then
`"$REPO_ROOT/$E2E_UP" down "$WT"` (the MAIN copy) first — the reap-first
`provision` would otherwise delete that state and orphan live servers. Then
provision the gate (per your isolation mode, above) and:

```bash
BASE_SHA=$(git -C "$WT" rev-parse "origin/$DEFAULT_BRANCH")   # pin — concurrent fetches move the ref
git -C "$WT" fetch origin --quiet
HEAD_SHA=$(git -C "$WT" rev-parse "origin/<branch>")
git -C "$WT" merge --no-edit "origin/<branch>"
```

- Merge clean → gates (1c).
- Conflict → `git -C "$WT" merge --abort`, go to the fix loop (1d), then
  re-provision and re-preview.

**1c. Targeted gates** on the preview tree, scoped by
`git -C "$WT" diff --name-only "$BASE_SHA"..HEAD`:

| Diff contains | Gate (run from inside `$WT`, from the worktree root) |
|---|---|
| backend files | `$TEST_BACKEND` — with `DATABASE_URL=$GATE_DB_URL` prefixed when a scratch DB was provisioned. Also run the repo's backend linter first if it has one (check CLAUDE.md / CI config — e.g. ruff, plus any repo-specific lint ratchets); CI's exact lint pair is the gate bar. Empty `TEST_BACKEND` → warn-skip (see 0b). |
| frontend files | `$TEST_FRONTEND`, plus the repo's frontend build/typecheck if one exists (e.g. `tsc -b --noEmit` for TS repos — test runners strip types without checking; the deploy build is what must pass). Pin the repo's documented Node version first if it uses one (a glob inside a `PATH=` assignment is NOT expanded — resolve the real bin dir: `NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v22*/bin 2>/dev/null | sort -V | tail -1)"` then `PATH="$NODE_BIN:$PATH" …`). Empty `TEST_FRONTEND` → warn-skip. |
| both / neither maps cleanly | `$TEST_ALL` once (when set), instead of guessing area splits. |
| e2e spec files (only when the repo has an e2e spec dir) | Cheap compile signal: run the repo's playwright spec-compile — `--list` (compiles the specs, boots no servers), e.g. `node_modules/.bin/playwright test --list` from the e2e project dir. An early red here catches spec-compile breakage before the expensive merged-tree e2e leg (Phase 1c-e2e). |
| migration files (`migrations/`, `alembic/versions/`, etc.) | `MIG_GATE` set → `DATABASE_URL=$GATE_DB_URL "$REPO_ROOT/$MIG_GATE"` on the MERGED tree — HARD gate: single migration head, clean upgrade, no autogenerate drift. `MIG_GATE` empty → read-only single-head check only (e.g. `alembic heads` must print exactly one head — catches multi-head merge collisions); do NOT run a live upgrade against the real dev DB — note "live upgrade unverified" in the report. Some repos' migration env resolution prefers an admin-DSN env var (e.g. `DATABASE_ADMIN_URL`) over `DATABASE_URL` — blank any such admin-DSN var when pointing migrations at a scratch DB (`DATABASE_ADMIN_URL="" DATABASE_URL=$GATE_DB_URL …`), or a future admin DSN gets migrated. |

Never use the shared dev/test DB. Never run two suites concurrently.

CI checks: ignore the ~2s zero-step billing failures; a CI job that actually
executed steps and failed counts as a red gate.

**Mass-failure heuristic:** >~20 failures across unrelated files → suspect
machine load, re-run the suite once before touching any code.

**Optional e2e leg — policy** (config-gated on `cfg '.e2e.up_script'`; only
when the repo's own docs/scripts provide a merged-tree e2e runner — never
invent one): it runs HERE, on the merged preview, for product-code PRs, as a
**machine-global critical section** (one stack + suite at a time; fixed ports
are a lock, not a suggestion). Ports busy or stack locked → do not block the
merge: verify the port holders are NOT your own orphans first (`lsof` + each
holder's cwd — a holder inside a gate/lane worktree is yours; kill it and
retry once), then skip the leg, append the PR to the debt file
(`cfg '.e2e.debt_file'`), comment on the PR naming the holder, and merge on
the remaining green gates. Runner boot/seed/build failure → RED gate. Broad
e2e red (>~20 specs across unrelated features) → suspect the ENVIRONMENT
(seed/boot logs) before touching code. Teardown must never `kill -9` ports it
cannot prove it owns — a user's dev servers may hold them. If the debt file
is non-empty on a later no-op pass, run one full leg against the fresh default
branch: green clears the debt; red is on merged main — report loudly, never
auto-fix main. **When `cfg '.e2e.up_script'` is empty this whole leg is
skipped** — the coverage-check policy above (and the review gate's coverage
check) is all that applies; merge-haunt executes no e2e.

### Phase 1c-e2e — full e2e suite on the merged tree (config-gated)

**Gate condition:** this entire section fires ONLY when `E2E_UP`
(`cfg '.e2e.up_script'`) is non-empty. When it is empty, skip everything here
— the repo ships no merged-tree e2e runner, and only the policy paragraph
above applies.

When set, this is the only place authored e2e specs actually EXECUTE
(commence-haunt / review-haunt author specs but never run them). It runs
after the unit/lint gates pass, for any product-code PR. The stack is a
**machine-global critical section**: the repo's e2e config hardcodes fixed
ports (`E2E_PORTS`, e.g. `9000`/`3005` — a same-origin proxy + a hardcoded API
URL make them a lock, not a suggestion) and the up-script enforces one stack
at a time via its lock dir (`E2E_LOCK`, e.g.
`.claude/state/e2e-stack.lock.d`), exiting 4 when another run holds it.

**The leg is THREE separate Bash calls** (up / test / down) — a single call
cannot survive the Bash tool's own timeout (boot + suite + down exceeds it),
and a tool-kill mid-call would skip teardown and leak daemons. No `set -e`
anywhere in this leg.

**Call 1 — up.** Capture `RC=$?` on the IMMEDIATELY following line, nothing
between. **Always invoke the MAIN checkout's copy of the up-script** (run from
the repo root) — a worktree copy is whatever version the merged tree happens
to carry and may predate the lock mechanism; orchestration tooling runs from
main, only product code runs from the worktree. Use the e2e slug (`E2E_SLUG`,
e.g. `mge2e`), **explicitly distinct from the gate slug** (`E2E_GATE_SLUG`,
e.g. `mggate`) so the two legs' DB lifecycles never collide:

```bash
BASEURL=$("$REPO_ROOT/$E2E_UP" up "$WT" "$E2E_SLUG")
RC=$?
```

Dispatch on `$RC`:

- **0** → run the **port-ownership assertion** (below); if it passes, Call 2.
- **3 (ports busy)** → do NOT assume "the user's dev servers". Check whether
  the holders are YOUR OWN orphans: `lsof -nP` each `E2E_PORTS` entry
  (`-sTCP:LISTEN`), then cross-check each holder PID's cwd
  (`lsof -p <pid> -d cwd`) against the gate worktree AND the up-script's pids
  state file — a holder whose cwd is inside the gate/lane worktree is your
  orphan from a prior crash. Kill only proven-own orphans and retry `up`
  **ONCE**; otherwise take the **skip path**.
- **4 (stack locked)** → **skip path** (the comment names the lock owner).
- **anything else** → RED gate (seed/boot/build died; the up-script's `die`
  already tore down). Read the up-script's state-dir logs (e.g.
  `$WT/.ext-serve/{seed,backend,build}.log`) before blaming the PR, then the
  1d fix loop.

**Skip path:** append `PR#<N> <date>` to the debt file (`E2E_DEBT`), comment
on the PR naming the holder/owner, record it in the report, and proceed to the
merge decision on the **remaining green gates** (a busy/locked stack never
blocks the merge).

**Port-ownership assertion.** Cross-check the port holders against the PIDs
the up-script recorded in the gate worktree's e2e state dir (the pids file,
e.g. `$WT/.ext-serve/pids`). Run it (a) right after `up` exits 0, (b) again
before Call 3 (`down`), and (c) inside every crash-reconciliation guard:

```bash
MISMATCH=
for pt in $E2E_PORTS; do
  for p in $(lsof -ti "tcp:$pt" -sTCP:LISTEN 2>/dev/null); do
    grep -qx "$p" "$WT/.ext-serve/pids" 2>/dev/null \
      || lsof -p "$p" -a -d cwd 2>/dev/null | grep -q "$WT" \
      || MISMATCH=1
  done
done
```

(The state-dir / pids path is the up-script's own convention — follow its
header; `.ext-serve/pids` is one example.) This closes the window between the
up-script's preflight and its port binds, during which a user's own dev
servers could take a port — the up-script's health-wait can't tell whose
server answered, and `down`'s backstop would then `kill -9` the user's dev
servers. **On mismatch: NEVER call `down`** — targeted cleanup only: kill only
the PIDs listed in the pids file, drop the e2e scratch DB
(`"$REPO_ROOT/$DB_SCRIPT" drop "${DB_PREFIX}_${E2E_SLUG}"`), remove the state
dir, then treat the leg as a ports-busy skip.

**Call 2 — test.** Its own Bash call with an explicit tool `timeout: 600000` —
macOS has no `timeout`/`gtimeout` binary, so the Bash tool's 600000ms timeout
IS the hang bound. Pin the node version the repo's e2e expects (a glob inside a
`PATH=` assignment is NOT expanded — resolve the real bin dir) and invoke the
Playwright binary DIRECTLY (`node_modules/.bin/playwright`, never `npx`) with
`PLAYWRIGHT_BASE_URL` from Call 1:

```bash
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v22*/bin 2>/dev/null | sort -V | tail -1)"   # repo's expected version, e.g. node 22
PATH="$NODE_BIN:$PATH" PLAYWRIGHT_BASE_URL="$BASEURL" \
  node_modules/.bin/playwright test
```

A tool-killed Call 2 = red gate, and Call 3 still runs (that IS the recovery
path). Leftover headless browsers after a killed run are expected residue, not
a red flag — `down` reaps the servers; stray browsers die on their own.

**Call 3 — down.** Its own Bash call, **ALWAYS issued after Call 2 regardless
of outcome** — including when Call 2 died to a tool-level timeout. Run the
port-ownership assertion, then invoke the MAIN checkout's copy:
`"$REPO_ROOT/$E2E_UP" down "$WT"` (one less integrity dependency on the
worktree). **But NEVER call `down` unless `up` exited 0** — after an exit-3
preflight, `down`'s port backstop would `kill -9` whatever holds the ports,
i.e. the user's dev servers.

Then parse `N passed / M skipped` from the runner's output for the report (the
count grows as merged PRs add specs). Green → merge decision. Red → the 1d fix
loop (same 3-cycle cap; each retry re-runs up/test/down). **Red-e2e
diagnosis:** read `test-results/<dir>/error-context.md` **FIRST** — the page
snapshot instantly distinguishes login-bounce vs missing-data vs copy-rot;
never blame the PR blind. A broad red (>~20 specs across unrelated features)
means suspect the ENVIRONMENT (the up-script's seed/boot logs) before touching
code. Refresh the run-lock timestamp after the leg.

**Debt mechanics.** The skip path appends to `E2E_DEBT` + a PR comment (above).
On an **empty-set pass** (Phase 0d) with a non-empty debt file **and** free
ports, run ONE full e2e leg against `origin/$DEFAULT_BRANCH` (provision the
gate → up/test/down per this section): green clears the debt file ("e2e debt
cleared (N PRs)"); red is on merged main — surface it loudly, do NOT auto-fix
main.

**1d. Autonomous fix loop** — max 3 cycles per PR per run. All fixes happen
in the PR's OWN worktree, never in mggate.

- Worktree missing? **Look up first** — `git worktree list --porcelain` may
  show an existing worktree already holding `<branch>` (use it; a second
  checkout of the same branch is refused by git). Only if none exists,
  materialize one — **NOT** via the worktree script's `provision` (that
  creates a fresh branch off the default branch, discarding the PR):

  ```bash
  git fetch origin "<branch>:<branch>"    # refused if checked out somewhere — that's your lookup miss
  git worktree add "<worktree-root>/<slug>" "<branch>"
  ```

  Then give it deps + env the same way the gate got them (real installs when
  the repo's worktrees own real deps; symlinks + `.env` copies in fallback
  mode). `<worktree-root>` is the repo's house worktree dir when the worktree
  script documents one, else `.gh-merge-wt/` next to the repo.

- **Hygiene preamble, every cycle:** in the PR worktree:
  `git merge --abort 2>/dev/null || true`; if not porcelain-clean,
  `git reset --hard "origin/<branch>"` (a crashed prior cycle must not leak
  conflict markers); `git pull --ff-only origin "<branch>"` — on divergence
  between local and remote, HARD-STOP this PR with a comment (never
  force-push over unknown remote work).
- **Conflicts:** `git merge "origin/$DEFAULT_BRANCH"`, resolve
  **semantically** — read both sides' intent and preserve both behaviors
  (overlap-cluster PRs land in the same files; the union of both features
  must survive, including in shared tests/specs). Commit and push.
- **Red gates:** diagnose on the preview tree, apply the real fix on the PR
  branch (small behavior adjustments are in-scope — fix, don't escalate),
  commit, push.
- **Pre-push assertion (enforced backstop):**
  `git rev-list "origin/<branch>" --not HEAD` prints nothing (remote head is
  an ancestor of what you're pushing). If it prints commits, you are about to
  discard remote work — STOP this PR.
- After each fix: re-provision mggate, re-preview, re-gate (back to 1b).
- After 3 failed cycles: `git merge --abort` +
  `git reset --hard "origin/<branch>"` in the PR worktree, post one PR
  comment with the exact findings (gate output, what was tried), continue to
  the next PR.

**1e. Merge + cleanup** (all gates green):

```bash
gh pr merge N --squash \
  --match-head-commit "$HEAD_SHA" \
  --subject "<PR title> (#N)"
git push origin --delete "<branch>"       # if the repo does not auto-delete; retry once
```

- `--match-head-commit` closes the gate→merge race: a push landing after the
  final gate fails the merge instead of merging ungated. On mismatch:
  refetch, re-gate, retry once.
- The explicit `--subject` preserves the `(#N)` house convention — a repo's
  squash-title setting may otherwise title a single-commit PR's squash by its
  raw commit message.
- Local cleanup **only if provably safe**: the PR worktree is porcelain-clean
  AND its local sha == `$HEAD_SHA` → remove it (`"$WT_SCRIPT" remove <slug>`
  in worktree mode; `git worktree remove` in fallback mode). Otherwise leave
  it standing and report why (commence-haunt leaves worktrees for inspection;
  uncommitted edits must never be `rm -rf`'d).
- Non-`ext/*` heads: the local branch survives a squash-merge
  (`git branch -d` won't see it as merged) — after the worktree is safely
  removed, delete it with `git branch -D "<branch>"`; if the worktree was
  left standing, leave the branch too and report it.
- `git fetch origin`; refresh `$LOCK/started`; the next PR now previews
  against the new default branch.

> **CHECKPOINT — Phase 1 complete** when every discovered PR is merged,
> skipped-with-comment, or quiescent.

## Phase 2 — Wrap-up

1. Fast-forward the primary checkout: `git pull --ff-only` (a dirty tree is
   fine; if the ff fails, report it and leave the tree alone — never stash or
   reset the user's checkout). If a merged PR changed a Node manifest AND the
   ff succeeded, run `npm install` in the primary checkout's frontend dir —
   node_modules is not git state; leaving it stale breaks the next app start.
   Same for a Python manifest → `pip install -r requirements.txt` into the
   primary venv (only when that venv is the primary checkout's own).
2. Teardown the gate. **First, e2e-stack reconciliation** (config-gated): when
   `E2E_UP` is set and the gate worktree's e2e state dir exists (e.g.
   `$WT/.ext-serve`), run the port-ownership assertion then
   `"$REPO_ROOT/$E2E_UP" down "$WT"` (the MAIN checkout's copy) **BEFORE**
   removing the worktree — reaping first deletes the PID state with servers
   still bound, so every future leg would exit "ports busy" with a false "dev
   servers up" diagnosis, silently disabling e2e forever. Then: worktree mode →
   `"$WT_SCRIPT" remove mggate` and `"$DB_SCRIPT" drop` each `${DB_PREFIX}_mg*`
   scratch DB this skill created — including the e2e scratch DB
   `${DB_PREFIX}_${E2E_SLUG}` when `E2E_UP` is set (all idempotent). Fallback
   mode →
   `git worktree remove --force "$WT" 2>/dev/null; rm -rf "$WT"; git worktree prune`.
   Leave any PR worktree that 1e left standing.
3. Release the lock (`rm -rf "$LOCK"`).
4. Report a table: PR → merged sha | fixes applied | gates run (including
   warn-skipped gates) | e2e result if the repo has a leg | deployed
   verification results (Phase 3) | deferred PRs and why | orphaned remote
   branches | worktrees left standing. If an e2e-debt file is non-empty,
   escalate: "e2e not executed for N consecutive PRs since <date>" — not one
   forgettable row per PR.

## Phase 3 — Deployed verification (post-merge)

Runs only when the sweep merged ≥1 product-code PR — no-op passes skip it, so
`/loop` stays cheap. Targets whatever deployed environments the repo's own
docs (CLAUDE.md / manifests) declare — staging and/or prod, auto-deployed
from the default branch. **No documented deployment → skip this phase and say
so.** Writes, if any, are limited to a staging environment's verification
artifacts (left standing + reported); **prod is strictly read-only, no
writes, ever.**

1. **Deploy detection:** health endpoints rarely carry a build sha, so probe
   a ROUTE the merged set added — unauthenticated it flips 404 → 401/403 once
   the new build serves. Poll ~20s apart riding through 502/503 (deploy swap
   in progress). A set with no new route: probe a changed response shape on
   an existing endpoint, or fall back to the health endpoint alone.
   Authenticated probes only with credentials the repo's docs provide for
   that environment — never assume dev/seed creds exist on prod.
2. **Migrations by inference:** the app healthy on the new build implies the
   migration runner succeeded (a bad migration crash-loops the deploy →
   health goes red). No endpoint exposes the migration head; don't invent
   one.
3. **Targeted staging smoke, per merged PR** (only when a staging env +
   documented seed creds exist): cookie-jar/API probes asserting each PR's
   observable contract (status codes, response fields, error details).
   Negative probes for roles you cannot mint get downgraded to what IS
   assertable — say so in the report rather than faking coverage.
4. **Staging browser walkthrough, per merged PR with a user-facing surface:**
   use the repo's configured browser tool (`cfg '.browser.tool'` —
   `playwright` or `claude-in-chrome`; `none` → skip and note it). Drive each
   new/changed screen through its primary interaction — render the page, open
   the dialog, apply the control — asserting the feature's observable UI
   contract. Read-mostly: reuse artifacts step 3 already created. This is a
   WALKTHROUGH, not the spec suite — **never point a local e2e/spec suite at
   a deployed environment**: its fixtures assume local seeding, deployed rate
   limits differ, and suite writes pollute shared data.
5. **Red after merge:** diagnose + report loudly. Any fix ships as a NEW PR
   through the same local gates — never a direct-to-default-branch commit,
   never an auto-revert. A crash-looped PaaS service presents as
   connect-then-hang (curl `000` after TLS), NOT 502 — check the platform's
   deploy logs before blaming the network. Missing env-var boot raises are
   config remediation on the platform, not code fixes — escalate to the human
   for the secret write.

## Error Handling

| Scenario | Action |
|---|---|
| `gh pr merge` fails (head mismatch / protection / race) | Refetch, re-gate, retry once; else leave open + comment |
| Gate provision fails (script error, missing env file, dep install failed, symlink target missing) | STOP loudly — never gate against a broken toolchain |
| Remote branch delete fails after merge | Retry once; then report the orphan (the PR is closed, discovery won't revisit it) |
| Crash mid-run | Next invocation self-heals: Phase 0's no-op path tears down mggate + its scratch DBs; the 3h lock TTL recovers the lock |
| Local/remote PR branch divergence | Hard-stop that PR + comment — a human decides |
| Shared-symlinked venv + Python manifest change | SKIP with a comment (a shared venv must not be mutated) |
| Migration gate: two heads on the merged chain | Fix the migration chain (e.g. `down_revision`) in the PR worktree (1d), re-gate |
| e2e ports busy / stack locked (repos with an e2e leg) | Orphan-check + one retry; else skip the leg, append to the debt file, PR comment naming the holder, merge on remaining green gates |
| All test config empty and no `scripts/test.sh` | Merge only on clean preview + remaining checks, with a LOUD per-PR and report-level warning |

## Key Reminders

- **MAIN is sacred**: no commits, resets, stashes, or checkouts in the
  primary tree; only `git pull --ff-only` at wrap-up.
- **Name-scoped cleanup only** — `remove mggate` / `remove <merged-slug>`.
  NEVER any script's `reap`: other lanes' worktrees and scratch DBs must
  survive.
- Strictly serial: one preview, one suite, one merge at a time.
- `provision` is only ever called with the literal slug `mggate` — with a
  PR's slug it would delete that PR's branch.
- Semantic conflict resolution means BOTH PRs' behaviors survive — check the
  shared tests actually assert both.
- When CI comes back to life, real check failures gate again automatically —
  no skill change needed.
- Empty test config never fails silently — every skipped gate is named in
  the report.
- This skill posts nothing to Ghost Hunting. Exorcising merged ghosts belongs
  to the flow that opened the PR (ghost-hunting-core:commence-haunt, the
  extermination workflow, or the human).
