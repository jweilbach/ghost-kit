import { parse } from 'acorn';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
import Ajv from 'ajv';

const ajv = new Ajv({ strict: false, allErrors: true });
export function validateResult(value, schema) {
  if (!schema) return value;
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`Agent output failed schema: ${ajv.errorsText(validate.errors)}`);
  return value;
}
export function parseResult(text, schema) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return validateResult(JSON.parse(fenced ? fenced[1] : trimmed), schema);
}
// Structured Outputs' strict subset cannot represent all existing Claude schemas.
// Only opt in when semantics are identical; always validate the original schema locally.
export function strictSchema(schema) {
  if (!schema || !schema.type || Array.isArray(schema.type)) return false;
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false || !schema.properties) return false;
    const keys = Object.keys(schema.properties);
    if (keys.length !== (schema.required || []).length || keys.some(k => !schema.required.includes(k))) return false;
    return Object.values(schema.properties).every(strictSchema);
  }
  return schema.type !== 'array' || strictSchema(schema.items);
}
export function workflowFile(p, name, { nested = false } = {}) {
  const file = isAbsolute(name) ? name : /[\\/]/.test(name) ? resolve(p.main, name) : join(p.main, '.claude/workflows', `${name.replace(/\.js$/, '')}.js`);
  const rel = relative(p.main, file);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Workflow must be inside the main checkout');
  if (!existsSync(file)) throw new Error(`Missing workflow: ${file}`);
  if (['ghost-lane.js', 'extermination.js'].includes(basename(file))) throw new Error('Deprecated shipping/QA workflows remain Claude-only; use forge-ritual → invoke-ritual → rite-cadence');
  if (nested && basename(file) !== 'harden.js') throw new Error('Only the harden child workflow is supported');
  const text = readFileSync(file, 'utf8');
  const vendored = p.config.workflows?.vendor?.includes(basename(file, '.js'));
  if (vendored) {
    const state = JSON.parse(readFileSync(join(p.main, '.ghost/sync-state.json')));
    const stamp = text.match(/^\/\/ vendored from ghost-kit\/ghost-hunting-core v(\S+) \(bundle (\S+)\)/);
    if (!stamp || stamp[1] !== state.plugin_version || stamp[2] !== state.bundle) throw new Error(`engine_freshness_unverifiable: ${file}; sync the main checkout`);
  }
  return { file, text };
}
export function compileWorkflow(source, { filename = 'workflow.js', root, aliases = [] } = {}) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
  const edits = [];
  for (const node of tree.body) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration' && node.declaration.declarations.length === 1 && node.declaration.declarations[0].id.name === 'meta') {
      edits.push([node.start, node.end, '']);
    } else if (/^(Import|Export)/.test(node.type)) throw new Error('Workflow imports/exports other than meta are unsupported');
  }
  // Preserve a repo's canonical scripts that still carry a legacy absolute ROOT, rebased onto this checkout.
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && typeof node.value === 'string' && aliases.some(a => node.value === a || node.value.startsWith(a + '/'))) {
      const old = aliases.find(a => node.value === a || node.value.startsWith(a + '/'));
      edits.push([node.start, node.end, JSON.stringify(root + node.value.slice(old.length))]);
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'parent') {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  tree.body.filter(n => n.type !== 'ExportNamedDeclaration').forEach(walk);
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + replacement + source.slice(end);
  if (/__CFG_[a-z_]+__/.test(source)) throw new Error('Unrendered workflow tokens');
  return (globals) => {
    const context = vm.createContext({ ...globals });
    return new vm.Script(`(async () => {\n${source}\n})()`, { filename }).runInContext(context, { timeout: 1000 });
  };
}
export function limiter(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error('concurrency must be an integer between 1 and 16');
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const { fn, yes, no } = queue.shift(); active++;
      Promise.resolve().then(fn).then(yes, no).finally(() => { active--; drain(); });
    }
  };
  return fn => new Promise((yes, no) => { queue.push({ fn, yes, no }); drain(); });
}
