#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { project, pluginRoot, api, version } from '../runtime/project.mjs';
import { setup } from './ghost-setup.mjs';
import { compileWorkflow, workflowFile } from '../runtime/engine.mjs';

export async function doctor(p, { host = 'codex', online = false } = {}) {
  const checks = [];
  const add = (capability, status, message) => checks.push({ capability, status, message });
  const original = spawnSync('bash', [join(pluginRoot, 'scripts/ghost-doctor.sh'), '--repo-root', p.root, '--json'], { encoding: 'utf8' });
  let base;
  try { base = JSON.parse(original.stdout); } catch { add('repo-config', 'BLOCKED', 'Existing doctor could not read repo configuration'); }
  for (const [cap, status] of Object.entries(base?.capabilities || {})) add(cap, status, base.findings?.filter(f => f.capability === cap || f.capability === 'version').map(f => f.message).join('; ') || 'Repository prerequisites');
  if (host === 'codex') {
    // Use the CLI's actual enabled installation, not the source manifest alone.
    const installed = spawnSync('codex', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 10000 });
    try {
      const entry = JSON.parse(installed.stdout).installed?.find(x => x.pluginId === 'ghost-hunting-core@ghost-kit' && x.installed && x.enabled);
      if (!entry) throw new Error('Install and enable ghost-hunting-core@ghost-kit');
      if (entry.version.split('+')[0] !== version) throw new Error(`Installed ${entry.version}; source is ${version}. Reinstall, then start a new session`);
      const cache = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins/cache/ghost-kit/ghost-hunting-core', entry.version);
      const skillFiles = readdirSync(join(pluginRoot, 'skills')).map(n => `skills/${n}/SKILL.md`);
      const stale = skillFiles.some(f => !existsSync(join(cache, f)) || !readFileSync(join(cache, f)).equals(readFileSync(join(pluginRoot, f))));
      add('plugin-install', stale ? 'BLOCKED' : 'READY', stale ? 'Installed skill cache differs from source; refresh the Codex cachebuster, reinstall, then start a new session' : `Enabled ${entry.version}; installed skill contents match source. Restarted-session discovery is checked separately`);
    } catch (error) { add('plugin-install', 'BLOCKED', installed.error ? 'Could not inspect Codex installation; check CLI availability' : error.message); }
    try {
      const diff = setup(p);
      add('discovery', diff.changes.length ? 'BLOCKED' : 'READY', diff.changes.length ? `Run ghost-setup.sh --repo ${p.root} --write (${diff.changes.length} generated artifacts differ)` : 'Generated instructions, skills and personas match their sources');
    } catch (error) { add('discovery', 'BLOCKED', error.message); }
    const workflows = join(p.main, '.claude/workflows');
    const names = existsSync(workflows) ? readdirSync(workflows).filter(n => n.endsWith('.js') && !['ghost-lane.js', 'extermination.js'].includes(n)) : [];
    for (const name of names) {
      try {
        const src = workflowFile(p, name);
        compileWorkflow(src.text, { filename: src.file, root: p.root, aliases: p.config.hosts?.codex?.path_aliases || [] });
        add(`workflow:${name}`, 'READY', 'Syntax and engine stamp verified; live acceptance is reported separately');
      } catch (error) { add(`workflow:${name}`, 'BLOCKED', error.message); }
    }
    if (existsSync(join(p.root, '.claude/skills/make-script/make-script.workflow.js'))) {
      try { compileWorkflow(readFileSync(join(p.root, '.claude/skills/make-script/make-script.workflow.js'), 'utf8')); add('workflow:make-script', 'READY', 'Syntax verified; paid generation not exercised'); }
      catch (error) { add('workflow:make-script', 'BLOCKED', error.message); }
    }
    const hooks = join(p.root, '.codex/hooks.json');
    if (existsSync(hooks) && existsSync(join(p.root, '.claude/hooks/content-guard.sh'))) {
      const hash = createHash('sha256').update(readFileSync(hooks)).digest('hex');
      const evidence = existsSync(join(p.common, 'ghost-runtime', `hooks-${hash}.json`));
      add('content-guards', evidence ? 'DEGRADED' : 'BLOCKED', evidence ? 'Hook execution observed; verify /hooks trust in this CLI session before generation' : 'Review /hooks and exercise guards before paid generation or publishing');
    }
    add('browser', p.config.browser?.tool === 'none' ? 'n/a' : 'DEGRADED', 'Session capability required: native browser for interactive work; retain Playwright for isolated E2E and any repo whose capture work requires it');
    add('legacy-shipping', 'n/a', 'Deprecated ghost-lane/extermination shipping remains Claude-only');
  }
  if (online) {
    try { const me = await api(p, '/api/agent/me', { skill: 'doctor' }); add('online-identity', 'READY', `${me.name} — coven ${me.org_id}; contract ${me.client_contract?.status || 'unknown'}`); }
    catch (error) { add('online-identity', 'BLOCKED', error.message); }
  }
  return { repo: p.root, host, plugin_version: version, checks };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { repo: { type: 'string', multiple: true }, host: { type: 'string', default: 'codex' }, online: { type: 'boolean' }, json: { type: 'boolean' }, check: { type: 'boolean' } } });
    if (!['codex', 'claude', 'both'].includes(values.host)) throw new Error('--host must be codex, claude or both');
    const results = [];
    for (const repo of values.repo || [process.cwd()]) for (const host of values.host === 'both' ? ['claude', 'codex'] : [values.host]) results.push(await doctor(project(repo), { host, online: values.online }));
    if (values.json) console.log(JSON.stringify(results, null, 2));
    else for (const result of results) {
      const checks = values.check ? result.checks.filter(c => c.status === 'BLOCKED') : result.checks;
      if (!checks.length) continue;
      console.log(`${result.repo} [${result.host}] ghost-kit ${version}`);
      for (const c of checks) console.log(`  ${c.status.padEnd(8)} ${c.capability}: ${c.message}`);
    }
    if (results.some(r => r.checks.some(c => c.status === 'BLOCKED'))) process.exitCode = 3;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
