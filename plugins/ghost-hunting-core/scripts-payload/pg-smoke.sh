#!/usr/bin/env bash
# pg-smoke.sh — genuine-Postgres smoke gate for the Ghost Hunting backend track. The pytest
# suite is hermetic in-memory sqlite (backend/tests/conftest.py), so a green suite proves
# NOTHING about the migrated Postgres schema. This gate connects to the scratch DB with the
# app's real async engine and dialect and:
#   1. SELECT 1  (connectivity / driver sanity)
#   2. for EVERY ORM-mapped table: SELECT <mapped columns> LIMIT 1 — a column present on the
#      model but missing from the migrated schema (or type-incompatible under the real
#      dialect) fails HERE even though sqlite tests pass.
# It complements migration-gate.sh (alembic check compares metadata; this exercises the live
# dialect at query time). Read-only; never writes.
#
# Requires DATABASE_URL in the environment. It REFUSES any database whose name does not end in
# `_test`, UNLESS PG_SMOKE_SCRATCH names the exact expected database — in which case it still
# refuses the repo's own configured database and the Postgres system catalogs. This gate must
# never point at a dev or prod database.
#
# Backend layout is auto-discovered across stack-convention variants: the virtualenv is found at
# backend/venv or backend/.venv (first that exists), and the ORM Base is imported from
# app.core.database or app.database (whichever module exposes a `Base`). Two optional env
# overrides pin the layout for other stacks:
#   PG_SMOKE_VENV         venv directory, relative to the repo root (e.g. backend/.venv)
#   PG_SMOKE_BASE_MODULE  dotted module that defines the ORM `Base` (e.g. app.database)
# When either is unset, the corresponding discovery chain above is used.
#
# VENDORED by /ghost-sync from ghost-kit (plugins/ghost-hunting-core/scripts-payload/pg-smoke.sh)
# when a repo sets .isolation.pg_smoke — edit the plugin copy, never the vendored repo copy.
set -uo pipefail

# Act on the checkout this script PHYSICALLY lives in (same discipline as ghost-db.sh /
# migration-gate.sh — a worktree's gate must import THAT worktree's models).
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
REPO_ROOT="$(git -C "$SELF_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT=""
if [[ -z "$REPO_ROOT" ]]; then
  echo "pg-smoke: not inside a git repository — run from the target checkout" >&2
  exit 2
fi
BACKEND_DIR="$REPO_ROOT/backend"

if [[ "${1:-}" == root ]]; then printf '%s\n' "$REPO_ROOT"; exit 0; fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "pg-smoke: DATABASE_URL is required (the scratch DB URL from ghost-db.sh url)" >&2
  exit 2
fi
# Strip query params / trailing slash noise before the name check.
DB_NAME="${DATABASE_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"; DB_NAME="${DB_NAME%%#*}"
# Scratch-DB guard. A `_test` suffix is ACCEPTED but is not the only proof: rite-cadence points
# this gate at the alembic-migrated BASE database, whose name has no suffix (the `_test` sibling is
# typically rebuilt by a pytest conftest from ORM metadata, which would make this gate compare the
# ORM against itself — a tautology that can never fail). For that path the engine sets
# PG_SMOKE_SCRATCH to the EXACT database name it provisioned (not a boolean flag — a caller that
# passes `1` gets a refusal, because `1` is not the database in DATABASE_URL); we still refuse
# anything that looks like a real database.
pg_smoke_refuse() {
  echo "pg-smoke: refusing database '$DB_NAME' — $1" >&2
  echo "  this gate must never point at a dev or prod database. Pass a *_test scratch DB, or set" >&2
  echo "  PG_SMOKE_SCRATCH=<exact-db-name> when an engine owns that database's whole lifecycle." >&2
  exit 4
}
if [[ -n "${PG_SMOKE_SCRATCH:-}" ]]; then
  # PG_SMOKE_SCRATCH is the EXACT database name the caller provisioned. It is an assertion, not a
  # boolean: a caller that cannot name the database it created has no business bypassing the
  # suffix rule. Matching by name cannot fail open the way a heuristic denylist can — a caller
  # would have to name the dev database outright, which an engine that mints
  # <prefix>_rc<slug> names never does.
  if [[ "$DB_NAME" != "$PG_SMOKE_SCRATCH" ]]; then
    pg_smoke_refuse "PG_SMOKE_SCRATCH declares scratch DB '$PG_SMOKE_SCRATCH', but DATABASE_URL points at '$DB_NAME'"
  fi
  # Belt-and-suspenders: refuse the repo's own configured database and the system catalogs even
  # when explicitly named, so a mis-derived scratch name can never reach a real database.
  for _f in "$REPO_ROOT/.env" "$BACKEND_DIR/.env"; do
    [[ -f "$_f" ]] || continue
    _u=$(grep -E '^DATABASE_URL=' "$_f" 2>/dev/null | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//; s/^'\''//; s/'\''$//')
    [[ -n "$_u" ]] || continue
    _env_db="${_u##*/}"; _env_db="${_env_db%%\?*}"
    if [[ -n "$_env_db" && "$DB_NAME" == "$_env_db" ]]; then
      pg_smoke_refuse "it is this repo's configured DATABASE_URL database ($_f), not a scratch DB"
    fi
  done
  case "$DB_NAME" in
    postgres|template0|template1|"")
      pg_smoke_refuse "it is a Postgres system database" ;;
  esac
elif [[ ! "$DB_NAME" =~ _test$ ]]; then
  pg_smoke_refuse "this gate only runs against *_test scratch DBs unless PG_SMOKE_SCRATCH names the scratch database"
fi
# Venv discovery: PG_SMOKE_VENV override (relative to repo root) wins; else backend/venv then
# backend/.venv — first that exists. Clear error if none can be found.
if [[ -n "${PG_SMOKE_VENV:-}" ]]; then
  VENV_DIR="$REPO_ROOT/$PG_SMOKE_VENV"
  if [[ ! -d "$VENV_DIR" ]]; then
    echo "pg-smoke: PG_SMOKE_VENV='$PG_SMOKE_VENV' not found at $VENV_DIR" >&2
    exit 2
  fi
elif [[ -d "$BACKEND_DIR/venv" ]]; then
  VENV_DIR="$BACKEND_DIR/venv"
elif [[ -d "$BACKEND_DIR/.venv" ]]; then
  VENV_DIR="$BACKEND_DIR/.venv"
else
  echo "pg-smoke: no backend venv found (tried backend/venv and backend/.venv — provision the worktree first)" >&2
  exit 2
fi

cd "$BACKEND_DIR"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
export PYTHONPATH="$BACKEND_DIR"

python - <<'PYEOF'
import asyncio, importlib, os, sys

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine


def _load_base():
    # ORM Base discovery: PG_SMOKE_BASE_MODULE override wins; else try app.core.database then
    # app.database — the first module that exposes a `Base` attribute. Error clearly listing
    # what was tried if none works.
    override = os.environ.get("PG_SMOKE_BASE_MODULE")
    candidates = [override] if override else ["app.core.database", "app.database"]
    tried = []
    for mod_name in candidates:
        try:
            mod = importlib.import_module(mod_name)
        except Exception as exc:  # noqa: BLE001
            tried.append(f"{mod_name} (import failed: {type(exc).__name__}: {exc})")
            continue
        base = getattr(mod, "Base", None)
        if base is None:
            tried.append(f"{mod_name} (no 'Base' attribute)")
            continue
        return base
    print("pg-smoke: could not locate the ORM Base — tried:", file=sys.stderr)
    for t in tried:
        print(f"  - {t}", file=sys.stderr)
    sys.exit(2)


Base = _load_base()
import app.models  # noqa: F401  (registers every mapped table on Base.metadata)


async def main() -> int:
    engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    failures = []
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            tables = list(Base.metadata.sorted_tables)
            for table in tables:
                try:
                    await conn.execute(select(table).limit(1))
                except Exception as exc:  # noqa: BLE001 — every table gets a verdict
                    failures.append(f"{table.name}: {type(exc).__name__}: {exc}")
        if failures:
            print(f"pg-smoke: {len(failures)}/{len(tables)} table(s) FAILED under the real dialect:", file=sys.stderr)
            for f in failures:
                print(f"  - {f}", file=sys.stderr)
            return 1
        print(f"pg-smoke: clean ({len(tables)} ORM tables selectable on {os.environ['DATABASE_URL'].rsplit('/', 1)[-1]})")
        return 0
    finally:
        await engine.dispose()


sys.exit(asyncio.run(main()))
PYEOF
status=$?
deactivate || true
exit $status
