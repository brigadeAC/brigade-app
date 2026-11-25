// Starts the real API on a throwaway local database. Nothing here can reach
// production: own temp folder, own secrets, no AI binding, no --remote.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const CRON_SECRET = 'test-cron-secret';
export const ADMIN = { email: 'admin@example.test', password: 'admin-pass-1' };

export async function startServer(port = 8799) {
  const dir = mkdtempSync(path.join(tmpdir(), 'brigade-test-'));
  mkdirSync(path.join(dir, 'dist'));
  writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html>');
  for (const n of ['functions', 'node_modules']) symlinkSync(path.join(ROOT, n), path.join(dir, n));
  const flags = /"compatibility_date":\s*"([^"]+)"/.exec(readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'));
  writeFileSync(path.join(dir, 'wrangler.jsonc'), JSON.stringify({
    name: 'brigade-test', compatibility_date: flags[1], compatibility_flags: ['nodejs_compat'], pages_build_output_dir: './dist',
    d1_databases: [{ binding: 'DB', database_name: 'brigade-test', database_id: '00000000-0000-0000-0000-000000000000' }],
  }));
  writeFileSync(path.join(dir, '.dev.vars'), `AUTH_SECRET=test-secret\nADMIN_EMAILS=${ADMIN.email}, second.admin@example.test\nCRON_SECRET=${CRON_SECRET}\n`);
  const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['pages', 'dev', 'dist', '--port', String(port), '--persist-to', path.join(dir, 'state')],
    { cwd: dir, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '' }, detached: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); };
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${base}/api/auth/me`)).status === 401) return { base, stop }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`Test server did not start:\n${log.slice(-2000)}`);
}

export function client(base) {
  const call = async (method, p, body, token, headers = {}) => {
    const res = await fetch(`${base}/api/${p}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const fn = async (name, payload, token) => (await call('POST', `functions/${name}`, payload ?? {}, token)).data;
  const create = async (type, body, token) => (await call('POST', `entities/${type}`, body, token)).data;
  const update = async (type, id, body, token) => call('PUT', `entities/${type}/${id}`, body, token);
  const list = async (type, token) => (await call('GET', `entities/${type}`, undefined, token)).data;
  return { call, fn, create, update, list };
}

// Dates and times in the gym's time zone.
export const eastern = (ms = Date.now()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
export const addDays = (key, n) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const tokenOf = (link) => /#(?:invite|reset)=([\w-]+)$/.exec(link)[1];
