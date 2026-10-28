"""sqlcount: count SQL statements per HTTP request while a test suite runs.

A test-runner plugin for the /reckoning `sql-per-request` instrument. It is loaded from
OUTSIDE the repo under test (`-p sqlcount` with PYTHONPATH pointing at this directory), so
it adds nothing to that repo: no conftest, no dependency, no file written into the tree.
The only file it writes is the JSON named by env RECKONING_SQLCOUNT_OUT (tmp -> rename,
in sessionfinish, together with the session exit status).

How attribution works
- `starlette.applications.Starlette.__call__` is wrapped at CLASS level. A conftest that
  binds `app` at import time and builds `ASGITransport(app=app)` still resolves the method
  through the class (FastAPI.__call__ calls super().__call__), so an instance patch after
  import would miss it but this does not. Only the OUTERMOST http call opens a request;
  a mounted sub-app passes through.
- The key is (method, scope["route"].path_format), read AFTER the inner call returns,
  because routing writes scope["route"] on the way down. An unrouted request (router 404)
  is keyed "<unrouted>".
- SQLAlchemy is hooked globally with `event.listen(Engine, "before_cursor_execute")` on the
  Engine CLASS; an AsyncEngine's sync_engine is an Engine instance, so async engines count.
- The current request travels in a contextvar. The async greenlet bridge is expected to
  carry it (SQLAlchemy copies gr_context); a module-level stack is the fallback, and the
  output reports how many statements each path attributed. If requests ran but nothing
  was attributed, self_check.ok is false and the instrument reports FAILED — never an
  empty table read as "no queries".
- Statements outside any request (fixtures, create_all/drop_all) are counted separately
  and never attributed.
"""

from __future__ import annotations

import contextvars
import json
import math
import os
import re
import sys
import time

_CUR: contextvars.ContextVar = contextvars.ContextVar("reckoning_sqlcount_request", default=None)
_STACK: list = []  # fallback attribution when the contextvar does not reach the cursor event
_BODY_CAP = 4 * 1024 * 1024
_STMT_SNIPPET = 300

_G = {
    "requests": 0,
    "routed": 0,
    "via_contextvar": 0,
    "via_stack": 0,
    "outside_requests": 0,
    "max_concurrent": 0,
    "dialects": {},
    "installed": [],
    "install_errors": [],
    "started": time.time(),
    "tests": {"passed": 0, "failed": 0, "errors": 0, "skipped": 0},
    "failed_ids": [],
}
_CALLS: dict = {}  # (method, path) -> list of per-call dicts

_WS = re.compile(r"\s+")
_STR = re.compile(r"'(?:[^']|'')*'")
_NUM = re.compile(r"(?<![\w$])-?\d+(?:\.\d+)?(?![\w])")
_PARAM = re.compile(r"\$\d+|%\(\w+\)s|%s|\?")
_INLIST = re.compile(r"\(\s*\?(?:\s*,\s*\?)+\s*\)")
_POSTCOMPILE = re.compile(r"\(?__\[POSTCOMPILE_\w+\]\)?")


def normalize(statement: str) -> str:
    """Strip literals and parameters, collapse whitespace: the N+1 identity of a statement."""
    s = _STR.sub("?", statement)
    s = _POSTCOMPILE.sub("(?...)", s)
    s = _PARAM.sub("?", s)
    s = _NUM.sub("?", s)
    s = _INLIST.sub("(?...)", s)
    return _WS.sub(" ", s).strip()


class _Req:
    __slots__ = ("method", "status", "stmts", "attempts", "errors", "norm", "body", "body_len", "ctype", "dialects")

    def __init__(self, method):
        self.method = method
        self.status = None
        self.stmts = 0
        self.attempts = 0
        self.errors = {}
        self.norm = {}
        self.body = []
        self.body_len = 0
        self.ctype = ""
        self.dialects = set()


def _item_count(req):
    if "json" not in req.ctype or req.body_len == 0 or req.body_len > _BODY_CAP:
        return None
    try:
        doc = json.loads(b"".join(req.body))
    except Exception:
        return None
    if isinstance(doc, list):
        return len(doc)
    if isinstance(doc, dict) and isinstance(doc.get("items"), list):
        return len(doc["items"])
    return None


def _record(req, route):
    path = getattr(route, "path_format", None) or getattr(route, "path", None)
    if path:
        _G["routed"] += 1
    else:
        path = "<unrouted>"
    top_stmt, top_n = "", 0
    for stmt, n in req.norm.items():
        if n > top_n:
            top_stmt, top_n = stmt, n
    _CALLS.setdefault((req.method, path), []).append({
        "status": req.status,
        "stmts": req.stmts,
        "items": _item_count(req),
        "repeat": top_n,
        "repeat_stmt": top_stmt[:_STMT_SNIPPET],
        "distinct": len(req.norm),
        "dialects": sorted(req.dialects),
        "aborted": req.attempts - req.stmts,
        "errors": dict(req.errors),
    })


def _on_cursor(conn, cursor, statement, parameters, context, executemany):
    """before_cursor_execute: attribute the ATTEMPT; the round trip counts only on success."""
    req = _CUR.get()
    if req is not None:
        _G["via_contextvar"] += 1
    elif _STACK:
        req = _STACK[-1]
        _G["via_stack"] += 1
    else:
        _G["outside_requests"] += 1
        return
    try:
        dialect = conn.dialect.name
    except Exception:
        dialect = "unknown"
    req.attempts += 1
    tag = (req, normalize(statement), dialect)
    if context is None:  # no execution context to pair with: count it now
        _count(tag)
    else:
        try:
            context._reckoning_sqlcount = tag
        except Exception:
            _count(tag)


def _count(tag):
    req, key, dialect = tag
    _G["dialects"][dialect] = _G["dialects"].get(dialect, 0) + 1
    req.dialects.add(dialect)
    req.stmts += 1
    req.norm[key] = req.norm.get(key, 0) + 1


def _after_cursor(conn, cursor, statement, parameters, context, executemany):
    tag = getattr(context, "_reckoning_sqlcount", None)
    if tag is not None:
        context._reckoning_sqlcount = None
        _count(tag)


def _on_error(exc_ctx):
    """A statement that raised: a DB error, or an ORM lazy load outside the async greenlet
    (MissingGreenlet), which never reaches the database but silently empties a field."""
    ctx = getattr(exc_ctx, "execution_context", None)
    tag = getattr(ctx, "_reckoning_sqlcount", None) if ctx is not None else None
    if tag is None:
        return
    name = type(getattr(exc_ctx, "original_exception", None) or exc_ctx).__name__
    tag[0].errors[name] = tag[0].errors.get(name, 0) + 1


def _install():
    try:
        from sqlalchemy import event
        from sqlalchemy.engine import Engine

        for name, fn in (("before_cursor_execute", _on_cursor), ("after_cursor_execute", _after_cursor),
                         ("handle_error", _on_error)):
            if not event.contains(Engine, name, fn):
                event.listen(Engine, name, fn)
            _G["installed"].append(f"sqlalchemy.Engine.{name}")
    except Exception as exc:  # recorded, surfaces as self_check failure
        _G["install_errors"].append(f"sqlalchemy hook: {exc!r}")
    try:
        from starlette.applications import Starlette

        orig = Starlette.__call__
        if getattr(orig, "_reckoning_sqlcount", False):
            return

        async def __call__(self, scope, receive, send):
            if scope.get("type") != "http" or _CUR.get() is not None:
                return await orig(self, scope, receive, send)
            req = _Req(scope.get("method", "?"))
            token = _CUR.set(req)
            _STACK.append(req)
            _G["requests"] += 1
            _G["max_concurrent"] = max(_G["max_concurrent"], len(_STACK))

            async def send_spy(message):
                kind = message.get("type")
                if kind == "http.response.start":
                    req.status = message.get("status")
                    for k, v in message.get("headers") or []:
                        if k.lower() == b"content-type":
                            req.ctype = v.decode("latin-1").lower()
                elif kind == "http.response.body":
                    chunk = message.get("body") or b""
                    req.body_len += len(chunk)
                    if req.body_len <= _BODY_CAP:
                        req.body.append(chunk)
                    else:
                        req.body = []
                await send(message)

            try:
                return await orig(self, scope, receive, send_spy)
            finally:
                _CUR.reset(token)
                for i in range(len(_STACK) - 1, -1, -1):
                    if _STACK[i] is req:
                        del _STACK[i]
                        break
                _record(req, scope.get("route"))
                req.body = []

        __call__._reckoning_sqlcount = True
        Starlette.__call__ = __call__
        _G["installed"].append("starlette.applications.Starlette.__call__")
    except Exception as exc:
        _G["install_errors"].append(f"starlette hook: {exc!r}")


def _pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx if sxx else 0.0
    r = sxy / math.sqrt(sxx * syy) if sxx and syy else 0.0
    return slope, r


def _merge(dicts):
    out: dict = {}
    for d in dicts:
        for k, v in d.items():
            out[k] = out.get(k, 0) + v
    return out


def _summarise():
    endpoints = []
    for (method, path), calls in _CALLS.items():
        stmts = [c["stmts"] for c in calls]
        statuses: dict = {}
        for c in calls:
            statuses[str(c["status"])] = statuses.get(str(c["status"]), 0) + 1
        worst = max(calls, key=lambda c: (c["repeat"], c["stmts"]))
        ok_pts = [(c["items"], c["stmts"]) for c in calls
                  if c["items"] is not None and c["status"] is not None and 200 <= c["status"] < 300]
        by_items: dict = {}
        for n, st in ok_pts:
            by_items.setdefault(n, []).append(st)
        # Zero-item responses are left out of the fit: eager (selectin) loads only fire when
        # rows exist, so 0 -> 1 item is a constant step, not per-item growth.
        pts = [p for p in ok_pts if p[0] >= 1]
        items = [p[0] for p in pts]
        growth = {"points": len(pts), "distinct_item_counts": len(set(items)),
                  "slope_stmts_per_item": None, "r": None, "flag": False,
                  "mean_stmts_by_items": {str(k): round(sum(v) / len(v), 2) for k, v in sorted(by_items.items())[:12]}}
        if len(pts) >= 3 and len(set(items)) >= 2:
            slope, r = _pearson(items, [p[1] for p in pts])
            growth.update(slope_stmts_per_item=round(slope, 3), r=round(r, 3),
                          flag=bool(slope >= 0.5 and r >= 0.5))
        endpoints.append({
            "method": method,
            "path": path,
            "dialects": sorted({d for c in calls for d in c["dialects"]}),
            "calls": len(calls),
            "statements": {"min": min(stmts), "mean": round(sum(stmts) / len(stmts), 2),
                           "max": max(stmts), "total": sum(stmts)},
            "status_codes": statuses,
            "items": {"calls_with_items": sum(1 for c in calls if c["items"] is not None),
                      "max": max((c["items"] for c in calls if c["items"] is not None), default=None)},
            "aborted": {"total": sum(c["aborted"] for c in calls),
                        "calls_with_aborted": sum(1 for c in calls if c["aborted"]),
                        "max_in_one_call": max(c["aborted"] for c in calls),
                        "by_exception": _merge([c["errors"] for c in calls])},
            "n_plus_one": {"max_repeat": worst["repeat"], "statement": worst["repeat_stmt"],
                           "in_call_with_stmts": worst["stmts"], "in_call_with_items": worst["items"],
                           "calls_with_repeat_ge3": sum(1 for c in calls if c["repeat"] >= 3)},
            "growth": growth,
        })
    endpoints.sort(key=lambda e: (-e["statements"]["mean"], e["path"], e["method"]))
    return endpoints


def _write(exitstatus):
    out = os.environ.get("RECKONING_SQLCOUNT_OUT")
    endpoints = _summarise()
    attributed = _G["via_contextvar"] + _G["via_stack"]
    completed = sum(_G["dialects"].values())
    reasons = []
    if _G["install_errors"]:
        reasons.append("hook install failed: " + "; ".join(_G["install_errors"]))
    if _G["requests"] == 0:
        reasons.append("no HTTP request reached Starlette.__call__ (hook not on the request path?)")
    elif attributed == 0 or completed == 0:
        reasons.append(f"{_G['requests']} requests ran but 0 statements were attributed "
                       "(contextvar did not reach the cursor event and the fallback stack was empty)")
    if _G["requests"] and _G["routed"] == 0:
        reasons.append("no request carried scope['route'] — every key would be <unrouted>")
    doc = {
        "probe": "sqlcount",
        "version": 1,
        "session": {
            "exitstatus": int(exitstatus),
            "tests": _G["tests"],
            "failed_ids": _G["failed_ids"][:50],
            "duration_s": round(time.time() - _G["started"], 1),
        },
        "self_check": {
            "ok": not reasons,
            "reason": "; ".join(reasons),
            "hooks": _G["installed"],
            "requests": _G["requests"],
            "routed_requests": _G["routed"],
            "attributed_attempts": attributed,
            "attributed_statements": sum(_G["dialects"].values()),
            "via_contextvar": _G["via_contextvar"],
            "via_fallback_stack": _G["via_stack"],
            "statements_outside_requests": _G["outside_requests"],
            "max_concurrent_requests": _G["max_concurrent"],
            "dialects_seen": sorted(_G["dialects"]),
            "attributed_by_dialect": dict(sorted(_G["dialects"].items())),
        },
        "caveats": [
            "Measured on the database(s) the test suite uses (self_check.attributed_by_dialect; each "
            "endpoint row lists its own dialects) at FIXTURE "
            "cardinality: tiny row counts, so an N+1 shows as a repeated identical statement, not as a "
            "large count.",
            "Counts round trips, never what one statement costs: on fixture-sized tables a sort or "
            "filter no index serves, a count over an ordered query, or an aggregate over a tenant's "
            "whole history runs as fast as a primary-key read, so a low count is no evidence a path is "
            "cheap at scale.",
            "Only statements inside an HTTP request are counted; fixture setup/teardown "
            "(create_all/drop_all per test) is excluded and reported as statements_outside_requests.",
            "Post-commit work is a known blind spot where the suite closes post-commit coroutines "
            "without running them (this repo's conftest does).",
            "A key's counts mix every test that called it: different params, error paths and "
            "permission failures all land in one row; read min/mean/max with that in mind.",
            "statements = completed cursor executions (after_cursor_execute); a statement that raised "
            "is counted under aborted.by_exception instead — MissingGreenlet there is an async lazy load "
            "that never reached the database and silently emptied a field.",
            "executemany counts as one statement; driver-level BEGIN/COMMIT are not cursor "
            "statements and are not counted.",
        ],
        "endpoints": endpoints,
    }
    if not out:
        sys.stderr.write("sqlcount: RECKONING_SQLCOUNT_OUT not set; nothing written\n")
        return
    tmp = f"{out}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False)
    os.replace(tmp, out)


# ---- test-runner hooks -------------------------------------------------------

def pytest_configure(config):
    _install()


def pytest_runtest_logreport(report):
    t = _G["tests"]
    if report.when == "call":
        if report.passed:
            t["passed"] += 1
        elif report.failed:
            t["failed"] += 1
            _G["failed_ids"].append(report.nodeid)
        elif report.skipped:
            t["skipped"] += 1
    elif report.failed:
        t["errors"] += 1
        _G["failed_ids"].append(f"{report.nodeid} ({report.when})")
    elif report.when == "setup" and report.skipped:
        t["skipped"] += 1


def pytest_sessionfinish(session, exitstatus):
    try:
        _write(exitstatus)
    except Exception as exc:  # never mask the suite's own exit status
        sys.stderr.write(f"sqlcount: failed to write output: {exc!r}\n")
