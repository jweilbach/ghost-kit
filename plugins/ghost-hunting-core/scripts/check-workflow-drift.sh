#!/usr/bin/env bash
# SessionStart drift check — READ-ONLY by design. Emits a one-line nudge when
# the repo's vendored workflows are stale relative to the plugin templates.
# Never writes; /ghost-sync is the write path.
set -uo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
# Check the MAIN checkout, not CWD. invoke-ritual now resolves the engine from the main
# checkout (git-common-dir), so in a worktree session the worktree's own vendored copies are
# not what executes — nagging about them would point at the wrong file.
ENGINE_ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null)
# Quiet until the repo is CONNECTED on this computer: a teammate who has not signed in yet gets
# one line from session-start.sh (/ghost-onboard), not a sync nag about files they cannot use.
ROOT_NOW=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -n "$(jq -r '.auth.prod.org_id // empty' "$ROOT_NOW/.ghost/config.json" 2>/dev/null)" ]; then
  "$DIR/ghost-kit" status --offline --repo-root "$ROOT_NOW" >/dev/null 2>&1
  [ $? -eq 3 ] && exit 0
fi
if [ -n "$ENGINE_ROOT" ] && [ -d "$ENGINE_ROOT" ] && [ "$ENGINE_ROOT" != "." ]; then
  OUT=$("$DIR/render-workflows.sh" --check --repo-root "$ENGINE_ROOT" 2>/dev/null); RC=$?
else
  OUT=$("$DIR/render-workflows.sh" --check 2>/dev/null); RC=$?
fi
if [ "$RC" -eq 3 ]; then
  V=$(jq -r '.version' "$DIR/../.claude-plugin/plugin.json" 2>/dev/null)
  echo "ghost-kit v${V:-?}: vendored workflows are out of date — run /ghost-sync to refresh:"
  echo "$OUT" | sed 's/^/  /'
fi
exit 0
