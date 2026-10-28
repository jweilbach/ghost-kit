import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// `yaml` is loaded only when frontmatter() runs (persona parsing, Codex setup). Importing this
// module must need NO node_modules: the Claude side (/reckoning -> reckoning-prep/api ->
// project.mjs) runs straight from an auto-updated plugin cache where nobody ran `npm ci`.
const require = createRequire(import.meta.url);
let yamlParse;
const parseYaml = (text) => (yamlParse ||= require('yaml').parse)(text);

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const version = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin/plugin.json'))).version;
export const modelDefaults = { fable: 'gpt-6-astra', opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-terra' };
export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function project(cwd = process.cwd()) {
  const root = git(resolve(cwd), 'rev-parse', '--show-toplevel');
  // worktree list works for linked worktrees and gitfiles, unlike dirname(.git).
  const main = git(root, 'worktree', 'list', '--porcelain').split('\n')[0].slice('worktree '.length);
  const configPath = join(root, '.ghost/config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath)) : {};
  return { root, main, config, common: git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir') };
}
// The per-user key name for a Coven: GHOST_HUNTING_API_KEY__<first 8 hex of org_id, uppercased>.
// `ghost-kit login` writes ONLY this name, so a key can never be read for the wrong Coven.
export function orgKeyName(orgId) {
  const org8 = String(orgId || '').slice(0, 8).toUpperCase();
  return /^[0-9A-F]{8}$/.test(org8) ? `GHOST_HUNTING_API_KEY__${org8}` : '';
}
export function userEnvFile(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'ghost-hunting/.env');
}
function readKey(file, key) {
  if (!key || !existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m?.[1] !== key) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (value) return value;
  }
  return '';
}
// Same lookup order as PHASE0.md and the engine CREDS preambles:
//   1. the env_var environment variable
//   2. this checkout's env_files
//   3. the same git repository's main checkout env_files (only when it names the same env_var)
//   4. ONLY when the config names org_id: the per-user file, by GHOST_HUNTING_API_KEY__<ORG8>
// A config without org_id keeps the legacy ~/.claude/.env (by env_var) as its last resort. The
// per-user file is never read by the bare env_var name: that name cannot say which Coven it is for.
export function credentialSource(p, local = false, env = process.env) {
  if (local && !p.config.api?.allow_local_switch) throw new Error('--local is not configured for this repository');
  const auth = p.config.auth?.[local ? 'local' : 'prod'] || {};
  const key = auth.env_var || 'GHOST_HUNTING_API_KEY';
  if (env[key]) return { value: env[key], source: `env:${key}`, key };
  const roots = [p.root];
  // The main checkout fallback belongs to this git repository and must use the same key.
  if (p.main !== p.root) {
    const mainFile = join(p.main, '.ghost/config.json');
    const mainConfig = existsSync(mainFile) ? JSON.parse(readFileSync(mainFile)) : {};
    if (mainConfig.auth?.[local ? 'local' : 'prod']?.env_var === key) roots.push(p.main);
  }
  const candidates = roots.flatMap(root => (auth.env_files || ['.env']).map(f => [resolve(root, f), key]));
  if (auth.org_id) candidates.push([userEnvFile(env), orgKeyName(auth.org_id)]);
  else candidates.push([join(env.HOME || homedir(), '.claude/.env'), key]);
  for (const [file, name] of candidates) {
    const value = readKey(file, name);
    if (value) return { value, source: file, key: name };
  }
  const hint = auth.org_id ? ` (or ${orgKeyName(auth.org_id)} in ${userEnvFile(env)}: type /ghost-onboard to connect)` : '';
  throw new Error(`Missing ${key}${hint}; provision the configured credential (never another repo's key)`);
}
export function credential(p, local = false, env = process.env) {
  return credentialSource(p, local, env).value;
}
export async function api(p, path, { method = 'GET', body, local = false, skill = 'runtime' } = {}) {
  if (!path.startsWith('/api/agent/')) throw new Error('Only /api/agent/ paths are supported');
  const base = local ? p.config.api?.local_base || 'http://localhost:8000' : p.config.api?.base || 'https://backend-production-ea01.up.railway.app';
  let bundle = '';
  const stamp = join(p.main, '.ghost/sync-state.json');
  if (existsSync(stamp)) bundle = JSON.parse(readFileSync(stamp)).bundle || '';
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${credential(p, local)}`, 'Content-Type': 'application/json',
      'X-Ghost-Client': `plugin/${version} repo/${p.config.repo || 'unknown'} skill/${skill}${bundle ? ` wf/${bundle}` : ''}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Ghost API ${method} ${path}: HTTP ${response.status}`);
  const result = text ? JSON.parse(text) : null;
  if (result?.client_contract?.status === 'unsupported') throw new Error(result.client_contract.message || 'Unsupported ghost-kit version');
  return result;
}
export function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let meta = {};
  if (m) {
    try { meta = parseYaml(m[1]) || {}; }
    catch {
      // Claude accepts unquoted description colons in existing persona files.
      // Normalize only that scalar for parsing; never rewrite the canonical file.
      meta = parseYaml(m[1].replace(/^description: (?!["'|>])(.+)$/m, (_, value) => `description: ${JSON.stringify(value)}`)) || {};
    }
  }
  return { meta, body: m ? text.slice(m[0].length) : text };
}
export function persona(p, name) {
  if (!name || name === 'general-purpose') return null;
  const bare = name.replace(/^ghost-hunting-core:/, '');
  if (!/^[\w-]+$/.test(bare)) throw new Error(`Invalid agent type: ${name}`);
  const candidates = [join(p.root, '.claude/agents', `${bare}.md`), join(pluginRoot, 'agents', `${bare}.md`)];
  const file = candidates.find(existsSync);
  if (!file) throw new Error(`Missing persona ${name}; cannot silently drop a review lens`);
  const data = frontmatter(file);
  const tools = Array.isArray(data.meta.tools) ? data.meta.tools : String(data.meta.tools || '').split(/,\s*/);
  // reckoning-leaf writes ONLY its own artifacts into the reckoning bus inside the pinned tree.
  const writePaths = p.config.hosts?.codex?.persona_write_paths?.[bare] || (bare === 'reckoning-leaf' ? ['.reckoning'] : []);
  return { ...data, file: realpathSync(file), writePaths, readOnly: !writePaths.length && tools.length > 0 && tools[0] !== '' && !tools.some(t => /^(Write|Edit|NotebookEdit)$/.test(t)) };
}
