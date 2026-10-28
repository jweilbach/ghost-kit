#!/usr/bin/env node
// Keep existing private .mcp.json credentials/paths out of tracked Codex config.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as types from '@modelcontextprotocol/sdk/types.js';
import { project, version } from '../runtime/project.mjs';

try {
  const p = project(); const name = process.argv[2];
  const file = [join(p.root, '.mcp.json'), join(p.main, '.mcp.json')].find(existsSync);
  if (!file) throw new Error('Provision the repo MCP configuration before connecting');
  const spec = JSON.parse(readFileSync(file)).mcpServers?.[name];
  if (!spec) throw new Error(`MCP server ${name} is not configured`);
  const interpolate = value => String(value).replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key) => {
    if (key === 'CLAUDE_PROJECT_DIR') return p.root;
    if (!process.env[key]) throw new Error(`Missing MCP environment variable ${key}`);
    return process.env[key];
  });
  const client = new Client({ name: 'ghost-kit-bridge', version });
  const transport = spec.url
    ? new StreamableHTTPClientTransport(new URL(interpolate(spec.url)), { requestInit: { headers: Object.fromEntries(Object.entries(spec.headers || {}).map(([k, v]) => [k, interpolate(v)])) } })
    : new StdioClientTransport({ command: interpolate(spec.command), args: (spec.args || []).map(interpolate), cwd: p.root, env: { ...process.env, ...Object.fromEntries(Object.entries(spec.env || {}).map(([k, v]) => [k, interpolate(v)])) }, stderr: 'inherit' });
  await client.connect(transport);
  const upstream = client.getServerCapabilities() || {};
  const capabilities = Object.fromEntries(['tools', 'resources', 'prompts', 'completions'].filter(k => upstream[k]).map(k => [k, {}]));
  const server = new Server({ name: `ghost-kit-${name}`, version }, { capabilities });
  for (const [cap, request, result] of [
    ['tools', 'ListToolsRequestSchema', 'ListToolsResultSchema'],
    ['tools', 'CallToolRequestSchema', 'CallToolResultSchema'],
    ['resources', 'ListResourcesRequestSchema', 'ListResourcesResultSchema'],
    ['resources', 'ListResourceTemplatesRequestSchema', 'ListResourceTemplatesResultSchema'],
    ['resources', 'ReadResourceRequestSchema', 'ReadResourceResultSchema'],
    ['prompts', 'ListPromptsRequestSchema', 'ListPromptsResultSchema'],
    ['prompts', 'GetPromptRequestSchema', 'GetPromptResultSchema'],
    ['completions', 'CompleteRequestSchema', 'CompleteResultSchema'],
  ]) if (capabilities[cap]) server.setRequestHandler(types[request], (req, extra) => client.request(req, types[result], { signal: extra.signal }));
  const close = async () => { await client.close(); await server.close(); };
  process.once('SIGTERM', close); process.once('SIGINT', close); process.stdin.once('end', close);
  await server.connect(new StdioServerTransport());
} catch (error) {
  // Transport exceptions can contain private URLs; never echo remote bodies/headers.
  console.error(error.message?.startsWith('Missing MCP environment variable ') ? error.message : `ghost-kit MCP bridge failed (${error.name}); check the configured server, credentials and connectivity.`);
  process.exitCode = 1;
}
