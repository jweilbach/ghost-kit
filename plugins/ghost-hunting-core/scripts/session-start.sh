#!/usr/bin/env bash
# SessionStart (matcher: startup) — READ-ONLY, offline, fast, and it ALWAYS exits 0.
#
# Speaks as hook JSON — {"systemMessage": <the line the user sees>,
# "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": <what Claude sees>}} —
# in exactly these cases, and stays silent otherwise:
#   1. the repo's .ghost/config.json names auth.prod.org_id but this computer holds no key for that
#      Coven → the teammate line ("…this computer isn't signed in. Type /ghost-onboard").
#   2. no config here AND no Ghost Hunting key anywhere on this computer → the first-time line, at
#      most once a day (marker: ~/.config/ghost-hunting/.onboard-hint). Silent on a machine whose
#      ghost-kit is a directory (development) marketplace.
#   3. a connected repo → the existing read-only checks (vendored-workflow drift, ghost doctor
#      --check), which say nothing unless something needs doing.
# An unrelated repo on a signed-in machine hears nothing. Never writes anything but the marker.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
INPUT=$(cat 2>/dev/null || true)
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ghost-hunting"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

if ! command -v jq >/dev/null 2>&1; then
  # Nothing below can run without jq. Speak only where ghost-kit is clearly expected.
  if [ -f "$(git rev-parse --show-toplevel 2>/dev/null)/.ghost/config.json" ]; then
    printf '%s\n' '{"systemMessage":"ghost-kit needs jq, which is not installed on this computer. Install it (macOS: brew install jq), then restart Claude Code.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"ghost-kit skills cannot run: jq is not installed. Tell the user to install jq before using any Ghost Hunting skill."}}'
  fi
  exit 0
fi

emit() { jq -cn --arg s "$1" --arg c "$2" '{systemMessage: $s, hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'; }

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] && [ -d "$CWD" ] || CWD=${CLAUDE_PROJECT_DIR:-$PWD}
cd "$CWD" 2>/dev/null || exit 0
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CFG="$ROOT/.ghost/config.json"

if [ -f "$CFG" ]; then
  ORG_ID=$(jq -r '.auth.prod.org_id // empty' "$CFG" 2>/dev/null)
  ORG_NAME=$(jq -r '.auth.prod.org_name // empty' "$CFG" 2>/dev/null)
  if [ -n "$ORG_ID" ]; then
    "$DIR/ghost-kit" status --offline --repo-root "$ROOT" >/dev/null 2>&1
    if [ $? -eq 3 ]; then
      emit "This repo tracks its work in Ghost Hunting (${ORG_NAME:-its Coven}), but this computer isn't signed in. Type /ghost-onboard to connect." \
        "ghost-kit: this repo's .ghost/config.json binds it to the Ghost Hunting Coven (organization) ${ORG_NAME:-} ${ORG_ID}, and this computer has no API key for it. Every ghost-kit skill will stop until the user types /ghost-onboard; suggest that before any Ghost Hunting work."
      exit 0
    fi
  fi
  # Connected: the read-only checks that existed before 1.10.0, now voiced through one JSON reply.
  OUT=$( { "$DIR/check-workflow-drift.sh" 2>/dev/null; "$DIR/ghost-doctor.sh" --check 2>/dev/null; } | sed '/^[[:space:]]*$/d')
  [ -n "$OUT" ] && emit "$OUT" "$OUT"
  exit 0
fi

# Not a connected repo. Quiet unless this computer has never signed in at all.
machine_has_key() {
  [ -n "${GHOST_HUNTING_API_KEY:-}" ] && return 0
  grep -q '^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}GHOST_HUNTING_[A-Z_]*API_KEY[A-Z0-9_]*=' \
    "$CONF_DIR/.env" "$CLAUDE_DIR/.env" 2>/dev/null
}
machine_has_key && exit 0
MP=$(jq -r '.["ghost-kit"].source.source // empty' "$CLAUDE_DIR/plugins/known_marketplaces.json" 2>/dev/null)
[ "$MP" = directory ] && exit 0
TODAY=$(date +%Y-%m-%d)
MARKER="$CONF_DIR/.onboard-hint"
[ "$(cat "$MARKER" 2>/dev/null)" = "$TODAY" ] && exit 0
{ mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR" && printf '%s\n' "$TODAY" > "$MARKER"; } 2>/dev/null
emit "ghost-kit is installed. Type /ghost-onboard to sign in to Ghost Hunting and connect this repo." \
  "ghost-kit (the Ghost Hunting plugin) is installed, but this computer has never signed in and this repo is not connected. If the user wants to track work in Ghost Hunting, suggest /ghost-onboard. Do not bring it up otherwise."
exit 0
