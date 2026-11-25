import Anthropic from "@anthropic-ai/sdk";
import { PASSKEY_SCHEMA, appOrigin, passkeyRoute, removePasskeys } from "../_lib/passkeys.js";
// Brigade Athletic Club backend — single Cloudflare Pages Function handling all /api/* routes.
// Bindings (wrangler.jsonc / Pages dashboard):
//   env.DB          D1 database
//   env.FILES       R2 bucket (optional; uploads fall back to data URLs if absent)
//   env.AUTH_SECRET string used to sign JWTs
//   env.PUBLIC_R2_URL  optional public base URL for the R2 bucket
//   env.LLM_API_KEY / env.LLM_MODEL  optional Anthropic key to enable InvokeLLM

const enc = new TextEncoder();

/* ------------------------------- helpers -------------------------------- */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const err = (message, status = 400, extra = {}) =>
  json({ message, detail: message, error_type: 'HTTPException', ...extra }, status);

const nowISO = () => new Date().toISOString();

function uid() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

const b64url = (bytes) => {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlToBytes = (str) => {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4 ? 4 - (str.length % 4) : 0;
  const bin = atob(str + '='.repeat(pad));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/* ------------------------------- auth ----------------------------------- */

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(bits)}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'pbkdf2') return false;
    const salt = b64urlToBytes(saltB64);
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: Number(iterStr), hash: 'SHA-256' },
      key,
      256
    );
    return b64url(bits) === hashB64;
  } catch {
    return false;
  }
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function signToken(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 };
  const p1 = b64url(enc.encode(JSON.stringify(header)));
  const p2 = b64url(enc.encode(JSON.stringify(body)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${p1}.${p2}`));
  return `${p1}.${p2}.${b64url(sig)}`;
}

async function verifyToken(token, secret) {
  try {
    const [p1, p2, sig] = token.split('.');
    if (!p1 || !p2 || !sig) return null;
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(`${p1}.${p2}`));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p2)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function userRow(row) {
  if (!row) return null;
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    user_type: row.user_type,
    created_date: row.created_date,
    updated_date: row.updated_date,
    ...data,
  };
}

// Exactly the emails listed in ADMIN_EMAILS are admins (comma-separated env var).
// Checked on every request so promotions/demotions apply without re-registering.
function resolveRole(env, email, storedRole) {
  const admins = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (admins.length > 0) return admins.includes(email.toLowerCase()) ? 'admin' : (storedRole === 'admin' ? 'user' : storedRole);
  return storedRole; // no allowlist configured — fall back to stored role
}

async function currentUser(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const payload = await verifyToken(token, env.AUTH_SECRET || 'dev-insecure-secret');
  if (!payload) return null;
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.sub).first();
  const u = userRow(row);
  if (!u || u.disabled) return null;
  // A password change or reset signs out every session issued before it.
  if (u.sessions_valid_from && (payload.iat || 0) < u.sessions_valid_from) return null;
  u.role = resolveRole(env, u.email, u.role);
  return u;
}

/* ---------------------------- account links ------------------------------ */
// One-time links for joining (invite) and resetting a password (reset). Only a
// hash of the token is stored, in its own table, so no entity route can read it.
const INVITE_HOURS = 14 * 24;
const STAFF_RESET_HOURS = 24;
const EMAIL_RESET_HOURS = 1;
const BAD_LINK = 'This link has expired or was already used. Ask for a new one.';

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The token goes in the URL fragment, which browsers never send to servers.
async function createAccountLink(env, url, { kind, email, user_type = null, client_id = null, full_name = '', created_by = null, hours }) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const addr = email.trim().toLowerCase();
  await env.DB.batch([
    // A new link replaces any earlier unused one.
    env.DB.prepare('DELETE FROM account_tokens WHERE kind = ? AND email = ? AND used_date IS NULL').bind(kind, addr),
    env.DB.prepare(
      'INSERT INTO account_tokens (token_hash, kind, email, user_type, client_id, full_name, created_by, created_date, expires_date) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(await sha256Hex(token), kind, addr, user_type, client_id, full_name || '', created_by, nowISO(), new Date(Date.now() + hours * 3600000).toISOString()),
  ]);
  return `${appOrigin(env, url)}/Login#${kind}=${token}`;
}

async function findAccountLink(env, token, kind) {
  if (!token || typeof token !== 'string') return null;
  const row = await env.DB.prepare(
    'SELECT * FROM account_tokens WHERE token_hash = ? AND used_date IS NULL AND expires_date > ?'
  ).bind(await sha256Hex(token), nowISO()).first();
  return row && (!kind || row.kind === kind) ? row : null;
}

// Claims the link; false if someone else just used it.
async function useAccountLink(env, row) {
  const res = await env.DB.prepare(
    'UPDATE account_tokens SET used_date = ? WHERE token_hash = ? AND used_date IS NULL AND expires_date > ?'
  ).bind(nowISO(), row.token_hash, nowISO()).run();
  return !!res?.meta?.changes;
}

async function setPassword(env, userId, password) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  const data = JSON.parse(row.data || '{}');
  data.sessions_valid_from = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE users SET password_hash = ?, data = ?, updated_date = ? WHERE id = ?')
    .bind(await hashPassword(password), JSON.stringify(data), nowISO(), userId).run();
  await env.DB.prepare(`DELETE FROM account_tokens WHERE kind = 'reset' AND email = ? AND used_date IS NULL`).bind(row.email).run();
}

const passwordProblem = (pw) => {
  const v = String(pw || '');
  if (v.length < 8) return 'Password must be at least 8 characters.';
  if (v.length > 200) return 'Password is too long.';
  return null;
};

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function emailAccountLink(env, { kind, to, name, link }) {
  const invite = kind === 'invite';
  return sendEmail(env, {
    to,
    subject: invite ? 'Join the Brigade Athletic Club app' : 'Reset your Brigade password',
    html: emailShell(invite ? 'You\'re invited.' : 'Reset your password', `
      <p>Hi ${escHtml(name || 'there')},</p>
      <p>${invite ? 'Create your Brigade account to book classes, follow your program and message your coach.' : 'Use this link to choose a new password.'}</p>
      <p style="margin:24px 0"><a href="${escHtml(link)}" style="background:#4B91DD;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">${invite ? 'Create your account' : 'Choose a new password'}</a></p>
      <p>This link works once and expires in ${invite ? '14 days' : `${EMAIL_RESET_HOURS} hour`}. If you didn't expect it, you can ignore this email.</p>`),
  });
}

/* ------------------------------ entities -------------------------------- */

function rowToEntity(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    ...data,
    id: row.id,
    created_by: row.created_by,
    created_date: row.created_date,
    updated_date: row.updated_date,
  };
}

const COLUMN_FIELDS = new Set(['id', 'created_by', 'created_date', 'updated_date']);

function fieldExpr(field) {
  if (COLUMN_FIELDS.has(field)) return field;
  return `json_extract(data, '$.${field.replace(/'/g, "''")}')`;
}

// Entity types every authenticated user of the app may read (shared/global content).
// Readable by every signed-in user. WaitingList is deliberately
// NOT here: the waiting list holds
// prospects' emails, so it is admin-only.
const SHARED_TYPES = new Set([
  'CommunityPost', 'TrainerCommunityPost', 'Recipe',
  'FitnessTemplate', 'MealPlanTemplate', 'CoachingExercise',
]);

// On shared rows anyone can read, only the author or an admin may change or
// delete them. Others may only react to community posts (likes, comments).
const REACTION_FIELDS = new Set(['likes', 'comments']);
function sharedWriteDenied(type, row, user, fields = null) {
  if (!SHARED_TYPES.has(type) || user.role === 'admin') return false;
  if (row.created_by === user.email || row.created_by === user.id) return false;
  if (fields && (type === 'CommunityPost' || type === 'TrainerCommunityPost')) {
    return !Object.keys(fields).every((k) => REACTION_FIELDS.has(k));
  }
  return true;
}

// Entity types that carry protected health information. Reads of these are
// written to the audit trail (HIPAA §164.312(b) — record access to ePHI).
const PHI_TYPES = new Set([
  'Client', 'ClientNote', 'ProgressLog', 'JournalEntry', 'SleepLog', 'StressLog',
  'Contract', 'FormCheck', 'ReadinessLog', 'HealthMetric', 'ClientNotebookPage',
]);

// Resources (files, forms, guides) are trainer→client content: a user sees
// their own resources plus everything shared by their own trainer — never
// other trainers' material. Returns extra OR-terms for ownershipClause.
// Members see gym resources (anything staff created) that are shared with
// everyone, or with one of their own client ids / their login. Resources are
// gym records, not tied to whichever coach uploaded them.
async function memberResourceTerm(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM entities WHERE entity_type='Client' AND (json_extract(data,'$.email') = ? OR json_extract(data,'$.user_id') = ?)`
  ).bind(user.email, user.id).all();
  const ids = [user.id, ...results.map((r) => r.id)];
  return {
    sql: `(json_extract(data,'$.trainer_id') IS NOT NULL AND (COALESCE(json_array_length(data,'$.shared_with'),0) = 0 OR EXISTS (SELECT 1 FROM json_each(data,'$.shared_with') WHERE value IN (${ids.map(() => '?').join(',')}))))`,
    binds: ids,
  };
}

// Staff (trainers and admins) work for the gym: they all see the same clients,
// plans, templates and business records. Only these stay private per person.
// Gym libraries everyone can read but only staff can change.
const STAFF_LIBRARY_TYPES = new Set(['HabitTemplate', 'Lesson', 'Program', 'ProgramItem',
  'ClassType', 'ClassSlot', 'ClassSession', 'MembershipPlan', 'GymSettings']);
// Client records only staff (or the system) may write. Members still read
// their own rows through the normal ownership scope (client_id/client_user_id).
// Reservation/Membership: members book only through the class functions.
const STAFF_WRITE_TYPES = new Set(['ProgramEnrollment', 'ProgramMessageLog', 'Reservation', 'Membership']);
// Class entities whose staff writes trigger session/count upkeep (afterClassEntityWrite).
const CLASS_HOOK_TYPES = new Set(['ClassSlot', 'ClassType', 'ClassSession', 'Reservation']);
// Member-writable program records; enrollment_id must point at their own enrollment.
const MEMBER_PROGRAM_RECORD_TYPES = new Set(['LessonCompletion', 'CheckinResponse']);
const STAFF_PRIVATE_TYPES = new Set(['Message', 'Notification', 'CoachBriefing', 'AgentConversation']);
const isStaff = (user) => !!user && (user.role === 'admin' || user.user_type === 'trainer');
const isMemberUser = (user) => !!user && user.role !== 'admin' && (user.user_type === 'client' || user.user_type === 'independent');
const staffWriteDenied = (type, user) => (STAFF_LIBRARY_TYPES.has(type) || STAFF_WRITE_TYPES.has(type)) && !isStaff(user);

// Ownership scoping: admins see everything; everyone else only rows they own —
// rows they created, rows assigned to them as trainer, or rows about them as
// client/user (their client-record id, user id, or email).
async function ownershipClause(env, user) {
  if (!user || user.role === 'admin') return null;
  const ors = [
    { sql: 'created_by = ?', bind: user.email },
    { sql: "json_extract(data,'$.trainer_id') = ?", bind: user.id },
    { sql: "json_extract(data,'$.user_id') = ?", bind: user.id },
    // Rows about this user as a client, keyed by their login id. The coach's
    // Workouts, Schedule and Meals pages assign by login id once the client
    // has signed up; without this term those plans were invisible to clients.
    { sql: "json_extract(data,'$.client_id') = ?", bind: user.id },
    { sql: "json_extract(data,'$.client_user_id') = ?", bind: user.id },
    { sql: "json_extract(data,'$.email') = ?", bind: user.email },
    { sql: "json_extract(data,'$.sender_id') = ?", bind: user.id },
    { sql: "json_extract(data,'$.receiver_id') = ?", bind: user.id },
  ];
  const { results } = await env.DB.prepare(
    `SELECT id FROM entities WHERE entity_type='Client' AND (json_extract(data,'$.email') = ? OR json_extract(data,'$.user_id') = ?)`
  ).bind(user.email, user.id).all();
  for (const row of results) {
    ors.push({ sql: "json_extract(data,'$.client_id') = ?", bind: row.id });
    ors.push({ sql: 'id = ?', bind: row.id });
  }
  return {
    sql: `(${ors.map((o) => o.sql).join(' OR ')})`,
    binds: ors.map((o) => o.bind),
  };
}

// Members (clients and independents) can write their own logs, journals and
// profile, but must not be able to point records at people they don't belong
// to. Without this a client could set trainer_id on their Client record to any
// trainer and start reading that trainer's resources, or drop rows into
// another client's history. Returns an error message, or null if allowed.
// Mutates `fields` for Client creates to pin the record to the caller.
async function memberWriteViolation(env, user, type, fields, existing = null) {
  if (!user || user.role === 'admin') return null;
  if (user.user_type !== 'client' && user.user_type !== 'independent') return null;
  if (STAFF_LIBRARY_TYPES.has(type)) return 'Only coaches can change the gym library.';

  const { results } = await env.DB.prepare(
    `SELECT id, data FROM entities WHERE entity_type='Client' AND (json_extract(data,'$.email') = ? OR json_extract(data,'$.user_id') = ?)`
  ).bind(user.email, user.id).all();
  const myClientIds = new Set(results.map((r) => r.id));
  const myTrainerIds = new Set(results
    .map((r) => { try { return JSON.parse(r.data).trainer_id; } catch { return null; } })
    .filter(Boolean));

  if (type === 'Client') {
    if (!existing) {
      fields.email = user.email;
      fields.user_id = user.id;
    } else if ('email' in fields && fields.email && fields.email.toLowerCase() !== String(user.email).toLowerCase()) {
      return 'You can only use your own email on your profile.';
    }
  }

  if ('trainer_id' in fields && fields.trainer_id) {
    const current = existing?.trainer_id;
    if (fields.trainer_id !== current && !myTrainerIds.has(fields.trainer_id)) {
      return 'Only your coach can assign you to a trainer.';
    }
  }

  if ('client_id' in fields && fields.client_id) {
    const cid = fields.client_id;
    if (cid !== user.id && !myClientIds.has(cid) && cid !== existing?.client_id) {
      return 'You can only save records to your own profile.';
    }
  }

  if (STAFF_WRITE_TYPES.has(type)) return 'Only coaches can change program enrollments.';
  if (MEMBER_PROGRAM_RECORD_TYPES.has(type) && 'enrollment_id' in fields && fields.enrollment_id
      && fields.enrollment_id !== existing?.enrollment_id) {
    const enr = await env.DB.prepare(
      `SELECT data FROM entities WHERE id = ? AND entity_type = 'ProgramEnrollment'`
    ).bind(fields.enrollment_id).first();
    let e = null; try { e = enr ? JSON.parse(enr.data) : null; } catch { /* ignore */ }
    if (!e || !(myClientIds.has(e.client_id) || e.client_user_id === user.id)) {
      return 'You can only save records to your own program.';
    }
  }
  return null;
}

/* --------------------------- audit logging ------------------------------ */
// HIPAA-aligned audit trail (45 CFR §164.312(b)): records who did what to
// which record, when, and from where. Fire-and-forget so it never blocks
// a request; failures are swallowed (logging must not break the app).
/* ------------------------------- billing -------------------------------- */
// Subscription plans. `clientLimit: 0` means unlimited. Prices live in Stripe
// and are resolved by lookup key, so pricing can change there without a deploy.
const PLANS = {
  starter: { name: 'Starter', clientLimit: 10, monthly: 9, annual: 90 },
  pro: { name: 'Pro', clientLimit: 40, monthly: 19, annual: 190 },
  studio: { name: 'Studio', clientLimit: 0, monthly: 39, annual: 390 },
};
const TRIAL_DAYS = 14;
// Statuses that still grant access (Stripe keeps a subscription usable while a
// payment retries, so 'past_due' is deliberately included).
const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing', 'past_due']);

// Minimal Stripe REST client — the official SDK is Node-oriented, and all we
// need is form-encoded POSTs against the API.
async function stripe(env, path, { method = 'POST', data } = {}) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured.');
  const body = data ? new URLSearchParams(flattenForStripe(data)).toString() : undefined;
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  const out = await resp.json();
  if (!resp.ok) throw new Error(out?.error?.message || `Stripe error ${resp.status}`);
  return out;
}

// Stripe wants bracketed keys for nested data: metadata[plan], line_items[0][price].
function flattenForStripe(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => {
      if (item !== null && typeof item === 'object') flattenForStripe(item, `${key}[${i}]`, out);
      else out[`${key}[${i}]`] = String(item);
    });
    else if (typeof v === 'object') flattenForStripe(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

// Verifies the Stripe-Signature header (HMAC-SHA256 over "timestamp.payload").
// Without this, anyone could POST fake "subscription active" events to us.
async function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=').map((s) => s.trim())));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  // Reject events older than 5 minutes to blunt replay attacks.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Constant-time compare.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// Reads subscription state off a user record and decides what they may do.
function subscriptionState(user) {
  const b = user?.billing || {};

  // Beta-key trainers are comped for life: full access, unlimited clients, and
  // they are never shown a paywall or asked for a card.
  if (user?.beta_key_used) {
    return {
      status: 'comped', plan: 'studio', planName: 'Founding Trainer',
      clientLimit: 0, active: true, onTrial: false, comped: true,
      trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      customerId: b.customer_id || null,
    };
  }

  const status = b.status || 'none';
  // Trainers who signed up before billing existed have no stored trial date.
  // Derive one from their account age so nobody is locked out by an upgrade.
  const trialEndsRaw = b.trial_ends_at
    || (user?.created_date ? new Date(new Date(user.created_date).getTime() + TRIAL_DAYS * 86400000).toISOString() : null);
  const trialEndsAt = trialEndsRaw ? new Date(trialEndsRaw).getTime() : null;
  const onTrial = status === 'none' && trialEndsAt != null && trialEndsAt > Date.now();
  const active = ACTIVE_SUB_STATUSES.has(status) || onTrial;
  const plan = b.plan && PLANS[b.plan] ? b.plan : null;
  return {
    status: onTrial ? 'trialing' : status,
    plan,
    planName: plan ? PLANS[plan].name : onTrial ? 'Free trial' : null,
    clientLimit: plan ? PLANS[plan].clientLimit : onTrial ? PLANS.starter.clientLimit : 0,
    active,
    onTrial,
    trialEndsAt: trialEndsRaw || null,
    currentPeriodEnd: b.current_period_end || null,
    cancelAtPeriodEnd: !!b.cancel_at_period_end,
    comped: false,
    customerId: b.customer_id || null,
  };
}

// Persists billing fields onto the user's JSON blob.
async function saveBilling(env, userId, patch) {
  const row = await env.DB.prepare('SELECT data FROM users WHERE id = ?').bind(userId).first();
  if (!row) return false;
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { /* corrupt blob — start fresh */ }
  data.billing = { ...(data.billing || {}), ...patch };
  await env.DB.prepare('UPDATE users SET data = ?, updated_date = ? WHERE id = ?')
    .bind(JSON.stringify(data), nowISO(), userId).run();
  return true;
}

async function audit(env, { actor, action, target, targetId, detail, request }) {
  try {
    const ip = request?.headers?.get('cf-connecting-ip') || '';
    await env.DB.prepare(
      `INSERT INTO audit_log (id, actor, action, target, target_id, detail, ip, created_date)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      uid(),
      actor || 'anonymous',
      action,
      target || '',
      targetId || '',
      detail ? String(detail).slice(0, 300) : '',
      ip,
      nowISO()
    ).run();
  } catch { /* never block the request on audit failure */ }
}

// The single source of truth for "which rows of `type` may `user` touch".
// Used by BOTH the list endpoint and single-record GET/PUT/DELETE so that
// fetching a record by its id can never bypass the list's access rules.
// Returns null when no restriction applies (admins, shared content types).
const COACH_PRIVATE_TYPES = new Set(['ClientNote', 'ClientNotebookPage']);

async function entityScope(env, type, user) {
  if (SHARED_TYPES.has(type) || STAFF_LIBRARY_TYPES.has(type)) return null;
  if (isStaff(user) && !STAFF_PRIVATE_TYPES.has(type)) return null;
  const scope = await ownershipClause(env, user);
  if (!scope) return null; // admin
  let sql = scope.sql;
  const binds = [...scope.binds];
  // Coach notes and notebooks are about the member but written for the coach
  // (including "medical" notes). Members only see notes they wrote and the AI
  // recovery prescriptions stored as notes from AI_SYSTEM.
  if (COACH_PRIVATE_TYPES.has(type) && (user.user_type === 'client' || user.user_type === 'independent')) {
    return {
      sql: `(created_by = ? OR (json_extract(data,'$.trainer_id') = 'AI_SYSTEM' AND ${scope.sql}))`,
      binds: [user.email, ...scope.binds],
    };
  }
  if (type === 'Resource' && isMemberUser(user)) {
    const extra = await memberResourceTerm(env, user);
    sql = `(${sql} OR ${extra.sql})`;
    binds.push(...extra.binds);
  }
  return { sql, binds };
}

// Admin-only: remove a client and everything stored about them: their own
// logs and posts, plans, notes, contracts and sessions attached to them,
// messages to or from their login, and the login itself.
async function deleteClientAndData(env, row) {
  let data = {}; try { data = JSON.parse(row.data); } catch { /* ignore */ }
  const email = data.email ? String(data.email).toLowerCase() : null;
  // The member's login, if any: linked by user_id or matched by email. Never
  // a staff login, so a coach's records are never swept up.
  let login = null;
  if (data.user_id) login = await env.DB.prepare('SELECT id, email, user_type, role FROM users WHERE id = ?').bind(data.user_id).first();
  if (!login && email) login = await env.DB.prepare('SELECT id, email, user_type, role FROM users WHERE lower(email) = ?').bind(email).first();
  const memberLogin = login && login.role !== 'admin' && (login.user_type === 'client' || login.user_type === 'independent') ? login : null;

  const ids = [row.id, data.user_id, memberLogin?.id].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  const ph = ids.map(() => '?').join(',');
  const where = [
    `json_extract(data,'$.client_id') IN (${ph})`,
    `json_extract(data,'$.client_user_id') IN (${ph})`,
    `json_extract(data,'$.sender_id') IN (${ph})`,
    `json_extract(data,'$.receiver_id') IN (${ph})`,
    `(entity_type = 'Notification' AND json_extract(data,'$.user_id') IN (${ph}))`,
  ];
  const binds = [...ids, ...ids, ...ids, ...ids, ...ids];
  if (memberLogin) {
    where.push('lower(created_by) = ?');
    binds.push(String(memberLogin.email).toLowerCase());
  }
  const { results } = await env.DB.prepare(
    `SELECT id FROM entities WHERE id != ? AND (${where.join(' OR ')})`
  ).bind(row.id, ...binds).all();
  for (const r of results) {
    await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(r.id).run();
  }
  await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(row.id).run();
  if (memberLogin) await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(memberLogin.id).run();
  return results.length + 1;
}

/* ------------------------------ web push -------------------------------- */
// Standard Web Push (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID),
// done with WebCrypto so no outside service is involved. Keys:
//   VAPID_PUBLIC_KEY  - base64url uncompressed P-256 public key (not secret)
//   VAPID_PRIVATE_KEY - the matching private key as a JWK JSON string (secret)
const b64uEncode = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64uDecode = (str) => {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const concatBytes = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function vapidAuthHeader(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64uEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(utf8(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'https://brigade-app.pages.dev',
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64uEncode(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function encryptPushPayload(sub, payload) {
  const uaPublic = b64uDecode(sub.keys.p256dh);
  const authSecret = b64uDecode(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concatBytes(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concatBytes(utf8(payload), new Uint8Array([2])); // 0x02 = last record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// Push a notification to every device the user enabled. Expired
// subscriptions (404/410) are removed. Never throws.
async function sendPushToUser(env, userId, message) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !userId) return 0;
  let sent = 0;
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, data FROM entities WHERE entity_type='PushSubscription' AND json_extract(data,'$.user_id') = ?`
    ).bind(userId).all();
    const payload = JSON.stringify(message);
    for (const row of results) {
      let sub; try { sub = JSON.parse(row.data); } catch { continue; }
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) continue;
      try {
        const body = await encryptPushPayload(sub, payload);
        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            Authorization: await vapidAuthHeader(env, sub.endpoint),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '86400',
            Urgency: 'high',
          },
          body,
        });
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(row.id).run();
        } else if (res.ok) {
          sent++;
        }
      } catch { /* one bad device shouldn't stop the rest */ }
    }
  } catch { /* push is best-effort */ }
  return sent;
}

// A new Notification row also goes out as a push. Members can only trigger
// pushes to staff (their coach), so one member can't push-spam another.
// Message text isn't put on the lock screen, only who it's from.
async function pushForNotification(env, user, fields) {
  const target = fields?.user_id;
  if (!target || target === user.id) return;
  if (isMemberUser(user)) {
    const t = await env.DB.prepare('SELECT role, user_type FROM users WHERE id = ?').bind(target).first();
    if (!t || (t.role !== 'admin' && t.user_type !== 'trainer')) return;
  }
  const isMessage = fields.type === 'message';
  const sender = isMessage ? String(fields.message || '').split(':')[0].slice(0, 60) : '';
  await sendPushToUser(env, target, {
    title: isMessage ? 'New message' : String(fields.title || 'Brigade').slice(0, 80),
    body: isMessage ? `${sender || 'Someone'} sent you a message.` : String(fields.message || '').slice(0, 140),
    url: fields.link || '/',
    tag: isMessage ? 'messages' : undefined,
  });
}

// Fetch one entity only if the user is allowed to see it. Returns null when the
// row is missing OR out of scope — callers answer 404 either way, so an
// attacker cannot probe for the existence of other users' records.
async function getScopedEntity(env, type, id, user) {
  const scope = await entityScope(env, type, user);
  const sql = `SELECT * FROM entities WHERE id = ? AND entity_type = ?${scope ? ` AND ${scope.sql}` : ''}`;
  const binds = scope ? [id, type, ...scope.binds] : [id, type];
  return env.DB.prepare(sql).bind(...binds).first();
}

async function listEntities(env, type, { filter = {}, sort, limit, user }) {
  const where = ['entity_type = ?'];
  const binds = [type];
  {
    const scope = await entityScope(env, type, user);
    if (scope) {
      where.push(scope.sql);
      binds.push(...scope.binds);
    }
  }
  for (const [k, v] of Object.entries(filter || {})) {
    if (v === undefined) continue;
    if (v === null) {
      where.push(`${fieldExpr(k)} IS NULL`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) { where.push('1 = 0'); continue; }
      where.push(`${fieldExpr(k)} IN (${v.map(() => '?').join(',')})`);
      binds.push(...v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)));
    } else {
      where.push(`${fieldExpr(k)} = ?`);
      binds.push(typeof v === 'object' ? JSON.stringify(v) : v);
    }
  }
  let sql = `SELECT * FROM entities WHERE ${where.join(' AND ')}`;
  let orderField = 'created_date';
  let dir = 'DESC';
  if (sort) {
    if (sort.startsWith('-')) { orderField = sort.slice(1); dir = 'DESC'; }
    else { orderField = sort; dir = 'ASC'; }
  }
  sql += ` ORDER BY ${fieldExpr(orderField)} ${dir}`;
  if (limit) { sql += ' LIMIT ?'; binds.push(Number(limit)); }
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results.map(rowToEntity);
}

/* ------------------------------ functions ------------------------------- */

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) return { success: false, error: 'RESEND_API_KEY not configured' };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'Brigade Athletic Club <onboarding@resend.dev>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    }),
  });
  const out = await resp.json();
  if (!resp.ok) return { success: false, error: out?.message || `Resend error ${resp.status}` };
  return { success: true, id: out?.id };
}

const EDB_HOST = 'edb-with-videos-and-images-by-ascendapi.p.rapidapi.com';
async function edbFetch(env, path) {
  if (!env.EXERCISEDB_API_KEY) return { success: false, error: 'EXERCISEDB_API_KEY not configured' };
  const resp = await fetch(`https://${EDB_HOST}${path}`, {
    headers: {
      'x-rapidapi-key': env.EXERCISEDB_API_KEY,
      'x-rapidapi-host': EDB_HOST,
    },
  });
  if (!resp.ok) return { success: false, error: `ExerciseDB ${resp.status}` };
  return resp.json();
}

/* ------------------------------- programs -------------------------------- */
// Programs, lessons and program calendars (docs/programs-spec.md). Dates are
// "yyyy-MM-dd" calendar keys; the math mirrors src/lib/programs.js but works
// in UTC on the key itself so the server's own time zone never matters.
const PROGRAM_TZ = 'America/New_York';
const MESSAGE_BACKLOG_MS = 3 * 864e5; // don't send program messages older than this
const isDateKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
const keyToUTC = (k) => { const [y, m, d] = String(k).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const pAddDays = (k, n) => new Date(keyToUTC(k) + n * 864e5).toISOString().slice(0, 10);
const pDaysBetween = (a, b) => Math.round((keyToUTC(b) - keyToUTC(a)) / 864e5);
const pDayNumberFor = (start, date) => pDaysBetween(start, date) + 1;
const pDateForDay = (start, day) => pAddDays(start, Number(day) - 1);
const pDow = (k) => new Date(keyToUTC(k)).getUTCDay();

// Today's calendar date at the gym (Eastern).
const programToday = (ms = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: PROGRAM_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// Minutes the Eastern wall clock is ahead of UTC at instant `ms` (e.g. -300 / -240).
function tzOffsetMinutes(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: PROGRAM_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
}

// UTC instant (ms) of an Eastern wall-clock time "HH:mm" on date key `k`, DST-correct.
function easternToUTC(k, hhmm = '09:00') {
  const [y, m, d] = String(k).split('-').map(Number);
  const [hh, mm] = (/^\d{1,2}:\d{2}$/.test(String(hhmm || '')) ? String(hhmm) : '09:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffsetMinutes(guess);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(t);
  if (off2 !== off1) t = guess - off2 * 60000;
  return t;
}

const parseRow = (row) => (row ? rowToEntity(row) : null);

async function selectEntities(env, type, whereSql = '1=1', binds = []) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM entities WHERE entity_type = ? AND (${whereSql})`
  ).bind(type, ...binds).all();
  return results.map(rowToEntity);
}

async function getEntityById(env, type, id) {
  if (!id) return null;
  return parseRow(await env.DB.prepare('SELECT * FROM entities WHERE id = ? AND entity_type = ?').bind(id, type).first());
}

async function insertEntity(env, type, data, createdBy, id = uid()) {
  const now = nowISO();
  await env.DB.prepare(
    'INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
  ).bind(id, type, JSON.stringify(data), createdBy || null, now, now).run();
  return { ...data, id, created_by: createdBy || null, created_date: now, updated_date: now };
}

async function patchEntity(env, entity, patch) {
  const { id, created_by, created_date, updated_date: _u, ...data } = entity;
  const merged = { ...data, ...patch };
  const now = nowISO();
  await env.DB.prepare('UPDATE entities SET data=?, updated_date=? WHERE id=?').bind(JSON.stringify(merged), now, id).run();
  return { ...merged, id, created_by, created_date, updated_date: now };
}

const inList = (arr) => arr.map(() => '?').join(',');

// The member's Client record ids (a login can have one per coach).
async function myClientIds(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM entities WHERE entity_type='Client' AND (json_extract(data,'$.email') = ? OR json_extract(data,'$.user_id') = ?)`
  ).bind(user.email, user.id).all();
  return results.map((r) => r.id);
}

// The member login for a Client record (user_id, else a member account with that email).
async function clientLogin(env, client) {
  if (!client) return null;
  if (client.user_id) {
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(client.user_id).first();
    if (row) return userRow(row);
  }
  if (client.email) {
    const row = await env.DB.prepare(
      `SELECT * FROM users WHERE lower(email) = lower(?) AND role != 'admin' AND user_type IN ('client','independent') LIMIT 1`
    ).bind(client.email).first();
    if (row) return userRow(row);
  }
  return null;
}

async function staffLogin(env, id) {
  if (!id) return null;
  const u = userRow(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first());
  if (u) u.role = resolveRole(env, u.email, u.role);
  return u && isStaff(u) ? u : null;
}

function programLength(program, items) {
  const weeks = Number(program?.duration_weeks) || 0;
  if (weeks > 0) return weeks * 7;
  return Math.max(1, ...items.map((i) => Number(i.end_day) || Number(i.day) || 1));
}

// Template items + per-client overrides/extras -> effective items. Each gets
// item_id, eff_day, source (template|extra), moved, skipped. Habits also get
// eff_end_day (inclusive); a moved habit keeps its length.
function materializeProgram(enrollment, templateItems, program) {
  const length = programLength(program, templateItems);
  const overrides = new Map();
  for (const o of Array.isArray(enrollment.overrides) ? enrollment.overrides : []) {
    if (o && o.item_id) overrides.set(o.item_id, o);
  }
  const out = [];
  const add = (item, source) => {
    const day = Number(item.day) || 1;
    const o = source === 'template' ? overrides.get(item.id) : null;
    const skipped = o?.action === 'skip';
    const moved = o?.action === 'move' && Number(o.day) > 0;
    const effDay = moved ? Number(o.day) : day;
    const eff = { ...item, item_id: item.id, eff_day: effDay, source, moved, skipped };
    if (item.type === 'habit') {
      const end = Number(item.end_day) > 0 ? Number(item.end_day) + (effDay - day) : Math.max(length, effDay);
      eff.eff_end_day = Math.max(effDay, end);
    }
    out.push(eff);
  };
  for (const it of templateItems) if (it.program_id === enrollment.program_id) add(it, 'template');
  for (const it of Array.isArray(enrollment.extra_items) ? enrollment.extra_items : []) {
    if (it && it.id && it.type) add(it, 'extra');
  }
  out.sort((a, b) => a.eff_day - b.eff_day || (Number(a.sort) || 0) - (Number(b.sort) || 0));
  return out;
}

function habitScheduledOn(item, dateKey, start) {
  const day = pDayNumberFor(start, dateKey);
  if (day < item.eff_day || day > item.eff_end_day) return false;
  const dow = item.days_of_week;
  if (Array.isArray(dow) && dow.length > 0 && dow.length < 7) return dow.map(Number).includes(pDow(dateKey));
  return true;
}

// Mirrors isLogDone() in src/lib/habitLibrary.js.
function habitLogDone(habit, log) {
  if (!log) return false;
  if ((habit?.tracking || 'check') !== 'number') return !!log.completed;
  if (log.value === undefined || log.value === null || log.value === '') return !!log.completed;
  const v = Number(log.value);
  return /\bmax\b/i.test(habit?.unit || '') ? v <= Number(habit.target_value) : v >= Number(habit.target_value);
}

const HABIT_COPY_FIELDS = ['name', 'icon', 'category', 'description', 'tips', 'tracking', 'target_value', 'unit',
  'frequency', 'days_per_week', 'days_of_week', 'template_id'];

// Make the client's program Habit rows match the enrollment: one per habit item
// (not skipped), dated from start_date. Rows no longer wanted are archived
// (is_active:false), never deleted, so logs and history stay.
async function syncProgramHabits(env, enrollment, effItems, actorEmail) {
  const existing = await selectEntities(env, 'Habit', "json_extract(data,'$.enrollment_id') = ?", [enrollment.id]);
  const byItem = new Map(existing.map((h) => [h.item_id, h]));
  const active = enrollment.status === 'active';
  const archiveAll = enrollment.status === 'cancelled' || enrollment.status === 'paused';
  const client = await getEntityById(env, 'Client', enrollment.client_id);
  const trainerId = client?.trainer_id || enrollment.trainer_id || null;
  const keep = new Set();
  if (!archiveAll) {
    for (const it of effItems) {
      if (it.type !== 'habit' || it.skipped) continue;
      keep.add(it.item_id);
      const schedule = {
        start_date: pDateForDay(enrollment.start_date, it.eff_day),
        end_date: pDateForDay(enrollment.start_date, it.eff_end_day),
        days_of_week: Array.isArray(it.days_of_week) ? it.days_of_week.map(Number) : [],
      };
      const h = byItem.get(it.item_id);
      if (h) {
        const patch = { ...schedule };
        if (active) patch.is_active = true;
        await patchEntity(env, h, patch);
      } else if (enrollment.status !== 'completed') {
        const fields = {};
        for (const f of HABIT_COPY_FIELDS) if (it[f] !== undefined) fields[f] = it[f];
        await insertEntity(env, 'Habit', {
          ...fields,
          ...schedule,
          client_id: enrollment.client_id,
          ...(trainerId ? { trainer_id: trainerId } : {}),
          program_id: enrollment.program_id,
          enrollment_id: enrollment.id,
          item_id: it.item_id,
          is_active: true,
        }, actorEmail);
      }
    }
  }
  for (const h of existing) {
    if (!keep.has(h.item_id) && h.is_active !== false) await patchEntity(env, h, { is_active: false });
  }
}

async function loadProgramAndItems(env, programId, cache = null) {
  if (cache?.has(programId)) return cache.get(programId);
  const program = await getEntityById(env, 'Program', programId);
  const items = await selectEntities(env, 'ProgramItem', "json_extract(data,'$.program_id') = ?", [programId]);
  const v = { program, items };
  cache?.set(programId, v);
  return v;
}

function cleanOverrides(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((o) => o && o.item_id && (o.action === 'skip' || (o.action === 'move' && Number(o.day) > 0)))
    .map((o) => (o.action === 'move' ? { item_id: String(o.item_id), action: 'move', day: Number(o.day) } : { item_id: String(o.item_id), action: 'skip' }));
}

const PROGRAM_ITEM_TYPES = new Set(['lesson', 'habit', 'message', 'workout', 'checkin']);
function cleanExtraItems(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((it) => it && PROGRAM_ITEM_TYPES.has(it.type) && Number(it.day) > 0)
    .map((it) => ({ ...it, id: it.id && String(it.id).startsWith('x-') ? String(it.id) : `x-${uid().slice(0, 12)}`, day: Number(it.day) }));
}

// Send every due program message. opts: { enrollmentIds?: string[] } (default: all active).
// Idempotent: the ProgramMessageLog row has a deterministic primary key per
// enrollment+item and is inserted (status "sending") BEFORE the message, so two
// racing ticks can never both send.
async function runProgramTick(env, opts = {}) {
  const now = Date.now();
  const summary = { success: true, enrollments: 0, sent: 0, skipped: 0, failed: 0 };
  let where = "json_extract(data,'$.status') = 'active'";
  const binds = [];
  const ids = opts.enrollmentIds || (opts.enrollmentId ? [opts.enrollmentId] : null);
  if (ids) {
    if (ids.length === 0) return summary;
    where += ` AND id IN (${inList(ids)})`;
    binds.push(...ids);
  }
  const enrollments = await selectEntities(env, 'ProgramEnrollment', where, binds);
  const cache = new Map();
  for (const enr of enrollments) {
    if (!isDateKey(enr.start_date)) continue;
    summary.enrollments++;
    const { program, items } = await loadProgramAndItems(env, enr.program_id, cache);
    const due = materializeProgram(enr, items, program).filter((it) => it.type === 'message' && !it.skipped
      && easternToUTC(pDateForDay(enr.start_date, it.eff_day), it.send_time || '09:00') <= now);
    if (due.length === 0) continue;
    const logged = new Set((await selectEntities(env, 'ProgramMessageLog',
      "json_extract(data,'$.enrollment_id') = ?", [enr.id])).map((l) => l.item_id));
    const pending = due.filter((it) => !logged.has(it.item_id));
    if (pending.length === 0) continue;

    const client = await getEntityById(env, 'Client', enr.client_id);
    const coach = await staffLogin(env, client?.trainer_id) || await staffLogin(env, enr.trainer_id);
    const login = await clientLogin(env, client);

    for (const it of pending) {
      const scheduledMs = easternToUTC(pDateForDay(enr.start_date, it.eff_day), it.send_time || '09:00');
      const logId = `pml_${enr.id}_${it.item_id}`;
      const logData = {
        enrollment_id: enr.id, item_id: it.item_id, client_id: enr.client_id,
        program_id: enr.program_id, scheduled_for: new Date(scheduledMs).toISOString(), status: 'sending',
      };
      const createdBy = coach?.email || null;
      const ins = await env.DB.prepare(
        'INSERT OR IGNORE INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
      ).bind(logId, 'ProgramMessageLog', JSON.stringify(logData), createdBy, nowISO(), nowISO()).run();
      if (!ins?.meta?.changes) continue; // another tick already claimed it
      let logEntity = await getEntityById(env, 'ProgramMessageLog', logId);

      let reason = null;
      if (now - scheduledMs > MESSAGE_BACKLOG_MS) reason = 'too_old';
      else if (!client) reason = 'client_missing';
      else if (!login) reason = 'no_login';
      else if (!coach) reason = 'no_coach';
      else if (!String(it.text || '').trim()) reason = 'empty';
      if (reason) {
        await patchEntity(env, logEntity, { status: 'skipped', reason });
        summary.skipped++;
        continue;
      }
      try {
        const content = String(it.text).trim();
        const message = await insertEntity(env, 'Message', {
          conversation_id: [coach.id, login.id].sort().join('-'),
          sender_id: coach.id,
          sender_name: coach.full_name || 'Coach',
          receiver_id: login.id,
          receiver_name: client.full_name || login.full_name || 'Client',
          content,
          media_urls: [],
          timestamp: nowISO(),
          read: false,
          program_id: enr.program_id,
          enrollment_id: enr.id,
          program_item_id: it.item_id,
        }, coach.email);
        const notif = {
          user_id: login.id, type: 'message', title: 'New message',
          message: `${coach.full_name || 'Coach'}: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`,
          link: '/Messages',
        };
        await insertEntity(env, 'Notification', notif, coach.email);
        logEntity = await patchEntity(env, logEntity, { status: 'sent', sent_at: nowISO(), message_id: message.id });
        summary.sent++;
        const p = pushForNotification(env, coach, notif);
        if (env.__waitUntil) env.__waitUntil(p); else await p;
      } catch (e) {
        await patchEntity(env, logEntity, { status: 'failed', error: String(e?.message || e).slice(0, 200) });
        summary.failed++;
      }
    }
  }
  return summary;
}

// Materialized calendar for one enrollment between two date keys (inclusive).
// includeSkipped: coach calendars show skipped items so they can be restored.
async function buildProgramDays(env, enrollment, from, to, { includeSkipped = true, cache = null } = {}) {
  const { program, items } = await loadProgramAndItems(env, enrollment.program_id, cache);
  const eff = materializeProgram(enrollment, items, program);
  const start = enrollment.start_date;
  const today = programToday();
  const eid = enrollment.id;

  const lessonIds = [...new Set(eff.filter((i) => i.type === 'lesson' && i.lesson_id).map((i) => i.lesson_id))];
  const [lessons, completions, checkins, msgLogs, habits, workoutLogs] = await Promise.all([
    lessonIds.length ? selectEntities(env, 'Lesson', `id IN (${inList(lessonIds)})`, lessonIds) : [],
    selectEntities(env, 'LessonCompletion', "json_extract(data,'$.enrollment_id') = ?", [eid]),
    selectEntities(env, 'CheckinResponse', "json_extract(data,'$.enrollment_id') = ?", [eid]),
    selectEntities(env, 'ProgramMessageLog', "json_extract(data,'$.enrollment_id') = ?", [eid]),
    selectEntities(env, 'Habit', "json_extract(data,'$.enrollment_id') = ?", [eid]),
    selectEntities(env, 'WorkoutLog', "json_extract(data,'$.client_id') = ? AND json_extract(data,'$.date') BETWEEN ? AND ?", [enrollment.client_id, from, to]),
  ]);
  const habitIds = habits.map((h) => h.id);
  const habitLogs = habitIds.length
    ? await selectEntities(env, 'HabitLog', `json_extract(data,'$.habit_id') IN (${inList(habitIds)}) AND json_extract(data,'$.date') BETWEEN ? AND ?`, [...habitIds, from, to])
    : [];

  const lessonById = new Map(lessons.map((l) => [l.id, l]));
  const completionByItem = new Map(completions.map((c) => [c.item_id, c]));
  const checkinByItem = new Map(checkins.map((c) => [c.item_id, c]));
  const logByItem = new Map(msgLogs.map((l) => [l.item_id, l]));
  const habitByItem = new Map(habits.map((h) => [h.item_id, h]));
  const habitLogByKey = new Map(habitLogs.map((l) => [`${l.habit_id}|${l.date}`, l]));
  const doneOrMissed = (done, date) => (done ? 'done' : date < today ? 'missed' : 'upcoming');

  const entryFor = (it, date) => {
    const base = { item_id: it.item_id, type: it.type, day: it.eff_day, source: it.source, moved: it.moved, skipped: it.skipped };
    if (it.skipped) {
      return { ...base, title: titleFor(it), status: 'skipped', ref: refFor(it, date) };
    }
    switch (it.type) {
      case 'lesson': {
        const c = completionByItem.get(it.item_id);
        return { ...base, title: titleFor(it), status: doneOrMissed(!!c, date), ref: refFor(it, date) };
      }
      case 'habit': {
        const h = habitByItem.get(it.item_id);
        const log = h ? habitLogByKey.get(`${h.id}|${date}`) : null;
        return { ...base, title: titleFor(it), status: doneOrMissed(habitLogDone(h || it, log), date), ref: refFor(it, date) };
      }
      case 'message': {
        const l = logByItem.get(it.item_id);
        const status = !l ? 'scheduled' : l.status === 'sent' ? 'sent' : l.status === 'sending' ? 'scheduled' : 'skipped';
        return { ...base, title: titleFor(it), status, ref: refFor(it, date) };
      }
      case 'workout': {
        const w = workoutFor(it, date);
        return { ...base, title: titleFor(it), status: doneOrMissed(!!w, date), ref: refFor(it, date) };
      }
      case 'checkin': {
        const c = checkinByItem.get(it.item_id);
        return { ...base, title: titleFor(it), status: doneOrMissed(!!c, date), ref: refFor(it, date) };
      }
      default:
        return { ...base, title: it.title || it.type, status: 'upcoming', ref: {} };
    }
  };
  function workoutFor(it, date) {
    return workoutLogs.find((w) => w.date === date && (!it.workout_plan_id || w.workout_plan_id === it.workout_plan_id)) || null;
  }
  function titleFor(it) {
    if (it.type === 'lesson') return lessonById.get(it.lesson_id)?.title || it.title || 'Lesson';
    if (it.type === 'habit') return it.name || it.title || 'Habit';
    if (it.type === 'message') { const t = String(it.text || '').trim(); return t.length > 60 ? `${t.slice(0, 57)}...` : (t || 'Message'); }
    if (it.type === 'workout') return it.title || 'Workout';
    if (it.type === 'checkin') return it.title || 'Check-in';
    return it.title || it.type;
  }
  function refFor(it, date) {
    switch (it.type) {
      case 'lesson': {
        const c = completionByItem.get(it.item_id);
        const l = lessonById.get(it.lesson_id);
        return {
          lesson_id: it.lesson_id || null,
          lesson: l ? { id: l.id, title: l.title, subtitle: l.subtitle, category: l.category, cover_image_url: l.cover_image_url } : null,
          completion_id: c?.id || null,
          reflection_answer: c?.reflection_answer || null,
        };
      }
      case 'habit': {
        const h = habitByItem.get(it.item_id);
        const log = h ? habitLogByKey.get(`${h.id}|${date}`) : null;
        return {
          habit_id: h?.id || null, log_id: log?.id || null, icon: it.icon || h?.icon || null,
          tracking: h?.tracking || it.tracking || 'check', target_value: h?.target_value ?? it.target_value ?? null,
          unit: h?.unit ?? it.unit ?? '', value: log?.value ?? null,
          start_day: it.eff_day, end_day: it.eff_end_day,
        };
      }
      case 'message': {
        const l = logByItem.get(it.item_id);
        return {
          text: it.text || '', send_time: it.send_time || '09:00',
          scheduled_for: new Date(easternToUTC(date, it.send_time || '09:00')).toISOString(),
          log_id: l?.id || null, log_status: l?.status || null, reason: l?.reason || null,
          message_id: l?.message_id || null, sent_at: l?.sent_at || null,
        };
      }
      case 'workout': {
        const w = workoutFor(it, date);
        return { workout_plan_id: it.workout_plan_id || null, workout_day: it.workout_day ?? null, log_id: w?.id || null };
      }
      case 'checkin': {
        const c = checkinByItem.get(it.item_id);
        return { fields: it.fields || [], response_id: c?.id || null, values: c?.values || null };
      }
      default:
        return {};
    }
  }

  const days = [];
  const span = Math.min(pDaysBetween(from, to), 400);
  for (let i = 0; i <= span; i++) {
    const date = pAddDays(from, i);
    const day = pDayNumberFor(start, date);
    const dayItems = [];
    for (const it of eff) {
      if (it.skipped && !includeSkipped) continue;
      const on = it.type === 'habit' ? habitScheduledOn(it, date, start) : it.eff_day === day;
      if (on) dayItems.push(entryFor(it, date));
    }
    days.push({ date, day, items: dayItems });
  }
  return { program, eff, days, lessonById, completionByItem, today };
}

/* ---------------------------- group classes ------------------------------ */
// Group classes (docs/classes-spec.md): schedule, reservations, attendance and
// plan limits. Dates are Eastern "yyyy-MM-dd" keys, times "HH:mm" Eastern,
// start_at/end_at ISO UTC (easternToUTC). Every capacity / allowance change is
// a single conditional SQL statement (or a D1 batch, which runs as one
// transaction), so two people racing for the last spot can't both get it.
const CLASS_SETTINGS_DEFAULTS = {
  booking_open_hours: 168, booking_close_minutes: 60, late_cancel_hours: 8,
  self_checkin_before_minutes: 30, self_checkin_after_minutes: 30,
  open_gym_checkin_until_end: true, no_show_after_minutes: 120,
  waitlist_enabled: true, late_cancel_counts_toward_limit: false, no_show_counts_toward_limit: false,
  waiver_required: true, show_roster_to_members: true, generate_days_ahead: 21,
};
const ACTIVE_RES = ['reserved', 'waitlisted', 'checked_in'];
const NO_LIMIT_KINDS = new Set(['unlimited', 'comp', 'intro']);
const sqlStr = (arr) => arr.map((s) => `'${s}'`).join(','); // constant status names only
const numOr = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const hmToMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const minToHm = (n) => { const x = ((n % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const capOf = (session) => { const c = numOr(session?.capacity, null); return c !== null && c > 0 ? c : null; };
const classWeekStart = (k) => pAddDays(k, -((pDow(k) + 6) % 7));
const RES_SPOT_COUNT = `(SELECT COUNT(*) FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.session_id') = ? AND json_extract(data,'$.status') IN ('reserved','checked_in'))`;

function monthAnchorKey(y, m, day) { // m is 1-based and may overflow either way
  const d = new Date(Date.UTC(y, m - 1, 1));
  const yy = d.getUTCFullYear(); const mm = d.getUTCMonth() + 1;
  const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(day, dim)).padStart(2, '0')}`;
}
// Billing month containing `k`, anchored on the membership start date's day of month.
function billingPeriod(anchorKey, k) {
  const day = Number(String(isDateKey(anchorKey) ? anchorKey : k).slice(8, 10)) || 1;
  const [y, m] = k.split('-').map(Number);
  let start = monthAnchorKey(y, m, day);
  if (start > k) start = monthAnchorKey(y, m - 1, day);
  const [sy, sm] = start.split('-').map(Number);
  return { start, end: pAddDays(monthAnchorKey(sy, sm + 1, day), -1) };
}

async function getGymSettings(env) {
  const row = parseRow(await env.DB.prepare(
    `SELECT * FROM entities WHERE entity_type='GymSettings' ORDER BY created_date ASC LIMIT 1`
  ).first());
  const s = { ...CLASS_SETTINGS_DEFAULTS };
  if (row) {
    for (const k of Object.keys(s)) {
      const v = row[k];
      if (v === undefined || v === null || v === '') continue;
      if (typeof s[k] === 'boolean') s[k] = v === true || v === 1 || v === 'true';
      else s[k] = numOr(v, s[k]);
    }
  }
  return s;
}

function sessionRules(session, s) {
  const o = session?.overrides || {};
  return {
    // single class > its weekly slot / class type (copied onto the session) > gym default
    open_h: numOr(o.booking_open_hours, numOr(session?.booking_open_hours, s.booking_open_hours)),
    close_m: numOr(o.booking_close_minutes, s.booking_close_minutes),
    late_h: numOr(o.late_cancel_hours, s.late_cancel_hours),
  };
}
function sessionWindows(session, s) {
  const start = Date.parse(session.start_at);
  const end = Date.parse(session.end_at) || start;
  const r = sessionRules(session, s);
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const ciClose = session.reservable === false && s.open_gym_checkin_until_end ? end : start + s.self_checkin_after_minutes * 60000;
  return {
    booking_opens_at: iso(start - r.open_h * 3600000),
    booking_closes_at: iso(start - r.close_m * 60000),
    late_cancel_at: iso(start - r.late_h * 3600000),
    checkin_opens_at: iso(start - s.self_checkin_before_minutes * 60000),
    checkin_closes_at: iso(ciClose),
  };
}
const classWhen = (session) => {
  const [y, m, d] = String(session.date).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const mins = hmToMin(session.start_time) ?? 0;
  const h = Math.floor(mins / 60);
  return `${day} at ${h % 12 === 0 ? 12 : h % 12}:${String(mins % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const shortName = (full) => {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Member';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};

// Who a class action is for. Members act for themselves (all their Client
// records); staff must name client_id. -> { client, clientIds, loginId } | { error }
async function resolveClassClient(env, user, clientId) {
  if (isStaff(user)) {
    if (!clientId) return { error: 'client_id is required.' };
    const client = await getEntityById(env, 'Client', clientId);
    if (!client) return { error: 'Client not found.' };
    const login = await clientLogin(env, client);
    return { client, clientIds: [client.id], loginId: login?.id || client.user_id || null };
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM entities WHERE entity_type='Client' AND (json_extract(data,'$.email') = ? OR json_extract(data,'$.user_id') = ?) ORDER BY created_date ASC`
  ).bind(user.email, user.id).all();
  const clients = results.map(rowToEntity);
  if (!clients.length) return { error: 'Your account is not linked to a client profile yet. Ask the front desk.' };
  if (clientId && !clients.some((c) => c.id === clientId)) return { error: 'You can only book classes for yourself.' };
  const client = clients.find((c) => c.id === clientId) || clients.find((c) => c.user_id === user.id) || clients[0];
  return { client, clientIds: clients.map((c) => c.id), loginId: user.id };
}

const clientMatchSql = (who) => {
  const ors = [`json_extract(data,'$.client_id') IN (${inList(who.clientIds)})`];
  const binds = [...who.clientIds];
  if (who.loginId) { ors.push(`json_extract(data,'$.client_user_id') = ?`); binds.push(who.loginId); }
  return { sql: `(${ors.join(' OR ')})`, binds };
};

async function waiverStatus(env, who) {
  const ids = [...who.clientIds, ...(who.loginId ? [who.loginId] : [])];
  const row = await env.DB.prepare(
    `SELECT id FROM entities WHERE entity_type='Contract' AND json_extract(data,'$.status') = 'signed'
     AND (json_extract(data,'$.client_id') IN (${inList(ids)}) OR json_extract(data,'$.client_user_id') = ?)
     AND (json_extract(data,'$.type') = 'waiver' OR lower(COALESCE(json_extract(data,'$.title'),'')) LIKE '%waiver%')
     ORDER BY created_date DESC LIMIT 1`
  ).bind(...ids, who.loginId || '').first();
  return { signed: !!row, contract_id: row?.id || null };
}

function membershipCoversDate(m, date) {
  if (!m || m.status === 'ended') return false;
  if (!isDateKey(m.start_date) || m.start_date > date) return false;
  if (isDateKey(m.end_date) && m.end_date < date) return false;
  const inHold = isDateKey(m.hold_from) && m.hold_from <= date && (!isDateKey(m.hold_to) || date <= m.hold_to);
  if (m.status === 'on_hold') return isDateKey(m.hold_from) && !inHold;
  if (m.status !== 'active') return false;
  return !inHold;
}
const membershipCoversType = (m, typeId) => !Array.isArray(m.class_type_ids) || m.class_type_ids.length === 0 || m.class_type_ids.includes(typeId);
function membershipLimit(m) {
  if (NO_LIMIT_KINDS.has(m.kind)) return null;
  if (m.kind === 'punch' || m.kind === 'drop_in' || m.limit_period === 'total') {
    return { period: 'total', count: numOr(m.sessions_total, numOr(m.limit_count, 0)) };
  }
  if ((m.limit_period === 'week' || m.limit_period === 'month') && numOr(m.limit_count, null) !== null) {
    return { period: m.limit_period, count: Number(m.limit_count) };
  }
  return null;
}
const membershipRank = (m) => (NO_LIMIT_KINDS.has(m.kind) ? 0 : membershipLimit(m)?.period === 'total' ? 2 : 1);
function countedStatuses(s, forTotal = false) {
  const st = forTotal ? ['reserved'] : ['reserved', 'checked_in'];
  if (s.late_cancel_counts_toward_limit) st.push('late_cancelled');
  if (s.no_show_counts_toward_limit) st.push('no_show');
  return st;
}
// SQL condition "this membership still has room for one more class on `date`".
// Week: Mon-Sun Eastern week; month: billing month; total: sessions_used (bumped
// at check-in) + reservations not yet checked in.
function allowanceGuard(m, date, s) {
  const lim = membershipLimit(m);
  if (!lim) return { sql: '1=1', binds: [], lim: null };
  if (lim.period === 'total') {
    return {
      sql: `(COALESCE((SELECT json_extract(data,'$.sessions_used') FROM entities WHERE id = ?),0) + (SELECT COUNT(*) FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.membership_id') = ? AND json_extract(data,'$.status') IN (${sqlStr(countedStatuses(s, true))}))) < ?`,
      binds: [m.id, m.id, lim.count], lim,
    };
  }
  const p = lim.period === 'week' ? { start: classWeekStart(date), end: pAddDays(classWeekStart(date), 6) } : billingPeriod(m.start_date, date);
  return {
    sql: `(SELECT COUNT(*) FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.membership_id') = ? AND json_extract(data,'$.status') IN (${sqlStr(countedStatuses(s))}) AND json_extract(data,'$.date') BETWEEN ? AND ?) < ?`,
    binds: [m.id, p.start, p.end, lim.count], lim, period: p,
  };
}
// Allowance for display, for the period containing `date` (default today).
async function membershipAllowance(env, m, s, date = programToday()) {
  const lim = membershipLimit(m);
  if (!lim) return { period: null, limit: null, used: null, remaining: null };
  if (lim.period === 'total') {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.membership_id') = ? AND json_extract(data,'$.status') IN (${sqlStr(countedStatuses(s, true))})`
    ).bind(m.id).first();
    const used = numOr(m.sessions_used, 0);
    const reserved = r?.n || 0;
    return { period: 'total', limit: lim.count, used: used + reserved, checked_in: used, reserved, remaining: Math.max(0, lim.count - used - reserved) };
  }
  const p = lim.period === 'week' ? { start: classWeekStart(date), end: pAddDays(classWeekStart(date), 6) } : billingPeriod(m.start_date, date);
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.membership_id') = ? AND json_extract(data,'$.status') IN (${sqlStr(countedStatuses(s))}) AND json_extract(data,'$.date') BETWEEN ? AND ?`
  ).bind(m.id, p.start, p.end).first();
  const used = r?.n || 0;
  return { period: lim.period, limit: lim.count, used, remaining: Math.max(0, lim.count - used), period_start: p.start, period_end: p.end };
}

async function clientMemberships(env, who) {
  const m = clientMatchSql(who);
  const list = await selectEntities(env, 'Membership', m.sql, m.binds);
  return list.sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)));
}

// First membership that covers the session and has room: unlimited/comp/intro,
// then limited, then punch/drop-in. -> { membership, guard } | { reason }
async function findClassMembership(env, who, session, s) {
  const all = await clientMemberships(env, who);
  const covering = all.filter((m) => membershipCoversDate(m, session.date) && membershipCoversType(m, session.class_type_id))
    .sort((a, b) => membershipRank(a) - membershipRank(b));
  if (!covering.length) return { reason: 'No active membership covers this class.', code: 'no_membership' };
  for (const m of covering) {
    const guard = allowanceGuard(m, session.date, s);
    if (!guard.lim) return { membership: m, guard };
    const ok = await env.DB.prepare(`SELECT CASE WHEN ${guard.sql} THEN 1 ELSE 0 END AS ok`).bind(...guard.binds).first();
    if (ok?.ok) return { membership: m, guard };
  }
  const lim = membershipLimit(covering[0]);
  const reason = lim?.period === 'week' ? `You have used all ${lim.count} classes on your plan for that week.`
    : lim?.period === 'month' ? `You have used all ${lim.count} classes on your plan for that month.`
      : 'No classes left on your plan.';
  return { reason, code: 'limit_reached' };
}

// Conditional insert of a reservation. mode: 'spot' (needs a free spot),
// 'waitlist' (class must be full; gets the next position), 'force' (staff override).
// Always refuses a second active reservation for the same client, and a
// session that is no longer scheduled. Returns { stmt, id }.
function reservationInsert(env, { data, createdBy, session, clientIds, guard, mode }) {
  const id = uid();
  const now = nowISO();
  const conds = [
    `EXISTS (SELECT 1 FROM entities WHERE id = ? AND entity_type='ClassSession' AND json_extract(data,'$.status') = 'scheduled')`,
    `NOT EXISTS (SELECT 1 FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.session_id') = ? AND json_extract(data,'$.client_id') IN (${inList(clientIds)}) AND json_extract(data,'$.status') IN (${sqlStr(ACTIVE_RES)}))`,
  ];
  const condBinds = [session.id, session.id, ...clientIds];
  const cap = capOf(session);
  if (mode === 'spot' && cap !== null) { conds.push(`${RES_SPOT_COUNT} < ?`); condBinds.push(session.id, cap); }
  if (mode === 'waitlist') { conds.push(`${RES_SPOT_COUNT} >= ?`); condBinds.push(session.id, cap ?? 0); }
  if (guard && guard.lim) { conds.push(guard.sql); condBinds.push(...guard.binds); }
  const dataExpr = mode === 'waitlist'
    ? `json_set(?, '$.waitlist_position', (SELECT COALESCE(MAX(CAST(json_extract(data,'$.waitlist_position') AS INTEGER)),0)+1 FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.session_id') = ? AND json_extract(data,'$.status') = 'waitlisted'))`
    : '?';
  const binds = [id, JSON.stringify(data), ...(mode === 'waitlist' ? [session.id] : []), createdBy || null, now, now, ...condBinds];
  const stmt = env.DB.prepare(
    `INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date)
     SELECT ?, 'Reservation', ${dataExpr}, ?, ?, ? WHERE ${conds.join(' AND ')}`
  ).bind(...binds);
  return { stmt, id };
}

const punchStmt = (env, membershipId, delta, existsSql, existsBinds) => env.DB.prepare(
  `UPDATE entities SET data = json_set(data, '$.sessions_used', MAX(0, COALESCE(json_extract(data,'$.sessions_used'),0) + ?)), updated_date = ?
   WHERE id = ? AND entity_type = 'Membership' AND EXISTS (${existsSql})`
).bind(delta, nowISO(), membershipId, ...existsBinds);

// Keep a session's counts (and waitlist numbering) in step with its reservations.
// reserved_count = spots taken (reserved + checked_in); checked_in_count is a subset.
async function recountSession(env, sessionId) {
  if (!sessionId) return;
  const cnt = (st) => `(SELECT COUNT(*) FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.session_id') = ?1 AND json_extract(data,'$.status') IN (${st}))`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE entities SET data = json_set(data, '$.waitlist_position', (SELECT rn FROM (SELECT id AS rid, ROW_NUMBER() OVER (ORDER BY CAST(json_extract(data,'$.waitlist_position') AS INTEGER), json_extract(data,'$.booked_at'), created_date) AS rn FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.session_id') = ?1 AND json_extract(data,'$.status') = 'waitlisted') WHERE rid = entities.id))
       WHERE entity_type='Reservation' AND json_extract(data,'$.session_id') = ?1 AND json_extract(data,'$.status') = 'waitlisted'`
    ).bind(sessionId),
    env.DB.prepare(
      `UPDATE entities SET data = json_set(data, '$.reserved_count', ${cnt("'reserved','checked_in'")}, '$.waitlist_count', ${cnt("'waitlisted'")}, '$.checked_in_count', ${cnt("'checked_in'")}), updated_date = ?2
       WHERE id = ?1 AND entity_type = 'ClassSession'`
    ).bind(sessionId, nowISO()),
  ]);
}

async function classActorEmail(env, actor, session) {
  if (actor && isStaff(actor)) return actor.email;
  const coach = await staffLogin(env, session?.coach_user_id);
  if (coach) return coach.email;
  const row = await env.DB.prepare(`SELECT email FROM users WHERE user_type = 'trainer' ORDER BY created_date LIMIT 1`).first();
  return row?.email || (env.ADMIN_EMAILS || '').split(',')[0].trim() || null;
}
// Gym -> member notice (Notification row + push). Sent with server authority,
// so it bypasses pushForNotification's member->member block on purpose.
async function notifyClassMember(env, { loginId, title, message, createdBy }) {
  if (!loginId) return false;
  await insertEntity(env, 'Notification', { user_id: loginId, type: 'class', title, message, link: '/ClientClasses', read: false }, createdBy);
  const p = sendPushToUser(env, loginId, { title, body: String(message).slice(0, 140), url: '/ClientClasses', tag: 'classes' });
  if (env.__waitUntil) env.__waitUntil(p); else await p;
  return true;
}

// Move waitlisted people into free spots, oldest first, only before the
// late-cancel cutoff and only if one of their memberships still qualifies.
async function promoteWaitlist(env, session, s, actor) {
  if (!session || session.status !== 'scheduled') return [];
  const cutoff = Date.parse(session.start_at) - sessionRules(session, s).late_h * 3600000;
  if (Date.now() >= cutoff) return [];
  const waiting = (await selectEntities(env, 'Reservation',
    `json_extract(data,'$.session_id') = ? AND json_extract(data,'$.status') = 'waitlisted'`, [session.id]))
    .sort((a, b) => numOr(a.waitlist_position, 1e9) - numOr(b.waitlist_position, 1e9) || String(a.booked_at).localeCompare(String(b.booked_at)));
  const cap = capOf(session);
  const promoted = [];
  let createdBy = null;
  for (const r of waiting) {
    if (cap !== null) {
      const c = await env.DB.prepare(`SELECT ${RES_SPOT_COUNT} AS n`).bind(session.id).first();
      if ((c?.n || 0) >= cap) break;
    }
    const pick = await findClassMembership(env, { clientIds: [r.client_id], loginId: r.client_user_id || null }, session, s);
    if (!pick.membership) continue;
    const now = nowISO();
    const capSql = cap === null ? '1=1' : `${RES_SPOT_COUNT} < ?`;
    const res = await env.DB.prepare(
      `UPDATE entities SET data = json_set(data, '$.status', 'reserved', '$.waitlist_position', NULL, '$.membership_id', ?, '$.promoted_at', ?), updated_date = ?
       WHERE id = ? AND json_extract(data,'$.status') = 'waitlisted' AND ${capSql} AND ${pick.guard.sql}`
    ).bind(pick.membership.id, now, now, r.id, ...(cap === null ? [] : [session.id, cap]), ...pick.guard.binds).run();
    if (!res?.meta?.changes) continue;
    promoted.push(r.id);
    if (createdBy === null) createdBy = await classActorEmail(env, actor, session);
    await notifyClassMember(env, {
      loginId: r.client_user_id, createdBy,
      title: 'You are in',
      message: `A spot opened in ${session.class_type_name || 'class'} on ${classWhen(session)}. You moved off the waitlist and are booked.`,
    });
  }
  if (promoted.length) await recountSession(env, session.id);
  return promoted;
}

// Cancel every active reservation of a session (class cancelled by the gym).
async function cancelSessionReservations(env, session, actor, reason) {
  const active = await selectEntities(env, 'Reservation',
    `json_extract(data,'$.session_id') = ? AND json_extract(data,'$.status') IN (${sqlStr(ACTIVE_RES)})`, [session.id]);
  const createdBy = await classActorEmail(env, actor, session);
  let affected = 0; let notified = 0;
  for (const r of active) {
    const now = nowISO();
    const stmts = [];
    if (r.status === 'checked_in' && r.punch_applied && r.membership_id) {
      stmts.push(punchStmt(env, r.membership_id, -1,
        `SELECT 1 FROM entities WHERE id = ? AND json_extract(data,'$.status') = 'checked_in'`, [r.id]));
    }
    stmts.push(env.DB.prepare(
      `UPDATE entities SET data = json_set(data, '$.status', 'cancelled_by_gym', '$.cancelled_at', ?, '$.waitlist_position', NULL, '$.punch_applied', json('false')), updated_date = ?
       WHERE id = ? AND json_extract(data,'$.status') = ?`
    ).bind(now, now, r.id, r.status));
    const out = await env.DB.batch(stmts);
    if (!out[out.length - 1]?.meta?.changes) continue;
    affected++;
    if (await notifyClassMember(env, {
      loginId: r.client_user_id, createdBy,
      title: 'Class cancelled',
      message: `${session.class_type_name || 'Class'} on ${classWhen(session)} was cancelled${reason ? `: ${String(reason).slice(0, 80)}` : '.'}`,
    })) notified++;
  }
  await recountSession(env, session.id);
  return { affected, notified };
}

/* ---- session generation from weekly slots ---- */
function slotSessionFields(slot, type, date) {
  const startMin = hmToMin(slot.start_time);
  const duration = numOr(slot.duration_min, numOr(type?.default_duration_min, 60)) || 60;
  const startMs = easternToUTC(date, minToHm(startMin));
  const capRaw = numOr(slot.capacity, numOr(type?.default_capacity, null));
  return {
    class_type_id: slot.class_type_id,
    class_type_name: type?.name || '',
    color: type?.color || null,
    slot_id: slot.id,
    date,
    start_time: minToHm(startMin),
    end_time: minToHm(startMin + duration),
    duration_min: duration,
    start_at: new Date(startMs).toISOString(),
    end_at: new Date(startMs + duration * 60000).toISOString(),
    capacity: capRaw !== null && capRaw > 0 ? capRaw : null,
    coach_user_id: slot.coach_user_id || null,
    coach_name: slot.coach_name || '',
    reservable: type?.reservable !== false,
    booking_open_hours: numOr(slot.booking_open_hours, numOr(type?.booking_open_hours, null)),
  };
}
const TIME_FIELDS = ['date', 'start_time', 'end_time', 'duration_min', 'start_at', 'end_at', 'capacity'];
const LABEL_FIELDS = ['class_type_id', 'class_type_name', 'color', 'coach_user_id', 'coach_name', 'reservable', 'booking_open_hours'];

// Bring one slot's future sessions in line with it and generate to the horizon.
// Empty future sessions follow the slot; booked ones keep time and capacity
// (only coach / name / color follow) and are reported in booked_sessions.
// Sessions staff edited one by one (edited_manually) or cancelled are left alone.
async function syncSlotSessions(env, slot, type, s, now = Date.now()) {
  const out = { generated: 0, revived: 0, updated: 0, cancelled: 0, booked_kept: 0, booked_sessions: [] };
  const today = programToday(now);
  // Classes must exist at least as far ahead as members may book them.
  const openHours = numOr(slot.booking_open_hours, numOr(type?.booking_open_hours, s.booking_open_hours));
  const horizonDays = Math.min(62, Math.max(1, numOr(s.generate_days_ahead, 21), Math.ceil(openHours / 24) + 1));
  const horizonEnd = pAddDays(today, horizonDays - 1);
  const active = slot.is_active !== false && !!type && type.is_active !== false && hmToMin(slot.start_time) !== null
    && Number.isInteger(Number(slot.day_of_week));
  const wants = (date) => active && pDow(date) === Number(slot.day_of_week)
    && (!isDateKey(slot.start_date) || date >= slot.start_date) && (!isDateKey(slot.end_date) || date <= slot.end_date)
    && date >= today && date <= horizonEnd;

  const existing = await selectEntities(env, 'ClassSession',
    `json_extract(data,'$.slot_id') = ? AND json_extract(data,'$.date') >= ?`, [slot.id, today]);
  const bookedIds = new Set();
  for (let i = 0; i < existing.length; i += 50) {
    const chunk = existing.slice(i, i + 50).map((x) => x.id);
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT json_extract(data,'$.session_id') AS sid FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.session_id') IN (${inList(chunk)}) AND json_extract(data,'$.status') IN (${sqlStr(ACTIVE_RES)})`
    ).bind(...chunk).all();
    results.forEach((r) => bookedIds.add(r.sid));
  }
  for (const ex of existing) {
    if (Date.parse(ex.start_at) <= now) continue;
    if (ex.status === 'cancelled' && !ex.auto_cancelled) continue;
    if (ex.edited_manually) continue;
    const booked = bookedIds.has(ex.id);
    if (wants(ex.date)) {
      const want = slotSessionFields(slot, type, ex.date);
      if (ex.status === 'cancelled') {
        await patchEntity(env, ex, { ...want, status: 'scheduled', auto_cancelled: false, cancel_reason: null });
        out.revived++;
      } else if (!booked) {
        if ([...TIME_FIELDS, ...LABEL_FIELDS].some((k) => (ex[k] ?? null) !== (want[k] ?? null))) {
          await patchEntity(env, ex, want);
          out.updated++;
        }
      } else {
        const labels = Object.fromEntries(LABEL_FIELDS.filter((k) => k !== 'reservable' && k !== 'class_type_id').map((k) => [k, want[k]]));
        if (Object.keys(labels).some((k) => (ex[k] ?? null) !== (labels[k] ?? null))) await patchEntity(env, ex, labels);
        if (TIME_FIELDS.some((k) => (ex[k] ?? null) !== (want[k] ?? null))) {
          out.booked_kept++;
          out.booked_sessions.push({ id: ex.id, date: ex.date, start_time: ex.start_time, reserved_count: ex.reserved_count || 0 });
        }
      }
    } else if (ex.status !== 'cancelled') {
      if (!booked) {
        await patchEntity(env, ex, { status: 'cancelled', auto_cancelled: true, cancel_reason: 'Removed from the weekly schedule' });
        out.cancelled++;
      } else {
        out.booked_kept++;
        out.booked_sessions.push({ id: ex.id, date: ex.date, start_time: ex.start_time, reserved_count: ex.reserved_count || 0 });
      }
    }
  }

  if (active) {
    const stmts = [];
    for (let d = today; d <= horizonEnd; d = pAddDays(d, 1)) {
      if (!wants(d)) continue;
      const f = slotSessionFields(slot, type, d);
      if (Date.parse(f.start_at) <= now) continue;
      const data = { ...f, status: 'scheduled', cancel_reason: null, notes: '', reserved_count: 0, waitlist_count: 0, checked_in_count: 0 };
      stmts.push(env.DB.prepare(
        'INSERT OR IGNORE INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
      ).bind(`cs_${slot.id}_${d}`, 'ClassSession', JSON.stringify(data), slot.created_by || null, nowISO(), nowISO()));
    }
    if (stmts.length) {
      const res = await env.DB.batch(stmts);
      out.generated += res.reduce((n, r) => n + (r?.meta?.changes || 0), 0);
    }
  }
  return out;
}

function addSync(total, part) {
  for (const k of ['generated', 'revived', 'updated', 'cancelled', 'booked_kept']) total[k] = (total[k] || 0) + (part[k] || 0);
  total.booked_sessions = [...(total.booked_sessions || []), ...(part.booked_sessions || [])];
  return total;
}

async function syncSlotsWhere(env, s, whereSql, binds, overrideSlot = null) {
  const slots = overrideSlot ? [overrideSlot] : await selectEntities(env, 'ClassSlot', whereSql, binds);
  const typeCache = new Map();
  const total = { generated: 0, revived: 0, updated: 0, cancelled: 0, booked_kept: 0, booked_sessions: [] };
  for (const slot of slots) {
    if (!typeCache.has(slot.class_type_id)) typeCache.set(slot.class_type_id, await getEntityById(env, 'ClassType', slot.class_type_id));
    addSync(total, await syncSlotSessions(env, slot, typeCache.get(slot.class_type_id), s));
  }
  return total;
}

// Automatic tick: generate to the horizon, mark no-shows, expire old waitlists.
async function runClassTick(env) {
  const s = await getGymSettings(env);
  const summary = { success: true, ...(await syncSlotsWhere(env, s, '1=1', [])), no_shows: 0, waitlist_expired: 0 };
  const now = Date.now();
  const touched = new Set();
  const noShowCutoff = new Date(now - s.no_show_after_minutes * 60000).toISOString();
  const nowIso = new Date(now).toISOString();
  const jobs = [
    { status: 'reserved', cutoff: noShowCutoff, set: `'$.status', 'no_show', '$.no_show_at', ?, '$.auto_no_show', json('true')`, key: 'no_shows' },
    { status: 'waitlisted', cutoff: nowIso, set: `'$.status', 'cancelled', '$.cancelled_at', ?, '$.waitlist_position', NULL, '$.waitlist_expired', json('true')`, key: 'waitlist_expired' },
  ];
  for (const job of jobs) {
    const { results } = await env.DB.prepare(
      `SELECT r.id AS id, json_extract(r.data,'$.session_id') AS session_id FROM entities r
       JOIN entities cs ON cs.id = json_extract(r.data,'$.session_id') AND cs.entity_type = 'ClassSession'
       WHERE r.entity_type = 'Reservation' AND json_extract(r.data,'$.status') = ? AND json_extract(cs.data,'$.end_at') < ?`
    ).bind(job.status, job.cutoff).all();
    for (let i = 0; i < results.length; i += 50) {
      const chunk = results.slice(i, i + 50);
      const res = await env.DB.prepare(
        `UPDATE entities SET data = json_set(data, ${job.set}), updated_date = ?
         WHERE id IN (${inList(chunk)}) AND json_extract(data,'$.status') = ?`
      ).bind(nowIso, nowIso, ...chunk.map((r) => r.id), job.status).run();
      summary[job.key] += res?.meta?.changes || 0;
      chunk.forEach((r) => touched.add(r.session_id));
    }
  }
  for (const sid of touched) await recountSession(env, sid);
  return summary;
}

/* ---- entity-route hooks for class types (staff writes only) ---- */
// Fill derived fields on a ClassSession written through the entity API
// (one-off sessions, single-session edits). Mutates `fields`.
async function normalizeClassSession(env, fields, existing) {
  for (const k of ['reserved_count', 'waitlist_count', 'checked_in_count']) if (existing) delete fields[k];
  const merged = { ...(existing || {}), ...fields };
  const type = await getEntityById(env, 'ClassType', merged.class_type_id);
  if (!existing || ('class_type_id' in fields && fields.class_type_id !== existing.class_type_id)) {
    if (type) {
      if (fields.class_type_name === undefined) fields.class_type_name = type.name || '';
      if (fields.color === undefined) fields.color = type.color || null;
      if (fields.reservable === undefined) fields.reservable = type.reservable !== false;
      if (!existing && fields.capacity === undefined) fields.capacity = numOr(type.default_capacity, null);
      if (!existing && fields.booking_open_hours === undefined) fields.booking_open_hours = numOr(type.booking_open_hours, null);
    }
  }
  const timeKeys = ['date', 'start_time', 'end_time', 'duration_min'];
  const timeChanged = !existing || timeKeys.some((k) => k in fields && fields[k] !== existing[k]);
  if (timeChanged && isDateKey(merged.date) && hmToMin(merged.start_time) !== null) {
    const st = hmToMin(merged.start_time);
    // An explicit end_time wins; otherwise keep the duration (start moves, length stays).
    let dur = ('end_time' in fields && hmToMin(fields.end_time) !== null) || (numOr(merged.duration_min, null) === null && hmToMin(merged.end_time) !== null)
      ? hmToMin(merged.end_time) - st
      : numOr(merged.duration_min, numOr(type?.default_duration_min, 60));
    if (dur <= 0) dur += 1440;
    const startMs = easternToUTC(merged.date, minToHm(st));
    Object.assign(fields, {
      start_time: minToHm(st), end_time: minToHm(st + dur), duration_min: dur,
      start_at: new Date(startMs).toISOString(), end_at: new Date(startMs + dur * 60000).toISOString(),
    });
  }
  if (existing && (timeChanged || 'capacity' in fields)) fields.edited_manually = true;
  if (!existing) {
    if (fields.status === undefined) fields.status = 'scheduled';
    if (fields.slot_id === undefined) fields.slot_id = null;
    fields.reserved_count = 0; fields.waitlist_count = 0; fields.checked_in_count = 0;
  }
}

// Copy plan fields onto a new Membership (only fields the caller left out).
async function normalizeMembership(env, fields) {
  const plan = await getEntityById(env, 'MembershipPlan', fields.plan_id);
  const fill = (k, v) => { if (fields[k] === undefined) fields[k] = v; };
  if (plan) {
    fill('plan_name', plan.name || '');
    fill('kind', plan.kind || 'unlimited');
    fill('limit_count', plan.limit_count ?? null);
    fill('limit_period', plan.limit_period ?? null);
    fill('class_type_ids', Array.isArray(plan.class_type_ids) ? plan.class_type_ids : []);
    if (['punch', 'drop_in'].includes(fields.kind) || fields.limit_period === 'total') fill('sessions_total', numOr(plan.limit_count, null));
    if (isDateKey(fields.start_date) && numOr(plan.duration_days, null) && fields.end_date === undefined) {
      fields.end_date = pAddDays(fields.start_date, Number(plan.duration_days) - 1);
    }
  }
  fill('start_date', programToday());
  fill('end_date', null);
  fill('sessions_used', 0);
  fill('status', 'active');
  if (fields.client_id && (fields.client_name === undefined || fields.client_user_id === undefined)) {
    const client = await getEntityById(env, 'Client', fields.client_id);
    if (client) {
      fill('client_name', client.full_name || '');
      fill('client_user_id', (await clientLogin(env, client))?.id || client.user_id || null);
    }
  }
}

// After a staff write to a class entity: keep sessions / counts consistent.
// Returns an object merged into the API response as `class_sync`, or null.
async function afterClassEntityWrite(env, type, id, data, prev, user) {
  if (!isStaff(user)) return null;
  if (type === 'ClassSlot') {
    const s = await getGymSettings(env);
    const slot = data ? { ...data, id } : { ...(prev || {}), id, is_active: false };
    if (!data && prev) slot.created_by = prev.created_by;
    return syncSlotsWhere(env, s, '', [], slot);
  }
  if (type === 'ClassType') {
    const s = await getGymSettings(env);
    return syncSlotsWhere(env, s, `json_extract(data,'$.class_type_id') = ?`, [id]);
  }
  if (type === 'Reservation') {
    const ids = new Set([data?.session_id, prev?.session_id].filter(Boolean));
    for (const sid of ids) await recountSession(env, sid);
    return null;
  }
  if (type === 'ClassSession' && data) {
    const session = { ...data, id };
    if (session.status === 'cancelled' && prev && prev.status !== 'cancelled') {
      const r = await cancelSessionReservations(env, session, user, session.cancel_reason);
      return { cancelled_reservations: r.affected };
    }
    await recountSession(env, id);
    if (prev) {
      const fresh = await getEntityById(env, 'ClassSession', id);
      const promoted = await promoteWaitlist(env, fresh, await getGymSettings(env), user);
      return promoted.length ? { promoted: promoted.length } : null;
    }
  }
  return null;
}

// Member/staff summary: upcoming, recent, memberships with allowance, waiver.
async function classMemberSummary(env, who, s, { includeAll = false } = {}) {
  const today = programToday();
  const now = Date.now();
  const m = clientMatchSql(who);
  const reservations = await selectEntities(env, 'Reservation', m.sql, m.binds);
  const sessionIds = [...new Set(reservations.map((r) => r.session_id).filter(Boolean))];
  const sessions = new Map();
  for (let i = 0; i < sessionIds.length; i += 90) {
    const chunk = sessionIds.slice(i, i + 90);
    (await selectEntities(env, 'ClassSession', `id IN (${inList(chunk)})`, chunk)).forEach((x) => sessions.set(x.id, x));
  }
  const enrich = (r) => {
    const cs = sessions.get(r.session_id) || {};
    return {
      ...r,
      start_time: cs.start_time || null, end_time: cs.end_time || null, end_at: cs.end_at || null,
      color: cs.color || null, overrides: cs.overrides || null, reservable: cs.reservable !== false,
      coach_name: cs.coach_name || '', session_status: cs.status || null, class_name: r.class_name || cs.class_type_name || '',
    };
  };
  const all = reservations.map(enrich);
  const upcoming = all.filter((r) => ACTIVE_RES.includes(r.status) && (Date.parse(r.end_at || r.start_at) > now || r.date >= today))
    .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
  const recent = all.filter((r) => !['reserved', 'waitlisted'].includes(r.status) && Date.parse(r.start_at) <= now)
    .sort((a, b) => String(b.start_at).localeCompare(String(a.start_at))).slice(0, 30);
  const since = new Date(now - 30 * 864e5).toISOString();
  const last30 = all.filter((r) => r.start_at >= since && Date.parse(r.start_at) <= now);
  const memberships = await clientMemberships(env, who);
  const current = memberships.filter((x) => x.status !== 'ended' && (!isDateKey(x.end_date) || x.end_date >= today));
  const withAllowance = [];
  const weekCount = async (x, st, en) => (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.membership_id') = ? AND json_extract(data,'$.status') IN (${sqlStr(countedStatuses(s))}) AND json_extract(data,'$.date') BETWEEN ? AND ?`
  ).bind(x.id, st, en).first())?.n || 0;
  for (const x of current) {
    const allowance = await membershipAllowance(env, x, s, today);
    const bp = billingPeriod(x.start_date, today);
    withAllowance.push({
      ...x, allowance, remaining: allowance.remaining,
      used_this_week: await weekCount(x, classWeekStart(today), pAddDays(classWeekStart(today), 6)),
      used_this_month: await weekCount(x, bp.start, bp.end),
    });
  }
  const waiver = await waiverStatus(env, who);
  const out = {
    success: true,
    client: who.client ? { id: who.client.id, full_name: who.client.full_name || '', email: who.client.email || '' } : null,
    today,
    upcoming,
    recent,
    recent_attendance: recent,
    memberships: withAllowance,
    waiver: { required: !!s.waiver_required, signed: waiver.signed, contract_id: waiver.contract_id },
    stats: {
      visits_30d: last30.filter((r) => r.status === 'checked_in').length,
      no_shows_30d: last30.filter((r) => r.status === 'no_show').length,
      late_cancels_30d: last30.filter((r) => r.status === 'late_cancelled').length,
      total_visits: all.filter((r) => r.status === 'checked_in').length,
    },
    settings: s,
  };
  if (includeAll) out.all_memberships = memberships;
  return out;
}

const programSummary = (p) => (p ? {
  id: p.id, name: p.name, description: p.description, duration_weeks: p.duration_weeks,
  cover_image_url: p.cover_image_url, kind: p.kind || 'program', status: p.status,
} : null);

const emailShell = (title, bodyHtml) => `
  <div style="font-family:Inter,Arial,sans-serif;background:#F5F7FA;padding:32px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;border:1px solid #E4E9F0;padding:32px">
      <h2 style="margin:0 0 4px;color:#0F172A">Brigade Athletic Club</h2>
      <h3 style="margin:0 0 16px;color:#4B91DD">${title}</h3>
      <div style="color:#334155;font-size:15px;line-height:1.6">${bodyHtml}</div>
    </div>
  </div>`;

/* ---- health: errors, heartbeat, admin alerts ---- */
const CRON_STALE_MINUTES = 60; // the scheduled job runs every 15

async function getState(env, key) {
  return env.DB.prepare('SELECT value, updated_date FROM app_state WHERE key = ?').bind(key).first();
}
async function setState(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO app_state (key, value, updated_date) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_date = ?3'
  ).bind(key, String(value), nowISO()).run();
}
// True for one caller per window: stops the same alert going out repeatedly.
async function claimAlert(env, key, hours) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO app_state (key, value, updated_date) VALUES (?1,'1',?2)
     ON CONFLICT(key) DO UPDATE SET updated_date = ?2 WHERE app_state.updated_date < ?3`
  ).bind(`alert_${key}`, nowISO(), cutoff).run();
  return !!res?.meta?.changes;
}
async function alertAdmins(env, title, message) {
  const { results } = await env.DB.prepare('SELECT id, email, role FROM users').all();
  for (const u of results.filter((x) => resolveRole(env, x.email, x.role) === 'admin')) {
    await insertEntity(env, 'Notification', { user_id: u.id, type: 'system', title, message, link: '/AdminBugs', read: false }, 'system');
    await sendPushToUser(env, u.id, { title, body: message.slice(0, 140), url: '/AdminBugs', tag: 'system' });
  }
}
// Same error on the same day counts up on one row; admins hear about new ones,
// at most one alert an hour.
async function recordError(env, { source, message, page = '', detail = '' }) {
  try {
    const day = programToday();
    const msg = String(message || 'Unknown error').slice(0, 300);
    const id = (await sha256Hex(`${day}|${source}|${page}|${msg}`)).slice(0, 24);
    const now = nowISO();
    await env.DB.prepare(
      `INSERT INTO app_errors (id, day, source, message, page, detail, first_seen, last_seen) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)
       ON CONFLICT(id) DO UPDATE SET hits = hits + 1, last_seen = ?7`
    ).bind(id, day, source, msg, String(page).slice(0, 120), String(detail).slice(0, 600), now).run();
    const row = await env.DB.prepare('SELECT hits FROM app_errors WHERE id = ?').bind(id).first();
    if (row?.hits === 1 && (await claimAlert(env, 'error', 1))) await alertAdmins(env, 'App error', `${page ? `${page}: ` : ''}${msg}`);
    await env.DB.prepare('DELETE FROM app_errors WHERE last_seen < ?').bind(new Date(Date.now() - 30 * 86400000).toISOString()).run();
  } catch (e) { console.error('recordError failed', e?.message); }
}
// A stopped job can't report itself, so staff opening the app check on it.
async function checkHeartbeat(env) {
  const beat = await getState(env, 'cron_last_ok');
  if (!beat) return;
  const mins = (Date.now() - Date.parse(beat.updated_date)) / 60000;
  if (mins > CRON_STALE_MINUTES && (await claimAlert(env, 'cron', 6))) {
    await alertAdmins(env, 'Scheduled job stopped', `The 15-minute job last ran ${Math.round(mins)} minutes ago. Program messages and new classes are paused.`);
  }
}

const PUBLIC_FUNCTIONS = new Set(['getAppLogo', 'submitContact']);

async function runFunction(name, payload, ctx) {
  const { env, user, url } = ctx;
  switch (name) {
    case 'getAppLogo':
      return { logo_url: null };

    case 'getUserById': {
      // Public profile only: callers (client portal) need the trainer's name,
      // branding and portal feature switches. The full userRow includes email,
      // billing and beta-key data, so never return it here, and require login.
      if (!user) return { user: null };
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload?.userId || payload?.id).first();
      const u = userRow(row);
      if (!u) return { user: null };
      return {
        user: {
          id: u.id,
          full_name: u.full_name,
          role: u.role,
          user_type: u.user_type,
          business_name: u.business_name,
          business_logo_url: u.business_logo_url,
          avatar_url: u.avatar_url,
          client_portal_features: u.client_portal_features,
        },
      };
    }

    case 'submitContact': {
      await env.DB.prepare(
        'INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
      ).bind(uid(), 'ContactMessage', JSON.stringify(payload || {}), user?.id || null, nowISO(), nowISO()).run();
      return { success: true };
    }

    /* ---- accounts: invites, resets, team ---- */
    // Staff invite a client to the app; admins invite coaches. Returns the link
    // to share, and emails it when email is set up.
    case 'createInvite': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can invite people.' };
      let target;
      if (payload?.client_id) {
        const client = await getEntityById(env, 'Client', payload.client_id);
        if (!client) return { success: false, error: 'Client not found.' };
        if (!client.email) return { success: false, error: 'Add an email address to this client first.' };
        target = { email: client.email, full_name: client.full_name || '', user_type: 'client', client_id: client.id };
      } else {
        if (user.role !== 'admin') return { success: false, error: 'Only an admin can invite coaches.' };
        target = { email: String(payload?.email || ''), full_name: String(payload?.full_name || '').trim(), user_type: 'trainer' };
      }
      target.email = target.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.email)) return { success: false, error: 'That email address does not look right.' };
      const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(target.email).first();
      if (existing) return { success: false, error: 'This person already has an account.', code: 'has_account' };
      const link = await createAccountLink(env, url, { ...target, kind: 'invite', hours: INVITE_HOURS, created_by: user.email });
      await audit(env, { actor: user.email, action: 'invite_created', target: target.user_type, targetId: target.client_id || target.email, request: null });
      const sent = payload?.send_email === false ? { success: false } : await emailAccountLink(env, { kind: 'invite', to: target.email, name: target.full_name, link });
      return { success: true, link, emailed: !!sent.success, email: target.email, expires_days: INVITE_HOURS / 24 };
    }

    // Admin only: whoever holds this link can take over the account.
    case 'createResetLink': {
      if (!user || user.role !== 'admin') return { success: false, error: 'Only an admin can reset someone else\'s password.' };
      let row = null;
      if (payload?.client_id) {
        const login = await clientLogin(env, await getEntityById(env, 'Client', payload.client_id));
        if (login) row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(login.id).first();
      } else if (payload?.user_id) {
        row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.user_id).first();
      }
      if (!row) return { success: false, error: 'This person has no account yet. Send an invite instead.', code: 'no_account' };
      const link = await createAccountLink(env, url, { kind: 'reset', email: row.email, full_name: row.full_name, hours: STAFF_RESET_HOURS, created_by: user.email });
      await audit(env, { actor: user.email, action: 'reset_link_created', target: 'Account', targetId: row.id, request: null });
      return { success: true, link, email: row.email, expires_hours: STAFF_RESET_HOURS };
    }

    case 'systemStatus': {
      if (!user || user.role !== 'admin') return { success: false, error: 'Admins only.' };
      const beat = await getState(env, 'cron_last_ok');
      const { results } = await env.DB.prepare('SELECT id, day, source, message, page, hits, last_seen FROM app_errors ORDER BY last_seen DESC LIMIT 25').all();
      const mins = beat ? Math.round((Date.now() - Date.parse(beat.updated_date)) / 60000) : null;
      return { success: true, cron_last_ok: beat?.updated_date || null, cron_minutes_ago: mins, cron_ok: mins !== null && mins <= CRON_STALE_MINUTES, email_enabled: !!env.RESEND_API_KEY, errors: results };
    }

    case 'listTeam': {
      if (!user || user.role !== 'admin') return { success: false, error: 'Only an admin can see the team.' };
      const { results } = await env.DB.prepare(`SELECT * FROM users WHERE user_type = 'trainer' ORDER BY full_name`).all();
      const pending = await env.DB.prepare(
        `SELECT email, full_name, expires_date FROM account_tokens WHERE kind = 'invite' AND user_type = 'trainer' AND used_date IS NULL AND expires_date > ? ORDER BY created_date DESC`
      ).bind(nowISO()).all();
      return {
        success: true, email_enabled: !!env.RESEND_API_KEY,
        team: results.map(userRow).map((u) => ({ id: u.id, email: u.email, full_name: u.full_name, disabled: !!u.disabled, is_admin: resolveRole(env, u.email, u.role) === 'admin', is_me: u.id === user.id })),
        pending: pending.results,
      };
    }

    case 'setCoachAccess': {
      if (!user || user.role !== 'admin') return { success: false, error: 'Only an admin can change access.' };
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload?.user_id || '').first();
      if (!row) return { success: false, error: 'Account not found.' };
      if (row.id === user.id || resolveRole(env, row.email, row.role) === 'admin') return { success: false, error: 'Admin accounts can\'t be turned off here.' };
      const data = JSON.parse(row.data || '{}');
      data.disabled = !!payload.disabled;
      await env.DB.prepare('UPDATE users SET data = ?, updated_date = ? WHERE id = ?').bind(JSON.stringify(data), nowISO(), row.id).run();
      await audit(env, { actor: user.email, action: data.disabled ? 'access_off' : 'access_on', target: 'Account', targetId: row.id, request: null });
      return { success: true, disabled: data.disabled };
    }

    /* ---- Email ---- */
    case 'sendResourceEmail': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can send this.' };
      const to = payload?.to || payload?.clientEmail || payload?.email;
      if (!to) return { success: false, error: 'No recipient' };
      return sendEmail(env, {
        to,
        subject: payload?.subject || 'New resource from your trainer',
        html: emailShell(escHtml(payload?.title || 'New resource'), `
          <p>${escHtml(payload?.message || 'Your trainer shared a resource with you.')}</p>
          ${/^https?:\/\//.test(payload?.link || '') ? `<p><a href="${escHtml(payload.link)}" style="color:#4B91DD">Open resource</a></p>` : ''}`),
      });
    }

    case 'sendSessionReminder': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can send this.' };
      const to = payload?.clientEmail || payload?.to;
      if (!to) return { success: false, error: 'No recipient' };
      return sendEmail(env, {
        to,
        subject: 'Session reminder — Brigade Athletic Club',
        html: emailShell('Upcoming session', `
          <p>Reminder: you have a training session on <strong>${escHtml(payload?.date || '')} ${escHtml(payload?.time || '')}</strong>.</p>
          ${payload?.notes ? `<p>${escHtml(payload.notes)}</p>` : ''}`),
      });
    }

    case 'onNewClientOnboardingEmail':
      return { success: true };

    /* ---- Food search (USDA FoodData Central) ---- */
    case 'searchFoods': {
      if (!env.USDA_API_KEY) return { foods: [] };
      const q = encodeURIComponent(payload?.query || '');
      const size = Math.min(Number(payload?.pageSize) || 10, 25);
      const resp = await fetch(
        `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${env.USDA_API_KEY}&query=${q}&pageSize=${size}&dataType=Foundation,SR%20Legacy,Branded`
      );
      if (!resp.ok) return { foods: [], error: `USDA ${resp.status}` };
      const out = await resp.json();
      const nut = (f, ids) => {
        const n = (f.foodNutrients || []).find((x) => ids.includes(x.nutrientId));
        return n ? Math.round(n.value) : 0;
      };
      const foods = (out.foods || []).map((f) => ({
        name: f.description,
        brand: f.brandOwner || null,
        calories: nut(f, [1008, 2047, 2048]),
        protein: nut(f, [1003]),
        carbs: nut(f, [1005]),
        fat: nut(f, [1004]),
        serving: f.servingSize ? `${f.servingSize}${f.servingSizeUnit || 'g'}` : '100g',
        fdcId: f.fdcId,
      }));
      return { foods };
    }

    /* ---- Exercise search (ExerciseDB w/ videos & images, AscendAPI) ---- */
    case 'searchExercises': {
      const out = await edbFetch(env, `/api/v1/exercises/search?search=${encodeURIComponent(payload?.search || payload?.query || '')}`);
      if (!out?.success) return { exercises: [], error: out?.error };
      const exercises = (out.data || []).map((e) => ({
        id: e.exerciseId,
        exerciseId: e.exerciseId,
        name: e.name,
        gifUrl: e.imageUrl, // legacy field name used across the UI
        imageUrl: e.imageUrl,
      }));
      return { exercises };
    }

    case 'getExerciseById': {
      const out = await edbFetch(env, `/api/v1/exercises/${encodeURIComponent(payload?.id || payload?.exerciseId || '')}`);
      if (!out?.success) return { exercise: null, error: out?.error };
      const d = out.data || {};
      return {
        exercise: {
          id: d.exerciseId,
          exerciseId: d.exerciseId,
          name: d.name,
          gifUrl: d.imageUrl,
          imageUrl: d.imageUrl,
          imageUrls: d.imageUrls,
          videoUrl: d.videoUrl,
          bodyPart: (d.bodyParts || [])[0]?.toLowerCase(),
          bodyParts: d.bodyParts,
          target: (d.targetMuscles || [])[0]?.toLowerCase(),
          targetMuscles: d.targetMuscles,
          secondaryMuscles: d.secondaryMuscles,
          equipment: (d.equipments || [])[0]?.toLowerCase(),
          equipments: d.equipments,
          exerciseType: d.exerciseType,
          overview: d.overview,
          instructions: d.instructions,
        },
      };
    }

    case 'getExerciseData': {
      // Reference lists (muscles, body parts, equipment, exercise types)
      const kind = payload?.kind || payload?.type || 'bodyparts';
      const path = { muscles: '/api/v1/muscles', bodyparts: '/api/v1/bodyparts', equipments: '/api/v1/equipments', exercisetypes: '/api/v1/exercisetypes' }[kind];
      if (!path) return { data: [] };
      const out = await edbFetch(env, path);
      return { data: out?.data || [] };
    }

    /* ---- Web Push (subscriptions; VAPID) ---- */
    case 'webPush': {
      if (!user) return { success: false, error: 'Not logged in' };
      const action = payload?.action;
      if (action === 'getPublicKey') return { publicKey: env.VAPID_PUBLIC_KEY || null };
      if (action === 'subscribe') {
        const sub = payload?.subscription;
        if (!sub?.endpoint) return { success: false, error: 'No subscription' };
        const existing = await env.DB.prepare(
          `SELECT id FROM entities WHERE entity_type='PushSubscription' AND json_extract(data,'$.endpoint') = ? LIMIT 1`
        ).bind(sub.endpoint).first();
        const data = JSON.stringify({ ...sub, user_id: user.id, user_email: user.email });
        if (existing) {
          await env.DB.prepare('UPDATE entities SET data=?, updated_date=? WHERE id=?').bind(data, nowISO(), existing.id).run();
        } else {
          await env.DB.prepare(
            'INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
          ).bind(uid(), 'PushSubscription', data, user.email, nowISO(), nowISO()).run();
        }
        return { success: true };
      }
      if (action === 'unsubscribe') {
        const endpoint = payload?.subscription?.endpoint;
        if (endpoint) {
          await env.DB.prepare(
            `DELETE FROM entities WHERE entity_type='PushSubscription' AND json_extract(data,'$.endpoint') = ?`
          ).bind(endpoint).run();
        }
        return { success: true };
      }
      if (action === 'test' || action === 'sendTest') {
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { success: false, error: 'Push notifications are not configured.' };
        const sent = await sendPushToUser(env, user.id, { title: 'Brigade', body: 'Notifications are working.', url: '/', tag: 'test' });
        return sent > 0 ? { success: true, sent } : { success: false, error: 'No device is set up for notifications yet.' };
      }
      return { success: false, error: `Unknown webPush action: ${action}` };
    }

    case 'aiVoiceCoach': {
      // Text-based post-workout analysis (the voice UI was removed; this powers
      // the "AI analysis" card after logging a workout).
      const wd = payload?.workoutData || {};
      const result = await invokeLLM(
        {
          prompt: `A client just completed a workout: ${JSON.stringify(wd)}. Client profile: ${JSON.stringify({
            goals: ctx.user?.goals, fitness_level: ctx.user?.fitness_level,
          })}. Give a short post-workout analysis.`,
          response_json_schema: {
            type: 'object',
            properties: {
              performance: { type: 'string', description: 'One sentence on how the session went' },
              recovery: { type: 'string', description: 'One sentence of recovery advice' },
              nutrition: { type: 'string', description: 'One sentence on what to eat now' },
              highlight: { type: 'string', description: 'One short encouraging highlight' },
            },
          },
        },
        env
      );
      if (result && !result.__stub && typeof result === 'object') {
        return { success: true, data: result };
      }
      return { success: false };
    }

    /* ---- AI personalized recovery plan ---- */
    case 'aiPersonalizedPlans': {
      const plan = await invokeLLM(
        {
          prompt: `Create a personalized recovery plan for this client. Profile: ${JSON.stringify(payload?.clientProfile || {})}. Recent workout activity count: ${(payload?.workoutLogs || []).length}. Give practical, specific guidance for each area in two to four sentences, and a mobility routine of four to six movements with how long and how often to do each.`,
          response_json_schema: {
            type: 'object',
            properties: {
              sleep_optimization: { type: 'string' },
              nutrition_timing: { type: 'string' },
              stress_management: { type: 'string' },
              active_recovery_days: { type: 'string' },
              deload_schedule: { type: 'string' },
              mobility_routine: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    exercise: { type: 'string' },
                    description: { type: 'string' },
                    duration_minutes: { type: 'number' },
                    frequency: { type: 'string' },
                  },
                  required: ['exercise', 'description', 'duration_minutes', 'frequency'],
                },
              },
              expected_outcomes: { type: 'string' },
            },
            required: ['sleep_optimization', 'nutrition_timing', 'stress_management', 'active_recovery_days', 'deload_schedule', 'mobility_routine', 'expected_outcomes'],
          },
        },
        env
      );
      if (plan && !plan.__stub && typeof plan === 'object') return { success: true, data: plan };
      return { success: false };
    }

    /* ---- Journal: rotating reflection prompt ---- */
    case 'generateJournalPrompt': {
      const PROMPTS = [
        'What was your biggest win today, and what is one thing you want to improve tomorrow?',
        'How did your body feel during training today? What was your energy like?',
        "What is one healthy choice you made today that you're proud of?",
        'Describe a moment today when you felt strong or capable.',
        'What got in the way of your goals today, and how will you handle it next time?',
        'How well did you sleep, and how did it affect your day?',
        'What are you grateful for in your fitness journey right now?',
        'Rate your stress today 1-10 and note what drove it.',
        'What is one small habit you want to lock in this week?',
        'If today had a theme, what would it be and why?',
      ];
      return { prompt: PROMPTS[Math.floor(Math.random() * PROMPTS.length)] };
    }

    /* ---- Journal summary: AI trainer-facing summary + sentiment,
            written back onto the JournalEntry ---- */
    case 'summarizeJournalEntry': {
      if (!user) return { success: false, error: 'Not logged in' };
      const entryId = payload?.entry_id;
      const content = String(payload?.content || '').slice(0, 4000);
      if (!entryId || !content.trim()) return { success: false };

      const out = await invokeLLM(
        {
          prompt: `A fitness client wrote this journal entry. (1) trainer_summary: summarize it for their trainer in 1-2 sentences (third person using "the client" or they/them, never guess gender from a name; professional; flag anything the trainer should follow up on). (2) athlete_insight: 1-2 short sentences written to the athlete as "you": one specific, practical takeaway from what they wrote, encouraging but not gushing. If they mention pain or injury, suggest easing off and checking with a coach or medical professional; do not diagnose. (3) Classify overall sentiment. Entry: """${content}"""`,
          response_json_schema: {
            type: 'object',
            properties: {
              trainer_summary: { type: 'string' },
              athlete_insight: { type: 'string' },
              sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
            },
            required: ['trainer_summary', 'athlete_insight', 'sentiment'],
          },
        },
        env
      );
      if (!out || out.__stub || !out.trainer_summary) return { success: false };

      const row = await env.DB.prepare(
        `SELECT data FROM entities WHERE id=? AND entity_type='JournalEntry' AND created_by=? LIMIT 1`
      ).bind(entryId, user.email).first();
      if (!row) return { success: false };
      let data; try { data = JSON.parse(row.data); } catch { return { success: false }; }
      data.trainer_summary = out.trainer_summary;
      if (out.athlete_insight) data.athlete_insight = String(out.athlete_insight).slice(0, 600);
      data.sentiment = out.sentiment || 'neutral';
      await env.DB.prepare('UPDATE entities SET data=?, updated_date=? WHERE id=?')
        .bind(JSON.stringify(data), nowISO(), entryId).run();
      return { success: true };
    }

    /* ---- Recovery prescription: AI protocol from today's sleep/stress logs,
            stored as an AI_SYSTEM ClientNote the Recovery page renders ---- */
    case 'generateRecoveryPrescription': {
      if (!user) return { success: false, error: 'Not logged in' };
      const clientId = payload?.client_id || user.id;
      const date = payload?.date || nowISO().split('T')[0];

      // Pull today's readiness logs for this client.
      const pick = async (type) => {
        const row = await env.DB.prepare(
          `SELECT data FROM entities WHERE entity_type=? AND json_extract(data,'$.client_id')=? AND json_extract(data,'$.date')=? ORDER BY created_date DESC LIMIT 1`
        ).bind(type, clientId, date).first();
        try { return row ? JSON.parse(row.data) : null; } catch { return null; }
      };
      const sleep = await pick('SleepLog');
      const stress = await pick('StressLog');

      const result = await invokeLLM(
        {
          prompt: `You are a certified recovery coach (NASM/ISSA aligned). Write a concise same-day recovery protocol in Markdown for a client based on today's readiness data. Data: sleep hours=${sleep?.hours_slept ?? 'unknown'}, sleep quality (1-5)=${sleep?.quality_rating ?? 'unknown'}, stress level (1-10)=${stress?.stress_level ?? 'unknown'}, stressors="${(stress?.stressors || 'none listed').slice(0, 300)}". Use short sections with bold headers: **Readiness Verdict** (one line: Train as planned / Reduce intensity / Prioritize rest), **Training Adjustment**, **Recovery Actions** (3-4 bullets), **Sleep Tonight** (1-2 bullets). Keep it under 180 words, practical and specific. No medical diagnosis.`,
        },
        env
      );
      const note = typeof result === 'string' ? result : result?.text || result?.response || null;
      if (!note || result?.__stub) return { success: false };

      const now = nowISO();
      await env.DB.prepare(
        'INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
      ).bind(
        uid(), 'ClientNote',
        JSON.stringify({ client_id: clientId, trainer_id: 'AI_SYSTEM', note: `Recovery Protocol — ${date}\n\n${note}`, date }),
        user.email, now, now
      ).run();
      return { success: true };
    }

    /* ---- Google Sheets import: reads a link-shared sheet via its CSV
            export (no OAuth needed) and creates/updates records ---- */
    case 'importFromGoogleSheets': {
      if (!user) return { success: false, error: 'Not logged in' };
      const sheetId = String(payload?.spreadsheetId || '').trim();
      const sheetName = String(payload?.sheetName || '').trim();
      const dataType = payload?.dataType === 'exercises' ? 'exercises' : 'clients';
      if (!sheetId) return { success: false, error: 'Missing spreadsheet ID' };

      const csvUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv${sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : ''}`;
      let csv;
      try {
        const resp = await fetch(csvUrl, { redirect: 'follow' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        csv = await resp.text();
      } catch (e) {
        return { success: false, error: 'Could not read the sheet. Make sure link sharing is set to "Anyone with the link can view".' };
      }
      if (!csv || csv.trim().startsWith('<')) {
        return { success: false, error: 'Sheet is not publicly readable. Set link sharing to "Anyone with the link can view" and try again.' };
      }

      // Minimal CSV parser (handles quoted fields with commas/newlines).
      const rows = [];
      {
        let row = [], field = '', inQ = false;
        for (let i = 0; i < csv.length; i++) {
          const c = csv[i];
          if (inQ) {
            if (c === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
          } else if (c === '"') inQ = true;
          else if (c === ',') { row.push(field); field = ''; }
          else if (c === '\n' || c === '\r') {
            if (c === '\r' && csv[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some(v => v.trim() !== '')) rows.push(row);
            row = [];
          } else field += c;
        }
        row.push(field);
        if (row.some(v => v.trim() !== '')) rows.push(row);
      }
      if (rows.length < 2) return { success: false, error: 'The sheet needs a header row plus at least one data row.' };

      const headers = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
      const dataRows = rows.slice(1, 501); // sanity cap
      const now = nowISO();
      let imported = 0;
      const errors = [];

      for (let r = 0; r < dataRows.length; r++) {
        const rec = {};
        headers.forEach((h, i) => { if (h) rec[h] = (dataRows[r][i] || '').trim(); });
        try {
          if (dataType === 'clients') {
            const email = (rec.email || '').toLowerCase();
            const fullName = rec.name || rec.full_name || '';
            if (!fullName && !email) throw new Error('missing name and email');
            const data = {
              full_name: fullName, email, phone: rec.phone || '',
              age: rec.age ? Number(rec.age) || null : null,
              gender: rec.gender || '', goals: rec.goals || '',
              medical_notes: rec.medical_notes || rec.notes || '',
              weight_kg: rec.weight ? Number(rec.weight) || null : null,
              height_cm: rec.height ? Number(rec.height) || null : null,
              status: 'active', trainer_id: user.id,
            };
            const existing = email ? await env.DB.prepare(
              `SELECT id, data FROM entities WHERE entity_type='Client' AND created_by=? AND json_extract(data,'$.email')=? LIMIT 1`
            ).bind(user.email, email).first() : null;
            if (existing) {
              let prev = {}; try { prev = JSON.parse(existing.data); } catch {}
              await env.DB.prepare('UPDATE entities SET data=?, updated_date=? WHERE id=?')
                .bind(JSON.stringify({ ...prev, ...data }), now, existing.id).run();
            } else {
              await env.DB.prepare('INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)')
                .bind(uid(), 'Client', JSON.stringify(data), user.email, now, now).run();
            }
          } else {
            if (!rec.name) throw new Error('missing name');
            const data = {
              name: rec.name, description: rec.description || '',
              category: rec.category || 'general', difficulty: rec.difficulty || '',
              sets: rec.sets ? Number(rec.sets) || null : null,
              reps: rec.reps || '', rest: rec.rest || '', trainer_id: user.id,
            };
            await env.DB.prepare('INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)')
              .bind(uid(), 'Exercise', JSON.stringify(data), user.email, now, now).run();
          }
          imported++;
        } catch (e) {
          errors.push({ row: r + 2, error: e.message || 'invalid row' });
        }
      }
      await audit(env, { actor: user.email, action: 'import', target: 'GoogleSheets', targetId: sheetId, detail: `${dataType}: ${imported}/${dataRows.length}` });
      return { success: true, imported, total: dataRows.length, errors };
    }

    /* ---- Generate a set of standard PT form resources ---- */
    case 'generatePTForms': {
      if (!user) return { success: false, error: 'Not logged in' };
      const now = nowISO();
      const forms = [
        { title: 'PAR-Q Health Questionnaire', category: 'general', description: 'Physical Activity Readiness Questionnaire to screen new clients before starting a program.' },
        { title: 'Liability Waiver & Release', category: 'general', description: 'Standard liability waiver and assumption-of-risk release for personal training.' },
        { title: 'Client Intake Form', category: 'general', description: 'Collect health history, goals, injuries, and contraindications for new clients.' },
        { title: 'Medical Release Form', category: 'general', description: 'Physician clearance form for higher-risk clients before beginning exercise.' },
      ];
      for (const f of forms) {
        const existing = await env.DB.prepare(
          `SELECT id FROM entities WHERE entity_type='Resource' AND created_by=? AND json_extract(data,'$.title')=? LIMIT 1`
        ).bind(user.email, f.title).first();
        if (existing) continue;
        await env.DB.prepare(
          'INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
        ).bind(uid(), 'Resource', JSON.stringify({ ...f, type: 'form', trainer_id: user.id, is_standard_form: true }), user.email, now, now).run();
      }
      return { success: true };
    }

    /* ---- Coach's Briefing (Claude's addition) ----
       A daily AI triage of the trainer's roster: wins, who needs attention,
       and one focus tip — computed from real activity, cached per day. */
    case 'coachBriefing': {
      if (!user) return { success: false, error: 'Not logged in' };
      const today = nowISO().split('T')[0];

      if (!payload?.force) {
        const cached = await env.DB.prepare(
          `SELECT * FROM entities WHERE entity_type='CoachBriefing' AND created_by=? AND json_extract(data,'$.date')=? LIMIT 1`
        ).bind(user.email, today).first();
        if (cached) return { success: true, cached: true, briefing: JSON.parse(cached.data).briefing };
      }

      // Gather the roster and the last 7 days of activity
      const clients = await listEntities(env, 'Client', { filter: { trainer_id: user.id }, user });
      if (clients.length === 0) {
        return { success: true, briefing: null, empty: true };
      }
      const since = new Date(Date.now() - 7 * 864e5).toISOString().split('T')[0];
      const [logs, progress, messages] = await Promise.all([
        listEntities(env, 'WorkoutLog', { filter: { trainer_id: user.id }, user }),
        listEntities(env, 'ProgressLog', { filter: { trainer_id: user.id }, user }),
        listEntities(env, 'Message', { filter: { receiver_id: user.id, read: false }, user }),
      ]);
      const roster = clients.slice(0, 25).map((c) => {
        const cLogs = logs.filter((l) => l.client_id === c.id && (l.date || '') >= since);
        const cProg = progress.filter((l) => l.client_id === c.id && (l.date || '') >= since);
        const lastLog = logs.filter((l) => l.client_id === c.id).map((l) => l.date).sort().pop() || null;
        return {
          name: c.full_name,
          status: c.status,
          workouts_last_7d: cLogs.length,
          progress_entries_last_7d: cProg.length,
          last_workout_date: lastLog,
        };
      });

      const briefing = await invokeLLM(
        {
          prompt: `Today is ${today}. You are an assistant for personal trainer ${user.full_name}. Here is their client roster with the last 7 days of activity: ${JSON.stringify(roster)}. Unread messages: ${messages.length}. Write a short morning briefing.`,
          response_json_schema: {
            type: 'object',
            properties: {
              headline: { type: 'string', description: 'One-sentence summary of the roster today' },
              wins: {
                type: 'array',
                items: { type: 'object', properties: { client: { type: 'string' }, note: { type: 'string' } } },
                description: 'Up to 3 clients doing great and why (one short sentence each)',
              },
              needs_attention: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    client: { type: 'string' },
                    reason: { type: 'string' },
                    suggestion: { type: 'string', description: 'One concrete action for the trainer' },
                  },
                },
                description: 'Up to 3 clients slipping (inactive, no logs) with a concrete next step',
              },
              focus_tip: { type: 'string', description: 'One coaching focus for the trainer today' },
            },
          },
        },
        env
      );

      if (briefing && !briefing.__stub && typeof briefing === 'object') {
        await env.DB.prepare(
          'INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
        ).bind(uid(), 'CoachBriefing', JSON.stringify({ date: today, trainer_id: user.id, briefing }), user.email, nowISO(), nowISO()).run();
        return { success: true, briefing };
      }
      return { success: false };
    }

    case 'syncWorkoutToCalendar':
      return { success: true, stubbed: true };

    /* ---- Import a recipe from any URL: fetch → strip HTML → AI extracts ---- */
    case 'parseRecipeFromText': {
      const url = payload?.recipe_url || payload?.url || '';
      let content = payload?.text || '';
      if (!content && /^https?:\/\//i.test(url)) {
        try {
          const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Brigade recipe importer)' } });
          const html = await r.text();
          content = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&[a-z]+;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 8000);
        } catch {
          return { success: false, error: 'Could not fetch that URL.' };
        }
      }
      if (!content) return { success: false, error: 'No recipe content to parse.' };
      const recipe = await invokeLLM(
        {
          prompt: `Extract the recipe from this web page text. Provide a clear name, a short description, a category (breakfast, lunch, dinner, snack, dessert or drink), each ingredient split into name, amount and unit, the instructions as numbered steps on separate lines, servings, prep and cook time in minutes, and estimated per-serving calories, protein, carbs and fat. Web page text:\n\n${content}`,
          response_json_schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              category: { type: 'string' },
              // Matches the app's Recipe model (Recipes, Resources, client view).
              ingredients: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { name: { type: 'string' }, amount: { type: 'string' }, unit: { type: 'string' } },
                  required: ['name', 'amount', 'unit'],
                },
              },
              instructions: { type: 'string' },
              servings: { type: 'number' },
              prep_time_minutes: { type: 'number' },
              cook_time_minutes: { type: 'number' },
              calories_per_serving: { type: 'number' },
              protein_per_serving: { type: 'number' },
              carbs_per_serving: { type: 'number' },
              fat_per_serving: { type: 'number' },
            },
            required: ['name', 'description', 'category', 'ingredients', 'instructions', 'servings', 'prep_time_minutes', 'cook_time_minutes', 'calories_per_serving', 'protein_per_serving', 'carbs_per_serving', 'fat_per_serving'],
          },
        },
        env
      );
      // Guard against pages that blocked the fetch (consent walls, bot pages):
      // a real recipe has a plausible name AND at least a couple of ingredients.
      const badName = !recipe?.name || /no recipe|not available|unavailable|n\/?a/i.test(recipe.name);
      const ingredientCount = Array.isArray(recipe?.ingredients) ? recipe.ingredients.length : 0;
      if (badName || ingredientCount < 2) {
        return { success: false, error: 'Couldn\'t read a recipe from that link. Some sites block automated imports — try a different source or add the recipe manually.' };
      }
      return { success: true, recipe };
    }

    /* ---- Programs (docs/programs-spec.md) ---- */
    case 'enrollInProgram': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can enroll clients.' };
      const { program_id, client_id } = payload || {};
      const start_date = payload?.start_date || programToday();
      if (!isDateKey(start_date)) return { success: false, error: 'start_date must be yyyy-MM-dd.' };
      const program = await getEntityById(env, 'Program', program_id);
      if (!program) return { success: false, error: 'Program not found.' };
      const client = await getEntityById(env, 'Client', client_id);
      if (!client) return { success: false, error: 'Client not found.' };
      const dup = await env.DB.prepare(
        `SELECT id FROM entities WHERE entity_type='ProgramEnrollment' AND json_extract(data,'$.program_id') = ?
         AND json_extract(data,'$.client_id') = ? AND json_extract(data,'$.status') IN ('active','paused') LIMIT 1`
      ).bind(program_id, client_id).first();
      if (dup) return { success: false, error: `${client.full_name || 'This client'} is already in ${program.name || 'this program'}.`, enrollment_id: dup.id };
      const login = await clientLogin(env, client);
      const enrollment = await insertEntity(env, 'ProgramEnrollment', {
        program_id,
        program_name: program.name || '',
        client_id,
        client_user_id: login?.id || null,
        trainer_id: client.trainer_id || user.id,
        start_date,
        status: 'active',
        overrides: [],
        extra_items: [],
      }, user.email);
      const { items } = await loadProgramAndItems(env, program_id);
      await syncProgramHabits(env, enrollment, materializeProgram(enrollment, items, program), user.email);
      await audit(env, { actor: user.email, action: 'create', target: 'ProgramEnrollment', targetId: enrollment.id, request: null });
      return { success: true, enrollment };
    }

    case 'unenrollFromProgram': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can change enrollments.' };
      const enr = await getEntityById(env, 'ProgramEnrollment', payload?.enrollment_id);
      if (!enr) return { success: false, error: 'Enrollment not found.' };
      const enrollment = await patchEntity(env, enr, { status: 'cancelled', cancelled_at: nowISO() });
      await syncProgramHabits(env, enrollment, [], user.email);
      await audit(env, { actor: user.email, action: 'update', target: 'ProgramEnrollment', targetId: enr.id, detail: 'cancelled', request: null });
      return { success: true, enrollment };
    }

    case 'updateEnrollment': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can change enrollments.' };
      const enr = await getEntityById(env, 'ProgramEnrollment', payload?.enrollment_id);
      if (!enr) return { success: false, error: 'Enrollment not found.' };
      const patch = {};
      if (payload.overrides !== undefined) patch.overrides = cleanOverrides(payload.overrides);
      if (payload.extra_items !== undefined) patch.extra_items = cleanExtraItems(payload.extra_items);
      if (payload.start_date !== undefined) {
        if (!isDateKey(payload.start_date)) return { success: false, error: 'start_date must be yyyy-MM-dd.' };
        patch.start_date = payload.start_date;
      }
      if (payload.status !== undefined) {
        if (!['active', 'paused', 'completed', 'cancelled'].includes(payload.status)) return { success: false, error: 'Invalid status.' };
        patch.status = payload.status;
      }
      const enrollment = await patchEntity(env, enr, patch);
      const { program, items } = await loadProgramAndItems(env, enrollment.program_id);
      await syncProgramHabits(env, enrollment, materializeProgram(enrollment, items, program), user.email);
      await audit(env, { actor: user.email, action: 'update', target: 'ProgramEnrollment', targetId: enr.id, request: null });
      return { success: true, enrollment };
    }

    case 'programTick': {
      if (!user) return { success: false, error: 'Not logged in' };
      if (isStaff(user)) return runProgramTick(env, payload?.enrollment_id ? { enrollmentId: payload.enrollment_id } : {});
      const cids = await myClientIds(env, user);
      const mine = await selectEntities(env, 'ProgramEnrollment',
        `json_extract(data,'$.status') = 'active' AND (json_extract(data,'$.client_user_id') = ?${cids.length ? ` OR json_extract(data,'$.client_id') IN (${inList(cids)})` : ''})`,
        [user.id, ...cids]);
      return runProgramTick(env, { enrollmentIds: mine.map((e) => e.id) });
    }

    case 'programCalendar': {
      if (!user) return { success: false, error: 'Not logged in' };
      if (!payload?.enrollment_id) return { success: false, error: 'enrollment_id is required.' };
      const row = await getScopedEntity(env, 'ProgramEnrollment', payload.enrollment_id, user);
      if (!row) return { success: false, error: 'Enrollment not found.' };
      const enrollment = rowToEntity(row);
      if (!isDateKey(enrollment.start_date)) return { success: false, error: 'Enrollment has no start date.' };
      const { program, items } = await loadProgramAndItems(env, enrollment.program_id);
      const length = programLength(program, items);
      const from = isDateKey(payload?.from) ? payload.from : enrollment.start_date;
      let to = isDateKey(payload?.to) ? payload.to : pDateForDay(enrollment.start_date, length);
      if (to < from) return { success: false, error: '"to" is before "from".' };
      if (pDaysBetween(from, to) > 400) to = pAddDays(from, 400);
      const built = await buildProgramDays(env, enrollment, from, to, { includeSkipped: isStaff(user) });
      return {
        success: true,
        enrollment,
        program: programSummary(program),
        program_days: length,
        today: built.today,
        today_day: pDayNumberFor(enrollment.start_date, built.today),
        days: built.days,
      };
    }

    case 'programTodayForMe': {
      if (!user) return { success: false, error: 'Not logged in' };
      const cids = await myClientIds(env, user);
      const mine = await selectEntities(env, 'ProgramEnrollment',
        `json_extract(data,'$.status') = 'active' AND (json_extract(data,'$.client_user_id') = ?${cids.length ? ` OR json_extract(data,'$.client_id') IN (${inList(cids)})` : ''})`,
        [user.id, ...cids]);
      const today = programToday();
      const cache = new Map();
      const enrollments = [];
      for (const enrollment of mine) {
        if (!isDateKey(enrollment.start_date)) continue;
        const built = await buildProgramDays(env, enrollment, today, today, { includeSkipped: false, cache });
        const day = pDayNumberFor(enrollment.start_date, today);
        const lessons = built.eff
          .filter((it) => it.type === 'lesson' && !it.skipped && it.eff_day <= day)
          .map((it) => {
            const c = built.completionByItem.get(it.item_id);
            return {
              item_id: it.item_id,
              day: it.eff_day,
              date: pDateForDay(enrollment.start_date, it.eff_day),
              lesson_id: it.lesson_id || null,
              lesson: built.lessonById.get(it.lesson_id) || null,
              completed: !!c,
              completion: c || null,
            };
          });
        enrollments.push({
          enrollment,
          program: programSummary(built.program),
          program_days: programLength(built.program, (await loadProgramAndItems(env, enrollment.program_id, cache)).items),
          day,
          started: day >= 1,
          items: built.days[0]?.items || [],
          lessons,
        });
      }
      return { success: true, today, enrollments };
    }

    /* ---- Group classes (docs/classes-spec.md) ---- */
    case 'classSchedule': {
      if (!user) return { success: false, error: 'Not logged in' };
      const s = await getGymSettings(env);
      const today = programToday();
      const from = isDateKey(payload?.from) ? payload.from : today;
      let to = isDateKey(payload?.to) ? payload.to : pAddDays(from, 6);
      if (to < from) return { success: false, error: '"to" is before "from".' };
      if (pDaysBetween(from, to) > 62) to = pAddDays(from, 62);
      const sessions = (await selectEntities(env, 'ClassSession',
        `json_extract(data,'$.date') BETWEEN ? AND ? AND COALESCE(json_extract(data,'$.auto_cancelled'),0) = 0`, [from, to]))
        .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
      const staff = isStaff(user);
      let mine = new Map();
      const attendees = new Map();
      if (!staff) {
        const cids = await myClientIds(env, user);
        const who = { clientIds: cids.length ? cids : ['__none__'], loginId: user.id };
        const cm = clientMatchSql(who);
        const myRes = await selectEntities(env, 'Reservation',
          `json_extract(data,'$.date') BETWEEN ? AND ? AND ${cm.sql}`, [from, to, ...cm.binds]);
        const rank = (r) => (ACTIVE_RES.includes(r.status) ? 0 : ['no_show', 'late_cancelled'].includes(r.status) ? 1 : 2);
        for (const r of myRes.sort((a, b) => rank(a) - rank(b) || String(b.booked_at).localeCompare(String(a.booked_at)))) {
          if (!mine.has(r.session_id)) mine.set(r.session_id, { id: r.id, status: r.status, waitlist_position: r.waitlist_position ?? null, checked_in_at: r.checked_in_at || null });
        }
        if (s.show_roster_to_members) {
          const { results } = await env.DB.prepare(
            `SELECT json_extract(data,'$.session_id') AS session_id, json_extract(data,'$.client_name') AS client_name, json_extract(data,'$.booked_at') AS booked_at
             FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.date') BETWEEN ? AND ? AND json_extract(data,'$.status') IN ('reserved','checked_in')
             ORDER BY json_extract(data,'$.booked_at')`
          ).bind(from, to).all();
          for (const r of results) {
            if (!attendees.has(r.session_id)) attendees.set(r.session_id, []);
            attendees.get(r.session_id).push({ name: shortName(r.client_name) });
          }
        }
      }
      const out = sessions.map((cs) => {
        const cap = capOf(cs);
        const row = {
          ...cs,
          capacity: cap,
          spots_left: cap === null ? null : Math.max(0, cap - (cs.reserved_count || 0)),
          is_full: cap !== null && (cs.reserved_count || 0) >= cap,
          windows: sessionWindows(cs, s),
        };
        if (!staff) {
          row.my_reservation = mine.get(cs.id) || null;
          if (s.show_roster_to_members) row.attendees = attendees.get(cs.id) || [];
        }
        return row;
      });
      return { success: true, from, to, today, now: nowISO(), settings: s, sessions: out };
    }

    case 'classRoster': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can see the full roster.' };
      const session = await getEntityById(env, 'ClassSession', payload?.session_id);
      if (!session) return { success: false, error: 'Class not found.' };
      const s = await getGymSettings(env);
      const order = { checked_in: 0, reserved: 1, waitlisted: 2, no_show: 3, late_cancelled: 4, cancelled: 5, cancelled_by_gym: 6 };
      const reservations = (await selectEntities(env, 'Reservation', `json_extract(data,'$.session_id') = ?`, [session.id]))
        .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)
          || numOr(a.waitlist_position, 0) - numOr(b.waitlist_position, 0)
          || String(a.booked_at).localeCompare(String(b.booked_at)));
      const memIds = [...new Set(reservations.map((r) => r.membership_id).filter(Boolean))];
      const mems = new Map();
      if (memIds.length) (await selectEntities(env, 'Membership', `id IN (${inList(memIds)})`, memIds)).forEach((m) => mems.set(m.id, m));
      const waivers = new Map();
      for (const cid of [...new Set(reservations.map((r) => r.client_id))]) {
        const r0 = reservations.find((r) => r.client_id === cid);
        waivers.set(cid, (await waiverStatus(env, { clientIds: [cid], loginId: r0?.client_user_id || null })).signed);
      }
      return {
        success: true,
        session: { ...session, windows: sessionWindows(session, s) },
        reservations: reservations.map((r) => ({
          ...r,
          membership_name: mems.get(r.membership_id)?.plan_name || null,
          membership_kind: mems.get(r.membership_id)?.kind || null,
          waiver_signed: waivers.get(r.client_id) || false,
        })),
      };
    }

    case 'myClasses': {
      if (!user) return { success: false, error: 'Not logged in' };
      const s = await getGymSettings(env);
      const who = await resolveClassClient(env, isStaff(user) ? { ...user, role: 'user', user_type: 'client' } : user, null);
      if (who.error) {
        return { success: true, client: null, today: programToday(), upcoming: [], recent: [], memberships: [], waiver: { required: !!s.waiver_required, signed: false, contract_id: null }, stats: null, settings: s, notice: who.error };
      }
      return classMemberSummary(env, who, s);
    }

    case 'classMemberStatus': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can see member status.' };
      const who = await resolveClassClient(env, user, payload?.client_id);
      if (who.error) return { success: false, error: who.error };
      return classMemberSummary(env, who, await getGymSettings(env), { includeAll: true });
    }

    case 'classCoaches': {
      // Staff picker for slots/sessions (User.list is admin-only for trainers).
      if (!isStaff(user)) return { success: false, error: 'Only coaches can see this.' };
      const { results } = await env.DB.prepare(`SELECT * FROM users ORDER BY full_name`).all();
      const coaches = results.map(userRow).map((u) => ({ ...u, role: resolveRole(env, u.email, u.role) }))
        .filter(isStaff).map((u) => ({ id: u.id, full_name: u.full_name || u.email, email: u.email }));
      return { success: true, coaches };
    }

    case 'bookClass': {
      if (!user) return { success: false, error: 'Not logged in' };
      const staff = isStaff(user);
      const s = await getGymSettings(env);
      const session = await getEntityById(env, 'ClassSession', payload?.session_id);
      if (!session) return { success: false, error: 'Class not found.' };
      if (session.status !== 'scheduled') return { success: false, error: 'This class was cancelled.', code: 'class_cancelled' };
      if (session.reservable === false) return { success: false, error: 'This class does not take reservations. Check in when you arrive.', code: 'not_reservable' };
      const now = Date.now();
      const w = sessionWindows(session, s);
      if (!staff) {
        if (now < Date.parse(w.booking_opens_at)) return { success: false, error: `Booking for this class opens ${new Date(w.booking_opens_at).toLocaleString('en-US', { timeZone: PROGRAM_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`, code: 'booking_not_open' };
        if (now > Date.parse(w.booking_closes_at)) return { success: false, error: 'Booking for this class has closed.', code: 'booking_closed' };
      } else if (now > Date.parse(session.end_at)) {
        return { success: false, error: 'This class is over. Use check-in to record attendance.', code: 'class_over' };
      }
      const who = await resolveClassClient(env, user, payload?.client_id);
      if (who.error) return { success: false, error: who.error, code: 'no_client' };
      const warnings = [];
      const override = staff && !!payload?.override;
      if (s.waiver_required && !(await waiverStatus(env, who)).signed) {
        if (!staff) return { success: false, error: 'Sign the liability waiver before booking a class. You can find it under Documents.', code: 'waiver_required' };
        warnings.push('No signed waiver on file.');
      }
      let reservation = null;
      for (let attempt = 0; attempt < 3 && !reservation; attempt++) {
        const pick = await findClassMembership(env, who, session, s);
        if (!pick.membership && !override) {
          return { success: false, error: staff ? pick.reason.replace(/^You have/, 'This client has') : pick.reason, code: pick.code, ...(staff ? { can_override: true } : {}) };
        }
        if (!pick.membership) warnings.push('Booked without a covering membership (staff override).');
        const data = {
          session_id: session.id, class_type_id: session.class_type_id, class_name: session.class_type_name || '',
          date: session.date, start_at: session.start_at,
          client_id: who.client.id, client_user_id: who.loginId || null, client_name: who.client.full_name || '',
          status: 'reserved', waitlist_position: null, membership_id: pick.membership?.id || null,
          booked_at: nowISO(), cancelled_at: null, checked_in_at: null, check_in_method: null, booked_by: user.id,
          ...(pick.membership ? {} : { membership_override: true }),
        };
        const ins = reservationInsert(env, { data, createdBy: user.email, session, clientIds: who.clientIds, guard: pick.guard, mode: override ? 'force' : 'spot' });
        const r1 = await ins.stmt.run();
        if (r1?.meta?.changes) { reservation = await getEntityById(env, 'Reservation', ins.id); break; }
        // Why not? Already booked / class cancelled / allowance used / full.
        const fresh = await getEntityById(env, 'ClassSession', session.id);
        if (!fresh || fresh.status !== 'scheduled') return { success: false, error: 'This class was cancelled.', code: 'class_cancelled' };
        const dup = await env.DB.prepare(
          `SELECT json_extract(data,'$.status') AS status FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.session_id') = ? AND json_extract(data,'$.client_id') IN (${inList(who.clientIds)}) AND json_extract(data,'$.status') IN (${sqlStr(ACTIVE_RES)}) LIMIT 1`
        ).bind(session.id, ...who.clientIds).first();
        if (dup) return { success: false, error: dup.status === 'waitlisted' ? 'You are already on the waitlist for this class.' : 'You are already booked in this class.', code: 'already_booked' };
        const cap = capOf(session);
        const c = await env.DB.prepare(`SELECT ${RES_SPOT_COUNT} AS n`).bind(session.id).first();
        if (cap === null || (c?.n || 0) < cap) continue; // allowance changed underneath us: re-pick
        if (!s.waitlist_enabled) return { success: false, error: 'Class is full.', code: 'class_full', ...(staff ? { can_override: true } : {}) };
        const wl = reservationInsert(env, { data: { ...data, status: 'waitlisted' }, createdBy: user.email, session, clientIds: who.clientIds, guard: null, mode: 'waitlist' });
        const r2 = await wl.stmt.run();
        if (r2?.meta?.changes) reservation = await getEntityById(env, 'Reservation', wl.id);
      }
      if (!reservation) return { success: false, error: 'Could not book this class. Refresh and try again.', code: 'retry' };
      await recountSession(env, session.id);
      if (reservation.status === 'waitlisted') reservation = await getEntityById(env, 'Reservation', reservation.id);
      await audit(env, { actor: user.email, action: 'create', target: 'Reservation', targetId: reservation.id, detail: reservation.status, request: null });
      return { success: true, status: reservation.status, reservation, session: await getEntityById(env, 'ClassSession', session.id), warnings };
    }

    case 'cancelReservation': {
      if (!user) return { success: false, error: 'Not logged in' };
      const staff = isStaff(user);
      const resv = await getEntityById(env, 'Reservation', payload?.reservation_id);
      if (!resv) return { success: false, error: 'Reservation not found.' };
      if (!staff) {
        const cids = await myClientIds(env, user);
        if (!cids.includes(resv.client_id) && resv.client_user_id !== user.id) return { success: false, error: 'Reservation not found.' };
      }
      if (!['reserved', 'waitlisted'].includes(resv.status)) return { success: false, error: 'This reservation can no longer be cancelled.', code: 'not_cancellable' };
      const s = await getGymSettings(env);
      const session = await getEntityById(env, 'ClassSession', resv.session_id);
      const now = Date.now();
      const start = Date.parse(session?.start_at || resv.start_at);
      if (!staff && now >= start) return { success: false, error: 'This class has already started.', code: 'class_started' };
      const lateCut = start - sessionRules(session || {}, s).late_h * 3600000;
      const late = resv.status === 'reserved' && now >= lateCut && !(staff && payload?.waive_late_cancel);
      const newStatus = late ? 'late_cancelled' : 'cancelled';
      const ts = nowISO();
      const res = await env.DB.prepare(
        `UPDATE entities SET data = json_set(data, '$.status', ?, '$.cancelled_at', ?, '$.waitlist_position', NULL, '$.cancelled_by', ?), updated_date = ?
         WHERE id = ? AND entity_type = 'Reservation' AND json_extract(data,'$.status') = ?`
      ).bind(newStatus, ts, user.id, ts, resv.id, resv.status).run();
      if (!res?.meta?.changes) return { success: false, error: 'This reservation just changed. Refresh and try again.', code: 'retry' };
      await recountSession(env, resv.session_id);
      let promoted = [];
      if (resv.status === 'reserved' && session) {
        promoted = await promoteWaitlist(env, await getEntityById(env, 'ClassSession', session.id), s, user);
      }
      await audit(env, { actor: user.email, action: 'update', target: 'Reservation', targetId: resv.id, detail: newStatus, request: null });
      return {
        success: true, late_cancel: late, status: newStatus, promoted: promoted.length,
        reservation: await getEntityById(env, 'Reservation', resv.id),
        session: await getEntityById(env, 'ClassSession', resv.session_id),
      };
    }

    case 'checkIn': {
      if (!user) return { success: false, error: 'Not logged in' };
      const staff = isStaff(user);
      const s = await getGymSettings(env);
      let resv = null;
      if (payload?.reservation_id && staff) resv = await getEntityById(env, 'Reservation', payload.reservation_id);
      const session = await getEntityById(env, 'ClassSession', resv?.session_id || payload?.session_id);
      if (!session) return { success: false, error: 'Class not found.' };
      if (session.status !== 'scheduled') return { success: false, error: 'This class was cancelled.', code: 'class_cancelled' };
      const who = await resolveClassClient(env, user, resv?.client_id || payload?.client_id);
      if (who.error) return { success: false, error: who.error, code: 'no_client' };
      const now = Date.now();
      const w = sessionWindows(session, s);
      if (!staff) {
        if (now < Date.parse(w.checkin_opens_at)) return { success: false, error: `Check-in opens ${s.self_checkin_before_minutes} minutes before class.`, code: 'checkin_not_open' };
        if (now > Date.parse(w.checkin_closes_at)) return { success: false, error: 'Check-in for this class has closed.', code: 'checkin_closed' };
      } else if (session.date > programToday()) {
        return { success: false, error: 'You can check people in on the day of the class.', code: 'checkin_not_open' };
      }
      if (!resv) {
        const mine = await selectEntities(env, 'Reservation',
          `json_extract(data,'$.session_id') = ? AND json_extract(data,'$.client_id') IN (${inList(who.clientIds)}) AND json_extract(data,'$.status') IN ('reserved','waitlisted','checked_in','no_show')`,
          [session.id, ...who.clientIds]);
        const rank = { checked_in: 0, reserved: 1, waitlisted: 2, no_show: 3 };
        resv = mine.sort((a, b) => rank[a.status] - rank[b.status])[0] || null;
      }
      if (resv && resv.status === 'checked_in') return { success: true, already: true, reservation: resv, session, warnings: [] };
      const warnings = [];
      const override = staff && !!payload?.override;
      if (s.waiver_required && !(await waiverStatus(env, who)).signed) {
        if (!staff) return { success: false, error: 'Sign the liability waiver before checking in. You can find it under Documents.', code: 'waiver_required' };
        warnings.push('No signed waiver on file.');
      }
      const ts = nowISO();
      const method = staff ? 'coach' : 'self';
      const usable = resv && (resv.status === 'reserved' || (staff && ['no_show', 'waitlisted'].includes(resv.status)));
      if (resv && resv.status === 'waitlisted' && !staff) return { success: false, error: 'You are on the waitlist for this class.', code: 'waitlisted' };

      let resultId = null;
      if (usable) {
        if (resv.status === 'waitlisted' && !override) {
          const cap = capOf(session);
          const c = await env.DB.prepare(`SELECT ${RES_SPOT_COUNT} AS n`).bind(session.id).first();
          if (cap !== null && (c?.n || 0) >= cap) return { success: false, error: 'Class is full.', code: 'class_full', can_override: true };
        }
        const mem = resv.membership_id ? await getEntityById(env, 'Membership', resv.membership_id) : null;
        const punch = !!(mem && membershipLimit(mem)?.period === 'total');
        const stmts = [];
        if (punch) {
          stmts.push(punchStmt(env, mem.id, 1,
            `SELECT 1 FROM entities WHERE id = ? AND json_extract(data,'$.status') = ?`, [resv.id, resv.status]));
        }
        stmts.push(env.DB.prepare(
          `UPDATE entities SET data = json_set(data, '$.status', 'checked_in', '$.checked_in_at', ?, '$.check_in_method', ?, '$.waitlist_position', NULL, '$.punch_applied', json(?), '$.checked_in_by', ?), updated_date = ?
           WHERE id = ? AND entity_type = 'Reservation' AND json_extract(data,'$.status') = ?`
        ).bind(ts, method, punch ? 'true' : 'false', user.id, ts, resv.id, resv.status));
        const out = await env.DB.batch(stmts);
        if (!out[out.length - 1]?.meta?.changes) return { success: false, error: 'This reservation just changed. Refresh and try again.', code: 'retry' };
        resultId = resv.id;
      } else {
        // No reservation: book-and-check-in (reservable), open gym, or staff walk-in.
        const pick = await findClassMembership(env, who, session, s);
        if (!pick.membership && !override) {
          return { success: false, error: staff ? pick.reason.replace(/^You have/, 'This client has') : pick.reason, code: pick.code, ...(staff ? { can_override: true } : {}) };
        }
        if (!pick.membership) warnings.push('Checked in without a covering membership (staff override).');
        const punch = !!(pick.membership && membershipLimit(pick.membership)?.period === 'total');
        const data = {
          session_id: session.id, class_type_id: session.class_type_id, class_name: session.class_type_name || '',
          date: session.date, start_at: session.start_at,
          client_id: who.client.id, client_user_id: who.loginId || null, client_name: who.client.full_name || '',
          status: 'checked_in', waitlist_position: null, membership_id: pick.membership?.id || null,
          booked_at: ts, cancelled_at: null, checked_in_at: ts,
          check_in_method: staff ? 'walk_in' : 'self', booked_by: user.id, checked_in_by: user.id,
          created_at_checkin: true, punch_applied: punch,
          ...(pick.membership ? {} : { membership_override: true }),
        };
        const ins = reservationInsert(env, { data, createdBy: user.email, session, clientIds: who.clientIds, guard: pick.guard, mode: override ? 'force' : 'spot' });
        const stmts = [ins.stmt];
        if (punch) stmts.push(punchStmt(env, pick.membership.id, 1, `SELECT 1 FROM entities WHERE id = ?`, [ins.id]));
        const out = await env.DB.batch(stmts);
        if (!out[0]?.meta?.changes) {
          const cap = capOf(session);
          const c = await env.DB.prepare(`SELECT ${RES_SPOT_COUNT} AS n`).bind(session.id).first();
          if (cap !== null && (c?.n || 0) >= cap) return { success: false, error: 'Class is full.', code: 'class_full', ...(staff ? { can_override: true } : {}) };
          return { success: false, error: 'Could not check in. Refresh and try again.', code: 'retry' };
        }
        resultId = ins.id;
      }
      await recountSession(env, session.id);
      await audit(env, { actor: user.email, action: 'update', target: 'Reservation', targetId: resultId, detail: 'checked_in', request: null });
      return { success: true, reservation: await getEntityById(env, 'Reservation', resultId), session: await getEntityById(env, 'ClassSession', session.id), warnings };
    }

    case 'undoCheckIn':
    case 'markNoShow': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can change attendance.' };
      let resv = payload?.reservation_id ? await getEntityById(env, 'Reservation', payload.reservation_id) : null;
      if (!resv && payload?.session_id && payload?.client_id) {
        const want = name === 'undoCheckIn' ? ['checked_in'] : ['reserved', 'checked_in'];
        resv = (await selectEntities(env, 'Reservation',
          `json_extract(data,'$.session_id') = ? AND json_extract(data,'$.client_id') = ? AND json_extract(data,'$.status') IN (${sqlStr(want)})`,
          [payload.session_id, payload.client_id]))[0] || null;
      }
      if (!resv) return { success: false, error: 'Reservation not found.' };
      const ts = nowISO();
      let newStatus;
      if (name === 'undoCheckIn') {
        if (resv.status !== 'checked_in') return { success: false, error: 'This person is not checked in.', code: 'not_checked_in' };
        newStatus = resv.created_at_checkin ? 'cancelled' : 'reserved';
      } else {
        if (!['reserved', 'checked_in'].includes(resv.status)) return { success: false, error: 'Only booked or checked-in reservations can be marked as a no-show.', code: 'invalid_status' };
        const session = await getEntityById(env, 'ClassSession', resv.session_id);
        if (session && Date.now() < Date.parse(session.start_at)) return { success: false, error: 'You can mark a no-show once the class has started.', code: 'class_not_started' };
        newStatus = 'no_show';
      }
      const stmts = [];
      if (resv.status === 'checked_in' && resv.punch_applied && resv.membership_id) {
        stmts.push(punchStmt(env, resv.membership_id, -1,
          `SELECT 1 FROM entities WHERE id = ? AND json_extract(data,'$.status') = 'checked_in'`, [resv.id]));
      }
      const extra = newStatus === 'no_show' ? `, '$.no_show_at', '${ts}'` : newStatus === 'cancelled' ? `, '$.cancelled_at', '${ts}'` : '';
      stmts.push(env.DB.prepare(
        `UPDATE entities SET data = json_set(data, '$.status', ?, '$.checked_in_at', NULL, '$.punch_applied', json('false')${extra}), updated_date = ?
         WHERE id = ? AND entity_type = 'Reservation' AND json_extract(data,'$.status') = ?`
      ).bind(newStatus, ts, resv.id, resv.status));
      const out = await env.DB.batch(stmts);
      if (!out[out.length - 1]?.meta?.changes) return { success: false, error: 'This reservation just changed. Refresh and try again.', code: 'retry' };
      await recountSession(env, resv.session_id);
      await audit(env, { actor: user.email, action: 'update', target: 'Reservation', targetId: resv.id, detail: newStatus, request: null });
      return { success: true, reservation: await getEntityById(env, 'Reservation', resv.id), session: await getEntityById(env, 'ClassSession', resv.session_id) };
    }

    case 'cancelClassSession': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can cancel a class.' };
      const session = await getEntityById(env, 'ClassSession', payload?.session_id);
      if (!session) return { success: false, error: 'Class not found.' };
      if (session.status === 'cancelled') return { success: false, error: 'This class is already cancelled.' };
      const reason = String(payload?.reason || '').trim().slice(0, 300) || null;
      const res = await env.DB.prepare(
        `UPDATE entities SET data = json_set(data, '$.status', 'cancelled', '$.cancel_reason', ?, '$.cancelled_at', ?, '$.cancelled_by', ?, '$.auto_cancelled', json('false')), updated_date = ?
         WHERE id = ? AND entity_type = 'ClassSession' AND json_extract(data,'$.status') != 'cancelled'`
      ).bind(reason, nowISO(), user.id, nowISO(), session.id).run();
      if (!res?.meta?.changes) return { success: false, error: 'This class is already cancelled.' };
      const fresh = await getEntityById(env, 'ClassSession', session.id);
      const r = await cancelSessionReservations(env, fresh, user, reason);
      await audit(env, { actor: user.email, action: 'update', target: 'ClassSession', targetId: session.id, detail: `cancelled; ${r.affected} reservations`, request: null });
      return { success: true, session: await getEntityById(env, 'ClassSession', session.id), affected: r.affected, notified: r.notified };
    }

    case 'classTick': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can run this.' };
      return runClassTick(env);
    }

    // Content browse helpers — empty until curated content sources are added.
    case 'getCuratedRecipes':
    case 'searchResourceSources':
      return { results: [], items: [], recipes: [] };

    default:
      return { __unimplemented: true };
  }
}

/* -------------------------------- LLM ----------------------------------- */

// Provider order: Anthropic (if LLM_API_KEY set, best quality) → Cloudflare
// Workers AI (env.AI binding, no key needed, free tier) → stub message.
// Load an image URL (or data: URL) into bytes + base64 for vision models.
async function loadImage(url) {
  try {
    let bytes;
    let mediaType = 'image/jpeg';
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) return null;
      mediaType = m[1];
      const bin = atob(m[2]);
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } else {
      const r = await fetch(url);
      if (!r.ok) return null;
      mediaType = r.headers.get('content-type') || 'image/jpeg';
      bytes = new Uint8Array(await r.arrayBuffer());
    }
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return { bytes, base64: btoa(bin), mediaType };
  } catch {
    return null;
  }
}

/* ---------------------------- Claude (primary) --------------------------- */
// Claude via the official SDK is the primary model whenever LLM_API_KEY is set;
// Workers AI is the fallback. Default: Claude Haiku 5.5 (override LLM_MODEL).
const CLAUDE_DEFAULT_MODEL = 'claude-haiku-5-5';

// Structured outputs require additionalProperties:false on every object and
// reject numeric/length constraints, so normalize the app's ad-hoc schemas.
function toStrictSchema(node) {
  if (Array.isArray(node)) return node.map(toStrictSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
         'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'pattern'].includes(k)) continue;
    out[k] = (k === 'properties')
      ? Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, toStrictSchema(pv)]))
      : toStrictSchema(v);
  }
  const isObject = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'));
  if (isObject) {
    out.properties = out.properties || {};
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Returns parsed JSON (schema) or text, or null when Claude can't answer
// (API error, refusal, truncation) so the caller can fall back.
async function callClaude(env, { prompt, schema, img }) {
  const client = new Anthropic({ apiKey: env.LLM_API_KEY });
  const content = [];
  if (img) {
    const media_type = CLAUDE_IMAGE_TYPES.has(img.mediaType) ? img.mediaType : 'image/jpeg';
    content.push({ type: 'image', source: { type: 'base64', media_type, data: img.base64 } });
  }
  content.push({ type: 'text', text: prompt });
  try {
    const response = await client.messages.create({
      model: env.LLM_MODEL || CLAUDE_DEFAULT_MODEL,
      max_tokens: 16000,
      system: 'You are an expert fitness and nutrition coaching assistant for Brigade Athletic Club. Be specific and practical. Never give medical diagnoses. Refer to people neutrally (they/them) unless the input states their pronouns.',
      output_config: {
        effort: 'low',
        ...(schema ? { format: { type: 'json_schema', schema: toStrictSchema(schema) } } : {}),
      },
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      console.error('claude stopped:', response.stop_reason, response.stop_details?.category || '');
      return null;
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!schema) return text;
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error('claude auth failed: check LLM_API_KEY');
    else if (e instanceof Anthropic.RateLimitError) console.error('claude rate limited');
    else if (e instanceof Anthropic.APIError) console.error('claude api error', e.status, e.message);
    else console.error('claude call failed', e?.message || String(e));
    return null;
  }
}

async function invokeLLM(payload, env) {
  const prompt = payload?.prompt || '';
  const schema = payload?.response_json_schema;
  const imageUrl = Array.isArray(payload?.file_urls) ? payload.file_urls[0] : payload?.file_url || null;
  // If the caller asked for image analysis, never silently fall through to the
  // text model — it would happily invent a plausible meal for a photo it never
  // saw. Fail loudly instead so the UI can say "we couldn't read that image".
  const wantedVision = 'file_urls' in (payload || {}) || 'file_url' in (payload || {});
  if (wantedVision && !imageUrl) {
    return schema
      ? { __stub: true, error: 'no_image', message: 'No image was received. Please try again.' }
      : { __stub: true, message: 'No image was received. Please try again.' };
  }
  const sys = schema
    ? `Respond with ONLY valid JSON matching this schema, no prose or markdown fences: ${JSON.stringify(schema)}`
    : 'You are a helpful fitness coaching assistant.';

  const parseOut = (text) => {
    if (text && typeof text === 'object') return text; // model returned structured output
    text = String(text ?? '');
    if (!schema) return text;
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      try { return m ? JSON.parse(m[0]) : { text }; } catch { return { text }; }
    }
  };

  /* ---- Vision path: an image was supplied (meal scanner, form check) ---- */
  if (imageUrl) {
    const img = await loadImage(imageUrl);
    if (!img) return schema ? {} : { __stub: true, message: 'Could not read the image.' };

    // Primary: Claude reads the image and answers in one call.
    if (env.LLM_API_KEY) {
      const out = await callClaude(env, { prompt, schema, img });
      if (out != null) return out;
    }

    // Free path: a multimodal Workers AI model reads the image and answers in
    // one step. (llava-1.5-7b was retired by Cloudflare on 2026-11-20.)
    // Override with VISION_MODEL; the next model in the list is the fallback.
    if (env.AI) {
      let mime = img.mediaType || 'image/jpeg';
      if (!/^image\//.test(mime)) mime = 'image/jpeg';
      const dataUri = `data:${mime};base64,${img.base64}`;
      // Plain-text mode with a JSON instruction: Workers AI vision models hung
      // with response_format + image in testing. Time-boxed so it can't stall.
      // Not a reasoning model: gemma-4 spends its token budget on hidden
      // reasoning_content and returns empty content (tested 2026-11-20).
      const model = env.VISION_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct';
      try {
        const run = env.AI.run(model, {
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUri } },
            ] },
          ],
          max_tokens: 1024,
        });
        // Llama 4 Scout takes ~45s on a 768px meal photo; 45s cut off real answers.
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 90s')), 90000));
        const out = await Promise.race([run, timeout]);
        const parsed = parseOut(out?.response ?? out?.choices?.[0]?.message?.content ?? '');
        const empty = !parsed || (typeof parsed === 'object' && Object.keys(parsed).length === 0)
          || (schema && typeof parsed === 'object' && 'text' in parsed && Object.keys(parsed).length === 1);
        if (!empty) return parsed;
        console.error('vision fallback returned nothing usable:', model);
      } catch (e) {
        console.error('vision fallback failed:', model, e?.message || String(e), 'bytes=', img.bytes.length);
      }
      return schema ? {} : { __stub: true, message: 'Image analysis is temporarily unavailable.' };
    }
    return schema ? {} : { __stub: true, message: 'AI vision is not configured.' };
  }

  if (env.LLM_API_KEY) {
    const out = await callClaude(env, { prompt, schema });
    if (out != null) return out;
  }

  if (env.AI) {
    const model = env.WORKERS_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: prompt },
    ];
    // With a schema, use Workers AI JSON mode so the model is constrained to
    // valid JSON. Free-form prompting alone regularly produced malformed JSON
    // (e.g. missing commas), which parsed into a useless { text } blob.
    if (schema) {
      try {
        const out = await env.AI.run(model, {
          messages,
          max_tokens: 2048,
          response_format: { type: 'json_schema', json_schema: schema },
        });
        const parsed = parseOut(out?.response ?? '');
        if (parsed && typeof parsed === 'object' && !('text' in parsed && Object.keys(parsed).length === 1)) {
          return parsed;
        }
      } catch { /* model without JSON mode support: fall through */ }
    }
    const out = await env.AI.run(model, { messages, max_tokens: 2048 });
    return parseOut(out?.response ?? '');
  }

  return {
    __stub: true,
    message: 'AI is not configured. Add the Workers AI binding (ai.binding = "AI") or set LLM_API_KEY.',
  };
}

/* ------------------------------- router --------------------------------- */

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      full_name TEXT, role TEXT DEFAULT 'user', user_type TEXT, data TEXT DEFAULT '{}',
      created_date TEXT NOT NULL, updated_date TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
      created_by TEXT, created_date TEXT NOT NULL, updated_date TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type)`,
    `CREATE INDEX IF NOT EXISTS idx_entities_type_created ON entities(entity_type, created_date)`,
    `CREATE INDEX IF NOT EXISTS idx_entities_created_by ON entities(created_by)`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, actor TEXT, action TEXT NOT NULL, target TEXT,
      target_id TEXT, detail TEXT, ip TEXT, created_date TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS account_tokens (
      token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL, user_type TEXT,
      client_id TEXT, full_name TEXT, created_by TEXT, created_date TEXT NOT NULL,
      expires_date TEXT NOT NULL, used_date TEXT)`,
    `CREATE TABLE IF NOT EXISTS app_errors (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, page TEXT, detail TEXT,
      hits INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_app_errors_seen ON app_errors(last_seen)`,
    `CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_date TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_account_tokens_email ON account_tokens(email, kind)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor, created_date)`,
    ...PASSKEY_SCHEMA,
  ];
  for (const s of stmts) await env.DB.prepare(s).run();
  await seedCoachingContent(env);
  schemaReady = true;
}


/* -------------------- coaching content (self-seeding) -------------------- */
// A movement-pattern exercise catalog and a set of ready-to-ship program
// templates, distilled from the owner's coaching references (COACHING-REFERENCE
// §1-§5). Seeded as global, read-only content so every user shares one catalog.
// Exercise names are the common vocabulary of the gym; nothing is copied from a
// book. Each exercise carries the eight selection/substitution fields, and its
// cues follow the eight cueing buckets — at least one is a stop-rule or ROM
// limit (COACHING-REFERENCE §2). Every one of the seven movement patterns has a
// bodyweight fallback so a user with no equipment never hits a dead end.
const COACHING_EXERCISES = [
  /* ---- Horizontal push (chest, front shoulder, triceps) ---- */
  { name: 'Barbell Bench Press', pattern: 'horizontal_push', equipment: 'barbell',
    primary_muscles: ['chest', 'front deltoid', 'triceps'], joint_tags: ['shoulder', 'elbow'], unilateral: false,
    regression: 'Push-up', progression: 'Load step — add a small increment once you hit the top of the rep range at your prescribed rest',
    leverage_knob: 'Slow the lowering to a 3-count and pause on the chest',
    cues: ['Tuck the elbows about 45 degrees with the wrists stacked over them', 'Keep the natural lower-back arch and pin the shoulder blades down and back', 'Stop the set when bar speed stalls or form breaks — leave 1-2 reps in the tank'] },
  { name: 'Dumbbell Bench Press', pattern: 'horizontal_push', equipment: 'dumbbells',
    primary_muscles: ['chest', 'front deltoid', 'triceps'], joint_tags: ['shoulder', 'elbow'], unilateral: false,
    regression: 'Floor press', progression: 'Add reps into the 8-12 range, then step the dumbbells up',
    leverage_knob: 'Add a one-second pause at the bottom of each rep',
    cues: ['Elbows tucked, forearms vertical at the bottom', 'Squeeze the chest for one second at the top', 'Lower only as deep as you can without the shoulders rolling forward'] },
  { name: 'Incline Dumbbell Press', pattern: 'horizontal_push', equipment: 'dumbbells, bench',
    primary_muscles: ['upper chest', 'front deltoid', 'triceps'], joint_tags: ['shoulder'], unilateral: false,
    regression: 'Incline push-up', progression: 'Total-rep target at a fixed load, then raise the load',
    leverage_knob: 'Turn the palms to face each other to spare the shoulder',
    cues: ['Set a slight incline and keep the ribs down', 'Press up and slightly back over the collarbones', 'Stop lowering the moment the front of the shoulder complains'] },
  { name: 'Push-Up', pattern: 'horizontal_push', equipment: 'bodyweight',
    primary_muscles: ['chest', 'front deltoid', 'triceps', 'core'], joint_tags: ['shoulder', 'elbow', 'wrist'], unilateral: false,
    regression: 'Incline push-up with the hands elevated', progression: 'Elevate the feet or slow the tempo before adding a weighted vest',
    leverage_knob: 'Elevate the feet to shift more load onto the chest and shoulders',
    cues: ['Brace the abs and squeeze the glutes so the body is one straight line', 'Elbows tucked to about 45 degrees, not flared wide', 'Stop the set when the hips sag or you lose full depth'] },
  { name: 'Machine Chest Press', pattern: 'horizontal_push', equipment: 'machine',
    primary_muscles: ['chest', 'front deltoid', 'triceps'], joint_tags: [], unilateral: false,
    regression: 'Lighten the stack and slow the tempo', progression: 'Load step on the stack',
    leverage_knob: 'Pause at full stretch before pressing',
    cues: ['Set the seat so the handles line up with mid-chest', 'Press smoothly without locking out hard', 'Let the handles come back only as far as the shoulders stay comfortable'] },
  { name: 'Dip', pattern: 'horizontal_push', equipment: 'dip bars, bodyweight',
    primary_muscles: ['lower chest', 'triceps', 'front deltoid'], joint_tags: ['shoulder', 'elbow'], unilateral: false,
    regression: 'Bench dip or band-assisted dip', progression: 'Add reps, then hang a little weight from a belt',
    leverage_knob: 'Lean the torso forward to bias the chest',
    cues: ['Keep the shoulders down away from the ears', 'Brace the abs and stay tall through the trunk', 'Descend only until the upper arms reach parallel — no deeper'] },

  /* ---- Vertical push (shoulders, triceps, upper chest) ---- */
  { name: 'Barbell Overhead Press', pattern: 'vertical_push', equipment: 'barbell',
    primary_muscles: ['shoulders', 'triceps', 'upper chest'], joint_tags: ['shoulder', 'lower back'], unilateral: false,
    regression: 'Seated dumbbell shoulder press', progression: 'Load step; add a work-up single slightly above the top set',
    leverage_knob: 'Press strictly with no leg drive and pause at the forehead',
    cues: ['Brace the abs and squeeze the glutes so the ribs stay down', 'Press in a straight line and finish with the bar stacked over the mid-foot', 'Stop the set if the lower back arches to move the weight'] },
  { name: 'Seated Dumbbell Shoulder Press', pattern: 'vertical_push', equipment: 'dumbbells',
    primary_muscles: ['shoulders', 'triceps'], joint_tags: ['shoulder'], unilateral: false,
    regression: 'Landmine press', progression: 'Total-rep target, then raise the load',
    leverage_knob: 'Use a neutral (palms-in) grip to spare the shoulder',
    cues: ['Sit tall with the lower back supported and ribs down', 'Press up and slightly in without banging the dumbbells', 'Lower only to ear height, then stop if the shoulder pinches'] },
  { name: 'Landmine Press', pattern: 'vertical_push', equipment: 'barbell, landmine',
    primary_muscles: ['shoulders', 'upper chest', 'triceps'], joint_tags: [], unilateral: true,
    regression: 'Half-kneeling landmine press', progression: 'Load step, then progress toward a standing strict press',
    leverage_knob: 'Press from a half-kneeling stance to remove the leg drive',
    cues: ['Brace the abs so the low back does not arch', 'Press the bar up along its arc and reach tall', 'Keep the shoulders square — stop if either side starts to twist'] },
  { name: 'Pike Push-Up', pattern: 'vertical_push', equipment: 'bodyweight',
    primary_muscles: ['shoulders', 'triceps', 'upper chest'], joint_tags: ['shoulder', 'wrist'], unilateral: false,
    regression: 'Wall press or feet-lower pike push-up', progression: 'Elevate the feet toward a wall handstand as strength grows',
    leverage_knob: 'Elevate the feet to raise the load on the shoulders',
    cues: ['Hips high, body in an inverted V', 'Lower the crown of the head toward the floor under control', 'Stop before the neck or shoulders take the load — end the set there'] },
  { name: 'Half-Kneeling Dumbbell Press', pattern: 'vertical_push', equipment: 'dumbbell',
    primary_muscles: ['shoulders', 'triceps'], joint_tags: ['shoulder'], unilateral: true,
    regression: 'Seated dumbbell shoulder press', progression: 'Load step per arm',
    leverage_knob: 'Slow the lowering to a 3-count',
    cues: ['Tuck the pelvis slightly and brace so the ribs stay down', 'Press straight up over the shoulder', 'Keep the hips level and square — stop if you have to lean to finish a rep'] },

  /* ---- Horizontal pull (mid-back, rear shoulder, biceps) ---- */
  { name: 'Barbell Bent-Over Row', pattern: 'horizontal_pull', equipment: 'barbell',
    primary_muscles: ['mid-back', 'lats', 'rear deltoid', 'biceps'], joint_tags: ['lower back'], unilateral: false,
    regression: 'Chest-supported dumbbell row', progression: 'Load step while keeping the torso angle fixed',
    leverage_knob: 'Pause the bar at the ribs for a one-count each rep',
    cues: ['Keep the natural lower-back arch — never round the spine to lift', 'Pull the bar to the lower ribs and squeeze the shoulder blades together', 'Stop the set the moment the back rounds or the torso starts swinging'] },
  { name: 'One-Arm Dumbbell Row', pattern: 'horizontal_pull', equipment: 'dumbbell, bench',
    primary_muscles: ['lats', 'mid-back', 'rear deltoid', 'biceps'], joint_tags: [], unilateral: true,
    regression: 'Chest-supported dumbbell row', progression: 'Total-rep target per side, then raise the load',
    leverage_knob: 'Pause at the top and lower on a 3-count',
    cues: ['Brace the free hand and keep the spine long and neutral', 'Drive the elbow back toward the hip, squeezing the shoulder blade', 'Keep the hips and shoulders square — stop if the torso rotates to finish a rep'] },
  { name: 'Chest-Supported Dumbbell Row', pattern: 'horizontal_pull', equipment: 'dumbbells, incline bench',
    primary_muscles: ['mid-back', 'rear deltoid', 'biceps'], joint_tags: [], unilateral: false,
    regression: 'Seated cable row', progression: 'Volume ramp — add a set every 1-2 weeks',
    leverage_knob: 'Pause and squeeze at the top of every rep',
    cues: ['Let the bench take the spine so the lower back is out of it', 'Row both dumbbells to the ribs and pinch the shoulder blades', 'Lower fully but stop the set when you can no longer pause at the top'] },
  { name: 'Inverted Row', pattern: 'horizontal_pull', equipment: 'bodyweight, bar or suspension trainer',
    primary_muscles: ['mid-back', 'rear deltoid', 'biceps'], joint_tags: [], unilateral: false,
    regression: 'Raise the bar higher or bend the knees', progression: 'Lower the bar or elevate the feet to steepen the angle',
    leverage_knob: 'Elevate the feet and lengthen the body angle',
    cues: ['Brace the abs and squeeze the glutes so the body stays a straight line', 'Pull the chest to the bar and squeeze the shoulder blades', 'Stop when the hips drop or you can no longer reach the bar with control'] },
  { name: 'Seated Cable Row', pattern: 'horizontal_pull', equipment: 'cable machine',
    primary_muscles: ['mid-back', 'lats', 'biceps'], joint_tags: [], unilateral: false,
    regression: 'Band row', progression: 'Load step on the stack',
    leverage_knob: 'Pause for a one-count with the handle at the stomach',
    cues: ['Sit tall and keep the chest up without leaning back hard', 'Pull to the stomach and drive the elbows past the ribs', 'Let the weight stretch you forward only as far as the back stays flat'] },
  { name: 'Face Pull', pattern: 'horizontal_pull', equipment: 'cable, band',
    primary_muscles: ['rear deltoid', 'mid-back', 'rotator cuff'], joint_tags: [], unilateral: false,
    regression: 'Band pull-apart', progression: 'Add reps into the 15-20 range, then a small load step',
    leverage_knob: 'Pause with the hands beside the ears',
    cues: ['Pull the rope toward the eyes, splitting the hands apart', 'Lead with the elbows high and squeeze the rear shoulders', 'Keep it light and stop short of any shoulder pinch — this is protective volume'] },

  /* ---- Vertical pull (lats, biceps, forearms) ---- */
  { name: 'Pull-Up', pattern: 'vertical_pull', equipment: 'pull-up bar, bodyweight',
    primary_muscles: ['lats', 'biceps', 'forearms'], joint_tags: ['shoulder', 'elbow'], unilateral: false,
    regression: 'Band-assisted pull-up or lat pulldown', progression: 'Add reps, then hang a little weight from a belt',
    leverage_knob: 'Pause at the top and lower on a 3-count',
    cues: ['Start from a full hang and pull the chest toward the bar', 'Drive the elbows down and squeeze the lats — do not just bend the arms', 'Stop the set when you can no longer clear the bar with control'] },
  { name: 'Chin-Up', pattern: 'vertical_pull', equipment: 'pull-up bar, bodyweight',
    primary_muscles: ['lats', 'biceps', 'forearms'], joint_tags: ['elbow', 'shoulder'], unilateral: false,
    regression: 'Band-assisted chin-up', progression: 'Add reps, then add weight from a belt',
    leverage_knob: 'Pause at the top for a one-count',
    cues: ['Palms facing you, start from a full hang', 'Lead with the chest and drive the elbows to the ribs', 'Stop when the reps break down — do not kip to finish'] },
  { name: 'Lat Pulldown', pattern: 'vertical_pull', equipment: 'machine',
    primary_muscles: ['lats', 'biceps'], joint_tags: ['shoulder'], unilateral: false,
    regression: 'Band lat pulldown', progression: 'Load step on the stack',
    leverage_knob: 'Pause with the bar at the collarbone each rep',
    cues: ['Sit tall and set the shoulders down before pulling', 'Pull the bar to the collarbone and squeeze the lats', 'Pull only to the collarbone — never behind the neck'] },
  { name: 'Neutral-Grip Lat Pulldown', pattern: 'vertical_pull', equipment: 'machine',
    primary_muscles: ['lats', 'biceps'], joint_tags: [], unilateral: false,
    regression: 'Band lat pulldown', progression: 'Load step on the stack',
    leverage_knob: 'Slow the return to a 3-count',
    cues: ['Use the palms-facing handle to spare the shoulders and elbows', 'Drive the elbows down toward the hips', 'Control the bar up and stop the set when the lats stop doing the work'] },
  { name: 'Band Lat Pulldown', pattern: 'vertical_pull', equipment: 'band',
    primary_muscles: ['lats', 'biceps'], joint_tags: [], unilateral: false,
    regression: 'Shorten the band or step closer to the anchor', progression: 'Use a thicker band or add a pause; then progress to pull-ups',
    leverage_knob: 'Add a one-second squeeze at the bottom',
    cues: ['Anchor the band overhead and set the shoulders down', 'Pull the elbows to the ribs and squeeze the lats', 'Return under control and stop when you can no longer pause at the bottom'] },

  /* ---- Squat (quads, glutes, trunk) ---- */
  { name: 'Back Squat', pattern: 'squat', equipment: 'barbell',
    primary_muscles: ['quads', 'glutes', 'adductors', 'trunk'], joint_tags: ['knee', 'lower back'], unilateral: false,
    regression: 'Goblet squat', progression: 'Load step; add a paused rep at the bottom',
    leverage_knob: 'Pause two seconds at the bottom of each rep',
    cues: ['Brace the abs and hold the natural lower-back arch throughout', 'Track the knees out over the toes, not caving in', 'Descend as deep as you can without the pelvis tucking under — stop there'] },
  { name: 'Front Squat', pattern: 'squat', equipment: 'barbell',
    primary_muscles: ['quads', 'glutes', 'trunk'], joint_tags: ['knee'], unilateral: false,
    regression: 'Goblet squat', progression: 'Load step while keeping the torso upright',
    leverage_knob: 'Pause at the bottom before driving up',
    cues: ['Keep the elbows high so the bar stays on the shoulders', 'Stay tall through the chest and brace hard', 'Sink only as low as the torso stays upright, then drive the floor away'] },
  { name: 'Goblet Squat', pattern: 'squat', equipment: 'kettlebell or dumbbell',
    primary_muscles: ['quads', 'glutes'], joint_tags: ['knee'], unilateral: false,
    regression: 'Box squat to a target', progression: 'Load step, then graduate to a barbell squat',
    leverage_knob: 'Pause at the bottom and pry the knees out',
    cues: ['Hold the weight at the chest and keep the elbows inside the knees', 'Sit down between the hips with the chest up', 'Go as deep as you can hold the arch, then stand — stop if the low back rounds'] },
  { name: 'Bulgarian Split Squat', pattern: 'squat', equipment: 'dumbbells, bench',
    primary_muscles: ['quads', 'glutes'], joint_tags: ['knee'], unilateral: true,
    regression: 'Bodyweight split squat', progression: 'Load step per leg, then a slow-tempo variation',
    leverage_knob: 'Slow the descent to a 3-count and pause at the bottom',
    cues: ['Set the rear foot on the bench and stay tall through the torso', 'Drop the back knee straight down, front knee tracking over the foot', 'Descend only as far as balance and the front knee stay comfortable'] },
  { name: 'Bodyweight Squat', pattern: 'squat', equipment: 'bodyweight',
    primary_muscles: ['quads', 'glutes'], joint_tags: ['knee'], unilateral: false,
    regression: 'Box or chair squat to a target', progression: 'Slow the tempo, then move toward a single-leg progression',
    leverage_knob: 'Slow the descent and pause at the bottom, or shift to one leg',
    cues: ['Track the knees over the toes and drive the floor away through the heels', 'Keep the chest up and the lower-back arch — do not round at the bottom', 'Squat only as deep as you can hold the arch, then stand'] },
  { name: 'Leg Press', pattern: 'squat', equipment: 'machine',
    primary_muscles: ['quads', 'glutes'], joint_tags: ['knee'], unilateral: false,
    regression: 'Lighten the load and shorten the range', progression: 'Load step on the sled',
    leverage_knob: 'Pause at the bottom of each rep',
    cues: ['Set the feet mid-platform and keep the whole back on the pad', 'Push through the mid-foot and avoid locking the knees hard', 'Lower only until the lower back starts to round off the pad — stop there'] },
  { name: 'Reverse Lunge', pattern: 'squat', equipment: 'bodyweight or dumbbells',
    primary_muscles: ['quads', 'glutes', 'hamstrings'], joint_tags: ['knee'], unilateral: true,
    regression: 'Bodyweight reverse lunge to a short range', progression: 'Add load, then progress to a deficit or slow tempo',
    leverage_knob: 'Slow the lowering and pause at the bottom',
    cues: ['Step straight back and lower the back knee toward the floor', 'Keep the front knee tracking over the foot and the torso tall', 'Stop the set when balance or knee tracking breaks down'] },

  /* ---- Hinge (hamstrings, glutes, back) ---- */
  { name: 'Conventional Deadlift', pattern: 'hinge', equipment: 'barbell',
    primary_muscles: ['hamstrings', 'glutes', 'back', 'trunk'], joint_tags: ['lower back'], unilateral: false,
    regression: 'Romanian deadlift or kettlebell deadlift', progression: 'Load step; back off one set before a heavy top set',
    leverage_knob: 'Pause the bar just below the knee on the way up',
    cues: ['Set the natural lower-back arch and brace before the bar leaves the floor', 'Drive the feet into the floor and push the hips through — do not yank with the back', 'Stop the set the instant the lower back rounds'] },
  { name: 'Romanian Deadlift', pattern: 'hinge', equipment: 'barbell or dumbbells',
    primary_muscles: ['hamstrings', 'glutes', 'back'], joint_tags: ['lower back'], unilateral: false,
    regression: 'Kettlebell deadlift', progression: 'Load step while keeping the bar path against the legs',
    leverage_knob: 'Slow the lowering to a 3-count',
    cues: ['Soft knees, push the hips back and keep the bar against the legs', 'Hold the natural arch and brace the abs', 'Lower only until you feel the hamstring stretch without rounding — then stand'] },
  { name: 'Kettlebell Swing', pattern: 'hinge', equipment: 'kettlebell',
    primary_muscles: ['glutes', 'hamstrings', 'back'], joint_tags: ['lower back'], unilateral: false,
    regression: 'Kettlebell deadlift to groove the hinge', progression: 'Load step, then density (more quality swings in a fixed window)',
    leverage_knob: 'Add a crisp float-and-hike each rep',
    cues: ['Hinge at the hips, not a squat — the bell floats from hip snap', 'Snap the hips forward and squeeze the glutes at the top', 'Keep the spine neutral and stop the set when the hinge gets sloppy'] },
  { name: 'Barbell Hip Thrust', pattern: 'hinge', equipment: 'barbell, bench',
    primary_muscles: ['glutes', 'hamstrings'], joint_tags: [], unilateral: false,
    regression: 'Bodyweight glute bridge', progression: 'Load step; add a paused rep at the top',
    leverage_knob: 'Pause and squeeze for two seconds at the top',
    cues: ['Ribs down and chin tucked, drive through the heels', 'Squeeze the glutes to lift the hips level with the knees', 'Do not overextend at the top — stop the rep once the hips are level'] },
  { name: 'Single-Leg Romanian Deadlift', pattern: 'hinge', equipment: 'dumbbell',
    primary_muscles: ['hamstrings', 'glutes'], joint_tags: ['lower back'], unilateral: true,
    regression: 'Hold a support for balance', progression: 'Load step per leg, then remove the support',
    leverage_knob: 'Slow the lowering and pause at the bottom',
    cues: ['Hinge at the hip with a soft knee, back leg reaching straight behind', 'Keep the hips square to the floor and the spine long', 'Lower only as far as the back stays flat and hips stay level'] },
  { name: 'Glute Bridge', pattern: 'hinge', equipment: 'bodyweight',
    primary_muscles: ['glutes', 'hamstrings'], joint_tags: [], unilateral: false,
    regression: 'Two-count hold at the top of each rep', progression: 'Move to one leg, then a weighted hip thrust',
    leverage_knob: 'Shift to a single leg to double the load',
    cues: ['Squeeze the glutes to lift and keep the ribs down — do not arch the low back', 'Drive through the heels', 'Stop short of any lower-back pinch; finish with the hips level with the knees'] },

  /* ---- Carry / core-brace (trunk, grip, whole body) ---- */
  { name: 'Farmer Carry', pattern: 'carry_core', equipment: 'dumbbells or kettlebells',
    primary_muscles: ['trunk', 'grip', 'traps', 'whole body'], joint_tags: [], unilateral: false,
    regression: 'Shorter distance with a lighter load', progression: 'Add load or distance each week',
    leverage_knob: 'Slow the pace and lengthen the distance',
    cues: ['Stand tall with the ribs down and the abs braced', 'Keep the shoulders square and level — do not lean', 'Stop the set when posture breaks or the grip starts to fail'] },
  { name: 'Suitcase Carry', pattern: 'carry_core', equipment: 'dumbbell or kettlebell',
    primary_muscles: ['obliques', 'trunk', 'grip'], joint_tags: [], unilateral: true,
    regression: 'Shorter distance with a lighter load', progression: 'Add load or distance per side',
    leverage_knob: 'Slow the pace to resist the lean longer',
    cues: ['Load one hand and brace hard against the pull', 'Keep the hips level and the shoulders square — do not lean toward the weight', 'Stop the set the moment the torso tips sideways'] },
  { name: 'Plank', pattern: 'carry_core', equipment: 'bodyweight',
    primary_muscles: ['trunk', 'shoulders'], joint_tags: [], unilateral: false,
    regression: 'Plank from the knees', progression: 'Extend the hold, then add a limb reach',
    leverage_knob: 'Elevate the feet or add a slow limb reach',
    cues: ['Brace the abs and squeeze the glutes — one straight line from head to heels', 'Keep the hips level, no sagging or piking', 'End the hold the moment the hips drop — quality over time'] },
  { name: 'Dead Bug', pattern: 'carry_core', equipment: 'bodyweight',
    primary_muscles: ['trunk'], joint_tags: [], unilateral: false,
    regression: 'Move only the arms or only the legs', progression: 'Add a light weight or a longer reach',
    leverage_knob: 'Slow every rep to a 3-count',
    cues: ['Press the lower back flat to the floor before you move', 'Extend the opposite arm and leg slowly while keeping the ribs down', 'Stop the rep if the lower back lifts off the floor'] },
  { name: 'Side Plank', pattern: 'carry_core', equipment: 'bodyweight',
    primary_muscles: ['obliques', 'trunk'], joint_tags: [], unilateral: true,
    regression: 'Side plank from the knee', progression: 'Extend the hold, then add a top-leg raise',
    leverage_knob: 'Stack the feet or add a top-leg raise',
    cues: ['Stack the shoulder over the elbow and brace the side of the trunk', 'Lift the hips so the body is one straight line', 'End the hold when the hips start to sag toward the floor'] },
  { name: 'Pallof Press', pattern: 'carry_core', equipment: 'cable or band',
    primary_muscles: ['obliques', 'trunk'], joint_tags: [], unilateral: false,
    regression: 'Step closer to the anchor to reduce the pull', progression: 'Add tension, then a longer hold at full reach',
    leverage_knob: 'Hold at full extension for a longer count',
    cues: ['Stand side-on to the anchor and brace the abs', 'Press the handle straight out and resist the twist', 'Stop the set when you can no longer keep the hips and shoulders square'] },
];

// Four standard program structures (COACHING-REFERENCE §4), with reps and rests
// drawn from the goal → parameter table (§5). Shape mirrors FitnessTemplate /
// WorkoutPlan so the Templates tab and WorkoutForm render them unchanged.
const COACHING_TEMPLATES = [
  {
    name: 'Beginner Full-Body (3-Day)',
    category: 'full_body',
    difficulty: 'beginner',
    duration_weeks: 6,
    days_per_week: 3,
    mesocycle_phase: 'general',
    description: 'The default for anyone new or short on time: three full-body sessions on non-consecutive days. Variety comes from rotating the rep scheme across the week (heavy, moderate, higher-rep), not from new exercises. Progression is a load step on the main lift — if you miss the target reps two sessions running, drop the load 5-10% and climb again.',
    exercises: [
      { day: 1, name: 'Goblet Squat', sets: 3, reps: '5', target_rir: 2, rest_seconds: 150, notes: 'Heavy day. Work up to a tough set of 5.' },
      { day: 1, name: 'Dumbbell Bench Press', sets: 3, reps: '5', target_rir: 2, rest_seconds: 150, notes: 'Elbows tucked; leave 1-2 reps in the tank.' },
      { day: 1, name: 'One-Arm Dumbbell Row', sets: 3, reps: '6', target_rir: 2, rest_seconds: 120, notes: 'Per side. Keep the torso square.' },
      { day: 1, name: 'Plank', sets: 3, reps: '30-45s', target_rir: 2, rest_seconds: 60, notes: 'Brace hard; end the hold when the hips drop.' },
      { day: 2, name: 'Romanian Deadlift', sets: 3, reps: '8-10', target_rir: 2, rest_seconds: 120, notes: 'Moderate day. Lower to the hamstring stretch, no rounding.' },
      { day: 2, name: 'Seated Dumbbell Shoulder Press', sets: 3, reps: '8-10', target_rir: 2, rest_seconds: 90, notes: 'Ribs down; press to ear height.' },
      { day: 2, name: 'Lat Pulldown', sets: 3, reps: '8-10', target_rir: 2, rest_seconds: 90, notes: 'To the collarbone, never behind the neck.' },
      { day: 2, name: 'Farmer Carry', sets: 3, reps: '40m', target_rir: 2, rest_seconds: 60, notes: 'Tall and braced; stop when the grip fails.' },
      { day: 3, name: 'Bodyweight Squat', sets: 3, reps: '12-15', target_rir: 2, rest_seconds: 75, notes: 'Higher-rep day. Control the depth.' },
      { day: 3, name: 'Push-Up', sets: 3, reps: '12-15', target_rir: 2, rest_seconds: 75, notes: 'One straight line; stop when the hips sag.' },
      { day: 3, name: 'Inverted Row', sets: 3, reps: '12-15', target_rir: 2, rest_seconds: 75, notes: 'Chest to the bar; raise the bar to regress.' },
      { day: 3, name: 'Dead Bug', sets: 3, reps: '10', target_rir: 2, rest_seconds: 45, notes: 'Per side. Keep the low back flat.' },
    ],
  },
  {
    name: 'Upper / Lower Split (4-Day)',
    category: 'upper_lower',
    difficulty: 'intermediate',
    duration_weeks: 6,
    days_per_week: 4,
    mesocycle_phase: 'hypertrophy',
    description: 'The first split, once a beginner has about 12 logged weeks. Each day still covers a push and a pull (upper) or a squat and a hinge (lower), and the pull-to-push balance check runs weekly. Hypertrophy defaults: moderate reps, 60-90s rest, sets stopped shy of failure.',
    exercises: [
      { day: 1, name: 'Barbell Bench Press', sets: 4, reps: '6-8', target_rir: 2, rest_seconds: 120, notes: 'Upper A.' },
      { day: 1, name: 'Barbell Bent-Over Row', sets: 4, reps: '6-8', target_rir: 2, rest_seconds: 120, notes: 'Match rows to presses for balance.' },
      { day: 1, name: 'Seated Dumbbell Shoulder Press', sets: 3, reps: '10-12', target_rir: 2, rest_seconds: 90, notes: '' },
      { day: 1, name: 'Neutral-Grip Lat Pulldown', sets: 3, reps: '10-12', target_rir: 2, rest_seconds: 90, notes: '' },
      { day: 1, name: 'Face Pull', sets: 3, reps: '15-20', target_rir: 3, rest_seconds: 60, notes: 'Protective rear-shoulder volume.' },
      { day: 2, name: 'Back Squat', sets: 4, reps: '6-8', target_rir: 2, rest_seconds: 150, notes: 'Lower A.' },
      { day: 2, name: 'Romanian Deadlift', sets: 3, reps: '8-10', target_rir: 2, rest_seconds: 120, notes: '' },
      { day: 2, name: 'Bulgarian Split Squat', sets: 3, reps: '10', target_rir: 2, rest_seconds: 90, notes: 'Per leg.' },
      { day: 2, name: 'Plank', sets: 3, reps: '45s', target_rir: 2, rest_seconds: 60, notes: '' },
      { day: 3, name: 'Incline Dumbbell Press', sets: 4, reps: '8-10', target_rir: 2, rest_seconds: 90, notes: 'Upper B.' },
      { day: 3, name: 'One-Arm Dumbbell Row', sets: 4, reps: '10', target_rir: 2, rest_seconds: 90, notes: 'Per side.' },
      { day: 3, name: 'Pull-Up', sets: 3, reps: '6-10', target_rir: 2, rest_seconds: 90, notes: 'Band-assist if needed.' },
      { day: 3, name: 'Pallof Press', sets: 3, reps: '12', target_rir: 3, rest_seconds: 45, notes: 'Per side.' },
      { day: 4, name: 'Conventional Deadlift', sets: 4, reps: '5', target_rir: 2, rest_seconds: 180, notes: 'Lower B. Back off one set before a heavy top set.' },
      { day: 4, name: 'Front Squat', sets: 3, reps: '8-10', target_rir: 2, rest_seconds: 120, notes: '' },
      { day: 4, name: 'Barbell Hip Thrust', sets: 3, reps: '12', target_rir: 2, rest_seconds: 75, notes: 'Do not overextend at the top.' },
      { day: 4, name: 'Farmer Carry', sets: 3, reps: '40m', target_rir: 2, rest_seconds: 60, notes: '' },
    ],
  },
  {
    name: 'Push / Pull / Legs (3-Day)',
    category: 'push_pull_legs',
    difficulty: 'intermediate',
    duration_weeks: 6,
    days_per_week: 3,
    mesocycle_phase: 'hypertrophy',
    description: 'For the intermediate who wants body-part emphasis while still obeying the balance rule. Run it 3 days for a lighter week or 6 days (repeating the rotation) for more volume — never place two heavy sessions that share a muscle on consecutive days. Hypertrophy defaults: moderate reps, 60-90s rest.',
    exercises: [
      { day: 1, name: 'Barbell Bench Press', sets: 4, reps: '6-8', target_rir: 2, rest_seconds: 120, notes: 'Push day.' },
      { day: 1, name: 'Seated Dumbbell Shoulder Press', sets: 3, reps: '10-12', target_rir: 2, rest_seconds: 90, notes: '' },
      { day: 1, name: 'Incline Dumbbell Press', sets: 3, reps: '10-12', target_rir: 2, rest_seconds: 90, notes: '' },
      { day: 1, name: 'Dip', sets: 3, reps: '10-12', target_rir: 2, rest_seconds: 75, notes: 'Bench or band-assist to regress.' },
      { day: 2, name: 'Pull-Up', sets: 4, reps: '6-10', target_rir: 2, rest_seconds: 120, notes: 'Pull day. Band-assist if needed.' },
      { day: 2, name: 'Barbell Bent-Over Row', sets: 4, reps: '8-10', target_rir: 2, rest_seconds: 120, notes: '' },
      { day: 2, name: 'Lat Pulldown', sets: 3, reps: '10-12', target_rir: 2, rest_seconds: 90, notes: '' },
      { day: 2, name: 'Face Pull', sets: 3, reps: '15-20', target_rir: 3, rest_seconds: 60, notes: 'Rear-shoulder health.' },
      { day: 3, name: 'Back Squat', sets: 4, reps: '6-8', target_rir: 2, rest_seconds: 150, notes: 'Legs day.' },
      { day: 3, name: 'Romanian Deadlift', sets: 3, reps: '8-10', target_rir: 2, rest_seconds: 120, notes: '' },
      { day: 3, name: 'Bulgarian Split Squat', sets: 3, reps: '10', target_rir: 2, rest_seconds: 90, notes: 'Per leg.' },
      { day: 3, name: 'Kettlebell Swing', sets: 3, reps: '15', target_rir: 3, rest_seconds: 60, notes: 'Explosive hip snap.' },
      { day: 3, name: 'Plank', sets: 3, reps: '45s', target_rir: 2, rest_seconds: 45, notes: '' },
    ],
  },
  {
    name: 'Recomposition Circuit (3-Day)',
    category: 'recomposition',
    difficulty: 'intermediate',
    duration_weeks: 6,
    days_per_week: 3,
    mesocycle_phase: 'general',
    description: 'Moderate reps paired upper-with-lower or push-with-pull, rests kept under a minute so rising lactate drives the hormonal response. Progression is rest compression — trim a few seconds off the rest every couple of weeks. Note: long slow cardio is not the efficient fat-loss tool here; circuits and intervals are. Adjacent pairs never share a primary muscle.',
    exercises: [
      { day: 1, name: 'Goblet Squat', sets: 3, reps: '12', target_rir: 3, rest_seconds: 30, notes: 'Circuit A — pair with the push-up.' },
      { day: 1, name: 'Push-Up', sets: 3, reps: '12-15', target_rir: 3, rest_seconds: 30, notes: 'Non-competing pair (lower + push).' },
      { day: 1, name: 'Romanian Deadlift', sets: 3, reps: '12', target_rir: 3, rest_seconds: 30, notes: 'Pair with the row.' },
      { day: 1, name: 'One-Arm Dumbbell Row', sets: 3, reps: '12', target_rir: 3, rest_seconds: 30, notes: 'Per side. Hinge + pull pairing.' },
      { day: 1, name: 'Farmer Carry', sets: 3, reps: '40m', target_rir: 3, rest_seconds: 45, notes: 'Finisher.' },
      { day: 2, name: 'Reverse Lunge', sets: 3, reps: '12', target_rir: 3, rest_seconds: 30, notes: 'Circuit B. Per leg.' },
      { day: 2, name: 'Seated Dumbbell Shoulder Press', sets: 3, reps: '12', target_rir: 3, rest_seconds: 30, notes: 'Lower + push pairing.' },
      { day: 2, name: 'Barbell Hip Thrust', sets: 3, reps: '12-15', target_rir: 3, rest_seconds: 30, notes: 'Pair with the pulldown.' },
      { day: 2, name: 'Lat Pulldown', sets: 3, reps: '12', target_rir: 3, rest_seconds: 30, notes: 'Hinge + pull pairing.' },
      { day: 2, name: 'Pallof Press', sets: 3, reps: '12', target_rir: 3, rest_seconds: 45, notes: 'Per side. Core finisher.' },
      { day: 3, name: 'Bulgarian Split Squat', sets: 3, reps: '12', target_rir: 3, rest_seconds: 30, notes: 'Circuit C. Per leg.' },
      { day: 3, name: 'Incline Dumbbell Press', sets: 3, reps: '12', target_rir: 3, rest_seconds: 30, notes: 'Lower + push pairing.' },
      { day: 3, name: 'Kettlebell Swing', sets: 3, reps: '15', target_rir: 3, rest_seconds: 30, notes: 'Pair with the inverted row.' },
      { day: 3, name: 'Inverted Row', sets: 3, reps: '12-15', target_rir: 3, rest_seconds: 30, notes: 'Hinge + pull pairing.' },
      { day: 3, name: 'Side Plank', sets: 3, reps: '30s', target_rir: 3, rest_seconds: 45, notes: 'Per side. Core finisher.' },
    ],
  },
];

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Idempotent, migration-free seed run on boot (INSERT OR IGNORE with
// deterministic ids). Global content, so created_by is
// the same 'system' value the other boot seeds use.
async function seedCoachingContent(env) {
  const now = nowISO();
  for (const ex of COACHING_EXERCISES) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)`
    ).bind(`cex_${slugify(ex.name)}`, 'CoachingExercise', JSON.stringify(ex), 'system', now, now).run();
  }
  for (const tpl of COACHING_TEMPLATES) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)`
    ).bind(`ftpl_${slugify(tpl.name)}`, 'FitnessTemplate', JSON.stringify(tpl), 'system', now, now).run();
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  // Lets slow side work (push delivery) finish after the response is sent.
  if (context.waitUntil) env.__waitUntil = (p) => context.waitUntil(p);
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (env.DB) await ensureSchema(env);

  // path after /api/
  const segs = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': url.origin,
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type',
      },
    });
  }

  if (!env.AUTH_SECRET && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return err('Server is missing AUTH_SECRET.', 500);

  try {
    /* ---- auth ---- */
    if (segs[0] === 'auth') {
      const action = segs[1];

      // What a join or reset link is for (the link itself is the proof).
      if (action === 'link-info' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const link = await findAccountLink(env, body.token);
        if (!link) return err(BAD_LINK, 410);
        return json({ kind: link.kind, email: link.email, full_name: link.full_name || '', user_type: link.user_type });
      }

      // Joining needs an invite link, which proves the person controls (or was
      // handed) the invited address. The one exception: the first admin on an
      // empty database, so a fresh install can be set up.
      if (action === 'register' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const bad = passwordProblem(body.password);
        let link = null; let email; let user_type;
        if (body.token) {
          link = await findAccountLink(env, body.token, 'invite');
          if (!link) return err(BAD_LINK, 410);
          email = link.email; user_type = link.user_type || 'client';
        } else {
          email = String(body.email || '').trim().toLowerCase();
          const any = await env.DB.prepare('SELECT id FROM users LIMIT 1').first();
          if (any || !email || resolveRole(env, email, 'user') !== 'admin') {
            return err('Brigade accounts are by invitation. Ask your coach or the front desk for your link.', 403);
          }
          user_type = 'trainer';
        }
        if (bad) return err(bad, 400);
        const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existing) return err('You already have an account. Sign in, or reset your password.', 409);
        if (link && !(await useAccountLink(env, link))) return err(BAD_LINK, 410);

        const id = uid();
        const now = nowISO();
        const role = 'user'; // admins come exclusively from the ADMIN_EMAILS allowlist
        const full_name = String(body.full_name || link?.full_name || '').trim().slice(0, 120);
        await env.DB.prepare(
          'INSERT INTO users (id,email,password_hash,full_name,role,user_type,data,created_date,updated_date) VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(id, email, await hashPassword(body.password), full_name, role, user_type, '{}', now, now).run();
        if (link?.client_id && user_type === 'client') {
          const client = await getEntityById(env, 'Client', link.client_id);
          if (client) await patchEntity(env, client, { user_id: id });
        }
        await audit(env, { actor: email, action: 'account_created', target: 'Account', targetId: id, detail: user_type, request });
        const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
        const token = await signToken({ sub: id, email }, env.AUTH_SECRET || 'dev-insecure-secret');
        const u = userRow(row);
        u.role = resolveRole(env, u.email, u.role);
        return json({ token, user: u });
      }

      // "Email me a link": a reset for an account, or the join link for an
      // invited member without one. The answer never says which, or neither.
      if (action === 'forgot' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || '').trim().toLowerCase();
        if (!email) return err('Enter your email.', 400);
        if (!env.RESEND_API_KEY) return json({ success: true, email_enabled: false });
        const hourAgo = new Date(Date.now() - 3600000).toISOString();
        const ip = request.headers.get('cf-connecting-ip') || '';
        const recent = await env.DB.prepare(
          `SELECT SUM(CASE WHEN actor = ? THEN 1 ELSE 0 END) AS mine, SUM(CASE WHEN ip = ? THEN 1 ELSE 0 END) AS here
           FROM audit_log WHERE action = 'link_requested' AND created_date > ?`
        ).bind(email, ip, hourAgo).first();
        await audit(env, { actor: email, action: 'link_requested', request });
        if ((recent?.mine || 0) < 3 && (!ip || (recent?.here || 0) < 30)) {
          const work = (async () => {
            const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
            if (row) {
              if (userRow(row).disabled) return;
              const link = await createAccountLink(env, url, { kind: 'reset', email, hours: EMAIL_RESET_HOURS, created_by: 'self' });
              await emailAccountLink(env, { kind: 'reset', to: email, name: row.full_name, link });
              return;
            }
            const c = parseRow(await env.DB.prepare(
              `SELECT * FROM entities WHERE entity_type='Client' AND lower(json_extract(data,'$.email')) = ? AND COALESCE(json_extract(data,'$.status'),'active') != 'archived' LIMIT 1`
            ).bind(email).first());
            if (!c) return;
            const link = await createAccountLink(env, url, { kind: 'invite', email, user_type: 'client', client_id: c.id, full_name: c.full_name, hours: INVITE_HOURS, created_by: 'self' });
            await emailAccountLink(env, { kind: 'invite', to: email, name: c.full_name, link });
          })().catch((e) => console.error('account link email failed', e?.message));
          // After the response, so timing doesn't reveal whether the email is on file.
          if (env.__waitUntil) env.__waitUntil(work); else await work;
        }
        return json({ success: true, email_enabled: true });
      }

      if (action === 'reset' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const link = await findAccountLink(env, body.token, 'reset');
        if (!link) return err(BAD_LINK, 410);
        const bad = passwordProblem(body.password);
        if (bad) return err(bad, 400);
        const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(link.email).first();
        if (!row || userRow(row).disabled || !(await useAccountLink(env, link))) return err(BAD_LINK, 410);
        await setPassword(env, row.id, body.password);
        // A reset is how a lost phone or a stranger gets locked out.
        await removePasskeys(env, row.id);
        await audit(env, { actor: link.email, action: 'password_reset', target: 'Account', targetId: row.id, request });
        const token = await signToken({ sub: row.id, email: row.email }, env.AUTH_SECRET || 'dev-insecure-secret');
        const u = userRow(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.id).first());
        u.role = resolveRole(env, u.email, u.role);
        return json({ token, user: u });
      }

      if (action === 'change-password' && method === 'POST') {
        const user = await currentUser(request, env);
        if (!user) return err('You must be logged in.', 401);
        const body = await request.json().catch(() => ({}));
        const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const fails = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM audit_log WHERE actor = ? AND action = 'password_change_failed' AND created_date > ?`
        ).bind(user.email, since).first();
        if ((fails?.n || 0) >= 10) return err('Too many attempts. Please try again in 15 minutes.', 429);
        const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
        if (!(await verifyPassword(body.current_password || '', row.password_hash))) {
          await audit(env, { actor: user.email, action: 'password_change_failed', request });
          return err('Your current password is not right.', 400);
        }
        const bad = passwordProblem(body.password);
        if (bad) return err(bad, 400);
        await setPassword(env, user.id, body.password);
        await audit(env, { actor: user.email, action: 'password_changed', target: 'Account', targetId: user.id, request });
        return json({ success: true, token: await signToken({ sub: row.id, email: row.email }, env.AUTH_SECRET || 'dev-insecure-secret') });
      }

      if (action === 'login' && method === 'POST') {
        const body = await request.json();
        const email = (body.email || '').trim().toLowerCase();

        // Brute-force throttle (HIPAA §164.308(a)(5)(ii)(C)): lock an account
        // out for 15 minutes after 10 failed attempts in that window. Counted
        // from the audit log, so no extra storage is needed.
        const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        // A completed password reset clears the count.
        const fails = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM audit_log WHERE actor = ?1 AND action = 'login_failed' AND created_date > ?2
           AND created_date > COALESCE((SELECT MAX(created_date) FROM audit_log WHERE actor = ?1 AND action = 'password_reset'), '')`
        ).bind(email, since).first();
        if ((fails?.n || 0) >= 10) {
          await audit(env, { actor: email, action: 'login_blocked', detail: 'rate limited', request });
          return err('Too many failed sign-in attempts. Please try again in 15 minutes.', 429);
        }

        const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
        if (!row || !(await verifyPassword(body.password || '', row.password_hash))) {
          await audit(env, { actor: email, action: 'login_failed', request });
          return err('Invalid email or password.', 401);
        }
        if (userRow(row).disabled) return err('This account is turned off. Contact the gym.', 403);
        await audit(env, { actor: email, action: 'login', request });
        const token = await signToken({ sub: row.id, email }, env.AUTH_SECRET || 'dev-insecure-secret');
        const u = userRow(row);
        u.role = resolveRole(env, u.email, u.role);
        return json({ token, user: u });
      }

      if (action === 'me') {
        const user = await currentUser(request, env);
        if (!user) return err('You must be logged in.', 401);
        if (method === 'GET') {
          if (isStaff(user)) {
            const p = checkHeartbeat(env).catch(() => {});
            if (env.__waitUntil) env.__waitUntil(p); else await p;
          }
          // Auto-provision a Client record for client/independent users so the
          // portals always have a profile to load (Base44 did this via backend jobs).
          if (user.user_type === 'client' || user.user_type === 'independent') {
            const existing = await env.DB.prepare(
              `SELECT id FROM entities WHERE entity_type='Client' AND json_extract(data,'$.email') = ? LIMIT 1`
            ).bind(user.email).first();
            if (!existing) {
              const now = nowISO();
              const profile = {
                full_name: user.full_name || '',
                email: user.email,
                user_id: user.id,
                status: 'active',
                trainer_id: user.user_type === 'independent' ? null : undefined,
              };
              await env.DB.prepare(
                'INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
              ).bind(uid(), 'Client', JSON.stringify(profile), user.email, now, now).run();
            }
          }
          return json(user);
        }
        if (method === 'PUT') {
          const body = await request.json();
          const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
          const data = JSON.parse(row.data || '{}');
          const cols = { full_name: row.full_name, role: row.role, user_type: row.user_type };
          // `role` and `user_type` are privilege fields — never writable by the
          // account itself. Admin status comes solely from the ADMIN_EMAILS
          // allowlist; account type is fixed at registration (gated by beta key
          // / invite), so self-service changes would bypass those gates.
          const PROTECTED = ['id', 'email', 'role', 'user_type', 'password_hash', 'beta_key_used', 'beta_key_verified', 'beta_key', 'billing', 'disabled', 'sessions_valid_from', 'created_date', 'updated_date'];
          for (const [k, v] of Object.entries(body)) {
            if (PROTECTED.includes(k)) continue;
            if (k in cols) cols[k] = v;
            else data[k] = v;
          }
          await env.DB.prepare(
            'UPDATE users SET full_name=?, role=?, user_type=?, data=?, updated_date=? WHERE id=?'
          ).bind(cols.full_name, cols.role, cols.user_type, JSON.stringify(data), nowISO(), user.id).run();
          const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
          return json(userRow(updated));
        }
      }

      // Right of access (HIPAA §164.524 / GDPR art. 15): hand the account
      // holder a machine-readable copy of everything stored about them.
      if (action === 'export' && method === 'GET') {
        const user = await currentUser(request, env);
        if (!user) return err('You must be logged in.', 401);
        const scope = await ownershipClause(env, user);
        // Members get what they can see in the app: coach-private notes and
        // notebooks (other than their own and AI recovery notes) stay out.
        const isMember = user.user_type === 'client' || user.user_type === 'independent';
        const privateTypes = [...COACH_PRIVATE_TYPES].map(() => '?').join(',');
        const memberFilter = isMember
          ? ` AND NOT (entity_type IN (${privateTypes}) AND created_by != ? AND COALESCE(json_extract(data,'$.trainer_id'),'') != 'AI_SYSTEM')`
          : '';
        const sql = scope
          ? `SELECT * FROM entities WHERE ${scope.sql}${memberFilter} ORDER BY entity_type, created_date`
          : `SELECT * FROM entities WHERE created_by = ? ORDER BY entity_type, created_date`;
        const binds = scope
          ? [...scope.binds, ...(isMember ? [...COACH_PRIVATE_TYPES, user.email] : [])]
          : [user.email];
        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        const records = {};
        for (const row of results) {
          (records[row.entity_type] ||= []).push(rowToEntity(row));
        }
        const { password_hash: _ph, ...profile } = user;
        await audit(env, { actor: user.email, action: 'export_data', target: 'Account', targetId: user.id, request });
        return json({
          exported_at: nowISO(),
          account: profile,
          records,
          record_counts: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.length])),
        });
      }

      // Close an account. Only the login and personal items go (notifications,
      // AI chats, daily briefings). Clients and their data are gym records:
      // they stay until an admin deletes the client. A member's client record
      // is kept but unlinked from the closed login. The UI requires typing
      // DELETE to confirm.
      if (action === 'me' && method === 'DELETE') {
        const user = await currentUser(request, env);
        if (!user) return err('You must be logged in.', 401);
        let removed = 0;
        const personal = await env.DB.prepare(
          `SELECT id FROM entities WHERE
             (entity_type = 'Notification' AND json_extract(data,'$.user_id') = ?)
             OR (entity_type IN ('CoachBriefing','AgentConversation') AND created_by = ?)`
        ).bind(user.id, user.email).all();
        for (const r of personal.results) {
          await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(r.id).run();
          removed++;
        }
        const { results: clientRows } = await env.DB.prepare(
          `SELECT id, data FROM entities WHERE entity_type='Client' AND json_extract(data,'$.user_id') = ?`
        ).bind(user.id).all();
        for (const row of clientRows) {
          let data; try { data = JSON.parse(row.data); } catch { continue; }
          delete data.user_id;
          data.status = 'inactive';
          data.account_deleted = true;
          await env.DB.prepare('UPDATE entities SET data=?, updated_date=? WHERE id=?')
            .bind(JSON.stringify(data), nowISO(), row.id).run();
        }
        await removePasskeys(env, user.id);
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
        // The audit trail deliberately outlives the account (HIPAA requires
        // retaining access logs for 6 years); it stores no PHI, only actions.
        await audit(env, { actor: user.email, action: 'account_deleted', target: 'Account', targetId: user.id, detail: `${removed} records`, request });
        return json({ success: true, deleted_records: removed });
      }

      if (action === 'passkeys') {
        return passkeyRoute({ request, env, url, method, step: segs[2], id: segs[3] }, {
          json, err, audit, currentUser,
          issue: async (row) => {
            const u = userRow(row);
            u.role = resolveRole(env, u.email, u.role);
            return { token: await signToken({ sub: row.id, email: row.email }, env.AUTH_SECRET || 'dev-insecure-secret'), user: u };
          },
          notify: (u, name) => insertEntity(env, 'Notification', {
            user_id: u.id, type: 'system', title: 'New sign-in method added', read: false, link: '/Settings?tab=account',
            message: `Face ID, fingerprint or screen lock sign-in was set up on: ${name}. If this wasn't you, reset your password.`,
          }, u.email),
        });
      }

      if (action === 'isAuthenticated') {
        const user = await currentUser(request, env);
        return json({ authenticated: !!user });
      }

      if (action === 'logout') return json({ success: true });

      return err('Unknown auth route.', 404);
    }

    /* ---- entities ---- */
    if (segs[0] === 'entities') {
      const type = segs[1];
      const id = segs[2];
      if (!type) return err('Entity type required.', 400);
      const user = await currentUser(request, env);
      if (!user) return err('Authentication required.', 401);

      // "User" maps to the real users table (Base44 exposed platform users as an entity).
      if (type === 'User') {
        if (method === 'GET' && !id) {
          if (user.role === 'admin') {
            const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY created_date DESC').all();
            return json(results.map(userRow));
          }
          return json([user]);
        }
        if (method === 'GET' && id) {
          const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
          if (!row) return err('Not found.', 404);
          const u = userRow(row);
          return user.role === 'admin' || u.id === user.id ? json(u) : err('Forbidden.', 403);
        }
        return err('Users are managed via /api/auth.', 405);
      }

      if (!id) {
        if (method === 'GET') {
          const filter = url.searchParams.get('filter') ? JSON.parse(url.searchParams.get('filter')) : {};
          const sort = url.searchParams.get('sort') || undefined;
          const limit = url.searchParams.get('limit') || undefined;
          return json(await listEntities(env, type, { filter, sort, limit, user }));
        }
        if (method === 'POST') {
          const body = await request.json();
          const list = Array.isArray(body) ? body : [body];

          const created = [];
          const prepared = [];
          for (const item of list) {
            const { id: _i, created_date: _c, updated_date: _u, created_by: _b, ...fields } = item || {};
            if (staffWriteDenied(type, user)) return err('Only coaches can change this.', 403);
            const violation = await memberWriteViolation(env, user, type, fields);
            if (violation) return err(violation, 403);
            // One Client record per email per coach. A duplicate splits the
            // member's plans and logs across two records.
            if (type === 'Client' && fields.email && fields.trainer_id) {
              const dup = await env.DB.prepare(
                `SELECT id FROM entities WHERE entity_type='Client' AND lower(json_extract(data,'$.email')) = lower(?) AND json_extract(data,'$.trainer_id') = ? LIMIT 1`
              ).bind(fields.email, fields.trainer_id).first();
              if (dup) return err(`${fields.email} is already one of your clients.`, 409, { code: 'duplicate_client', id: dup.id });
            }
            if (type === 'ClassSession' && isStaff(user)) await normalizeClassSession(env, fields, null);
            if (type === 'Membership' && isStaff(user)) await normalizeMembership(env, fields);
            prepared.push(fields);
          }
          for (const fields of prepared) {
            const eid = uid();
            const now = nowISO();
            await env.DB.prepare(
              'INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
            ).bind(eid, type, JSON.stringify(fields), user.email || user.id, now, now).run();
            created.push({ ...fields, id: eid, created_by: user.email || user.id, created_date: now, updated_date: now });
            await audit(env, { actor: user.email, action: 'create', target: type, targetId: eid, request });
            if (CLASS_HOOK_TYPES.has(type)) {
              const sync = await afterClassEntityWrite(env, type, eid, { ...fields, created_by: user.email || user.id }, null, user);
              if (sync) created[created.length - 1].class_sync = sync;
            }
            if (type === 'Notification') {
              const p = pushForNotification(env, user, fields);
              if (env.__waitUntil) env.__waitUntil(p); else await p;
            }
          }
          return json(Array.isArray(body) ? created : created[0]);
        }
      } else {
        if (method === 'GET') {
          const row = await getScopedEntity(env, type, id, user);
          if (!row) return err('Not found.', 404);
          // HIPAA §164.312(b): record who viewed a health record, not just who
          // changed one. Limited to PHI-bearing types so the log stays useful.
          if (PHI_TYPES.has(type)) {
            await audit(env, { actor: user.email, action: 'read', target: type, targetId: id, request });
          }
          return json(rowToEntity(row));
        }
        if (method === 'PUT') {
          const row = await getScopedEntity(env, type, id, user);
          if (!row) return err('Not found.', 404);
          const body = await request.json();
          const data = JSON.parse(row.data || '{}');
          const { id: _i, created_date: _c, updated_date: _u, created_by: _b, ...fields } = body || {};
          if (staffWriteDenied(type, user)) return err('Only coaches can change this.', 403);
          const violation = await memberWriteViolation(env, user, type, fields, data);
          if (violation) return err(violation, 403);
          if (sharedWriteDenied(type, row, user, fields)) return err('Only the author can edit this.', 403);
          if (type === 'ClassSession' && isStaff(user)) await normalizeClassSession(env, fields, data);
          const merged = { ...data, ...fields };
          const now = nowISO();
          await env.DB.prepare('UPDATE entities SET data=?, updated_date=? WHERE id=?')
            .bind(JSON.stringify(merged), now, id).run();
          await audit(env, { actor: user.email, action: 'update', target: type, targetId: id, request });
          if (CLASS_HOOK_TYPES.has(type)) {
            const sync = await afterClassEntityWrite(env, type, id, { ...merged, created_by: row.created_by }, data, user);
            const fresh = type === 'ClassSession' ? await getEntityById(env, 'ClassSession', id) : null;
            return json({ ...(fresh || { ...merged, id, created_by: row.created_by, created_date: row.created_date, updated_date: now }), ...(sync ? { class_sync: sync } : {}) });
          }
          return json({ ...merged, id, created_by: row.created_by, created_date: row.created_date, updated_date: now });
        }
        if (method === 'DELETE') {
          const row = await getScopedEntity(env, type, id, user);
          if (!row) return err('Not found.', 404);
          if (sharedWriteDenied(type, row, user)) return err('Only the author can delete this.', 403);
          if (staffWriteDenied(type, user)) return err('Only coaches can change this.', 403);
          // Clients and their data are kept until an admin deletes the client.
          if (type === 'Client') {
            if (user.role !== 'admin') return err('Only an admin can delete a client.', 403);
            const removed = await deleteClientAndData(env, row);
            await audit(env, { actor: user.email, action: 'delete_client', target: 'Client', targetId: id, detail: `${removed} records`, request });
            return json({ success: true, deleted_records: removed });
          }
          if (user.role !== 'admin' && row.created_by !== user.email) {
            const author = await env.DB.prepare('SELECT user_type, role FROM users WHERE email = ?').bind(row.created_by).first();
            const authorIsStaff = author && (author.role === 'admin' || author.user_type === 'trainer');
            if (!authorIsStaff) return err("This is a client's own record. Only an admin can delete it.", 403);
          }
          await env.DB.prepare('DELETE FROM entities WHERE id=? AND entity_type=?').bind(id, type).run();
          await audit(env, { actor: user.email, action: 'delete', target: type, targetId: id, request });
          if (CLASS_HOOK_TYPES.has(type) && type !== 'ClassSession') {
            let prev = {}; try { prev = JSON.parse(row.data || '{}'); } catch { /* ignore */ }
            const sync = await afterClassEntityWrite(env, type, id, null, { ...prev, created_by: row.created_by }, user);
            return json({ success: true, ...(sync ? { class_sync: sync } : {}) });
          }
          return json({ success: true });
        }
      }
      return err('Method not allowed.', 405);
    }

    /* ---- integrations ---- */
    if (segs[0] === 'integrations') {
      const user = await currentUser(request, env);
      if (!user) return err('Authentication required.', 401);

      if (segs[1] === 'upload' && method === 'POST') {
        const form = await request.formData();
        const file = form.get('file');
        if (!file) return err('No file provided.', 400);
        const key = `uploads/${user.id}/${uid()}-${(file.name || 'file').replace(/[^\w.-]/g, '_')}`;
        if (env.FILES) {
          await env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
          const base = env.PUBLIC_R2_URL ? env.PUBLIC_R2_URL.replace(/\/$/, '') : `${url.origin}/api/files`;
          const fileUrl = `${base}/${key}`;
          return json({ file_url: fileUrl, url: fileUrl, data: { file_url: fileUrl } });
        }
        // No R2 bound: return an inline data URL so previews still work in dev.
        const buf = await file.arrayBuffer();
        const dataUrl = `data:${file.type};base64,${b64(new Uint8Array(buf))}`;
        return json({ file_url: dataUrl, url: dataUrl, data: { file_url: dataUrl } });
      }

      if (segs[1] === 'llm' && method === 'POST') {
        const body = await request.json();
        return json(await invokeLLM(body, env));
      }

      return err('Unknown integration.', 404);
    }

    /* ---- functions ---- */
    /* ---- audit log (admin only) ---- */
    /* ---- billing (Stripe) ---- */
    if (segs[0] === 'stripe') {
      // Webhook first: it is unauthenticated by design and verified by signature.
      if (segs[1] === 'webhook' && method === 'POST') {
        const raw = await request.text();
        const ok = await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
        if (!ok) return err('Invalid signature.', 400);

        let event;
        try { event = JSON.parse(raw); } catch { return err('Bad payload.', 400); }
        const obj = event?.data?.object || {};

        // Find the user this event belongs to: metadata first, then customer id.
        const findUser = async () => {
          const uid = obj.metadata?.apex_user_id || obj.subscription_details?.metadata?.apex_user_id;
          if (uid) return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
          const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
          if (!customer) return null;
          return env.DB.prepare(
            `SELECT * FROM users WHERE json_extract(data,'$.billing.customer_id') = ? LIMIT 1`
          ).bind(customer).first();
        };

        const row = await findUser();
        if (row) {
          const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
          if (event.type === 'checkout.session.completed') {
            await saveBilling(env, row.id, {
              customer_id: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
              subscription_id: typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id,
              plan: obj.metadata?.apex_plan || null,
              status: 'active',
            });
          } else if (event.type.startsWith('customer.subscription.')) {
            const deleted = event.type.endsWith('deleted');
            await saveBilling(env, row.id, {
              customer_id: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
              subscription_id: obj.id,
              plan: deleted ? null : (obj.metadata?.apex_plan || obj.items?.data?.[0]?.price?.metadata?.plan || null),
              status: deleted ? 'canceled' : obj.status,
              current_period_end: iso(obj.current_period_end),
              cancel_at_period_end: !!obj.cancel_at_period_end,
            });
          } else if (event.type === 'invoice.payment_failed') {
            await saveBilling(env, row.id, { status: 'past_due' });
          }
          await audit(env, { actor: row.email, action: 'billing_' + event.type.replace(/\./g, '_'), target: 'Subscription', targetId: obj.id || '', request });
        }
        return json({ received: true });
      }

      const user = await currentUser(request, env);
      if (!user) return err('Authentication required.', 401);

      // Current plan + limits, used by the billing screen and feature gates.
      if (segs[1] === 'status' && method === 'GET') {
        const state = subscriptionState(user);
        const { results } = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM entities WHERE entity_type='Client' AND created_by = ? AND COALESCE(json_extract(data,'$.status'),'active') != 'archived'`
        ).bind(user.email).all();
        return json({
          ...state,
          clientCount: results?.[0]?.n || 0,
          configured: !!env.STRIPE_SECRET_KEY,
          plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })),
          trialDays: TRIAL_DAYS,
        });
      }

      // Hosted Checkout — card details never touch our servers.
      if (segs[1] === 'checkout' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const plan = String(body.plan || '');
        const interval = body.interval === 'annual' ? 'annual' : 'monthly';
        if (!PLANS[plan]) return err('Unknown plan.', 400);

        const lookup = `apex_${plan}_${interval}`;
        const prices = await stripe(env, `prices?lookup_keys[]=${encodeURIComponent(lookup)}&active=true&limit=1`, { method: 'GET' });
        const price = prices?.data?.[0];
        if (!price) return err('That plan is not available right now.', 400);

        const state = subscriptionState(user);
        const origin = new URL(request.url).origin;
        const session = await stripe(env, 'checkout/sessions', {
          data: {
            mode: 'subscription',
            line_items: [{ price: price.id, quantity: 1 }],
            success_url: `${origin}/Settings?billing=success`,
            cancel_url: `${origin}/Settings?billing=cancelled`,
            client_reference_id: user.id,
            ...(state.customerId ? { customer: state.customerId } : { customer_email: user.email }),
            allow_promotion_codes: true,
            metadata: { apex_user_id: user.id, apex_plan: plan },
            subscription_data: { metadata: { apex_user_id: user.id, apex_plan: plan } },
          },
        });
        await audit(env, { actor: user.email, action: 'billing_checkout_started', target: 'Subscription', detail: `${plan}/${interval}`, request });
        return json({ url: session.url });
      }

      // Stripe-hosted portal for changing plan, updating card, or cancelling.
      if (segs[1] === 'portal' && method === 'POST') {
        const customerId = user?.billing?.customer_id;
        if (!customerId) return err('No subscription to manage yet.', 400);
        const origin = new URL(request.url).origin;
        const session = await stripe(env, 'billing_portal/sessions', {
          data: { customer: customerId, return_url: `${origin}/Settings` },
        });
        return json({ url: session.url });
      }

      return err('Unknown billing route.', 404);
    }

    if (segs[0] === 'audit') {
      const user = await currentUser(request, env);
      if (!user) return err('Authentication required.', 401);
      if (user.role !== 'admin') return err('Forbidden.', 403);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
      const { results } = await env.DB.prepare(
        'SELECT * FROM audit_log ORDER BY created_date DESC LIMIT ?'
      ).bind(limit).all();
      return json(results);
    }

    /* ---- cron: program message delivery (workers/program-cron POSTs here) ---- */
    if (segs[0] === 'cron' && segs[1] === 'program-tick') {
      if (method !== 'POST') return err('Method not allowed.', 405);
      const given = request.headers.get('x-cron-secret') || '';
      const secret = env.CRON_SECRET || '';
      let diff = given.length === secret.length ? 0 : 1;
      for (let i = 0; i < Math.min(given.length, secret.length); i++) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
      if (!secret || diff !== 0) return err('Unauthorized.', 401);
      const programs = await runProgramTick(env, {});
      let classes;
      try { classes = await runClassTick(env); } catch (e) { classes = { success: false, error: String(e?.message || e).slice(0, 200) }; }
      if (classes?.success === false) await recordError(env, { source: 'job', message: classes.error, page: 'classes' });
      if (programs?.success === false) await recordError(env, { source: 'job', message: programs.error, page: 'programs' });
      await setState(env, 'cron_last_ok', 'ok');
      return json({ ...programs, classes });
    }

    if (segs[0] === 'client-error' && method === 'POST') {
      const user = await currentUser(request, env);
      if (!user) return err('Authentication required.', 401);
      const body = await request.json().catch(() => ({}));
      await recordError(env, { source: body.source === 'page' ? 'page' : 'screen', message: body.message, page: body.page, detail: body.stack });
      return json({ success: true });
    }

    if (segs[0] === 'functions') {
      const name = segs[1];
      const user = await currentUser(request, env);
      // Only these run without signing in; everything else can read data, send
      // email or spend AI credits.
      if (!user && !PUBLIC_FUNCTIONS.has(name)) return err('Authentication required.', 401);
      const payload = method === 'POST' ? await request.json().catch(() => ({})) : {};
      const result = await runFunction(name, payload, { env, user, url });
      if (result && result.__unimplemented) {
        return json({ error: `Function "${name}" is not available in the Cloudflare build.`, stubbed: true }, 200);
      }
      return json(result);
    }

    /* ---- R2 file serving (fallback when no public bucket URL) ---- */
    if (segs[0] === 'files' || url.pathname.startsWith('/files/')) {
      if (!env.FILES) return err('File storage not configured.', 404);
      const key = url.pathname.replace(/^\/(api\/)?files\//, '');
      const obj = await env.FILES.get(key);
      if (!obj) return err('Not found.', 404);
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      // Uploads are served from the app's own origin with an uploader-chosen
      // content type. Never let one run as a page: images, audio, video and
      // PDFs display inline; anything else downloads. The sandbox CSP stops
      // script even if a browser decides to render it.
      const type = (headers.get('content-type') || '').toLowerCase();
      const inline = /^(image\/(png|jpe?g|gif|webp|heic|heif|avif)|video\/|audio\/|application\/pdf)/.test(type);
      if (!inline) {
        headers.set('content-type', 'application/octet-stream');
        headers.set('content-disposition', 'attachment');
      }
      headers.set('x-content-type-options', 'nosniff');
      headers.set('content-security-policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      return new Response(obj.body, { headers });
    }

    return err('Not found.', 404);
  } catch (e) {
    const p = recordError(env, { source: 'server', message: e?.message, page: `/api/${segs.slice(0, 2).join('/')}`, detail: e?.stack });
    if (env.__waitUntil) env.__waitUntil(p); else await p;
    return err(e.message || 'Server error', 500);
  }
}

function b64(bytes) {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}
