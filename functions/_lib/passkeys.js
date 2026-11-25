// Passkeys: sign in with Face ID, Touch ID, a fingerprint or the phone's PIN.
// The phone keeps the private key; only the public key is stored here.
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const CHALLENGE_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 10;
const isLocal = (host) => /^(localhost|127\.0\.0\.1)$/.test(host);

export const PASSKEY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT, name TEXT, created_date TEXT NOT NULL, last_used TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id)`,
  `CREATE TABLE IF NOT EXISTS passkey_challenges (
    challenge TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, expires_date TEXT NOT NULL)`,
];

// The address members use. Links and passkeys always point here.
export function appOrigin(env, url) {
  return env.APP_ORIGIN && !isLocal(url.hostname) ? env.APP_ORIGIN.replace(/\/$/, '') : url.origin;
}

// A passkey only works on the address it was made on, so none are offered on
// any other address. PASSKEY_ORIGINS adds the phone app's origins later.
function relyingParty(env, url) {
  if (isLocal(url.hostname)) return { id: url.hostname, origins: [url.origin] };
  if (!env.APP_ORIGIN) return null;
  const home = new URL(env.APP_ORIGIN);
  if (url.hostname !== home.hostname) return null;
  const extra = String(env.PASSKEY_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { id: home.hostname, origins: [home.origin, ...extra] };
}

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

function deviceName(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  return 'This device';
}

async function saveChallenge(env, challenge, kind, userId) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM passkey_challenges WHERE expires_date < ?').bind(new Date(now).toISOString()),
    env.DB.prepare('INSERT INTO passkey_challenges (challenge, kind, user_id, expires_date) VALUES (?,?,?,?)')
      .bind(challenge, kind, userId, new Date(now + CHALLENGE_MS).toISOString()),
  ]);
}

// Each challenge works once, for the person it was made for.
const takeChallenge = (env, kind, userId) => async (challenge) => {
  const res = await env.DB.prepare(
    'DELETE FROM passkey_challenges WHERE challenge = ? AND kind = ? AND user_id IS ? AND expires_date > ?'
  ).bind(challenge, kind, userId, new Date().toISOString()).run();
  return !!res?.meta?.changes;
};

export const removePasskeys = (env, userId) =>
  env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(userId).run();

// ctx: { currentUser, json, err, audit, issue, notify }
export async function passkeyRoute({ request, env, url, method, step, id }, ctx) {
  const { json, err } = ctx;
  const rp = relyingParty(env, url);
  if (step === 'enabled' && method === 'GET') return json({ enabled: !!rp });
  if (!rp) return err('Face ID sign-in is not available at this address.', 400);

  if (method === 'POST' && step === 'login-options') {
    const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required', allowCredentials: [] });
    await saveChallenge(env, options.challenge, 'login', null);
    return json(options);
  }

  if (method === 'POST' && step === 'login') {
    const { response } = await request.json().catch(() => ({}));
    const bad = () => err("That didn't work. Try again, or use your password.", 401);
    const gone = () => err('This passkey is no longer set up. Sign in with your password.', 401);
    if (!response || typeof response.id !== 'string') return bad();
    const cred = await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(response.id).first();
    if (!cred) return gone();
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(cred.user_id).first();
    if (!row) return gone();
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response, expectedChallenge: takeChallenge(env, 'login', null), expectedOrigin: rp.origins, expectedRPID: rp.id,
        requireUserVerification: true,
        credential: { id: cred.id, publicKey: fromB64(cred.public_key), counter: cred.counter, transports: parse(cred.transports) },
      });
    } catch { result = null; }
    if (!result?.verified) {
      await ctx.audit(env, { actor: row.email, action: 'passkey_failed', request });
      return bad();
    }
    if (JSON.parse(row.data || '{}').disabled) return err('This account is turned off. Contact the gym.', 403);
    await env.DB.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?')
      .bind(result.authenticationInfo.newCounter, new Date().toISOString(), cred.id).run();
    await ctx.audit(env, { actor: row.email, action: 'login', detail: 'passkey', request });
    return json(await ctx.issue(row));
  }

  const user = await ctx.currentUser(request, env);
  if (!user) return err('You must be logged in.', 401);

  if (method === 'GET' && step === 'list') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, created_date, last_used FROM passkeys WHERE user_id = ? ORDER BY created_date'
    ).bind(user.id).all();
    return json({ passkeys: results });
  }

  if (method === 'DELETE' && step === 'list' && id) {
    const res = await env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    if (!res?.meta?.changes) return err('That passkey is already gone.', 404);
    await ctx.audit(env, { actor: user.email, action: 'passkey_removed', target: 'Account', targetId: user.id, request });
    return json({ success: true });
  }

  if (method === 'POST' && step === 'add-options') {
    const { results } = await env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').bind(user.id).all();
    if (results.length >= MAX_PASSKEYS) return err('You have the most devices allowed. Remove one first.', 400);
    const options = await generateRegistrationOptions({
      rpName: 'Brigade Athletic Club', rpID: rp.id, userName: user.email, userDisplayName: user.full_name || user.email,
      userID: new TextEncoder().encode(user.id), attestationType: 'none',
      excludeCredentials: results.map((r) => ({ id: r.id, transports: parse(r.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' },
    });
    await saveChallenge(env, options.challenge, 'add', user.id);
    return json(options);
  }

  if (method === 'POST' && step === 'add') {
    const { response } = await request.json().catch(() => ({}));
    let result;
    try {
      result = await verifyRegistrationResponse({
        response, expectedChallenge: takeChallenge(env, 'add', user.id), expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true,
      });
    } catch { result = null; }
    if (!result?.verified) return err("That didn't work. Try again.", 400);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(user.id).first();
    if ((n?.n || 0) >= MAX_PASSKEYS) return err('You have the most devices allowed. Remove one first.', 400);
    const { credential } = result.registrationInfo;
    const name = deviceName(request.headers.get('user-agent') || '');
    // A credential already on file stays with its owner.
    const ins = await env.DB.prepare(
      'INSERT OR IGNORE INTO passkeys (id, user_id, public_key, counter, transports, name, created_date) VALUES (?,?,?,?,?,?,?)'
    ).bind(credential.id, user.id, toB64(credential.publicKey), credential.counter, JSON.stringify(credential.transports || []), name, new Date().toISOString()).run();
    if (!ins?.meta?.changes) return err('That passkey is already set up.', 409);
    await ctx.audit(env, { actor: user.email, action: 'passkey_added', target: 'Account', targetId: user.id, detail: name, request });
    await ctx.notify(user, name);
    return json({ success: true, name });
  }

  return err('Unknown auth route.', 404);
}
