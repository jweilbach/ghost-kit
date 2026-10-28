#!/usr/bin/env bash
# ghost fleet — run ghost doctor across every ghost-kit consumer repo on this machine
# and print one matrix. READ-ONLY.
#
# Discovers repos rather than hardcoding a list: any directory containing
# .ghost/config.json under the search roots. Default root is the parent of the ghost-kit
# install location (repos live alongside the plugin repo), overridable with --root.
#
# Usage: ghost-fleet.sh [--root <dir>]... [--probe] [--json]
# Exit: 0 all repos OK | 3 at least one repo BLOCKED | 2 usage error
set -uo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
DOCTOR="$DIR/ghost-doctor.sh"
ROOTS=(); PROBE=""; JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOTS+=("${2:-}"); shift 2 ;;
    --probe) PROBE="--probe"; shift ;;
    --json) JSON=1; shift ;;
    *) echo "ghost-fleet: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
if [ "${#ROOTS[@]}" -eq 0 ]; then
  GK_SRC=$(jq -r '.["ghost-kit"].installLocation // empty' "$HOME/.claude/plugins/known_marketplaces.json" 2>/dev/null)
  [ -n "$GK_SRC" ] && ROOTS=("$(dirname "$GK_SRC")") || ROOTS=("$HOME/Desktop")
fi
[ -x "$DOCTOR" ] || { echo "ghost-fleet: ghost-doctor.sh not found next to this script" >&2; exit 2; }

REPOS=$(for r in "${ROOTS[@]}"; do
  find "$r" -maxdepth 3 -type f -path '*/.ghost/config.json' 2>/dev/null
done | sed 's|/\.ghost/config\.json$||' | sort -u)
[ -n "$REPOS" ] && REPOS=$(printf '%s\n' "$REPOS" | while read -r p; do
  # only real git checkouts, and only the MAIN checkout of each (skip worktrees, which
  # share the same config and would double-count)
  [ -d "$p/.git" ] && printf '%s\n' "$p"
done)

if [ -z "$REPOS" ]; then echo "ghost-fleet: no ghost-kit repos found under: ${ROOTS[*]}" >&2; exit 2; fi

WORST=0
if [ "$JSON" = 1 ]; then
  printf '['; sep=""
  while read -r p; do
    out=$("$DOCTOR" --repo-root "$p" --json $PROBE 2>/dev/null); rc=$?
    [ "$rc" -eq 3 ] && WORST=3
    printf '%s%s' "$sep" "$out"; sep=","
  done <<<"$REPOS"
  printf ']\n'; exit "$WORST"
fi

printf '%-16s %-8s %-9s %-9s %-9s %-9s  %s\n' REPO VERSION FRONTEND BACKEND MIGRATION MERGE NOTES
printf '%s\n' "----------------------------------------------------------------------------------------"
while read -r p; do
  j=$("$DOCTOR" --repo-root "$p" --json $PROBE 2>/dev/null); rc=$?
  [ "$rc" -eq 3 ] && WORST=3
  name=$(basename "$p")
  ver=$(printf '%s' "$j" | jq -r '.plugin_version // "?"' 2>/dev/null)
  fe=$(printf '%s' "$j" | jq -r '.capabilities["frontend-wave"] // "?"' 2>/dev/null)
  be=$(printf '%s' "$j" | jq -r '.capabilities["backend-wave"] // "?"' 2>/dev/null)
  mg=$(printf '%s' "$j" | jq -r '.capabilities["migration-wave"] // "?"' 2>/dev/null)
  mh=$(printf '%s' "$j" | jq -r '.capabilities["merge-haunt"] // "?"' 2>/dev/null)
  n=$(printf '%s' "$j" | jq -r '[.findings[]? | select(.severity=="BLOCK")] | length' 2>/dev/null)
  # Repo-level blocks (version skew, broken config) are the actionable headline — a
  # capability-level block is often downstream of them.
  note=$(printf '%s' "$j" | jq -r '
    ([.findings[]? | select(.severity=="BLOCK")]) as $b
    | (first($b[] | select(.capability=="version" or .capability=="config") | .message)
       // first($b[] | .message) // "")' 2>/dev/null)
  [ "${n:-0}" -gt 1 ] && note="$note (+$((n-1)) more)"
  printf '%-16s %-8s %-9s %-9s %-9s %-9s  %s\n' "$name" "$ver" "$fe" "$be" "$mg" "$mh" "${note:0:64}"
done <<<"$REPOS"
exit "$WORST"
