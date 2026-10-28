#!/usr/bin/env bash
# Render ghost-kit workflow templates into a repo's .claude/workflows/.
#
# Usage:
#   render-workflows.sh [--check] [--repo-root <path>]
#
#   --check          compare only; exit 3 if any vendored workflow is missing or
#                    stale, 0 if in sync (or repo vendors nothing), never write
#   --stdout <name>  render ONE workflow to stdout and exit; writes nothing. The bytes are
#                    IDENTICAL to what the vendored .claude/workflows/<name>.js would contain,
#                    header included, so a caller can execute the engine inline
#                    (Workflow({script})) instead of reading a committed file. Renders even if
#                    the repo vendors nothing -- the caller names what it wants to run.
#
# Reads the repo's .ghost/config.json (workflows.vendor list + __CFG_*__ token
# values). Substitutes tokens into workflows/<name>.js.tmpl and writes plain
# files with a DO-NOT-EDIT header. Records the rendered state (template hashes
# + bundle, matching backend compute_bundle) in .ghost/sync-state.json — the
# `bundle` there is what skills send as the wf/ token in X-Ghost-Client.
set -euo pipefail

PLUGIN_ROOT=$(cd "$(dirname "$0")/.." && pwd)
CHECK=0
REPO_ROOT=""
STDOUT_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --stdout) STDOUT_NAME="${2:-}"; shift ;;
    --repo-root) REPO_ROOT="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$REPO_ROOT" ] && REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

CFG="$REPO_ROOT/.ghost/config.json"
[ -f "$CFG" ] || exit 0
VENDOR=$(jq -r '.workflows.vendor[]? // empty' "$CFG")
[ -z "$VENDOR" ] && [ -z "$STDOUT_NAME" ] && exit 0

PLUGIN_VERSION=$(jq -r '.version' "$PLUGIN_ROOT/.claude-plugin/plugin.json")
cfg() { jq -r "$1 // empty" "$CFG"; }
# auth.prod.org_id binds the engines' key lookup to one Coven (the per-user
# GHOST_HUNTING_API_KEY__<ORG8> fallback + the claim-stage Coven check). Rendered ONLY when it is
# a well-formed UUID: a value that reached the sed below unvalidated could break out of the JS
# string literal it lands in.
ORG_ID_TOKEN=$(cfg '.auth.prod.org_id' | grep -Ei '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || true)

# Token map: __CFG_<name>__ → value from .ghost/config.json
render() { # $1 = template path; stdout = rendered content
  sed \
    -e "s|__CFG_repo__|$(cfg '.repo' | grep . || basename "$REPO_ROOT")|g" \
    -e "s|__CFG_seance_id__|$(cfg '.seance.id')|g" \
    -e "s|__CFG_qa_seance_id__|$(cfg '.seance.qa_seance_id')|g" \
    -e "s|__CFG_human_hunter_id__|$(cfg '.human_hunter_id')|g" \
    -e "s|__CFG_api_base__|$(cfg '.api.base' | grep . || echo 'https://backend-production-ea01.up.railway.app')|g" \
    -e "s|__CFG_key_var__|$(cfg '.auth.prod.env_var' | grep . || echo GHOST_HUNTING_API_KEY)|g" \
    -e "s|__CFG_env_file__|$(cfg '.auth.prod.env_files[0]' | grep . || echo .env)|g" \
    -e "s|__CFG_org_id__|$ORG_ID_TOKEN|g" \
    -e "s|__CFG_test_backend__|$(cfg '.tests.backend')|g" \
    -e "s|__CFG_test_frontend__|$(cfg '.tests.frontend')|g" \
    -e "s|__CFG_test_all__|$(cfg '.tests.all')|g" \
    -e "s|__CFG_isolation_mode__|$(cfg '.isolation.mode' | grep . || echo none)|g" \
    -e "s|__CFG_worktree_script__|$(cfg '.isolation.worktree_script')|g" \
    -e "s|__CFG_db_script__|$(cfg '.isolation.db_script')|g" \
    -e "s|__CFG_commit_script__|$(cfg '.isolation.commit_script')|g" \
    -e "s|__CFG_migration_gate__|$(cfg '.isolation.migration_gate')|g" \
    -e "s|__CFG_pg_smoke__|$(cfg '.isolation.pg_smoke')|g" \
    -e "s|__CFG_db_migrate__|$(cfg '.isolation.db_migrate')|g" \
    -e "s|__CFG_db_prefix__|$(cfg '.isolation.db_prefix')|g" \
    -e "s|__CFG_model_remap__|$(jq -c '(.models.remap // {}) | with_entries(select((.key|type=="string") and (.value|type=="string") and (.key|test("^[A-Za-z0-9_.-]+$")) and (.value|test("^[A-Za-z0-9_.-]+$"))))' "$CFG")|g" \
    -e "s|__CFG_browser_tool__|$(cfg '.browser.tool' | grep . || echo none)|g" \
    -e "s|__CFG_plugin_version__|$PLUGIN_VERSION|g" \
    "$1"
}

# Template-bundle hashes — must match backend compute_bundle():
# sha256 over "name:hash" lines, names sorted, joined by \n, first 12 hex.
declare -a HASH_LINES=()
FILES_JSON="{}"
for t in "$PLUGIN_ROOT"/workflows/*.js.tmpl; do
  [ -e "$t" ] || continue
  name=$(basename "$t")
  h="sha256:$(shasum -a 256 "$t" | awk '{print $1}')"
  HASH_LINES+=("$name:$h")
  FILES_JSON=$(echo "$FILES_JSON" | jq --arg k "$name" --arg v "$h" '. + {($k): $v}')
done
BUNDLE=""
if [ ${#HASH_LINES[@]} -gt 0 ]; then
  BUNDLE=$(printf '%s\n' "${HASH_LINES[@]}" | sort | awk 'NR>1{printf "\n"} {printf "%s", $0}' | shasum -a 256 | awk '{print $1}' | cut -c1-12)
fi

# --stdout: one workflow, to stdout, byte-identical to the vendored file. This is the seam
# that lets a caller run the engine WITHOUT a committed copy -- same renderer, second output
# mode, so the two can never drift.
if [ -n "$STDOUT_NAME" ]; then
  TMPL="$PLUGIN_ROOT/workflows/$STDOUT_NAME.js.tmpl"
  if [ ! -f "$TMPL" ]; then
    echo "ghost-kit: no template for '$STDOUT_NAME'" >&2
    exit 2
  fi
  { echo "// vendored from ghost-kit/ghost-hunting-core v$PLUGIN_VERSION (bundle $BUNDLE) — DO NOT EDIT"; \
    echo "// edit ghosthunting/plugins/ghost-hunting-core/workflows/$STDOUT_NAME.js.tmpl and run /ghost-sync"; \
    render "$TMPL"; }
  exit 0
fi

DRIFT=0
for name in $VENDOR; do
  TMPL="$PLUGIN_ROOT/workflows/$name.js.tmpl"
  OUT="$REPO_ROOT/.claude/workflows/$name.js"
  if [ ! -f "$TMPL" ]; then
    echo "ghost-kit: no template for '$name' (skipping)" >&2
    continue
  fi
  WANT=$( { echo "// vendored from ghost-kit/ghost-hunting-core v$PLUGIN_VERSION (bundle $BUNDLE) — DO NOT EDIT"; \
            echo "// edit ghosthunting/plugins/ghost-hunting-core/workflows/$name.js.tmpl and run /ghost-sync"; \
            render "$TMPL"; } )
  if [ -f "$OUT" ] && [ "$(cat "$OUT")" = "$WANT" ]; then
    continue
  fi
  DRIFT=1
  if [ "$CHECK" = "1" ]; then
    echo "stale: .claude/workflows/$name.js"
  else
    mkdir -p "$REPO_ROOT/.claude/workflows"
    printf '%s\n' "$WANT" > "$OUT"
    echo "wrote: .claude/workflows/$name.js"
  fi
done

# Payload scripts — non-template artifacts vendored by PATH from .ghost/config.json (copied
# verbatim, no token substitution). These are NOT part of the template bundle/wf-stamp
# computation; their hashes are recorded separately under the sync-state "scripts" key.
SCRIPTS_JSON="{}"
PG_SMOKE_DEST=$(cfg '.isolation.pg_smoke')
if [ -n "$PG_SMOKE_DEST" ]; then
  SRC="$PLUGIN_ROOT/scripts-payload/pg-smoke.sh"
  OUT="$REPO_ROOT/$PG_SMOKE_DEST"
  if [ ! -f "$SRC" ]; then
    echo "ghost-kit: no payload script at scripts-payload/pg-smoke.sh (skipping)" >&2
  else
    SH="sha256:$(shasum -a 256 "$SRC" | awk '{print $1}')"
    SCRIPTS_JSON=$(echo "$SCRIPTS_JSON" | jq --arg k "$PG_SMOKE_DEST" --arg v "$SH" '. + {($k): $v}')
    if [ -f "$OUT" ] && cmp -s "$SRC" "$OUT"; then
      : # in sync
    else
      DRIFT=1
      if [ "$CHECK" = "1" ]; then
        echo "stale: $PG_SMOKE_DEST"
      else
        mkdir -p "$(dirname "$OUT")"
        cp "$SRC" "$OUT"
        chmod +x "$OUT"
        echo "wrote: $PG_SMOKE_DEST"
      fi
    fi
  fi
fi

if [ "$CHECK" = "1" ]; then
  [ "$DRIFT" = "1" ] && exit 3 || exit 0
fi

mkdir -p "$REPO_ROOT/.ghost"
jq -n --arg pv "$PLUGIN_VERSION" --arg bundle "$BUNDLE" --argjson files "$FILES_JSON" --argjson scripts "$SCRIPTS_JSON" \
  '{plugin_version: $pv, bundle: $bundle, templates: $files, scripts: $scripts}' > "$REPO_ROOT/.ghost/sync-state.json"
echo "sync-state: plugin v$PLUGIN_VERSION bundle ${BUNDLE:-<none>}"
