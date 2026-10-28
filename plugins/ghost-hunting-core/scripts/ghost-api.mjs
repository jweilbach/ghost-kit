#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { api, project } from '../runtime/project.mjs';
try {
  const args = process.argv.slice(2);
  const local = args.includes('--local');
  const a = args.filter(v => v !== '--local');
  const [method, path, bodyFile] = a;
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method) || !path) throw new Error('Usage: ghost-api.mjs METHOD /api/agent/path [body.json] [--local]');
  console.log(JSON.stringify(await api(project(), path, { method, local, body: bodyFile ? JSON.parse(readFileSync(bodyFile)) : undefined }), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
