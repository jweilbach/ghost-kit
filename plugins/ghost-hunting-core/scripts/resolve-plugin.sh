#!/usr/bin/env bash
# Bootstrap-installed shim: resolve a machine-local installation without committed absolute paths.
set -euo pipefail
if [ -n "${GHOST_KIT_ROOT:-}" ] && [ -f "$GHOST_KIT_ROOT/package.json" ]; then
  printf '%s\n' "$GHOST_KIT_ROOT"; exit 0
fi
ROOT=$(git rev-parse --show-toplevel)
if [ -f "$ROOT/plugins/ghost-hunting-core/package.json" ]; then
  printf '%s\n' "$ROOT/plugins/ghost-hunting-core"; exit 0
fi
REGISTRY="${XDG_CONFIG_HOME:-$HOME/.config}/ghost-hunting/install.json"
if [ -f "$REGISTRY" ]; then
  FOUND=$(jq -r '.plugin_root // empty' "$REGISTRY")
  if [ -f "$FOUND/package.json" ]; then printf '%s\n' "$FOUND"; exit 0; fi
fi
echo 'ghost-kit is not installed on this machine; run ghost-setup.sh --install from the plugin checkout' >&2
exit 2
