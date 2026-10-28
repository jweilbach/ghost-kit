// reckoning-api.mjs — the Ghost Hunting client the /reckoning scripts share.
//
// Two properties the runtime's generic api() helper does not give, and a reckoning needs:
//   * it RETRIES 429 and 5xx with backoff (honouring Retry-After) — a snapshot of a large Coven
//     fans out thousands of GETs against a 1000/min agent limit, and a throttled call must be
//     retried, not read as "this ghost has no EVPs";
//   * it RETURNS status + body instead of throwing them away — apply needs a 400's
//     failing_indexes and a 403's error_code.
// The key is read with the runtime's credential() and never printed.
import { project, credential, version } from '../runtime/project.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function reckoningClient({ cwd = process.cwd(), local = false, skill = 'reckoning', attempts = 6 } = {}) {
  const p = project(cwd);
  const base = local ? p.config.api?.local_base || 'http://localhost:8000' : p.config.api?.base || 'https://backend-production-ea01.up.railway.app';
  const key = credential(p, local);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Ghost-Client': `plugin/${version} repo/${p.config.repo || 'unknown'} skill/${skill}` };
  const req = async (method, path, body) => {
    if (!path.startsWith('/api/agent/')) throw new Error('Only /api/agent/ paths are supported');
    let last = null;
    for (let i = 0; i < attempts; i++) {
      let r;
      try {
        r = await fetch(base + path, { method, headers, signal: AbortSignal.timeout(60000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (e) {
        last = { status: 0, ok: false, body: { error: String(e.message || e) } };
        await sleep(Math.min(30000, 1000 * 2 ** i));
        continue;
      }
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
      last = { status: r.status, ok: r.ok, body: json };
      if (r.status !== 429 && r.status < 500) return last;
      const ra = Number(r.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(90, ra) * 1000 : Math.min(30000, 1000 * 2 ** i));
    }
    return last;
  };
  // A GET that must succeed: a failure is recorded, never silently read as an empty result.
  const errors = [];
  const must = async (path, fallback) => {
    const r = await req('GET', path);
    if (r && r.ok) return r.body;
    errors.push(`GET ${path.split('?')[0]} → HTTP ${r ? r.status : '?'}${r?.body?.detail?.error_code ? ` ${r.body.detail.error_code}` : ''}`);
    return fallback;
  };
  return { p, base, req, must, errors };
}
