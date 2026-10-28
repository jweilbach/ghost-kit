#!/usr/bin/env bash
# reckoning-instruments.sh — the deterministic Instruments of /reckoning (P0 · Survey, step 4).
#
#   reckoning-instruments.sh --tree <pinned-tree-abs> --out <dir-abs>
#                            [--only name,name] [--snapshot <dir-abs>]
#
# Instruments: churn, ui-bypass, agent-context, loose-ends, sql-per-request (run in that order).
# Each writes <out>/<name>.json atomically (tmp -> mv):
#   {"name", "status": "ok"|"skipped"|"failed", "reason", "sha": <tree HEAD>, "data": {...}}
# HONEST STATUS: a missing tool or config is "skipped" with a reason, a crashed or killed run is
# "failed" with a reason — never an empty "ok". Exit 0 unless the usage is wrong (exit 2).
#
# Config: .reckoning.instruments in <tree>/.ghost/config.json (absent -> defaults / skipped);
# keys are documented in skills/reckoning/references/instruments.md.
# Env (optional): RECKONING_API_BASE, RECKONING_AUTH (a full "Authorization: Bearer ..." line),
# RECKONING_CLIENT (a full "X-Ghost-Client: ..." line), RECKONING_INSTRUMENTS_CONFIG (a JSON
# file that REPLACES .reckoning.instruments — for trying a config before it is committed). The
# auth header is never printed, never put on an argv, and never passed to a child process.
#
# Everything is READ-ONLY toward the tree, the API and git. Heavy lifting is Node (>= 22) fed
# on stdin, so no program text ever appears on an argv.
set -uo pipefail

ALL="churn ui-bypass agent-context loose-ends sql-per-request"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROBES="$SCRIPT_DIR/probes"

usage() {
  echo "usage: $(basename "$0") --tree <pinned-tree-abs> --out <dir-abs> [--only name,name] [--snapshot <dir-abs>]" >&2
  echo "       instruments: $ALL" >&2
  [ -n "${1:-}" ] && echo "error: $1" >&2
  exit 2
}

TREE="" OUT="" ONLY="" SNAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tree) [ $# -ge 2 ] || usage "--tree needs a value"; TREE="$2"; shift 2 ;;
    --out) [ $# -ge 2 ] || usage "--out needs a value"; OUT="$2"; shift 2 ;;
    --only) [ $# -ge 2 ] || usage "--only needs a value"; ONLY="$2"; shift 2 ;;
    --snapshot) [ $# -ge 2 ] || usage "--snapshot needs a value"; SNAP="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) usage "unknown argument: $1" ;;
  esac
done

[ -n "$TREE" ] || usage "--tree is required"
[ -n "$OUT" ] || usage "--out is required"
case "$TREE" in /*) ;; *) usage "--tree must be absolute" ;; esac
case "$OUT" in /*) ;; *) usage "--out must be absolute" ;; esac
if [ -n "$SNAP" ]; then case "$SNAP" in /*) ;; *) usage "--snapshot must be absolute" ;; esac; fi
[ -d "$TREE" ] || usage "--tree is not a directory: $TREE"
git -C "$TREE" rev-parse --is-inside-work-tree >/dev/null 2>&1 || usage "--tree is not a git work tree: $TREE"
TREE="$(cd "$TREE" && pwd)"
case "$OUT/" in "$TREE"/*) usage "--out must be outside the tree (the tree must stay untouched)" ;; esac
mkdir -p "$OUT" || usage "cannot create --out: $OUT"

SELECTED=""
if [ -n "$ONLY" ]; then
  for n in $(echo "$ONLY" | tr ',' ' '); do
    case " $ALL " in *" $n "*) ;; *) usage "unknown instrument in --only: $n" ;; esac
  done
  for n in $ALL; do
    case ",$ONLY," in *",$n,"*) SELECTED="$SELECTED $n" ;; esac
  done
else
  SELECTED=" $ALL"
fi

SHA="$(git -C "$TREE" rev-parse HEAD 2>/dev/null || echo unknown)"

# Minimal JSON writer that needs nothing but printf — used only when Node itself is unusable.
json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\t' '  '; }
write_raw() { # name status reason
  local f="$OUT/$1.json" tmp="$OUT/.$1.json.tmp.$$"
  printf '{"name":"%s","status":"%s","reason":"%s","sha":"%s","data":{}}\n' \
    "$1" "$2" "$(json_str "$3")" "$SHA" > "$tmp" && mv -f "$tmp" "$f"
}

NODE_OK=1 NODE_WHY=""
if ! command -v node >/dev/null 2>&1; then
  NODE_OK=0 NODE_WHY="node (>= 22) not found on PATH"
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -lt 22 ] 2>/dev/null; then NODE_OK=0 NODE_WHY="node >= 22 required (found $(node --version 2>/dev/null))"; fi
fi

tree_state() { git --no-optional-locks -C "$TREE" status --porcelain --ignored -uall 2>/dev/null; }
BEFORE="$OUT/.tree-before.$$" AFTER="$OUT/.tree-after.$$"
tree_state > "$BEFORE"

js_main() {
cat <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const E = process.env;
const NAME = E.RI_NAME, TREE = E.RI_TREE, OUT = E.RI_OUT, SHA = E.RI_SHA;
const SNAP = E.RI_SNAPSHOT || '', PROBES = E.RI_PROBES;
const RUNNER_WORD = ['py', 'test'].join(''); // assembled so no argv/program text carries it

let CONFIG_SOURCE = '.ghost/config.json .reckoning.instruments';
function writeResult(status, reason, data) {
  const doc = { name: NAME, status, reason: reason || '', sha: SHA, generated_at: new Date().toISOString(), config_source: CONFIG_SOURCE, data: data || {} };
  const f = path.join(OUT, `${NAME}.json`);
  const tmp = path.join(OUT, `.${NAME}.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n');
  fs.renameSync(tmp, f);
}

function loadCfg() {
  const f = path.join(TREE, '.ghost', 'config.json');
  let j = {};
  if (fs.existsSync(f)) {
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { return { error: `.ghost/config.json is not valid JSON: ${e.message}` }; }
  } else CONFIG_SOURCE = 'none (.ghost/config.json absent) — defaults';
  let inst = j.reckoning && j.reckoning.instruments;
  if (!inst && fs.existsSync(f)) CONFIG_SOURCE = 'none (.reckoning.instruments absent) — defaults';
  const ov = E.RECKONING_INSTRUMENTS_CONFIG;
  if (ov) {
    try { inst = JSON.parse(fs.readFileSync(ov, 'utf8')); CONFIG_SOURCE = `override RECKONING_INSTRUMENTS_CONFIG=${ov}`; }
    catch (e) { return { error: `RECKONING_INSTRUMENTS_CONFIG ${ov} is unreadable: ${e.message}` }; }
  }
  return { cfg: inst && typeof inst === 'object' ? inst : {}, ghost: j };
}

const childEnv = () => {
  const env = { ...E, PYTHONDONTWRITEBYTECODE: '1' };
  for (const k of ['RECKONING_AUTH', 'RECKONING_CLIENT', 'RI_NAME', 'RI_TREE', 'RI_OUT', 'RI_SHA', 'RI_SNAPSHOT', 'RI_PROBES']) delete env[k];
  return env;
};

function git(args, cwd) {
  return cp.execFileSync('git', ['-c', 'core.quotepath=off', '-C', cwd || TREE, ...args],
    { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
}
let LS = null;
function lsFiles() { if (!LS) LS = git(['ls-files', '-z']).split('\0').filter(Boolean); return LS; }
const isDir = (rel) => { try { return fs.statSync(path.join(TREE, rel)).isDirectory(); } catch { return false; } };
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const tok = (bytes) => Math.round(bytes / 4);
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v) || '');

function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function runShell(cmd, timeoutMs) {
  const r = cp.spawnSync('/bin/sh', ['-c', cmd], { cwd: TREE, env: childEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 << 20 });
  const why = r.error ? (r.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs / 1000}s` : r.error.message)
    : r.signal ? `killed by ${r.signal}` : r.status !== 0 ? `exited ${r.status}` : '';
  return { ok: !why, why, stdout: r.stdout || '', stderrTail: String(r.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400) };
}
function parseJsonOut(s) {
  try { return JSON.parse(s); } catch { /* fall through: noise before the document */ }
  const lines = s.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// ─────────────────────────────── churn ───────────────────────────────
async function churn(cfg) {
  const c = cfg.churn || {};
  const sinceDays = Number.isInteger(c.since_days) && c.since_days > 0 ? c.since_days : 180;
  const topN = Number.isInteger(c.top) && c.top > 0 ? c.top : 40;
  const extra = (Array.isArray(c.exclude) ? c.exclude : []).map(globToRe);
  const LOCK = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock|bun\.lockb)$|\.lock$/;
  const GEN = [/(^|\/)(node_modules|dist|build|vendor|venv|\.venv|__pycache__|coverage)\//, /^\.claude\/workflows\/[^/]+\.js$/, /\.min\.(js|css)$/, /\.map$/];
  const BIN = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|jar|woff2?|ttf|otf|eot|mp[34]|mov|wav|ogg|webm|sqlite3?|db|bin|exe|dll|dylib|so|pyc|class|wasm)$/i;
  const excluded = { lockfile: 0, generated_or_vendored: 0, binary: 0, config_exclude: 0, symlink_or_unreadable: 0 };
  const loc = new Map();
  for (const f of lsFiles()) {
    if (LOCK.test(f)) { excluded.lockfile++; continue; }
    if (GEN.some((r) => r.test(f))) { excluded.generated_or_vendored++; continue; }
    if (extra.some((r) => r.test(f))) { excluded.config_exclude++; continue; }
    if (BIN.test(f)) { excluded.binary++; continue; }
    let buf;
    try {
      const st = fs.lstatSync(path.join(TREE, f));
      if (!st.isFile()) { excluded.symlink_or_unreadable++; continue; }
      buf = fs.readFileSync(path.join(TREE, f));
    } catch { excluded.symlink_or_unreadable++; continue; }
    if (buf.subarray(0, 8000).includes(0)) { excluded.binary++; continue; }
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    if (buf.length && buf[buf.length - 1] !== 10) n++;
    loc.set(f, n);
  }
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  const log = git(['log', `--since=${sinceDays}.days`, '--numstat', '-M', '--no-merges', '--format=@@%H', 'HEAD']);
  const renamed = (p) => {
    const m = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (m) return (m[1] + m[3] + m[4]).replace(/\/\//g, '/');
    const k = p.indexOf(' => ');
    return k >= 0 ? p.slice(k + 4) : p;
  };
  const created = new Set(git(['log', `--since=${sinceDays}.days`, '--diff-filter=A', '--name-only', '-M', '--no-merges', '--format=', 'HEAD']).split('\n').filter(Boolean));
  const per = new Map();
  let commit = null, commits = 0, churnAll = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('@@')) { commit = line.slice(2); commits++; continue; }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m || m[1] === '-') continue;
    const f = renamed(m[3]);
    const a = +m[1], d = +m[2];
    churnAll += a + d;
    let e = per.get(f);
    if (!e) per.set(f, (e = { added: 0, deleted: 0, commits: new Set() }));
    e.added += a; e.deleted += d; e.commits.add(commit);
  }
  const dirs = new Map();
  const dirOf = (f) => (f.includes('/') ? f.split('/')[0] : '(root)');
  const hot = [];
  let totLoc = 0, totChurn = 0;
  for (const [f, n] of loc) {
    const e = per.get(f);
    const ch = e ? e.added + e.deleted : 0;
    totLoc += n; totChurn += ch;
    const k = dirOf(f);
    let d = dirs.get(k);
    if (!d) dirs.set(k, (d = { dir: k, files: 0, loc: 0, churn_lines: 0, commits: new Set() }));
    d.files++; d.loc += n; d.churn_lines += ch;
    if (e) for (const x of e.commits) d.commits.add(x);
    if (ch > 0 && n > 0) hot.push({ path: f, loc: n, churn_lines: ch, added: e.added, deleted: e.deleted, commits: e.commits.size, created_in_window: created.has(f), score: ch * n });
  }
  hot.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const byDir = [...dirs.values()].map((d) => ({ ...d, commits: d.commits.size })).sort((a, b) => b.loc - a.loc);
  const top = hot.slice(0, topN);
  writeResult('ok', shallow ? 'shallow clone: churn covers only the fetched history' : '', {
    summary: `${loc.size} files, ${totLoc} LOC; ${commits} commits / ${totChurn} churned lines in ${sinceDays}d; top hotspot ${top[0] ? `${top[0].path} (${top[0].loc} LOC x ${top[0].churn_lines} churn)` : 'none'}`,
    window_days: sinceDays,
    shallow,
    score: 'churn_lines (added+deleted, renames followed, merges excluded) x current LOC; created_in_window marks files born inside the window, whose churn is mostly their own creation',
    totals: { files: loc.size, loc: totLoc, churn_lines: totChurn, churn_lines_incl_deleted_paths: churnAll, commits },
    excluded,
    by_top_level_dir: byDir,
    hotspots: top,
  });
}

// ─────────────────────────────── ui-bypass ───────────────────────────────
async function uiBypass(cfg) {
  const c = cfg.ui_bypass || {};
  const src = (c.src || 'frontend/src').replace(/\/+$/, '');
  const ui = (c.ui_dir || 'frontend/src/components/ui').replace(/\/+$/, '');
  const missing = [src, ui].filter((d) => !isDir(d));
  if (missing.length) {
    return writeResult('skipped', `${missing.join(', ')} not found in the tree${cfg.ui_bypass ? '' : ' (defaults; set .reckoning.instruments.ui_bypass)'}`, { src, ui_dir: ui });
  }
  const tokenRes = Array.isArray(c.token_files) && c.token_files.length ? c.token_files.map(globToRe)
    : [/(^|\/)(tokens?|theme|themes|palette|colou?rs?|design-tokens)(\.[cm]?[jt]sx?$|\/)/i];
  const isTest = (f) => /(\.test\.|\.spec\.|(^|\/)__tests__\/|(^|\/)tests?\/)/.test(f);
  const inScope = lsFiles().filter((f) => f.startsWith(`${src}/`) && !f.startsWith(`${ui}/`) && !isTest(f.slice(src.length)));
  const CONTROL = /<(button|select|input|textarea)(?=[\s>/])/g;
  const HEX = /(^|[^&\w#])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
  const terms = Array.isArray(c.terms) ? c.terms.filter((t) => typeof t === 'string' && t) : [];
  const allow = Array.isArray(c.allow_phrases) ? c.allow_phrases : ['Ghost Hunting'];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const TERM = terms.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(${terms.map(esc).join('|')})(?![\\p{L}\\p{N}_])`, 'gu') : null;
  const TEXT = /(?:(?<![=\-])>([^<>{};]*\p{L}[^<>{};]*)<|\b(?:title|placeholder|aria-label|alt|label)="([^"]+)"|\btoast(?:\.\w+)?\(\s*(['"`])((?:(?!\3)[^\\\n])*)\3)/gu;
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, '$1');
  const ctl = [], hex = [], tb = [];
  const kinds = { button: 0, select: 0, input: 0, textarea: 0 };
  const byTerm = {};
  const tokenSkipped = [];
  let scanned = 0;
  for (const f of inScope) {
    const jsx = /\.(jsx|tsx)$/.test(f), js = /\.js$/.test(f);
    if (!jsx && !js) continue;
    let text;
    try { text = fs.readFileSync(path.join(TREE, f), 'utf8'); } catch { continue; }
    scanned++;
    if (jsx) {
      const per = { button: 0, select: 0, input: 0, textarea: 0 };
      let m;
      CONTROL.lastIndex = 0;
      while ((m = CONTROL.exec(text))) { per[m[1]]++; kinds[m[1]]++; }
      const n = per.button + per.select + per.input + per.textarea;
      if (n) ctl.push({ path: f, count: n, ...per });
    }
    if (tokenRes.some((r) => r.test(f))) tokenSkipped.push(f);
    else {
      let n = 0;
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('import ')) continue;
        HEX.lastIndex = 0;
        while (HEX.exec(line)) n++;
      }
      if (n) hex.push({ path: f, count: n });
    }
    if (TERM && jsx) {
      let n = 0, m;
      const code = stripComments(text);
      TEXT.lastIndex = 0;
      while ((m = TEXT.exec(code))) {
        let seg = m[1] || m[2] || m[4] || '';
        for (const a of allow) seg = seg.split(a).join(' ');
        TERM.lastIndex = 0;
        let t;
        while ((t = TERM.exec(seg))) { n++; byTerm[t[1]] = (byTerm[t[1]] || 0) + 1; }
      }
      if (n) tb.push({ path: f, count: n });
    }
  }
  const top = (arr) => arr.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, 20);
  const sum = (arr) => arr.reduce((a, b) => a + b.count, 0);
  const controls = sum(ctl), hexes = sum(hex), tbs = sum(tb);
  writeResult('ok', TERM ? '' : 't_bypass skipped: ui_bypass.terms not configured', {
    summary: `${controls} raw controls in ${ctl.length} files; ${hexes} hex colours in ${hex.length} files${TERM ? `; ${tbs} t() bypasses in ${tb.length} files` : ''} (outside ${ui})`,
    src, ui_dir: ui, files_scanned: scanned,
    method: 'grep-level heuristic over tracked files; tests (*.test.*, *.spec.*, __tests__/, test/) excluded; comment and import lines skipped for hex',
    raw_controls: { total: controls, by_kind: kinds, files: ctl.length, top_files: top(ctl) },
    hex_colours: { total: hexes, files: hex.length, token_files_excluded: tokenSkipped, top_files: top(hex) },
    t_bypass: TERM
      ? { status: 'ok', total: tbs, files: tb.length, by_term: byTerm, allow_phrases: allow, method: 'terms in JSX text nodes, title/placeholder/aria-label/alt/label string props and toast() string literals, comments stripped', top_files: top(tb) }
      : { status: 'skipped', reason: 'ui_bypass.terms not configured' },
  });
}

// ─────────────────────────────── agent-context ───────────────────────────────
function walkStrings(node, p, out) {
  if (typeof node === 'string') out.push([p, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => walkStrings(v, `${p}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walkStrings(v, p ? `${p}.${k}` : k, out);
}
function repeatedSentences(strings, minChars) {
  const map = new Map();
  for (const [p, s] of strings) {
    for (const raw of s.split(/(?<=[.!?])\s+|\n+/)) {
      const t = raw.replace(/\s+/g, ' ').trim();
      if (t.length < minChars) continue;
      const key = t.replace(/https?:\/\/[^\s/"']+(?=\/api\/)/g, '');
      let e = map.get(key);
      if (!e) map.set(key, (e = { text: key, count: 0, sizes: [], paths: [] }));
      e.count++; e.sizes.push(Buffer.byteLength(t));
      if (e.paths.length < 6) e.paths.push(p);
    }
  }
  const reps = [...map.values()].filter((e) => e.count >= 2).map((e) => {
    const min = Math.min(...e.sizes);
    return { count: e.count, bytes_each: min, wasted_bytes: e.sizes.reduce((a, b) => a + b, 0) - min, text: e.text.length > 240 ? `${e.text.slice(0, 240)}…` : e.text, paths: e.paths };
  }).sort((a, b) => b.wasted_bytes - a.wasted_bytes);
  const wasted = reps.reduce((a, b) => a + b.wasted_bytes, 0);
  return { min_chars: minChars, distinct_repeated: reps.length, wasted_bytes: wasted, approx_wasted_tokens: tok(wasted), top: reps.slice(0, 25) };
}
// Paraphrase-tolerant companion to repeatedSentences: leaf strings (>= 150 chars) that share
// >= 8 six-word shingles covering >= 25% of the smaller one, clustered by union-find. The
// redundant-byte figure is an ESTIMATE (overlap x bytes of every member but the largest).
function nearDuplicates(strings) {
  const K = 6, MIN = 150;
  const docs = [];
  for (const [p, s] of strings) {
    if (s.length < MIN) continue;
    const w = s.toLowerCase().replace(/https?:\/\/[^\s/"']+(?=\/api\/)/g, '').replace(/[^\p{L}\p{N}/_{}.-]+/gu, ' ').trim().split(/\s+/);
    const sh = new Set();
    for (let i = 0; i + K <= w.length; i++) sh.add(w.slice(i, i + K).join(' '));
    if (sh.size) docs.push({ p, s, bytes: Buffer.byteLength(s), sh });
  }
  const idx = new Map();
  docs.forEach((d, i) => { for (const x of d.sh) { let l = idx.get(x); if (!l) idx.set(x, (l = [])); l.push(i); } });
  const shared = new Map();
  for (const l of idx.values()) {
    if (l.length < 2 || l.length > 40) continue; // a shingle in >40 strings is vocabulary, not a copy
    for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) { const k = `${l[a]}|${l[b]}`; shared.set(k, (shared.get(k) || 0) + 1); }
  }
  const parent = docs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const best = new Map();
  for (const [k, n] of shared) {
    const [i, j] = k.split('|').map(Number);
    const ov = n / Math.min(docs[i].sh.size, docs[j].sh.size);
    if (n < 8 || ov < 0.25) continue;
    parent[find(i)] = find(j);
    for (const x of [i, j]) best.set(x, Math.max(best.get(x) || 0, Math.min(1, ov)));
  }
  const groups = new Map();
  for (const i of best.keys()) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const clusters = [...groups.values()].map((g) => {
    g.sort((a, b) => docs[b].bytes - docs[a].bytes);
    const redundant = Math.round(g.slice(1).reduce((a, i) => a + best.get(i) * docs[i].bytes, 0));
    return { members: g.length, redundant_bytes_estimate: redundant, paths: g.slice(0, 8).map((i) => `${docs[i].p} (${docs[i].bytes} B)`), sample: `${docs[g[0]].s.slice(0, 160)}…` };
  }).sort((a, b) => b.redundant_bytes_estimate - a.redundant_bytes_estimate);
  const total = clusters.reduce((a, c) => a + c.redundant_bytes_estimate, 0);
  return { rule: 'leaf strings >= 150 chars sharing >= 8 six-word shingles covering >= 25% of the smaller; estimate', clusters: clusters.length, redundant_bytes_estimate: total, approx_tokens: tok(total), top: clusters.slice(0, 15) };
}
function analyseManifest(m, minChars, rawBytes) {
  const total = bytesOf(m);
  const sections = Object.entries(m).map(([k, v]) => ({ section: k, bytes: bytesOf(k) + 1 + bytesOf(v) }))
    .sort((a, b) => b.bytes - a.bytes).map((s) => ({ ...s, approx_tokens: tok(s.bytes), pct: +(100 * s.bytes / total).toFixed(1) }));
  let endpoints = null;
  if (Array.isArray(m.endpoints)) {
    const sized = m.endpoints.map((e) => ({ endpoint: e && typeof e === 'object' ? `${e.method || '?'} ${String(e.path || e.url || '?').replace(/^https?:\/\/[^/]+/, '')}` : String(e).slice(0, 80), bytes: bytesOf(e) }))
      .sort((a, b) => b.bytes - a.bytes);
    endpoints = { count: sized.length, bytes: bytesOf(m.endpoints), largest: sized.slice(0, 15).map((e) => ({ ...e, approx_tokens: tok(e.bytes) })) };
  }
  const strings = [];
  walkStrings(m, '', strings);
  return { bytes: total, raw_response_bytes: rawBytes || null, approx_tokens: tok(total), sections, endpoints, repeated_contracts: repeatedSentences(strings, minChars), near_duplicate_passages: nearDuplicates(strings) };
}
async function fetchText(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return t;
}
function clientHeaders(withAuth) {
  const h = {};
  const put = (line) => { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim(); };
  put(E.RECKONING_CLIENT || 'X-Ghost-Client: skill/reckoning');
  if (withAuth && E.RECKONING_AUTH) put(E.RECKONING_AUTH);
  return h;
}
function analyseTools(tools, minChars) {
  const sized = tools.map((t) => {
    const seen = { name: t.name, description: t.description || '', inputSchema: t.inputSchema || t.input_schema || {} };
    return { name: t.name, bytes: bytesOf(seen), description_bytes: Buffer.byteLength(seen.description), schema_bytes: bytesOf(seen.inputSchema), output_schema_bytes: t.outputSchema ? bytesOf(t.outputSchema) : 0 };
  }).sort((a, b) => b.bytes - a.bytes);
  const total = sized.reduce((a, b) => a + b.bytes, 0);
  const strings = tools.map((t) => [`tool:${t.name}`, t.description || '']);
  return {
    count: tools.length, bytes: total, approx_tokens: tok(total),
    description_bytes: sized.reduce((a, b) => a + b.description_bytes, 0),
    input_schema_bytes: sized.reduce((a, b) => a + b.schema_bytes, 0),
    output_schema_bytes_not_counted: sized.reduce((a, b) => a + b.output_schema_bytes, 0),
    largest: sized.slice(0, 15).map((s) => ({ ...s, approx_tokens: tok(s.bytes) })),
    repeated_in_descriptions: repeatedSentences(strings, minChars),
  };
}
async function agentContext(cfg) {
  const c = cfg.agent_context || {};
  const minChars = Number.isInteger(c.min_sentence_chars) ? c.min_sentence_chars : 100;
  const timeout = (Number.isInteger(c.timeout_s) ? c.timeout_s : 180) * 1000;
  const sub = {};
  const failures = [], notes = [];
  // manifest: the pinned tree first, the live API only as a labelled fallback
  let manifest = null;
  if (c.manifest_cmd) {
    const r = runShell(c.manifest_cmd, timeout);
    if (r.ok) {
      try { manifest = { source: 'pinned tree (manifest_cmd)', ...analyseManifest(parseJsonOut(r.stdout), minChars) }; }
      catch (e) { r.ok = false; r.why = `output is not JSON (${e.message})`; }
    }
    if (!r.ok) notes.push(`manifest_cmd ${r.why}${r.stderrTail ? `: ${r.stderrTail}` : ''}`);
  }
  if (!manifest && E.RECKONING_API_BASE) {
    const url = E.RECKONING_API_BASE.replace(/\/+$/, '') + (c.manifest_path || '/api/agent/manifest');
    try {
      const t = await fetchText(url, clientHeaders(false));
      manifest = { source: 'measured from the live API, not the pinned tree', url, ...analyseManifest(JSON.parse(t), minChars, Buffer.byteLength(t)) };
    } catch (e) { notes.push(`live manifest fetch failed: ${e.message}`); }
  }
  if (manifest) sub.manifest = { status: 'ok', ...manifest };
  else if (c.manifest_cmd) { sub.manifest = { status: 'failed', reason: notes.join('; ') }; failures.push('manifest'); }
  else sub.manifest = { status: 'skipped', reason: `no agent_context.manifest_cmd configured and RECKONING_API_BASE unset${notes.length ? `; ${notes.join('; ')}` : ''}` };
  if (manifest && c.manifest_cmd && manifest.source.startsWith('measured from the live API')) sub.manifest.reason = notes.join('; ');
  // agent-facing prose files
  const globs = Array.isArray(c.files) && c.files.length ? c.files : ['CLAUDE.md', 'AGENTS.md', 'agent-claude-md-snippet.md', 'plugins/*/skills/*/SKILL.md'];
  const files = [], unmatched = [];
  const tracked = lsFiles();
  for (const g of globs) {
    const re = globToRe(g);
    const hits = tracked.filter((f) => re.test(f));
    if (!hits.length) unmatched.push(g);
    for (const f of hits) {
      if (files.some((x) => x.path === f)) continue;
      try { const b = fs.statSync(path.join(TREE, f)).size; files.push({ path: f, glob: g, bytes: b, approx_tokens: tok(b) }); } catch { /* tracked but absent */ }
    }
  }
  files.sort((a, b) => b.bytes - a.bytes);
  const fBytes = files.reduce((a, b) => a + b.bytes, 0);
  sub.files = { status: 'ok', globs, unmatched_globs: unmatched, count: files.length, bytes: fBytes, approx_tokens: tok(fBytes), files };
  // MCP tool text
  if (c.mcp_tools_cmd) {
    const r = runShell(c.mcp_tools_cmd, timeout);
    let tools = null;
    if (r.ok) { try { tools = parseJsonOut(r.stdout); if (!Array.isArray(tools)) throw new Error('not an array'); } catch (e) { r.ok = false; r.why = `output is not a JSON tool array (${e.message})`; } }
    if (r.ok) sub.mcp_tools = { status: 'ok', source: 'pinned tree (mcp_tools_cmd)', measured: 'name + description + inputSchema per tool (what the model is shown)', ...analyseTools(tools, minChars) };
    else { sub.mcp_tools = { status: 'failed', reason: `mcp_tools_cmd ${r.why}${r.stderrTail ? `: ${r.stderrTail}` : ''}` }; failures.push('mcp_tools'); }
  } else sub.mcp_tools = { status: 'skipped', reason: 'agent_context.mcp_tools_cmd not configured' };
  const m = sub.manifest.status === 'ok' ? sub.manifest : null;
  const mt = sub.mcp_tools.status === 'ok' ? sub.mcp_tools : null;
  const skipped = Object.entries(sub).filter(([, v]) => v.status === 'skipped').map(([k]) => k);
  const data = {
    summary: [
      m ? `manifest ${kb(m.bytes)} ~${m.approx_tokens} tok, ${m.repeated_contracts.distinct_repeated} repeated sentences wasting ${kb(m.repeated_contracts.wasted_bytes)}, ${m.near_duplicate_passages.clusters} near-duplicate clusters ~${kb(m.near_duplicate_passages.redundant_bytes_estimate)}${m.source.startsWith('measured') ? ' [LIVE API]' : ''}` : `manifest ${sub.manifest.status}`,
      `files ${files.length} = ${kb(fBytes)} ~${tok(fBytes)} tok`,
      mt ? `mcp ${mt.count} tools ${kb(mt.bytes)} ~${mt.approx_tokens} tok` : `mcp ${sub.mcp_tools.status}`,
    ].join('; '),
    approx_tokens_rule: 'bytes / 4',
    ...sub,
  };
  if (failures.length) return writeResult('failed', `configured sub-measure failed: ${failures.map((k) => `${k} (${sub[k].reason})`).join('; ')}`, data);
  const reason = [skipped.length ? `skipped: ${skipped.map((k) => `${k} (${sub[k].reason})`).join('; ')}` : '', m && m.source.startsWith('measured') ? 'manifest measured from the live API, not the pinned tree' : ''].filter(Boolean).join('; ');
  // The manifest is this instrument's primary measure: without it the result is not an "ok".
  writeResult(m ? 'ok' : 'skipped', reason, data);
}

// ─────────────────────────────── sql-per-request ───────────────────────────────
async function sqlPerRequest(cfg) {
  const c = cfg.sql_probe;
  if (!c || typeof c !== 'object') return writeResult('skipped', 'not configured (.reckoning.instruments.sql_probe absent)', {});
  const cmdDir = c.cmd_dir || 'backend';
  const py = c.python || `${cmdDir}/venv/bin/python`;
  const testArgs = Array.isArray(c.test_args) && c.test_args.length ? c.test_args.map(String) : ['tests', '-q'];
  const timeoutS = Number.isInteger(c.timeout_s) && c.timeout_s > 0 ? c.timeout_s : 5400;
  const cwd = path.join(TREE, cmdDir);
  const pyAbs = path.isAbsolute(py) ? py : path.join(TREE, py);
  const runner = path.join(PROBES, 'run_suite.py');
  if (!isDir(cmdDir)) return writeResult('skipped', `sql_probe.cmd_dir ${cmdDir} not found in the tree`, {});
  try { fs.accessSync(pyAbs, fs.constants.X_OK); } catch { return writeResult('skipped', `interpreter not found or not executable: ${py} (is the venv provisioned in the tree?)`, {}); }
  for (const f of ['run_suite.py', 'sqlcount.py']) if (!fs.existsSync(path.join(PROBES, f))) return writeResult('failed', `probe file missing: ${path.join(PROBES, f)}`, {});
  const argv = [pyAbs, runner, ...testArgs];
  if (argv.some((a) => a.toLowerCase().includes(RUNNER_WORD))) {
    return writeResult('skipped', `refusing to run: the argv would contain "${RUNNER_WORD}", so a sibling lane's pkill -f could kill it (rename the path/args)`, { argv });
  }
  const rawOut = path.join(OUT, '.sqlcount.raw.json');
  const logPath = path.join(OUT, 'sql-per-request.log');
  try { fs.unlinkSync(rawOut); } catch { /* none */ }
  const env = childEnv();
  delete env.DATABASE_URL; // hermetic: the suite's own test database, never a developer's
  for (const [k, v] of Object.entries(c.env && typeof c.env === 'object' ? c.env : {})) env[k] = String(v);
  env.PYTHONPATH = [PROBES, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.RECKONING_SQLCOUNT_OUT = rawOut;
  const logFd = fs.openSync(logPath, 'w');
  const t0 = Date.now();
  const r = cp.spawnSync(pyAbs, argv.slice(1), { cwd, env, stdio: ['ignore', logFd, logFd], timeout: timeoutS * 1000, killSignal: 'SIGTERM' });
  fs.closeSync(logFd);
  const dur = +((Date.now() - t0) / 1000).toFixed(1);
  const SIG = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGTERM: 15 };
  const exit = r.status !== null && r.status !== undefined ? r.status : r.signal ? 128 + (SIG[r.signal] || 0) : -1;
  const logTail = (() => { try { return fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-4).join(' | ').slice(0, 600); } catch { return ''; } })();
  const run = { cwd: cmdDir, argv: [py, runner, ...testArgs], exit, signal: r.signal || null, duration_s: dur, timeout_s: timeoutS, log: logPath };
  if (r.error && r.error.code === 'ETIMEDOUT') return writeResult('failed', `suite timed out after ${timeoutS}s (killed; exit ${exit})`, { run, log_tail: logTail });
  if (r.error && r.error.code !== 'ETIMEDOUT') return writeResult('failed', `could not start the runner: ${r.error.message}`, { run });
  if (exit >= 128 || r.signal) return writeResult('failed', `runner killed (exit ${exit}${r.signal ? `, ${r.signal}` : ''}) — a sibling lane's pkill, OOM or a signal; counts are incomplete`, { run, log_tail: logTail });
  let doc;
  try { doc = JSON.parse(fs.readFileSync(rawOut, 'utf8')); } catch (e) {
    return writeResult('failed', `probe wrote no readable output (runner exit ${exit}): ${e.code === 'ENOENT' ? 'file missing — did -p sqlcount load?' : e.message}`, { run, log_tail: logTail });
  }
  try { fs.unlinkSync(rawOut); } catch { /* embedded below */ }
  const sc = doc.self_check || {};
  const T = (doc.session || {}).tests || {};
  const eps = doc.endpoints || [];
  const topStmts = eps.slice().sort((a, b) => b.statements.mean - a.statements.mean).slice(0, 25)
    .map((e) => ({ key: `${e.method} ${e.path}`, calls: e.calls, stmts_min: e.statements.min, stmts_mean: e.statements.mean, stmts_max: e.statements.max, max_identical: e.n_plus_one.max_repeat, max_items: e.items.max, dialects: e.dialects }));
  const nPlusOne = eps.filter((e) => e.n_plus_one.max_repeat >= 3).sort((a, b) => b.n_plus_one.max_repeat - a.n_plus_one.max_repeat)
    .map((e) => ({ key: `${e.method} ${e.path}`, max_identical: e.n_plus_one.max_repeat, calls_with_repeat_ge3: e.n_plus_one.calls_with_repeat_ge3, calls: e.calls, in_call_with_stmts: e.n_plus_one.in_call_with_stmts, in_call_with_items: e.n_plus_one.in_call_with_items, dialects: e.dialects, statement: e.n_plus_one.statement }));
  const grows = eps.filter((e) => e.growth.flag).map((e) => ({ key: `${e.method} ${e.path}`, slope_stmts_per_item: e.growth.slope_stmts_per_item, r: e.growth.r, points: e.growth.points, mean_stmts_by_items: e.growth.mean_stmts_by_items }));
  const aborted = eps.filter((e) => e.aborted && e.aborted.total > 0).sort((a, b) => b.aborted.total - a.aborted.total)
    .map((e) => ({ key: `${e.method} ${e.path}`, total: e.aborted.total, calls_with_aborted: e.aborted.calls_with_aborted, calls: e.calls, max_in_one_call: e.aborted.max_in_one_call, by_exception: e.aborted.by_exception }));
  const greenlet = aborted.filter((a) => a.by_exception.MissingGreenlet);
  const byD = sc.attributed_by_dialect || {};
  const dTot = Object.values(byD).reduce((a, b) => a + b, 0);
  const db = Object.entries(byD).sort((a, b) => b[1] - a[1]).map(([d, n]) => (Object.keys(byD).length > 1 ? `${d} ${n}/${dTot} stmts` : d)).join(' + ') || (sc.dialects_seen || []).join('+') || 'unknown';
  const multiDialect = eps.filter((e) => (e.dialects || []).length && (e.dialects.length > 1 || e.dialects[0] !== Object.entries(byD).sort((a, b) => b[1] - a[1])[0][0])).map((e) => `${e.method} ${e.path} [${e.dialects.join('+')}]`);
  const data = {
    summary: `${eps.length} endpoints from ${sc.requests} requests; worst ${topStmts[0] ? `${topStmts[0].key} = ${topStmts[0].stmts_mean} stmts/call` : 'n/a'}; ${nPlusOne.length} N+1 signatures (>=3 identical); ${grows.length} grow with items; ${greenlet.length} with MissingGreenlet lazy loads; suite exit ${exit} (${T.failed || 0} failed, ${T.errors || 0} errors) [${db}, fixture cardinality]`,
    label: `${db}, fixture cardinality`,
    caveats: doc.caveats || [],
    endpoints_off_main_dialect: multiDialect,
    run,
    session: doc.session,
    self_check: sc,
    top_by_statements: topStmts,
    n_plus_one: nPlusOne,
    grows_with_items: grows,
    growth_rule: 'flag when >=3 2xx calls with >=1 item and >=2 distinct item counts give slope >= 0.5 stmts/item and Pearson r >= 0.5 (zero-item calls excluded: eager loads step 0 -> 1)',
    aborted_statements: aborted,
    aborted_note: 'statements that raised instead of completing; MissingGreenlet = an async lazy load that never reached the database (the field it feeds is silently empty)',
    endpoints: eps,
  };
  if (!sc.ok) return writeResult('failed', `probe self-check failed: ${sc.reason || 'unknown'}`, data);
  if (exit > 1) return writeResult('failed', `suite exit ${exit} (interrupted, internal or usage error, or no tests collected); counts cover only what ran`, data);
  writeResult('ok', exit === 1 ? `suite exit 1 (${T.failed || 0} failed, ${T.errors || 0} errors) — counts are still valid` : '', data);
}

// ─────────────────────────────── loose-ends ───────────────────────────────
async function looseEnds(cfg, ghostCfg) {
  const c = cfg.loose_ends || {};
  const staleDays = Number.isFinite(c.stale_days) ? c.stale_days : 7;
  const base = (E.RECKONING_API_BASE || '').replace(/\/+$/, '');
  if (!base || !E.RECKONING_AUTH) return writeResult('skipped', 'RECKONING_API_BASE and RECKONING_AUTH are both required', {});
  const H = clientHeaders(true);
  const now = Date.now();
  const days = (t) => (t ? +((now - new Date(t).getTime()) / 864e5).toFixed(1) : null);
  let calls = 0;
  async function api(method, p, body) {
    calls++;
    const r = await fetch(base + p, { method, headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} → HTTP ${r.status}${r.status === 401 ? ' (talisman rejected)' : ''}: ${t.slice(0, 200)}`);
    return JSON.parse(t);
  }
  async function pages(p, body) {
    const items = [];
    for (let off = 0; ; ) {
      const r = body ? await api('POST', p, { ...body, limit: 200, offset: off })
        : await api('GET', `${p}${p.includes('?') ? '&' : '?'}limit=200&offset=${off}`);
      const got = Array.isArray(r) ? r : r.items || [];
      items.push(...got);
      if (Array.isArray(r) || !r.has_more || !got.length) break;
      off += got.length;
      if (off > 50000) throw new Error(`pagination runaway on ${p}`);
    }
    return items;
  }
  async function pool(list, n, fn) {
    const out = new Array(list.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } }));
    return out;
  }
  // scope: the skill's snapshot when present, else the repo posture from .ghost/config.json
  let scope = null;
  const scopeFile = SNAP ? path.join(SNAP, 'scope.json') : '';
  if (scopeFile && fs.existsSync(scopeFile)) {
    try { scope = JSON.parse(fs.readFileSync(scopeFile, 'utf8')); } catch (e) { return writeResult('failed', `snapshot scope.json is not valid JSON: ${e.message}`, {}); }
  }
  const se = ghostCfg.seance || {};
  const posture = se.scope || (se.id ? 'seance' : 'coven');
  const checks = {};
  const errors = [];
  let org = scope && scope.org_id;
  try { if (!org) { const me = await api('GET', '/api/agent/me'); org = me.org_id || (me.organization && me.organization.id); } }
  catch (e) { return writeResult('failed', `identity check failed: ${e.message}`, {}); }
  let seanceProjects = null;
  const inSeance = async () => {
    if (seanceProjects) return seanceProjects;
    seanceProjects = new Set((await pages(`/api/agent/hauntings?portfolio_id=${se.id}`)).map((p) => p.id));
    return seanceProjects;
  };
  const scopeLabel = scope ? `snapshot scope.json${scope.kind ? ` (${scope.kind})` : ''}` : posture === 'seance' && se.id ? `séance ${se.id} (config posture)` : 'whole Coven (config posture)';
  const snapGhosts = scope && Array.isArray(scope.ghosts) ? scope.ghosts : null;
  // 1. Rites still invoked whose top-level ghosts are all / all-but-one exorcised
  try {
    const rites = scope && Array.isArray(scope.rites) ? scope.rites : await pages(`/api/agent/covens/${org}/rites?status=invoked`);
    const out = [];
    let outOfScope = 0;
    for (const r of rites.filter((x) => x.status === 'invoked')) {
      let total = r.total_tasks, done = r.ghost_status_counts ? r.ghost_status_counts.exorcised || 0 : r.completed_tasks;
      if (total === undefined && snapGhosts) {
        const g = snapGhosts.filter((x) => x.milestone_id === r.id && !x.parent_task_id);
        total = g.length; done = g.filter((x) => x.status === 'exorcised').length;
      }
      if (!(total > 0 && done >= 1 && total - done <= 1)) continue;
      let open = null;
      if (!scope) {
        const gs = await pages(`/api/agent/rites/${r.id}/ghosts`);
        if (posture === 'seance' && se.id) {
          const mine = await inSeance();
          if (!gs.some((g) => mine.has(g.project_id))) { outOfScope++; continue; }
        }
        open = gs.filter((g) => g.status !== 'exorcised').map((g) => ({ id: g.id, title: g.title, status: g.status }));
      } else if (snapGhosts) {
        open = snapGhosts.filter((g) => g.milestone_id === r.id && !g.parent_task_id && g.status !== 'exorcised').map((g) => ({ id: g.id, title: g.title, status: g.status }));
      }
      out.push({ id: r.id, name: r.name, total_top_level: total, exorcised: done, remaining: total - done, open_ghosts: open });
    }
    checks.rites_ready_to_seal = { status: 'ok', rule: 'status invoked, top-level ghosts all or all-but-one exorcised (>=1 exorcised)', scope: scopeLabel, out_of_scope_skipped: outOfScope, items: out };
  } catch (e) { checks.rites_ready_to_seal = { status: 'failed', reason: e.message }; errors.push(`rites: ${e.message}`); }
  // 2. Ghosts in purgatory whose linked PR (Apparition) is merged
  try {
    let purg;
    if (snapGhosts) purg = snapGhosts.filter((g) => g.status === 'purgatory');
    else {
      const conds = [{ field: 'status', operator: 'is', values: ['purgatory'] }];
      if (posture === 'seance' && se.id) conds.push({ field: 'portfolio', operator: 'is', values: [se.id] });
      purg = await pages('/api/agent/ghosts/filter', { groups: [{ conditions: conds }] });
    }
    const rows = await pool(purg, 4, async (g) => ({ g, apps: Array.isArray(g.apparitions) ? g.apparitions : await api('GET', `/api/agent/ghosts/${g.id}/apparitions`) }));
    const items = rows.map(({ g, apps }) => ({ g, merged: (apps || []).filter((a) => a.status === 'merged' || a.merged_at), n: (apps || []).length }))
      .filter((x) => x.merged.length)
      .map(({ g, merged }) => ({ id: g.id, title: g.title, project_id: g.project_id, prs: merged.map((a) => ({ number: a.pr_number, url: a.pr_url, merged_at: a.merged_at })), days_since_merge: days(merged.map((a) => a.merged_at).filter(Boolean).sort().pop()) }));
    checks.purgatory_with_merged_pr = { status: 'ok', scope: scopeLabel, purgatory_total: purg.length, without_any_apparition: rows.filter((x) => !(x.apps || []).length).length, items };
  } catch (e) { checks.purgatory_with_merged_pr = { status: 'failed', reason: e.message }; errors.push(`purgatory: ${e.message}`); }
  // 3. Invocations parked in awaiting_hunter
  try {
    const inv = await pages(`/api/agent/covens/${org}/invocations?status=awaiting_hunter`);
    checks.invocations_awaiting_hunter = { status: 'ok', scope: 'whole Coven (Invocations carry no Haunting)', items: inv.map((v) => ({ id: v.id, title: v.title, workflow_name: v.workflow_name, is_ad_hoc: v.is_ad_hoc, resumable: v.resumable, step_counts: v.step_counts, started_at: v.started_at, age_days: days(v.started_at || v.created_at) })) };
  } catch (e) { checks.invocations_awaiting_hunter = { status: 'failed', reason: e.message }; errors.push(`invocations: ${e.message}`); }
  // git half — read-only against the main checkout that owns the tree
  let common = '';
  try { common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(); } catch { /* below */ }
  const main = common.endsWith('/.git') ? path.dirname(common) : '';
  let prs = null, prWhy = '';
  if (main) {
    const r = cp.spawnSync('gh', ['pr', 'list', '--state', 'open', '--json', 'headRefName,number,url', '--limit', '1000'], { cwd: main, encoding: 'utf8', timeout: 60000, env: childEnv() });
    if (r.error) prWhy = r.error.code === 'ENOENT' ? 'gh CLI not installed' : `gh failed: ${r.error.message}`;
    else if (r.status !== 0) prWhy = `gh pr list exited ${r.status}: ${String(r.stderr).trim().split('\n')[0]}`;
    else { try { prs = new Map(JSON.parse(r.stdout).map((p) => [p.headRefName, p])); } catch (e) { prWhy = `gh output unreadable: ${e.message}`; } }
  } else prWhy = 'main checkout not resolvable from the tree (bare or non-standard git dir)';
  const slugOf = (b) => b.replace(/^ext\//, '').replace(/[^A-Za-z0-9_]/g, '');
  const openSlugs = prs ? new Set([...prs.keys()].filter((b) => b.startsWith('ext/')).map(slugOf)) : null;
  const lastCommit = (ref) => { try { return +git(['log', '-1', '--format=%ct', ref], main).trim() * 1000; } catch { return null; } };
  const ageOf = (ms) => (ms ? +((now - ms) / 864e5).toFixed(1) : null);
  // 4. .haunt-wt worktrees with no open PR and a last commit older than stale_days
  const wts = [];
  if (main) {
    let cur = null;
    for (const line of git(['worktree', 'list', '--porcelain'], main).split('\n')) {
      if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null, head: null }; wts.push(cur); }
      else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
      else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
  }
  const hauntWt = wts.filter((w) => w.path.startsWith(`${main}/.haunt-wt/`));
  if (!main || !prs) checks.stale_haunt_worktrees = { status: 'skipped', reason: prWhy || 'no main checkout', worktrees_seen: hauntWt.length };
  else {
    const items = [];
    for (const w of hauntWt) {
      const age = ageOf(lastCommit(w.head || 'HEAD'));
      if (w.branch && prs.has(w.branch)) continue;
      if (age === null || age <= staleDays) continue;
      const st = cp.spawnSync('git', ['--no-optional-locks', '-C', w.path, 'status', '--porcelain'], { encoding: 'utf8', timeout: 30000 });
      items.push({ path: w.path, branch: w.branch || '(detached)', last_commit_age_days: age, dirty_files: st.status === 0 ? st.stdout.split('\n').filter(Boolean).length : null });
    }
    checks.stale_haunt_worktrees = { status: 'ok', rule: `under ${main}/.haunt-wt/, branch has no open PR, last commit > ${staleDays}d`, worktrees_seen: hauntWt.length, items };
  }
  // 5. ext/* branches with no open PR
  if (!main || !prs) checks.ext_branches_without_open_pr = { status: 'skipped', reason: prWhy || 'no main checkout' };
  else {
    const lines = git(['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads/ext/'], main).split('\n').filter(Boolean);
    const inWt = new Map(wts.filter((w) => w.branch).map((w) => [w.branch, w.path]));
    const items = lines.map((l) => l.split('\t')).filter(([b]) => !prs.has(b))
      .map(([b, t]) => ({ branch: b, last_commit_age_days: ageOf(+t * 1000), worktree: inWt.get(b) || null }))
      .sort((a, b) => (b.last_commit_age_days || 0) - (a.last_commit_age_days || 0));
    checks.ext_branches_without_open_pr = { status: 'ok', local_ext_branches: lines.length, items };
  }
  // 6. rite-cadence parked patches older than stale_days
  const parkDir = common ? path.join(common, 'rite-cadence-parked') : '';
  if (!parkDir) checks.stale_parked_patches = { status: 'skipped', reason: 'git common dir not resolvable' };
  else {
    let names = [];
    try { names = fs.readdirSync(parkDir).filter((n) => n.endsWith('.patch')); } catch { /* no parked patches ever */ }
    const items = [];
    for (const n of names) {
      const m = n.match(/^(.+?)\.w(\d+)\.([^.]+)\.(\d{9,11})\.patch$/);
      let ms = m ? +m[4] * 1000 : null;
      if (!ms) { try { ms = fs.statSync(path.join(parkDir, n)).mtimeMs; } catch { ms = null; } }
      const age = ageOf(ms);
      if (age === null || age <= staleDays) continue;
      const slug = m ? m[1] : null;
      items.push({ patch: path.join(parkDir, n), slug, wave: m ? +m[2] : null, phase: m ? m[3] : null, age_days: age, bytes: (() => { try { return fs.statSync(path.join(parkDir, n)).size; } catch { return null; } })(), open_pr_for_slug: openSlugs && slug ? openSlugs.has(slug) : null });
    }
    checks.stale_parked_patches = { status: 'ok', dir: parkDir, patches_total: names.length, rule: `parked > ${staleDays}d (open_pr_for_slug null when gh is unavailable)`, items };
  }
  const n = (k) => (checks[k] && checks[k].status === 'ok' ? checks[k].items.length : checks[k] ? checks[k].status : '?');
  const data = {
    summary: `rites ready to seal ${n('rites_ready_to_seal')}; purgatory w/ merged PR ${n('purgatory_with_merged_pr')}; awaiting_hunter ${n('invocations_awaiting_hunter')}; stale .haunt-wt ${n('stale_haunt_worktrees')}; ext/* w/o PR ${n('ext_branches_without_open_pr')}; parked > ${staleDays}d ${n('stale_parked_patches')}`,
    scope: scopeLabel, posture, stale_days: staleDays, api_base: base, api_calls: calls, main_checkout: main || null,
    checks,
  };
  if (errors.length) return writeResult('failed', `API sub-check failed: ${errors.join(' ; ')}`, data);
  const skipped = Object.entries(checks).filter(([, v]) => v.status === 'skipped').map(([k, v]) => `${k} (${v.reason})`);
  writeResult('ok', skipped.length ? `sub-checks skipped: ${skipped.join('; ')}` : '', data);
}

// ─────────────────────────────── dispatch ───────────────────────────────
(async () => {
  const C = loadCfg();
  if (C.error) return writeResult('failed', C.error, {});
  const fn = { churn, 'ui-bypass': uiBypass, 'agent-context': agentContext, 'sql-per-request': sqlPerRequest, 'loose-ends': looseEnds }[NAME];
  if (!fn) return writeResult('failed', `unknown instrument ${NAME}`, {});
  try { await fn(C.cfg, C.ghost); } catch (e) {
    writeResult('failed', `instrument crashed: ${String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')}`, {});
  }
})();
JS
}

summary_line() { # name
  node -e '
    const f = process.argv[1];
    try {
      const d = JSON.parse(require("fs").readFileSync(f, "utf8"));
      const s = (d.data && d.data.summary) || "";
      const r = d.reason ? (s ? " — " + d.reason : d.reason) : "";
      process.stdout.write((s + r).replace(/\s+/g, " ").slice(0, 400));
    } catch (e) { process.stdout.write("(unreadable result)"); }' "$OUT/$1.json"
}

for name in $SELECTED; do
  rm -f "$OUT/$name.json"
  if [ "$NODE_OK" -ne 1 ]; then
    write_raw "$name" failed "$NODE_WHY"
    printf '%-16s %-8s %s\n' "$name" failed "$NODE_WHY"
    continue
  fi
  ERR="$OUT/.$name.stderr.$$"
  js_main | RI_NAME="$name" RI_TREE="$TREE" RI_OUT="$OUT" RI_SHA="$SHA" RI_SNAPSHOT="$SNAP" RI_PROBES="$PROBES" node - 2>"$ERR"
  rc=$?
  if [ ! -s "$OUT/$name.json" ]; then
    write_raw "$name" failed "node exited $rc without a result: $(tail -n 3 "$ERR" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
  fi
  rm -f "$ERR"
  status="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status)}catch(e){process.stdout.write("failed")}' "$OUT/$name.json" 2>/dev/null || echo failed)"
  printf '%-16s %-8s %s\n' "$name" "$status" "$(summary_line "$name")"
done

# Tripwire: the instruments must leave the tree exactly as they found it (ignored files included).
tree_state > "$AFTER"
if ! cmp -s "$BEFORE" "$AFTER"; then
  echo "WARNING: the tree's git status changed while the instruments ran:" >&2
  diff "$BEFORE" "$AFTER" | sed -n '1,20p' >&2
fi
rm -f "$BEFORE" "$AFTER"
exit 0
