#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, symlinkSync, readlinkSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import TOML from '@iarna/toml';
import { project, pluginRoot, frontmatter, persona, modelDefaults, version } from '../runtime/project.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const begin = '# BEGIN ghost-kit managed host instructions';
const end = '# END ghost-kit managed host instructions';
const instructionBlock = new RegExp(`${begin}\\n[\\s\\S]*?${end}\\n?`, 'g');
const mcpBegin = '# BEGIN ghost-kit managed MCP';
const mcpEnd = '# END ghost-kit managed MCP';
const mcpBlock = new RegExp(`${mcpBegin}\\n[\\s\\S]*?${mcpEnd}\\n?`, 'g');
const quote = JSON.stringify;

export function setup(p, { write = false } = {}) {
  const changes = [], files = {}, sources = {};
  const stateFile = join(p.root, '.ghost/codex-state.json');
  const prior = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile)) : { files: {} };
  const put = (rel, text, { executable = false, merge = false } = {}) => {
    const file = join(p.root, rel);
    const old = existsSync(file) ? readFileSync(file, 'utf8') : null;
    files[rel] = hash(text);
    if (old === text) return;
    if (old !== null && !merge && prior.files?.[rel] !== hash(old)) throw new Error(`Refusing to overwrite unmanaged or edited ${rel}`);
    changes.push(rel);
    if (write) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); if (executable) chmodSync(file, 0o755); }
  };
  const source = (file, key) => { const text = readFileSync(file, 'utf8'); sources[key] = hash(text); return text; };
  const skills = readdirSync(join(pluginRoot, 'skills'));
  const localDir = join(p.root, '.claude/skills');
  if (existsSync(localDir)) for (const name of readdirSync(localDir)) {
    const canonical = join(localDir, name);
    if (!existsSync(join(canonical, 'SKILL.md'))) continue;
    source(join(canonical, 'SKILL.md'), `.claude/skills/${name}/SKILL.md`);
    if (skills.includes(name)) {
      const alias = `${p.config.repo.toLowerCase()}-${name}`;
      const { meta } = frontmatter(join(canonical, 'SKILL.md'));
      put(`.agents/skills/${alias}/SKILL.md`, `---\nname: ${alias}\ndescription: ${quote(meta.description || `Run ${name} for ${p.config.repo}`)}\n---\n\nRead and execute the canonical repo skill at \`.claude/skills/${name}/SKILL.md\` with the user's invocation input. Apply the Codex host substitutions in project guidance. This is ${p.config.repo}'s domain skill, separate from the Ghost Hunting skill named ${name}.\n`);
    } else {
      const dest = join(p.root, '.agents/skills', name), target = relative(dirname(dest), canonical);
      if (existsSync(dest) || (() => { try { return lstatSync(dest).isSymbolicLink(); } catch { return false; } })()) {
        // Some repos already own their .agents skills and link Claude TO them.
        if (!lstatSync(dest).isSymbolicLink()) continue;
        if (readlinkSync(dest) === target) continue;
        throw new Error(`Existing skill link has a different target: ${dest}`);
      }
      changes.push(`.agents/skills/${name} -> ${target}`);
      if (write) { mkdirSync(dirname(dest), { recursive: true }); symlinkSync(target, dest); }
    }
  }
  // Only remove the known pilot links into this exact canonical plugin tree.
  for (const name of skills) {
    const dest = join(p.root, '.agents/skills', name);
    try {
      if (lstatSync(dest).isSymbolicLink() && resolve(dirname(dest), readlinkSync(dest)) === join(p.root, 'plugins/ghost-hunting-core/skills', name)) {
        changes.push(`remove duplicate pilot skill ${name}`); if (write) unlinkSync(dest);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const hostText = source(join(pluginRoot, 'runtime/CODEX.md'), 'plugin:runtime/CODEX.md');
  const configFile = join(p.root, '.codex/config.toml');
  let configText = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
  configText = configText.replace(instructionBlock, '').replace(mcpBlock, '');
  const existing = TOML.parse(configText);
  const roots = [];
  if (!existing.project_doc_fallback_filenames) roots.push('project_doc_fallback_filenames = ["CLAUDE.md"]');
  else if (!existing.project_doc_fallback_filenames.includes('CLAUDE.md')) throw new Error('Existing fallback configuration omits CLAUDE.md; merge deliberately');
  if (!existing.project_doc_max_bytes) roots.push('project_doc_max_bytes = 65536');
  if (existing.developer_instructions) throw new Error('Existing developer_instructions must be merged explicitly before bootstrap');
  roots.push(`developer_instructions = ${quote(hostText)}`);
  configText = `${begin}\n${roots.join('\n')}\n${end}\n${configText.trim()}\n`;

  const names = new Set(readdirSync(join(pluginRoot, 'agents')).filter(n => n.endsWith('.md')).map(n => basename(n, '.md')));
  const agentDir = join(p.root, '.claude/agents');
  if (existsSync(agentDir)) for (const f of readdirSync(agentDir)) if (f.endsWith('.md')) names.add(basename(f, '.md'));
  for (const name of names) {
    const role = persona(p, name);
    source(role.file, role.file.startsWith(p.root + '/') ? relative(p.root, role.file) : `plugin:agents/${name}.md`);
    const model = role.meta.model && role.meta.model !== 'inherit' ? (p.config.hosts?.codex?.models?.[role.meta.model] || modelDefaults[role.meta.model] || role.meta.model) : null;
    const content = `# Generated by ghost-kit; edit the canonical persona and rerun setup.\nname = ${quote(name)}\ndescription = ${quote(role.meta.description || name)}\n${model ? `model = ${quote(model)}\n` : ''}${role.readOnly ? 'sandbox_mode = "read-only"\n' : ''}developer_instructions = ${quote(`${hostText}\n\n${role.body}\nCanonical tool contract: ${JSON.stringify(role.meta.tools || 'inherit')}\n${role.writePaths.length ? `Only writable output paths: ${role.writePaths.join(', ')}` : ''}`)}\n`;
    put(`.codex/agents/${name}.toml`, content);
  }
  const shim = source(join(pluginRoot, 'scripts/resolve-plugin.sh'), 'plugin:scripts/resolve-plugin.sh');
  put('.ghost/bin/resolve-plugin', shim, { executable: true });
  for (const [name, script] of Object.entries({ 'run-workflow': 'run-workflow.mjs', 'ghost-api': 'ghost-api.mjs', 'host-hook': 'host-hook.mjs', 'ghost-doctor': 'host-doctor.mjs', 'mcp-bridge': 'mcp-bridge.mjs', 'session-start': 'session-start.mjs' })) {
    put(`.ghost/bin/${name}`, `#!/usr/bin/env bash\n# Generated by ghost-kit; stable, relocation-safe launcher.\nset -euo pipefail\nDIR=$(cd "$(dirname "$0")" && pwd)\nGK_ROOT=$(bash "$DIR/resolve-plugin")\nexport GHOST_KIT_ROOT="$GK_ROOT"\nexec node "$GK_ROOT/scripts/${script}" "$@"\n`, { executable: true });
  }
  // Match the bridge's same-repository fallback for ignored private worktree config.
  const mcpPath = [join(p.root, '.mcp.json'), join(p.main, '.mcp.json')].find(existsSync);
  const mcp = mcpPath ? JSON.parse(readFileSync(mcpPath)).mcpServers || {} : {};
  const mcps = [];
  for (const [name, spec] of Object.entries(mcp)) {
    if (existing.mcp_servers?.[name]) continue;
    const envVars = [...new Set([...JSON.stringify(spec).matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map(m => m[1]))].filter(n => n !== 'CLAUDE_PROJECT_DIR').sort();
    if (spec.url && !Object.keys(spec.headers || {}).length && !envVars.length) {
      mcps.push(`[mcp_servers.${quote(name)}]\nurl = ${quote(spec.url)}`);
    } else {
      // Do not copy tokens or machine paths out of the existing gitignored MCP file.
      mcps.push(`[mcp_servers.${quote(name)}]\ncommand = "bash"\nargs = ["-c", ${quote(`exec bash "$(git rev-parse --show-toplevel)/.ghost/bin/mcp-bridge" ${quote(name)}`)}]\n${envVars.length ? `env_vars = ${JSON.stringify(envVars)}\n` : ''}startup_timeout_sec = 30`);
    }
  }
  if (mcps.length) configText += `\n${mcpBegin}\n${mcps.join('\n\n')}\n${mcpEnd}\n`;
  TOML.parse(configText); put('.codex/config.toml', configText, { merge: true });

  {
    const file = join(p.root, '.codex/hooks.json');
    const hooks = existsSync(file) ? JSON.parse(readFileSync(file)) : { hooks: {} };
    hooks.hooks ||= {};
    const startup = 'bash "$(git rev-parse --show-toplevel)/.ghost/bin/session-start"';
    hooks.hooks.SessionStart = (hooks.hooks.SessionStart || []).filter(group => !group.hooks?.some(h => h.command === startup));
    hooks.hooks.SessionStart.push({ matcher: 'startup|resume', hooks: [{ type: 'command', command: startup, timeout: 30 }] });
    const command = 'bash "$(git rev-parse --show-toplevel)/.ghost/bin/host-hook"';
    for (const [event, matcher] of existsSync(join(p.root, '.claude/hooks/content-guard.sh')) ? [['PreToolUse', 'Bash|apply_patch|Edit|Write'], ['PostToolUse', 'Bash']] : []) {
      hooks.hooks[event] = (hooks.hooks[event] || []).filter(group => !group.hooks?.some(h => h.command === command));
      hooks.hooks[event].push({ matcher, hooks: [{ type: 'command', command, timeout: 30 }] });
    }
    put('.codex/hooks.json', JSON.stringify(hooks, null, 2) + '\n', { merge: true });
  }
  const cfg = structuredClone(p.config);
  cfg.hosts ||= {}; cfg.hosts.codex ||= {};
  cfg.hosts.codex.models = { ...modelDefaults, ...cfg.hosts.codex.models };
  cfg.hosts.codex.concurrency ??= 4;
  cfg.hosts.codex.browser ??= 'native';
  const aliases = new Set(cfg.hosts.codex.path_aliases || []);
  const workflows = join(p.root, '.claude/workflows');
  if (existsSync(workflows)) for (const f of readdirSync(workflows).filter(n => n.endsWith('.js'))) {
    const s = readFileSync(join(workflows, f), 'utf8');
    const m = s.match(/\bROOT\s*=\s*['"]([^'"]+)['"]/);
    if (m && m[1].startsWith('/') && basename(m[1]).toLowerCase() === cfg.repo.toLowerCase()) aliases.add(m[1]);
  }
  if (aliases.size) cfg.hosts.codex.path_aliases = [...aliases];
  put('.ghost/config.json', JSON.stringify(cfg, null, 2) + '\n', { merge: true });
  // Lock is runtime state, never a committed artifact; append without replacing existing ignore rules.
  const ignore = join(p.root, '.gitignore'); const oldIgnore = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  put('.gitignore', oldIgnore.split('\n').includes('.ghost/codex-workflow.lock') ? oldIgnore : oldIgnore.replace(/\n?$/, '\n') + '.ghost/codex-workflow.lock\n', { merge: true });
  const state = JSON.stringify({ version, files, sources }, null, 2) + '\n';
  if (!existsSync(stateFile) || readFileSync(stateFile, 'utf8') !== state) {
    changes.push('.ghost/codex-state.json');
    if (write) { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, state); }
  }
  return { repo: p.root, mode: write ? 'write' : 'inspect', changes };
}

export function install() {
  const root = resolve(pluginRoot, '../..');
  for (const args of [['plugin', 'marketplace', 'add', root], ['plugin', 'add', 'ghost-hunting-core@ghost-kit']]) {
    const result = spawnSync('codex', args, { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Codex plugin installation failed');
  }
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ghost-hunting');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ plugin_root: pluginRoot, version }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { repo: { type: 'string', multiple: true }, write: { type: 'boolean' }, install: { type: 'boolean' } } });
    if (values.install) install();
    const repos = (values.repo || [process.cwd()]).map(repo => project(repo));
    // Validate every target before applying any changes to the fleet.
    const previews = repos.map(p => setup(p));
    for (let i = 0; i < repos.length; i++) console.log(JSON.stringify(values.write ? setup(repos[i], { write: true }) : previews[i], null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
