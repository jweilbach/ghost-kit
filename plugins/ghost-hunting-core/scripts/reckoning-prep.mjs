#!/usr/bin/env node
// reckoning-prep.mjs — the deterministic half of the /reckoning skill.
//
// The skill is prose a model executes; everything here is the part that must be EXACT: resolving
// the scope through the API, snapshotting it into files the leaves read, assigning every tracked
// source file to a shard, splitting fidelity batches, estimating the run, composing each Part's args
// (ids copied by code, never retyped by a model), recording a Part's result against its seal and the
// tree tripwire, and keeping the outputs.
//
//   init     --run R --tree T --scope KIND [--target X] [--depth D] [--reason S] [--parts a,b]
//            [--lenses a,b] [--budget N] [--local]
//   args     --run R --part KEY [--engine vendored.js] [--force] [--leaf-agent-type T]
//   record   --run R --key KEY --result result.json
//   status   --run R
//   finalize --run R
//
// Layout: <run>/snapshot, <run>/instruments, <run>/parts/<key>.g<gen> (a recorded Part's bus, copied
// OUT of the tree so a resume or a removed tree never loses it), <run>/tree (the pinned detached tree;
// each Part's bus is <tree>/.reckoning/gen-<gen>/<key>, the only place its leaves may write).
// KEY is imprints | fidelity[-N] | health-<group> | verdict. Every command prints one JSON object.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, cpSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { git, pluginRoot, version } from '../runtime/project.mjs';
import { reckoningClient } from './reckoning-api.mjs';

const KINDS = ['backend', 'frontend', 'agent-surface', 'plugin', 'migrations', 'tests', 'infra'];
const OPEN = ['ether', 'active_haunt', 'purgatory', 'poltergeist'];
// Plugin personas' default kinds. A repo persona must be mapped in .ghost/config.json
// reckoning.personas (or <run>/personas.json) — the skill maps unknown ones from their description.
const DEFAULT_PERSONA_KINDS = {
  'staff-engineer': ['backend', 'agent-surface', 'migrations', 'infra'],
  'product-manager': ['backend', 'frontend', 'agent-surface', 'plugin'],
  'senior-ux': ['frontend'],
};
// Files every shard map must cover (code); docs and config are reviewed when a shard claims them.
const CODE_RE = /\.(py|js|jsx|ts|tsx|mjs|cjs|sh|css|scss|sql|html|vue|svelte|go|rb|rs|java|kt|swift)$/i;
const SKIP_RE = /(^|\/)(node_modules|dist|build|venv|\.venv|__pycache__|vendor)\//;

const writeJSON = (file, obj) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, file);
};
const readJSON = (file, dflt) => (file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : dflt);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
const fail = (msg, code = 1, extra = {}) => {
  out({ ok: false, error: msg, ...extra });
  process.exit(code);
};
const trim = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + ' …[trimmed]' : s);
const djb2 = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const id8 = (id) => String(id || '').slice(0, 8);
const BUS = join(pluginRoot, 'scripts', 'reckoning-bus.sh');

async function pmap(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}
const runOf = (values) => resolve(values.run);
const stateOf = (run) => readJSON(join(run, 'state.json'), null);
const dirty = (tree) => git(tree, 'status', '--porcelain', '-uall').split('\n').filter(Boolean);

// ── shard assignment: every tracked code file lands in exactly one shard ─────────────────────
// The most specific pattern wins: an exact file (3) beats a glob (2) beats a directory (1, longer
// prefix first), so a co-located test glob wins over its page's directory.
const globRe = (pat) => new RegExp('^' + pat.split('**/').map((a) => a.split('**').map((b) => b.split('*').map((c) => c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')).join('(?:.*/)?') + '$');
function matchScore(file, raw) {
  const pat = String(raw).split(' (')[0].trim(); // prose after " (" is a note for the reader
  if (!pat) return 0;
  if (pat.includes('*')) return globRe(pat).test(file) ? 2 : 0;
  if (file === pat) return 3;
  const dir = pat.endsWith('/') ? pat : pat + '/';
  return file.startsWith(dir) ? 1 + dir.length / 10000 : 0;
}
function assignShards(tree, shardsCfg, groups) {
  const tracked = git(tree, 'ls-files').split('\n').filter((f) => f && !SKIP_RE.test(f) && !/^\.claude\/workflows\/.*\.js$/.test(f));
  const shards = shardsCfg.map((s) => ({ ...s, files: [] }));
  const uncovered = [];
  for (const f of tracked) {
    let best = null;
    let score = 0;
    for (const s of shards) for (const p of s.paths) { const sc = matchScore(f, p); if (sc > score) { score = sc; best = s; } }
    if (best) best.files.push(f);
    else if (CODE_RE.test(f)) uncovered.push(f);
  }
  // Nothing is dropped: uncovered code becomes an auto shard per top-level dir, in the group that
  // already reviews the most of that kind.
  const guess = (top) => (/^backend|^api|^server/.test(top) ? 'backend' : /^frontend|^web|^app|^client/.test(top) ? 'frontend' : /^plugins?/.test(top) ? 'plugin' : 'infra');
  const byTop = new Map();
  for (const f of uncovered) { const top = f.includes('/') ? f.split('/')[0] : '(root)'; if (!byTop.has(top)) byTop.set(top, []); byTop.get(top).push(f); }
  for (const [top, files] of byTop) {
    const kind = guess(top);
    const g = shards.filter((s) => s.kind === kind).sort((a, b) => b.files.length - a.files.length)[0]?.group || groups[0]?.name || 'all';
    shards.push({ name: slug(`unsharded-${top}`), kind, group: g, paths: [], files, auto: true });
  }
  return { shards: shards.filter((s) => s.files.length), empty: shards.filter((s) => !s.files.length).map((s) => s.name), uncovered: uncovered.length, auto: [...byTop.keys()] };
}

// ── tenets lint: the one repo file every finder and refuter reads in full ──
// Nothing truncates it, so its size is paid on every agent — warned past TENETS_WARN_BYTES. Its
// `path:line` pointers are what an intent refuter reads to settle a Deliberate exception, and a bare
// line number rots with every edit above it (one consumer repo: ~40 stale within three weeks). A pointer
// followed by a quoted anchor phrase is checkable: the phrase must still be on that line, or the
// lint names the line it moved to. Paths resolve against the PINNED tree — what the refuters read.
export const TENETS_WARN_BYTES = 24 * 1024;
export function tenetsLint(text, tree) {
  const files = new Map();
  const linesOf = (rel) => {
    if (!files.has(rel)) {
      const f = join(tree, rel);
      files.set(rel, existsSync(f) && statSync(f).isFile() ? readFileSync(f, 'utf8').split('\n') : null);
    }
    return files.get(rel);
  };
  const norm = (s) => s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const problems = [];
  let tenet = '';
  let pointers = 0;
  let anchored = 0;
  for (const row of text.split('\n')) {
    const h = row.match(/^## (T-[a-z0-9-]+)/);
    if (h) { tenet = h[1]; continue; }
    if (!tenet) continue;
    // `path:12` or `path:12-20`, optionally followed by "anchor phrase" (straight or curly quotes).
    for (const m of row.matchAll(/`([^`\s:]+):(\d+)(?:-\d+)?`(?:\s*[(:—–-]?\s*["“]([^"”]{3,200})["”])?/g)) {
      const [, rel, n, quote] = m;
      // A pointer names a file in this repo: relative, inside the tree, with an extension (so
      // `localhost:8000` is not one).
      if (rel.startsWith('/') || rel.split('/').includes('..') || !/\.[A-Za-z0-9]+$/.test(rel)) continue;
      pointers += 1;
      const pointer = `${rel}:${n}`;
      const lines = linesOf(rel);
      const at = Number(n);
      if (!lines) { problems.push({ tenet, pointer, problem: 'no such file in the pinned tree' }); continue; }
      if (quote) {
        anchored += 1;
        const want = norm(quote);
        if (at <= lines.length && norm(lines[at - 1]).includes(want)) continue;
        const moved = lines.findIndex((l) => norm(l).includes(want));
        problems.push({ tenet, pointer, problem: moved >= 0 ? `its anchor "${quote}" moved to line ${moved + 1}` : `its anchor "${quote}" is no longer in the file` });
        continue;
      }
      if (at > lines.length) problems.push({ tenet, pointer, problem: `past the end of the file (${lines.length} lines)` });
      else if (!lines[at - 1].trim()) problems.push({ tenet, pointer, problem: 'a blank line' });
    }
  }
  return { bytes: Buffer.byteLength(text), pointers, anchored, problems };
}

// ── model split: how many agents of each tier a run will spend (rough, and said to be rough) ──
// Mirrors the engine's ROLE_MODELS: Fable only for the synthesis roles and the plugin's reasoning
// personas; Opus for the bulk; Sonnet for the seal scribes. Ratios are from the pilots: ~5 findings
// per finder, ~12 claims per ghost, refuters batched 5 per call.
const PRINCIPLE_GROUPS_BY_KIND = { backend: 4, frontend: 5, 'agent-surface': 5, plugin: 4, migrations: 3, tests: 2, infra: 4 };
// `--parts imprints` alone is the BARE Imprint reckoning: no verdict step. The Imprint check's own
// sealed ops are the plan (apply reads them directly) and publish writes the Scroll from them.
export const imprintsOnly = (parts) => Array.isArray(parts) && parts.length === 1 && parts[0] === 'imprints';

// The Parts a run chooses. `verdict` is never one: it is the step over the chosen Parts, so a typed
// `verdict` (any casing, any number of times) is dropped instead of becoming a Part the verdict would
// wait on. `--parts verdict` alone means "the usual run", so it gets the default Parts — never the
// bare Imprint reckoning, which has no verdict at all. May return [] (init refuses that).
export function initParts(values, scopeKind, warnings) {
  const defaults = scopeKind === 'repo' ? ['health', 'imprints'] : ['fidelity', 'health', 'imprints'];
  const typed = values.parts ? String(values.parts).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [...defaults];
  let parts = typed.filter((x) => x !== 'verdict');
  const droppedVerdict = parts.length < typed.length;
  const verdictAlone = droppedVerdict && !parts.length;
  if (verdictAlone) parts = [...defaults];
  // The Imprint check is ON in every run, scoped to what the run touches; only --no-imprints skips it.
  if (!values['no-imprints'] && !parts.includes('imprints')) parts.push('imprints');
  if (values['no-imprints']) parts = parts.filter((x) => x !== 'imprints');
  if (droppedVerdict && parts.length) {
    const list = parts.join(', ');
    warnings.push(verdictAlone
      ? `\`--parts verdict\` alone runs the default Parts (${list}) and the verdict over them: \`verdict\` is not a Part, and the bare Imprint reckoning is \`--parts imprints\``
      : imprintsOnly(parts)
        ? '`verdict` was dropped from --parts: with only `imprints` left this is the bare Imprint reckoning, which has no verdict step — name another Part to get one'
        : `\`verdict\` was dropped from --parts: it is not a Part but the step this run ends in, over its Parts (${list})`);
  }
  return parts;
}

export function modelSplit({ shards = [], groups = [], personas = [], depth = 'standard', parts = [], ghosts = 0, exorcised = 0, units = [], imprints = 0, orgImprints = 0, posture = 'seance', named = false, perFinder = depth === 'survey' ? 8 : 5 }) {
  const t = () => ({ fable: 0, opus: 0, sonnet: 0 });
  const P = personas.filter((x) => x.kinds && x.kinds.length && x.file);
  const out = {};
  if (parts.includes('health')) for (const g of groups) {
    const m = t();
    const ss = shards.filter((s) => s.group === g.name);
    m.opus += ss.reduce((n, s) => n + (depth === 'survey' || (named && (s.touched || []).length <= 6) ? 1 : PRINCIPLE_GROUPS_BY_KIND[s.kind] || 3), 0);
    for (const p of P) {
      const mine = ss.filter((s) => p.kinds.includes(s.kind)).length;
      if (mine) m[p.reasoning ? 'fable' : 'opus'] += depth === 'survey' ? 1 : Math.ceil(mine / 4);
    }
    if (g.cross_cutting) m.fable += named ? 1 : 5;
    const finders = m.fable + m.opus;
    // Refuters, from pilot C (backend, survey, 2026-09-29): finders fill their cap (141 findings from 18
    // finders = 0.98 of 8) and each finding draws ~2.4 votes (majors get three lenses), 6 per call.
    m.opus += Math.round((finders * 0.95 * perFinder * 2.4) / 6);
    m.fable += Math.min(6, Math.max(1, Math.ceil(finders / 8))); // wardens
    out[`health-${g.name}`] = m;
  }
  if (parts.includes('fidelity') && ghosts) {
    const m = t();
    const claims = ghosts * 7;
    m.opus += Math.ceil(ghosts / 5) * 2; // charter + verifier
    m.opus += Math.round((claims * 0.25 * 2) / 6); // two search votes on each negative verdict
    m.opus += Math.round((exorcised * (depth === 'survey' ? 0.5 : 1)) / 2); // one skeptic per exorcised ghost, two per call
    if (depth === 'standard') for (const u of units.filter((x) => x.kind === 'rite')) {
      const matched = P.filter((p) => p.kinds.some((k) => (u.kinds || []).includes(k))).sort((a, b) => Number(b.reasoning) - Number(a.reasoning)).slice(0, 3);
      for (const p of matched) m[p.reasoning ? 'fable' : 'opus'] += 1;
    }
    m.fable += units.length; // unit wardens
    out.fidelity = m;
  }
  if (parts.includes('imprints')) out.imprints = { fable: 0, opus: (posture === 'seance' && !named ? Math.ceil(orgImprints / 10) : 0) + Math.ceil(imprints / 6) + Math.ceil((imprints * 0.4 * 1.5) / 6), sonnet: 0 };
  if (!imprintsOnly(parts)) out.verdict = { fable: 3, opus: 8, sonnet: 0 };
  const total = t();
  for (const v of Object.values(out)) for (const k of Object.keys(total)) total[k] += v[k];
  const all = total.fable + total.opus + total.sonnet;
  return { per_part: out, total, agents: all, fable_share: Math.round((100 * total.fable) / Math.max(1, all)) };
}

// ── footprint + adjacency: what a named scope's work actually touched ─────────────────────────
// Adjacency is ONE hop on the import graph: what the touched code imports, what imports it (capped;
// a hub imported by everything is skipped — it is context for all, subject of none), and its tests.
// `from X import a, b` (one line) or `from X import (\n a,\n b\n)` — never across into the next statement.
const PY_RE = /^\s*(?:from\s+([.\w]+)\s+import\s+(\([\w\s,]+|[\w \t,]+)|import\s+([\w.]+))/gm;
const JS_RE = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;
const JS_EXT = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];
export function importGraph(tree, tracked) {
  const set = new Set(tracked);
  // A Python module's root is the parent of its top-most package (the first ancestor without an __init__.py).
  const pyMods = new Map();
  for (const f of tracked.filter((x) => x.endsWith('.py'))) {
    const parts = f.slice(0, -3).split('/');
    let root = parts.length - 1;
    while (root > 0 && set.has(`${parts.slice(0, root).join('/')}/__init__.py`)) root -= 1;
    const mod = parts.slice(root).filter((x) => x !== '__init__').join('.');
    if (mod) pyMods.set(mod, f);
  }
  const out = new Map();
  const add = (a, b) => { if (b && b !== a && set.has(b)) { if (!out.has(a)) out.set(a, new Set()); out.get(a).add(b); } };
  for (const f of tracked) {
    const isPy = f.endsWith('.py');
    const isJs = /\.(jsx?|tsx?|mjs|cjs)$/.test(f);
    if (!isPy && !isJs) continue;
    let text = '';
    try { text = readFileSync(join(tree, f), 'utf8'); } catch { continue; }
    if (text.length > 800000) continue;
    if (isPy) {
      for (const m of text.matchAll(PY_RE)) {
        const name = m[1] || m[3];
        if (!name || name.startsWith('.')) continue;
        // `from app.core import db` imports the SUBMODULE app.core.db when one exists.
        const subs = m[1] ? String(m[2] || '').replace(/[()]/g, '').split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).map((x) => `${name}.${x}`).filter((x) => pyMods.has(x)) : [];
        if (subs.length) { subs.forEach((x) => add(f, pyMods.get(x))); continue; }
        for (let n = name; n; n = n.includes('.') ? n.slice(0, n.lastIndexOf('.')) : '') { if (pyMods.has(n)) { add(f, pyMods.get(n)); break; } }
      }
    } else {
      for (const m of text.matchAll(JS_RE)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        const base = join(dirname(f), spec).replace(/\\/g, '/');
        const hit = JS_EXT.map((e) => base + e).find((c) => set.has(c));
        if (hit) add(f, hit);
      }
    }
  }
  const importers = new Map();
  for (const [a, bs] of out) for (const b of bs) { if (!importers.has(b)) importers.set(b, new Set()); importers.get(b).add(a); }
  return { imports: out, importers };
}
const GENERIC_STEM = /^(index|main|init|__init__|app|mod|types|utils|helpers|constants|config|test|tests|base|models|schemas|api|service|services|client|conftest|settings)$/;
export function adjacencyOf(touched, graph, tracked, { importerCap = 15, hubAt = 25, importCap = 8 } = {}) {
  const T = new Set(touched);
  const adj = new Set();
  const isTest = (f) => /(^|\/)(tests?|__tests__)\/|\.test\.|\.spec\.|(^|\/)test_[^/]+\.py$/.test(f);
  for (const f of T) {
    // A test's imports are the code under test — not this scope's subject; a god file's imports are
    // everything. So: no outgoing expansion from tests, and at most importCap imports per file.
    if (!isTest(f)) [...(graph.imports.get(f) || [])].slice(0, importCap).forEach((d) => adj.add(d));
    const imps = [...(graph.importers.get(f) || [])];
    const tests = imps.filter(isTest);
    tests.forEach((t) => adj.add(t));
    if (imps.length <= hubAt) imps.filter((x) => !isTest(x)).slice(0, importerCap).forEach((x) => adj.add(x));
    // tests named after the file (test_foo.py, Foo.test.jsx) even when they reach it indirectly
    const stem = f.split('/').pop().replace(/\.[^.]+$/, '');
    if (stem.length > 3 && !GENERIC_STEM.test(stem.toLowerCase())) for (const t of tracked) if (isTest(t) && (t.includes(`test_${stem}.`) || t.includes(`${stem}.test.`))) adj.add(t);
  }
  for (const f of T) adj.delete(f);
  return [...adj].sort();
}

// ── init ─────────────────────────────────────────────────────────────────────────────────────
async function init(values) {
  const run = runOf(values);
  if (!values.tree) fail('--tree is required');
  const tree = resolve(values.tree);
  if (!existsSync(join(tree, '.git'))) fail(`pinned tree not found at ${tree}`);
  const local = !!values.local;
  const api = reckoningClient({ cwd: values.cwd || process.cwd(), local });
  const { p, must, errors } = api;
  const cfg = p.config || {};
  const rcfg = cfg.reckoning || {};
  const posture = cfg.seance?.scope === 'coven' ? 'coven' : 'seance';
  const scopeKind = String(values.scope || 'whole');
  if (!['whole', 'coven', 'seance', 'haunting', 'rite', 'repo'].includes(scopeKind)) fail(`unknown scope ${scopeKind}`);
  const warnings = [];
  let parts = initParts(values, scopeKind, warnings);
  if (!parts.length) fail(`--parts ${values.parts || ''}${values['no-imprints'] ? ' with --no-imprints' : ''} leaves no Part to run — name one of fidelity, health, imprints`);
  const snap = join(run, 'snapshot');
  mkdirSync(join(snap, 'fidelity'), { recursive: true });
  mkdirSync(join(run, 'instruments'), { recursive: true });
  // The bus lives inside the pinned tree (a Codex child can only write under its --repo root), so
  // its directory ignores itself; the tripwire baseline below is taken after this and after the
  // skill linked the dependency dirs, so neither ever reads as a leaf's edit.
  mkdirSync(join(tree, '.reckoning'), { recursive: true });
  writeFileSync(join(tree, '.reckoning', '.gitignore'), '*\n');

  const paged = async (path) => {
    const items = [];
    for (let offset = 0; ; offset += 200) {
      const r = await must(`${path}${path.includes('?') ? '&' : '?'}limit=200&offset=${offset}`, null);
      if (r == null) return items;
      const page = Array.isArray(r) ? r : r.items || [];
      items.push(...page);
      if (Array.isArray(r) || !r.has_more || !page.length) return items;
    }
  };
  const filterGhosts = async (conditions) => {
    const items = [];
    for (let offset = 0; ; offset += 200) {
      const r = await api.req('POST', '/api/agent/ghosts/filter', { groups: [{ conditions }], limit: 200, offset });
      if (!r || !r.ok) { errors.push(`POST /ghosts/filter → HTTP ${r ? r.status : '?'}`); return items; }
      items.push(...(r.body?.items || []));
      if (!r.body?.has_more || !(r.body?.items || []).length) return items;
    }
  };
  const matchOne = (list, target, label) => {
    const t = String(target || '').trim();
    if (!t) return { error: `${label} needs an id or a name` };
    const byId = list.filter((x) => x.id === t || x.id.startsWith(t.toLowerCase()));
    if (byId.length === 1) return { hit: byId[0] };
    const exact = list.filter((x) => String(x.name).toLowerCase() === t.toLowerCase());
    if (exact.length === 1) return { hit: exact[0] };
    const sub = list.filter((x) => String(x.name).toLowerCase().includes(t.toLowerCase()));
    if (sub.length === 1) return { hit: sub[0] };
    return { error: `${label} "${t}" matched ${exact.length || sub.length || 0} candidates — name it by id`, candidates: (exact.length ? exact : sub).slice(0, 20).map((x) => ({ id: x.id, name: x.name })) };
  };

  const me = await must('/api/agent/me', null);
  const orgId = me?.org_id || me?.organization_id || me?.agent?.org_id;
  if (!orgId) fail('could not read the Medium\'s org_id from /api/agent/me', 7, { errors });
  writeJSON(join(snap, 'me.json'), { id: me.id, name: me.name, org_id: orgId });

  const hauntingsAll = await paged('/api/agent/hauntings');
  let wholeSeance = null;
  let wholeHauntings = hauntingsAll;
  if (posture === 'seance') {
    const seances = await paged('/api/agent/seances');
    if (cfg.seance?.id) wholeSeance = seances.find((s) => s.id === cfg.seance.id) || null;
    else if (cfg.seance?.selector) {
      const re = new RegExp(cfg.seance.selector, 'i');
      const hits = seances.filter((s) => re.test(s.name));
      if (hits.length === 1) wholeSeance = hits[0];
      else fail(`seance.selector matched ${hits.length} séances — pin seance.id in .ghost/config.json`, 5, { candidates: hits.map((s) => ({ id: s.id, name: s.name })) });
    }
    if (!wholeSeance) fail('this repo is in séance posture but no séance resolved — set seance.id in .ghost/config.json', 5);
    wholeHauntings = hauntingsAll.filter((h) => h.portfolio_id === wholeSeance.id);
  }

  let scope = { kind: scopeKind, id: '', name: '' };
  let scopeHauntings = [];
  let scopeGhosts = [];
  let rite = null;
  if (scopeKind === 'whole') {
    scope = posture === 'seance' ? { kind: 'seance', id: wholeSeance.id, name: wholeSeance.name } : { kind: 'coven', id: orgId, name: 'the whole Coven' };
    scopeHauntings = wholeHauntings;
  } else if (scopeKind === 'coven') {
    scope = { kind: 'coven', id: orgId, name: 'the whole Coven' };
    scopeHauntings = hauntingsAll;
    if (posture === 'seance') warnings.push(`this repo is in séance posture: ${hauntingsAll.length - wholeHauntings.length} of the Coven's Haunting(s) are other repos' work — their ghosts and project Imprints are excluded and counted, never judged against this code, so \`coven\` here reviews what \`/reckoning\` does`);
  } else if (scopeKind === 'seance') {
    const m = matchOne(await paged('/api/agent/seances'), values.target, 'séance');
    if (m.error) fail(m.error, 5, { candidates: m.candidates });
    scope = { kind: 'seance', id: m.hit.id, name: m.hit.name };
    scopeHauntings = hauntingsAll.filter((h) => h.portfolio_id === m.hit.id);
  } else if (scopeKind === 'haunting') {
    const m = matchOne(wholeHauntings, values.target, 'haunting');
    const m2 = m.error ? matchOne(hauntingsAll, values.target, 'haunting') : m;
    if (m2.error) fail(m2.error, 5, { candidates: m2.candidates });
    scope = { kind: 'haunting', id: m2.hit.id, name: m2.hit.name };
    scopeHauntings = [m2.hit];
  } else if (scopeKind === 'rite') {
    const m = matchOne(await paged(`/api/agent/covens/${orgId}/rites`), values.target, 'rite');
    if (m.error) fail(m.error, 5, { candidates: m.candidates });
    rite = m.hit;
    scope = { kind: 'rite', id: rite.id, name: rite.name };
    scopeGhosts = await paged(`/api/agent/rites/${rite.id}/ghosts`);
    const hs = new Set(scopeGhosts.map((g) => g.project_id));
    scopeHauntings = hauntingsAll.filter((h) => hs.has(h.id));
  } else {
    scope = { kind: 'repo', id: '', name: 'the codebase (no platform scope)' };
    scopeHauntings = wholeHauntings;
  }
  if (['whole', 'coven', 'seance', 'haunting'].includes(scopeKind) && scopeHauntings.length) {
    scopeGhosts = await filterGhosts([{ field: 'project', operator: 'is', values: scopeHauntings.map((h) => h.id) }]);
  }

  // Backlog = every ghost of the repo's whole scope, with its Wisps (the filter endpoint returns
  // top-level ghosts only and does not count their Wisps, so every ghost is asked), for dedupe.
  const backlogTop = wholeHauntings.length ? await filterGhosts([{ field: 'project', operator: 'is', values: wholeHauntings.map((h) => h.id) }]) : [];
  const wispOf = new Map();
  const allTop = [...new Map([...backlogTop, ...scopeGhosts].map((g) => [g.id, g])).values()];
  await pmap(allTop, 8, async (g) => { wispOf.set(g.id, (await must(`/api/agent/ghosts/${g.id}/wisps`, { subtasks: [] }))?.subtasks || []); });
  const compact = (g) => ({ id: g.id, title: g.title, status: g.status, priority: g.priority, project_id: g.project_id, project_name: g.project_name, milestone_id: g.milestone_id, parent_task_id: g.parent_task_id || null, description: trim(g.description || '', 600), objective: trim(g.context_payload?.objective || '', 400), acceptance_criteria: (g.context_payload?.acceptance_criteria || []).slice(0, 12).map((x) => trim(String(x), 240)), labels: (g.labels || []).map((l) => l.name || l) });
  const backlog = backlogTop.map((g) => ({ ...compact(g), wisps: (wispOf.get(g.id) || []).map((w) => ({ id: w.id, title: w.title, status: w.status })) }));
  writeJSON(join(snap, 'backlog.json'), { note: 'Every ghost of this repo\'s whole scope (all statuses), with Wisps — the dedupe corpus. Descriptions are trimmed.', count: backlog.length, ghosts: backlog });

  // Units: the Hauntings in scope and the Rites their ghosts sit in (minus each Haunting's default
  // milestone, which is the Haunting again under another name).
  const defaults = new Set(scopeHauntings.map((h) => h.default_milestone_id).filter(Boolean));
  const riteIds = rite ? [rite.id] : [...new Set(scopeGhosts.map((g) => g.milestone_id).filter((m) => m && !defaults.has(m)))];
  const rites = (await pmap(riteIds, 6, (id) => must(`/api/agent/rites/${id}`, null))).filter((r) => r && r.status !== 'unraveled');
  const units = scopeKind === 'repo' ? [] : [
    ...(scopeKind === 'rite' ? [] : scopeHauntings.map((h) => ({ key: `haunting:${id8(h.id)}`, kind: 'haunting', id: h.id, name: h.name, description: h.description || '' }))),
    ...rites.map((r) => ({ key: `rite:${id8(r.id)}`, kind: 'rite', id: r.id, name: r.name, description: r.description || '', status: r.status })),
  ];
  const unitOf = (g) => units.filter((u) => (u.kind === 'haunting' && u.id === g.project_id) || (u.kind === 'rite' && u.id === g.milestone_id)).map((u) => u.key);

  // Full records for the ghosts under review: EVPs, Wisps, Apparitions, and the git footprint.
  const trackedAll = git(tree, 'ls-files').split('\n').filter(Boolean);
  const trackedSet = new Set(trackedAll);
  let originRepo = '';
  try { originRepo = git(tree, 'remote', 'get-url', 'origin').replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/').toLowerCase(); } catch {}
  const idx = scopeGhosts.length ? execFileSync('git', ['-C', tree, 'log', '--format=%H%x1f%cI%x1f%s%x1f%b%x1e'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => { const [sha, at, subject, body] = r.split('\x1f'); return { sha, at: Date.parse(at), subject, body: body || '' }; }) : [];
  const filesOf = (sha) => execFileSync('git', ['-C', tree, 'show', '--name-only', '--format=', sha], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const detail = await pmap(scopeGhosts, 8, async (g) => {
    const [evps, prs] = await Promise.all([must(`/api/agent/ghosts/${g.id}/evps`, []), must(`/api/agent/ghosts/${g.id}/apparitions`, [])]);
    const prFiles = new Set();
    const commits = [];
    const ownPrs = (prs || []).filter((pr) => !(originRepo && pr.repo_full_name && String(pr.repo_full_name).toLowerCase() !== originRepo));
    // PR numbers the ghost's own text mentions count too — older ghosts cite "#159" in an EVP with no
    // Apparition linked (pilot B's Rite did exactly that).
    const prose = [g.description || '', JSON.stringify(g.context_payload || {}), ...(evps || []).map((e) => e.content || '')].join('\n');
    // A PR number in prose only counts when this repo's squash commit for it landed inside the ghost's
    // lifetime — another repo's "#12", or a digit-only hex colour, must not pull in unrelated files.
    const born = Date.parse(g.created_at || '') - 86400000;
    const doneBy = Date.parse(g.completed_at || '') + 14 * 86400000 || Date.now();
    const inLife = (x) => !Number.isFinite(born) || (x.at >= born && x.at <= doneBy);
    const mentioned = [...new Set([...prose.matchAll(/(?:\bPR\s*#?|\/pull\/|\(#|(?<![\w&])#)(\d{2,6})\b/g)].map((m) => Number(m[1])))];
    const linked = new Set(ownPrs.map((pr) => pr.pr_number));
    for (const n of [...new Set([...linked, ...mentioned])]) {
      const hit = idx.find((x) => x.subject.includes(`(#${n})`) && (linked.has(n) || inLife(x)));
      if (hit && !commits.some((k) => hit.sha.startsWith(k.sha))) { commits.push({ sha: hit.sha.slice(0, 12), subject: hit.subject }); filesOf(hit.sha).filter((f) => trackedSet.has(f)).forEach((f) => prFiles.add(f)); }
    }
    for (const m of prose.matchAll(/([\w.-]+\/)+[\w.-]+\.(?:json|jsx|js|tsx|ts|mjs|py|md|sh|css)\b/g)) if (trackedSet.has(m[0])) prFiles.add(m[0]);
    for (const x of idx.filter((y) => y.body.includes(g.id))) {
      if (!commits.some((k) => x.sha.startsWith(k.sha))) { commits.push({ sha: x.sha.slice(0, 12), subject: x.subject }); filesOf(x.sha).filter((f) => trackedSet.has(f)).forEach((f) => prFiles.add(f)); }
    }
    const foreignOnly = (prs || []).length > 0 && !ownPrs.length && !!originRepo;
    return {
      foreign_only: foreignOnly,
      id: g.id, title: g.title, status: g.status, priority: g.priority, project_id: g.project_id, project_name: g.project_name, milestone_id: g.milestone_id, milestone_name: g.milestone_name,
      created_at: g.created_at, completed_at: g.completed_at, description: g.description || '', context_payload: g.context_payload || {}, labels: (g.labels || []).map((l) => l.name || l),
      wisps: (wispOf.get(g.id) || []).map((w) => ({ id: w.id, title: w.title, status: w.status })),
      evps: (evps || []).slice(-15).map((e) => ({ author: e.author_name || e.author_type, at: e.created_at, content: trim(e.content || '', 3000) })),
      apparitions: (prs || []).map((pr) => ({ pr_number: pr.pr_number, pr_url: pr.pr_url, title: pr.title, status: pr.status, merged_at: pr.merged_at, repo: pr.repo_full_name })),
      footprint: { declared_files: (Array.isArray(g.context_payload?.files) ? g.context_payload.files : []).map(String), changed_files: [...prFiles].sort().slice(0, 400), commits: commits.slice(0, 20) },
      units: unitOf(g),
    };
  });
  const obsoleteLabel = String(rcfg.obsolete_sigil || 'obsolete');
  const ownHauntings = new Set(wholeHauntings.map((h) => h.id));
  const foreignGhost = (g) => g.foreign_only || (posture === 'seance' && !ownHauntings.has(g.project_id));
  const inJurisdiction = detail.filter((g) => !g.labels.includes(obsoleteLabel) && !foreignGhost(g));
  const outOfJurisdiction = detail.filter(foreignGhost).length;
  // --history: which ghosts get their claims checked. Open ghosts always; exorcised ones by window.
  const hist = String(values.history || 'all');
  const days = /^\d+d$/.test(hist) ? Number(hist.slice(0, -1)) : null;
  const cutoff = days ? Date.now() - days * 86400000 : null;
  const inWindow = (g, h) => OPEN.includes(g.status) || (h === 'all') || (h !== 'open' && g.completed_at && Date.parse(g.completed_at) >= h);
  const reviewed = inJurisdiction.filter((g) => inWindow(g, hist === 'open' ? 'open' : cutoff ?? 'all'));
  // A Rite / Haunting with no reviewed ghost has nothing to judge: no unit warden, no intent to
  // confirm, no walkthrough (another repo's Hauntings under \`coven\`, or all-closed ones under --history open).
  const unitsBefore = units.length;
  const allUnits = [...units];
  units.splice(0, units.length, ...units.filter((u) => reviewed.some((g) => g.units.includes(u.key))));
  const unitsDropped = unitsBefore - units.length;
  const windows = {
    all: inJurisdiction.length,
    '90d': inJurisdiction.filter((g) => inWindow(g, Date.now() - 90 * 86400000)).length,
    open: inJurisdiction.filter((g) => OPEN.includes(g.status)).length,
  };
  writeJSON(join(snap, 'scope.json'), { kind: scope.kind, org_id: orgId, scope, posture, units, ghosts: reviewed.map((g) => ({ id: g.id, title: g.title, status: g.status, project_id: g.project_id, milestone_id: g.milestone_id, units: g.units, apparitions: g.apparitions })), rites, hauntings: scopeHauntings.map((h) => ({ id: h.id, name: h.name, description: h.description, default_milestone_id: h.default_milestone_id, total_tasks: h.total_tasks, completed_tasks: h.completed_tasks })) });

  // Fidelity batches: per Haunting, 5 ghosts each, full records; numbered globally so keys and
  // seal names stay unique across slices.
  const byProject = new Map();
  for (const g of reviewed) { if (!byProject.has(g.project_id)) byProject.set(g.project_id, []); byProject.get(g.project_id).push(g); }
  const batches = [];
  for (const [pid, gs] of [...byProject.entries()].sort()) {
    gs.sort((a, b) => a.status.localeCompare(b.status) || a.title.localeCompare(b.title));
    for (let i = 0; i < gs.length; i += 5) {
      const n = batches.length + 1;
      const file = join(snap, 'fidelity', `batch-${String(n).padStart(3, '0')}.json`);
      writeJSON(file, { batch: n, haunting: pid, ghosts: gs.slice(i, i + 5) });
      batches.push({ n, file, project_id: pid, ghosts: gs.slice(i, i + 5).map((g) => ({ id: g.id, status: g.status, title: g.title, units: g.units })) });
    }
  }
  for (const u of units) writeJSON(join(snap, 'fidelity', `unit-${slug(u.key)}.json`), { ...u, ghosts: reviewed.filter((g) => g.units.includes(u.key)).map((g) => ({ id: g.id, title: g.title, status: g.status, batch: batches.find((b) => b.ghosts.some((x) => x.id === g.id))?.file })) });

  // ── footprint (named scopes) — what the scope's ghosts touched, and one hop around it ──
  const NAMED = ['seance', 'haunting', 'rite'].includes(scopeKind);
  // --history narrows WHICH GHOSTS GET CLAIM-CHECKED, never the code or Imprints in scope: those come
  // from every in-jurisdiction ghost of the scope.
  const touchedSet = new Set(inJurisdiction.flatMap((g) => [...g.footprint.declared_files.filter((f) => trackedSet.has(f)), ...g.footprint.changed_files]));
  const graph = NAMED ? importGraph(tree, trackedAll) : null;
  const footprint = NAMED ? { touched: [...touchedSet].sort(), adjacent: adjacencyOf([...touchedSet], graph, trackedAll) } : null;
  const withFootprint = inJurisdiction.filter((g) => g.footprint.changed_files.length || g.footprint.declared_files.some((f) => trackedSet.has(f))).length;

  // ── Imprints: a wide run touches the whole repo, so ALL of its Imprints; a named scope, the ones
  // related to it in any way (its Hauntings' project Imprints — for a Rite only the related ones —
  // plus anything linked to or sourced from its ghosts, and anything naming its files).
  const imprintHauntings = posture === 'coven' && ['whole', 'coven', 'repo'].includes(scopeKind) ? hauntingsAll : scopeKind === 'repo' ? wholeHauntings : scopeHauntings;
  const org = await paged('/api/agent/imprints?status=vivid&scope=org');
  // In séance posture a project Imprint belongs to this repo only if its Haunting is one of the repo's
  // own; another repo's is never judged against this code (it is counted, and left alone).
  const ours = (m) => m.scope === 'org' || (m.scope === 'project' && (posture === 'coven' || ownHauntings.has(m.project_id)));
  const projAll = (await pmap(imprintHauntings, 6, (h) => paged(`/api/agent/imprints?status=vivid&scope=project&project_id=${h.id}`))).flat();
  const proj = projAll.filter(ours);
  const foreignImprints = projAll.length - proj.length;
  let pool = [...org, ...proj];
  const related = { base: 0, linked: 0, mentions: 0 };
  if (NAMED) {
    const scopeGhostIds = new Set(inJurisdiction.map((g) => g.id));
    // Match on a FILENAME (with its extension) or a full path — a bare stem like "search" or "task"
    // appears in most Imprints and would pull the whole org set in.
    const names = [...new Set([...touchedSet].flatMap((f) => [f, f.split('/').pop()]).filter((x) => x.length >= 6 && !GENERIC_STEM.test(x.replace(/\.[^.]+$/, '').toLowerCase())))];
    const mentions = (m) => names.some((x) => `${m.title}\n${m.content}`.includes(x));
    const linkedTo = (m) => (m.links || []).some((l) => scopeGhostIds.has(l.id)) || scopeGhostIds.has(m.source_task_id);
    const keep = new Map();
    for (const m of proj) if (scopeKind !== 'rite' || linkedTo(m) || mentions(m)) { keep.set(m.id, m); related.base += 1; }
    for (const m of org) if (linkedTo(m) || mentions(m)) { if (!keep.has(m.id)) related.mentions += 1; keep.set(m.id, m); }
    const linked = (await pmap(inJurisdiction, 6, (g) => paged(`/api/agent/imprints?status=vivid&task_id=${g.id}`))).flat();
    for (const m of linked) if (ours(m) && !keep.has(m.id)) { keep.set(m.id, m); related.linked += 1; }
    // No recall here: POST /imprints/recall bumps recall_count and last_recalled_at in prod, and a
    // snapshot must not write anything before the Hunter has approved a thing.
    pool = [...keep.values()];
  }
  const imprints = pool.map((m) => ({ id: m.id, title: m.title, content: m.content, memory_type: m.memory_type, scope: m.scope, project_id: m.project_id || '', project_name: m.project_name || '', agent_id: m.agent_id || '', tags: m.tags || [], links: m.links || [], creator: `${m.creator_type}/${m.creator_name || m.creator_id}`, self: m.creator_type === 'medium' && m.creator_id === me.id, promoted: !!m.promoted_document_id, source_task_id: m.source_task_id || null, recall_count: m.recall_count, last_recalled_at: m.last_recalled_at, created_at: m.created_at, updated_at: m.updated_at, supersedes_id: m.supersedes_id || null }));
  writeJSON(join(snap, 'imprints.json'), { note: NAMED ? 'Vivid Imprints RELATED to this scope (its Hauntings, linked to its ghosts, or naming its files).' : 'All vivid Imprints of this repo (org + its Hauntings).', count: imprints.length, related: NAMED ? related : null, imprints });

  const auguries = await paged('/api/agent/auguries');
  writeJSON(join(snap, 'auguries.json'), { note: 'Auguries (decisions). Answered ones are SETTLED — a finding that re-argues one is not a finding.', auguries: auguries.map((q) => ({ id: q.id, title: q.title, status: q.status, context: trim(q.context || '', 1500), answer: trim(q.answer || '', 1500), chosen_option: q.chosen_option, task_id: q.task_id })) });

  // The previous reckoning of the same scope (its Scroll, never its appendix), for the re-check.
  // The label keys the previous-reckoning lookup and the Scroll title, so a whole-repo run and a
  // named-séance run of the same séance never pass for each other.
  const label = `Reckoning — ${['seance', 'haunting', 'rite'].includes(scopeKind) ? `${scopeKind} ${scope.name}` : scopeKind === 'repo' ? 'the codebase' : `${scope.name} (whole)`}`;
  const prevScrolls = (await paged(`/api/agent/covens/${orgId}/scrolls?search=${encodeURIComponent('Reckoning')}`)).filter((s) => String(s.title || '').startsWith(`${label} — `) && !/— appendix$/.test(String(s.title)) && !String(s.title).startsWith(`${label} — Imprints — `));
  prevScrolls.sort((a, b) => String(b.created_at || b.updated_at).localeCompare(String(a.created_at || a.updated_at)));
  let previousScroll = null;
  if (prevScrolls[0]) {
    const doc = await must(`/api/agent/scrolls/${prevScrolls[0].id}`, null);
    if (doc?.content) { previousScroll = join(snap, 'previous-scroll.md'); writeFileSync(previousScroll, doc.content); }
  }
  // A snapshot with holes is not a snapshot: every failed call (after retries) stops init here.
  if (errors.length) fail(`${errors.length} API call(s) failed after retries — the snapshot would silently miss data`, 7, { errors: errors.slice(0, 40) });
  const runsDir = dirname(run);
  const previousInstruments = existsSync(runsDir)
    ? readdirSync(runsDir).filter((d) => join(runsDir, d) !== run && existsSync(join(runsDir, d, 'out', 'instruments')) && readJSON(join(runsDir, d, 'state.json'), {}).scope_label === label).sort().pop()
    : null;

  // Shards (every tracked code file in exactly one), personas, tenets.
  const shardCfg = (rcfg.shards || readJSON(join(run, 'shards.json'), [])).filter((s) => s && s.name && KINDS.includes(s.kind)).map((s) => ({ name: slug(s.name), kind: s.kind, paths: s.paths || [], group: slug(s.group || 'all') }));
  const groupsCfg = Object.fromEntries(Object.entries(rcfg.shard_groups || {}).map(([k, v]) => [slug(k), v]));
  const groups0 = [...new Set(shardCfg.map((s) => s.group))].map((g) => ({ name: g, cross_cutting: !!groupsCfg[g]?.cross_cutting }));
  const assigned = shardCfg.length ? assignShards(tree, shardCfg, groups0) : { shards: [], empty: [], uncovered: 0, auto: [] };
  const kindOf = new Map(assigned.shards.flatMap((x) => x.files.map((f) => [f, x.kind])));
  if (NAMED) {
    // A named scope reviews ONLY what its ghosts touched: each shard keeps its touched files, plus the
    // one-hop neighbours of those files as context; a shard with nothing touched drops out.
    assigned.shards = assigned.shards
      .map((x) => { const touched = x.files.filter((f) => touchedSet.has(f)); return { ...x, touched, adjacent: touched.length ? adjacencyOf(touched, graph, trackedAll) : [], full_files: x.files.length }; })
      .filter((x) => x.touched.length)
      .map((x) => ({ ...x, files: [...x.touched, ...x.adjacent], group: 'scope' }));
    // A named scope's footprint is small: ONE health run (one set of wardens, one seal), not three.
  }
  const groups = [...new Set(assigned.shards.map((s) => s.group))].map((g) => ({ name: g, cross_cutting: !NAMED && !!groupsCfg[g]?.cross_cutting }));
  if (groups.length && !groups.some((g) => g.cross_cutting)) {
    // Wide run: the configured group (or the last). Named scope: the group holding most of the touched code.
    const target = NAMED ? groups.map((g) => ({ g, n: assigned.shards.filter((x) => x.group === g.name).reduce((a, x) => a + x.touched.length, 0) })).sort((a, b) => b.n - a.n)[0].g : groups[groups.length - 1];
    target.cross_cutting = true;
  }
  // A Rite's footprint kinds decide which personas walk it.
  for (const u of allUnits) u.kinds = [...new Set(inJurisdiction.filter((g) => g.units.includes(u.key)).flatMap((g) => g.footprint.changed_files.concat(g.footprint.declared_files)).map((f) => kindOf.get(f)).filter(Boolean))];
  const personaMap = { ...DEFAULT_PERSONA_KINDS, ...(rcfg.personas || {}), ...readJSON(join(run, 'personas.json'), {}) };
  const lenses = cfg.panel?.lenses || ['staff-engineer', 'product-manager', 'senior-ux'];
  const personaFile = (k) => [join(tree, '.claude/agents', `${k}.md`), join(p.root, '.claude/agents', `${k}.md`), join(pluginRoot, 'agents', `${k}.md`)].find(existsSync) || '';
  // A persona whose definition ships with the plugin is a REASONING lens (the panel runs those on
  // Fable); a repo's own personas are reality-check lenses.
  const personas = lenses.map((k) => { const file = personaFile(k); return { key: k, file, reasoning: !!file && file.startsWith(join(pluginRoot, 'agents')), kinds: (personaMap[k] || []).filter((x) => KINDS.includes(x)) }; });
  const unmapped = personas.filter((x) => !x.kinds.length || !x.file).map((x) => ({ key: x.key, file: x.file || '(no definition file found)', why: !x.file ? 'no definition file' : 'no kinds mapped' }));
  // A repo with no tenets file runs on Layers A and B only; the plugin default is the format spec.
  const tenetsPath = [join(tree, '.ghost/tenets.md'), join(p.root, '.ghost/tenets.md')].find(existsSync) || join(pluginRoot, 'skills/reckoning/references/tenets.md');
  const tenetsText = readFileSync(tenetsPath, 'utf8');
  const tenetIds = [...tenetsText.matchAll(/^## (T-[a-z0-9-]+)/gm)].map((m) => m[1]);
  const tenetsCheck = tenetIds.length ? tenetsLint(tenetsText, tree) : null;
  if (tenetsCheck && tenetsCheck.bytes > TENETS_WARN_BYTES) warnings.push(`the tenets file is ${(tenetsCheck.bytes / 1024).toFixed(1)} KB (${tenetIds.length} tenets): every finder and refuter reads all of it and nothing truncates it — past ${TENETS_WARN_BYTES / 1024} KB, tighten the tenets (references/tenets.md "Size")`);
  if (tenetsCheck && tenetsCheck.problems.length) {
    const shown = tenetsCheck.problems.slice(0, 8).map((x) => `${x.tenet} \`${x.pointer}\` is ${x.problem}`);
    warnings.push(`${tenetsCheck.problems.length} of the tenets file's ${tenetsCheck.pointers} \`path:line\` pointer(s) no longer land in the pinned tree: ${shown.join('; ')}${tenetsCheck.problems.length > shown.length ? `; … +${tenetsCheck.problems.length - shown.length}` : ''}. Refuters read these lines to settle Deliberate exceptions — fix them before launch (a quoted anchor phrase after a pointer lets prep track it)`);
  }
  // The largest tenant the repo designs for. Health finders and refuters judge growth and statement
  // cost at this size; without it the only numbers they have are fixture-sized.
  const referenceScale = typeof rcfg.reference_scale === 'string' ? rcfg.reference_scale.trim().slice(0, 600) : '';

  if (parts.includes('fidelity') && !batches.length) { parts = parts.filter((x) => x !== 'fidelity'); warnings.push('the scope has no reviewable ghosts — fidelity is skipped'); }
  if (NAMED && !touchedSet.size && parts.includes('health')) { parts = parts.filter((x) => x !== 'health'); warnings.push("no code footprint — none of this scope's ghosts links a PR, names a file, or is named in a commit; the code review is skipped (the claims check still searches the whole repo)"); }
  else if (!assigned.shards.length && parts.includes('health')) warnings.push('no shards — health cannot run until shards are proposed (reckoning.shards or <run>/shards.json)');
  if (parts.includes('health') && !referenceScale) warnings.push('no reckoning.reference_scale in .ghost/config.json — the code review has no stated size to judge growth and per-statement cost at, so P-scale\'s "beyond the stated scale" exemption cannot be claimed for tables that grow with activity. Set it to the largest tenant this repo designs for (e.g. "one org with ~2M orders")');
  // Estimate (rough, and said to be rough): agents per tier and Part, wall-clock per host, and — for a
  // big scope — what each history window would cost, so the launch question can show it.
  const pk = personas.filter((x) => x.kinds.length && x.file);
  const depth = values.depth === 'survey' ? 'survey' : 'standard';
  const exo = reviewed.filter((g) => g.status === 'exorcised').length;
  const splitFor = (ghostN, exoN, partsX) => modelSplit({ shards: assigned.shards, groups, personas, depth, parts: partsX, ghosts: ghostN, exorcised: exoN, units, imprints: imprints.length, orgImprints: org.length, posture, named: NAMED });
  const models = splitFor(reviewed.length, exo, parts);
  const fidelityAgents = models.per_part.fidelity ? models.per_part.fidelity.fable + models.per_part.fidelity.opus + models.per_part.fidelity.sonnet : 0;
  const health = Object.entries(models.per_part).filter(([k]) => k.startsWith('health-')).map(([k, v]) => ({ key: k, agents: v.fable + v.opus + v.sonnet }));
  const imprintsAgents = models.per_part.imprints ? models.per_part.imprints.opus + models.per_part.imprints.sonnet : 0;
  const slices = Math.max(1, Math.ceil(fidelityAgents / 250));
  const total = models.agents;
  const TARGET = Number(rcfg.target_agents) > 0 ? Number(rcfg.target_agents) : 700;
  // Each window is costed from ITS ghosts: their real exorcised count and only the units they belong to.
  const fidOf = (gs) => {
    const us = allUnits.filter((u) => gs.some((g) => g.units.includes(u.key)));
    const m = modelSplit({ shards: assigned.shards, groups, personas, depth, parts: ['fidelity'], ghosts: gs.length, exorcised: gs.filter((g) => g.status === 'exorcised').length, units: us, imprints: imprints.length, orgImprints: org.length, posture, named: NAMED });
    const f = m.per_part.fidelity; return f ? f.fable + f.opus + f.sonnet : 0;
  };
  const winGhosts = { all: inJurisdiction, '90d': inJurisdiction.filter((g) => inWindow(g, Date.now() - 90 * 86400000)), open: inJurisdiction.filter((g) => OPEN.includes(g.status)) };
  const windowCosts = Object.fromEntries(Object.entries(winGhosts).map(([k, gs]) => [k, { ghosts: gs.length, fidelity_agents: fidOf(gs) }]));
  const claudeConc = Math.max(1, Math.min(16, cpus().length - 2));
  const codexConc = cfg.hosts?.codex?.concurrency || 4;
  const hours = (conc) => Math.round((total * 4) / conc / 6) / 10;

  // Fidelity slices: whole Hauntings per slice, so a Haunting's warden sees all of its claims.
  // Slices by COST: consecutive batches (already grouped by Haunting) until a slice holds its share.
  // One big Haunting can span slices; a Rite that spans slices is reported.
  const nSlices = Math.min(slices, Math.max(1, batches.length));
  const perSlice = Math.ceil(batches.length / nSlices);
  const sliceOfBatch = new Map(batches.map((b, i) => [b.n, 1 + Math.floor(i / perSlice)]));
  const sliceOfGhost = new Map(batches.flatMap((b) => b.ghosts.map((g) => [g.id, sliceOfBatch.get(b.n)])));
  const riteSpans = units.filter((u) => new Set(reviewed.filter((g) => g.units.includes(u.key)).map((g) => sliceOfGhost.get(g.id))).size > 1).map((u) => u.name);

  // A compact map of what this repository contains — the jurisdiction classifier reads it to tell
  // "about this codebase" (including tooling that lives here, like a plugin) from another repo's.
  const tracked = git(tree, 'ls-files').split('\n').filter(Boolean);
  const tops = new Map();
  for (const f of tracked) { const parts = f.split('/'); const k = parts[0] === 'plugins' && parts.length > 2 ? `plugins/${parts[1]}` : parts.length > 1 ? parts[0] : '(root files)'; tops.set(k, (tops.get(k) || 0) + 1); }
  const repoMap = `${cfg.repo || 'this repo'}: ` + [...tops.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}/ (${n} files)`).join(', ');
  const state = {
    run_id: relative(runsDir, run), repo_map: repoMap, created_at: new Date().toISOString(), plugin_version: version, local,
    tree, sha: git(tree, 'rev-parse', 'HEAD'), main: p.main, invoked_from: p.root,
    scope, scope_label: label, posture, depth, reason: String(values.reason || ''), reference_scale: referenceScale, parts,
    org_id: orgId, me_id: me.id, whole_seance: wholeSeance ? { id: wholeSeance.id, name: wholeSeance.name } : null,
    hauntings_in_scope: imprintHauntings.map((h) => h.id), file_hauntings: (scopeHauntings.filter((h) => posture === 'coven' || ownHauntings.has(h.id)).length ? scopeHauntings.filter((h) => posture === 'coven' || ownHauntings.has(h.id)) : wholeHauntings).map((h) => ({ id: h.id, name: h.name })),
    scroll_parent: scope.kind === 'haunting' ? { kind: 'haunting', id: scope.id } : scope.kind === 'seance' ? { kind: 'seance', id: scope.id } : { kind: 'coven', id: orgId },
    shard_groups: groups, shards: assigned.shards, personas, tenets_path: tenetsPath, tenet_ids: tenetIds,
    principles_path: join(pluginRoot, 'skills/reckoning/references/principles.md'),
    batches: batches.map((b) => ({ ...b, slice: sliceOfBatch.get(b.n) })), units, fidelity_slices: nSlices,
    previous_scroll: previousScroll, previous_instruments: previousInstruments ? join(runsDir, previousInstruments, 'out', 'instruments') : null,
    obsolete_sigil: obsoleteLabel, budget: Number(values.budget) > 0 ? Math.trunc(Number(values.budget)) : null,
    only_lenses: String(values.lenses || '').split(',').map((x) => x.trim()).filter(Boolean),
    models: { ...(rcfg.models || {}), ...Object.fromEntries(String(values.models || '').split(',').map((x) => x.trim()).filter((x) => x.includes('=')).map((x) => x.split('=').map((y) => y.trim()))) },
    scoped: NAMED, history: hist, windows: windowCosts, out_of_jurisdiction: outOfJurisdiction,
    footprint: NAMED ? { ghosts_with_footprint: withFootprint, ghosts: reviewed.length, touched: footprint.touched.length, adjacent: footprint.adjacent.length } : null,
    tripwire_baseline: dirty(tree), imprints_only: imprintsOnly(parts), estimate: { imprints: imprintsAgents, fidelity: fidelityAgents, fidelity_slices: slices, health, verdict: imprintsOnly(parts) ? 0 : 17, total, target: TARGET, over_target: total > TARGET }, parts_state: {},
  };
  writeJSON(join(run, 'state.json'), state);
  // One config source for the whole run: the instruments read the SAME reckoning block prep did (the
  // invoking checkout's), not whatever the pinned tree's older config says.
  writeJSON(join(run, 'instruments.config.json'), rcfg.instruments || {});
  writeJSON(join(run, 'intents.draft.json'), Object.fromEntries(units.map((u) => [u.key, { name: u.name, kind: u.kind, description: trim(u.description, 1200) }])));
  out({
    ok: true, run, scope, posture, sha: state.sha, depth, parts, warnings, reference_scale: referenceScale || null,
    tenets_lint: tenetsCheck,
    counts: { hauntings: scopeHauntings.length, ghosts: reviewed.length, ghosts_obsolete_skipped: detail.filter((g) => g.labels.includes(obsoleteLabel) && !foreignGhost(g)).length, ghosts_out_of_window: inJurisdiction.length - reviewed.length, units_without_reviewed_ghosts: unitsDropped, exorcised: reviewed.filter((g) => g.status === 'exorcised').length, open: reviewed.filter((g) => OPEN.includes(g.status)).length, units: units.length, batches: batches.length, backlog: backlog.length, imprints: imprints.length, org_imprints: org.length, auguries: auguries.length, shards: assigned.shards.length, tenets: tenetIds.length },
    shard_coverage: { shards: assigned.shards.map((s) => ({ name: s.name, kind: s.kind, group: s.group, files: s.files.length, auto: !!s.auto })), uncovered_code_files: assigned.uncovered, auto_shards: assigned.auto, empty_configured_shards: assigned.empty },
    units: units.map((u) => ({ key: u.key, kind: u.kind, name: u.name, description: trim(u.description, 300) })),
    personas: personas.map((x) => ({ key: x.key, kinds: x.kinds })), unmapped_personas: unmapped,
    shard_groups: groups, no_shards: parts.includes('health') && !assigned.shards.length,
    models,
    scoped: NAMED, footprint: state.footprint, out_of_jurisdiction: outOfJurisdiction, foreign_imprints_skipped: foreignImprints, history: hist,
    history_windows: windowCosts, imprints_related: NAMED ? related : null, imprints_only: imprintsOnly(parts),
    estimate: { ...state.estimate, total_agents: total, hours_claude: hours(claudeConc), hours_codex: hours(codexConc), claude_concurrency: claudeConc, codex_concurrency: codexConc, note: 'rough: ~4 agent-minutes per agent; real runs vary by 2x' },
    rite_spans_slices: riteSpans,
    tripwire_baseline: state.tripwire_baseline,
    previous: { scroll: previousScroll, instruments: state.previous_instruments },
  });
}

// ── args ─────────────────────────────────────────────────────────────────────────────────────
function args(values) {
  const run = runOf(values);
  const s = stateOf(run);
  if (!s) fail(`no state.json in ${run} — run init first`);
  const key = String(values.part || '');
  const m = key.match(/^(imprints|verdict|fidelity(?:-(\d+))?|health-([a-z0-9-]+))$/);
  if (!m) fail(`unknown part key ${key} (imprints | fidelity[-N] | health-<group> | verdict)`);
  if (key === 'verdict' && s.imprints_only) fail('an imprints-only reckoning has no verdict step: run `finalize`, then apply reads the Imprint check\'s sealed ops directly', 3);
  const prev = s.parts_state[key];
  if (prev && prev.status === 'complete' && !values.force) fail(`${key} is already complete (gen ${prev.gen}); pass --force to re-run it`, 3);
  const gen = prev ? prev.gen + 1 : 1;
  const bus = join(s.tree, '.reckoning', `gen-${gen}`, key);
  mkdirSync(join(bus, '.tmp'), { recursive: true });
  const intents = readJSON(join(run, 'intents.json'), {});
  const common = {
    part: m[1].startsWith('fidelity') ? 'fidelity' : m[1].startsWith('health') ? 'health' : m[1],
    run_id: s.run_id, gen, tree: s.tree, ctx: join(s.tree, '.reckoning'), bus, bus_script: BUS,
    snapshot: join(run, 'snapshot'), instruments: join(run, 'instruments'), depth: s.depth, scope: s.scope, posture: s.posture, reason: s.reason,
    ...(s.reference_scale ? { reference_scale: s.reference_scale } : {}),
    principles_path: s.principles_path, tenets_path: s.tenets_path, tenet_ids: s.tenet_ids,
    personas: s.personas.filter((x) => x.kinds.length && x.file),
    ...(values['leaf-agent-type'] !== undefined ? { leaf_agent_type: values['leaf-agent-type'] } : {}),
    ...(values['refuter-agent-type'] !== undefined ? { refuter_agent_type: values['refuter-agent-type'] } : {}),
    ...(s.budget ? { budget: s.budget } : {}),
    ...(s.only_lenses && s.only_lenses.length ? { only_lenses: s.only_lenses } : {}),
    repo_map: s.repo_map || '',
    ...(s.models && Object.keys(s.models).length ? { models: s.models } : {}),
  };
  let a;
  if (common.part === 'health') {
    const g = s.shard_groups.find((x) => x.name === m[3]);
    if (!g) fail(`no shard group ${m[3]} (have ${s.shard_groups.map((x) => x.name).join(', ')})`);
    // Finders get their shard's exact FILE list, so a shard's review covers what it claims.
    const asArg = (x) => ({ name: x.name, kind: x.kind, paths: x.files, ...(s.scoped ? { touched: x.touched, adjacent: x.adjacent } : {}) });
    const summary = (x) => (s.scoped ? { name: x.name, kind: x.kind, paths: [`touched: ${x.touched.join(', ')}`, ...(x.adjacent.length ? [`adjacent: ${x.adjacent.slice(0, 30).join(', ')}${x.adjacent.length > 30 ? ` … +${x.adjacent.length - 30}` : ''}`] : [])] } : { name: x.name, kind: x.kind, paths: [`${x.files.length} files, e.g. ${x.files.slice(0, 6).join(', ')}`] });
    a = { ...common, scoped: !!s.scoped, group: g.name, shards: s.shards.filter((x) => x.group === g.name).map(asArg), all_shards: s.shards.map(summary), cross_cutting: g.cross_cutting };
  } else if (common.part === 'fidelity') {
    const slice = Number(m[2] || 0);
    const bs = s.batches.filter((b) => (slice ? b.slice === slice : true));
    if (!bs.length) fail(`fidelity${slice ? ` slice ${slice}` : ''} has no batches`);
    const units = s.units.filter((u) => bs.some((b) => b.ghosts.some((g) => g.units.includes(u.key)))).map((u) => ({ key: u.key, kind: u.kind, id: u.id, name: u.name, kinds: u.kinds || [], intent: intents[u.key]?.intent || '', file: join(run, 'snapshot', 'fidelity', `unit-${slug(u.key)}.json`) }));
    a = { ...common, slice, batches: bs.map((b) => ({ n: b.n, file: b.file, ghosts: b.ghosts })), units };
  } else if (common.part === 'imprints') {
    const im = readJSON(join(run, 'snapshot', 'imprints.json'), { imprints: [] }).imprints;
    const bl = readJSON(join(run, 'snapshot', 'backlog.json'), { ghosts: [] }).ghosts;
    a = { ...common, imprints: im.map((x) => ({ id: x.id, title: x.title, scope: x.scope, project_id: x.project_id, agent_id: x.agent_id, memory_type: x.memory_type, self: x.self, promoted: !!x.promoted })), hauntings_in_scope: s.hauntings_in_scope, known_task_ids: bl.flatMap((g) => [g.id, ...(g.wisps || []).map((w) => w.id)]) };
  } else {
    // A state.json written before init dropped a typed `verdict` can still list it among the Parts.
    const expected = s.parts.filter((x) => x !== 'verdict').flatMap((x) => (x === 'health' ? s.shard_groups.map((g) => `health-${g.name}`) : x === 'fidelity' ? (s.fidelity_slices > 1 ? Array.from({ length: s.fidelity_slices }, (_, i) => `fidelity-${i + 1}`) : ['fidelity']) : [x]));
    const done = Object.entries(s.parts_state).filter(([k, v]) => k !== 'verdict' && v.status === 'complete');
    const notDone = expected.filter((k) => !done.some(([dk]) => dk === k));
    // budget_exhausted / aborted / invalid / tampered are NOT complete: a verdict over them needs the
    // Hunter's explicit --force, and even then only COMPLETE Parts' seals are read.
    if (notDone.length && !values.force) fail(`these Parts are not complete: ${notDone.map((k) => `${k} (${s.parts_state[k]?.status || 'not run'})`).join(', ')} — run them, or pass --force to write a verdict without them`, 3, { missing: notDone });
    const seals = { imprints: '', fidelity: [], health: [] };
    for (const [k, v] of done) {
      if (k === 'imprints') seals.imprints = v.seal;
      else if (k.startsWith('fidelity')) seals.fidelity.push(v.seal);
      else if (k.startsWith('health')) seals.health.push(v.seal);
    }
    // The verified grounds a state change needs, read from the fidelity seals and the loose ends.
    const verified = { false_greens: [], open_done: [], open_obsolete: [], loose_close: [] };
    for (const f of seals.fidelity) {
      const sj = readJSON(f, {});
      for (const u of Object.values(sj.units || {})) {
        verified.false_greens.push(...(u.numbers?.false_greens || []));
        verified.open_done.push(...(u.numbers?.open_already_done || []));
        verified.open_obsolete.push(...(u.numbers?.open_obsolete || []));
      }
    }
    const le = readJSON(join(run, 'instruments', 'loose-ends.json'), null);
    if (le?.status === 'ok') verified.loose_close.push(...((le.data?.checks?.purgatory_with_merged_pr?.items || []).map((x) => x.id)));
    for (const k of Object.keys(verified)) verified[k] = [...new Set(verified[k])];
    const backlog = readJSON(join(run, 'snapshot', 'backlog.json'), { ghosts: [] }).ghosts;
    const im = readJSON(join(run, 'snapshot', 'imprints.json'), { imprints: [] }).imprints;
    // The tenet ids behind every code-review theme and finding (from the finders' own stubs), keyed the
    // way the cluster names its sources ("health-backend:F011.0", "health-backend:warden.…#theme"), so
    // the engine can tell a tenet violation from the evidence rather than from the cluster's say-so.
    const tenetsByRef = {};
    for (const sp of seals.health) {
      const sj = readJSON(sp, null);
      if (!sj) continue;
      const name = sp.split('/').pop().replace(/\.seal\.json$/, '');
      const busDir = sp.slice(0, sp.lastIndexOf('/'));
      const byFinding = {};
      for (const [leaf, v] of Object.entries(sj.leaves || {})) {
        if (!v || v.dead || !v.key) continue;
        const stub = readJSON(join(busDir, `${v.key}.stub.json`), null);
        (stub?.findings || []).forEach((f, i) => {
          const ids = (Array.isArray(f.violates) ? f.violates : []).map(String).filter((x) => x.startsWith('T-'));
          byFinding[`${leaf}.${i}`] = ids;
          tenetsByRef[`${name}:${leaf}.${i}`] = ids; // every ref, even an empty one: the engine flags a ref that is not here at all
        });
      }
      for (const w of Object.values(sj.wardens || {})) for (const t of w?.themes || []) {
        const ids = [...new Set((t.members || []).flatMap((m) => byFinding[m] || []))].sort();
        if (w.key) tenetsByRef[`${name}:${w.key}#${t.key}`] = ids;
      }
    }
    a = { ...common, seals, verified, missing_parts: notDone, tenets_by_ref: tenetsByRef, backlog: backlog.flatMap((g) => [{ id: g.id, status: g.status }, ...(g.wisps || []).map((w) => ({ id: w.id, status: w.status }))]), imprint_titles: im.map((x) => x.title), hauntings_in_scope: s.hauntings_in_scope, hauntings: s.file_hauntings || [], previous_scroll: s.previous_scroll, previous_instruments: s.previous_instruments, coverage: { scoped: !!s.scoped, footprint: s.footprint, history: s.history, out_of_jurisdiction: s.out_of_jurisdiction || 0 } };
  }
  const argsFile = join(run, 'args', `${key}.g${gen}.json`);
  writeJSON(argsFile, a);
  let script = null;
  if (values.engine) {
    script = join(run, 'runs', `${key}.g${gen}.js`);
    mkdirSync(dirname(script), { recursive: true });
    execFileSync('bash', [BUS, 'compose', resolve(values.engine), argsFile, script], { stdio: ['ignore', 'pipe', 'inherit'] });
  }
  s.parts_state[key] = { gen, status: 'launched', args: argsFile, bus, script, launched_at: new Date().toISOString() };
  writeJSON(join(run, 'state.json'), s);
  try { execFileSync('bash', [BUS, 'lock', run, 'heartbeat'], { stdio: 'ignore' }); } catch {}
  out({ ok: true, key, gen, args_file: argsFile, bus, script, args_chars: JSON.stringify(a).length });
}

// ── record ───────────────────────────────────────────────────────────────────────────────────
function record(values) {
  const run = runOf(values);
  const s = stateOf(run);
  if (!s) fail(`no state.json in ${run}`);
  const key = String(values.key || '');
  const ps = s.parts_state[key];
  if (!ps) fail(`${key} was never launched in this run`);
  const res = readJSON(resolve(values.result), null);
  if (!res || typeof res !== 'object') fail(`result file ${values.result} is missing or not JSON`);
  const problems = [];
  if (res.bus && res.bus !== ps.bus) problems.push(`result bus ${res.bus} is not this launch's bus ${ps.bus} (a stale result?)`);
  const sealIn = res.seal?.path || '';
  if (['complete', 'budget_exhausted'].includes(res.status)) {
    // The Part RETURNS its seal (seal_content) with the engine's checksum; record is what writes it.
    // (seal_fallback: a result from an engine that still had scribes, written the same way.)
    const content = res.seal_content ?? (res.seal && res.seal.ok === false ? res.seal_fallback : undefined);
    if (content !== undefined && content !== null) {
      const body = JSON.stringify(content);
      if (!res.seal?.djb2 || djb2(body) !== res.seal.djb2) problems.push(`the returned seal does not match the engine's checksum ${res.seal?.djb2 || '(none)'} (got ${djb2(body)}) — the result was not saved verbatim; save the Workflow's return value exactly and re-record`);
      else { mkdirSync(dirname(sealIn), { recursive: true }); writeFileSync(sealIn, body); }
    }
    if (!sealIn || !existsSync(sealIn)) problems.push(`no seal at ${sealIn || '(none)'}`);
    else {
      let body = readFileSync(sealIn, 'utf8');
      if (body.endsWith('\n')) body = body.slice(0, -1);
      if (res.seal?.djb2 && djb2(body) !== res.seal.djb2) problems.push(`seal ${sealIn} does not match its checksum`);
    }
  }
  // Tripwire: only CHANGES since the baseline count (the baseline already holds the dependency links).
  const base = new Set(s.tripwire_baseline || []);
  const changed = dirty(s.tree).filter((l) => !base.has(l));
  // Copy the Part's bus OUT of the tree: a removed or re-attached tree must never lose a finished Part.
  let kept = '';
  if (!problems.length && existsSync(ps.bus)) {
    kept = join(run, 'parts', `${key}.g${ps.gen}`);
    cpSync(ps.bus, kept, { recursive: true, filter: (src) => !/\/\.(tmp|seal-parts)(\/|$)/.test(src) });
  }
  const status = changed.length ? 'tampered' : problems.length ? 'invalid' : res.status;
  s.parts_state[key] = { ...ps, status, result: resolve(values.result), seal: kept && sealIn ? join(kept, sealIn.slice(ps.bus.length + 1)) : sealIn, kept, recorded_at: new Date().toISOString(), counts: res.counts || null, problems, tripwire: changed };
  writeJSON(join(run, 'state.json'), s);
  try { execFileSync('bash', [BUS, 'lock', run, 'heartbeat'], { stdio: 'ignore' }); } catch {}
  out({ ok: !problems.length && !changed.length && status === 'complete', key, status, problems, tripwire_changed: changed.slice(0, 50), counts: res.counts || null, caps: (res.caps || []).length, coverage: res.coverage ? { total: res.coverage.total, ok: res.coverage.ok, dead: res.coverage.dead_count, budget: res.coverage.budget_count } : null });
  if (changed.length) process.exitCode = 6;
  else if (problems.length) process.exitCode = 4;
}

function status(values) {
  const run = runOf(values);
  const s = stateOf(run);
  if (!s) fail(`no state.json in ${run}`);
  out({ ok: true, run, scope: s.scope, sha: s.sha, depth: s.depth, local: !!s.local, parts: s.parts.filter((x) => x !== 'verdict'), shard_groups: s.shard_groups.map((g) => g.name), fidelity_slices: s.fidelity_slices, parts_state: Object.fromEntries(Object.entries(s.parts_state).map(([k, v]) => [k, { gen: v.gen, status: v.status, problems: v.problems || [], tripwire: (v.tripwire || []).length }])), tree_present: existsSync(s.tree) });
}

// finalize: gather what must outlive the pinned tree into <run>/out — every COMPLETE Part's kept bus,
// the instruments (the next reckoning's trend), and the snapshot files apply reads.
function finalize(values) {
  const run = runOf(values);
  const s = stateOf(run);
  if (!s) fail(`no state.json in ${run}`);
  const dest = join(run, 'out');
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  const copyTree = (from, to) => { if (existsSync(from)) { cpSync(from, to, { recursive: true, filter: (src) => !/\/\.(tmp|seal-parts)(\/|$)/.test(src) }); copied += 1; } };
  copyTree(join(run, 'instruments'), join(dest, 'instruments'));
  for (const f of ['backlog.json', 'me.json', 'scope.json', 'imprints.json']) {
    const src = join(run, 'snapshot', f);
    if (existsSync(src)) { mkdirSync(join(dest, 'snapshot'), { recursive: true }); copyFileSync(src, join(dest, 'snapshot', f)); copied += 1; }
  }
  for (const [k, v] of Object.entries(s.parts_state)) if (v.kept && v.status === 'complete') copyTree(v.kept, join(dest, k));
  s.finalized_at = new Date().toISOString();
  writeJSON(join(run, 'state.json'), s);
  const verdict = s.parts_state.verdict;
  if (s.imprints_only) return out({ ok: true, out: dest, copied, imprints_only: true, plan: existsSync(join(dest, 'imprints', 'imprints.seal.json')) ? join(dest, 'imprints', 'imprints.seal.json') : null, scroll: null, note: 'the Scroll is generated from the sealed ops at publish' });
  out({ ok: true, out: dest, copied, scroll: verdict ? join(dest, 'verdict', 'scroll.md') : null, appendix: verdict ? join(dest, 'verdict', 'appendix.md') : null, plan: verdict ? join(dest, 'verdict', 'plan.seal.json') : null });
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      run: { type: 'string' }, tree: { type: 'string' }, scope: { type: 'string' }, target: { type: 'string' }, depth: { type: 'string' },
      reason: { type: 'string' }, parts: { type: 'string' }, lenses: { type: 'string' }, models: { type: 'string' }, budget: { type: 'string' }, local: { type: 'boolean' }, history: { type: 'string' }, 'no-imprints': { type: 'boolean' },
      part: { type: 'string' }, key: { type: 'string' }, result: { type: 'string' }, engine: { type: 'string' }, force: { type: 'boolean' }, cwd: { type: 'string' },
      'leaf-agent-type': { type: 'string' }, 'refuter-agent-type': { type: 'string' },
    },
  });
  if (!values.run) fail('--run <run dir> is required');
  const cmds = { init, args, record, status, finalize };
  if (!cmds[cmd]) fail(`usage: reckoning-prep.mjs ${Object.keys(cmds).join('|')} --run <dir> …`);
  Promise.resolve().then(() => cmds[cmd](values)).catch((e) => fail(e.message || String(e)));
}
