import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { persona, modelDefaults, pluginRoot } from './project.mjs';
import { strictSchema, parseResult } from './engine.mjs';

export function codexAdapter(p, { runDir, log, signal, executable = 'codex', baseModel } = {}) {
  const children = new Set();
  let counter = 0;
  let cancelled = false;
  const host = p.config.hosts?.codex || {};
  const mappings = { ...modelDefaults, ...host.models };
  const context = readFileSync(join(pluginRoot, 'runtime/CODEX.md'), 'utf8');
  const terminate = (child) => {
    if (child.exitCode !== null) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
    timer.unref();
  };
  const cancel = async () => {
    cancelled = true;
    await Promise.all([...children].map(child => new Promise(resolve => {
      child.once('close', resolve); terminate(child);
    })));
  };
  signal?.addEventListener('abort', cancel);
  return {
    cancel,
    async agent(prompt, opts = {}) {
      if (signal?.aborted || cancelled) throw new Error('Workflow cancelled');
      const role = persona(p, opts.agentType);
      const requested = opts.model || (role?.meta.model !== 'inherit' ? role?.meta.model : undefined);
      const model = requested ? mappings[requested] || requested : baseModel;
      if (requested && !mappings[requested] && !/^gpt-[\w.-]+$/.test(requested)) throw new Error(`Unmapped Codex model: ${requested}`);
      const cache = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
      if (model && existsSync(cache)) {
        const available = JSON.parse(readFileSync(cache)).models?.map(m => m.slug);
        if (available?.length && !available.includes(model)) throw new Error(`Codex model ${model} is not in this installation's model catalog; refresh model access before running`);
      }
      const effort = opts.effort || host.effort;
      if (effort && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error(`Unsupported effort ${effort}`);
      // Unknown execution controls must not silently lose their semantics.
      const supported = new Set(['label', 'phase', 'agentType', 'schema', 'model', 'effort', 'stallMs']);
      for (const key of Object.keys(opts)) if (!supported.has(key)) throw new Error(`Unsupported agent option: ${key}`);
      const stall = opts.stallMs === undefined ? 180000 : Number(opts.stallMs);
      if (!Number.isFinite(stall) || stall <= 0) throw new Error('Invalid stallMs');
      const id = String(++counter).padStart(4, '0');
      const dir = join(runDir, id); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const output = join(dir, 'result.txt');
      const argv = ['exec', '--json', '--ephemeral', '--cd', p.root, '--output-last-message', output];
      if (role?.readOnly) argv.push('--sandbox', 'read-only', '-c', 'approval_policy="never"');
      else argv.push('--approve-for-me');
      if (model) argv.push('--model', model);
      if (effort) argv.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
      if (opts.schema && strictSchema(opts.schema)) {
        const schemaFile = join(dir, 'schema.json');
        writeFileSync(schemaFile, JSON.stringify(opts.schema), { mode: 0o600 });
        argv.push('--output-schema', schemaFile);
      }
      argv.push('-');
      const fullPrompt = `${context}\n\nWorking checkout: ${p.root}\nMain checkout: ${p.main}\nPlugin root: ${pluginRoot}\nDo not delegate this bounded workflow step again unless its instructions explicitly require it.\n${role ? `\nPERSONA (${role.file}):\n${role.body}\nTool contract: ${JSON.stringify(role.meta.tools || 'inherit')}\n${role.writePaths.length ? `Writable output artifacts ONLY under: ${role.writePaths.join(', ')}. Do not modify other paths.\n` : ''}` : ''}\nTASK:\n${prompt}\n${opts.schema ? `\nReturn ONLY JSON conforming to this schema (no prose or markdown):\n${JSON.stringify(opts.schema)}` : ''}`;
      log('agent_start', { id, label: opts.label, model: model || 'configured', effort, readOnly: !!role?.readOnly });
      let outcome = 'failed';
      try {
        await new Promise((yes, no) => {
          const child = spawn(executable, argv, { cwd: p.root, env: { ...process.env, GHOST_KIT_ROOT: pluginRoot }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
          children.add(child);
          let partial = '', errorTail = '', timedOut = false;
          let timer;
          const reset = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; terminate(child); }, stall); timer.unref(); };
          reset();
          child.stdout.on('data', b => {
            reset(); partial += b.toString();
            const lines = partial.split('\n'); partial = lines.pop();
            for (const line of lines) {
              try { const e = JSON.parse(line); if (e.type === 'thread.started') log('agent_session', { id, thread_id: e.thread_id }); } catch {}
            }
            if (partial.length > 1024 * 1024) partial = ''; // bound malformed output
          });
          child.stderr.on('data', b => { errorTail = (errorTail + b.toString()).slice(-3000); });
          child.stdin.on('error', () => {});
          child.on('error', error => { clearTimeout(timer); children.delete(child); no(error); });
          child.on('close', (code, sig) => {
            clearTimeout(timer); children.delete(child);
            if (signal?.aborted) no(new Error('Workflow cancelled; inspect the working tree before retrying'));
            else if (timedOut) no(new Error(`Agent stalled for ${stall}ms; inspect partial edits before retrying`));
            else if (code !== 0) no(new Error(`Codex child failed (${code ?? sig}); ${/trust|hooks/i.test(errorTail) ? 'review hook trust with /hooks' : 'inspect CLI authentication, model access and permissions'}`));
            else yes();
          });
          child.stdin.end(fullPrompt);
        });
        if (!existsSync(output)) throw new Error('Codex exited without a final response');
        const text = readFileSync(output, 'utf8');
        const result = opts.schema ? parseResult(text, opts.schema) : text;
        outcome = 'complete'; return result;
      } finally { log('agent_end', { id, label: opts.label, status: outcome }); }
    },
  };
}
