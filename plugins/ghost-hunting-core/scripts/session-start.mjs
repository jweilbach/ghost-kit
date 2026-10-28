#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { project } from '../runtime/project.mjs';
import { doctor } from './host-doctor.mjs';
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const result = await doctor(project(input.cwd || process.cwd()));
  const blocked = result.checks.filter(c => c.status === 'BLOCKED');
  if (blocked.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Ghost-kit readiness: ' + blocked.map(c => `${c.capability}: ${c.message}`).join('; ') } }));
} catch (error) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Ghost-kit readiness could not be checked: ${error.message}` } }));
}
