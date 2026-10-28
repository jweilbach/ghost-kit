#!/usr/bin/env bash
# ghost doctor — READ-ONLY capability preflight for a ghost-kit consumer repo.
#
# Answers ONE question per capability: can this repo run it, and if not, why not.
# Lives in the plugin (not scripts-payload/) on purpose: a repo with a missing or
# broken .ghost/config.json must still be diagnosable, and vendoring-by-config-path
# would be a chicken-and-egg. Adds zero artifacts to consumer repos.
#
# Usage: ghost-doctor.sh [--repo-root <path>] [--check] [--probe] [--json]
#   --check   terse; exit 3 if any capability is BLOCKED (hook / fleet use)
#   --probe   additionally RUN contract probes (db_script url). Off by default so
#             the SessionStart hook stays side-effect-free and fast.
#   --json    machine-readable
# Exit: 0 ok (may include WARNs) | 2 usage/parse error | 3 something BLOCKED
set -uo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$DIR/.." && pwd)
REPO_ROOT=""; MODE=human; PROBE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
    --check) MODE=check; shift ;;
    --json) MODE=json; shift ;;
    --probe) PROBE=1; shift ;;
    *) echo "ghost-doctor: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
if [ -z "$REPO_ROOT" ]; then
  # Resolve the MAIN checkout, not CWD — same reasoning as check-workflow-drift.sh: in a
  # worktree session the engine that executes comes from the main checkout (git-common-dir),
  # so a worktree-local verdict would describe files that never run.
  REPO_ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null)
  { [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT" ] && [ "$REPO_ROOT" != "." ]; } \
    || REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi
CFG="$REPO_ROOT/.ghost/config.json"
SCHEMA="$PLUGIN_ROOT/config.schema.json"

BLOCKED=0
FINDINGS=()   # SEVERITY\tCAPABILITY\tMESSAGE
add() { FINDINGS+=("$1	$2	$3"); return 0; }
# Emit findings one per line. Guarded because bash 3.2 (macOS /bin/bash) errors on
# "${FINDINGS[@]}" when the array is empty under `set -u` — i.e. on a perfectly healthy repo.
each_finding() { local sev cap msg
  [ "${#FINDINGS[@]}" -eq 0 ] && return 0
  printf '%s\n' "${FINDINGS[@]}" | while IFS=$'\t' read -r sev cap msg; do
    # Drop findings about capabilities this repo never declared. relevant() is defined
    # after the config is read; before that (early parse errors) everything passes through.
    if ! declare -f relevant >/dev/null 2>&1 || relevant "$cap"; then
      printf '%s\t%s\t%s\n' "$sev" "$cap" "$msg"
    fi
  done; }

# ── config presence + parse ───────────────────────────────────────────────────
if [ ! -f "$CFG" ]; then
  add BLOCK config ".ghost/config.json not found — this repo is not a ghost-kit consumer"
elif ! jq -e . "$CFG" >/dev/null 2>&1; then
  add BLOCK config ".ghost/config.json is not valid JSON"
fi
cfg() { [ -f "$CFG" ] && jq -r "$* // empty" "$CFG" 2>/dev/null || true; }

if [ -f "$CFG" ] && jq -e . "$CFG" >/dev/null 2>&1; then
  # ── unknown-key detection, driven by config.schema.json ────────────────────
  # This is what catches a typo like "isolaton": today it renders empty and syncs clean.
  # Keys beginning with _ are comments by convention (e.g. "_note").
  if [ -f "$SCHEMA" ]; then
    while IFS= read -r path; do
      [ -n "$path" ] && add WARN config "unknown config key \"$path\" — typo? (renders empty; nothing else would tell you)"
    done < <(jq -r --slurpfile s "$SCHEMA" '
      def known($sch): ($sch.properties // {}) | keys_unsorted;
      def walk($obj; $sch; $prefix):
        ($obj | keys_unsorted[]) as $k
        | if ($k | startswith("_")) then empty
          elif (known($sch) | index($k)) == null then "\($prefix)\($k)"
          else ( ($sch.properties[$k]) as $sub
                 | if ($obj[$k] | type) == "object" and ($sub.properties != null)
                   then walk($obj[$k]; $sub; "\($prefix)\($k).")
                   else empty end )
          end;
      walk(.; $s[0]; "")' "$CFG" 2>/dev/null)
  fi

  # ── conditional requirements the schema alone cannot express ───────────────
  ISO_MODE=$(cfg '.isolation.mode'); ISO_MODE=${ISO_MODE:-none}
  if [ "$ISO_MODE" = worktree ] && [ -z "$(cfg '.isolation.worktree_script')" ]; then
    add WARN config 'isolation.mode is "worktree" but isolation.worktree_script is unset'
  fi
  if [ -n "$(cfg '.e2e.up_script')" ]; then
    [ "$(cfg '.e2e.slug')" = "$(cfg '.e2e.gate_slug')" ] &&
      add BLOCK merge-haunt 'e2e.slug equals e2e.gate_slug — their scratch-DB lifecycles would collide'
  fi
fi

# ── script existence + executability ─────────────────────────────────────────
# The engine NEVER checks this: it only tests for an empty string, then interpolates
# the path into agent shell text. A configured-but-missing script surfaces only as a
# mid-run nonzero exit, after agents have already spawned.
check_script() { # <cfgpath> <capability> <severity-if-missing>
  local p; p=$(cfg "$1"); [ -z "$p" ] && return 0
  if [ ! -f "$REPO_ROOT/$p" ]; then add "$3" "$2" "$1 -> $p does not exist"
  elif [ ! -x "$REPO_ROOT/$p" ]; then add "$3" "$2" "$1 -> $p is not executable"
  fi
}
check_script '.isolation.db_script'       backend-wave   BLOCK
check_script '.isolation.migration_gate'  backend-wave   BLOCK
check_script '.isolation.pg_smoke'        backend-wave   WARN
check_script '.isolation.db_migrate'      migration-wave WARN
check_script '.isolation.worktree_script' backend-wave   WARN
check_script '.isolation.commit_script'   backend-wave   WARN
check_script '.e2e.up_script'             merge-haunt    WARN

# ── R7, hoisted from run-time to now ─────────────────────────────────────────
# rite-cadence.js hard-fails a backend/migration wave without these two — but only
# once a wave plan is validated, i.e. after ghosts are gathered and waves authored.
DB_SCRIPT=$(cfg '.isolation.db_script'); MIG_GATE=$(cfg '.isolation.migration_gate')
DB_MIGRATE=$(cfg '.isolation.db_migrate'); PG_SMOKE=$(cfg '.isolation.pg_smoke')
[ -z "$DB_SCRIPT" ] && add BLOCK backend-wave 'isolation.db_script unset — the scratch-Postgres manager is required (engine rule R7)'
[ -z "$MIG_GATE" ]  && add BLOCK backend-wave 'isolation.migration_gate unset — the single-head + drift gate is required (engine rule R7)'
[ -z "$PG_SMOKE" ]  && add WARN  backend-wave 'isolation.pg_smoke unset — the genuine-Postgres ORM smoke gate will be SKIPPED'
[ -z "$DB_MIGRATE" ] && add WARN migration-wave 'isolation.db_migrate unset — migration reversibility will be SKIPPED (the downgrade/upgrade roundtrip is never proven)'
[ -z "$(cfg '.isolation.commit_script')" ] && add WARN backend-wave 'isolation.commit_script unset — commits fall back to plain git with NO secret scan'
[ -z "$(cfg '.tests.frontend')" ] && [ -z "$(cfg '.tests.all')" ] && add WARN frontend-wave 'neither tests.frontend nor tests.all is set'
[ -z "$(cfg '.review.lint')" ] && add WARN merge-haunt 'review.lint unset — CI-only linters will not run in review-haunt'

# ── contract probes (opt-in: these RUN the repo's scripts) ────────────────────
if [ "$PROBE" = 1 ] && [ -n "$DB_SCRIPT" ] && [ -x "$REPO_ROOT/$DB_SCRIPT" ]; then
  URL=$("$REPO_ROOT/$DB_SCRIPT" url ghostdoctorprobe 2>/dev/null | tr -d '[:space:]')
  if [ -z "$URL" ]; then
    add BLOCK backend-wave "db_script 'url' printed nothing — the engine cannot resolve a scratch DSN"
  elif ! printf '%s' "$URL" | grep -Eq '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*/[^/?#]+'; then
    add BLOCK backend-wave "db_script 'url' returned an unparseable DSN: ${URL:0:60}"
  fi
fi

# ── version agreement across the artifacts ───────────────────────────────────
# INSTALLED is the version of the tree THIS SCRIPT came from. The SessionStart hook
# invokes it as "${CLAUDE_PLUGIN_ROOT}/scripts/ghost-doctor.sh", so PLUGIN_ROOT is the
# plugin that actually loaded. Reading the marketplace source instead described the
# AUTHORED tree, which need not be the one running -- that is what made this check blind:
# authored 1.4.0 over running 1.3.7 printed "ghost-kit v1.4.0", exit 0.
INSTALLED=$(jq -r '.version // empty' "$PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null)
GK_SRC=$(jq -r '.["ghost-kit"].installLocation // empty' "$HOME/.claude/plugins/known_marketplaces.json" 2>/dev/null)
GK_DISK=$(jq -r '.version // empty' "$GK_SRC/plugins/ghost-hunting-core/.claude-plugin/plugin.json" \
  "$HOME"/.claude/plugins/cache/ghost-kit/ghost-hunting-core/*/.claude-plugin/plugin.json 2>/dev/null | sort -V | tail -1)
# The remedy depends on WHERE the plugin comes from. A directory marketplace loads in place, so
# `claude plugin update` is a no-op there (it compares version strings and copies nothing) — telling
# a directory-sourced machine to run it was a contradiction. ghost-kit owns the one mapping.
UPDATE_HINT=$("$DIR/ghost-kit" update-hint 2>/dev/null) || UPDATE_HINT=""
[ -n "$UPDATE_HINT" ] || UPDATE_HINT="run 'claude plugin update ghost-hunting-core@ghost-kit', then restart"
[ -n "$GK_DISK" ] && [ -n "$INSTALLED" ] && [ "$GK_DISK" != "$INSTALLED" ] &&
  add WARN version "this doctor is v$INSTALLED but v$GK_DISK is on disk — $UPDATE_HINT"
# Which 1.4.0? The version-stamp fix shipped without a bump, so two trees can share a
# version string and differ in content. A pre-stamp tree reports a version read off disk
# rather than the prose it runs -- detectable: it has no PLUGIN_VERSION literal.
grep -q '^PLUGIN_VERSION="' "$PLUGIN_ROOT/PHASE0.md" 2>/dev/null ||
  add WARN version "this ghost-kit build predates the version stamp — the version its skills report is read from disk, not the prose they run (update, then restart)"
SYNCED=$(jq -r '.plugin_version // empty' "$REPO_ROOT/.ghost/sync-state.json" 2>/dev/null)
VENDORED=$(head -1 "$REPO_ROOT/.claude/workflows/rite-cadence.js" 2>/dev/null | sed -n 's/.*ghost-hunting-core v\([0-9.]*\).*/\1/p')
# Skew only matters if this repo actually vendors workflows — some repos vendor none.
# A rite runs in ext/<slug> worktrees off this checkout. /ghost-sync REWRITES the committed
# vendored .js those worktrees execute -- doing that mid-invocation is exactly the failure that
# killed a v1.3.6 run. So when a rite may be in flight, this must NOT tell anyone to sync.
#
# "An ext/ worktree exists" is NOT the signal: ext/ worktrees outlive their rites (one consumer repo
# carries 8 stale ones and 1 live). A permanently-firing caution is noise, and noise is how a
# safety message stops being read. Count a worktree as possibly-live only if it has uncommitted
# work or a very recent commit. Computed lazily -- only when a skew is actually detected.
rite_worktrees() { # -> "<live> <stale>"
  local live=0 stale=0 w head age now
  now=$(date +%s)
  while read -r w; do
    [ -d "$w" ] || continue
    if [ -n "$(git -C "$w" status --porcelain 2>/dev/null)" ]; then live=$((live+1)); continue; fi
    head=$(git -C "$w" log -1 --format=%ct 2>/dev/null || echo 0)
    age=$(( now - ${head:-0} ))
    if [ "$age" -lt "${GHOST_DOCTOR_RITE_WINDOW_SECS:-21600}" ]; then live=$((live+1)); else stale=$((stale+1)); fi
  done < <(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null \
             | awk '/^worktree /{p=$2} /^branch refs\/heads\/ext\//{print p}')
  printf '%s %s' "$live" "$stale"
}

if [ -n "$(cfg '.workflows.vendor[]')" ] && [ -n "$SYNCED" ] && [ -n "$INSTALLED" ] && [ "$SYNCED" != "$INSTALLED" ]; then
  read -r RITE_LIVE RITE_STALE <<<"$(rite_worktrees)"
  # Which side is ahead decides the severity. Plugin NEWER than the vendored engines is the normal
  # state of an auto-updating marketplace: every teammate's plugin moves on its own, while the
  # committed .claude/workflows/*.js move only when someone syncs and commits. That is a WARN that
  # names who acts — not a BLOCK on every teammate's session. Vendored NEWER than the plugin means
  # THIS machine runs stale skills against a newer engine: still a BLOCK.
  NEWEST=$(printf '%s\n%s\n' "$SYNCED" "$INSTALLED" | sort -V | tail -1)
  if [ "${RITE_LIVE:-0}" -gt 0 ]; then
    add BLOCK version "skew: skills are v$INSTALLED but vendored workflows are v$SYNCED — ${RITE_LIVE} ext/ worktree(s) look ACTIVE (uncommitted work or a commit in the last 6h), so a rite may be in flight: do NOT run /ghost-sync until it finishes (syncing rewrites the vendored engine a live invocation is executing). Sync once the tree is quiet."
  else
    # ${VAR:+...} tests for NON-EMPTY, and "0" is non-empty -- it printed "(0 stale ext/
    # worktree(s) present but idle)". Test the number.
    stale_note=""
    [ "${RITE_STALE:-0}" -gt 0 ] && stale_note=" (${RITE_STALE} stale ext/ worktree(s) present but idle — safe to sync; consider \`git worktree prune\`)"
    if [ "$NEWEST" = "$INSTALLED" ]; then
      add WARN version "skew: ghost-kit updated to v$INSTALLED but this repo's vendored workflows are v$SYNCED — rites keep running the committed v$SYNCED engine until whoever maintains this repo's ghost-kit setup runs /ghost-sync and commit; nobody else needs to act${stale_note}"
    else
      add BLOCK version "skew: skills are v$INSTALLED but vendored workflows are v$SYNCED (newer) — this computer's ghost-kit is behind the repo: $UPDATE_HINT${stale_note}"
    fi
  fi
fi

# ── capability relevance ─────────────────────────────────────────────────────
# Declared-capability detection. N/A is a first-class verdict: a frontend-only repo has no
# backend, and some repos vendor no workflows at all. Flagging either as BLOCKED for a backend
# wave is noise, and noise is how a readiness signal stops being read.
VENDORS=$(cfg '.workflows.vendor[]')
HAS_ISO=$([ -n "$DB_SCRIPT$MIG_GATE$PG_SMOKE$DB_MIGRATE$(cfg '.isolation.worktree_script')" ] && echo 1 || echo 0)
[ "$(cfg '.isolation.mode')" = worktree ] && HAS_ISO=1
HAS_BE_TESTS=$([ -n "$(cfg '.tests.backend')" ] && echo 1 || echo 0)
HAS_FE_TESTS=$([ -n "$(cfg '.tests.frontend')$(cfg '.tests.all')" ] && echo 1 || echo 0)
HAS_ANY_TESTS=$([ -n "$(cfg '.tests.backend')$(cfg '.tests.frontend')$(cfg '.tests.all')" ] && echo 1 || echo 0)
# Backend and migration waves are rite-cadence capabilities. A repo that does not vendor
# rite-cadence cannot run one, so their R7 findings are n/a there — a freshly onboarded repo with a
# backend test command and no rites is not "BLOCKED" (the narrow slice of INAPPLICABLE vs MISSING).
VENDORS_RITES=$(printf '%s\n' "$VENDORS" | grep -qx 'rite-cadence' && echo 1 || echo 0)
relevant() { case "$1" in
    version|config) return 0 ;;
    backend-wave|migration-wave) [ "$VENDORS_RITES" = 1 ] && { [ "$HAS_ISO" = 1 ] || [ "$HAS_BE_TESTS" = 1 ]; } ;;
    frontend-wave)               [ "$HAS_FE_TESTS" = 1 ] ;;
    merge-haunt)                 [ "$HAS_ANY_TESTS" = 1 ] ;;
    *) return 0 ;;
  esac; }

# Decide the exit verdict from RELEVANT findings only.
while IFS=$'\t' read -r _sev _cap _msg; do [ "$_sev" = BLOCK ] && BLOCKED=1; done < <(each_finding)

# ── capability verdicts ──────────────────────────────────────────────────────
CAPS=(frontend-wave backend-wave migration-wave merge-haunt)
verdict() { local c=$1 v=READY sev cap msg
  relevant "$c" || { echo "n/a"; return; }
  # A broken config or a version skew invalidates every capability: the engine you would
  # run is not the engine your skills expect.
  while IFS=$'	' read -r sev cap msg; do
    [ "$sev" = BLOCK ] || continue
    case "$cap" in
      "$c"|version|config) echo BLOCKED; return ;;
      backend-wave) [ "$c" = migration-wave ] && { echo BLOCKED; return ; } ;;
    esac
  done < <(each_finding)
  while IFS=$'	' read -r sev cap msg; do
    [ "$sev" = WARN ] || continue
    case "$cap" in "$c") v=DEGRADED ;; backend-wave) [ "$c" = migration-wave ] && v=DEGRADED ;; esac
  done < <(each_finding)
  echo "$v"; }

if [ "$MODE" = json ]; then
  { printf '{"repo_root":%s,"plugin_version":%s,"capabilities":{' "$(jq -Rn --arg v "$REPO_ROOT" '$v')" "$(jq -Rn --arg v "${INSTALLED:-}" '$v')"
    sep=""; for c in "${CAPS[@]}"; do printf '%s%s:%s' "$sep" "$(jq -Rn --arg v "$c" '$v')" "$(jq -Rn --arg v "$(verdict "$c")" '$v')"; sep=","; done
    printf '},"findings":['; sep=""
    while IFS=$'\t' read -r sev cap msg; do
      printf '%s{"severity":%s,"capability":%s,"message":%s}' "$sep" "$(jq -Rn --arg v "$sev" '$v')" "$(jq -Rn --arg v "$cap" '$v')" "$(jq -Rn --arg v "$msg" '$v')"; sep=","
    done < <(each_finding); printf ']}\n'; }
  [ "$BLOCKED" = 1 ] && exit 3 || exit 0
fi

if [ "$MODE" = check ]; then
  if [ "$BLOCKED" = 1 ]; then
    echo "ghost doctor [$(basename "$REPO_ROOT")]: BLOCKED"
    while IFS=$'\t' read -r sev cap msg; do [ "$sev" = BLOCK ] && echo "  $cap: $msg"; done < <(each_finding)
    exit 3
  fi
  exit 0
fi

echo "ghost doctor — $(basename "$REPO_ROOT")  (ghost-kit v${INSTALLED:-?}${SYNCED:+, vendored v$SYNCED})"
for c in "${CAPS[@]}"; do printf '  %-16s %s\n' "$c" "$(verdict "$c")"; done
if [ ${#FINDINGS[@]} -gt 0 ]; then
  echo
  for want in BLOCK WARN; do
    while IFS=$'\t' read -r sev cap msg; do
      [ "$sev" = "$want" ] && printf '  %-5s %-15s %s\n' "$sev" "$cap" "$msg"
    done < <(each_finding)
  done
fi
[ "$BLOCKED" = 1 ] && exit 3 || exit 0
