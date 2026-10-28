#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { project } from '../runtime/project.mjs';
import { patchFiles } from '../runtime/hooks.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const p = project(input.cwd || process.cwd());
  const event = input.hook_event_name;
  const tool = input.tool_name;
  const runGuard = (name, payload) => {
    const file = join(p.root, '.claude/hooks', name);
    if (!existsSync(file)) return;
    const result = spawnSync('bash', [file], { cwd: p.root, env: { ...process.env, CLAUDE_PROJECT_DIR: p.root }, input: JSON.stringify(payload), encoding: 'utf8' });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status === null) throw new Error(`Could not execute ${name}`);
    if (result.status !== 0) throw new Error(`${name} blocked this operation`);
  };
  if (event === 'PreToolUse' && tool === 'Bash') runGuard('budget-guard.sh', input);
  if (event === 'PreToolUse' && ['apply_patch', 'Edit', 'Write'].includes(tool)) {
    const files = tool === 'apply_patch' ? patchFiles(input.tool_input.command, p.root) : [input.tool_input];
    for (const file of files) runGuard('content-guard.sh', { ...input, tool_input: file });
  }
  if (event === 'PostToolUse' && tool === 'Bash') runGuard('content-guard-post.sh', input);
  // Execution evidence is local and never contains commands, contents, or credentials.
  const dir = join(p.common, 'ghost-runtime');
  try {
    mkdirSync(dir, { recursive: true });
    const hookFile = join(p.root, '.codex/hooks.json');
    const hash = createHash('sha256').update(readFileSync(hookFile)).digest('hex');
    writeFileSync(join(dir, `hooks-${hash}.json`), JSON.stringify({ event, tool, at: new Date().toISOString() }));
  } catch {} // evidence failure never disables a guard
} catch (error) {
  console.error(`ghost-kit hook: ${error.message}`);
  process.exitCode = 2;
}
