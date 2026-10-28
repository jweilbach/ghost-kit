#!/usr/bin/env node
// reckoning-apply.mjs — carries out an APPROVED reckoning plan against the Ghost Hunting API.
//
// The reckoning workflow never writes to the API; this does, and only what the Hunter approved.
// It writes ONLY what the engine validated and sealed (the plan seal's drafts, the Imprint seal's
// replacement text) — never a stub file an agent could have written differently. Every write is
// SAFE TO RE-RUN, because a network blip or a dead session mid-apply followed by a re-run must never
// duplicate a ghost, an EVP or an Imprint in prod:
//   * a journal (<run>/applied.jsonl) gets one line per CONFIRMED response, keyed by the verdict's
//     generation + item key, and a journaled step is never sent again;
//   * each Imprint write is its own batch under a stable idempotency key (run + generation + item),
//     so a lost response replays on the server instead of writing twice;
//   * created ghosts carry context_payload.reckoning = "<run>:<k>", EVPs / Auguries / Scrolls carry a
//     "<!-- reckoning:<run>:<k> -->" marker, looked up before anything is created;
//   * a merge is two journaled steps (supersede, then retire) — a failed retire is retried next run;
//   * every target is re-read first; a status change is checked against the status the API RETURNS.
//
//   plan    --run R                              numbered action plan, grouped, with "applied" flags
//   apply   --run R --select all|additive|1,4,7 [--dry-run]
//   publish --run R                              Scroll + appendix (child) + one Tolling; idempotent
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { reckoningClient } from './reckoning-api.mjs';

const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
const fail = (msg, code = 1, extra = {}) => { out({ ok: false, error: msg, ...extra }); process.exit(code); };
const readJSON = (f, d) => (f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const OPEN = ['ether', 'active_haunt', 'purgatory', 'poltergeist'];
// "Additive" = adds without rewriting or removing anything. An edit rewrites an Imprint in place
// (often someone else's), so it is not additive; a supersede keeps the old one, faded, in history.
const ADDITIVE = new Set(['enrich_existing', 'supersede', 'promote', 'new_imprint', 'fix_batch']);

export function load(values) {
  const run = resolve(values.run);
  const s = readJSON(join(run, 'state.json'), null);
  if (!s) fail(`no state.json in ${run}`);
  const o = join(run, 'out');
  // Only a COMPLETE Imprint check is ever applied: a tampered or budget_exhausted one keeps its bus for
  // the record, but its ops were never trusted (finalize copies only complete Parts into out/).
  const ist = s.parts_state?.imprints?.status;
  const idir = existsSync(join(o, 'imprints', 'imprints.seal.json')) ? join(o, 'imprints') : ist === 'complete' ? s.parts_state?.imprints?.kept : null;
  if (s.imprints_only && s.parts_state?.imprints && ist !== 'complete') fail(`the Imprint check is ${ist || 'not run'}, not complete — nothing from it can be applied; re-run the imprints Part`);
  const impSeal = idir ? readJSON(join(idir, 'imprints.seal.json'), { ops: [] }) : { ops: [] };
  // A bare Imprint reckoning (--parts imprints) has no verdict: the Imprint check's sealed ops ARE the plan.
  let vdir = null;
  let plan;
  if (s.imprints_only) {
    if (!idir || !existsSync(join(idir, 'imprints.seal.json'))) fail('no sealed Imprint check — run the imprints Part and `reckoning-prep.mjs finalize` first');
    plan = { scope: s.scope, actions: [], new_imprints: [], fix_batch: [] };
  } else {
    vdir = existsSync(join(o, 'verdict', 'plan.seal.json')) ? join(o, 'verdict') : s.parts_state?.verdict?.kept;
    if (!vdir || !existsSync(join(vdir, 'plan.seal.json'))) fail('no sealed plan — run the verdict Part and `reckoning-prep.mjs finalize` first');
    plan = readJSON(join(vdir, 'plan.seal.json'));
  }
  const snapFile = (f) => [join(o, 'snapshot', f), join(run, 'snapshot', f)].find(existsSync);
  const imprints = new Map((readJSON(snapFile('imprints.json'), { imprints: [] }).imprints || []).map((m) => [m.id, m]));
  const backlogIds = new Set();
  for (const g of readJSON(snapFile('backlog.json'), { ghosts: [] }).ghosts) { backlogIds.add(g.id); for (const w of g.wisps || []) backlogIds.add(w.id); }
  const gen = s.parts_state?.verdict?.gen || 1;
  const impGen = s.parts_state?.imprints?.gen || 1;
  return { run, s, plan, impSeal, imprints, backlogIds, vdir, gen, impGen, journal: join(run, 'applied.jsonl'), decisions: join(run, 'decisions.json') };
}

// The numbered plan the Hunter approves. One line per API-visible effect group.
function items(L) {
  const list = [];
  // Imprint ops are keyed by the IMPRINTS Part's generation: a re-run of that Part reuses k values.
  const ns = `i${L.impGen}`;
  for (const op of (L.impSeal.ops || []).filter((x) => x.status === 'pass')) {
    if (op.op === 'edit') { list.push({ ns, k: op.k, type: 'edit', additive: false, summary: `edit Imprint ${op.target.slice(0, 8)} (${Object.keys(op.changes || {}).join(', ')}) — ${String(op.reason || '').slice(0, 120)}`, op }); continue; }
    if (op.op === 'promote') { list.push({ ns, k: op.k, type: 'promote', additive: true, summary: `promote Imprint ${op.target.slice(0, 8)} to a Scroll — ${String(op.reason || '').slice(0, 120)}`, op }); continue; }
    if (op.op === 'supersede') list.push({ ns, k: op.k, type: 'supersede', additive: !op.also_banish, summary: `supersede Imprint ${op.target.slice(0, 8)} → "${op.title}"${op.also_banish ? ` and retire its duplicate ${op.also_banish.slice(0, 8)}` : ''}`, op });
    else list.push({ ns, k: op.k, type: 'banish', additive: false, summary: `retire Imprint ${op.target.slice(0, 8)}${op.dup_of ? ` (duplicate of ${op.dup_of.slice(0, 8)})` : ''} — ${String(op.reason || '').slice(0, 140)}`, op });
  }
  (L.plan.new_imprints || []).forEach((m, i) => list.push({ k: `new-imprint.${i}`, type: 'new_imprint', additive: true, summary: `new Imprint (${m.memory_type}, ${m.scope}): "${m.title}"`, item: m }));
  if ((L.plan.fix_batch || []).length) list.push({ k: 'fix-batch', type: 'fix_batch', additive: true, summary: `ONE cleanup ghost with ${L.plan.fix_batch.length} checklist item(s): ${L.plan.fix_batch.join(', ')}`, members: L.plan.fix_batch });
  for (const a of L.plan.actions || []) {
    if (['note_only', 'drop', 'fix_batch'].includes(a.disposition)) continue;
    list.push({ k: a.k, type: a.disposition, additive: ADDITIVE.has(a.disposition), target: a.target_ghost_id || '', summary: `${a.disposition}${a.target_ghost_id ? ` ${a.target_ghost_id.slice(0, 8)}` : ''}: ${a.title} (${a.severity})`, action: a, draft: a.draft || {} });
  }
  const order = ['edit', 'supersede', 'promote', 'banish', 'new_imprint', 'fix_batch', 'enrich_existing', 'file_ghost', 'raise_augury', 'reopen_ghost', 'close_done', 'mark_obsolete'];
  list.sort((x, y) => order.indexOf(x.type) - order.indexOf(y.type));
  return list.map((x, i) => ({ n: i + 1, ...x }));
}
const jkey = (L, x, k = x.k) => `${x.ns || `g${L.gen}`}:${k}`;
export const journaled = (file) => {
  const done = new Map();
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) { try { const j = JSON.parse(line); if (j.ok) done.set(j.k, j); } catch {} }
  return done;
};
const note = (file, entry) => appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
const marker = (runId, k) => `<!-- reckoning:${runId}:${k} -->`;
// An item is done when all of its journaled steps are (a merge has two).
// A skipped step (the world moved since the snapshot) is RESOLVED, not pending: it is journaled.
const isDone = (L, done, x) => done.has(jkey(L, x)) && (!(x.type === 'supersede' && x.op.also_banish) || done.has(jkey(L, x, `${x.k}#retire`)));
const pendingOf = (L, list, done) => {
  const declined = new Set(readJSON(L.decisions, { declined: [] }).declined || []);
  return list.filter((x) => !isDone(L, done, x) && !declined.has(x.k));
};

function plan(values) {
  const L = load(values);
  const list = items(L);
  const done = journaled(L.journal);
  out({ ok: true, run: L.run, scope: L.plan.scope, items: list.map((x) => ({ n: x.n, k: x.k, type: x.type, additive: x.additive, applied: isDone(L, done, x), summary: x.summary })), counts: { total: list.length, additive: list.filter((x) => x.additive).length, applied: list.filter((x) => isDone(L, done, x)).length } });
}

async function apply(values) {
  const L = load(values);
  const runId = L.s.run_id;
  const list = items(L);
  const sel = String(values.select || '');
  const chosen = sel === 'all' ? list : sel === 'additive' ? list.filter((x) => x.additive) : list.filter((x) => sel.split(',').map((n) => Number(n.trim())).includes(x.n));
  if (!chosen.length) fail('nothing selected (use --select all | additive | 1,3,5)');
  const done = journaled(L.journal);
  const todo = chosen.filter((x) => !isDone(L, done, x));
  if (values['dry-run']) return out({ ok: true, dry_run: true, would_apply: todo.map((x) => ({ n: x.n, k: x.k, type: x.type, summary: x.summary })), already_applied: chosen.filter((x) => isDone(L, done, x)).map((x) => x.k) });
  // What was NOT selected is declined (not pending) — the Tolling stops asking about it.
  writeFileSync(L.decisions, JSON.stringify({ at: new Date().toISOString(), selected: sel, declined: list.filter((x) => !chosen.includes(x)).map((x) => x.k) }, null, 2) + '\n');
  const { req } = reckoningClient({ cwd: values.cwd || process.cwd(), local: !!(values.local || L.s.local) });
  const results = [];
  // A skip is a resolution (journaled, never retried, never counted as a failure): the target changed
  // or vanished since the snapshot, and the only honest move is to leave it for the next reckoning.
  const step = (x, k, ok, detail) => { const e = { k: jkey(L, x, k), n: x.n, type: x.type, ok: ok || !!detail?.skipped, ...detail }; if (e.ok) { note(L.journal, e); done.set(e.k, e); } results.push(e); };
  // An edit or supersede was written against the SNAPSHOT text; if someone changed the Imprint since,
  // applying it would silently overwrite their change.
  const staleSince = (live, id) => { const snap = L.imprints.get(id); return snap?.updated_at && live?.updated_at && live.updated_at !== snap.updated_at ? `the Imprint changed since the snapshot (${snap.updated_at} → ${live.updated_at}); re-reckon it` : ''; };
  const hauntingIds = new Set((L.s.file_hauntings || []).map((h) => h.id));
  const errText = (r) => `HTTP ${r?.status} ${r?.body?.detail?.error_code || ''} ${JSON.stringify(r?.body?.detail?.detail || r?.body?.detail || r?.body || '').slice(0, 240)}`.trim();

  // 1. Imprints. Each write is its own batch under a STABLE key, so a replay is the server's job.
  const writeImprint = async (x, k, item) => {
    const r = await req('POST', '/api/agent/imprints/batch', { items: [item], idempotency_key: `reckoning:${runId}:${jkey(L, x, k)}`.slice(0, 128) });
    if (r?.ok) return step(x, k, true, { imprint_id: r.body?.memory_ids?.[0], replayed: !!r.body?.replayed });
    const code = r?.body?.detail?.error_code || JSON.stringify(r?.body?.detail?.failing_indexes || '');
    if (/SUPERSEDE_CONFLICT/.test(code)) return step(x, k, false, { skipped: 'the target was superseded by someone else since the snapshot' });
    return step(x, k, false, { error: errText(r) });
  };
  const retire = async (x, k, id) => {
    const g = await req('GET', `/api/agent/imprints/${id}`);
    if (g?.status === 404) return step(x, k, false, { skipped: `Imprint ${id} no longer exists` });
    if (g?.ok && g.body?.status === 'banished') return step(x, k, true, { retired: id, already: true });
    const r = await req('POST', `/api/agent/imprints/${id}/retire`);
    if (r?.ok && r.body?.status === 'banished') return step(x, k, true, { retired: id });
    if (r?.status === 403) return step(x, k, false, { error: `403 ${r.body?.detail?.error_code || ''}: this Medium may not retire it on this backend — a Hunter can retire it at /imprints (retire parity is ghost-kit PR #203)` });
    return step(x, k, false, { error: errText(r) });
  };
  for (const x of todo.filter((y) => y.type === 'edit' || y.type === 'promote')) {
    const g = await req('GET', `/api/agent/imprints/${x.op.target}`);
    if (g?.status === 404) { step(x, x.k, false, { skipped: 'the Imprint no longer exists' }); continue; }
    if (g?.ok && g.body?.status !== 'vivid') { step(x, x.k, false, { skipped: `the Imprint is ${g.body?.status} now` }); continue; }
    if (!g?.ok) { step(x, x.k, false, { error: `GET Imprint ${errText(g)}` }); continue; }
    if (x.type === 'edit') {
      // Already carries every change (a re-run after a lost response): done, not "changed by someone".
      const linkSet = (ls) => JSON.stringify((ls || []).map((l) => `${l.kind}:${l.id}`).sort());
      const holds = Object.entries(x.op.changes || {}).every(([f, v]) => (f === 'links' ? linkSet(g.body.links) === linkSet(v) : f === 'tags' ? JSON.stringify([...(g.body.tags || [])].sort()) === JSON.stringify([...v].sort()) : g.body[f] === v));
      if (holds) { step(x, x.k, true, { edited: x.op.target, already: true }); continue; }
      const stale = staleSince(g.body, x.op.target);
      if (stale) { step(x, x.k, false, { skipped: stale }); continue; }
      // An identical PUT is a no-op on the server, so a re-run after a lost response is harmless.
      const r = await req('PUT', `/api/agent/imprints/${x.op.target}`, x.op.changes || {});
      if (r?.ok) step(x, x.k, true, { edited: x.op.target, fields: Object.keys(x.op.changes || {}) });
      else step(x, x.k, false, { error: r?.status === 403 ? `403 ${r.body?.detail?.error_code || ''}: this backend lets a Medium edit only its own Imprints — a Hunter can edit it at /imprints (edit parity is PR #203)` : errText(r) });
    } else {
      const r = await req('POST', `/api/agent/imprints/${x.op.target}/promote`);
      if (r?.ok) step(x, x.k, true, { scroll_id: r.body?.document?.id });
      else if (r?.status === 409 && /ALREADY_PROMOTED/.test(JSON.stringify(r.body))) step(x, x.k, true, { already: true, scroll_id: r.body?.detail?.promoted_document_id });
      else step(x, x.k, false, { error: errText(r) });
    }
  }
  for (const x of todo.filter((y) => y.type === 'supersede' || y.type === 'new_imprint' || y.type === 'banish')) {
    if (x.type === 'new_imprint') {
      const m = x.item;
      await writeImprint(x, x.k, { title: m.title, content: m.content, memory_type: m.memory_type, scope: m.scope, ...(m.scope === 'project' ? { project_id: m.project_id } : {}), tags: [...new Set([...(m.tags || []), 'reckoning'])].slice(0, 20) });
    } else if (x.type === 'supersede') {
      if (!done.has(jkey(L, x))) {
        const g = await req('GET', `/api/agent/imprints/${x.op.target}`);
        if (g?.status === 404) { step(x, x.k, false, { skipped: 'the Imprint no longer exists' }); continue; }
        if (g?.ok && g.body?.status !== 'vivid') { step(x, x.k, false, { skipped: `the Imprint is ${g.body?.status} now` }); continue; }
        const stale = g?.ok ? staleSince(g.body, x.op.target) : '';
        if (stale) { step(x, x.k, false, { skipped: stale }); continue; }
        // The replacement keeps what the old Imprint was linked to — its tags, citations and source
        // ghost — and adds the reckoning tag; only the text, type and (widened) scope change.
        const old = L.imprints.get(x.op.target) || {};
        await writeImprint(x, x.k, {
          title: x.op.title, content: x.op.content, memory_type: x.op.memory_type, scope: x.op.scope, supersedes_id: x.op.target,
          ...(x.op.scope === 'project' ? { project_id: x.op.project_id } : {}),
          tags: [...new Set([...(old.tags || []), 'reckoning'])].slice(0, 20),
          ...(Array.isArray(old.links) && old.links.length ? { links: old.links.slice(0, 20) } : {}),
          ...(old.source_task_id ? { source_task_id: old.source_task_id } : {}),
        });
      }
      if (x.op.also_banish && done.has(jkey(L, x)) && !done.get(jkey(L, x))?.skipped) await retire(x, `${x.k}#retire`, x.op.also_banish);
      else if (x.op.also_banish && done.get(jkey(L, x))?.skipped) step(x, `${x.k}#retire`, false, { skipped: 'its merge replacement was skipped, so the duplicate stays' });
    } else await retire(x, x.k, x.op.target);
  }

  // 2. Ghost-side actions, from the SEALED drafts.
  const evpExists = async (ghostId, k) => {
    const r = await req('GET', `/api/agent/ghosts/${ghostId}/evps`);
    if (!r?.ok) throw new Error(`cannot read EVPs of ${ghostId} (${errText(r)}) — not posting blind`);
    return (r.body || []).some((e) => String(e.content || '').includes(marker(runId, k)));
  };
  const postEvp = async (k, ghostId, text) => {
    if (await evpExists(ghostId, k)) return { ok: true, existed: true };
    const r = await req('POST', `/api/agent/ghosts/${ghostId}/evps`, { content: `${String(text).slice(0, 9800)}\n\n${marker(runId, k)}` });
    return { ok: !!r?.ok, id: r?.body?.id, error: r?.ok ? undefined : errText(r) };
  };
  const ghostByMarker = async (title, k) => {
    const r = await req('GET', `/api/agent/search?q=${encodeURIComponent(String(title || '').slice(0, 120))}`);
    for (const t of (r?.ok && r.body?.tasks) || []) {
      const g = await req('GET', `/api/agent/ghosts/${t.id}`);
      if (g?.ok && g.body?.context_payload?.reckoning === `${runId}:${k}`) return g.body;
    }
    return null;
  };
  const setStatus = async (ghostId, status) => {
    const r = await req('PUT', `/api/agent/ghosts/${ghostId}/status`, { status });
    return { ok: !!r?.ok && r.body?.status === status, got: r?.body?.status, http: r?.status };
  };
  for (const x of todo.filter((y) => !['supersede', 'banish', 'new_imprint', 'edit', 'promote'].includes(y.type))) {
    const d = x.draft || {};
    try {
      if (x.type === 'fix_batch') {
        const members = x.members.map((k) => (L.plan.actions || []).find((a) => a.k === k) || { k, title: k, draft: {} });
        const project_id = L.s.scope.kind === 'haunting' ? L.s.scope.id : (L.s.file_hauntings || [])[0]?.id;
        if (!project_id) { step(x, x.k, false, { error: 'no Haunting to file the cleanup ghost in' }); continue; }
        const title = `Reckoning cleanup batch — ${L.s.scope.name} (${members.length} items, ${String(L.s.created_at).slice(0, 10)})`;
        const existing = await ghostByMarker(title, x.k);
        if (existing) { step(x, x.k, true, { ghost_id: existing.id, existed: true }); continue; }
        const body = { title: title.slice(0, 500), priority: 'moan', description: `Small verified fixes from the reckoning ${runId} — each is a few lines; do them together.`, context_payload: { objective: 'Land every checklist item below; each was verified by the reckoning at the pinned SHA.', instructions: members.map((m) => `[${m.k}] ${m.draft?.item || m.title}`), files: [...new Set(members.flatMap((m) => m.draft?.files || []))].slice(0, 100), acceptance_criteria: members.map((m) => `[${m.k}] fixed, with the repo's test suite green`), reckoning: `${runId}:${x.k}`, reckoning_sha: L.s.sha } };
        const r = await req('POST', `/api/agent/hauntings/${project_id}/ghosts`, body);
        step(x, x.k, !!r?.ok, r?.ok ? { ghost_id: r.body?.id } : { error: errText(r) });
      } else if (x.type === 'file_ghost') {
        if (!hauntingIds.has(d.project_id) || !d.title) { step(x, x.k, false, { error: `the sealed draft has no in-scope Haunting or no title — not filed` }); continue; }
        const existing = await ghostByMarker(d.title, x.k);
        if (existing) { step(x, x.k, true, { ghost_id: existing.id, existed: true }); continue; }
        const body = { title: d.title, priority: d.priority || 'moan', description: d.description || '', context_payload: { ...(d.context_payload || {}), reckoning: `${runId}:${x.k}`, reckoning_sha: L.s.sha } };
        const r = await req('POST', `/api/agent/hauntings/${d.project_id}/ghosts`, body);
        step(x, x.k, !!r?.ok, r?.ok ? { ghost_id: r.body?.id } : { error: errText(r) });
      } else if (x.type === 'raise_augury') {
        const body = { title: d.title, context: `${String(d.context || '')}\n\n${marker(runId, x.k)}`.slice(0, 20000), ...(d.options ? { options: d.options } : {}), ...(d.task_id && L.backlogIds.has(d.task_id) ? { task_id: d.task_id } : {}) };
        const r = await req('POST', '/api/agent/auguries', body); // idempotent on (task_id, title) server-side
        step(x, x.k, !!r?.ok, r?.ok ? { augury_id: r.body?.id } : { error: errText(r) });
      } else if (['enrich_existing', 'reopen_ghost', 'close_done', 'mark_obsolete'].includes(x.type)) {
        const gid = x.target;
        if (!L.backlogIds.has(gid)) { step(x, x.k, false, { error: `target ${gid} is not in the backlog snapshot` }); continue; }
        const g = await req('GET', `/api/agent/ghosts/${gid}`);
        if (!g?.ok) { step(x, x.k, false, { error: `GET ghost ${errText(g)}` }); continue; }
        const st = g.body?.status;
        if (x.type === 'reopen_ghost' && st !== 'exorcised') { step(x, x.k, false, { skipped: `ghost is ${st} now, not exorcised` }); continue; }
        if ((x.type === 'close_done' || x.type === 'mark_obsolete') && !OPEN.includes(st)) { step(x, x.k, false, { skipped: `ghost is ${st} now, not open` }); continue; }
        const e = await postEvp(x.k, gid, d.evp || x.action.title);
        if (!e.ok) { step(x, x.k, false, { error: e.error }); continue; }
        if (x.type === 'reopen_ghost') { const r = await setStatus(gid, 'ether'); step(x, x.k, r.ok, r.ok ? { status: 'ether' } : { error: `status is ${r.got} (HTTP ${r.http})` }); }
        else if (x.type === 'close_done') { const r = await setStatus(gid, 'exorcised'); step(x, x.k, r.ok, r.ok ? { status: 'exorcised' } : { error: `status is ${r.got} (HTTP ${r.http})` }); }
        else if (x.type === 'mark_obsolete') {
          const name = String(L.s.obsolete_sigil || 'obsolete');
          const sig = await req('GET', '/api/agent/sigils');
          let label = ((sig?.ok && sig.body) || []).find((l) => String(l.name).toLowerCase() === name);
          if (!label) { const c = await req('POST', '/api/agent/sigils', { name, color: '#6b7280' }); label = c?.ok ? c.body : null; }
          if (!label) { step(x, x.k, false, { error: 'could not find or create the obsolete Sigil' }); continue; }
          const has = await req('GET', `/api/agent/ghosts/${gid}/sigils`);
          if (!(((has?.ok && has.body) || []).some((l) => l.id === label.id))) { const r = await req('POST', `/api/agent/ghosts/${gid}/sigils`, { label_id: label.id }); if (!r?.ok) { step(x, x.k, false, { error: `add Sigil ${errText(r)}` }); continue; } }
          step(x, x.k, true, { sigil: name });
        } else step(x, x.k, true, { evp_id: e.id, existed: !!e.existed });
      }
    } catch (err) { step(x, x.k, false, { error: String(err.message || err).slice(0, 300) }); }
  }

  // 3. Nothing left to act on → acknowledge the needs_action Tolling this reckoning posted.
  const pending = pendingOf(L, list, done);
  const tj = [...done.values()].find((j) => j.k === 'tolling' && j.needs_action);
  if (!pending.length && tj && !done.has('tolling#ack')) {
    const r = await req('POST', `/api/agent/tollings/${tj.tolling_id}/acknowledge`);
    if (r?.ok) note(L.journal, { k: 'tolling#ack', ok: true, tolling_id: tj.tolling_id });
  }
  const failed = results.filter((r) => !r.ok);
  out({ ok: !failed.length, applied: results.filter((r) => r.ok && !r.skipped).length, skipped: results.filter((r) => r.skipped).length, failed: failed.length, pending: pending.length, results, journal: L.journal });
  if (failed.length) process.exitCode = 4;
}

// The bare Imprint reckoning's Scroll, written from the SEALED ops and the journal — no agent writes it.
const cell = (x, n = 220) => String(x ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, n);
export function imprintScroll(L, done) {
  const list = items(L);
  const declined = new Set(readJSON(L.decisions, { declined: [] }).declined || []);
  const seal = L.impSeal || {};
  const jur = Object.values(seal.jurisdiction || {});
  const n = (c) => jur.filter((x) => x === c).length;
  const ops = seal.ops || [];
  const titleOf = (id) => L.imprints.get(id)?.title || '(title not in the snapshot)';
  const stateOf = (x) => {
    const j = done.get(jkey(L, x));
    if (j?.skipped) return `skipped: ${cell(j.skipped, 160)}`;
    if (isDone(L, done, x)) return 'applied';
    return declined.has(x.k) ? 'declined' : 'awaiting approval';
  };
  const what = (x) => (x.type === 'edit' ? `edit (${Object.keys(x.op.changes || {}).join(', ')})` : x.type === 'supersede' ? (x.op.also_banish ? `merge → "${cell(x.op.title, 120)}", retiring ${x.op.also_banish.slice(0, 8)}` : `supersede → "${cell(x.op.title, 120)}"`) : x.type === 'banish' ? (x.op.dup_of ? `retire (duplicate of ${x.op.dup_of.slice(0, 8)})` : 'retire') : x.type);
  const snapCount = L.imprints.size;
  const lines = [
    `# Imprint reckoning — ${L.s.scope?.name || L.s.scope_label}`,
    '',
    `Pinned at \`${String(L.s.sha || '').slice(0, 12)}\` · ${String(L.s.created_at || '').slice(0, 10)} · run \`${L.s.run_id}\` · a bare Imprint check (no claims check, no code review, so no brand-new Imprints)`,
    '',
    `**Reviewed:** ${snapCount} vivid Imprint(s)${jur.length ? ` — ${n('T')} this repo's, ${n('O')} another repo's and ${n('P')} process (those two left alone), ${n('?')} unclassified` : ''}.`,
    `**Proposed:** ${ops.filter((o) => o.status === 'pass').length} change(s) passed verification; ${ops.filter((o) => o.status === 'refuted').length} refuted and ${ops.filter((o) => o.status === 'unverified').length} unverified (never applied); ${(seal.invalid || []).length} invalid.`,
    `**Now:** ${list.filter((x) => stateOf(x) === 'applied').length} applied · ${list.filter((x) => stateOf(x).startsWith('skipped')).length} skipped · ${list.filter((x) => stateOf(x) === 'awaiting approval').length} awaiting approval · ${list.filter((x) => stateOf(x) === 'declined').length} declined.`,
    '',
    '## Changes',
    '',
  ];
  if (list.length) {
    lines.push('| # | Change | Imprint | Why | State |', '|---|---|---|---|---|');
    for (const x of list) lines.push(`| ${x.n} | ${cell(what(x), 200)} | ${cell(titleOf(x.op.target), 120)} (\`${x.op.target.slice(0, 8)}\`) | ${cell(x.op.reason)} | ${stateOf(x)} |`);
  } else lines.push('Every Imprint checked still holds — nothing to change.');
  const notApplied = ops.filter((o) => o.status !== 'pass');
  if (notApplied.length) {
    lines.push('', '## Proposed but not verified (never applied)', '');
    for (const o of notApplied) lines.push(`- ${o.op} \`${String(o.target).slice(0, 8)}\` "${cell(titleOf(o.target), 120)}" — ${o.status}: ${cell(o.reason, 200)}`);
  }
  if ((seal.invalid || []).length) {
    lines.push('', '## Invalid proposals (refused by the engine)', '');
    for (const v of seal.invalid) lines.push(`- \`${String(v.target || '').slice(0, 8)}\` — ${cell(v.why, 240)}`);
  }
  return lines.join('\n') + '\n';
}

async function publish(values) {
  const L = load(values);
  const runId = L.s.run_id;
  const { req } = reckoningClient({ cwd: values.cwd || process.cwd(), local: !!(values.local || L.s.local) });
  const done = journaled(L.journal);
  const bare = !!L.s.imprints_only;
  const scrollFile = bare ? null : join(L.vdir, 'scroll.md');
  if (!bare && !existsSync(scrollFile)) fail(`no Scroll at ${scrollFile} — re-run the verdict Part`);
  const scrollBody = bare ? imprintScroll(L, done) : readFileSync(scrollFile, 'utf8');
  // The run id is in the title: two reckonings of one scope on one day are two Scrolls.
  const title = `${L.s.scope_label}${bare ? ' — Imprints' : ''} — ${String(L.s.created_at || '').slice(0, 10)} · ${runId.slice(0, 16)}`;
  const parent = L.s.scroll_parent;
  const createPath = parent.kind === 'haunting' ? `/api/agent/hauntings/${parent.id}/scrolls` : parent.kind === 'seance' ? `/api/agent/seances/${parent.id}/scrolls` : `/api/agent/covens/${L.s.org_id}/scrolls`;
  const findByTitle = async (t) => { const r = await req('GET', `/api/agent/covens/${L.s.org_id}/scrolls?search=${encodeURIComponent(t.slice(0, 120))}&limit=50`); return ((r?.ok && r.body?.items) || []).find((x) => x.title === t) || null; };
  const res = {};
  const footer = `\n\n---\n*Reckoning \`${runId}\` · pinned at \`${String(L.s.sha).slice(0, 12)}\`${bare ? '' : ` · depth ${L.s.depth} · appendix: [[${title} — appendix]]`}*\n${marker(runId, 'scroll')}`;
  let scrollId = done.get('scroll')?.scroll_id || (await findByTitle(title))?.id;
  if (!scrollId) {
    const r = await req('POST', createPath, { title, content: scrollBody.slice(0, 480000) + footer });
    if (!r?.ok) fail(`Scroll create ${r?.status}: ${JSON.stringify(r?.body).slice(0, 300)}`);
    scrollId = r.body.id;
    note(L.journal, { k: 'scroll', ok: true, scroll_id: scrollId });
  }
  else if (bare) {
    // The generated Scroll states each change's apply state; a later apply must not leave it saying
    // "awaiting approval". Refresh it under the Scroll's version lock.
    const cur = await req('GET', `/api/agent/scrolls/${scrollId}`);
    const want = scrollBody.slice(0, 480000) + footer;
    if (cur?.ok && cur.body?.content !== want) {
      const r = await req('PUT', `/api/agent/scrolls/${scrollId}`, { content: want, base_version: cur.body.version });
      if (r?.ok) { note(L.journal, { k: 'scroll#refresh', ok: true, scroll_id: scrollId, version: r.body?.version }); res.scroll_refreshed = true; }
      else res.scroll_refresh_error = `HTTP ${r?.status}${r?.status === 409 ? ' (someone edited the Scroll; its states were left as they are)' : ''}`;
    }
  }
  res.scroll = scrollId;
  const appendixFile = bare ? '' : join(L.vdir, 'appendix.md');
  if (appendixFile && existsSync(appendixFile)) {
    const at = `${title} — appendix`;
    let appId = done.get('appendix')?.scroll_id || (await findByTitle(at))?.id;
    if (!appId) {
      const r = await req('POST', createPath, { title: at, content: readFileSync(appendixFile, 'utf8').slice(0, 480000) + `\n\n${marker(runId, 'appendix')}`, parent_document_id: scrollId });
      if (r?.ok) { appId = r.body.id; note(L.journal, { k: 'appendix', ok: true, scroll_id: appId }); }
      else res.appendix_error = `HTTP ${r?.status}`;
    }
    res.appendix = appId || null;
  }
  if (!done.has('tolling')) {
    const list = items(L);
    const pending = pendingOf(L, list, done);
    const applied = list.filter((x) => isDone(L, done, x) && !done.get(jkey(L, x))?.skipped).length;
    const body = `The reckoning of **${L.s.scope.name}** is written: /scrolls/${scrollId}\n\n${applied ? `${applied} approved action(s) applied. ` : ''}${pending.length ? `${pending.length} proposed action(s) are waiting for a Hunter's approval — \`/reckoning apply ${runId}\`.` : 'Nothing is waiting for approval.'}\n\n${marker(runId, 'tolling')}`;
    const r = await req('POST', '/api/agent/tollings', { title: `${L.s.scope_label || `Reckoning — ${L.s.scope.name}`}${bare ? ' — Imprints' : ''}`, body, summary: `Reckoning written; ${pending.length} action(s) awaiting approval`.slice(0, 500), category: 'finding', needs_action: pending.length > 0, ...(L.s.scope.kind === 'haunting' ? { project_id: L.s.scope.id } : {}) });
    if (r?.ok) { note(L.journal, { k: 'tolling', ok: true, tolling_id: r.body?.id, needs_action: pending.length > 0 }); res.tolling = r.body?.id; res.needs_action = pending.length > 0; }
    else res.tolling_error = `HTTP ${r?.status}`;
  }
  out({ ok: true, ...res, title });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { run: { type: 'string' }, select: { type: 'string' }, 'dry-run': { type: 'boolean' }, local: { type: 'boolean' }, cwd: { type: 'string' } } });
  if (!values.run) fail('--run <run dir> is required');
  const cmds = { plan, apply, publish };
  if (!cmds[cmd]) fail(`usage: reckoning-apply.mjs ${Object.keys(cmds).join('|')} --run <dir> …`);
  Promise.resolve().then(() => cmds[cmd](values)).catch((e) => fail(e.message || String(e)));
}
