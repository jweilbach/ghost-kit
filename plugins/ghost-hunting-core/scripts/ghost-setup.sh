#!/usr/bin/env bash
# One command after cloning; does not depend on a globally installed npm package.
set -euo pipefail
PLUGIN_ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK_HASH=$(shasum -a 256 "$PLUGIN_ROOT/package-lock.json" | awk '{print $1}')
INSTALLED_HASH=$(cat "$PLUGIN_ROOT/node_modules/.ghost-kit-lock.sha256" 2>/dev/null || true)
if [ "$LOCK_HASH" != "$INSTALLED_HASH" ] || [ ! -d "$PLUGIN_ROOT/node_modules/ajv" ] || [ ! -d "$PLUGIN_ROOT/node_modules/@iarna/toml" ] || [ ! -d "$PLUGIN_ROOT/node_modules/@modelcontextprotocol/sdk" ]; then
  (cd "$PLUGIN_ROOT" && npm ci --ignore-scripts --no-audit --no-fund)
  printf '%s\n' "$LOCK_HASH" > "$PLUGIN_ROOT/node_modules/.ghost-kit-lock.sha256"
fi
exec node "$PLUGIN_ROOT/scripts/ghost-setup.mjs" "$@"
