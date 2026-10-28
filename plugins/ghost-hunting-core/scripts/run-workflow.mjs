#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { project } from '../runtime/project.mjs';
import { compileWorkflow, workflowFile, limiter } from '../runtime/engine.mjs';
import { codexAdapter } from '../runtime/codex.mjs';

export async function run(p, name, args, { dryRun = false, agent: injected, signal, baseModel, executable } = {}) {
  const host = p.config.hosts?.codex || {};
  const schedule = limiter(host.concurrency || 4);
  const source = workflowFile(p, name);
  const compile = s => compileWorkflow(s.text, { filename: s.file, root: p.root, aliases: host.path_aliases || [] });
  const execute = compile(source);
  if (dryRun) return { status: 'validated', workflow: source.file, checkout: p.root, models: host.models || {}, concurrency: host.concurrency || 4, note: 'Syntax/freshness only; no agents or external effects were run.' };
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dir = join(p.common, 'ghost-runtime', id); mkdirSync(dir, { recursive: true, mode: 0o700 });
  // One runner per checkout. A stale lock is inspectable, never automatically stolen.
  const lock = join(p.root, '.ghost', 'codex-workflow.lock');
  mkdirSync(join(p.root, '.ghost'), { recursive: true });
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, id, workflow: source.file, dir }), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error(`Workflow already running or interrupted: inspect ${lock} and its recorded run before retrying`); }
  const log = (event, data = {}) => {
    const entry = { at: new Date().toISOString(), event, ...data };
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    process.stderr.write(`[ghost-kit] ${event}${data.label ? ` ${data.label}` : ''}\n`);
  };
  const adapter = injected ? { agent: injected, cancel() {} } : codexAdapter(p, { runDir: dir, log, signal, baseModel, executable });
  let cancelled = false;
  const agent = (prompt, opts) => schedule(() => {
    if (signal?.aborted || cancelled) throw new Error('Workflow cancelled');
    return adapter.agent(prompt, opts);
  });
  const globals = depth => ({ args, agent, parallel: fns => Promise.all(fns.map(fn => fn())),
    phase: value => log('phase', { label: typeof value === 'string' ? value : JSON.stringify(value) }),
    log: value => log('workflow_log', { message: String(value) }),
    workflow: async (child, childArgs) => {
      if (depth >= 1) throw new Error('Workflow nesting deeper than one child is unsupported');
      const nested = workflowFile(p, child, { nested: true });
      return compile(nested)({ ...globals(depth + 1), args: childArgs });
    },
  });
  log('run_start', { id, workflow: source.file });
  try {
    const result = await execute(globals(0));
    if (signal?.aborted) throw new Error('Workflow cancelled');
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    log('run_end', { status: 'returned', label: join(dir, 'result.json') }); // stderr names the lossless copy
    return result;
  } catch (error) {
    cancelled = true; await adapter.cancel(); log('run_end', { status: 'failed', error: error.message }); throw error;
  } finally { rmSync(lock, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
  try {
    const { values } = parseArgs({ options: { workflow: { type: 'string' }, 'args-file': { type: 'string' }, repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, model: { type: 'string' } } });
    if (!values.workflow) throw new Error('Usage: run-workflow --workflow <name-or-path> [--args-file file.json] [--repo path] [--dry-run] [--model model]');
    const result = await run(project(values.repo), values.workflow, values['args-file'] ? JSON.parse(readFileSync(values['args-file'])) : {}, { dryRun: values['dry-run'], signal: abort.signal, baseModel: values.model });
    console.log(JSON.stringify(result, null, 2));
    if (result?.aborted || result?.green === false || ['invalid', 'failed', 'escalated', 'backfired'].includes(result?.status)) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
