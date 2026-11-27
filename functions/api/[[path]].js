import Anthropic from "@anthropic-ai/sdk";
import { smtpSend } from "../_lib/smtp.js";
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
  return attachRights(env, u);
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
  'ClassType', 'ClassSlot', 'ClassSession', 'MembershipPlan', 'GymSettings', 'ClassDayChange',
  'Movement', 'Benchmark', 'Workout']); // Phase 3 editor: workout libraries + daily workouts
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

/* ---- Roles and permissions ----
 * Admin comes only from ADMIN_EMAILS and has every right. Staff accounts
 * (user_type 'trainer') hold one role (users.data.staff_role, default 'coach').
 * Admins create roles and tick their rights on the Team page; the definitions
 * live in app_state 'staff_roles'. Clients are members; a member with linked
 * children is also a parent (client_guardians). Every staff-only action names
 * the right it needs. */
const RIGHTS = [
  { key: 'classes.run', label: 'Run classes', hint: 'Rosters, check-in, book people in' },
  { key: 'classes.edit', label: 'Change a single class', hint: 'Time, coach, capacity, or cancel it' },
  { key: 'schedule.manage', label: 'Set up the class schedule', hint: 'Class types, weekly times, holiday closures' },
  { key: 'coach_schedule.manage', label: 'Manage coach schedules', hint: 'Build and publish the coaching schedule, approve time off' },
  { key: 'members.invite', label: 'Invite members', hint: 'Send join links to members' },
  { key: 'members.manage', label: 'Manage memberships', hint: 'Plans, holds and end dates' },
  { key: 'guardians.manage', label: 'Link parents and children', hint: 'Who can book for a child' },
  { key: 'members.coaching_all', label: 'See all personal training details', hint: "Notes, health and logs for every coach's personal training clients" },
  { key: 'programs.manage', label: 'Programs and workouts', hint: 'Build and assign programs' },
  { key: 'reports.view', label: 'Class reports', hint: 'Attendance, class fill, no-shows, members by plan' },
  { key: 'settings.manage', label: 'Booking rules', hint: 'Booking windows, late cancels, waiver' },
  { key: 'billing.view', label: 'Rates and payments', hint: 'Prices, rates, payments and billing' },
];
const RIGHT_KEYS = new Set(RIGHTS.map((r) => r.key));
const ADMIN_ONLY_RIGHTS = ['staff.manage']; // invite staff, change roles: never grantable
const DEFAULT_ROLES = {
  coach: { name: 'Coach', builtin: true, rights: ['classes.run', 'classes.edit', 'members.invite', 'programs.manage'] },
  manager: { name: 'Manager', builtin: true, rights: ['classes.run', 'classes.edit', 'schedule.manage', 'coach_schedule.manage', 'members.invite', 'members.manage', 'guardians.manage', 'members.coaching_all', 'programs.manage', 'reports.view', 'settings.manage', 'billing.view'] },
};
const ALL_PERMISSIONS = [...RIGHT_KEYS, ...ADMIN_ONLY_RIGHTS].sort();
async function loadRoles(env) {
  let saved = {};
  try { saved = JSON.parse((await getState(env, 'staff_roles'))?.value || '{}'); } catch { saved = {}; }
  const roles = {};
  for (const [k, v] of Object.entries(DEFAULT_ROLES)) roles[k] = { ...v, rights: [...v.rights] };
  for (const [k, v] of Object.entries(saved)) {
    if (!v || typeof v !== 'object') continue;
    roles[k] = { name: String(v.name || k), builtin: !!DEFAULT_ROLES[k], rights: (v.rights || []).filter((r) => RIGHT_KEYS.has(r)) };
  }
  return roles;
}
// Attach the signed-in staff member's role and rights (once per request).
async function attachRights(env, user) {
  if (!user || user.role === 'admin' || user.user_type !== 'trainer') return user;
  const roles = await loadRoles(env);
  const key = roles[user.staff_role] ? user.staff_role : 'coach';
  user._staffRole = key;
  user._roleName = roles[key].name;
  user._rights = new Set(roles[key].rights);
  return user;
}

/* What each staff level can open about a member:
 * - Every coach: all group members' basics, coaching details included.
 * - Personal training clients (Client.personal_training + trainer_id): coaching
 *   details only for their assigned coach, managers and admins.
 * - Money (rates, prices, payments): managers and admins only. */
const MONEY_FIELDS = ['price', 'price_label', 'price_cents', 'rate', 'rate_cents', 'amount', 'amount_cents', 'balance', 'balance_cents',
  'billing', 'payment', 'payments', 'payment_method', 'payment_status', 'last_payment', 'last_payment_date', 'next_payment', 'next_payment_date',
  'stripe_customer_id', 'stripe_subscription_id', 'card_last4', 'card_brand', 'autopay', 'discount', 'invoice', 'invoices', 'failed_payments',
  'billing_status', 'tax_cents', 'discount_cents', 'refunded_cents', 'buyout_cents', 'bank_discount_pct', 'tax_rate_pct', 'stripe_product_id', 'stripe_price_id', 'stripe_price_bank_id', 'stripe_price_signature', 'stripe_tax_rate_id', 'stripe_invoice_id', 'stripe_payment_intent_id', // Phase 4 CORE
];
const MONEY_TYPES = new Set(['Client', 'Membership', 'MembershipPlan', 'Payment']);
const HEALTH_FIELDS = ['medical_notes', 'injuries', 'medical_conditions', 'medications', 'allergies', 'health_notes', 'health_history',
  'parq', 'emergency_notes', 'body_fat', 'weight', 'measurements', 'notes'];
// Coaching-detail records about a member, keyed by client_id.
const COACHING_DETAIL_TYPES = new Set(['ClientNote', 'ClientNotebookPage', 'JournalEntry', 'MealLog', 'CalorieLog', 'ProgressLog',
  'SleepLog', 'StressLog', 'CheckinResponse', 'FormCheck', 'Goal', 'MealPlan']);
const seesAllCoaching = (user) => can(user, 'members.coaching_all');
// SQL: this row is NOT about a personal training client assigned to another coach.
const notOthersPtClient = (col) => `NOT EXISTS (SELECT 1 FROM entities pt WHERE pt.entity_type = 'Client'
  AND (pt.id = ${col} OR json_extract(pt.data,'$.user_id') = ${col})
  AND json_extract(pt.data,'$.personal_training') = 1 AND COALESCE(json_extract(pt.data,'$.trainer_id'),'') <> ?)`;
const isOthersPtClient = (user, client) => !!client && client.personal_training === true && isStaff(user) && !seesAllCoaching(user) && client.trainer_id !== user.id;
function redactFor(user, type, rec) {
  if (type === 'Workout') return workoutFor(user, rec); // Phase 3 editor
  if (type === 'TimeOffRequest') return schedRedact(user, type, rec); // Scheduling: CORE
  if (!rec || !isStaff(user)) return rec;
  let out = rec;
  if (MONEY_TYPES.has(type) && !can(user, 'billing.view')) {
    out = { ...out };
    for (const f of MONEY_FIELDS) delete out[f];
  }
  if (type === 'Client' && isOthersPtClient(user, out)) {
    out = { ...out };
    for (const f of HEALTH_FIELDS) delete out[f];
    out.details_limited = true;
  }
  return out;
}
// Staff writes a coach may not make. Money fields are dropped from the write
// (a coach never sees them, so they can't knowingly change them).
function staffFieldViolation(user, type, fields, existing = null) {
  if (!isStaff(user)) return null;
  if (MONEY_TYPES.has(type) && !can(user, 'billing.view')) for (const f of MONEY_FIELDS) delete fields[f];
  if (type !== 'Client' || seesAllCoaching(user)) return null;
  if (existing && isOthersPtClient(user, existing)) return 'This is another coach\'s personal training client. Ask a manager.';
  const nextPt = 'personal_training' in fields ? fields.personal_training === true : existing?.personal_training === true;
  const nextTrainer = 'trainer_id' in fields ? fields.trainer_id : existing?.trainer_id;
  if (nextPt && nextTrainer !== user.id && ('personal_training' in fields || 'trainer_id' in fields)) {
    return 'Coaches can only make someone their own personal training client.';
  }
  return null;
}
function staffRole(user) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  if (user.user_type !== 'trainer') return null;
  return user._staffRole || (DEFAULT_ROLES[user.staff_role] ? user.staff_role : 'coach');
}
function can(user, perm) {
  const r = staffRole(user);
  if (r === 'admin') return true;
  if (!r) return false;
  const rights = user._rights || new Set(DEFAULT_ROLES[r]?.rights || DEFAULT_ROLES.coach.rights);
  return rights.has(perm);
}
const permissionsOf = (user) => {
  const r = staffRole(user);
  if (r === 'admin') return ALL_PERMISSIONS;
  if (!r) return [];
  return ALL_PERMISSIONS.filter((p) => can(user, p));
};
const NO_PERMISSION = { success: false, error: 'Your role doesn\'t allow this. Ask an admin.', code: 'forbidden' };
// Entity types whose writes need more than plain staff access.
const TYPE_PERMISSION = {
  Membership: 'members.manage', MembershipPlan: 'members.manage',
  GymSettings: 'settings.manage', ClassType: 'schedule.manage', ClassSlot: 'schedule.manage', ClassDayChange: 'schedule.manage',
  WorkoutScore: 'classes.run', // Phase 3 MEMBER
  Movement: 'programs.manage', Benchmark: 'programs.manage', Workout: 'programs.manage', // Phase 3 editor
};
const isMemberUser = (user) => !!user && user.role !== 'admin' && (user.user_type === 'client' || user.user_type === 'independent');
const staffWriteDenied = (type, user) => ((STAFF_LIBRARY_TYPES.has(type) || STAFF_WRITE_TYPES.has(type)) && !isStaff(user))
  || (TYPE_PERMISSION[type] && isStaff(user) && !can(user, TYPE_PERMISSION[type]))
  || GYM_BILLING_WRITE_LOCKED.has(type) // Phase 4 CORE: Payment rows come only from Stripe
  || (SCHED_TYPES.has(type) && !managesCoachSchedule(user)); // Scheduling: CORE — coaches write only through the functions

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

  if (type === 'WorkoutScore') return "Log scores from Today's Workout."; // Phase 3 MEMBER
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
  const resp = await fetch(`${String(env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '')}/v1/${path}`, { // base overridable for tests (Phase 4 CORE)
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
  if (type === 'Workout') return workoutReadScope(user); // Phase 3 editor
  if (type === 'Payment') return paymentReadScope(user); // Phase 4 CORE
  if (SCHED_TYPES.has(type)) return schedEntityScope(type, user); // Scheduling: CORE
  if (SHARED_TYPES.has(type) || STAFF_LIBRARY_TYPES.has(type)) return null;
  if (isStaff(user) && !STAFF_PRIVATE_TYPES.has(type)) {
    if (COACHING_DETAIL_TYPES.has(type) && !seesAllCoaching(user)) {
      return { sql: notOthersPtClient("json_extract(entities.data,'$.client_id')"), binds: [user.id] };
    }
    return null;
  }
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

// ===== Phase 3: editor =====
// Daily class workouts (gym-owned): the Movement and Benchmark libraries and
// one Workout per date per class type (class_type_id null = every class).
// Coaches with programs.manage write them; members see a workout only once it
// is published and its publish time has passed, and never see coach_notes.
const WORKOUT_SECTION_KINDS = new Set(['warmup', 'strength', 'metcon', 'accessory', 'other']);
const SCORING_TYPES = new Set(['time', 'rounds_reps', 'load', 'reps', 'distance', 'calories', 'check', 'none']);
const SCORING_UNITS = new Set(['lb', 'kg', 'm', 'km', 'mi', 'cal']);
const MOVEMENT_CATEGORIES = new Set(['weightlifting', 'gymnastics', 'monostructural', 'other']);
const BENCHMARK_KINDS = new Set(['girl', 'hero', 'open', 'lift', 'other']);
const WORKOUT_PUBLISH_DEFAULTS = { workout_publish_days_before: 1, workout_publish_time: '20:00' };

const managesWorkouts = (user) => can(user, 'programs.manage');

// Who may read which Workout rows (used by entityScope for the generic routes too).
function workoutReadScope(user) {
  if (managesWorkouts(user)) return null;
  return {
    sql: `(json_extract(data,'$.status') = 'published' AND (json_extract(data,'$.publish_at') IS NULL OR json_extract(data,'$.publish_at') <= ?))`,
    binds: [nowISO()],
  };
}
function workoutFor(user, w) {
  if (!w || managesWorkouts(user)) return w;
  const { coach_notes: _n, ...rest } = w;
  return rest;
}
const workoutVisibleNow = (w, nowIso = nowISO()) => w.status === 'published' && (!w.publish_at || w.publish_at <= nowIso);

function normalizeScoring(s) {
  const src = s && typeof s === 'object' ? s : {};
  const type = SCORING_TYPES.has(src.type) ? src.type : 'none';
  const out = { type, lower_is_better: type === 'time' };
  const cap = Number(src.time_cap_sec);
  if (Number.isFinite(cap) && cap > 0) out.time_cap_sec = Math.round(cap);
  if (SCORING_UNITS.has(src.unit)) out.unit = src.unit;
  const rpr = Number(src.reps_per_round);
  if (type === 'rounds_reps' && Number.isFinite(rpr) && rpr > 0) out.reps_per_round = Math.round(rpr);
  return out;
}
function normalizeSections(list) {
  const used = new Set();
  return (Array.isArray(list) ? list : []).slice(0, 20).map((s, i) => {
    let id = typeof s?.id === 'string' && s.id.trim() ? s.id.trim().slice(0, 40) : `s${i + 1}`;
    for (let n = i + 1; used.has(id); n += 1) id = `s${n + 1}`;
    used.add(id);
    return {
      id,
      kind: WORKOUT_SECTION_KINDS.has(s?.kind) ? s.kind : 'other',
      title: String(s?.title || '').slice(0, 200),
      description: String(s?.description || '').slice(0, 5000),
      scoring: normalizeScoring(s?.scoring),
      movement_ids: (Array.isArray(s?.movement_ids) ? s.movement_ids : []).filter((x) => typeof x === 'string' && x).slice(0, 30),
      benchmark_id: typeof s?.benchmark_id === 'string' && s.benchmark_id ? s.benchmark_id : null,
    };
  });
}
const toIsoOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

// Gym default publish time, stored on the GymSettings record.
async function workoutPublishDefaults(env) {
  const row = parseRow(await env.DB.prepare(
    `SELECT * FROM entities WHERE entity_type='GymSettings' ORDER BY created_date ASC LIMIT 1`
  ).first());
  const days = numOr(row?.workout_publish_days_before, WORKOUT_PUBLISH_DEFAULTS.workout_publish_days_before);
  const time = hmToMin(row?.workout_publish_time) !== null ? row.workout_publish_time : WORKOUT_PUBLISH_DEFAULTS.workout_publish_time;
  return { workout_publish_days_before: Math.max(0, Math.min(14, Math.round(days))), workout_publish_time: time };
}
async function defaultPublishAt(env, date) {
  const d = await workoutPublishDefaults(env);
  return new Date(easternToUTC(pAddDays(date, -d.workout_publish_days_before), d.workout_publish_time)).toISOString();
}

const SEED_MOVEMENTS = [
  // Barbell lifts (worth a 1-rep max)
  ['Back Squat', 'weightlifting', true], ['Front Squat', 'weightlifting', true], ['Overhead Squat', 'weightlifting', true],
  ['Deadlift', 'weightlifting', true], ['Sumo Deadlift', 'weightlifting', true], ['Romanian Deadlift', 'weightlifting', true],
  ['Clean', 'weightlifting', true, ['Squat Clean']], ['Power Clean', 'weightlifting', true], ['Hang Power Clean', 'weightlifting', true],
  ['Clean and Jerk', 'weightlifting', true, ['C&J']], ['Snatch', 'weightlifting', true, ['Squat Snatch']], ['Power Snatch', 'weightlifting', true],
  ['Hang Power Snatch', 'weightlifting', true], ['Strict Press', 'weightlifting', true, ['Shoulder Press', 'Overhead Press']],
  ['Push Press', 'weightlifting', true], ['Push Jerk', 'weightlifting', true], ['Split Jerk', 'weightlifting', true],
  ['Bench Press', 'weightlifting', true], ['Thruster', 'weightlifting', true],
  // Other loaded movements
  ['Kettlebell Swing', 'weightlifting', false, ['KB Swing']], ['Dumbbell Snatch', 'weightlifting', false, ['DB Snatch']],
  ['Wall Ball', 'other', false, ['Wall Ball Shot']], ['Sandbag Carry', 'other', false],
  // Gymnastics
  ['Pull-Up', 'gymnastics', false, ['Pullup']], ['Chest-to-Bar Pull-Up', 'gymnastics', false, ['C2B']],
  ['Bar Muscle-Up', 'gymnastics', false, ['BMU']], ['Ring Muscle-Up', 'gymnastics', false, ['RMU']],
  ['Toes-to-Bar', 'gymnastics', false, ['T2B']], ['Handstand Push-Up', 'gymnastics', false, ['HSPU']],
  ['Handstand Walk', 'gymnastics', false], ['Push-Up', 'gymnastics', false], ['Ring Dip', 'gymnastics', false],
  ['Sit-Up', 'gymnastics', false, ['AbMat Sit-Up']], ['Air Squat', 'gymnastics', false], ['Pistol', 'gymnastics', false, ['Single-Leg Squat']],
  ['Rope Climb', 'gymnastics', false], ['Burpee', 'gymnastics', false], ['Box Jump', 'gymnastics', false], ['Walking Lunge', 'gymnastics', false],
  // Monostructural
  ['Row', 'monostructural', false, ['Rower', 'Erg']], ['Run', 'monostructural', false], ['Bike', 'monostructural', false, ['Assault Bike', 'Echo Bike']],
  ['Ski Erg', 'monostructural', false], ['Double-Under', 'monostructural', false, ['DU']], ['Single-Under', 'monostructural', false],
];
const forTime = (cap) => ({ type: 'time', lower_is_better: true, ...(cap ? { time_cap_sec: cap } : {}) });
const SEED_BENCHMARKS = [
  ['Fran', 'girl', '21-15-9 reps for time:\nThrusters (95/65 lb)\nPull-ups', forTime(600)],
  ['Grace', 'girl', '30 clean and jerks for time (135/95 lb)', forTime(600)],
  ['Isabel', 'girl', '30 snatches for time (135/95 lb)', forTime(600)],
  ['Diane', 'girl', '21-15-9 reps for time:\nDeadlifts (225/155 lb)\nHandstand push-ups', forTime(900)],
  ['Helen', 'girl', '3 rounds for time:\n400 m run\n21 kettlebell swings (53/35 lb)\n12 pull-ups', forTime(1200)],
  ['Karen', 'girl', '150 wall balls for time (20/14 lb)', forTime(1200)],
  ['Annie', 'girl', '50-40-30-20-10 reps for time:\nDouble-unders\nSit-ups', forTime(1200)],
  ['Jackie', 'girl', 'For time:\n1,000 m row\n50 thrusters (45 lb)\n30 pull-ups', forTime(1200)],
  ['Cindy', 'girl', 'As many rounds as possible in 20 minutes:\n5 pull-ups\n10 push-ups\n15 air squats', { type: 'rounds_reps', reps_per_round: 30, time_cap_sec: 1200, lower_is_better: false }],
  ['Murph', 'hero', 'For time, with a 20/14 lb vest:\n1 mile run\n100 pull-ups\n200 push-ups\n300 air squats\n1 mile run\nPartition the pull-ups, push-ups and squats as needed.', forTime(3600)],
  ['DT', 'hero', '5 rounds for time (155/105 lb):\n12 deadlifts\n9 hang power cleans\n6 push jerks', forTime(1200)],
  ['Back Squat 1RM', 'lift', 'Build to a heavy single back squat.', { type: 'load', unit: 'lb', lower_is_better: false }],
  ['Deadlift 1RM', 'lift', 'Build to a heavy single deadlift.', { type: 'load', unit: 'lb', lower_is_better: false }],
  ['Clean 1RM', 'lift', 'Build to a heavy single clean.', { type: 'load', unit: 'lb', lower_is_better: false }],
  ['Snatch 1RM', 'lift', 'Build to a heavy single snatch.', { type: 'load', unit: 'lb', lower_is_better: false }],
  ['Strict Press 1RM', 'lift', 'Build to a heavy single strict press.', { type: 'load', unit: 'lb', lower_is_better: false }],
  ['Clean and Jerk 1RM', 'lift', 'Build to a heavy single clean and jerk.', { type: 'load', unit: 'lb', lower_is_better: false }],
];

// Seed the sample libraries the first time they are used (once; deleting
// entries later never brings them back).
let workoutLibraryChecked = false;
async function ensureWorkoutLibrary(env) {
  if (workoutLibraryChecked) return;
  if (await getState(env, 'workout_library_seeded')) { workoutLibraryChecked = true; return; }
  const now = nowISO();
  const ins = (id, type, data) => env.DB.prepare(
    `INSERT OR IGNORE INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)`
  ).bind(id, type, JSON.stringify(data), 'system', now, now);
  const hasMov = await env.DB.prepare(`SELECT 1 FROM entities WHERE entity_type='Movement' LIMIT 1`).first();
  const hasBench = await env.DB.prepare(`SELECT 1 FROM entities WHERE entity_type='Benchmark' LIMIT 1`).first();
  const stmts = [];
  if (!hasMov) for (const [name, category, is_lift, aliases = []] of SEED_MOVEMENTS) stmts.push(ins(`mv_${slugify(name)}`, 'Movement', { name, category, is_lift, aliases }));
  if (!hasBench) for (const [name, kind, description, scoring] of SEED_BENCHMARKS) stmts.push(ins(`bm_${slugify(name)}`, 'Benchmark', { name, kind, description, scoring }));
  if (stmts.length) await env.DB.batch(stmts);
  await setState(env, 'workout_library_seeded', now);
  workoutLibraryChecked = true;
}

// Cleans Movement/Benchmark writes on the generic entity routes.
function normalizeLibraryFields(type, fields) {
  if (type === 'Movement') {
    if ('name' in fields) fields.name = String(fields.name || '').trim().slice(0, 120);
    if ('category' in fields && !MOVEMENT_CATEGORIES.has(fields.category)) fields.category = 'other';
    if ('is_lift' in fields) fields.is_lift = fields.is_lift === true;
    if ('aliases' in fields) fields.aliases = (Array.isArray(fields.aliases) ? fields.aliases : []).map((a) => String(a).trim()).filter(Boolean).slice(0, 20);
  }
  if (type === 'Benchmark') {
    if ('name' in fields) fields.name = String(fields.name || '').trim().slice(0, 120);
    if ('kind' in fields && !BENCHMARK_KINDS.has(fields.kind)) fields.kind = 'other';
    if ('scoring' in fields) fields.scoring = normalizeScoring(fields.scoring);
  }
}

async function loadWorkoutRange(env, user, from, to, classTypeId) {
  const scope = workoutReadScope(user);
  const where = [`json_extract(data,'$.date') >= ?`, `json_extract(data,'$.date') <= ?`];
  const binds = [from, to];
  if (classTypeId !== undefined) {
    if (classTypeId === null) where.push(`json_extract(data,'$.class_type_id') IS NULL`);
    else { where.push(`json_extract(data,'$.class_type_id') = ?`); binds.push(classTypeId); }
  }
  if (scope) { where.push(scope.sql); binds.push(...scope.binds); }
  const rows = await selectEntities(env, 'Workout', where.join(' AND '), binds);
  rows.sort((a, b) => (a.date === b.date ? (a.class_type_id ? 1 : 0) - (b.class_type_id ? 1 : 0) : a.date < b.date ? -1 : 1));
  return rows.map((w) => workoutFor(user, w));
}

// Movement and benchmark names the workouts refer to, so screens can show them.
async function workoutRefs(env, workouts) {
  const mids = new Set(); const bids = new Set();
  for (const w of workouts) for (const s of w.sections || []) {
    (s.movement_ids || []).forEach((m) => mids.add(m));
    if (s.benchmark_id) bids.add(s.benchmark_id);
  }
  const pick = async (type, ids) => {
    if (!ids.size) return {};
    const rows = await selectEntities(env, type, `id IN (${inList([...ids])})`, [...ids]);
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  };
  return { movements: await pick('Movement', mids), benchmarks: await pick('Benchmark', bids) };
}

async function workoutFunction(name, payload, user, env) {
  if (!user) return { success: false, error: 'Please sign in.' };
  await ensureWorkoutLibrary(env);
  const p = payload || {};
  switch (name) {
    case 'workoutLibrary': {
      const movements = await selectEntities(env, 'Movement');
      const benchmarks = await selectEntities(env, 'Benchmark');
      const byName = (a, b) => String(a.name).localeCompare(String(b.name));
      return { success: true, movements: movements.sort(byName), benchmarks: benchmarks.sort(byName), publish_defaults: await workoutPublishDefaults(env) };
    }
    case 'listWorkouts': {
      const from = isDateKey(p.from) ? p.from : programToday();
      const to = isDateKey(p.to) ? p.to : pAddDays(from, 6);
      if (pDaysBetween(from, to) > 92 || to < from) return { success: false, error: 'Pick a range of up to three months.' };
      const workouts = await loadWorkoutRange(env, user, from, to, p.class_type_id === undefined ? undefined : (p.class_type_id || null));
      return { success: true, from, to, workouts, publish_defaults: await workoutPublishDefaults(env) };
    }
    case 'saveWorkout': {
      if (!managesWorkouts(user)) return NO_PERMISSION;
      const existing = p.id ? await getEntityById(env, 'Workout', p.id) : null;
      if (p.id && !existing) return { success: false, error: 'That workout is gone. Refresh and try again.' };
      const date = p.date ?? existing?.date;
      if (!isDateKey(date)) return { success: false, error: 'Pick a date for the workout.' };
      const classTypeId = 'class_type_id' in p ? (p.class_type_id || null) : (existing?.class_type_id ?? null);
      if (classTypeId && !(await getEntityById(env, 'ClassType', classTypeId))) return { success: false, error: 'That class type no longer exists.' };
      const status = p.status === 'published' ? 'published' : p.status === 'draft' ? 'draft' : (existing?.status || 'draft');
      let publishAt = 'publish_at' in p ? (p.publish_at === 'default' ? await defaultPublishAt(env, date) : toIsoOrNull(p.publish_at)) : (existing?.publish_at ?? null);
      if (publishAt === undefined) return { success: false, error: 'That publish time is not valid.' };
      if (status === 'draft' && !('publish_at' in p)) publishAt = existing?.publish_at ?? null;
      const clash = await env.DB.prepare(
        `SELECT id FROM entities WHERE entity_type='Workout' AND json_extract(data,'$.date') = ?
         AND COALESCE(json_extract(data,'$.class_type_id'),'') = ? AND id <> ? LIMIT 1`
      ).bind(date, classTypeId || '', existing?.id || '').first();
      if (clash) return { success: false, error: 'There is already a workout for that day and class. Edit that one instead.', code: 'duplicate', id: clash.id };
      const data = {
        date,
        class_type_id: classTypeId,
        title: String(p.title ?? existing?.title ?? '').slice(0, 200),
        sections: normalizeSections(p.sections ?? existing?.sections),
        coach_notes: String(p.coach_notes ?? existing?.coach_notes ?? '').slice(0, 5000),
        status,
        publish_at: publishAt,
      };
      let saved;
      if (existing) saved = await patchEntity(env, existing, data);
      else saved = await insertEntity(env, 'Workout', data, user.email);
      await audit(env, { actor: user.email, action: existing ? 'workout_updated' : 'workout_created', target: 'Workout', targetId: saved.id, detail: `${date} ${status}` });
      return { success: true, workout: saved };
    }
    case 'deleteWorkout': {
      if (!managesWorkouts(user)) return NO_PERMISSION;
      const w = await getEntityById(env, 'Workout', p.id);
      if (!w) return { success: false, error: 'That workout is already gone.' };
      await env.DB.prepare(`DELETE FROM entities WHERE id = ? AND entity_type='Workout'`).bind(w.id).run();
      await audit(env, { actor: user.email, action: 'workout_deleted', target: 'Workout', targetId: w.id, detail: w.date });
      return { success: true };
    }
    case 'copyWorkouts': {
      if (!managesWorkouts(user)) return NO_PERMISSION;
      const days = Math.round(Number(p.days) || 7);
      if (!isDateKey(p.from_date) || !isDateKey(p.to_date)) return { success: false, error: 'Pick the dates to copy from and to.' };
      if (days < 1 || days > 31) return { success: false, error: 'Copy between 1 and 31 days.' };
      const shift = pDaysBetween(p.from_date, p.to_date);
      if (shift === 0) return { success: false, error: 'Pick a different start date.' };
      const source = await selectEntities(env, 'Workout', `json_extract(data,'$.date') >= ? AND json_extract(data,'$.date') <= ?`, [p.from_date, pAddDays(p.from_date, days - 1)]);
      const created = []; const skipped = [];
      for (const w of source) {
        const date = pAddDays(w.date, shift);
        const clash = await env.DB.prepare(
          `SELECT id FROM entities WHERE entity_type='Workout' AND json_extract(data,'$.date') = ? AND COALESCE(json_extract(data,'$.class_type_id'),'') = ? LIMIT 1`
        ).bind(date, w.class_type_id || '').first();
        if (clash) { skipped.push({ date, class_type_id: w.class_type_id || null }); continue; }
        created.push(await insertEntity(env, 'Workout', {
          date, class_type_id: w.class_type_id || null, title: w.title || '', sections: normalizeSections(w.sections),
          coach_notes: w.coach_notes || '', status: 'draft', publish_at: null,
        }, user.email));
      }
      await audit(env, { actor: user.email, action: 'workouts_copied', target: 'Workout', detail: `${p.from_date} +${days}d -> ${p.to_date}: ${created.length} made, ${skipped.length} skipped` });
      return { success: true, created, skipped };
    }
    case 'todayWorkout': {
      const date = isDateKey(p.date) ? p.date : programToday();
      const nowIso = nowISO();
      const preview = p.include_drafts === true && managesWorkouts(user);
      const all = (await selectEntities(env, 'Workout', `json_extract(data,'$.date') = ?`, [date]))
        .filter((w) => preview || workoutVisibleNow(w, nowIso));
      let typeIds = p.class_type_id ? [p.class_type_id] : [];
      if (!typeIds.length && !isStaff(user)) {
        // The member's own booked classes that day decide which version they see.
        const ids = await myClientIds(env, user);
        const kids = ids.length ? (await guardedChildren(env, ids)).map((c) => c.id) : [];
        const cids = [...ids, ...kids];
        if (cids.length) {
          const { results } = await env.DB.prepare(
            `SELECT DISTINCT json_extract(s.data,'$.class_type_id') AS t FROM entities r JOIN entities s ON s.id = json_extract(r.data,'$.session_id') AND s.entity_type='ClassSession'
             WHERE r.entity_type='Reservation' AND json_extract(r.data,'$.client_id') IN (${inList(cids)})
             AND json_extract(r.data,'$.status') IN (${sqlStr(ACTIVE_RES)}) AND json_extract(s.data,'$.date') = ?`
          ).bind(...cids, date).all();
          typeIds = results.map((r) => r.t).filter(Boolean);
        }
      }
      let picked;
      if (typeIds.length) {
        const general = all.find((w) => !w.class_type_id);
        const seen = new Set();
        picked = [];
        for (const t of typeIds) {
          const w = all.find((x) => x.class_type_id === t) || general;
          if (w && !seen.has(w.id)) { seen.add(w.id); picked.push(w); }
        }
      } else {
        picked = all.sort((a, b) => (a.class_type_id ? 1 : 0) - (b.class_type_id ? 1 : 0));
      }
      picked = picked.map((w) => workoutFor(user, w));
      return { success: true, date, workouts: picked, ...(await workoutRefs(env, picked)) };
    }
    default:
      return { success: false, error: 'Unknown function.' };
  }
}
// ===== end Phase 3: editor =====

/* ------------------------------ functions ------------------------------- */

// Email goes out through the gym's own mailbox (SMTP_USER and SMTP_PASS), or
// through Resend if that is set up instead.
const emailReady = (env) => !!(env.SMTP_USER && env.SMTP_PASS) || !!env.RESEND_API_KEY;

async function sendEmail(env, { to, subject, html }) {
  if (env.SMTP_USER && env.SMTP_PASS) {
    try {
      const { connect } = await import('cloudflare:sockets');
      await smtpSend(connect, {
        host: env.SMTP_HOST || 'my.mailbux.com', port: env.SMTP_PORT || 587, user: env.SMTP_USER, pass: env.SMTP_PASS,
        from: env.EMAIL_FROM || `Brigade Athletic Club <${env.SMTP_USER}>`, to, subject, html,
      });
      return { success: true };
    } catch (e) {
      console.error('email failed', e?.message);
      return { success: false, error: e?.message || 'The email could not be sent.' };
    }
  }
  if (!env.RESEND_API_KEY) return { success: false, error: 'Email is not set up yet.' };
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
  if (clientId && !clients.some((c) => c.id === clientId)) {
    // A guardian may act for a child linked to them by staff. The child keeps
    // its own records: its own plan, holds and reservations, never the parent's.
    const child = (await guardedChildren(env, clients.map((c) => c.id))).find((c) => c.id === clientId);
    if (!child) return { error: 'You can only book classes for yourself.' };
    const login = await clientLogin(env, child);
    return { client: child, clientIds: [child.id], loginId: login?.id || child.user_id || null, guardianId: user.id };
  }
  const client = clients.find((c) => c.id === clientId) || clients.find((c) => c.user_id === user.id) || clients[0];
  return { client, clientIds: clients.map((c) => c.id), loginId: user.id };
}

/* ---- guardians: a parent's login can book for a linked child ---- */
// Staff link a child's Client record to a guardian's Client record. The
// guardian is whoever signs in as that Client (email/user_id), so a link made
// before the parent accepts their invite starts working once they do.
// Unlinking only marks the row removed; nothing about the member is deleted.
const GUARDIAN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS client_guardians (
    client_id TEXT NOT NULL, guardian_client_id TEXT NOT NULL,
    created_by TEXT, created_date TEXT NOT NULL, removed_by TEXT, removed_date TEXT,
    PRIMARY KEY (client_id, guardian_client_id))`,
  `CREATE INDEX IF NOT EXISTS idx_client_guardians_guardian ON client_guardians(guardian_client_id)`,
];
const MAX_GUARDIANS = 6;

// Child Client records linked to any of these guardian Client ids (never the guardian's own).
async function guardedChildren(env, guardianClientIds) {
  if (!guardianClientIds.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT e.* FROM client_guardians g JOIN entities e ON e.id = g.client_id AND e.entity_type = 'Client'
     WHERE g.removed_date IS NULL AND g.guardian_client_id IN (${inList(guardianClientIds)}) ORDER BY e.created_date ASC`
  ).bind(...guardianClientIds).all();
  return results.map(rowToEntity).filter((c) => !guardianClientIds.includes(c.id));
}

// Client ids a signed-in member may act for in class functions: their own and their linked children.
async function actableClientIds(env, user) {
  const own = await myClientIds(env, user);
  return [...own, ...(await guardedChildren(env, own)).map((c) => c.id)];
}

async function clientGuardians(env, clientId) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, g.created_date AS linked_date FROM client_guardians g JOIN entities e ON e.id = g.guardian_client_id AND e.entity_type = 'Client'
     WHERE g.removed_date IS NULL AND g.client_id = ? ORDER BY g.created_date ASC`
  ).bind(clientId).all();
  return results.map((r) => ({ ...rowToEntity(r), linked_date: r.linked_date }));
}

const familyPerson = async (env, c) => ({
  id: c.id, full_name: c.full_name || '', email: c.email || '', has_login: !!(await clientLogin(env, c)),
});

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

// Holds live on the membership: m.holds = [{ id, from, to, planned_to, reason,
// status: 'active'|'cancelled', extend_days, created_by, created_at, ... }].
// Ending a hold early shortens `to` (planned_to keeps the first plan).
// Cancelled holds stay in the list as history. The older single hold
// (status 'on_hold' + hold_from/hold_to) is still honoured below.
const liveHolds = (m) => (Array.isArray(m?.holds) ? m.holds : [])
  .filter((h) => h && h.status !== 'cancelled' && isDateKey(h.from) && isDateKey(h.to));
function holdOn(m, date) {
  const h = liveHolds(m).find((x) => x.from <= date && date <= x.to);
  if (h) return h;
  const legacy = isDateKey(m?.hold_from) && m.hold_from <= date && (!isDateKey(m.hold_to) || date <= m.hold_to);
  if (legacy && (m.status === 'on_hold' || m.status === 'active')) return { from: m.hold_from, to: isDateKey(m.hold_to) ? m.hold_to : null, legacy: true };
  return null;
}
// "Dec 10" (adds the year when it isn't this year).
const shortDay = (k, today = programToday()) => new Date(keyToUTC(k)).toLocaleDateString('en-US', {
  timeZone: 'UTC', month: 'short', day: 'numeric', ...(String(k).slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
});

function membershipCoversDate(m, date) {
  if (!m || m.status === 'ended') return false;
  if (!isDateKey(m.start_date) || m.start_date > date) return false;
  if (isDateKey(m.end_date) && m.end_date < date) return false;
  if (liveHolds(m).some((h) => h.from <= date && date <= h.to)) return false;
  const inHold = isDateKey(m.hold_from) && m.hold_from <= date && (!isDateKey(m.hold_to) || date <= m.hold_to);
  if (m.status === 'on_hold') return isDateKey(m.hold_from) && !inHold;
  if (m.status !== 'active') return false;
  return !inHold;
}
const membershipCoversType = (m, typeId) => !Array.isArray(m.class_type_ids) || m.class_type_ids.length === 0 || m.class_type_ids.includes(typeId);
function membershipLimit(m) {
  if (NO_LIMIT_KINDS.has(m.kind)) return null;
  if (m.kind === 'punch' || m.kind === 'punch_card' || m.kind === 'drop_in' || m.limit_period === 'total') {
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
// SQL condition "this membership is still live on `date`": not ended, not past
// its end date, not on hold. Checked inside the insert so a hold or end date
// saved while someone is booking still wins.
const MEMBERSHIP_LIVE_SQL = `EXISTS (SELECT 1 FROM entities mm WHERE mm.id = ? AND mm.entity_type = 'Membership'
  AND COALESCE(json_extract(mm.data,'$.status'),'active') != 'ended'
  AND (json_extract(mm.data,'$.end_date') IS NULL OR json_extract(mm.data,'$.end_date') = '' OR json_extract(mm.data,'$.end_date') >= ?)
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(mm.data,'$.holds'),'[]')) h
    WHERE COALESCE(json_extract(h.value,'$.status'),'active') != 'cancelled'
      AND json_extract(h.value,'$.from') <= ? AND json_extract(h.value,'$.to') >= ?))`;
function allowanceGuard(m, date, s) {
  const g = allowanceLimitGuard(m, date, s);
  return { ...g, sql: `${MEMBERSHIP_LIVE_SQL} AND ${g.sql}`, binds: [m.id, date, date, date, ...g.binds] };
}
function allowanceLimitGuard(m, date, s) {
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
  if (!covering.length) return whyNotCovered(all, session);
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

// Plain-words reason when no membership covers a class date: on hold, ended,
// or none at all. staffReason is the same sentence about "this client".
function whyNotCovered(all, session) {
  const date = session.date;
  const today = programToday();
  const typed = all.filter((m) => membershipCoversType(m, session.class_type_id) && isDateKey(m.start_date) && m.start_date <= date);
  for (const m of typed) {
    if (m.status === 'ended' || (isDateKey(m.end_date) && m.end_date < date)) continue;
    const h = holdOn(m, date);
    if (!h) continue;
    const until = isDateKey(h.to) ? ` until ${shortDay(h.to, today)}` : '';
    return { reason: `Your membership is on hold${until}.`, staffReason: `This client's membership is on hold${until}.`, code: 'on_hold' };
  }
  const ended = typed.filter((m) => isDateKey(m.end_date) && m.end_date < date)
    .sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
  if (ended) {
    const d = shortDay(ended.end_date, today);
    return ended.end_date >= today
      ? { reason: `Your membership ends ${d}, so you can't book classes after that.`, staffReason: `This client's membership ends ${d}.`, code: 'membership_ended' }
      : { reason: `Your membership ended ${d}.`, staffReason: `This client's membership ended ${d}.`, code: 'membership_ended' };
  }
  return { reason: 'No active membership covers this class.', code: 'no_membership' };
}

// Save a membership only if nobody changed it since we read it.
async function patchMembershipIf(env, m, patch) {
  const { id, created_by: _c, created_date: _d, updated_date, ...data } = m;
  const now = nowISO();
  const res = await env.DB.prepare(
    `UPDATE entities SET data = ?, updated_date = ? WHERE id = ? AND entity_type = 'Membership' AND updated_date = ?`
  ).bind(JSON.stringify({ ...data, ...patch }), now, id, updated_date).run();
  return !!res?.meta?.changes;
}

// Cancel a membership's bookings (reserved / waitlisted, not started yet) on
// dates from..to, for a hold or an end date. Frees spots for the waitlist.
// Attendance and past records are never touched.
async function releaseMembershipBookings(env, m, from, to, reason, actor) {
  const rows = await selectEntities(env, 'Reservation',
    `json_extract(data,'$.membership_id') = ? AND json_extract(data,'$.status') IN ('reserved','waitlisted') AND json_extract(data,'$.date') >= ? AND json_extract(data,'$.date') <= ?`,
    [m.id, from, to || '9999-12-31']);
  const now = Date.now();
  const touched = new Set(); const freed = new Set();
  let n = 0;
  for (const r of rows) {
    if (Date.parse(r.start_at) <= now) continue;
    const ts = nowISO();
    const res = await env.DB.prepare(
      `UPDATE entities SET data = json_set(data, '$.status', 'cancelled', '$.cancelled_at', ?, '$.waitlist_position', NULL, '$.cancelled_by', ?, '$.cancel_reason', ?), updated_date = ?
       WHERE id = ? AND entity_type = 'Reservation' AND json_extract(data,'$.status') = ?`
    ).bind(ts, actor.id, reason, ts, r.id, r.status).run();
    if (!res?.meta?.changes) continue;
    n++;
    touched.add(r.session_id);
    if (r.status === 'reserved') freed.add(r.session_id);
  }
  if (touched.size) {
    const s = await getGymSettings(env);
    for (const sid of touched) {
      await recountSession(env, sid);
      if (freed.has(sid)) await promoteWaitlist(env, await getEntityById(env, 'ClassSession', sid), s, actor);
    }
  }
  return n;
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
  if (guard) { conds.push(guard.sql); condBinds.push(...guard.binds); }
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
async function notifyClassMember(env, { loginId, title, message, createdBy, tag = 'classes' }) {
  if (!loginId) return false;
  await insertEntity(env, 'Notification', { user_id: loginId, type: 'class', title, message, link: '/ClientClasses', read: false }, createdBy);
  const p = sendPushToUser(env, loginId, { title, body: String(message).slice(0, 140), url: '/ClientClasses', tag });
  if (env.__waitUntil) env.__waitUntil(p); else await p;
  return true;
}

// Booking confirmations: tell the member when they book, join the waitlist or
// cancel (themselves or by a coach). Best-effort: a failed notice never undoes
// the booking.
async function notifyBookingChange(env, { reservation, session, actor, kind, late = false }) {
  const loginId = reservation?.client_user_id;
  if (!loginId) return false;
  const name = session?.class_type_name || reservation.class_name || 'class';
  const when = session ? classWhen(session) : '';
  const byCoach = actor && actor.id !== loginId;
  const notes = {
    reserved: { title: 'You are booked', message: `${name} on ${when}. See you there.` },
    waitlisted: {
      title: 'You are on the waitlist',
      message: `${name} on ${when} is full. You are number ${reservation.waitlist_position || 1} on the waitlist. We will tell you if a spot opens.`,
    },
    cancelled: {
      title: 'Booking cancelled',
      message: `${byCoach ? 'The gym cancelled your spot in' : 'You cancelled your spot in'} ${name} on ${when}.${late ? ' This counts as a late cancel.' : ''}`,
    },
    left_waitlist: { title: 'Off the waitlist', message: `${byCoach ? 'The gym took you off' : 'You left'} the waitlist for ${name} on ${when}.` },
  }[kind];
  if (!notes) return false;
  try {
    return await notifyClassMember(env, { loginId, ...notes, createdBy: await classActorEmail(env, actor, session) });
  } catch (e) {
    console.error('booking notice failed', e?.message);
    return false;
  }
}

/* ---- class reminders (run by the 15-minute cron) ---- */
// Members choose on/off and how long before class (users.data.notifications:
// class_reminders, class_reminder_minutes). Default: on, 2 hours before.
const REMINDER_CHOICES = [30, 60, 120, 180];
const REMINDER_DEFAULT_MIN = 120;
function reminderPrefs(userData) {
  const n = (userData && typeof userData === 'object' && userData.notifications) || {};
  const mins = Number(n.class_reminder_minutes);
  return {
    on: n.class_reminders !== false,
    minutes: REMINDER_CHOICES.includes(mins) ? mins : REMINDER_DEFAULT_MIN,
    email: n.email_reminders !== false,
  };
}
const classTimeLabel = (session, today) => {
  const mins = hmToMin(session.start_time) ?? 0;
  const h = Math.floor(mins / 60);
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(mins % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  return session.date === today ? `today at ${time}` : session.date === pAddDays(today, 1) ? `tomorrow at ${time}` : classWhen(session);
};

// Send each booked member one reminder before class. Every reservation is
// claimed with a conditional update before anything goes out, so a second
// (or overlapping) run never sends it again. Bookings made after the reminder
// time are skipped: the booking notice already told them.
async function runClassReminders(env, nowMs = Date.now()) {
  const summary = { success: true, reminders_sent: 0, reminders_skipped: 0 };
  const nowIso = new Date(nowMs).toISOString();
  const horizon = new Date(nowMs + Math.max(...REMINDER_CHOICES) * 60000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT r.id AS id, r.data AS rdata, cs.data AS sdata FROM entities r
     JOIN entities cs ON cs.id = json_extract(r.data,'$.session_id') AND cs.entity_type = 'ClassSession'
     WHERE r.entity_type = 'Reservation' AND json_extract(r.data,'$.status') = 'reserved'
       AND json_extract(r.data,'$.reminder_sent_at') IS NULL
       AND json_extract(cs.data,'$.status') = 'scheduled'
       AND json_extract(cs.data,'$.start_at') > ? AND json_extract(cs.data,'$.start_at') <= ?
     LIMIT 500`
  ).bind(nowIso, horizon).all();
  if (!results.length) return summary;
  const rows = results.map((x) => {
    let r = {}; let sess = {};
    try { r = JSON.parse(x.rdata); } catch { /* skip bad row */ }
    try { sess = JSON.parse(x.sdata); } catch { /* skip bad row */ }
    return { id: x.id, r, sess };
  });
  const loginIds = [...new Set(rows.map((x) => x.r.client_user_id).filter(Boolean))];
  const users = new Map();
  for (let i = 0; i < loginIds.length; i += 50) {
    const chunk = loginIds.slice(i, i + 50);
    const { results: us } = await env.DB.prepare(`SELECT id, email, data FROM users WHERE id IN (${inList(chunk)})`).bind(...chunk).all();
    for (const u of us) {
      let data = {}; try { data = JSON.parse(u.data || '{}'); } catch { /* defaults */ }
      users.set(u.id, { id: u.id, email: u.email, data });
    }
  }
  const today = programToday(nowMs);
  const emailOn = env.CLASS_EMAILS === 'on' && emailReady(env);
  const createdByCache = new Map();
  for (const { id, r, sess } of rows) {
    const start = Date.parse(sess.start_at);
    if (!Number.isFinite(start)) continue;
    const u = users.get(r.client_user_id);
    const prefs = reminderPrefs(u?.data);
    const remindAt = start - prefs.minutes * 60000;
    if (nowMs < remindAt) continue; // not yet; a later run picks it up
    // Booked (or moved up) after the reminder time, judged by the class time
    // when they booked. If the gym later moves the class, they still get one.
    const bookedAt = Date.parse(r.promoted_at || r.booked_at || '');
    const startWhenBooked = Date.parse(r.start_at || '') || start;
    let outcome = 'sent';
    if (!u) outcome = 'no_login';
    else if (!prefs.on) outcome = 'off';
    else if (Number.isFinite(bookedAt) && bookedAt > startWhenBooked - prefs.minutes * 60000) outcome = 'booked_late';
    const claim = await env.DB.prepare(
      `UPDATE entities SET data = json_set(data, '$.reminder_sent_at', ?, '$.reminder_outcome', ?), updated_date = ?
       WHERE id = ? AND entity_type = 'Reservation' AND json_extract(data,'$.status') = 'reserved' AND json_extract(data,'$.reminder_sent_at') IS NULL`
    ).bind(nowIso, outcome, nowIso, id).run();
    if (!claim?.meta?.changes) continue; // another run has it
    if (outcome !== 'sent') { summary.reminders_skipped++; continue; }
    try {
      if (!createdByCache.has(sess.coach_user_id || '')) createdByCache.set(sess.coach_user_id || '', await classActorEmail(env, null, sess));
      const name = sess.class_type_name || r.class_name || 'Class';
      const message = `${name} starts ${classTimeLabel(sess, today)}. Can't make it? Cancel in the app so someone else can have your spot.`;
      await notifyClassMember(env, { loginId: u.id, title: 'Class reminder', message, createdBy: createdByCache.get(sess.coach_user_id || ''), tag: `reminder-${id}` });
      if (emailOn && prefs.email && u.email) {
        const p = sendEmail(env, { to: u.email, subject: `Reminder: ${name} ${classTimeLabel(sess, today)}`, html: emailShell('Class reminder', `<p>${escHtml(message)}</p>`) })
          .catch(() => {});
        if (env.__waitUntil) env.__waitUntil(p); else await p;
      }
      summary.reminders_sent++;
    } catch (e) {
      console.error('class reminder failed', e?.message);
    }
  }
  return summary;
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

/* ---- one-class edits and holiday day changes ---- */
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmtHm = (hm) => {
  const mins = hmToMin(hm) ?? 0; const h = Math.floor(mins / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mins % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const fmtDay = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); };

// Holiday changes, one ClassDayChange row per date (id cdc_<date>):
// mode 'closed' (no classes), 'use_day' (runs another weekday's schedule) or
// 'shift' (every class moved by shift_minutes). -> Map date -> row
async function loadDayChanges(env, from, to) {
  const rows = await selectEntities(env, 'ClassDayChange', `json_extract(data,'$.date') BETWEEN ? AND ?`, [from, to]);
  return new Map(rows.filter((r) => ['closed', 'use_day', 'shift'].includes(r.mode)).map((r) => [r.date, r]));
}
const dayOfWeekFor = (date, changes) => {
  const ch = changes?.get(date);
  return ch?.mode === 'use_day' && Number.isInteger(Number(ch.use_day_of_week)) ? Number(ch.use_day_of_week) : pDow(date);
};
const dayChangeLabel = (ch) => (ch.mode === 'closed' ? 'Closed'
  : ch.mode === 'use_day' ? `Runs the ${DOW_NAMES[Number(ch.use_day_of_week)]} schedule`
    : `All classes ${Math.abs(ch.shift_minutes)} min ${ch.shift_minutes > 0 ? 'later' : 'earlier'}`);

// Move one class to a new start time / length on the same date. Bookings stay;
// everyone booked or waitlisted is told when the start time changes.
async function moveSessionTime(env, session, startMin, dur, actor, extra = {}) {
  const startMs = easternToUTC(session.date, minToHm(startMin));
  const patch = {
    ...extra,
    start_time: minToHm(startMin), end_time: minToHm(startMin + dur), duration_min: dur,
    start_at: new Date(startMs).toISOString(), end_at: new Date(startMs + dur * 60000).toISOString(),
  };
  const moved = patch.start_at !== session.start_at;
  const fresh = await patchEntity(env, session, patch);
  let notified = 0;
  if (moved) {
    await env.DB.prepare(
      `UPDATE entities SET data = json_set(data, '$.start_at', ?), updated_date = ? WHERE entity_type='Reservation' AND json_extract(data,'$.session_id') = ?`
    ).bind(patch.start_at, nowISO(), session.id).run();
    const active = await selectEntities(env, 'Reservation',
      `json_extract(data,'$.session_id') = ? AND json_extract(data,'$.status') IN ('reserved','waitlisted','checked_in')`, [session.id]);
    const createdBy = await classActorEmail(env, actor, session);
    const told = new Set();
    for (const r of active) {
      if (!r.client_user_id || told.has(r.client_user_id)) continue;
      told.add(r.client_user_id);
      if (await notifyClassMember(env, {
        loginId: r.client_user_id, createdBy,
        title: 'Class time changed',
        message: `${session.class_type_name || 'Your class'} on ${fmtDay(session.date)} now starts at ${fmtHm(patch.start_time)} (was ${fmtHm(session.start_time)}). You are still booked.`,
      })) notified++;
    }
  }
  await recountSession(env, session.id);
  return { session: { ...fresh, ...(await getEntityById(env, 'ClassSession', session.id)) }, moved, notified };
}

// Staff edit of one class on one date: time, length, coach, capacity. The
// weekly slot is untouched (edited_manually keeps the generator off it).
async function editClassSession(env, user, payload) {
  const session = await getEntityById(env, 'ClassSession', payload?.session_id);
  if (!session) return { success: false, error: 'Class not found.' };
  if (session.status !== 'scheduled') return { success: false, error: 'This class was cancelled.' };
  if (Date.now() > Date.parse(session.end_at)) return { success: false, error: 'This class is over.' };
  const has = (k) => payload && Object.prototype.hasOwnProperty.call(payload, k);
  const patch = { edited_manually: true };
  const warnings = [];
  if (has('coach_user_id')) {
    if (payload.coach_user_id) {
      const coach = await staffLogin(env, payload.coach_user_id);
      if (!coach) return { success: false, error: 'Pick a coach from the list.' };
      patch.coach_user_id = coach.id; patch.coach_name = coach.full_name || coach.email;
    } else { patch.coach_user_id = null; patch.coach_name = ''; }
  }
  let capChanged = false;
  if (has('capacity')) {
    const c = payload.capacity === null || payload.capacity === '' ? null : Number(payload.capacity);
    if (c !== null && (!Number.isInteger(c) || c < 1 || c > 1000)) return { success: false, error: 'Capacity must be a whole number, 1 or more. Leave it blank for no cap.' };
    capChanged = (capOf(session) ?? null) !== c;
    patch.capacity = c;
  }
  let startMin = hmToMin(session.start_time);
  let dur = numOr(session.duration_min, 60);
  if (has('start_time')) {
    startMin = hmToMin(payload.start_time);
    if (startMin === null || startMin >= 1440) return { success: false, error: 'Pick a start time.' };
  }
  if (has('duration_min')) {
    dur = Number(payload.duration_min);
    if (!Number.isInteger(dur) || dur < 5 || dur > 600) return { success: false, error: 'Length must be 5 to 600 minutes.' };
  }
  if (startMin + dur > 1440) return { success: false, error: 'The class has to end by midnight.' };
  const timeChanged = minToHm(startMin) !== session.start_time || dur !== numOr(session.duration_min, 60);
  if (timeChanged && easternToUTC(session.date, minToHm(startMin)) <= Date.now()) {
    return { success: false, error: 'That time has already passed. Pick a later time.' };
  }
  const base = await patchEntity(env, session, patch);
  const r = await moveSessionTime(env, { ...session, ...base }, startMin, dur, user, timeChanged ? { day_shifted: null } : {});
  let fresh = r.session;
  if (capChanged) {
    const booked = numOr(fresh.reserved_count, 0);
    const cap = capOf(fresh);
    if (cap !== null && booked > cap) {
      warnings.push(`${booked} people are booked but the class now holds ${cap}. Nobody was removed.`);
    } else {
      const promoted = await promoteWaitlist(env, fresh, await getGymSettings(env), user);
      if (promoted.length) fresh = await getEntityById(env, 'ClassSession', session.id);
    }
  }
  const what = [timeChanged && 'time', has('coach_user_id') && 'coach', capChanged && 'capacity'].filter(Boolean).join(', ') || 'nothing';
  await audit(env, { actor: user.email, action: 'update', target: 'ClassSession', targetId: session.id, detail: `edited one class: ${what}; ${r.notified} notified`, request: null });
  return { success: true, session: fresh, notified: r.notified, time_changed: r.moved, warnings };
}

// Cancel a class as part of a day change: hidden from the schedule (the day
// banner explains it), bookings released, members told.
async function dayCancelSession(env, session, user, reason, marker) {
  const res = await env.DB.prepare(
    `UPDATE entities SET data = json_set(data, '$.status', 'cancelled', '$.cancel_reason', ?, '$.cancelled_at', ?, '$.cancelled_by', ?, '$.auto_cancelled', json('true'), '$.${marker}', json('true')), updated_date = ?
     WHERE id = ? AND entity_type = 'ClassSession' AND json_extract(data,'$.status') = 'scheduled'`
  ).bind(reason, nowISO(), user.id, nowISO(), session.id).run();
  if (!res?.meta?.changes) return { affected: 0, notified: 0 };
  return cancelSessionReservations(env, { ...session, status: 'cancelled' }, user, reason);
}

// Apply or undo a holiday change for one date. payload: { date, mode:
// 'closed'|'use_day'|'shift'|'normal', reason, use_day_of_week, shift_minutes }.
async function classDayChange(env, user, payload) {
  const date = payload?.date;
  const today = programToday();
  if (!isDateKey(date)) return { success: false, error: 'Pick a date.' };
  if (date < today) return { success: false, error: 'Pick today or a later date.' };
  const mode = payload?.mode;
  if (!['closed', 'use_day', 'shift', 'normal'].includes(mode)) return { success: false, error: 'Pick what happens that day.' };
  const id = `cdc_${date}`;
  const existing = await getEntityById(env, 'ClassDayChange', id);
  const s = await getGymSettings(env);
  const now = Date.now();
  const onDay = async () => (await selectEntities(env, 'ClassSession', `json_extract(data,'$.date') = ?`, [date]))
    .filter((x) => Date.parse(x.start_at) > now);
  const out = { success: true, date, cancelled: 0, moved: 0, added: 0, restored: 0, notified: 0 };
  const tally = (r) => { out.notified += r.notified || 0; };

  if (mode === 'normal') {
    if (!existing) return { success: false, error: 'This day has no change to undo.' };
    await env.DB.prepare('DELETE FROM entities WHERE id = ?').bind(id).run();
    const sessions = await onDay();
    if (existing.mode === 'shift') {
      const back = -numOr(existing.shift_minutes, 0);
      for (const x of sessions.filter((v) => v.status === 'scheduled' && v.day_shifted)) {
        const st = hmToMin(x.start_time) + back;
        if (st < 0 || st >= 1440) continue;
        const r = await moveSessionTime(env, x, st, numOr(x.duration_min, 60), user, { day_shifted: null });
        out.moved++; tally(r);
      }
    } else {
      if (existing.mode === 'use_day') {
        for (const x of sessions.filter((v) => v.status === 'scheduled' && v.day_change_added)) {
          tally(await dayCancelSession(env, x, user, 'Back to the normal schedule', 'day_change_removed'));
          out.cancelled++;
        }
      }
      // Classes this change took off come back (empty; members were told they were cancelled).
      for (const x of sessions.filter((v) => v.status === 'cancelled' && v.day_change)) {
        await patchEntity(env, x, { status: 'scheduled', auto_cancelled: false, cancel_reason: null, cancelled_at: null, day_change: null });
        await recountSession(env, x.id);
        out.restored++;
      }
    }
    addSync(out, await syncSlotsWhere(env, s, '1=1', []));
    await audit(env, { actor: user.email, action: 'update', target: 'ClassDayChange', targetId: id, detail: `undid ${existing.mode} on ${date}`, request: null });
    return out;
  }

  if (existing) return { success: false, error: 'This day already has a change. Undo it first.' };
  const reason = String(payload?.reason || '').trim().slice(0, 120);
  const row = { date, mode, reason, created_by_name: user.full_name || user.email };
  if (mode === 'use_day') {
    const dow = Number(payload?.use_day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return { success: false, error: 'Pick which day\'s schedule to run.' };
    if (dow === pDow(date)) return { success: false, error: `That date is already a ${DOW_NAMES[dow]}.` };
    row.use_day_of_week = dow;
  }
  if (mode === 'shift') {
    const shift = Number(payload?.shift_minutes);
    if (!Number.isInteger(shift) || shift === 0 || Math.abs(shift) > 720) return { success: false, error: 'Pick how many minutes to move the classes.' };
    row.shift_minutes = shift;
  }
  const sessions = (await onDay()).filter((x) => x.status === 'scheduled');
  if (mode === 'shift') {
    const bad = sessions.find((x) => { const st = hmToMin(x.start_time) + row.shift_minutes; return st < 0 || st + numOr(x.duration_min, 60) > 1440; });
    if (bad) return { success: false, error: `${bad.class_type_name || 'A class'} at ${fmtHm(bad.start_time)} would move past midnight. Pick a smaller shift.` };
    const early = sessions.find((x) => easternToUTC(date, minToHm(hmToMin(x.start_time) + row.shift_minutes)) <= now);
    if (early) return { success: false, error: `${early.class_type_name || 'A class'} at ${fmtHm(early.start_time)} would move to a time that has passed.` };
  }
  await env.DB.prepare(
    'INSERT OR IGNORE INTO entities (id, entity_type, data, created_by, created_date, updated_date) VALUES (?,?,?,?,?,?)'
  ).bind(id, 'ClassDayChange', JSON.stringify(row), user.email, nowISO(), nowISO()).run();
  const label = fmtDay(date);
  if (mode === 'closed') {
    const why = reason ? `Gym closed ${label}: ${reason}` : `Gym closed ${label}`;
    for (const x of sessions) { tally(await dayCancelSession(env, x, user, why, 'day_change')); out.cancelled++; }
  } else if (mode === 'use_day') {
    const why = `${label} runs the ${DOW_NAMES[row.use_day_of_week]} schedule${reason ? ` (${reason})` : ''}`;
    for (const x of sessions.filter((v) => v.slot_id)) { tally(await dayCancelSession(env, x, user, why, 'day_change')); out.cancelled++; }
  } else {
    for (const x of sessions) {
      const r = await moveSessionTime(env, x, hmToMin(x.start_time) + row.shift_minutes, numOr(x.duration_min, 60), user, { day_shifted: true });
      out.moved++; tally(r);
    }
  }
  addSync(out, await syncSlotsWhere(env, s, '1=1', []));
  if (mode === 'use_day') {
    // Weekly classes that now run that day (new, or revived from an earlier change).
    const added = (await onDay()).filter((x) => x.status === 'scheduled' && x.slot_id && !x.day_change_added);
    for (const x of added) await patchEntity(env, x, { day_change_added: true });
    out.added = (await onDay()).filter((x) => x.status === 'scheduled' && x.day_change_added).length;
  }
  await audit(env, { actor: user.email, action: 'create', target: 'ClassDayChange', targetId: id, detail: `${mode} on ${date}; ${out.cancelled} cancelled, ${out.moved} moved, ${out.notified} notified`, request: null });
  return { ...out, change: { ...row, id, label: dayChangeLabel(row) } };
}

/* ---- session generation from weekly slots ---- */
function slotSessionFields(slot, type, date, shiftMin = 0) {
  const startMin = hmToMin(slot.start_time) + (Number(shiftMin) || 0);
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
async function syncSlotSessions(env, slot, type, s, now = Date.now(), dayChanges = null) {
  const out = { generated: 0, revived: 0, updated: 0, cancelled: 0, booked_kept: 0, booked_sessions: [] };
  const today = programToday(now);
  // Classes must exist at least as far ahead as members may book them.
  const openHours = numOr(slot.booking_open_hours, numOr(type?.booking_open_hours, s.booking_open_hours));
  const horizonDays = Math.min(62, Math.max(1, numOr(s.generate_days_ahead, 21), Math.ceil(openHours / 24) + 1));
  const horizonEnd = pAddDays(today, horizonDays - 1);
  const changes = dayChanges || await loadDayChanges(env, today, pAddDays(today, 62));
  const active = slot.is_active !== false && !!type && type.is_active !== false && hmToMin(slot.start_time) !== null
    && Number.isInteger(Number(slot.day_of_week));
  // Holiday changes: closed days get nothing, "runs Saturday's schedule" swaps the weekday.
  const wants = (date) => active && changes.get(date)?.mode !== 'closed' && dayOfWeekFor(date, changes) === Number(slot.day_of_week)
    && (!isDateKey(slot.start_date) || date >= slot.start_date) && (!isDateKey(slot.end_date) || date <= slot.end_date)
    && date >= today && date <= horizonEnd && fitsDay(date);
  const shiftOf = (date) => (changes.get(date)?.mode === 'shift' ? numOr(changes.get(date).shift_minutes, 0) : 0);
  function fitsDay(date) { const st = hmToMin(slot.start_time) + shiftOf(date); return st >= 0 && st < 1440; }

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
      const want = slotSessionFields(slot, type, ex.date, shiftOf(ex.date));
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
      const f = slotSessionFields(slot, type, d, shiftOf(d));
      if (Date.parse(f.start_at) <= now) continue;
      const data = { ...f, status: 'scheduled', cancel_reason: null, notes: '', reserved_count: 0, waitlist_count: 0, checked_in_count: 0 };
      if (shiftOf(d)) data.day_shifted = true;
      if (changes.get(d)?.mode === 'use_day') data.day_change_added = true;
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
  const today = programToday();
  const changes = await loadDayChanges(env, today, pAddDays(today, 62));
  for (const slot of slots) {
    if (!typeCache.has(slot.class_type_id)) typeCache.set(slot.class_type_id, await getEntityById(env, 'ClassType', slot.class_type_id));
    addSync(total, await syncSlotSessions(env, slot, typeCache.get(slot.class_type_id), s, Date.now(), changes));
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

/* ---- staff reports (read-only) ---- */
// Attendance, class fill, no-shows and members by plan for a date range of
// Eastern day keys. `to` stops at today; the range is at most a year.
// "Booked" = held a spot by booking (checked in, no-show or still reserved);
// walk-ins count as check-ins and as used spots for fill, not as bookings.
const REPORT_MAX_DAYS = 366;
const REPORT_INACTIVE_DAYS = 14;
const REPORT_RES = `SELECT json_extract(data,'$.client_id') AS cid, json_extract(data,'$.client_name') AS cname,
    json_extract(data,'$.class_type_id') AS tid, json_extract(data,'$.class_name') AS tname,
    json_extract(data,'$.session_id') AS sid, json_extract(data,'$.date') AS date, json_extract(data,'$.status') AS st,
    COALESCE(json_extract(data,'$.created_at_checkin'),0) AS walkin
  FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.date') BETWEEN ?1 AND ?2`;
const REPORT_SESSIONS = `SELECT id, json_extract(data,'$.class_type_id') AS tid, json_extract(data,'$.class_type_name') AS tname,
    json_extract(data,'$.date') AS date, json_extract(data,'$.start_time') AS time,
    CAST(json_extract(data,'$.capacity') AS INTEGER) AS cap, COALESCE(json_extract(data,'$.reservable'),1) AS reservable
  FROM entities WHERE entity_type='ClassSession' AND json_extract(data,'$.date') BETWEEN ?1 AND ?2
    AND COALESCE(json_extract(data,'$.status'),'scheduled') != 'cancelled' AND COALESCE(json_extract(data,'$.auto_cancelled'),0) = 0`;
const REPORT_TALLY = `SUM(st='checked_in') AS check_ins, SUM(st IN ('checked_in','no_show','reserved') AND walkin = 0) AS booked,
    SUM(st='no_show') AS no_shows, SUM(st='late_cancelled') AS late_cancels`;
// Memberships current on ?1 (not ended, started, not past their end date).
const REPORT_CURRENT_MEMBERSHIPS = `SELECT json_extract(data,'$.client_id') AS cid, json_extract(data,'$.plan_id') AS pid,
    json_extract(data,'$.plan_name') AS pname, json_extract(data,'$.start_date') AS sd
  FROM entities WHERE entity_type='Membership' AND COALESCE(json_extract(data,'$.status'),'active') NOT IN ('ended','cancelled')
    AND (COALESCE(json_extract(data,'$.end_date'),'') = '' OR json_extract(data,'$.end_date') >= ?1)
    AND COALESCE(json_extract(data,'$.start_date'),'') <= ?1`;

async function classReports(env, payload) {
  const today = programToday();
  let to = isDateKey(payload.to) ? payload.to : today;
  if (to > today) to = today;
  let from = isDateKey(payload.from) ? payload.from : pAddDays(to, -29);
  if (from > to) return { success: false, error: 'The start date is after the end date.' };
  if (pDaysBetween(from, to) >= REPORT_MAX_DAYS) from = pAddDays(to, -(REPORT_MAX_DAYS - 1));
  const cutoff = pAddDays(today, -REPORT_INACTIVE_DAYS);
  const all = async (sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).all()).results || [];
  const n = (v) => Number(v) || 0;

  const [memberRows, classRows, sessionRows, fillRows, dailyRows, planCounts, plans, inactiveRows] = await Promise.all([
    all(`SELECT cid, MAX(cname) AS name, ${REPORT_TALLY}, MAX(CASE WHEN st='checked_in' THEN date END) AS last_visit
         FROM (${REPORT_RES}) GROUP BY cid`, from, to),
    all(`SELECT tid, MAX(tname) AS name, ${REPORT_TALLY} FROM (${REPORT_RES}) GROUP BY tid`, from, to),
    all(`SELECT tid, MAX(tname) AS name, COUNT(*) AS sessions FROM (${REPORT_SESSIONS}) GROUP BY tid`, from, to),
    all(`WITH s AS (${REPORT_SESSIONS}),
              r AS (SELECT sid, SUM(st IN ('checked_in','no_show','reserved')) AS held, SUM(st='checked_in') AS check_ins FROM (${REPORT_RES}) GROUP BY sid)
         SELECT CAST(strftime('%w', s.date) AS INTEGER) AS dow, s.time AS time, MAX(s.tname) AS name, COUNT(*) AS sessions,
                SUM(COALESCE(r.held,0)) AS booked, SUM(COALESCE(r.check_ins,0)) AS check_ins,
                SUM(CASE WHEN s.cap > 0 THEN s.cap ELSE 0 END) AS capacity,
                SUM(CASE WHEN s.cap > 0 THEN COALESCE(r.held,0) ELSE 0 END) AS booked_capped,
                SUM(CASE WHEN s.cap > 0 AND COALESCE(r.held,0) >= s.cap THEN 1 ELSE 0 END) AS full_sessions
         FROM s LEFT JOIN r ON r.sid = s.id WHERE s.reservable != 0
         GROUP BY dow, s.time, s.tid ORDER BY dow, s.time`, from, to),
    all(`SELECT date, SUM(st='checked_in') AS check_ins, SUM(st='no_show') AS no_shows FROM (${REPORT_RES}) GROUP BY date`, from, to),
    all(`SELECT pid, MAX(pname) AS name, COUNT(DISTINCT cid) AS members FROM (${REPORT_CURRENT_MEMBERSHIPS}) GROUP BY pid`, today),
    all(`SELECT id, json_extract(data,'$.name') AS name, json_extract(data,'$.kind') AS kind, COALESCE(json_extract(data,'$.is_active'),1) AS active
         FROM entities WHERE entity_type='MembershipPlan'`),
    all(`WITH m AS (${REPORT_CURRENT_MEMBERSHIPS}),
              lv AS (SELECT json_extract(data,'$.client_id') AS cid, MAX(json_extract(data,'$.date')) AS last_visit
                     FROM entities WHERE entity_type='Reservation' AND json_extract(data,'$.status') = 'checked_in' AND json_extract(data,'$.date') <= ?1
                     GROUP BY cid)
         SELECT c.id AS client_id, json_extract(c.data,'$.full_name') AS name, json_extract(c.data,'$.email') AS email, lv.last_visit AS last_visit,
                (SELECT GROUP_CONCAT(DISTINCT m.pname) FROM m WHERE m.cid = c.id) AS plans,
                (SELECT MIN(m.sd) FROM m WHERE m.cid = c.id) AS member_since
         FROM entities c LEFT JOIN lv ON lv.cid = c.id
         WHERE c.entity_type = 'Client' AND c.id IN (SELECT cid FROM m) AND (lv.last_visit IS NULL OR lv.last_visit <= ?2)
         ORDER BY lv.last_visit IS NOT NULL, lv.last_visit, name`, today, cutoff),
  ]);

  const tallied = (r) => ({ check_ins: n(r.check_ins), booked: n(r.booked), no_shows: n(r.no_shows), late_cancels: n(r.late_cancels) });
  const members = memberRows.map((r) => ({ client_id: r.cid, name: r.name || 'Member', ...tallied(r), last_visit: r.last_visit || null }))
    .sort((a, b) => b.check_ins - a.check_ins || b.no_shows - a.no_shows || a.name.localeCompare(b.name));
  const sessionsByType = new Map(sessionRows.map((r) => [r.tid, r]));
  const classes = classRows.map((r) => ({ class_type_id: r.tid, name: r.name || sessionsByType.get(r.tid)?.name || 'Class', sessions: n(sessionsByType.get(r.tid)?.sessions), ...tallied(r) }));
  for (const r of sessionRows) if (!classes.some((c) => c.class_type_id === r.tid)) classes.push({ class_type_id: r.tid, name: r.name || 'Class', sessions: n(r.sessions), check_ins: 0, booked: 0, no_shows: 0, late_cancels: 0 });
  classes.sort((a, b) => b.check_ins - a.check_ins || a.name.localeCompare(b.name));

  const fill = fillRows.map((r) => ({
    dow: n(r.dow), time: r.time || '', name: r.name || 'Class', sessions: n(r.sessions),
    avg_booked: Math.round((n(r.booked) / Math.max(1, n(r.sessions))) * 10) / 10,
    avg_capacity: n(r.capacity) ? Math.round((n(r.capacity) / n(r.sessions)) * 10) / 10 : null,
    fill_pct: n(r.capacity) ? Math.round((n(r.booked_capped) / n(r.capacity)) * 100) : null,
    full_sessions: n(r.full_sessions),
  }));

  const byDay = new Map(dailyRows.map((r) => [r.date, r]));
  const daily = [];
  for (let d = from; d <= to; d = pAddDays(d, 1)) daily.push({ date: d, check_ins: n(byDay.get(d)?.check_ins), no_shows: n(byDay.get(d)?.no_shows) });

  const countByPlan = new Map(planCounts.map((r) => [r.pid, r]));
  const planList = plans.map((p) => ({ plan_id: p.id, name: p.name || 'Plan', kind: p.kind || null, members: n(countByPlan.get(p.id)?.members), active: p.active !== 0 && p.active !== 'false' }))
    .filter((p) => p.active || p.members > 0);
  for (const r of planCounts) if (!plans.some((p) => p.id === r.pid)) planList.push({ plan_id: r.pid || null, name: r.name || 'No plan', kind: null, members: n(r.members), active: false });
  planList.sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));

  const inactive = inactiveRows.map((r) => ({
    client_id: r.client_id, name: r.name || 'Member', email: r.email || '', plans: r.plans || '',
    last_visit: r.last_visit || null, days_since: r.last_visit ? pDaysBetween(r.last_visit, today) : null, member_since: r.member_since || null,
  }));

  const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
  const capped = fillRows.reduce((t, r) => ({ cap: t.cap + n(r.capacity), held: t.held + n(r.booked_capped) }), { cap: 0, held: 0 });
  const totals = {
    check_ins: sum(members, 'check_ins'), booked: sum(members, 'booked'), no_shows: sum(members, 'no_shows'), late_cancels: sum(members, 'late_cancels'),
    members_attended: members.filter((m) => m.check_ins > 0).length, sessions: sum(sessionRows.map((r) => ({ s: n(r.sessions) })), 's'),
    avg_fill_pct: capped.cap ? Math.round((capped.held / capped.cap) * 100) : null,
    active_members: new Set((await all(`SELECT DISTINCT cid FROM (${REPORT_CURRENT_MEMBERSHIPS})`, today)).map((r) => r.cid)).size,
    inactive: inactive.length,
  };
  return { success: true, from, to, today, inactive_days: REPORT_INACTIVE_DAYS, totals, daily, members, classes, fill, inactive, plans: planList };
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
  gymBillingMembershipDefaults(fields, plan); // Phase 4 CORE
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
    const holdNow = holdOn(x, today);
    const nextHold = liveHolds(x).filter((h) => h.from > today).sort((a, b) => a.from.localeCompare(b.from))[0] || null;
    withAllowance.push({
      ...x, allowance, remaining: allowance.remaining,
      hold_now: holdNow ? { from: holdNow.from, to: holdNow.to || null } : null,
      next_hold: nextHold ? { from: nextHold.from, to: nextHold.to } : null,
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
    // Ended memberships, newest first: members keep seeing their history.
    past_memberships: memberships.filter((x) => !current.includes(x))
      .map((x) => ({ id: x.id, plan_name: x.plan_name || '', start_date: x.start_date || null, end_date: x.end_date || null, status: x.status }))
      .sort((a, b) => String(b.end_date || '').localeCompare(String(a.end_date || ''))),
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

// ===== Phase 3: lifts =====
// PRs, lift history and one-rep maxes. Two sources feed a member's lifts:
// load scores in a class strength section (WorkoutScore, written by logScore;
// the lift is the section's first movement) and lifts logged outside class
// (LiftEntry). Members write LiftEntry only through saveLiftEntry and
// deleteLiftEntry so the server always sets is_pr. Staff with classes.run may
// add or fix a member's lift. Guardians act for a linked child.
STAFF_WRITE_TYPES.add('LiftEntry');
TYPE_PERMISSION.LiftEntry = 'classes.run';
const LIFT_KG_PER_LB = 0.45359237;
const LIFT_RM_REPS = [1, 2, 3, 5, 10];
const liftToLb = (load, unit) => (unit === 'kg' ? Number(load) / LIFT_KG_PER_LB : Number(load));
const liftFromLb = (lb, unit) => (unit === 'kg' ? lb * LIFT_KG_PER_LB : lb);
const liftRound = (n) => Math.round(Number(n) * 10) / 10;
// Epley: load x (1 + reps/30); a single is the 1RM itself.
const liftEpley = (load, reps) => (reps <= 1 ? load : load * (1 + reps / 30));

// Rep count of a class load score: value.reps if given, else read from the
// section text ("3RM", "5x3" = sets of 3), else a single.
function liftRepsOf(value, section) {
  const r = Number(value?.reps);
  if (Number.isInteger(r) && r > 0) return r;
  const text = `${section?.title || ''} ${section?.description || ''}`;
  const rm = /\b(\d{1,2})\s*-?\s*RM\b/i.exec(text);
  if (rm && Number(rm[1]) > 0) return Number(rm[1]);
  const sets = /\b\d{1,2}\s*[x×]\s*(\d{1,2})\b/i.exec(text);
  if (sets && Number(sets[1]) > 0) return Number(sets[1]);
  return 1;
}

// Every WorkoutScore of these clients with the workout section it belongs to.
async function liftScoreRows(env, clientIds) {
  if (!clientIds.length) return [];
  const scores = await selectEntities(env, 'WorkoutScore', `json_extract(data,'$.client_id') IN (${inList(clientIds)})`, clientIds);
  const ids = [...new Set(scores.map((s) => s.workout_id).filter(Boolean))];
  const workouts = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    for (const w of await selectEntities(env, 'Workout', `id IN (${inList(chunk)})`, chunk)) workouts.set(w.id, w);
  }
  return scores.map((score) => {
    const workout = workouts.get(score.workout_id);
    const section = (workout?.sections || []).find((s) => s.id === score.section_id) || null;
    return { score, workout, section };
  }).filter((r) => r.section);
}

// Lift rows (class strength scores + LiftEntry), newest first.
async function liftRows(env, clientIds, movementId = null) {
  if (!clientIds.length) return [];
  const where = `json_extract(data,'$.client_id') IN (${inList(clientIds)})${movementId ? " AND json_extract(data,'$.movement_id') = ?" : ''}`;
  const entries = await selectEntities(env, 'LiftEntry', where, movementId ? [...clientIds, movementId] : clientIds);
  const rows = entries.filter((e) => Number(e.load) > 0).map((e) => {
    const unit = e.unit === 'kg' ? 'kg' : 'lb';
    const reps = Math.max(1, Math.round(Number(e.reps) || 1));
    return {
      id: e.id, source: 'lift', client_id: e.client_id, movement_id: e.movement_id, date: e.date, created_date: e.created_date,
      load: Number(e.load), unit, reps, load_lb: liftToLb(e.load, unit), note: e.note || '', is_pr: !!e.is_pr,
    };
  });
  for (const { score, workout, section } of await liftScoreRows(env, clientIds)) {
    const lift = section.kind === 'strength' ? (section.movement_ids || [])[0] : null;
    const load = Number(score.value?.load);
    if (!lift || !(load > 0) || (movementId && lift !== movementId)) continue;
    const unit = (score.value?.unit || section.scoring?.unit) === 'kg' ? 'kg' : 'lb';
    const reps = liftRepsOf(score.value, section);
    rows.push({
      id: score.id, source: 'class', client_id: score.client_id, movement_id: lift, date: score.date || workout.date, created_date: score.created_date,
      load, unit, reps, load_lb: liftToLb(load, unit), note: score.comment || '', is_pr: !!score.is_pr,
      workout_id: workout.id, section_id: section.id, workout_title: section.title || workout.title || 'Class',
    });
  }
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.created_date).localeCompare(String(a.created_date)));
}

// Benchmark results (class scores on a section linked to a benchmark).
async function liftBenchmarkRows(env, clientIds) {
  return (await liftScoreRows(env, clientIds))
    .filter(({ score, section }) => section.benchmark_id && Number.isFinite(Number(score.sort_value)))
    .map(({ score, workout, section }) => ({
      id: score.id, benchmark_id: section.benchmark_id, date: score.date || workout.date, sort_value: Number(score.sort_value),
      value: score.value || {}, division: score.division || null, scoring: section.scoring || null, is_pr: !!score.is_pr,
      lower_is_better: section.scoring?.lower_is_better ?? section.scoring?.type === 'time', title: section.title || workout.title || '',
    }));
}

// Is this result a PR? Lifts: the load beats the member's best at the same
// rep count (kg and lb compared), from class strength scores and logged lifts.
// Benchmarks: sort_value beats their best on that benchmark. The record being
// saved (exclude_id) is ignored. A first-ever result is not a PR (nothing to
// beat yet); it becomes the baseline. -> { is_pr, previous } (previous in the
// new result's unit for lifts, as a sort_value for benchmarks).
async function checkPr(env, { client_id, movement_id, load, reps, scoring, sort_value, benchmark_id, workout_id, section_id, exclude_id, unit } = {}) {
  const none = { is_pr: false, previous: null };
  if (!client_id) return none;
  let section = null;
  if (workout_id && section_id) {
    const w = await getEntityById(env, 'Workout', workout_id);
    section = (w?.sections || []).find((s) => s.id === section_id) || null;
  }
  const sc = scoring || section?.scoring || null;
  const lift = movement_id || (section?.kind === 'strength' ? (section.movement_ids || [])[0] : null);
  const isLift = Number(load) > 0 && lift && (!section || section.kind === 'strength');
  if (isLift) {
    const u = (unit || sc?.unit) === 'kg' ? 'kg' : 'lb';
    const r = Number(reps) > 0 ? Math.round(Number(reps)) : liftRepsOf(null, section);
    const prev = (await liftRows(env, [client_id], lift)).filter((x) => x.id !== exclude_id && x.reps === r);
    if (!prev.length) return none;
    const best = Math.max(...prev.map((x) => x.load_lb));
    return { is_pr: liftToLb(load, u) > best + 0.01, previous: liftRound(liftFromLb(best, u)) };
  }
  const bench = benchmark_id || section?.benchmark_id || null;
  const sv = Number(sort_value);
  if (!bench || sort_value == null || !Number.isFinite(sv)) return none;
  let lower = sc?.lower_is_better;
  if (lower == null) {
    const b = await getEntityById(env, 'Benchmark', bench);
    const bs = b?.scoring || sc;
    lower = bs?.lower_is_better ?? bs?.type === 'time';
  }
  const prev = (await liftBenchmarkRows(env, [client_id])).filter((x) => x.benchmark_id === bench && x.id !== exclude_id);
  if (!prev.length) return none;
  const best = lower ? Math.min(...prev.map((x) => x.sort_value)) : Math.max(...prev.map((x) => x.sort_value));
  return { is_pr: lower ? sv < best : sv > best, previous: best };
}

// Whose lifts: staff name client_id (writes need classes.run); members get
// their own, or a linked child's (guardian rules in resolveClassClient).
async function resolveLiftClient(env, user, clientId, { write = false } = {}) {
  if (!user) return { error: 'Not logged in' };
  if (isStaff(user)) {
    if (write && !can(user, 'classes.run')) return { error: NO_PERMISSION.error, code: 'forbidden' };
    if (!clientId) return { error: 'Pick a member first.' };
    const client = await getEntityById(env, 'Client', clientId);
    if (!client) return { error: 'Member not found.' };
    return { client, clientIds: [client.id] };
  }
  const who = await resolveClassClient(env, user, clientId || null);
  if (who.error) {
    return clientId
      ? { error: 'You can only see lifts for yourself or your children.', code: 'forbidden' }
      : { error: who.error, code: 'no_client' };
  }
  return who;
}

async function liftNames(env, type, ids) {
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    for (const e of await selectEntities(env, type, `id IN (${inList(chunk)})`, chunk)) out.set(e.id, e);
  }
  return out;
}

// One movement's lifts: the best at each rep count and the 1RM figures, in the unit most recently used.
function liftSummary(rows) {
  const unit = rows[0]?.unit || 'lb';
  const show = (lb) => liftRound(liftFromLb(lb, unit));
  const byReps = new Map();
  for (const r of rows) {
    const cur = byReps.get(r.reps);
    if (!cur || r.load_lb > cur.load_lb + 0.01 || (Math.abs(r.load_lb - cur.load_lb) <= 0.01 && r.date < cur.date)) byReps.set(r.reps, r);
  }
  const bests = [...byReps.values()].sort((a, b) => a.reps - b.reps)
    .map((r) => ({ reps: r.reps, load: show(r.load_lb), unit, date: r.date, id: r.id, standard: LIFT_RM_REPS.includes(r.reps) }));
  const single = byReps.get(1);
  let est = null;
  for (const r of rows) {
    const e = liftEpley(r.load_lb, r.reps);
    if (!est || e > est.lb + 0.01) est = { lb: e, date: r.date, reps: r.reps };
  }
  return {
    unit, bests,
    one_rm: single ? { load: show(single.load_lb), date: single.date } : null,
    est_1rm: est ? { load: show(est.lb), date: est.date, from_reps: est.reps } : null,
  };
}

const LIFT_DATE = /^\d{4}-\d{2}-\d{2}$/;
const liftPublic = (e) => ({ id: e.id, client_id: e.client_id, movement_id: e.movement_id, date: e.date, load: e.load, unit: e.unit, reps: e.reps, note: e.note || '', is_pr: !!e.is_pr, created_date: e.created_date });

async function runLiftsFunction(name, payload, ctx) {
  const { env, user } = ctx;
  if (!user) return { success: false, error: 'Not logged in' };
  const p = payload || {};
  switch (name) {
    // Lift movements from the gym library, for the "Log a lift" picker.
    case 'liftMovements': {
      const all = await selectEntities(env, 'Movement');
      const lifts = all.filter((m) => m.is_lift === true || (m.is_lift == null && m.category === 'weightlifting'))
        .map((m) => ({ id: m.id, name: m.name || 'Lift', category: m.category || null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { success: true, movements: lifts };
    }

    // "Would this be a PR?" for the signed-in member (or a child / a member staff pick).
    case 'checkPr': {
      const who = await resolveLiftClient(env, user, p.client_id);
      if (who.error) return { success: false, error: who.error, code: who.code };
      const { client_id: _c, ...args } = p;
      return { success: true, ...(await checkPr(env, { ...args, client_id: who.client.id })) };
    }

    case 'liftHistory': {
      if (!p.movement_id) return { success: false, error: 'Pick a lift.' };
      const who = await resolveLiftClient(env, user, p.client_id);
      if (who.error) return { success: false, error: who.error, code: who.code };
      const movement = await getEntityById(env, 'Movement', p.movement_id);
      const rows = await liftRows(env, who.clientIds, p.movement_id);
      return {
        success: true,
        movement: { id: p.movement_id, name: movement?.name || 'Lift' },
        entries: rows.map(({ load_lb: _l, created_date: _c, ...r }) => r),
        ...liftSummary(rows),
      };
    }

    case 'prList': {
      const who = await resolveLiftClient(env, user, p.client_id);
      if (who.error) return { success: false, error: who.error, code: who.code };
      const rows = await liftRows(env, who.clientIds);
      const byMove = new Map();
      for (const r of rows) {
        if (!byMove.has(r.movement_id)) byMove.set(r.movement_id, []);
        byMove.get(r.movement_id).push(r);
      }
      const moves = await liftNames(env, 'Movement', [...byMove.keys()]);
      const lifts = [...byMove.entries()].map(([id, list]) => ({
        movement_id: id, name: moves.get(id)?.name || 'Lift', count: list.length, last_date: list[0].date, ...liftSummary(list),
      })).sort((a, b) => a.name.localeCompare(b.name));
      const bench = await liftBenchmarkRows(env, who.clientIds);
      const byBench = new Map();
      for (const r of bench) {
        const cur = byBench.get(r.benchmark_id);
        const better = cur && (r.lower_is_better ? r.sort_value < cur.best.sort_value : r.sort_value > cur.best.sort_value);
        if (!cur) byBench.set(r.benchmark_id, { best: r, count: 1 });
        else { cur.count += 1; if (better) cur.best = r; }
      }
      const names = await liftNames(env, 'Benchmark', [...byBench.keys()]);
      const benchmarks = [...byBench.entries()].map(([id, { best, count }]) => ({
        benchmark_id: id, name: names.get(id)?.name || best.title || 'Benchmark', count,
        best: { value: best.value, sort_value: best.sort_value, date: best.date, division: best.division },
        scoring: names.get(id)?.scoring || best.scoring, lower_is_better: best.lower_is_better,
      })).sort((a, b) => a.name.localeCompare(b.name));
      return { success: true, lifts, benchmarks };
    }

    case 'saveLiftEntry': {
      const existing = p.id ? await getEntityById(env, 'LiftEntry', p.id) : null;
      if (p.id && !existing) return { success: false, error: 'That lift was not found.' };
      const who = await resolveLiftClient(env, user, existing ? existing.client_id : p.client_id, { write: true });
      if (who.error) return { success: false, error: who.error, code: who.code };
      const movementId = p.movement_id || existing?.movement_id;
      const movement = await getEntityById(env, 'Movement', movementId);
      if (!movement) return { success: false, error: 'Pick a lift from the list.' };
      const load = Number(p.load ?? existing?.load);
      if (!(load > 0) || load > 2000) return { success: false, error: 'Enter the weight you lifted.' };
      const unit = (p.unit ?? existing?.unit) === 'kg' ? 'kg' : 'lb';
      const reps = Number(p.reps ?? existing?.reps ?? 1);
      if (!Number.isInteger(reps) || reps < 1 || reps > 50) return { success: false, error: 'Reps must be a whole number from 1 to 50.' };
      const date = p.date ?? existing?.date ?? programToday();
      if (!LIFT_DATE.test(String(date)) || date > programToday()) return { success: false, error: 'Pick a date that is today or earlier.' };
      const note = String(p.note ?? existing?.note ?? '').slice(0, 500);
      const clientId = existing ? existing.client_id : who.client.id;
      const pr = await checkPr(env, { client_id: clientId, movement_id: movement.id, load, reps, unit, exclude_id: existing?.id });
      const fields = { movement_id: movement.id, date, load, unit, reps, note, is_pr: pr.is_pr };
      let entry;
      if (existing) entry = await patchEntity(env, existing, fields);
      else {
        const login = await clientLogin(env, who.client);
        entry = await insertEntity(env, 'LiftEntry', { client_id: clientId, user_email: login?.email || who.client.email || null, ...fields }, user.email);
      }
      await audit(env, { actor: user.email, action: existing ? 'update' : 'create', target: 'LiftEntry', targetId: entry.id, detail: `${movement.name || 'lift'} ${load}${unit} x${reps}${pr.is_pr ? ' PR' : ''}`, request: null });
      return { success: true, entry: liftPublic(entry), pr: pr.is_pr, previous: pr.previous };
    }

    case 'deleteLiftEntry': {
      const existing = await getEntityById(env, 'LiftEntry', p.id);
      if (!existing) return { success: false, error: 'That lift was not found.' };
      const who = await resolveLiftClient(env, user, existing.client_id, { write: true });
      if (who.error) return { success: false, error: who.error, code: who.code };
      await env.DB.prepare("DELETE FROM entities WHERE id = ? AND entity_type = 'LiftEntry'").bind(existing.id).run();
      await audit(env, { actor: user.email, action: 'delete', target: 'LiftEntry', targetId: existing.id, detail: `${existing.load}${existing.unit} x${existing.reps}`, request: null });
      return { success: true };
    }
    default:
      return { success: false, error: 'Unknown lifts function.' };
  }
}
// ===== end Phase 3: lifts =====

// ===== Phase 4: SALES =====
// Public join page (publicPlans, publicCheckout), promo codes, the billing
// dashboard and the QuickBooks CSV export. Money is read with billing.view;
// promo codes are changed with settings.manage. All Stripe calls go through
// stripe(env, ...), so tests point them at a fake Stripe.
TYPE_PERMISSION.PromoCode = 'settings.manage';
const SALES_TRY_KINDS = new Set(['trial', 'intro', 'drop_in', 'punch_card']); // planBillingKind() values
const SALES_DEFAULT_TAX_PCT = 2.98;
const SALES_DEFAULT_BANK_PCT = 2.89;
const SALES_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const salesConnected = (env) => !!env.STRIPE_SECRET_KEY;
const salesNum = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const salesIsActive = (p) => p.is_active !== false && p.is_active !== 0 && p.is_active !== 'false';
const salesIsPublic = (p) => p.public === true || p.public === 1 || p.public === 'true';
const salesGroup = (p) => (SALES_TRY_KINDS.has(planBillingKind(p)) || salesNum(p.price_cents, 0) === 0 ? 'try' : 'membership');

async function salesGymSettings(env) {
  return parseRow(await env.DB.prepare(
    `SELECT * FROM entities WHERE entity_type='GymSettings' ORDER BY created_date ASC LIMIT 1`
  ).first()) || {};
}

// Per-IP counter in app_state, one bucket per 10 minutes.
async function salesRateLimited(env, request, bucket, max) {
  const ip = request?.headers?.get('cf-connecting-ip') || request?.headers?.get('x-forwarded-for') || 'local';
  const windowId = Math.floor(Date.now() / 600000);
  const row = await env.DB.prepare(
    `INSERT INTO app_state (key, value, updated_date) VALUES (?1,'1',?2)
     ON CONFLICT(key) DO UPDATE SET value = CAST(app_state.value AS INTEGER) + 1, updated_date = ?2 RETURNING value`
  ).bind(`rl_sales_${bucket}_${ip}_${windowId}`, nowISO()).first();
  if (Math.random() < 0.05) {
    await env.DB.prepare(`DELETE FROM app_state WHERE key LIKE 'rl_sales_%' AND updated_date < ?`)
      .bind(new Date(Date.now() - 3600000).toISOString()).run();
  }
  return Number(row?.value || 0) > max;
}
const SALES_RATE_LIMITED = { success: false, error: 'Too many tries. Please wait a few minutes and try again.', code: 'rate_limited' };

function salesPublicPlan(p, gym) {
  const price = Math.max(0, Math.round(salesNum(p.price_cents, 0)));
  const bankPct = salesNum(p.bank_discount_pct, salesNum(gym.bank_discount_pct, SALES_DEFAULT_BANK_PCT));
  const taxPct = salesNum(p.tax_rate_pct, salesNum(gym.tax_rate_pct, SALES_DEFAULT_TAX_PCT));
  const group = salesGroup(p);
  const interval = ['month', 'year', 'week', 'once'].includes(p.interval) ? p.interval : (group === 'membership' ? 'month' : 'once');
  return {
    id: p.id,
    name: String(p.name || 'Plan'),
    kind: planBillingKind(p),
    group,
    free: price === 0,
    description: String(p.description || ''),
    price_cents: price,
    interval,
    interval_count: Math.max(1, Math.round(salesNum(p.interval_count, 1))),
    commitment_months: Math.max(0, Math.round(salesNum(p.commitment_months, 0))),
    bank_discount_pct: price ? bankPct : 0,
    bank_price_cents: price ? Math.round(price * (1 - bankPct / 100)) : 0,
    tax_rate_pct: price ? taxPct : 0,
    tax_note: price && taxPct ? `plus ${taxPct}% tax` : '',
  };
}

async function salesFindOrCreateLead(env, { full_name, email, phone, plan }) {
  const found = await selectEntities(env, 'Client', `lower(json_extract(data,'$.email')) = ?`, [email]);
  if (found.length) return found[0];
  return insertEntity(env, 'Client', {
    full_name, email, phone, status: 'lead', lead_source: 'join_page', lead_plan_id: plan.id, lead_plan_name: plan.name || '',
  }, 'join_page');
}

async function salesSignAgreement(env, { client, plan, signed_name, ip }) {
  const rec = await createAgreement(env, { client_id: client.id, plan: await getEntityById(env, 'MembershipPlan', plan.id), signed_name, actor: client.email || 'join_page', ip });
  return { agreement_id: rec?.id || null };
}

// QuickBooks-friendly CSV cell: neutralize formulas, quote when needed.
function salesCsvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const salesMoney = (c) => (Math.round(salesNum(c, 0)) / 100).toFixed(2);
const salesUsDate = (key) => (key ? `${key.slice(5, 7)}/${key.slice(8, 10)}/${key.slice(0, 4)}` : '');
const salesDay = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? programToday(Date.parse(iso)) : null);
const SALES_MOVED = new Set(['paid', 'refunded', 'partially_refunded']);

async function salesClientNames(env, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT id, json_extract(data,'$.full_name') AS name FROM entities WHERE entity_type='Client' AND id IN (${inList(list)})`
  ).bind(...list).all();
  return new Map(results.map((r) => [r.id, r.name || 'Member']));
}

async function salesRenewals(env, memberships, names, plans, today) {
  // eslint-disable-next-line no-undef
  if (typeof upcomingRenewals === 'function') return upcomingRenewals(env); // RULES' report
  try {
    const saved = JSON.parse((await getState(env, 'billing_renewals'))?.value || 'null');
    if (Array.isArray(saved)) return saved;
    if (Array.isArray(saved?.renewals)) return saved.renewals;
  } catch { /* fall through */ }
  const until = pAddDays(today, 7);
  return memberships
    .filter((m) => m.billing_status === 'active' && isDateKey(m.next_payment_date) && m.next_payment_date >= today && m.next_payment_date <= until)
    .map((m) => ({
      membership_id: m.id, client_id: m.client_id, name: names.get(m.client_id) || 'Member',
      plan: m.plan_name || plans.get(m.plan_id)?.name || 'Plan', date: m.next_payment_date,
      amount_cents: salesNum(plans.get(m.plan_id)?.price_cents, null),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function runSalesFunction(name, payload, ctx) {
  const { env, user, url, request } = ctx;
  const p = payload || {};
  switch (name) {
    case 'publicPlans': {
      if (await salesRateLimited(env, request, 'plans', 120)) return SALES_RATE_LIMITED;
      const gym = await salesGymSettings(env);
      const plans = (await selectEntities(env, 'MembershipPlan')).filter((x) => salesIsPublic(x) && salesIsActive(x))
        .map((x) => salesPublicPlan(x, gym))
        .sort((a, b) => (a.group === b.group ? a.price_cents - b.price_cents : a.group === 'try' ? -1 : 1));
      return {
        success: true, connected: salesConnected(env), plans,
        agreement: await currentAgreement(env),
      };
    }

    // One reply shape whether or not the email is already known.
    case 'publicCheckout': {
      const limit = Math.max(1, salesNum(env.SALES_RATE_LIMIT, 10));
      if (await salesRateLimited(env, request, 'checkout', limit)) return SALES_RATE_LIMITED;
      const full_name = String(p.full_name || '').trim().replace(/\s+/g, ' ');
      const email = String(p.email || '').trim().toLowerCase();
      const phone = String(p.phone || '').trim();
      if (full_name.length < 2 || full_name.length > 100) return { success: false, error: 'Please enter your full name.' };
      if (!SALES_EMAIL.test(email) || email.length > 200) return { success: false, error: 'That email address does not look right.' };
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15 || phone.length > 30) return { success: false, error: 'Please enter a phone number we can reach you at.' };
      const raw = await getEntityById(env, 'MembershipPlan', String(p.plan_id || ''));
      if (!raw || !salesIsPublic(raw) || !salesIsActive(raw)) return { success: false, error: 'That option isn\'t available. Pick another.' };
      const gym = await salesGymSettings(env);
      const plan = { ...salesPublicPlan(raw, gym), stripe_price_id: raw.stripe_price_id || null, stripe_price_bank_id: raw.stripe_price_bank_id || null };
      const ip = request?.headers?.get('cf-connecting-ip') || '';

      if (plan.free) {
        const client = await salesFindOrCreateLead(env, { full_name, email, phone, plan });
        await insertEntity(env, 'ContactMessage', {
          name: full_name, email, phone, subject: `Free trial: ${plan.name}`, status: 'new', source: 'join_page',
          message: `${full_name} asked for a free trial (${plan.name}) from the Join page. Phone: ${phone}`,
        }, null);
        // Existing invite flow, only when this email has no account yet; the link is never returned here.
        const hasAccount = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        let emailed = false;
        if (!hasAccount) {
          const link = await createAccountLink(env, url, { kind: 'invite', email, user_type: 'client', client_id: client.id, full_name: client.full_name || full_name, hours: INVITE_HOURS, created_by: 'join_page' });
          emailed = !!(await emailAccountLink(env, { kind: 'invite', to: email, name: full_name, link }))?.success;
        }
        await audit(env, { actor: email, action: 'trial_requested', target: 'MembershipPlan', targetId: plan.id, detail: emailed ? 'invite emailed' : 'invite recorded', request });
        return { success: true, kind: 'trial', message: 'Thanks! We\'ll be in touch soon to set up your first class.' };
      }

      if (!salesConnected(env)) return { success: false, code: 'billing_not_connected', error: 'Online sign-up isn\'t open yet. Contact us to join.' };
      const method = p.method === 'bank' ? 'bank' : p.method === 'card' ? 'card' : null;
      if (!method) return { success: false, error: 'Pick card or bank account.' };
      const promo = p.promo_code ? String(p.promo_code).trim().toUpperCase() : '';
      if (promo && !/^[A-Z0-9_-]{2,40}$/.test(promo)) return { success: false, error: 'That promo code isn\'t valid.' };
      const signed = String(p.signed_name || '').trim().replace(/\s+/g, ' ');
      if (planNeedsAgreement(raw) && signed.toLowerCase() !== full_name.toLowerCase()) {
        return { success: false, code: 'agreement_required', error: 'Type your full name to sign the agreement.' };
      }

      const client = await salesFindOrCreateLead(env, { full_name, email, phone, plan });
      let agreement_id = null;
      if (planNeedsAgreement(raw)) agreement_id = (await salesSignAgreement(env, { client, plan, signed_name: signed, ip }))?.agreement_id || null;
      const origin = appOrigin(env, url);
      let out;
      try {
        out = await createCheckoutSession(env, {
          plan: raw, client, method, promo_code: promo || undefined, agreement_id: agreement_id || undefined,
          success_url: `${origin}/JoinBrigade?joined=1`, cancel_url: `${origin}/JoinBrigade?canceled=1`,
        });
      } catch (e) {
        await recordError(env, { source: 'server', message: `publicCheckout: ${e?.message || e}`, page: 'JoinBrigade' });
        return { success: false, error: 'We couldn\'t start checkout. Please try again or contact us.' };
      }
      if (!out?.url) return { success: false, error: out?.error || 'We couldn\'t start checkout. Please try again or contact us.' };
      await audit(env, { actor: email, action: 'join_checkout_started', target: 'MembershipPlan', targetId: plan.id, detail: method, request });
      return { success: true, kind: 'checkout', url: out.url };
    }

    case 'listPromoCodes': {
      if (!can(user, 'billing.view')) return NO_PERMISSION;
      const codes = (await selectEntities(env, 'PromoCode')).sort((a, b) => String(b.created_date).localeCompare(String(a.created_date)));
      if (salesConnected(env) && codes.length) {
        try {
          const live = await stripe(env, 'promotion_codes?limit=100', { method: 'GET' });
          const used = new Map((live?.data || []).map((x) => [x.id, x.times_redeemed || 0]));
          for (const c of codes) if (used.has(c.promotion_code_id)) c.times_redeemed = used.get(c.promotion_code_id);
        } catch { /* show what we have */ }
      }
      return { success: true, connected: salesConnected(env), can_edit: can(user, 'settings.manage'), codes };
    }

    case 'savePromoCode': {
      if (!can(user, 'billing.view') || !can(user, 'settings.manage')) return NO_PERMISSION;
      if (!salesConnected(env)) return { success: false, code: 'billing_not_connected', error: 'Connect billing first. Promo codes live in Stripe.' };
      const code = String(p.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return { success: false, error: 'Use 3 to 30 letters or numbers for the code.' };
      const percent = p.percent_off === undefined || p.percent_off === null || p.percent_off === '' ? null : Number(p.percent_off);
      const amount = p.amount_off_cents === undefined || p.amount_off_cents === null || p.amount_off_cents === '' ? null : Math.round(Number(p.amount_off_cents));
      if ((percent === null) === (amount === null)) return { success: false, error: 'Pick a percent off or an amount off.' };
      if (percent !== null && !(percent > 0 && percent <= 100)) return { success: false, error: 'Percent off must be between 1 and 100.' };
      if (amount !== null && !(amount >= 1 && amount <= 1000000)) return { success: false, error: 'Enter a dollar amount off.' };
      const duration = ['once', 'repeating', 'forever'].includes(p.duration) ? p.duration : null;
      if (!duration) return { success: false, error: 'Pick how long the discount lasts.' };
      const months = duration === 'repeating' ? Math.round(Number(p.duration_in_months)) : null;
      if (duration === 'repeating' && !(months >= 1 && months <= 36)) return { success: false, error: 'Pick 1 to 36 months.' };
      const expires = p.expires_on ? String(p.expires_on) : null;
      if (expires && (!isDateKey(expires) || expires < programToday())) return { success: false, error: 'Pick an end date in the future.' };
      const maxUses = p.max_redemptions === undefined || p.max_redemptions === null || p.max_redemptions === '' ? null : Math.round(Number(p.max_redemptions));
      if (maxUses !== null && !(maxUses >= 1 && maxUses <= 100000)) return { success: false, error: 'Max uses must be 1 or more.' };
      const dupe = await selectEntities(env, 'PromoCode', `json_extract(data,'$.code') = ? AND COALESCE(json_extract(data,'$.active'),1) = 1`, [code]);
      if (dupe.length) return { success: false, error: 'That code already exists.' };
      let coupon; let promo;
      try {
        coupon = await stripe(env, 'coupons', {
          data: {
            name: code, duration, duration_in_months: months ?? undefined,
            ...(percent !== null ? { percent_off: percent } : { amount_off: amount, currency: 'usd' }),
          },
        });
        promo = await stripe(env, 'promotion_codes', {
          data: {
            coupon: coupon.id, code,
            expires_at: expires ? Math.floor(easternToUTC(expires, '23:59') / 1000) : undefined,
            max_redemptions: maxUses ?? undefined,
          },
        });
      } catch (e) {
        return { success: false, error: `Stripe said: ${String(e?.message || e).slice(0, 160)}` };
      }
      const rec = await insertEntity(env, 'PromoCode', {
        code, coupon_id: coupon.id, promotion_code_id: promo.id, percent_off: percent, amount_off_cents: amount,
        duration, duration_in_months: months, expires_on: expires, max_redemptions: maxUses, active: true, times_redeemed: 0,
      }, user.id);
      await audit(env, { actor: user.email, action: 'promo_code_created', target: 'PromoCode', targetId: rec.id, detail: `${code} ${percent !== null ? `${percent}%` : `${amount}c`} ${duration}`, request });
      return { success: true, promo_code: rec };
    }

    case 'archivePromoCode': {
      if (!can(user, 'billing.view') || !can(user, 'settings.manage')) return NO_PERMISSION;
      const rec = await getEntityById(env, 'PromoCode', String(p.id || ''));
      if (!rec) return { success: false, error: 'Promo code not found.' };
      if (rec.promotion_code_id && salesConnected(env)) {
        try { await stripe(env, `promotion_codes/${encodeURIComponent(rec.promotion_code_id)}`, { data: { active: false } }); } catch (e) {
          return { success: false, error: `Stripe said: ${String(e?.message || e).slice(0, 160)}` };
        }
      }
      const saved = await patchEntity(env, rec, { active: false, archived_at: nowISO() });
      await audit(env, { actor: user.email, action: 'promo_code_archived', target: 'PromoCode', targetId: rec.id, detail: rec.code, request });
      return { success: true, promo_code: saved };
    }

    case 'billingDashboard': {
      if (!can(user, 'billing.view')) return NO_PERMISSION;
      const today = programToday();
      const month = /^\d{4}-\d{2}$/.test(String(p.month || '')) ? p.month : today.slice(0, 7);
      const [payments, memberships, planRows] = await Promise.all([
        selectEntities(env, 'Payment'), selectEntities(env, 'Membership'), selectEntities(env, 'MembershipPlan'),
      ]);
      const plans = new Map(planRows.map((x) => [x.id, x]));
      const names = await salesClientNames(env, [...payments.map((x) => x.client_id), ...memberships.map((x) => x.client_id)]);
      const inMonth = (iso) => (salesDay(iso) || '').slice(0, 7) === month;
      const revenue = { gross_cents: 0, refunded_cents: 0, net_cents: 0, tax_cents: 0, discount_cents: 0, payments: 0, failed: 0 };
      for (const x of payments) {
        if (SALES_MOVED.has(x.status) && inMonth(x.paid_at)) {
          revenue.gross_cents += salesNum(x.amount_cents, 0);
          revenue.tax_cents += salesNum(x.tax_cents, 0);
          revenue.discount_cents += salesNum(x.discount_cents, 0);
          revenue.payments += 1;
        }
        if (salesNum(x.refunded_cents, 0) > 0 && inMonth(x.refunded_at || x.paid_at)) revenue.refunded_cents += salesNum(x.refunded_cents, 0);
        if (x.status === 'failed' && inMonth(x.paid_at || x.created_date)) revenue.failed += 1;
      }
      revenue.net_cents = revenue.gross_cents - revenue.refunded_cents;
      const counts = { active: 0, past_due: 0, paused: 0, comped: 0 };
      for (const m of memberships) {
        const s = m.billing_status === 'unpaid' ? 'past_due' : m.billing_status;
        if (s in counts) counts[s] += 1;
      }
      const failedFor = (m) => payments.filter((x) => x.membership_id === m.id && x.status === 'failed')
        .map((x) => salesDay(x.paid_at || x.created_date)).filter(Boolean).sort();
      const past_due = memberships.filter((m) => m.billing_status === 'past_due' || m.billing_status === 'unpaid').map((m) => {
        const fails = failedFor(m);
        return {
          membership_id: m.id, client_id: m.client_id, name: names.get(m.client_id) || 'Member',
          plan: m.plan_name || plans.get(m.plan_id)?.name || 'Plan', status: m.billing_status,
          failed_payments: Math.max(salesNum(m.failed_payments, 0), fails.length),
          since: m.past_due_since || fails[0] || null,
        };
      }).sort((a, b) => String(a.since || '9').localeCompare(String(b.since || '9')));
      const renewals = await salesRenewals(env, memberships, names, plans, today);
      const refunds = payments.filter((x) => salesNum(x.refunded_cents, 0) > 0)
        .sort((a, b) => String(b.refunded_at || b.paid_at || '').localeCompare(String(a.refunded_at || a.paid_at || '')))
        .slice(0, 10)
        .map((x) => ({
          payment_id: x.id, client_id: x.client_id, name: names.get(x.client_id) || 'Member', description: x.description || '',
          refunded_cents: salesNum(x.refunded_cents, 0), amount_cents: salesNum(x.amount_cents, 0), date: salesDay(x.refunded_at || x.paid_at),
        }));
      return { success: true, connected: salesConnected(env), month, today, revenue, counts, past_due, renewals, refunds };
    }

    case 'exportPaymentsCsv': {
      if (!can(user, 'billing.view')) return NO_PERMISSION;
      const today = programToday();
      const from = isDateKey(p.from) ? p.from : `${today.slice(0, 7)}-01`;
      const to = isDateKey(p.to) ? p.to : today;
      if (from > to) return { success: false, error: 'The start date is after the end date.' };
      if (pDaysBetween(from, to) > 400) return { success: false, error: 'Pick a range of about a year or less.' };
      const payments = (await selectEntities(env, 'Payment'))
        .map((x) => ({ ...x, day: salesDay(x.paid_at) }))
        .filter((x) => SALES_MOVED.has(x.status) && x.day && x.day >= from && x.day <= to)
        .sort((a, b) => a.day.localeCompare(b.day) || String(a.paid_at).localeCompare(String(b.paid_at)));
      const names = await salesClientNames(env, payments.map((x) => x.client_id));
      const header = ['Date', 'Customer', 'Description', 'Amount', 'Tax', 'Discount', 'Refunded', 'Method', 'Stripe id'];
      const rows = payments.map((x) => [
        salesUsDate(x.day), names.get(x.client_id) || 'Member', x.description || 'Membership payment',
        salesMoney(x.amount_cents), salesMoney(x.tax_cents), salesMoney(x.discount_cents), salesMoney(x.refunded_cents),
        x.method || '', x.stripe_invoice_id || x.stripe_payment_intent_id || '',
      ]);
      const csv = [header, ...rows].map((r) => r.map(salesCsvCell).join(',')).join('\r\n') + '\r\n';
      await audit(env, { actor: user.email, action: 'payments_exported', target: 'Payment', detail: `${from}..${to} (${rows.length})`, request });
      return { success: true, from, to, count: rows.length, filename: `brigade-payments-${from}-to-${to}.csv`, csv };
    }

    default:
      return { success: false, error: 'Unknown sales function.' };
  }
}
// ===== end Phase 4: SALES =====

// ===== Scheduling: CORE =====
// Coach scheduling, coach side: the staff-only entities (StaffShift,
// Availability, TimeOffRequest, ScheduleWeek), each coach's own schedule,
// availability and time off. Managing other people's schedules needs the
// right coach_schedule.manage (BOARD adds it to RIGHTS; admins always have it).
// Coaches write the four entities only through these functions; generic
// entity-API writes need coach_schedule.manage. Reads are scoped below.
const SCHED_TYPES = new Set(['StaffShift', 'Availability', 'TimeOffRequest', 'ScheduleWeek']);
for (const t of SCHED_TYPES) STAFF_WRITE_TYPES.add(t);
const AVAILABILITY_BLOCKS = {
  early: { label: 'Early', start: '05:00', end: '11:00' },
  midday: { label: 'Midday', start: '11:00', end: '16:00' },
  evening: { label: 'Evening', start: '16:00', end: '21:00' },
};
const SCHED_COLORS = { shift: '#14b8a6', class: '#8b5cf6', pt: '#f97366', time_off: '#9ca3af' };
const SCHED_AVAIL_DAYS = 28; // today .. today+27
const SCHED_MAX_RANGE = 62;
const managesCoachSchedule = (user) => can(user, 'coach_schedule.manage');

// Generic entity reads: members get nothing; coaches see published shifts,
// their own availability and their own time off; managers see everything.
function schedEntityScope(type, user) {
  if (!isStaff(user)) return { sql: '0', binds: [] };
  if (managesCoachSchedule(user) || type === 'ScheduleWeek') return null;
  if (type === 'StaffShift') return { sql: `json_extract(data,'$.status') = 'published'`, binds: [] };
  return { sql: `json_extract(data,'$.user_id') = ?`, binds: [user.id] };
}
// A time-off reason is for the coach and schedule managers only.
function schedRedact(user, type, rec) {
  if (type !== 'TimeOffRequest' || !rec || managesCoachSchedule(user) || rec.user_id === user?.id) return rec;
  const { reason: _r, ...rest } = rec;
  return rest;
}

const schedHm = (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
const GYM_HM = new Intl.DateTimeFormat('en-US', { timeZone: PROGRAM_TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
const isoToGymHm = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(GYM_HM.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`;
};
const schedFmtRange = (a, b) => (a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`);
const schedDates = (from, to) => { const out = []; for (let d = from; d <= to; d = pAddDays(d, 1)) out.push(d); return out; };
const schedOverlap = (s1, e1, s2, e2) => hmToMin(s1) < hmToMin(e2) && hmToMin(s2) < hmToMin(e1);

function classTimes(cs) {
  const start = schedHm(cs.start_time) || isoToGymHm(cs.start_at) || '00:00';
  let end = cs.end_at ? isoToGymHm(cs.end_at) : null;
  if (!end) end = minToHm(hmToMin(start) + (numOr(cs.duration_min, 60) || 60));
  return { start, end };
}
function ptTimes(s) {
  const start = schedHm(s.start_time) || '00:00';
  const end = schedHm(s.end_time) && hmToMin(s.end_time) > hmToMin(start) ? s.end_time : minToHm(hmToMin(start) + (numOr(s.duration, 60) || 60));
  return { start, end };
}

// Range from the payload, with defaults and a cap. -> { from, to } | { error }
function schedRange(p, defFrom, defTo) {
  const from = p?.from ?? defFrom;
  const to = p?.to ?? defTo;
  if (!isDateKey(from) || !isDateKey(to)) return { error: 'Pick valid dates.' };
  if (to < from) return { error: 'The end date is before the start date.' };
  if (pDaysBetween(from, to) + 1 > SCHED_MAX_RANGE) return { error: `Pick ${SCHED_MAX_RANGE} days or fewer.` };
  return { from, to };
}

// Everything one coach works in a date range (published shifts, coached
// classes, PT sessions), as schedule items.
async function schedWorkItems(env, userId, from, to) {
  const shifts = await selectEntities(env, 'StaffShift',
    `json_extract(data,'$.user_id') = ? AND json_extract(data,'$.date') BETWEEN ? AND ? AND json_extract(data,'$.status') = 'published'`, [userId, from, to]);
  const classes = await selectEntities(env, 'ClassSession',
    `json_extract(data,'$.coach_user_id') = ? AND json_extract(data,'$.date') BETWEEN ? AND ? AND COALESCE(json_extract(data,'$.status'),'scheduled') = 'scheduled'`, [userId, from, to]);
  const pts = await selectEntities(env, 'Session',
    `json_extract(data,'$.trainer_id') = ? AND json_extract(data,'$.date') BETWEEN ? AND ? AND COALESCE(json_extract(data,'$.status'),'') <> 'cancelled'`, [userId, from, to]);
  return [
    ...shifts.map((s) => ({ kind: 'shift', id: s.id, date: s.date, start: s.start, end: s.end, title: s.role_label || 'Shift', subtitle: s.note || '', color: SCHED_COLORS.shift, status: s.status })),
    ...classes.map((c) => ({ kind: 'class', id: c.id, date: c.date, ...classTimes(c), title: c.class_type_name || 'Class', subtitle: 'Coaching', color: SCHED_COLORS.class, status: c.status || 'scheduled' })),
    ...pts.map((s) => ({ kind: 'pt', id: s.id, date: s.date, ...ptTimes(s), title: s.client_name || 'Client session', subtitle: String(s.type || 'personal_training').replace(/_/g, ' '), color: SCHED_COLORS.pt, status: s.status || 'scheduled' })),
  ];
}

// Hours worked, counting overlapping items (a class inside a shift) once.
function schedHours(items) {
  const byDay = {};
  for (const it of items) {
    if (it.kind === 'time_off') continue;
    const a = hmToMin(it.start); const b = hmToMin(it.end);
    if (a === null || b === null || b <= a) continue;
    (byDay[it.date] = byDay[it.date] || []).push([a, b]);
  }
  let mins = 0;
  for (const list of Object.values(byDay)) {
    list.sort((x, y) => x[0] - y[0]);
    let [cs, ce] = list[0];
    for (const [a, b] of list.slice(1)) {
      if (a <= ce) ce = Math.max(ce, b);
      else { mins += ce - cs; cs = a; ce = b; }
    }
    mins += ce - cs;
  }
  return Math.round((mins / 60) * 100) / 100;
}

async function schedOwnTimeOff(env, userId, from, to, statuses = ['pending', 'approved']) {
  return selectEntities(env, 'TimeOffRequest',
    `json_extract(data,'$.user_id') = ? AND json_extract(data,'$.status') IN (${inList(statuses)}) AND json_extract(data,'$.start_date') <= ? AND json_extract(data,'$.end_date') >= ?`,
    [userId, ...statuses, to, from]);
}

const timeOffPublic = (r) => ({
  id: r.id, user_id: r.user_id, user_name: r.user_name || '', start_date: r.start_date, end_date: r.end_date,
  part_day: r.part_day || null, reason: r.reason || '', status: r.status, decided_by: r.decided_by || null,
  decided_at: r.decided_at || null, decision_note: r.decision_note || '', affected: r.affected || [],
  created_date: r.created_date,
});

// Validates a time-off window. -> { start_date, end_date, part_day } | { error }
function schedTimeOffWindow(p) {
  const today = programToday();
  const { start_date: s, end_date: e0 } = p || {};
  const e = e0 || s;
  if (!isDateKey(s) || !isDateKey(e)) return { error: 'Pick the dates you need off.' };
  if (e < s) return { error: 'The last day is before the first day.' };
  if (s < today) return { error: 'Time off can\'t start in the past.' };
  if (pDaysBetween(s, e) + 1 > 60) return { error: 'Ask for 60 days or fewer at a time.' };
  let part = null;
  if (p.part_day) {
    if (s !== e) return { error: 'Part of a day only works for a single day.' };
    const ps = schedHm(p.part_day.start); const pe = schedHm(p.part_day.end);
    if (!ps || !pe || hmToMin(pe) <= hmToMin(ps)) return { error: 'Pick a start and end time for the part of the day.' };
    part = { start: ps, end: pe };
  }
  return { start_date: s, end_date: e, part_day: part };
}

async function schedImpact(env, userId, w) {
  const items = await schedWorkItems(env, userId, w.start_date, w.end_date);
  return items
    .filter((it) => !w.part_day || schedOverlap(it.start, it.end, w.part_day.start, w.part_day.end))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    .map((it) => ({ kind: it.kind, id: it.id, date: it.date, label: it.title, time: `${it.start}–${it.end}` }));
}

// Staff with coach_schedule.manage (admins included).
async function schedManagers(env) {
  const { results } = await env.DB.prepare('SELECT * FROM users').all();
  const out = [];
  for (const row of results) {
    const u = userRow(row);
    if (!u || u.disabled) continue;
    u.role = resolveRole(env, u.email, u.role);
    if (!isStaff(u)) continue;
    if (managesCoachSchedule(await attachRights(env, u))) out.push(u);
  }
  return out;
}

async function schedNotify(env, userIds, { title, message, link }, actor) {
  if (!userIds.length) return;
  return notifyScheduleChange(env, userIds, { title, message, link, createdBy: actor });
}

async function schedAvailabilityRows(env, userId, from, to) {
  return selectEntities(env, 'Availability',
    `json_extract(data,'$.user_id') = ? AND json_extract(data,'$.date') BETWEEN ? AND ?`, [userId, from, to]);
}
const schedBlocks = (b) => Object.fromEntries(Object.keys(AVAILABILITY_BLOCKS).map((k) => [k, b?.[k] === true]));

async function schedUpsertAvailability(env, user, date, blocks, note) {
  const [existing] = await schedAvailabilityRows(env, user.id, date, date);
  const fields = { user_id: user.id, date, blocks: schedBlocks(blocks), note: String(note || '').slice(0, 300), submitted_at: nowISO() };
  return existing ? patchEntity(env, existing, fields) : insertEntity(env, 'Availability', fields, user.email);
}

async function runSchedCoreFunction(name, p, { env, user }) {
  if (!isStaff(user)) return { success: false, error: 'Only staff can use the schedule.', code: 'forbidden' };
  p = p || {};
  const today = programToday();
  switch (name) {
    case 'mySchedule': {
      let target = user;
      if (p.user_id && p.user_id !== user.id) {
        if (!managesCoachSchedule(user)) return NO_PERMISSION;
        const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(p.user_id).first();
        const u = row ? userRow(row) : null;
        if (u) u.role = resolveRole(env, u.email, u.role);
        if (!u || !isStaff(u)) return { success: false, error: 'Staff member not found.' };
        target = u;
      }
      const monday = classWeekStart(today);
      const r = schedRange(p, monday, pAddDays(monday, 6));
      if (r.error) return { success: false, error: r.error };
      const items = await schedWorkItems(env, target.id, r.from, r.to);
      const offs = await schedOwnTimeOff(env, target.id, r.from, r.to);
      for (const t of offs) {
        for (const d of schedDates(t.start_date < r.from ? r.from : t.start_date, t.end_date > r.to ? r.to : t.end_date)) {
          items.push({
            kind: 'time_off', id: t.id, date: d, start: t.part_day?.start || null, end: t.part_day?.end || null,
            title: t.status === 'approved' ? 'Time off' : 'Time off (pending)', subtitle: t.part_day ? 'Part of the day' : 'All day',
            color: SCHED_COLORS.time_off, status: t.status,
          });
        }
      }
      items.sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
      return { success: true, user_id: target.id, from: r.from, to: r.to, items, hours_total: schedHours(items), time_off: offs.map(timeOffPublic) };
    }

    case 'myAvailability': {
      const r = schedRange(p, today, pAddDays(today, 13));
      if (r.error) return { success: false, error: r.error };
      const rows = await schedAvailabilityRows(env, user.id, r.from, r.to);
      const byDate = Object.fromEntries(rows.map((x) => [x.date, x]));
      const days = schedDates(r.from, r.to).map((date) => ({
        date, blocks: schedBlocks(byDate[date]?.blocks), note: byDate[date]?.note || '', saved: !!byDate[date],
      }));
      return { success: true, from: r.from, to: r.to, blocks: AVAILABILITY_BLOCKS, days, last_date: pAddDays(today, SCHED_AVAIL_DAYS - 1) };
    }

    case 'saveAvailability': {
      const days = Array.isArray(p.days) ? p.days : [];
      if (!days.length) return { success: false, error: 'Nothing to save.' };
      if (days.length > SCHED_AVAIL_DAYS) return { success: false, error: `Save ${SCHED_AVAIL_DAYS} days or fewer.` };
      const last = pAddDays(today, SCHED_AVAIL_DAYS - 1);
      for (const d of days) {
        if (!isDateKey(d?.date) || d.date < today || d.date > last) {
          return { success: false, error: `You can set availability from today through ${fmtDay(last)}.` };
        }
      }
      const saved = [];
      for (const d of days) {
        const row = await schedUpsertAvailability(env, user, d.date, d.blocks, d.note);
        saved.push({ date: row.date, blocks: row.blocks, note: row.note });
      }
      return { success: true, days: saved.sort((a, b) => a.date.localeCompare(b.date)) };
    }

    case 'copyAvailabilityLastWeek': {
      // Source: the past 7 days if any were saved (fills both coming weeks);
      // otherwise this coming week (fills the week after it).
      let source = await schedAvailabilityRows(env, user.id, pAddDays(today, -7), pAddDays(today, -1));
      let first = today;
      if (!source.length) { source = await schedAvailabilityRows(env, user.id, today, pAddDays(today, 6)); first = pAddDays(today, 7); }
      if (!source.length) return { success: false, error: 'Save a week first, then copy it.' };
      const byDow = {};
      for (const s of source) byDow[pDow(s.date)] = s;
      const days = [];
      for (const date of schedDates(first, pAddDays(today, 13))) {
        const src = byDow[pDow(date)];
        if (!src) continue;
        const row = await schedUpsertAvailability(env, user, date, src.blocks, src.note);
        days.push({ date, blocks: row.blocks, note: row.note });
      }
      return { success: true, days, copied: days.length };
    }

    case 'timeOffImpact': {
      const w = schedTimeOffWindow(p);
      if (w.error) return { success: false, error: w.error };
      return { success: true, affected: await schedImpact(env, user.id, w) };
    }

    case 'requestTimeOff': {
      const w = schedTimeOffWindow(p);
      if (w.error) return { success: false, error: w.error };
      const clash = (await schedOwnTimeOff(env, user.id, w.start_date, w.end_date)).find((t) => !(
        w.part_day && t.part_day && t.start_date === w.start_date && !schedOverlap(t.part_day.start, t.part_day.end, w.part_day.start, w.part_day.end)));
      if (clash) return { success: false, error: `You already asked for time off ${schedFmtRange(clash.start_date, clash.end_date)}.`, code: 'overlap' };
      const request = await insertEntity(env, 'TimeOffRequest', {
        user_id: user.id, user_name: user.full_name || user.email, start_date: w.start_date, end_date: w.end_date,
        part_day: w.part_day, reason: String(p.reason || '').trim().slice(0, 500), status: 'pending',
        decided_by: null, decided_at: null, decision_note: '', affected: await schedImpact(env, user.id, w),
      }, user.email);
      await audit(env, { actor: user.email, action: 'time_off_requested', target: 'TimeOffRequest', targetId: request.id, detail: schedFmtRange(w.start_date, w.end_date) });
      const managers = (await schedManagers(env)).map((m) => m.id).filter((id) => id !== user.id);
      await schedNotify(env, managers, {
        title: 'Time off request',
        message: `${user.full_name || 'A coach'} asked for time off ${schedFmtRange(w.start_date, w.end_date)}${request.affected.length ? ` (${request.affected.length} thing${request.affected.length === 1 ? '' : 's'} need cover)` : ''}.`,
        link: '/TimeOffInbox',
      }, user.email);
      return { success: true, request: timeOffPublic(request) };
    }

    case 'cancelTimeOff': {
      const r = await getEntityById(env, 'TimeOffRequest', p.id);
      if (!r || r.user_id !== user.id) return { success: false, error: 'Request not found.' };
      if (r.status === 'approved' && r.start_date <= today) return { success: false, error: 'This time off has already started. Ask a manager to change it.' };
      if (r.status !== 'pending' && r.status !== 'approved') return { success: false, error: 'This request can\'t be cancelled.' };
      const wasApproved = r.status === 'approved';
      const fresh = await patchEntity(env, r, { status: 'cancelled', cancelled_at: nowISO() });
      await audit(env, { actor: user.email, action: 'time_off_cancelled', target: 'TimeOffRequest', targetId: r.id, detail: r.status });
      if (wasApproved) {
        const managers = (await schedManagers(env)).map((m) => m.id).filter((id) => id !== user.id);
        await schedNotify(env, managers, { title: 'Time off cancelled', message: `${user.full_name || 'A coach'} cancelled their time off ${schedFmtRange(r.start_date, r.end_date)}.`, link: '/TimeOffInbox' }, user.email);
      }
      return { success: true, request: timeOffPublic(fresh) };
    }

    case 'myTimeOff': {
      const rows = await selectEntities(env, 'TimeOffRequest', `json_extract(data,'$.user_id') = ?`, [user.id]);
      rows.sort((a, b) => b.start_date.localeCompare(a.start_date));
      return { success: true, requests: rows.map(timeOffPublic) };
    }

    default:
      return { __unimplemented: true };
  }
}
// ===== end Scheduling: CORE =====

// ===== Scheduling: BOARD =====
// Manager side of coach scheduling: the weekly board, shifts, publish, and the
// time off inbox. Everything here needs the right coach_schedule.manage.
const BOARD_PERM = 'coach_schedule.manage';
const BOARD_BLOCKS = Object.fromEntries(Object.entries(AVAILABILITY_BLOCKS).map(([k, b]) => [k, [b.start, b.end]]));
const BOARD_HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const boardOverlap = (aS, aE, bS, bE) => hmToMin(aS) < hmToMin(bE) && hmToMin(bS) < hmToMin(aE);
const boardWeek = (k) => classWeekStart(isDateKey(k) ? k : programToday());
const boardWeekLabel = (k) => new Date(keyToUTC(k)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const boardEnd = (start, minutes) => minToHm(Math.min(hmToMin(start) + (Number(minutes) || 60), 1439));

async function boardStaff(env) {
  const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY full_name').all();
  return results.map(userRow).map((u) => ({ ...u, role: resolveRole(env, u.email, u.role) }))
    .filter(isStaff).map((u) => ({ id: u.id, name: u.full_name || u.email }));
}

// Time off that touches `date` (and the time window, for part-day requests).
const boardOffCovers = (t, date, start = null, end = null) => t.start_date <= date && t.end_date >= date
  && (!t.part_day || !start || boardOverlap(t.part_day.start, t.part_day.end, start, end));

// Is [start,end] inside the coach's available blocks that day? null = no row on file.
function boardAvailable(avail, start, end) {
  if (!avail) return null;
  let t = hmToMin(start);
  const stop = hmToMin(end);
  const spans = Object.entries(BOARD_BLOCKS).filter(([k]) => avail.blocks?.[k]).map(([, s]) => s.map(hmToMin)).sort((a, b) => a[0] - b[0]);
  for (const [s, e] of spans) if (s <= t && e > t) t = e;
  return t >= stop;
}

async function boardRange(env, from, to) {
  const inRange = `json_extract(data,'$.date') BETWEEN ? AND ?`;
  const [shifts, sessions, pt, avail, off] = await Promise.all([
    selectEntities(env, 'StaffShift', inRange, [from, to]),
    selectEntities(env, 'ClassSession', `${inRange} AND json_extract(data,'$.status') = 'scheduled' AND COALESCE(json_extract(data,'$.auto_cancelled'),0) = 0`, [from, to]),
    selectEntities(env, 'Session', `${inRange} AND json_extract(data,'$.trainer_id') IS NOT NULL AND COALESCE(json_extract(data,'$.status'),'') NOT IN ('cancelled','canceled')`, [from, to]),
    selectEntities(env, 'Availability', inRange, [from, to]),
    selectEntities(env, 'TimeOffRequest', `json_extract(data,'$.status') IN ('pending','approved') AND json_extract(data,'$.start_date') <= ? AND json_extract(data,'$.end_date') >= ?`, [to, from]),
  ]);
  const classes = sessions.map((s) => ({
    id: s.id, date: s.date, start: s.start_time, end: boardEnd(s.start_time, s.duration_min),
    title: s.class_type_name || 'Class', color: s.color || null,
    coach_user_id: s.coach_user_id || null, coach_name: s.coach_name || '', reserved_count: s.reserved_count || 0,
    needs_coach: !s.coach_user_id,
  })).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const ptOut = pt.filter((p) => BOARD_HM.test(String(p.start_time || ''))).map((p) => ({
    id: p.id, date: p.date, start: p.start_time, end: boardEnd(p.start_time, p.duration || p.duration_min),
    trainer_id: p.trainer_id, title: String(p.type || 'PT session').replace(/_/g, ' '), status: p.status || 'scheduled', client_name: p.client_name || '',
  }));
  const availability = {};
  for (const a of avail) (availability[a.user_id] ||= {})[a.date] = { blocks: a.blocks || {}, note: a.note || '' };
  const shiftOut = shifts.map((s) => ({ id: s.id, user_id: s.user_id, user_name: s.user_name, date: s.date, start: s.start, end: s.end, role_label: s.role_label || '', note: s.note || '', status: s.status || 'draft' }))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const timeOff = off.map((t) => ({ id: t.id, user_id: t.user_id, user_name: t.user_name, start_date: t.start_date, end_date: t.end_date, part_day: t.part_day || null, reason: t.reason || '', status: t.status }));
  return { shifts: shiftOut, classes, pt: ptOut, availability, time_off: timeOff };
}

// Is this person already busy (shift, class or PT) at that time?
const boardBusy = (r, userId, date, start, end, skipId = null) =>
  r.shifts.some((s) => s.user_id === userId && s.date === date && s.id !== skipId && boardOverlap(s.start, s.end, start, end))
  || r.classes.some((c) => c.coach_user_id === userId && c.date === date && c.id !== skipId && boardOverlap(c.start, c.end, start, end))
  || r.pt.some((p) => p.trainer_id === userId && p.date === date && boardOverlap(p.start, p.end, start, end));

async function boardNotify(env, userIds, { title, message }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  await notifyScheduleChange(env, ids, { title, message });
  return ids.length;
}

async function boardWeekState(env, weekStart) {
  return (await selectEntities(env, 'ScheduleWeek', `json_extract(data,'$.week_start') = ?`, [weekStart]))[0] || null;
}

async function boardShiftWarnings(env, r, f, skipId) {
  const warnings = [];
  const off = r.time_off.find((t) => t.user_id === f.user_id && t.status === 'approved' && boardOffCovers(t, f.date, f.start, f.end));
  if (off) warnings.push(`${f.user_name} has approved time off then.`);
  const ok = boardAvailable(r.availability[f.user_id]?.[f.date], f.start, f.end);
  if (ok === false) warnings.push(`This is outside ${f.user_name}'s availability.`);
  if (boardBusy(r, f.user_id, f.date, f.start, f.end, skipId)) warnings.push(`${f.user_name} is already working then.`);
  return warnings;
}

async function runScheduleBoardFunction(name, payload, ctx) {
  const { env, user } = ctx;
  if (!user) return { success: false, error: 'Not logged in' };
  if (!isStaff(user) || !can(user, BOARD_PERM)) return NO_PERMISSION;
  const p = payload || {};
  switch (name) {
    case 'scheduleBoard': {
      const week = boardWeek(p.week_start);
      const days = Array.from({ length: 7 }, (_, i) => pAddDays(week, i));
      const [r, coaches, state, pending] = await Promise.all([
        boardRange(env, days[0], days[6]), boardStaff(env), boardWeekState(env, week),
        selectEntities(env, 'TimeOffRequest', `json_extract(data,'$.status') = 'pending'`),
      ]);
      return {
        success: true, week_start: week, days, coaches,
        status: state?.status || 'draft', published_at: state?.published_at || null,
        ...r,
        counts: {
          needs_coach: r.classes.filter((c) => c.needs_coach).length,
          pending_time_off: pending.length,
          drafts: r.shifts.filter((s) => s.status !== 'published').length,
        },
      };
    }

    case 'saveShift': {
      const existing = p.id ? await getEntityById(env, 'StaffShift', p.id) : null;
      if (p.id && !existing) return { success: false, error: 'Shift not found.' };
      const who = await staffLogin(env, p.user_id || existing?.user_id);
      if (!who) return { success: false, error: 'Pick someone from the team.' };
      const date = p.date ?? existing?.date;
      const start = p.start ?? existing?.start;
      const end = p.end ?? existing?.end;
      if (!isDateKey(date)) return { success: false, error: 'Pick a date.' };
      if (!BOARD_HM.test(String(start)) || !BOARD_HM.test(String(end))) return { success: false, error: 'Pick a start and end time.' };
      if (hmToMin(end) <= hmToMin(start)) return { success: false, error: 'The shift has to end after it starts.' };
      const fields = {
        user_id: who.id, user_name: who.full_name || who.email, date, start, end,
        role_label: String(p.role_label ?? existing?.role_label ?? 'Coach').trim().slice(0, 40) || 'Coach',
        note: String(p.note ?? existing?.note ?? '').trim().slice(0, 300),
        status: 'draft', // stays a draft until the week is published (again)
      };
      const r = await boardRange(env, date, date);
      const warnings = await boardShiftWarnings(env, r, fields, existing?.id);
      const shift = existing
        ? await patchEntity(env, existing, { ...fields, updated_by: user.id })
        : await insertEntity(env, 'StaffShift', { ...fields, created_by_id: user.id }, user.email);
      await audit(env, { actor: user.email, action: existing ? 'update' : 'create', target: 'StaffShift', targetId: shift.id, detail: `${fields.user_name} ${date} ${start}-${end} ${fields.role_label}`, request: null });
      return { success: true, shift, warnings };
    }

    case 'deleteShift': {
      const shift = await getEntityById(env, 'StaffShift', p.id);
      if (!shift) return { success: false, error: 'Shift not found.' };
      await env.DB.prepare('DELETE FROM entities WHERE id = ? AND entity_type = ?').bind(shift.id, 'StaffShift').run();
      await audit(env, { actor: user.email, action: 'delete', target: 'StaffShift', targetId: shift.id, detail: `${shift.user_name} ${shift.date} ${shift.start}-${shift.end}`, request: null });
      // A coach could already see a published shift: tell them it's gone.
      if (shift.status === 'published' && shift.date >= programToday()) {
        await boardNotify(env, [shift.user_id], { title: 'Shift removed', message: `Your shift on ${boardWeekLabel(shift.date)} (${shift.start}–${shift.end}) was removed.` }, user.email);
      }
      return { success: true };
    }

    case 'assignClassCoach': {
      // The one coach-change path: editClassSession patches, audits and notifies.
      return editClassSession(env, user, { session_id: p.session_id, coach_user_id: p.coach_user_id || null });
    }

    case 'reassignPtSession': {
      // Move a PT / client appointment to another trainer. Both trainers are told.
      const sess = await getEntityById(env, 'Session', p.session_id);
      if (!sess || !sess.trainer_id) return { success: false, error: 'Session not found.' };
      const who = await staffLogin(env, p.trainer_id);
      if (!who) return { success: false, error: 'Pick someone from the team.' };
      if (who.id === sess.trainer_id) return { success: true, session: sess, unchanged: true };
      const prevId = sess.trainer_id;
      const updated = await patchEntity(env, sess, { trainer_id: who.id, trainer_name: who.full_name || who.email, updated_by: user.id });
      const what = `${String(sess.type || 'PT session').replace(/_/g, ' ')}${sess.client_name ? ` with ${sess.client_name}` : ''} on ${boardWeekLabel(sess.date)} at ${sess.start_time}`;
      await audit(env, { actor: user.email, action: 'reassign_pt', target: 'Session', targetId: sess.id, detail: `${prevId} -> ${who.id}`, request: null });
      if (sess.date >= programToday()) {
        await boardNotify(env, [who.id], { title: 'New session for you', message: `You now have the ${what}.` });
        await boardNotify(env, [prevId], { title: 'Session moved', message: `The ${what} was moved to ${who.full_name || 'another coach'}.` });
      }
      return { success: true, session: updated };
    }

    case 'copyScheduleWeek': {
      const fromWeek = boardWeek(p.from_week);
      const toWeek = isDateKey(p.to_week) ? boardWeek(p.to_week) : pAddDays(fromWeek, 7);
      if (fromWeek === toWeek) return { success: false, error: 'Pick a different week to copy to.' };
      const offset = pDaysBetween(fromWeek, toWeek);
      const src = await boardRange(env, fromWeek, pAddDays(fromWeek, 6));
      const dst = await boardRange(env, toWeek, pAddDays(toWeek, 6));
      const created = []; const skipped = [];
      for (const s of src.shifts) {
        const date = pAddDays(s.date, offset);
        if (dst.time_off.some((t) => t.user_id === s.user_id && t.status === 'approved' && boardOffCovers(t, date, s.start, s.end))) {
          skipped.push({ user_name: s.user_name, date, reason: 'time off' }); continue;
        }
        if (dst.shifts.some((d) => d.user_id === s.user_id && d.date === date && d.start === s.start && d.end === s.end)) {
          skipped.push({ user_name: s.user_name, date, reason: 'already there' }); continue;
        }
        created.push(await insertEntity(env, 'StaffShift', {
          user_id: s.user_id, user_name: s.user_name, date, start: s.start, end: s.end,
          role_label: s.role_label, note: s.note, status: 'draft', created_by_id: user.id,
        }, user.email));
      }
      await audit(env, { actor: user.email, action: 'create', target: 'StaffShift', targetId: toWeek, detail: `copied week ${fromWeek} to ${toWeek}: ${created.length} shifts, ${skipped.length} skipped`, request: null });
      return { success: true, week_start: toWeek, created: created.length, skipped };
    }

    case 'publishSchedule': {
      const week = boardWeek(p.week_start);
      const shifts = await selectEntities(env, 'StaffShift', `json_extract(data,'$.date') BETWEEN ? AND ?`, [week, pAddDays(week, 6)]);
      const drafts = shifts.filter((s) => s.status !== 'published');
      for (const s of drafts) await patchEntity(env, s, { status: 'published' });
      const state = await boardWeekState(env, week);
      const was = state?.status === 'published';
      const fields = { week_start: week, status: 'published', published_at: nowISO(), published_by: user.id };
      if (state) await patchEntity(env, state, fields); else await insertEntity(env, 'ScheduleWeek', fields, user.email);
      const label = boardWeekLabel(week);
      const notified = await boardNotify(env, shifts.map((s) => s.user_id), was
        ? { title: 'Schedule updated', message: `Your schedule for the week of ${label} changed. Take a look.` }
        : { title: 'Your schedule is out', message: `Your schedule for the week of ${label} is out.` }, user.email);
      await audit(env, { actor: user.email, action: 'update', target: 'ScheduleWeek', targetId: week, detail: `published week ${week}: ${drafts.length} changes, ${notified} notified`, request: null });
      return { success: true, week_start: week, published: drafts.length, notified };
    }

    case 'timeOffInbox': {
      const all = await selectEntities(env, 'TimeOffRequest');
      const want = p.status === 'history' ? (t) => t.status !== 'pending' : p.status ? (t) => t.status === p.status : () => true;
      const list = all.filter(want).sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1)
        || (a.status === 'pending' ? a.start_date.localeCompare(b.start_date) : String(b.decided_at || b.created_date).localeCompare(String(a.decided_at || a.created_date))))
        .slice(0, 200);
      const staff = await boardStaff(env);
      const requests = [];
      for (const t of list) {
        const live = t.status === 'pending' || t.status === 'approved';
        let affected = Array.isArray(t.affected) ? t.affected : [];
        let r = null;
        if (live && t.start_date && t.end_date && pDaysBetween(t.start_date, t.end_date) <= 62) {
          r = await boardRange(env, t.start_date, t.end_date);
          const hit = (date, start, end) => boardOffCovers(t, date, start, end);
          affected = [
            ...r.classes.filter((c) => c.coach_user_id === t.user_id && hit(c.date, c.start, c.end)).map((c) => ({ kind: 'class', id: c.id, date: c.date, label: c.title, time: c.start, end: c.end })),
            ...r.shifts.filter((s) => s.user_id === t.user_id && hit(s.date, s.start, s.end)).map((s) => ({ kind: 'shift', id: s.id, date: s.date, label: s.role_label || 'Shift', time: s.start, end: s.end })),
            ...r.pt.filter((x) => x.trainer_id === t.user_id && hit(x.date, x.start, x.end)).map((x) => ({ kind: 'pt', id: x.id, date: x.date, label: x.title, time: x.start, end: x.end })),
          ].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        }
        const out = { ...t, affected };
        if (r) {
          out.affected = affected.map((a) => {
            if (a.kind === 'pt' || !a.end) return a;
            const cover = staff.filter((s) => s.id !== t.user_id
              && boardAvailable(r.availability[s.id]?.[a.date], a.time, a.end) === true
              && !r.time_off.some((o) => o.user_id === s.id && boardOffCovers(o, a.date, a.time, a.end))
              && !boardBusy(r, s.id, a.date, a.time, a.end));
            return { ...a, cover_suggestions: cover };
          });
        }
        requests.push(out);
      }
      return { success: true, requests };
    }

    case 'decideTimeOff': {
      const t = await getEntityById(env, 'TimeOffRequest', p.id);
      if (!t) return { success: false, error: 'Request not found.' };
      if (t.status !== 'pending') return { success: false, error: `This request is already ${t.status}.` };
      const approve = p.approve === true;
      const note = String(p.note || '').trim().slice(0, 300);
      const res = await env.DB.prepare(
        `UPDATE entities SET data = json_set(data, '$.status', ?, '$.decided_by', ?, '$.decided_at', ?, '$.decision_note', ?), updated_date = ?
         WHERE id = ? AND entity_type = 'TimeOffRequest' AND json_extract(data,'$.status') = 'pending'`
      ).bind(approve ? 'approved' : 'declined', user.id, nowISO(), note, nowISO(), t.id).run();
      if (!res?.meta?.changes) return { success: false, error: 'This request just changed. Refresh and try again.' };
      const when = t.start_date === t.end_date ? boardWeekLabel(t.start_date) : `${boardWeekLabel(t.start_date)}–${boardWeekLabel(t.end_date)}`;
      await boardNotify(env, [t.user_id], {
        title: approve ? 'Time off approved' : 'Time off declined',
        message: `Your time off for ${when} was ${approve ? 'approved' : 'declined'}.${note ? ` Note: ${note}` : ''}`,
      }, user.email);
      await audit(env, { actor: user.email, action: 'update', target: 'TimeOffRequest', targetId: t.id, detail: `${approve ? 'approved' : 'declined'} time off for ${t.user_name || t.user_id} ${t.start_date}..${t.end_date}`, request: null });
      return { success: true, request: await getEntityById(env, 'TimeOffRequest', t.id) };
    }

    default:
      return { success: false, error: 'Unknown function.' };
  }
}
// ===== end Scheduling: BOARD =====

// ===== Scheduling: REMIND =====
// Coach reminders, schedule-change notices and the phone calendar feed.
//
// Reminder settings live on the staff user's own record:
//   users.data.schedule_reminders = { shifts, classes, pt }  (minutes before, or null = off)
// Defaults 60 / 60 / 30. The 15-minute cron (cron/program-tick) runs
// runScheduleReminders; each reminder is claimed once in app_state
// (key sremind_<kind>_<id>_<start ms>), so overlapping runs never repeat one and
// a moved shift/class gets a fresh reminder for its new time.
//
// Calendar feed: GET /api/calendar/<token>.ics, no sign-in. The token is the
// only auth: 32 random chars (feed id, 192 bits) + 32 chars of HMAC(AUTH_SECRET)
// over the id. app_state holds calfeed_id_<feed id> -> user id and
// calfeed_user_<user id> -> feed id, so a database copy alone can't build a
// working link, and reset deletes the old id (old link stops at once). The token
// is never written to logs, audit rows or error reports.


const SCHED_REMINDER_CHOICES = [15, 30, 60, 120, 180, 1440];
const SCHED_REMINDER_DEFAULTS = { shifts: 60, classes: 60, pt: 30 };
const SCHED_REMINDER_KINDS = ['shifts', 'classes', 'pt'];
const SCHED_FEED_PAST_DAYS = 14;
const SCHED_FEED_FUTURE_DAYS = 60;
const SCHED_PT_LABELS = { personal_training: 'PT', assessment: 'Assessment', video_call: 'Video call', group_class: 'Group session' };

function schedReminderPrefs(userData) {
  const saved = (userData && typeof userData === 'object' && userData.schedule_reminders) || {};
  const out = {};
  for (const k of SCHED_REMINDER_KINDS) {
    if (!(k in saved)) out[k] = SCHED_REMINDER_DEFAULTS[k];
    else out[k] = saved[k] === null ? null : (SCHED_REMINDER_CHOICES.includes(Number(saved[k])) ? Number(saved[k]) : SCHED_REMINDER_DEFAULTS[k]);
  }
  return out;
}

async function schedUserData(env, userId) {
  const row = await env.DB.prepare('SELECT data FROM users WHERE id = ?').bind(userId).first();
  if (!row) return null;
  try { return JSON.parse(row.data || '{}'); } catch { return {}; }
}

// In-app notification + push to each user. BOARD calls it on publish/decide,
// CORE may call it for time-off requests. Never throws; returns how many got one.
async function notifyScheduleChange(env, userIds, { title, message, link = '/MySchedule', tag, createdBy = null } = {}) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter((x) => typeof x === 'string' && x))];
  const t = String(title || 'Schedule update').slice(0, 80);
  const m = String(message || '').slice(0, 500);
  let n = 0;
  for (const id of ids) {
    try {
      await insertEntity(env, 'Notification', { user_id: id, type: 'schedule', title: t, message: m, link, read: false }, createdBy);
      const p = sendPushToUser(env, id, { title: t, body: m.slice(0, 140), url: link, tag: tag || 'schedule' });
      if (env.__waitUntil) env.__waitUntil(p); else await p;
      n++;
    } catch (e) {
      console.error('schedule notice failed', e?.message);
    }
  }
  return n;
}

const schedClock = (hm) => {
  const mins = hmToMin(hm);
  if (mins === null) return '';
  const h = Math.floor(mins / 60) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mins % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const schedWhen = (date, hm, today) => {
  const day = date === today ? 'today' : date === pAddDays(today, 1) ? 'tomorrow'
    : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} at ${schedClock(hm)}`;
};
// "HH:MM" of an instant on the gym's wall clock.
const schedGymHm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: PROGRAM_TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const schedFirstName = (name) => String(name || '').trim().split(/\s+/)[0].slice(0, 40);

// First names only for PT clients: Session.client_name, else the Client record
// (or member login) its client_id points at.
async function schedClientFirstNames(env, sessions) {
  const out = new Map();
  const need = [...new Set(sessions.filter((s) => !s.client_name && s.client_id).map((s) => s.client_id))];
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    const { results: cs } = await env.DB.prepare(
      `SELECT id, json_extract(data,'$.full_name') AS n FROM entities WHERE entity_type='Client' AND id IN (${inList(chunk)})`
    ).bind(...chunk).all();
    for (const c of cs) out.set(c.id, c.n);
    const left = chunk.filter((id) => !out.has(id));
    if (left.length) {
      const { results: us } = await env.DB.prepare(`SELECT id, full_name AS n FROM users WHERE id IN (${inList(left)})`).bind(...left).all();
      for (const u of us) out.set(u.id, u.n);
    }
  }
  return (s) => schedFirstName(s.client_name || out.get(s.client_id) || '');
}

const schedPtTitle = (s, first) => {
  const label = SCHED_PT_LABELS[s.type] || 'PT';
  return first ? `${label}: ${first}` : `${label} session`;
};
const schedPtMinutes = (s) => {
  const n = Number(s.duration_min ?? s.duration);
  return Number.isFinite(n) && n > 0 && n <= 600 ? n : 60;
};
const schedSpan = (date, start, end) => {
  const a = easternToUTC(date, start);
  let b = hmToMin(end) !== null ? easternToUTC(date, end) : a + 3600000;
  if (b <= a) b += 864e5;
  return [a, b];
};

/* ---- reminders (run by the 15-minute cron) ---- */
async function runScheduleReminders(env, nowMs = Date.now()) {
  const summary = { success: true, sent: 0 };
  const today = programToday(nowMs);
  const lastDay = pAddDays(today, 2);
  const horizonMs = nowMs + Math.max(...SCHED_REMINDER_CHOICES) * 60000;
  const items = [];
  for (const s of await selectEntities(env, 'StaffShift',
    `json_extract(data,'$.status') = 'published' AND json_extract(data,'$.date') BETWEEN ? AND ?`, [today, lastDay])) {
    if (!s.user_id || hmToMin(s.start) === null) continue;
    items.push({ kind: 'shifts', id: s.id, userId: s.user_id, start: easternToUTC(s.date, s.start), date: s.date, hm: s.start,
      title: 'Shift reminder', what: `${s.role_label || 'Your'} shift` });
  }
  for (const c of await selectEntities(env, 'ClassSession',
    `json_extract(data,'$.status') = 'scheduled' AND json_extract(data,'$.coach_user_id') IS NOT NULL
     AND json_extract(data,'$.start_at') > ? AND json_extract(data,'$.start_at') <= ?`,
    [new Date(nowMs).toISOString(), new Date(horizonMs).toISOString()])) {
    const start = Date.parse(c.start_at);
    if (!Number.isFinite(start)) continue;
    items.push({ kind: 'classes', id: c.id, userId: c.coach_user_id, start, date: programToday(start), hm: schedGymHm(start),
      title: 'Coaching reminder', what: `You coach ${c.class_type_name || 'a class'}` });
  }
  const pts = (await selectEntities(env, 'Session',
    `json_extract(data,'$.trainer_id') IS NOT NULL AND json_extract(data,'$.date') BETWEEN ? AND ?
     AND COALESCE(json_extract(data,'$.status'),'scheduled') NOT IN ('cancelled','completed','no_show')`, [today, lastDay]))
    .filter((s) => hmToMin(s.start_time) !== null);
  const firstOf = await schedClientFirstNames(env, pts);
  for (const s of pts) {
    const first = firstOf(s);
    items.push({ kind: 'pt', id: s.id, userId: s.trainer_id, start: easternToUTC(s.date, s.start_time), date: s.date, hm: s.start_time,
      title: 'PT reminder', what: first ? `${SCHED_PT_LABELS[s.type] || 'PT'} with ${first}` : `${SCHED_PT_LABELS[s.type] || 'PT'} session` });
  }

  const people = new Map();
  const personOf = async (id) => {
    if (!people.has(id)) {
      const u = await staffLogin(env, id);
      people.set(id, u && !u.disabled ? { prefs: schedReminderPrefs(u) } : null);
    }
    return people.get(id);
  };
  const nowIso = new Date(nowMs).toISOString();
  for (const it of items) {
    if (!(it.start > nowMs)) continue;
    const who = await personOf(it.userId);
    const mins = who?.prefs?.[it.kind];
    if (!who || mins === null || mins === undefined) continue;
    if (nowMs < it.start - mins * 60000) continue; // not yet
    const claim = await env.DB.prepare('INSERT OR IGNORE INTO app_state (key, value, updated_date) VALUES (?,?,?)')
      .bind(`sremind_${it.kind}_${it.id}_${it.start}`, '1', nowIso).run();
    if (!claim?.meta?.changes) continue; // already sent
    const n = await notifyScheduleChange(env, [it.userId], {
      title: it.title, message: `${it.what} ${schedWhen(it.date, it.hm, today)}.`, tag: `sremind-${it.kind}-${it.id}`,
    });
    summary.sent += n;
  }
  await env.DB.prepare(`DELETE FROM app_state WHERE key LIKE 'sremind\\_%' ESCAPE '\\' AND updated_date < ?`)
    .bind(new Date(nowMs - 4 * 864e5).toISOString()).run();
  return summary;
}

/* ---- calendar feed ---- */
const SCHED_FEED_ID_LEN = 32;
async function schedFeedMac(env, feedId) {
  const key = await hmacKey(env.AUTH_SECRET || 'dev-insecure-secret');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`calfeed:${feedId}`));
  return b64uEncode(sig).slice(0, 32);
}
async function schedFeedUrl(env, url, feedId) {
  const httpUrl = `${appOrigin(env, url)}/api/calendar/${feedId}${await schedFeedMac(env, feedId)}.ics`;
  return { url: httpUrl, webcal_url: httpUrl.replace(/^https?:/, 'webcal:') };
}
async function schedNewFeed(env, userId) {
  const feedId = b64uEncode(crypto.getRandomValues(new Uint8Array(24)));
  const now = nowISO();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO app_state (key, value, updated_date) VALUES (?,?,?)').bind(`calfeed_id_${feedId}`, userId, now),
    env.DB.prepare('INSERT INTO app_state (key, value, updated_date) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_date = ?3')
      .bind(`calfeed_user_${userId}`, feedId, now),
  ]);
  return feedId;
}
// The user id a token belongs to, or null. Constant-time MAC check.
async function schedFeedUser(env, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(token)) return null;
  const feedId = token.slice(0, SCHED_FEED_ID_LEN);
  const want = await schedFeedMac(env, feedId);
  const given = token.slice(SCHED_FEED_ID_LEN);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  if (diff !== 0) return null;
  const row = await getState(env, `calfeed_id_${feedId}`);
  if (!row?.value) return null;
  const current = await getState(env, `calfeed_user_${row.value}`);
  return current?.value === feedId ? row.value : null;
}

// Per-IP counter, one bucket per 10 minutes. bump=false only reads.
async function schedFeedLimited(env, request, bucket, max, bump = true) {
  const ip = request?.headers?.get('cf-connecting-ip') || 'local';
  const key = `rl_calfeed_${bucket}_${ip}_${Math.floor(Date.now() / 600000)}`;
  let n;
  if (bump) {
    const row = await env.DB.prepare(
      `INSERT INTO app_state (key, value, updated_date) VALUES (?1,'1',?2)
       ON CONFLICT(key) DO UPDATE SET value = CAST(app_state.value AS INTEGER) + 1, updated_date = ?2 RETURNING value`
    ).bind(key, nowISO()).first();
    n = Number(row?.value || 0);
    if (Math.random() < 0.05) {
      await env.DB.prepare(`DELETE FROM app_state WHERE key LIKE 'rl\\_calfeed\\_%' ESCAPE '\\' AND updated_date < ?`)
        .bind(new Date(Date.now() - 3600000).toISOString()).run();
    }
  } else {
    n = Number((await getState(env, key))?.value || 0);
  }
  return n > max;
}

// iCalendar text helpers (RFC 5545).
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDate = (key) => String(key).replace(/-/g, '');
// Fold to 75 octets per line without splitting a UTF-8 character.
function icsFold(line) {
  const bytes = utf8(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  let curLen = 0;
  let limit = 75;
  for (const ch of line) {
    const len = utf8(ch).length;
    if (curLen + len > limit) { out.push(cur); cur = ''; curLen = 0; limit = 74; }
    cur += ch; curLen += len;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// The user's items for the feed: published shifts, scheduled classes they
// coach, their PT sessions (client first name only) and approved time off.
async function schedFeedEvents(env, userId, nowMs = Date.now()) {
  const today = programToday(nowMs);
  const from = pAddDays(today, -SCHED_FEED_PAST_DAYS);
  const to = pAddDays(today, SCHED_FEED_FUTURE_DAYS);
  const stamp = (row) => icsUtc(Date.parse(row.updated_date || '') || nowMs);
  const events = [];
  for (const s of await selectEntities(env, 'StaffShift',
    `json_extract(data,'$.user_id') = ? AND json_extract(data,'$.status') = 'published' AND json_extract(data,'$.date') BETWEEN ? AND ?`, [userId, from, to])) {
    if (!isDateKey(s.date) || hmToMin(s.start) === null) continue;
    const [a, b] = schedSpan(s.date, s.start, s.end);
    events.push({ uid: `shift-${s.id}`, stamp: stamp(s), start: a, end: b, summary: `${s.role_label || 'Shift'} shift` });
  }
  for (const c of await selectEntities(env, 'ClassSession',
    `json_extract(data,'$.coach_user_id') = ? AND json_extract(data,'$.status') = 'scheduled' AND json_extract(data,'$.date') BETWEEN ? AND ?`, [userId, from, to])) {
    const a = Date.parse(c.start_at);
    if (!Number.isFinite(a)) continue;
    const b = Date.parse(c.end_at || '') || a + (Number(c.duration_min) || 60) * 60000;
    events.push({ uid: `class-${c.id}`, stamp: stamp(c), start: a, end: b > a ? b : a + 3600000, summary: `Coach: ${c.class_type_name || 'Class'}` });
  }
  const pts = (await selectEntities(env, 'Session',
    `json_extract(data,'$.trainer_id') = ? AND json_extract(data,'$.date') BETWEEN ? AND ? AND COALESCE(json_extract(data,'$.status'),'scheduled') != 'cancelled'`,
    [userId, from, to])).filter((s) => isDateKey(s.date) && hmToMin(s.start_time) !== null);
  const firstOf = await schedClientFirstNames(env, pts);
  for (const s of pts) {
    const a = easternToUTC(s.date, s.start_time);
    events.push({ uid: `pt-${s.id}`, stamp: stamp(s), start: a, end: a + schedPtMinutes(s) * 60000, summary: schedPtTitle(s, firstOf(s)) });
  }
  for (const t of await selectEntities(env, 'TimeOffRequest',
    `json_extract(data,'$.user_id') = ? AND json_extract(data,'$.status') = 'approved'
     AND json_extract(data,'$.start_date') <= ? AND json_extract(data,'$.end_date') >= ?`, [userId, to, from])) {
    if (!isDateKey(t.start_date) || !isDateKey(t.end_date)) continue;
    const ev = { uid: `timeoff-${t.id}`, stamp: stamp(t), summary: 'Time off', transparent: false };
    if (t.part_day && t.start_date === t.end_date && hmToMin(t.part_day.start) !== null) {
      [ev.start, ev.end] = schedSpan(t.start_date, t.part_day.start, t.part_day.end);
    } else {
      ev.allDay = [t.start_date, pAddDays(t.end_date, 1)];
    }
    events.push(ev);
  }
  return events.sort((x, y) => (x.start ?? keyToUTC(x.allDay[0])) - (y.start ?? keyToUTC(y.allDay[0])));
}

function schedBuildIcs(events, nowMs = Date.now()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brigade Athletic Club//Coach schedule//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:Brigade schedule', `X-WR-TIMEZONE:${PROGRAM_TZ}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@brigade-schedule`, `DTSTAMP:${e.stamp || icsUtc(nowMs)}`);
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${icsDate(e.allDay[0])}`, `DTEND;VALUE=DATE:${icsDate(e.allDay[1])}`);
    else lines.push(`DTSTART:${icsUtc(e.start)}`, `DTEND:${icsUtc(e.end)}`);
    lines.push(`SUMMARY:${icsText(e.summary)}`, 'STATUS:CONFIRMED', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

// GET /api/calendar/<token>.ics. Errors are caught here so the token (part of
// the path) never reaches the error log.
async function serveCalendarFeed(env, request, file) {
  const plain = (status, text) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  try {
    if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) return plain(405, 'Method not allowed.');
    if (await schedFeedLimited(env, request, 'bad', 30, false)) return plain(429, 'Too many requests.');
    if (await schedFeedLimited(env, request, 'all', 600)) return plain(429, 'Too many requests.');
    const m = /^([A-Za-z0-9_-]+)\.ics$/.exec(String(file || ''));
    const userId = m ? await schedFeedUser(env, m[1]) : null;
    const person = userId ? await staffLogin(env, userId) : null;
    if (!person || person.disabled) {
      await schedFeedLimited(env, request, 'bad', 30);
      return plain(404, 'Calendar not found.');
    }
    const body = schedBuildIcs(await schedFeedEvents(env, userId));
    return new Response(request.method.toUpperCase() === 'HEAD' ? null : body, {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'inline; filename="brigade-schedule.ics"',
        'cache-control': 'private, max-age=300',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (e) {
    await recordError(env, { source: 'server', message: e?.message, page: '/api/calendar' }).catch(() => {});
    return plain(500, 'Calendar is not available right now.');
  }
}

async function runScheduleRemindFunction(name, payload, { env, user, url, request }) {
  if (!isStaff(user)) return NO_PERMISSION;
  switch (name) {
    case 'getReminderPrefs':
      return { success: true, prefs: schedReminderPrefs(await schedUserData(env, user.id)), choices: SCHED_REMINDER_CHOICES, defaults: SCHED_REMINDER_DEFAULTS };

    case 'saveReminderPrefs': {
      const data = (await schedUserData(env, user.id)) || {};
      const next = schedReminderPrefs(data);
      for (const k of SCHED_REMINDER_KINDS) {
        if (!(k in (payload || {}))) continue;
        const v = payload[k];
        if (v === null || v === false) next[k] = null;
        else if (SCHED_REMINDER_CHOICES.includes(Number(v))) next[k] = Number(v);
        else return { success: false, error: 'Pick one of the reminder times in the list.', code: 'bad_minutes' };
      }
      data.schedule_reminders = next;
      await env.DB.prepare('UPDATE users SET data = ?, updated_date = ? WHERE id = ?').bind(JSON.stringify(data), nowISO(), user.id).run();
      return { success: true, prefs: next };
    }

    case 'calendarFeedLink': {
      let feedId = (await getState(env, `calfeed_user_${user.id}`))?.value;
      if (!feedId || !(await getState(env, `calfeed_id_${feedId}`))) feedId = await schedNewFeed(env, user.id);
      return { success: true, ...(await schedFeedUrl(env, url, feedId)) };
    }

    case 'resetCalendarFeed': {
      const old = (await getState(env, `calfeed_user_${user.id}`))?.value;
      if (old) await env.DB.prepare('DELETE FROM app_state WHERE key = ?').bind(`calfeed_id_${old}`).run();
      const feedId = await schedNewFeed(env, user.id);
      await audit(env, { actor: user.email, action: 'calendar_feed_reset', target: 'User', targetId: user.id, detail: 'old calendar link turned off', request });
      return { success: true, ...(await schedFeedUrl(env, url, feedId)) };
    }

    default:
      return { success: false, error: 'Unknown schedule function.' };
  }
}
// ===== end Scheduling: REMIND =====

const PUBLIC_FUNCTIONS = new Set(['getAppLogo', 'submitContact',
  'publicPlans', 'publicCheckout', // Phase 4: SALES
]);

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
      return { success: true, cron_last_ok: beat?.updated_date || null, cron_minutes_ago: mins, cron_ok: mins !== null && mins <= CRON_STALE_MINUTES, email_enabled: emailReady(env), errors: results };
    }

    case 'sendTestEmail': {
      if (!user || user.role !== 'admin') return { success: false, error: 'Admins only.' };
      const since = new Date(Date.now() - 3600000).toISOString();
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE actor = ? AND action = 'test_email' AND created_date > ?`).bind(user.email, since).first();
      if ((n?.n || 0) >= 10) return { success: false, error: 'Too many test emails. Try again in an hour.' };
      await audit(env, { actor: user.email, action: 'test_email', request: null });
      const sent = await sendEmail(env, { to: user.email, subject: 'Test email from the Brigade app', html: emailShell('Email is working', '<p>This is a test. Invites and password resets will arrive like this one.</p>') });
      return sent.success ? { success: true, to: user.email } : sent;
    }

    case 'listTeam': {
      if (!user || user.role !== 'admin') return { success: false, error: 'Only an admin can see the team.' };
      const { results } = await env.DB.prepare(`SELECT * FROM users WHERE user_type = 'trainer' ORDER BY full_name`).all();
      const roles = await loadRoles(env);
      const pending = await env.DB.prepare(
        `SELECT email, full_name, expires_date FROM account_tokens WHERE kind = 'invite' AND user_type = 'trainer' AND used_date IS NULL AND expires_date > ? ORDER BY created_date DESC`
      ).bind(nowISO()).all();
      return {
        success: true, email_enabled: emailReady(env),
        team: results.map(userRow).map((u) => {
          const isAdmin = resolveRole(env, u.email, u.role) === 'admin';
          return { id: u.id, email: u.email, full_name: u.full_name, disabled: !!u.disabled, is_admin: isAdmin, staff_role: isAdmin ? 'admin' : (roles[u.staff_role] ? u.staff_role : 'coach'), is_me: u.id === user.id };
        }),
        roles: Object.entries(roles).map(([key, r]) => ({ key, name: r.name })),
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

    // Admin only: give a staff account one of the roles.
    case 'setStaffRole': {
      if (!can(user, 'staff.manage')) return { success: false, error: 'Only an admin can change roles.' };
      const roles = await loadRoles(env);
      const role = String(payload?.role || '');
      if (!roles[role]) return { success: false, error: 'Pick one of the roles.' };
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload?.user_id || '').first();
      if (!row || row.user_type !== 'trainer') return { success: false, error: 'Staff account not found.' };
      if (resolveRole(env, row.email, row.role) === 'admin') return { success: false, error: 'Admins already have every right.' };
      const data = JSON.parse(row.data || '{}');
      const before = roles[data.staff_role] ? data.staff_role : 'coach';
      if (before === role) return { success: true, role };
      data.staff_role = role;
      await env.DB.prepare('UPDATE users SET data = ?, updated_date = ? WHERE id = ?').bind(JSON.stringify(data), nowISO(), row.id).run();
      await audit(env, { actor: user.email, action: 'role_changed', target: 'Account', targetId: row.id, detail: `${before} -> ${role}`, request: null });
      return { success: true, role };
    }

    // Admin only: the roles, the rights each one has, and how many staff hold it.
    case 'listRoles': {
      if (!can(user, 'staff.manage')) return { success: false, error: 'Only an admin can see roles.' };
      const roles = await loadRoles(env);
      const { results } = await env.DB.prepare(`SELECT email, role, data FROM users WHERE user_type = 'trainer'`).all();
      const counts = {};
      for (const r of results) {
        if (resolveRole(env, r.email, r.role) === 'admin') continue;
        let d = {}; try { d = JSON.parse(r.data || '{}'); } catch { /* skip */ }
        const k = roles[d.staff_role] ? d.staff_role : 'coach';
        counts[k] = (counts[k] || 0) + 1;
      }
      return { success: true, rights: RIGHTS, roles: Object.entries(roles).map(([key, r]) => ({ key, ...r, people: counts[key] || 0 })) };
    }

    // Admin only: create a role or change its name and rights.
    case 'saveRole': {
      if (!can(user, 'staff.manage')) return { success: false, error: 'Only an admin can change roles.' };
      const roles = await loadRoles(env);
      const name = String(payload?.name || '').trim().slice(0, 40);
      if (!name) return { success: false, error: 'Give the role a name.' };
      const rights = [...new Set((Array.isArray(payload?.rights) ? payload.rights : []).map(String))];
      const bad = rights.filter((r) => !RIGHT_KEYS.has(r));
      if (bad.length) return { success: false, error: 'Some of those rights can\'t be given to a role.' };
      let key = String(payload?.key || '');
      const isNew = !key;
      if (isNew) {
        key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'role';
        if (roles[key]) key = `${key}_${Math.random().toString(36).slice(2, 6)}`;
      } else if (!roles[key]) return { success: false, error: 'Role not found.' };
      if (Object.values(roles).some((r, i) => Object.keys(roles)[i] !== key && r.name.toLowerCase() === name.toLowerCase())) {
        return { success: false, error: 'Another role already has that name.' };
      }
      const before = roles[key] ? roles[key].rights.join(',') : '';
      roles[key] = { name, builtin: !!DEFAULT_ROLES[key], rights };
      const store = Object.fromEntries(Object.entries(roles).map(([k, r]) => [k, { name: r.name, rights: r.rights }]));
      await setState(env, 'staff_roles', JSON.stringify(store));
      await audit(env, { actor: user.email, action: isNew ? 'role_created' : 'role_updated', target: 'Role', targetId: key, detail: `${name}: ${before} -> ${rights.join(',')}`, request: null });
      return { success: true, key };
    }

    // Admin only: remove a role nobody holds. Coach and Manager stay.
    case 'deleteRole': {
      if (!can(user, 'staff.manage')) return { success: false, error: 'Only an admin can change roles.' };
      const roles = await loadRoles(env);
      const key = String(payload?.key || '');
      if (!roles[key]) return { success: false, error: 'Role not found.' };
      if (DEFAULT_ROLES[key]) return { success: false, error: 'Coach and Manager can be changed but not removed.' };
      const inUse = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE user_type = 'trainer' AND json_extract(data,'$.staff_role') = ?`).bind(key).first();
      if (inUse?.n) return { success: false, error: `${inUse.n} staff member${inUse.n === 1 ? ' has' : 's have'} this role. Give them another role first.` };
      delete roles[key];
      const store = Object.fromEntries(Object.entries(roles).map(([k, r]) => [k, { name: r.name, rights: r.rights }]));
      await setState(env, 'staff_roles', JSON.stringify(store));
      await audit(env, { actor: user.email, action: 'role_deleted', target: 'Role', targetId: key, request: null });
      return { success: true };
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
      const date = payload?.date || programToday();

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
      const today = programToday();

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
      const since = pAddDays(programToday(), -7);
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
        // A guardian can view the schedule as one of their linked children.
        let who;
        if (payload?.client_id) {
          who = await resolveClassClient(env, user, payload.client_id);
          if (who.error) return { success: false, error: who.error, code: 'no_client' };
        } else {
          const cids = await myClientIds(env, user);
          who = { clientIds: cids.length ? cids : ['__none__'], loginId: user.id };
        }
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
      const dayChanges = [...(await loadDayChanges(env, from, to)).values()]
        .map((c) => ({ id: c.id, date: c.date, mode: c.mode, reason: c.reason || '', use_day_of_week: c.use_day_of_week ?? null, shift_minutes: c.shift_minutes ?? null, label: dayChangeLabel(c) }))
        .sort((a, b) => a.date.localeCompare(b.date));
      return { success: true, from, to, today, now: nowISO(), settings: s, sessions: out, day_changes: dayChanges };
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

    // Membership holds and end dates (staff only). Holds block booking on
    // those days, cancel bookings already made then, and push a set end date
    // back by the hold length so the member doesn't lose paid days.
    case 'holdMembership':
    case 'endMembershipHold':
    case 'cancelMembershipHold':
    case 'setMembershipEndDate': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can change memberships.' };
      if (!can(user, 'members.manage')) return NO_PERMISSION;
      const today = programToday();
      let m = await getEntityById(env, 'Membership', payload?.membership_id);
      if (!m) return { success: false, error: 'Membership not found.' };
      const holds = Array.isArray(m.holds) ? m.holds.map((h) => ({ ...h })) : [];
      const patch = {};
      let detail = '';
      let release = null; // [from, to, reason]

      if (name === 'holdMembership') {
        const from = payload?.from; const to = payload?.to;
        const reason = String(payload?.reason || '').trim().slice(0, 200);
        if (!isDateKey(from) || !isDateKey(to)) return { success: false, error: 'Pick a start and end date for the hold.' };
        if (to < from) return { success: false, error: 'The hold ends before it starts.' };
        if (pDaysBetween(from, to) >= 366) return { success: false, error: 'A hold can be one year at most.' };
        if (to < today) return { success: false, error: 'That hold is already over. Pick dates from today on.' };
        if (!reason) return { success: false, error: 'Add a reason for the hold.' };
        if (m.status === 'ended') return { success: false, error: 'This membership has ended.' };
        if (isDateKey(m.start_date) && from < m.start_date) return { success: false, error: 'The hold starts before the membership does.' };
        if (isDateKey(m.end_date) && from > m.end_date) return { success: false, error: `The membership ends ${shortDay(m.end_date, today)}, before this hold starts.` };
        // Older single hold: fold it into the list first.
        if (m.status === 'on_hold' || isDateKey(m.hold_from)) {
          if (!isDateKey(m.hold_to)) return { success: false, error: 'Resume the current hold first.' };
          holds.push({ id: uid(), from: m.hold_from, to: m.hold_to, planned_to: m.hold_to, reason: '', status: 'active', extend_days: 0, legacy: true });
          Object.assign(patch, { status: 'active', hold_from: null, hold_to: null });
        }
        const clash = holds.find((h) => h.status !== 'cancelled' && isDateKey(h.from) && isDateKey(h.to) && h.from <= to && from <= h.to);
        if (clash) return { success: false, error: `This overlaps another hold (${shortDay(clash.from, today)} to ${shortDay(clash.to, today)}).` };
        const days = pDaysBetween(from, to) + 1;
        const extend = payload?.extend_end_date !== false && isDateKey(m.end_date);
        if (extend) patch.end_date = pAddDays(m.end_date, days);
        holds.push({
          id: uid(), from, to, planned_to: to, reason, status: 'active', extend_days: extend ? days : 0,
          created_by: user.email, created_at: nowISO(),
        });
        detail = `hold ${from} to ${to}: ${reason}`;
        release = [from, to, 'Membership on hold'];
      } else if (name === 'endMembershipHold' || name === 'cancelMembershipHold') {
        const h = holds.find((x) => x.id === payload?.hold_id);
        if (!h || h.status === 'cancelled') return { success: false, error: 'Hold not found.' };
        const cancel = name === 'cancelMembershipHold' || h.from >= today;
        let giveBack = 0;
        if (cancel) {
          giveBack = numOr(h.extend_days, 0);
          Object.assign(h, { status: 'cancelled', cancelled_at: nowISO(), cancelled_by: user.email, extend_days: 0 });
          detail = `hold ${h.from} to ${h.to} cancelled`;
        } else {
          if (h.to < today) return { success: false, error: 'This hold is already over.' };
          const newTo = pAddDays(today, -1);
          giveBack = Math.min(numOr(h.extend_days, 0), pDaysBetween(newTo, h.to));
          Object.assign(h, { to: newTo, ended_early_at: nowISO(), ended_by: user.email, extend_days: numOr(h.extend_days, 0) - giveBack });
          detail = `hold ${h.from} to ${h.planned_to || h.to} ended early, last day ${newTo}`;
        }
        if (giveBack > 0 && isDateKey(m.end_date)) patch.end_date = pAddDays(m.end_date, -giveBack);
      } else {
        const end = payload?.end_date === null || payload?.end_date === '' ? null : payload?.end_date;
        if (end !== null && !isDateKey(end)) return { success: false, error: 'Pick an end date.' };
        if (end && isDateKey(m.start_date) && end < m.start_date) return { success: false, error: 'The end date is before the membership starts.' };
        patch.end_date = end;
        patch.end_reason = String(payload?.reason || '').trim().slice(0, 200) || null;
        patch.end_set_by = user.email;
        patch.end_set_at = nowISO();
        if (m.status === 'ended' && (end === null || end >= today)) patch.status = 'active';
        detail = end ? `end date ${end}${patch.end_reason ? `: ${patch.end_reason}` : ''}` : 'end date removed';
        if (end) release = [pAddDays(end, 1), null, 'Membership ended'];
      }

      if (!(await patchMembershipIf(env, m, { ...patch, holds }))) {
        return { success: false, error: 'This membership just changed. Refresh and try again.', code: 'retry' };
      }
      m = await getEntityById(env, 'Membership', m.id);
      if (name !== 'setMembershipEndDate') m = await rulesAfterHoldChange(env, m, user); // Phase 4: RULES
      const cancelled = release ? await releaseMembershipBookings(env, m, release[0], release[1], release[2], user) : 0;
      if (cancelled) {
        await notifyClassMember(env, {
          loginId: m.client_user_id, createdBy: user.email,
          title: name === 'holdMembership' ? 'Membership on hold' : 'Membership end date',
          message: name === 'holdMembership'
            ? `Your membership is on hold ${shortDay(release[0], today)} to ${shortDay(release[1], today)}. We cancelled ${cancelled} class${cancelled === 1 ? '' : 'es'} you had booked then.`
            : `Your membership ends ${shortDay(m.end_date, today)}. We cancelled ${cancelled} class${cancelled === 1 ? '' : 'es'} you had booked after that.`,
        });
      }
      await audit(env, { actor: user.email, action: name, target: 'Membership', targetId: m.id, detail: `${detail}${cancelled ? `; ${cancelled} bookings cancelled` : ''}`, request: null });
      return { success: true, membership: m, cancelled_bookings: cancelled };
    }

    case 'myClasses': {
      if (!user) return { success: false, error: 'Not logged in' };
      const s = await getGymSettings(env);
      // payload.client_id: a guardian viewing a linked child (checked in resolveClassClient).
      const who = await resolveClassClient(env, isStaff(user) ? { ...user, role: 'user', user_type: 'client' } : user, payload?.client_id || null);
      if (who.error && payload?.client_id) return { success: false, error: who.error, code: 'no_client' };
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

    // The signed-in member and the children they can book for.
    case 'myFamily': {
      if (!user) return { success: false, error: 'Not logged in' };
      const own = await myClientIds(env, user);
      const kids = await guardedChildren(env, own);
      return { success: true, children: kids.map((c) => ({ id: c.id, full_name: c.full_name || 'Child' })) };
    }

    // Staff: who a client's guardians are, and who they are guardian of.
    case 'clientFamily': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can see this.' };
      const client = await getEntityById(env, 'Client', payload?.client_id);
      if (!client) return { success: false, error: 'Client not found.' };
      const guardians = await clientGuardians(env, client.id);
      const children = await guardedChildren(env, [client.id]);
      return {
        success: true,
        guardians: await Promise.all(guardians.map((g) => familyPerson(env, g))),
        children: await Promise.all(children.map((c) => familyPerson(env, c))),
      };
    }

    case 'linkGuardian':
    case 'unlinkGuardian': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can change guardians.' };
      if (!can(user, 'guardians.manage')) return NO_PERMISSION;
      const child = await getEntityById(env, 'Client', payload?.client_id);
      const guardian = await getEntityById(env, 'Client', payload?.guardian_client_id);
      if (!child || !guardian) return { success: false, error: 'Client not found.' };
      const ts = nowISO();
      if (name === 'unlinkGuardian') {
        const r = await env.DB.prepare(
          'UPDATE client_guardians SET removed_by = ?, removed_date = ? WHERE client_id = ? AND guardian_client_id = ? AND removed_date IS NULL'
        ).bind(user.email, ts, child.id, guardian.id).run();
        if (!r?.meta?.changes) return { success: false, error: 'This person is not a guardian of this client.' };
        await audit(env, { actor: user.email, action: 'guardian_unlinked', target: 'Client', targetId: child.id, detail: `guardian ${guardian.id}`, request: null });
        return { success: true };
      }
      if (child.id === guardian.id) return { success: false, error: 'A client cannot be their own guardian.' };
      if (!guardian.email) return { success: false, error: 'The guardian needs an email address so they can sign in.' };
      if (String(guardian.email).toLowerCase() === String(child.email || '').toLowerCase()) {
        return { success: false, error: 'This child uses the same email as the guardian. Remove the email from the child first.' };
      }
      if ((await guardedChildren(env, [child.id])).some((c) => c.id === guardian.id)) {
        return { success: false, error: 'This person is already this client\'s child.' };
      }
      const current = await clientGuardians(env, child.id);
      if (current.some((g) => g.id === guardian.id)) return { success: true, already: true };
      if (current.length >= MAX_GUARDIANS) return { success: false, error: `A client can have up to ${MAX_GUARDIANS} guardians.` };
      await env.DB.prepare(
        `INSERT INTO client_guardians (client_id, guardian_client_id, created_by, created_date) VALUES (?,?,?,?)
         ON CONFLICT (client_id, guardian_client_id) DO UPDATE SET created_by = excluded.created_by, created_date = excluded.created_date, removed_by = NULL, removed_date = NULL`
      ).bind(child.id, guardian.id, user.email, ts).run();
      await audit(env, { actor: user.email, action: 'guardian_linked', target: 'Client', targetId: child.id, detail: `guardian ${guardian.id}`, request: null });
      return { success: true };
    }

    case 'classReports': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can see reports.' };
      if (!can(user, 'reports.view')) return NO_PERMISSION;
      return classReports(env, payload || {});
    }

    case 'askBrigade': {
      if (!user) return { success: false, error: 'Not logged in' };
      return askBrigade(env, user, url, payload || {});
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
        if (!staff) return { success: false, error: who.guardianId ? `${shortName(who.client.full_name)} needs a signed waiver before booking. Ask the front desk.` : 'Sign the liability waiver before booking a class. You can find it under Documents.', code: 'waiver_required' };
        warnings.push('No signed waiver on file.');
      }
      { const bb = await gymBillingBookingBlock(env, who, staff); if (bb && !override) return bb; if (bb) warnings.push('Payment past due (staff override).'); } // Phase 4 CORE
      let reservation = null;
      for (let attempt = 0; attempt < 3 && !reservation; attempt++) {
        const pick = await findClassMembership(env, who, session, s);
        if (!pick.membership && !override) {
          return { success: false, error: staff ? (pick.staffReason || pick.reason.replace(/^You have/, 'This client has')) : pick.reason, code: pick.code, ...(staff ? { can_override: true } : {}) };
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
      await audit(env, { actor: user.email, action: 'create', target: 'Reservation', targetId: reservation.id, detail: who.guardianId ? `${reservation.status} (by guardian)` : reservation.status, request: null });
      const sessionNow = await getEntityById(env, 'ClassSession', session.id);
      await notifyBookingChange(env, { reservation, session: sessionNow || session, actor: user, kind: reservation.status === 'waitlisted' ? 'waitlisted' : 'reserved' });
      return { success: true, status: reservation.status, reservation, session: sessionNow, warnings };
    }

    case 'cancelReservation': {
      if (!user) return { success: false, error: 'Not logged in' };
      const staff = isStaff(user);
      const resv = await getEntityById(env, 'Reservation', payload?.reservation_id);
      if (!resv) return { success: false, error: 'Reservation not found.' };
      if (!staff) {
        // Their own reservations, or a linked child's (guardian).
        const cids = await actableClientIds(env, user);
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
      await notifyBookingChange(env, { reservation: resv, session, actor: user, kind: resv.status === 'waitlisted' ? 'left_waitlist' : 'cancelled', late });
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
        if (!staff) return { success: false, error: who.guardianId ? `${shortName(who.client.full_name)} needs a signed waiver before checking in. Ask the front desk.` : 'Sign the liability waiver before checking in. You can find it under Documents.', code: 'waiver_required' };
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
          return { success: false, error: staff ? (pick.staffReason || pick.reason.replace(/^You have/, 'This client has')) : pick.reason, code: pick.code, ...(staff ? { can_override: true } : {}) };
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

    case 'editClassSession': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can change a class.' };
      return editClassSession(env, user, payload);
    }

    case 'classDayChange': {
      if (!isStaff(user)) return { success: false, error: 'Only coaches can change the schedule.' };
      if (!can(user, 'schedule.manage')) return NO_PERMISSION;
      return classDayChange(env, user, payload);
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

    // ===== Phase 3: lifts (cases) =====
    case 'liftMovements': case 'liftHistory': case 'prList': case 'saveLiftEntry': case 'deleteLiftEntry': case 'checkPr':
      return runLiftsFunction(name, payload, ctx);
    // ===== end Phase 3: lifts (cases) =====
    // ===== Phase 3: editor (cases) =====
    case 'workoutLibrary':
    case 'listWorkouts':
    case 'saveWorkout':
    case 'deleteWorkout':
    case 'copyWorkouts':
    case 'todayWorkout':
      return workoutFunction(name, payload, user, env);
    // ===== end Phase 3: editor (cases) =====
    // ===== Phase 4: RULES (cases) =====
    case 'agreementText': case 'saveAgreementText': case 'signAgreement': case 'checkAgreement':
    case 'changePlan': case 'cancelMembership': case 'refundPayment': case 'compMembership':
    case 'upcomingRenewals': case 'memberBilling': case 'runBillingRules':
      return runRulesFunction(name, payload, ctx);
    // ===== end Phase 4: RULES (cases) =====
    // ===== Phase 4: SALES (cases) =====
    case 'publicPlans': case 'publicCheckout': case 'listPromoCodes': case 'savePromoCode': case 'archivePromoCode':
    case 'billingDashboard': case 'exportPaymentsCsv':
      return runSalesFunction(name, payload, ctx);
    // ===== end Phase 4: SALES (cases) =====
    // ===== Scheduling: BOARD (cases) =====
    case 'scheduleBoard': case 'saveShift': case 'deleteShift': case 'assignClassCoach': case 'copyScheduleWeek': case 'reassignPtSession':
    case 'publishSchedule': case 'timeOffInbox': case 'decideTimeOff':
      return runScheduleBoardFunction(name, payload, ctx);
    // ===== end Scheduling: BOARD (cases) =====
    // ===== Scheduling: REMIND (cases) =====
    case 'getReminderPrefs': case 'saveReminderPrefs': case 'calendarFeedLink': case 'resetCalendarFeed':
      return runScheduleRemindFunction(name, payload, ctx);
    // ===== end Scheduling: REMIND (cases) =====

    // Content browse helpers — empty until curated content sources are added.
    // Phase 3: MEMBER (scores, leaderboard, streak)
    case 'logScore':
    case 'deleteScore':
    case 'leaderboard':
    case 'myScores':
    case 'weeklyStreak':
      return runMemberScoreFunction(name, payload, ctx);

    case 'getCuratedRecipes':
    case 'searchResourceSources':
      return { results: [], items: [], recipes: [] };

    // ===== Scheduling: CORE (cases) =====
    case 'mySchedule': case 'myAvailability': case 'saveAvailability': case 'copyAvailabilityLastWeek':
    case 'timeOffImpact': case 'requestTimeOff': case 'cancelTimeOff': case 'myTimeOff':
      return runSchedCoreFunction(name, payload, ctx);
    // ===== end Scheduling: CORE (cases) =====

    // Phase 4 CORE: gym billing
    case 'billingStatus': case 'syncPlanToStripe': case 'startCheckout': case 'billingPortal': case 'myBilling':
      return runGymBillingFunction(name, payload, ctx);

    default:
      return { __unimplemented: true };
  }
}

// ===== Phase 3: MEMBER =====
// Scores members log against the day's workout, the leaderboard and the weekly
// streak. WorkoutScore rows are written only through logScore/deleteScore, so
// every score is checked against its section's scoring type and gets a
// comparable sort_value (contract: lower is better only for 'time').
const SCORE_DIVISIONS = ['rx_plus', 'rx', 'scaled'];
const SCORE_DIVISION_LABEL = { rx_plus: 'Rx+', rx: 'Rx', scaled: 'Scaled' };
const SCORE_CAP_PENALTY = 1e7; // capped time scores rank below every finisher, more reps first
const SCORE_COMMENT_MAX = 280;
const SCORED_TYPES = new Set(['time', 'rounds_reps', 'load', 'reps', 'distance', 'calories', 'check']);
const LOAD_TO_LB = { lb: 1, kg: 2.20462 };
const DIST_TO_M = { m: 1, km: 1000, mi: 1609.344 };

// Members see a workout once it is published and its publish time has passed.
const scoreWorkoutVisible = (w, nowMs = Date.now()) => !!w && w.status === 'published'
  && (!w.publish_at || Date.parse(w.publish_at) <= nowMs);
const scoreSection = (w, sectionId) => (Array.isArray(w?.sections) ? w.sections : []).find((s) => s && s.id === sectionId) || null;
const sectionIsScored = (s) => !!s && SCORED_TYPES.has(s.scoring?.type);
const fmtClock = (sec) => {
  const t = Math.round(Number(sec) || 0);
  const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const roundNum = (n) => Math.round(Number(n) * 100) / 100;

// Check a logged value against the section's scoring. -> { value, sort_value } | { error }
function normalizeScoreValue(scoring, raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const num = (x) => (x === '' || x === null || x === undefined ? NaN : Number(x));
  const whole = (x) => Number.isInteger(num(x)) && num(x) >= 0;
  switch (scoring?.type) {
    case 'time': {
      const cap = Number(scoring.time_cap_sec) > 0 ? Number(scoring.time_cap_sec) : null;
      if (v.capped) {
        if (!whole(v.reps)) return { error: 'Enter how many reps you finished before the cap.' };
        const reps = num(v.reps);
        return { value: { capped: true, reps, ...(cap ? { seconds: cap } : {}) }, sort_value: SCORE_CAP_PENALTY - Math.min(reps, SCORE_CAP_PENALTY - 1) };
      }
      const sec = num(v.seconds);
      if (!Number.isFinite(sec) || sec <= 0) return { error: 'Enter your time as minutes and seconds.' };
      if (cap && sec > cap) return { error: `That's over the ${fmtClock(cap)} time cap. Tick "Hit the cap" and enter your reps.` };
      return { value: { seconds: Math.round(sec), capped: false }, sort_value: Math.round(sec) };
    }
    case 'rounds_reps': {
      const rounds = v.rounds === '' || v.rounds === undefined || v.rounds === null ? 0 : num(v.rounds);
      const reps = v.reps === '' || v.reps === undefined || v.reps === null ? 0 : num(v.reps);
      if (!whole(rounds) || !whole(reps)) return { error: 'Rounds and reps must be whole numbers.' };
      if (rounds === 0 && reps === 0) return { error: 'Enter your rounds and reps.' };
      const per = Number(scoring.reps_per_round) > 0 ? Number(scoring.reps_per_round) : null;
      if (per && reps >= per) return { error: `A round is ${per} reps, so extra reps must be fewer than ${per}.` };
      if (reps >= 1000) return { error: 'That many extra reps looks off. Check the number.' };
      return { value: { rounds, reps }, sort_value: rounds * 1000 + reps };
    }
    case 'load': {
      const load = num(v.load);
      if (!Number.isFinite(load) || load <= 0 || load > 5000) return { error: 'Enter the weight you lifted.' };
      const unit = LOAD_TO_LB[v.unit] ? v.unit : (LOAD_TO_LB[scoring.unit] ? scoring.unit : 'lb');
      const base = LOAD_TO_LB[scoring.unit] ? scoring.unit : 'lb';
      // Compared in the section's unit so lb and kg entries rank together.
      return { value: { load: roundNum(load), unit }, sort_value: roundNum(unit === base ? load : (load * LOAD_TO_LB[unit]) / LOAD_TO_LB[base]) };
    }
    case 'reps': {
      if (!whole(v.reps) || num(v.reps) === 0) return { error: 'Enter your reps as a whole number.' };
      return { value: { reps: num(v.reps) }, sort_value: num(v.reps) };
    }
    case 'distance': {
      const d = num(v.distance);
      if (!Number.isFinite(d) || d <= 0) return { error: 'Enter the distance.' };
      const unit = DIST_TO_M[v.unit] ? v.unit : (DIST_TO_M[scoring.unit] ? scoring.unit : 'm');
      const base = DIST_TO_M[scoring.unit] ? scoring.unit : 'm';
      return { value: { distance: roundNum(d), unit }, sort_value: roundNum(unit === base ? d : (d * DIST_TO_M[unit]) / DIST_TO_M[base]) };
    }
    case 'calories': {
      const c = num(v.calories);
      if (!Number.isFinite(c) || c <= 0 || !Number.isInteger(c)) return { error: 'Enter your calories as a whole number.' };
      return { value: { calories: c, unit: 'cal' }, sort_value: c };
    }
    case 'check':
      if (v.done === false) return { error: 'Tick done to log this part.' };
      return { value: { done: true }, sort_value: 1 };
    default:
      return { error: 'This part of the workout is not scored.' };
  }
}

// How a score reads on screen: "12:34", "Capped, 145 reps", "5 rounds + 12", "225 lb".
function scoreDisplay(scoring, value) {
  const v = value || {};
  switch (scoring?.type) {
    case 'time': return v.capped ? `Capped, ${v.reps ?? 0} reps` : fmtClock(v.seconds);
    case 'rounds_reps': return `${v.rounds ?? 0} round${v.rounds === 1 ? '' : 's'}${v.reps ? ` + ${v.reps}` : ''}`;
    case 'load': return `${v.load} ${v.unit || scoring.unit || 'lb'}`;
    case 'reps': return `${v.reps} reps`;
    case 'distance': return `${v.distance} ${v.unit || scoring.unit || 'm'}`;
    case 'calories': return `${v.calories} cal`;
    case 'check': return 'Done';
    default: return '';
  }
}

// Who a score is for. Members: themselves or a linked child. Staff need classes.run and name client_id.
async function scoreTarget(env, user, clientId) {
  if (isStaff(user)) {
    if (!can(user, 'classes.run')) return { denied: NO_PERMISSION };
    if (!clientId) return { denied: { success: false, error: 'Pick the member this score is for.' } };
  }
  const who = await resolveClassClient(env, user, clientId || null);
  if (who.error) {
    return { denied: { success: false, error: clientId && !isStaff(user) ? 'You can only log scores for yourself or your children.' : who.error, code: 'forbidden' } };
  }
  return { who };
}

// Can this user change or remove this score?
async function canEditScore(env, user, score) {
  if (isStaff(user)) return can(user, 'classes.run');
  return (await actableClientIds(env, user)).includes(score.client_id);
}

const scoreOut = (score, section) => ({ ...score, display: scoreDisplay(section?.scoring, score.value), division_label: SCORE_DIVISION_LABEL[score.division] || '' });

async function logScore(env, user, payload) {
  const workout = await getEntityById(env, 'Workout', payload?.workout_id);
  if (!workout || (!scoreWorkoutVisible(workout))) return { success: false, error: 'This workout is not posted yet.', code: 'not_published' };
  const section = scoreSection(workout, payload?.section_id);
  if (!section) return { success: false, error: 'That part of the workout was not found.' };
  if (!sectionIsScored(section)) return { success: false, error: 'This part of the workout is not scored.' };
  if (workout.date > programToday()) return { success: false, error: 'You can log this score on the day of the workout.', code: 'too_early' };
  const t = await scoreTarget(env, user, payload?.client_id);
  if (t.denied) return t.denied;
  const { who } = t;
  const division = SCORE_DIVISIONS.includes(payload?.division) ? payload.division : null;
  if (!division) return { success: false, error: 'Pick Rx, Rx+ or Scaled.' };
  const norm = normalizeScoreValue(section.scoring, payload?.value);
  if (norm.error) return { success: false, error: norm.error, code: 'bad_value' };
  const comment = String(payload?.comment ?? '').trim().slice(0, SCORE_COMMENT_MAX);

  const ids = who.clientIds;
  const existing = (await selectEntities(env, 'WorkoutScore',
    `json_extract(data,'$.workout_id') = ? AND json_extract(data,'$.section_id') = ? AND json_extract(data,'$.client_id') IN (${inList(ids)})`,
    [workout.id, section.id, ...ids])).sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)))[0] || null;
  const clientId = existing?.client_id || who.client.id;
  const fields = {
    workout_id: workout.id, section_id: section.id, date: workout.date,
    client_id: clientId, user_email: who.client.email || existing?.user_email || null,
    division, value: norm.value, sort_value: norm.sort_value, comment, is_pr: false,
  };
  let pr = null;
  if (typeof checkPr === 'function') {
    try {
      // checkPr is defined by the LIFTS block once merged.
      pr = await checkPr(env, {
        client_id: clientId, movement_id: section.kind === 'strength' ? (section.movement_ids || [])[0] || null : null,
        load: norm.value.load ?? null, unit: norm.value.unit || section.scoring?.unit || null, reps: norm.value.reps ?? null, scoring: section.scoring, sort_value: norm.sort_value,
        benchmark_id: section.benchmark_id || null, workout_id: workout.id, section_id: section.id, exclude_id: existing?.id || null,
      });
      fields.is_pr = !!pr?.is_pr;
    } catch (e) {
      console.error('checkPr failed', e?.message);
    }
  }
  let score;
  if (existing) {
    score = await patchEntity(env, existing, { ...fields, updated_by: user.email });
  } else {
    // One score per member per section: insert only if none slipped in meanwhile.
    const id = uid();
    const now = nowISO();
    const r = await env.DB.prepare(
      `INSERT INTO entities (id, entity_type, data, created_by, created_date, updated_date)
       SELECT ?, 'WorkoutScore', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM entities WHERE entity_type='WorkoutScore'
         AND json_extract(data,'$.workout_id') = ? AND json_extract(data,'$.section_id') = ? AND json_extract(data,'$.client_id') = ?)`
    ).bind(id, JSON.stringify(fields), user.email, now, now, workout.id, section.id, clientId).run();
    if (!r?.meta?.changes) return { success: false, error: 'A score was just saved for this. Refresh and try again.', code: 'conflict' };
    score = await getEntityById(env, 'WorkoutScore', id);
  }
  if (isStaff(user) || who.guardianId) {
    await audit(env, { actor: user.email, action: existing ? 'score_updated' : 'score_logged', target: 'WorkoutScore', targetId: score.id, detail: `for ${who.client.full_name || clientId}`, request: null });
  }
  return { success: true, score: scoreOut(score, section), pr: !!fields.is_pr, previous: pr?.previous ?? null, updated: !!existing };
}

async function deleteScore(env, user, payload) {
  const score = await getEntityById(env, 'WorkoutScore', payload?.score_id);
  if (!score) return { success: false, error: 'Score not found.' };
  if (!(await canEditScore(env, user, score))) return isStaff(user) ? NO_PERMISSION : { success: false, error: 'You can only remove your own scores.', code: 'forbidden' };
  await env.DB.prepare(`DELETE FROM entities WHERE id = ? AND entity_type = 'WorkoutScore'`).bind(score.id).run();
  if (isStaff(user)) await audit(env, { actor: user.email, action: 'score_deleted', target: 'WorkoutScore', targetId: score.id, detail: '', request: null });
  return { success: true };
}

const scoredSectionsOf = (w) => (Array.isArray(w?.sections) ? w.sections : []).filter(sectionIsScored)
  .map((s) => ({ id: s.id, kind: s.kind, title: s.title || '', scoring: s.scoring }));

async function leaderboard(env, user, payload) {
  const workout = await getEntityById(env, 'Workout', payload?.workout_id);
  const staffView = isStaff(user);
  if (!workout || (!staffView && !scoreWorkoutVisible(workout))) return { success: false, error: 'This workout is not posted yet.', code: 'not_published' };
  const sections = scoredSectionsOf(workout);
  const section = scoreSection(workout, payload?.section_id) || (() => {
    const id = (sections.find((s) => s.kind === 'metcon') || sections[0])?.id;
    return id ? scoreSection(workout, id) : null;
  })();
  const head = { workout: { id: workout.id, date: workout.date, title: workout.title || '' }, sections };
  if (!section || !sectionIsScored(section)) return { success: true, ...head, section: null, rows: [] };
  const scores = await selectEntities(env, 'WorkoutScore', `json_extract(data,'$.workout_id') = ? AND json_extract(data,'$.section_id') = ?`, [workout.id, section.id]);
  const clientIds = [...new Set(scores.map((s) => s.client_id))];
  const clients = clientIds.length ? await selectEntities(env, 'Client', `id IN (${inList(clientIds)})`, clientIds) : [];
  const byId = Object.fromEntries(clients.map((c) => [c.id, c]));
  const mine = new Set(staffView ? [] : await actableClientIds(env, user));
  const division = SCORE_DIVISIONS.includes(payload?.division) ? payload.division : null;
  const gender = payload?.gender ? String(payload.gender).toLowerCase() : null;
  const lower = section.scoring?.lower_is_better === true || (section.scoring?.lower_is_better === undefined && section.scoring?.type === 'time');
  const tier = (d) => { const i = SCORE_DIVISIONS.indexOf(d); return i < 0 ? 9 : i; };
  const list = scores
    .filter((s) => !division || s.division === division)
    .filter((s) => !gender || String(byId[s.client_id]?.gender || '').toLowerCase() === gender)
    // Rx+ above Rx above Scaled, then by score; ties go to whoever logged first.
    .sort((a, b) => tier(a.division) - tier(b.division)
      || (lower ? a.sort_value - b.sort_value : b.sort_value - a.sort_value)
      || String(a.created_date).localeCompare(String(b.created_date)));
  let rank = 0;
  const rows = list.map((s, i) => {
    const prev = list[i - 1];
    if (!prev || prev.division !== s.division || prev.sort_value !== s.sort_value) rank = i + 1;
    return {
      rank, score_id: s.id, name: shortName(byId[s.client_id]?.full_name),
      division: s.division, division_label: SCORE_DIVISION_LABEL[s.division] || '', display: scoreDisplay(section.scoring, s.value),
      comment: s.comment || '', is_pr: !!s.is_pr, mine: mine.has(s.client_id),
    };
  });
  return {
    success: true, ...head,
    section: { id: section.id, kind: section.kind, title: section.title || '', description: section.description || '', scoring: section.scoring },
    rows,
  };
}

async function myScores(env, user, payload) {
  const t = isStaff(user)
    ? (payload?.client_id ? await scoreTarget(env, user, payload.client_id) : { denied: { success: false, error: 'Pick a member.' } })
    : await scoreTarget(env, user, payload?.client_id || null);
  if (t.denied) return t.denied;
  const today = programToday();
  const from = isDateKey(payload?.from) ? payload.from : pAddDays(today, -90);
  const to = isDateKey(payload?.to) ? payload.to : pAddDays(today, 1);
  const ids = t.who.clientIds;
  const scores = await selectEntities(env, 'WorkoutScore',
    `json_extract(data,'$.client_id') IN (${inList(ids)}) AND json_extract(data,'$.date') >= ? AND json_extract(data,'$.date') <= ?`, [...ids, from, to]);
  const wIds = [...new Set(scores.map((s) => s.workout_id))];
  const workouts = wIds.length ? await selectEntities(env, 'Workout', `id IN (${inList(wIds)})`, wIds) : [];
  const wById = Object.fromEntries(workouts.map((w) => [w.id, w]));
  return {
    success: true,
    scores: scores.map((s) => {
      const w = wById[s.workout_id];
      const sec = scoreSection(w, s.section_id);
      return { ...scoreOut(s, sec), workout_title: w?.title || '', section_title: sec?.title || '', section_kind: sec?.kind || '' };
    }).sort((a, b) => b.date.localeCompare(a.date) || String(b.created_date).localeCompare(String(a.created_date))),
  };
}

// Consecutive Monday-start weeks (gym time) with a logged score or a class check-in.
// This week counts once it has one; until then the streak runs to last week.
async function weeklyStreak(env, user, payload) {
  const t = isStaff(user)
    ? (payload?.client_id ? await scoreTarget(env, user, payload.client_id) : { denied: { success: false, error: 'Pick a member.' } })
    : await scoreTarget(env, user, payload?.client_id || null);
  if (t.denied) return t.denied;
  const ids = t.who.clientIds;
  const today = programToday();
  const since = pAddDays(today, -7 * 160);
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT json_extract(data,'$.date') AS d FROM entities WHERE entity_type = 'WorkoutScore'
       AND json_extract(data,'$.client_id') IN (${inList(ids)}) AND json_extract(data,'$.date') >= ? AND json_extract(data,'$.date') <= ?
     UNION SELECT DISTINCT json_extract(data,'$.date') AS d FROM entities WHERE entity_type = 'Reservation'
       AND json_extract(data,'$.status') = 'checked_in' AND json_extract(data,'$.client_id') IN (${inList(ids)})
       AND json_extract(data,'$.date') >= ? AND json_extract(data,'$.date') <= ?`
  ).bind(...ids, since, today, ...ids, since, today).all();
  const days = results.map((r) => r.d).filter(isDateKey);
  const weeks = new Set(days.map(classWeekStart));
  const thisWeek = classWeekStart(today);
  const thisWeekCount = days.filter((d) => classWeekStart(d) === thisWeek).length;
  let w = weeks.has(thisWeek) ? thisWeek : pAddDays(thisWeek, -7);
  let streak = 0;
  while (weeks.has(w)) { streak += 1; w = pAddDays(w, -7); }
  return { success: true, weeks: streak, this_week_count: thisWeekCount, this_week_active: weeks.has(thisWeek), week_start: thisWeek };
}

async function runMemberScoreFunction(name, payload, { env, user }) {
  if (!user) return { success: false, error: 'Not logged in' };
  switch (name) {
    case 'logScore': return logScore(env, user, payload);
    case 'deleteScore': return deleteScore(env, user, payload);
    case 'leaderboard': return leaderboard(env, user, payload);
    case 'myScores': return myScores(env, user, payload);
    case 'weeklyStreak': return weeklyStreak(env, user, payload);
    default: return { __unimplemented: true };
  }
}
// ===== end Phase 3: MEMBER =====

// ===== Phase 4: RULES =====
// Membership rules: the membership agreement, holds pausing Stripe collection,
// plan changes, cancel with commitment/buyout, refunds, comps and the daily
// renewals step. Every money action needs members.manage AND billing.view and
// is audited. Memberships with no stripe_subscription_id change local fields
// only, so everything works before billing is connected.
//
// Exports for CORE/SALES checkout:
//   requireAgreement(env, plan, agreement_id, { client_id }?) -> null when OK,
//     else { success:false, error, code:'agreement_required' }. Call it before
//     creating a Checkout session; it passes for plans that don't need one.
//   createAgreement(env, { client_id, plan, signed_name, actor, ip }) -> Agreement
//     (for the public join flow once the lead's Client exists).
STAFF_WRITE_TYPES.add('Agreement'); // written only by signAgreement
TYPE_PERMISSION.Agreement = 'members.manage';
PUBLIC_FUNCTIONS.add('agreementText'); // read-only, no member data
MONEY_FIELDS.push('buyout_cents', 'refunded_cents', 'refunds', 'tax_cents', 'discount_cents', 'billing_status', 'comped_until');

const SAMPLE_AGREEMENT_TEXT = `SAMPLE MEMBERSHIP AGREEMENT. Replace this text with your own before taking real members.

1. Membership. Your membership lets you book and attend the classes your plan includes, following the gym's booking rules.

2. Payments. Your plan renews automatically each billing period and is charged to the card or bank account on file until you cancel. Prices include the sales tax shown at checkout.

3. Commitment. If your plan has a commitment (for example 6 or 12 months), you agree to pay for the whole commitment. You can leave early by paying the buyout amount shown for your plan. After the commitment ends, the plan continues month to month.

4. Cancelling. After any commitment, you can cancel at any time. Your membership stays active until the end of the period you already paid for. No partial refunds.

5. Holds. You can ask to put your membership on hold (for travel, injury or illness). Billing pauses while the hold lasts and any end date moves back by the hold length.

6. Failed payments. If a payment fails we retry it. You can't book classes until your payment goes through.

7. Health and safety. CrossFit is hard exercise. You confirm you are fit to train, that you'll tell a coach about any injury or condition, and that you'll follow the coaches' instructions. You accept the risks that come with training.

8. Conduct. Treat coaches, members and the space with respect. The gym may end a membership for unsafe or abusive behavior.

9. Changes. The gym may change prices or these terms with 30 days' notice. Changes apply from your next billing period.`;

const canChangeBilling = (user) => isStaff(user) && can(user, 'members.manage') && can(user, 'billing.view');
const rulesCentsOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const rulesDateFromUnix = (secs) => (Number.isFinite(Number(secs)) && Number(secs) > 0 ? programToday(Number(secs) * 1000) : null);
const rulesUnixOf = (key) => Math.floor(easternToUTC(key, '00:00') / 1000);
const fmtUsd = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

async function rulesGymSettingsRow(env) {
  return parseRow(await env.DB.prepare(
    `SELECT * FROM entities WHERE entity_type='GymSettings' ORDER BY created_date ASC LIMIT 1`
  ).first());
}
async function currentAgreement(env) {
  const row = await rulesGymSettingsRow(env);
  const custom = typeof row?.agreement_text === 'string' && row.agreement_text.trim();
  return {
    text: custom ? row.agreement_text : SAMPLE_AGREEMENT_TEXT,
    version: Math.max(1, Math.round(numOr(row?.agreement_version, 1))),
    is_sample: !custom,
  };
}

// Which plans need a signed agreement: recurring memberships. Drop-ins, trials,
// intro offers, punch cards and one-time payments don't.
const NO_AGREEMENT_KINDS = new Set(['drop_in', 'trial', 'intro', 'punch_card', 'comp']);
const planNeedsAgreement = (plan) => !!plan && !NO_AGREEMENT_KINDS.has(planBillingKind(plan)) && plan.interval !== 'once';

async function createAgreement(env, { client_id, plan, signed_name, actor, ip = '', membership_id = null }) {
  const a = await currentAgreement(env);
  return insertEntity(env, 'Agreement', {
    client_id, membership_id, plan_id: plan.id, text_version: a.version, text: a.text,
    signed_name: String(signed_name).trim().slice(0, 120), signed_at: nowISO(), ip: String(ip || '').slice(0, 64),
  }, actor || 'system');
}

async function requireAgreement(env, plan, agreement_id, { client_id } = {}) {
  if (!planNeedsAgreement(plan)) return null;
  const need = { success: false, error: 'Please read and sign the membership agreement first.', code: 'agreement_required' };
  const ag = agreement_id ? await getEntityById(env, 'Agreement', agreement_id) : null;
  if (!ag || ag.plan_id !== plan.id) return need;
  if (client_id && ag.client_id !== client_id) return need;
  if (ag.text_version !== (await currentAgreement(env)).version) {
    return { ...need, error: 'The membership agreement changed. Please read and sign the new version.' };
  }
  return null;
}

// Buyout to leave inside the commitment: the plan's buyout amount, else the
// months left times the price.
function buyoutFor(m, plan, today = programToday()) {
  if (!isDateKey(m?.commitment_ends) || m.commitment_ends <= today) return null;
  const set = numOr(plan?.buyout_cents, null);
  if (set !== null && set >= 0) return Math.round(set);
  const months = Math.max(1, Math.ceil(pDaysBetween(today, m.commitment_ends) / 30.44));
  return months * Math.max(0, Math.round(numOr(plan?.price_cents, 0)));
}
const priceFor = (m, plan) => (m.payment_method === 'bank' && plan.stripe_price_bank_id ? plan.stripe_price_bank_id : plan.stripe_price_id);

// Stripe failures never undo the local change silently: the caller decides.
async function rulesStripe(env, path, opts) {
  if (!billingConnected(env)) throw new Error("Billing isn't connected yet.");
  return stripe(env, path, opts);
}

// Hold <-> Stripe: when a hold covers today, pause collection (invoices voided)
// until the day after it ends; otherwise resume. Called from the hold
// functions and the daily renewals step. Returns the updated membership.
const activeHoldToday = (m, today) => (Array.isArray(m.holds) ? m.holds : [])
  .find((h) => h.status !== 'cancelled' && isDateKey(h.from) && isDateKey(h.to) && h.from <= today && today <= h.to) || null;
async function syncHoldBilling(env, m, actor = 'system') {
  if (!m?.stripe_subscription_id || !billingConnected(env) || m.billing_status === 'comped' || m.billing_status === 'canceled') return m;
  const today = programToday();
  const hold = activeHoldToday(m, today);
  try {
    if (hold && (m.billing_status !== 'paused' || m.paused_until !== hold.to)) {
      await rulesStripe(env, `subscriptions/${m.stripe_subscription_id}`, { data: { pause_collection: { behavior: 'void', resumes_at: rulesUnixOf(pAddDays(hold.to, 1)) } } });
      m = await patchEntity(env, m, { billing_status: 'paused', paused_until: hold.to, billing_status_before_pause: m.billing_status === 'paused' ? (m.billing_status_before_pause || 'active') : (m.billing_status || 'active') });
      await audit(env, { actor, action: 'billing_paused', target: 'Membership', targetId: m.id, detail: `collection paused for hold until ${hold.to}` });
    } else if (!hold && m.billing_status === 'paused') {
      await rulesStripe(env, `subscriptions/${m.stripe_subscription_id}`, { data: { pause_collection: '' } });
      m = await patchEntity(env, m, { billing_status: m.billing_status_before_pause || 'active', paused_until: null, billing_status_before_pause: null });
      await audit(env, { actor, action: 'billing_resumed', target: 'Membership', targetId: m.id, detail: 'collection resumed' });
    }
  } catch (e) {
    await audit(env, { actor, action: 'billing_sync_failed', target: 'Membership', targetId: m.id, detail: String(e?.message || e) });
  }
  return m;
}
// One-line hook from holdMembership / endMembershipHold / cancelMembershipHold.
async function rulesAfterHoldChange(env, m, user) {
  return syncHoldBilling(env, m, user?.email || 'system');
}

async function rulesLoadMembership(env, id) {
  const m = await getEntityById(env, 'Membership', id);
  if (!m) return { error: { success: false, error: 'Membership not found.' } };
  const plan = await getEntityById(env, 'MembershipPlan', m.plan_id);
  return { m, plan };
}

async function runRulesFunction(name, payload, ctx) {
  const { env, user } = ctx;
  const ip = ctx.request?.headers?.get?.('cf-connecting-ip') || '';
  const today = programToday();
  const actor = user?.email || 'system';
  // Public: the join page shows the text before the person has an account.
  if (name === 'agreementText') return { success: true, ...(await currentAgreement(env)) };
  if (!user) return { success: false, error: 'Not logged in' };

  if (name === 'saveAgreementText') {
    if (!isStaff(user) || !can(user, 'settings.manage')) return NO_PERMISSION;
    const text = String(payload?.text ?? '').trim();
    if (text.length < 20) return { success: false, error: 'The agreement text is too short.' };
    if (text.length > 20000) return { success: false, error: 'The agreement text is too long.' };
    const now = await currentAgreement(env);
    const bump = payload?.bump_version !== false;
    const version = bump ? now.version + 1 : now.version;
    const row = await rulesGymSettingsRow(env);
    if (row) await patchEntity(env, row, { agreement_text: text, agreement_version: version });
    else await insertEntity(env, 'GymSettings', { agreement_text: text, agreement_version: version }, actor);
    await audit(env, { actor, action: 'agreement_text_updated', target: 'GymSettings', targetId: row?.id || '', detail: `version ${version}` });
    return { success: true, text, version, is_sample: false };
  }

  if (name === 'signAgreement') {
    const plan = await getEntityById(env, 'MembershipPlan', payload?.plan_id);
    if (!plan) return { success: false, error: 'Plan not found.' };
    const signedName = String(payload?.signed_name || '').trim();
    if (signedName.length < 2) return { success: false, error: 'Type your full name to sign.' };
    let clientId;
    if (isStaff(user)) {
      if (!can(user, 'members.manage')) return NO_PERMISSION;
      const c = await getEntityById(env, 'Client', payload?.client_id);
      if (!c) return { success: false, error: 'Pick a member first.' };
      clientId = c.id;
    } else {
      const who = await resolveClassClient(env, user, payload?.client_id || null);
      if (who.error) return { success: false, error: who.error };
      clientId = who.client?.id;
      if (!clientId) return { success: false, error: 'No member record found for this account.' };
    }
    const ag = await createAgreement(env, { client_id: clientId, plan, signed_name: signedName, actor, ip, membership_id: payload?.membership_id || null });
    await audit(env, { actor, action: 'agreement_signed', target: 'Agreement', targetId: ag.id, detail: `plan ${plan.name || plan.id}, version ${ag.text_version}` });
    return { success: true, agreement_id: ag.id, text_version: ag.text_version };
  }

  if (name === 'checkAgreement') { // UI/checkout helper: does this agreement still count?
    const plan = await getEntityById(env, 'MembershipPlan', payload?.plan_id);
    if (!plan) return { success: false, error: 'Plan not found.' };
    const r = await requireAgreement(env, plan, payload?.agreement_id);
    return r || { success: true, required: planNeedsAgreement(plan) };
  }

  if (name === 'upcomingRenewals') {
    if (!isStaff(user) || !can(user, 'billing.view')) return NO_PERMISSION;
    const days = Math.max(1, Math.min(60, Math.round(numOr(payload?.days, 7))));
    return { success: true, days, renewals: await collectRenewals(env, days) };
  }

  if (name === 'memberBilling') {
    if (!isStaff(user) || !can(user, 'billing.view')) return NO_PERMISSION;
    const client = await getEntityById(env, 'Client', payload?.client_id);
    if (!client) return { success: false, error: 'Member not found.' };
    const memberships = await selectEntities(env, 'Membership', "json_extract(data,'$.client_id') = ?", [client.id]);
    const plans = await selectEntities(env, 'MembershipPlan');
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
    const payments = (await selectEntities(env, 'Payment', "json_extract(data,'$.client_id') = ?", [client.id]))
      .sort((a, b) => String(b.paid_at || b.created_date).localeCompare(String(a.paid_at || a.created_date)));
    const agreements = (await selectEntities(env, 'Agreement', "json_extract(data,'$.client_id') = ?", [client.id]))
      .map(({ text: _t, ...a }) => a).sort((a, b) => String(b.signed_at).localeCompare(String(a.signed_at)));
    return {
      success: true,
      connected: billingConnected(env),
      today,
      can_change: canChangeBilling(user),
      client: { id: client.id, full_name: client.full_name || '', email: client.email || '' },
      memberships: memberships.sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || ''))).map((m) => ({
        ...m,
        plan: byId[m.plan_id] || null,
        pending_plan: m.pending_plan_id ? byId[m.pending_plan_id] || null : null,
        inside_commitment: isDateKey(m.commitment_ends) && m.commitment_ends > today,
        buyout_now_cents: buyoutFor(m, byId[m.plan_id], today),
      })),
      payments,
      agreements,
      plans: plans.filter((p) => p.is_active !== false).map((p) => ({ id: p.id, name: p.name, price_cents: p.price_cents ?? null, interval: p.interval || null, commitment_months: p.commitment_months ?? 0, stripe_price_id: p.stripe_price_id || null })),
    };
  }

  if (name === 'runBillingRules') {
    if (!canChangeBilling(user)) return NO_PERMISSION;
    return runBillingRenewals(env, { force: true });
  }

  // ---- money actions: members.manage + billing.view ----
  if (!isStaff(user) || !canChangeBilling(user)) return NO_PERMISSION;

  if (name === 'refundPayment') {
    const p = await getEntityById(env, 'Payment', payload?.payment_id);
    if (!p) return { success: false, error: 'Payment not found.' };
    const paid = Math.round(numOr(p.amount_cents, 0));
    const already = Math.round(numOr(p.refunded_cents, 0));
    const left = paid - already;
    if (p.status === 'failed' || left <= 0) return { success: false, error: 'Nothing left to refund on this payment.' };
    const amount = payload?.amount_cents === undefined || payload?.amount_cents === null ? left : rulesCentsOf(payload.amount_cents);
    if (!amount) return { success: false, error: 'Enter an amount in cents above zero.' };
    if (amount > left) return { success: false, error: `You can refund up to ${fmtUsd(left)}.` };
    const reason = String(payload?.reason || '').trim().slice(0, 200);
    let refundId = null;
    if (p.stripe_payment_intent_id) {
      if (!billingConnected(env)) return { success: false, error: "Billing isn't connected yet.", code: 'not_connected' };
      try {
        const r = await rulesStripe(env, 'refunds', { data: { payment_intent: p.stripe_payment_intent_id, amount, reason: 'requested_by_customer', metadata: { payment_id: p.id, note: reason || undefined } } });
        refundId = r.id;
      } catch (e) { return { success: false, error: `Stripe said: ${String(e?.message || e)}` }; }
    }
    const refunded = already + amount;
    const updated = await patchEntity(env, p, {
      refunded_cents: refunded,
      status: refunded >= paid ? 'refunded' : 'partially_refunded',
      refunds: [...(Array.isArray(p.refunds) ? p.refunds : []), { amount_cents: amount, reason, stripe_refund_id: refundId, by: actor, at: nowISO() }],
    });
    await audit(env, { actor, action: 'payment_refunded', target: 'Payment', targetId: p.id, detail: `${fmtUsd(amount)} of ${fmtUsd(paid)}${reason ? `: ${reason}` : ''}` });
    return { success: true, payment: updated };
  }

  const { m, plan, error } = await rulesLoadMembership(env, payload?.membership_id);
  if (error) return error;
  const sub = m.stripe_subscription_id || null;
  if (sub && !billingConnected(env)) return { success: false, error: "Billing isn't connected yet.", code: 'not_connected' };

  if (name === 'changePlan') {
    const next = await getEntityById(env, 'MembershipPlan', payload?.plan_id);
    if (!next) return { success: false, error: 'Plan not found.' };
    if (next.id === m.plan_id) return { success: false, error: 'They are already on this plan.' };
    const when = payload?.when === 'next_cycle' ? 'next_cycle' : payload?.when === 'now' ? 'now' : null;
    if (!when) return { success: false, error: "Choose 'now' or 'next_cycle'." };
    if (m.billing_status === 'canceled' || m.status === 'ended') return { success: false, error: 'This membership has ended.' };
    const newPrice = sub ? priceFor(m, next) : null;
    if (sub && !newPrice) return { success: false, error: 'This plan is not set up in Stripe yet. Sync it first.' };
    let patch;
    try {
      if (when === 'now') {
        if (sub) {
          const s = await rulesStripe(env, `subscriptions/${sub}`, { method: 'GET' });
          const item = s.items?.data?.[0];
          await rulesStripe(env, `subscriptions/${sub}`, { data: { items: [{ id: item?.id, price: newPrice }], proration_behavior: 'create_prorations' } });
        }
        const months = Math.round(numOr(next.commitment_months, 0));
        const ends = months > 0 ? monthAnchorKey(Number(today.slice(0, 4)), Number(today.slice(5, 7)) + months, Number(today.slice(8, 10))) : null;
        patch = { plan_id: next.id, pending_plan_id: null, pending_plan_from: null, previous_plan_id: m.plan_id, plan_changed_at: nowISO(),
          commitment_ends: ends && (!isDateKey(m.commitment_ends) || ends > m.commitment_ends) ? ends : (m.commitment_ends ?? null) };
      } else {
        let from = null;
        if (sub) {
          const s = await rulesStripe(env, `subscriptions/${sub}`, { method: 'GET' });
          const item = s.items?.data?.[0];
          const curPrice = item?.price?.id || item?.price || priceFor(m, plan || {});
          const start = s.current_period_start ?? item?.current_period_start;
          const end = s.current_period_end ?? item?.current_period_end;
          const sched = s.schedule ? { id: typeof s.schedule === 'string' ? s.schedule : s.schedule.id }
            : await rulesStripe(env, 'subscription_schedules', { data: { from_subscription: sub } });
          await rulesStripe(env, `subscription_schedules/${sched.id}`, { data: {
            end_behavior: 'release',
            phases: [
              { items: [{ price: curPrice, quantity: 1 }], start_date: start, end_date: end },
              { items: [{ price: newPrice, quantity: 1 }], proration_behavior: 'none' },
            ],
          } });
          from = rulesDateFromUnix(end);
        }
        from = from || (isDateKey(m.next_payment_date) && m.next_payment_date > today ? m.next_payment_date : pAddDays(billingPeriod(m.start_date, today).end, 1));
        patch = { pending_plan_id: next.id, pending_plan_from: from };
      }
    } catch (e) { return { success: false, error: `Stripe said: ${String(e?.message || e)}` }; }
    if (!(await patchMembershipIf(env, m, patch))) return { success: false, error: 'This membership just changed. Refresh and try again.', code: 'retry' };
    await audit(env, { actor, action: 'plan_changed', target: 'Membership', targetId: m.id, detail: `${plan?.name || m.plan_id} -> ${next.name || next.id} (${when}${patch.pending_plan_from ? ` from ${patch.pending_plan_from}` : ''})` });
    return { success: true, when, membership: await getEntityById(env, 'Membership', m.id) };
  }

  if (name === 'cancelMembership') {
    if (m.billing_status === 'canceled' || m.status === 'ended') return { success: false, error: 'This membership is already cancelled.' };
    const reason = String(payload?.reason || '').trim().slice(0, 200);
    if (!reason) return { success: false, error: 'Add a reason for cancelling.' };
    const buyout = buyoutFor(m, plan, today);
    let patch;
    if (buyout !== null) {
      if (payload?.confirm_buyout !== true) {
        return { success: false, code: 'buyout_required', buyout_cents: buyout, commitment_ends: m.commitment_ends,
          error: `They're in a commitment until ${shortDay(m.commitment_ends, today)}. Leaving now costs a ${fmtUsd(buyout)} buyout.` };
      }
      try {
        if (sub && buyout > 0) {
          const s = await rulesStripe(env, `subscriptions/${sub}`, { method: 'GET' });
          const customer = m.stripe_customer_id || (typeof s.customer === 'string' ? s.customer : s.customer?.id);
          await rulesStripe(env, 'invoiceitems', { data: { customer, amount: buyout, currency: 'usd', description: `Membership buyout (${plan?.name || 'plan'})`, metadata: { membership_id: m.id, kind: 'buyout' } } });
          const inv = await rulesStripe(env, 'invoices', { data: { customer, collection_method: 'charge_automatically', pending_invoice_items_behavior: 'include', auto_advance: true, metadata: { membership_id: m.id, kind: 'buyout' } } });
          await rulesStripe(env, `invoices/${inv.id}/pay`, {});
        }
        if (sub) await rulesStripe(env, `subscriptions/${sub}`, { method: 'DELETE' });
      } catch (e) { return { success: false, error: `Stripe said: ${String(e?.message || e)}` }; }
      patch = { billing_status: sub ? 'canceled' : (m.billing_status === 'none' || !m.billing_status ? 'none' : 'canceled'), end_date: today, buyout_cents: buyout, commitment_ends: today, cancel_at_period_end: false };
    } else {
      let end = null;
      try {
        if (sub) {
          const s = await rulesStripe(env, `subscriptions/${sub}`, { data: { cancel_at_period_end: true, metadata: { cancel_reason: reason } } });
          const periodEnd = rulesDateFromUnix(s.current_period_end ?? s.items?.data?.[0]?.current_period_end);
          if (periodEnd) end = pAddDays(periodEnd, -1);
        }
      } catch (e) { return { success: false, error: `Stripe said: ${String(e?.message || e)}` }; }
      end = end || (isDateKey(m.next_payment_date) && m.next_payment_date > today ? pAddDays(m.next_payment_date, -1) : billingPeriod(m.start_date, today).end);
      if (isDateKey(m.end_date) && m.end_date < end) end = m.end_date;
      patch = { end_date: end, cancel_at_period_end: !!sub, ...(sub ? {} : { billing_status: m.billing_status && m.billing_status !== 'none' ? 'canceled' : (m.billing_status || 'none') }) };
    }
    Object.assign(patch, { cancel_reason: reason, canceled_at: nowISO(), canceled_by: actor, end_reason: reason, end_set_by: actor, end_set_at: nowISO(), pending_plan_id: null, pending_plan_from: null });
    if (!(await patchMembershipIf(env, m, patch))) return { success: false, error: 'This membership just changed. Refresh and try again.', code: 'retry' };
    const fresh = await getEntityById(env, 'Membership', m.id);
    const released = await releaseMembershipBookings(env, fresh, pAddDays(fresh.end_date, 1), null, 'Membership ended', user);
    await audit(env, { actor, action: buyout !== null ? 'membership_buyout' : 'membership_canceled', target: 'Membership', targetId: m.id,
      detail: `${buyout !== null ? `buyout ${fmtUsd(buyout)}, ` : ''}ends ${fresh.end_date}: ${reason}${released ? `; ${released} bookings cancelled` : ''}` });
    return { success: true, membership: fresh, buyout_cents: buyout, ends: fresh.end_date };
  }

  if (name === 'compMembership') {
    if (payload?.end === true) {
      if (m.billing_status !== 'comped') return { success: false, error: 'This membership is not comped.' };
      return endComp(env, m, actor);
    }
    const until = payload?.until === null || payload?.until === '' || payload?.until === undefined ? null : payload.until;
    if (until !== null && (!isDateKey(until) || until < today)) return { success: false, error: 'Pick an end date from today on, or leave it open.' };
    if (m.billing_status === 'canceled' || m.status === 'ended') return { success: false, error: 'This membership has ended.' };
    const reason = String(payload?.reason || '').trim().slice(0, 200);
    try {
      if (sub) await rulesStripe(env, `subscriptions/${sub}`, { data: { pause_collection: { behavior: 'void', ...(until ? { resumes_at: rulesUnixOf(pAddDays(until, 1)) } : {}) } } });
    } catch (e) { return { success: false, error: `Stripe said: ${String(e?.message || e)}` }; }
    const patch = { billing_status: 'comped', comped_until: until, comp_reason: reason || null, comped_by: actor,
      billing_status_before_comp: m.billing_status === 'comped' ? (m.billing_status_before_comp || 'active') : (m.billing_status || 'none') };
    if (!(await patchMembershipIf(env, m, patch))) return { success: false, error: 'This membership just changed. Refresh and try again.', code: 'retry' };
    await audit(env, { actor, action: 'membership_comped', target: 'Membership', targetId: m.id, detail: `comped ${until ? `until ${until}` : 'with no end date'}${reason ? `: ${reason}` : ''}` });
    return { success: true, membership: await getEntityById(env, 'Membership', m.id) };
  }

  return { __unimplemented: true };
}

async function endComp(env, m, actor) {
  try {
    if (m.stripe_subscription_id && billingConnected(env)) await stripe(env, `subscriptions/${m.stripe_subscription_id}`, { data: { pause_collection: '' } });
  } catch (e) { return { success: false, error: `Stripe said: ${String(e?.message || e)}` }; }
  const back = m.billing_status_before_comp && m.billing_status_before_comp !== 'comped' ? m.billing_status_before_comp : (m.stripe_subscription_id ? 'active' : 'none');
  const fresh = await patchEntity(env, m, { billing_status: back, comped_until: null, billing_status_before_comp: null, comp_ended_at: nowISO() });
  await audit(env, { actor, action: 'comp_ended', target: 'Membership', targetId: m.id, detail: `billing back to ${back}` });
  return { success: true, membership: fresh };
}

// Memberships renewing (next payment) or leaving a commitment in the next `days`.
async function collectRenewals(env, days = 7) {
  const today = programToday();
  const until = pAddDays(today, days);
  const all = await selectEntities(env, 'Membership', "COALESCE(json_extract(data,'$.status'),'active') <> 'ended'");
  const plans = Object.fromEntries((await selectEntities(env, 'MembershipPlan')).map((p) => [p.id, p]));
  const out = [];
  for (const m of all) {
    if (['canceled', 'comped', 'paused'].includes(m.billing_status) || m.cancel_at_period_end) continue;
    if (isDateKey(m.end_date) && m.end_date < today) continue;
    const plan = plans[m.plan_id];
    const recurring = plan && plan.interval !== 'once' && (m.stripe_subscription_id || numOr(plan.price_cents, 0) > 0);
    if (recurring) {
      const next = isDateKey(m.next_payment_date) ? m.next_payment_date : pAddDays(billingPeriod(m.start_date, today).end, 1);
      if (next >= today && next <= until && (!isDateKey(m.end_date) || next <= m.end_date)) {
        out.push({ membership_id: m.id, client_id: m.client_id, plan_id: m.plan_id, plan_name: plan.name || '', date: next, reason: 'payment', amount_cents: numOr(plan.price_cents, null) });
      }
    }
    if (isDateKey(m.commitment_ends) && m.commitment_ends >= today && m.commitment_ends <= until) {
      out.push({ membership_id: m.id, client_id: m.client_id, plan_id: m.plan_id, plan_name: plan?.name || '', date: m.commitment_ends, reason: 'commitment_end', amount_cents: null });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Daily step in the program-tick cron: commitments that ended, local plan
// changes that are due, comps that ran out, hold pauses, and the renewals list
// for the billing dashboard (app_state 'billing_renewals').
async function runBillingRenewals(env, { force = false } = {}) {
  const today = programToday();
  if (!force && (await getState(env, 'billing_rules_day'))?.value === today) return { success: true, skipped: true };
  await setState(env, 'billing_rules_day', today);
  const counts = { commitments_ended: 0, plan_changes: 0, comps_ended: 0, holds_synced: 0 };
  const all = await selectEntities(env, 'Membership', "COALESCE(json_extract(data,'$.status'),'active') <> 'ended'");
  for (let m of all) {
    if (isDateKey(m.commitment_ends) && m.commitment_ends <= today && !m.commitment_ended) {
      m = await patchEntity(env, m, { commitment_ended: true });
      counts.commitments_ended += 1;
      await audit(env, { actor: 'system', action: 'commitment_ended', target: 'Membership', targetId: m.id, detail: `commitment ended ${m.commitment_ends}; now month to month` });
    }
    if (m.pending_plan_id && isDateKey(m.pending_plan_from) && m.pending_plan_from <= today) {
      const from = m.plan_id;
      m = await patchEntity(env, m, { previous_plan_id: from, plan_id: m.pending_plan_id, pending_plan_id: null, pending_plan_from: null, plan_changed_at: nowISO() });
      counts.plan_changes += 1;
      await audit(env, { actor: 'system', action: 'plan_changed', target: 'Membership', targetId: m.id, detail: `scheduled change applied: ${from} -> ${m.plan_id}` });
    }
    if (m.billing_status === 'comped' && isDateKey(m.comped_until) && m.comped_until < today) {
      const r = await endComp(env, m, 'system');
      if (r.success) { m = r.membership; counts.comps_ended += 1; }
    }
    if (m.stripe_subscription_id && (m.billing_status === 'paused' || activeHoldToday(m, today))) {
      const before = m.billing_status;
      m = await syncHoldBilling(env, m, 'system');
      if (m.billing_status !== before) counts.holds_synced += 1;
    }
  }
  const renewals = await collectRenewals(env, 7);
  await setState(env, 'billing_renewals', JSON.stringify({ date: today, renewals }));
  return { success: true, ...counts, renewals: renewals.length };
}
// ===== end Phase 4: RULES =====
// ===== Phase 4: CORE =====
// Gym billing: Stripe holds the cards, runs autopay and retries failures; the
// app reads whether a membership is paid. Everything works with no Stripe key
// (billing "isn't connected yet"). All Stripe calls go through stripe(), whose
// base URL tests point at a fake (STRIPE_API_BASE).
//
// Plan `kind` keeps the booking vocabulary it already had (unlimited, limited,
// punch, drop_in, intro, comp). The billing contract's kinds (membership,
// drop_in, trial, intro, punch_card) are also accepted. planBillingKind()
// maps either one to the contract's kind; use it, not plan.kind, for billing.
const GYM_BILLING_DEFAULTS = { bank_discount_pct: 2.89, tax_rate_pct: 2.98 };
const BILLING_STATUSES = new Set(['none', 'active', 'past_due', 'paused', 'canceled', 'unpaid', 'comped']);
const BILLING_BLOCKED = new Set(['past_due', 'unpaid']);
// Rows written only by the server (webhooks, refunds): no entity-API writes.
const GYM_BILLING_WRITE_LOCKED = new Set(['Payment']);
const GYM_BILLING_NOT_CONNECTED = { success: false, error: 'Billing isn\'t connected yet.', code: 'billing_not_connected' };

const billingConnected = (env) => !!env.STRIPE_SECRET_KEY;
const billingMode = (env) => {
  const k = String(env.STRIPE_SECRET_KEY || '');
  if (!k) return null;
  return /^(sk|rk)_live_/.test(k) ? 'live' : 'test';
};
function planBillingKind(plan) {
  const k = plan?.kind;
  if (['membership', 'drop_in', 'trial', 'intro', 'punch_card'].includes(k)) return k;
  if (k === 'punch') return 'punch_card';
  if (k === 'comp') return 'comp';
  return 'membership'; // unlimited, limited, or not set
}
const planInterval = (plan) => (['month', 'year', 'week', 'once'].includes(plan?.interval) ? plan.interval : 'month');
const centsOf = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

async function gymBillingSettings(env) {
  const row = parseRow(await env.DB.prepare(
    `SELECT * FROM entities WHERE entity_type='GymSettings' ORDER BY created_date ASC LIMIT 1`
  ).first());
  return {
    tax_rate_pct: numOr(row?.tax_rate_pct, GYM_BILLING_DEFAULTS.tax_rate_pct),
    bank_discount_pct: numOr(row?.bank_discount_pct, GYM_BILLING_DEFAULTS.bank_discount_pct),
    retry_notice_text: row?.retry_notice_text || '',
  };
}
// Plan's own percentages win; the gym setting is the fallback.
async function planRates(env, plan) {
  const g = await gymBillingSettings(env);
  return {
    tax_rate_pct: numOr(plan?.tax_rate_pct, g.tax_rate_pct),
    bank_discount_pct: numOr(plan?.bank_discount_pct, g.bank_discount_pct),
  };
}
const bankPriceCents = (cents, pct) => Math.max(0, Math.round(cents * (1 - pct / 100)));

// Unix seconds -> gym date key.
const unixToKey = (unix) => (Number(unix) > 0 ? programToday(Number(unix) * 1000) : null);
function addMonthsKey(key, months) {
  const [y, m, d] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}
const idOf = (v) => (typeof v === 'string' ? v : v?.id || null);

// Membership defaults (hooked into normalizeMembership for staff creates).
function gymBillingMembershipDefaults(fields, plan) {
  if (fields.billing_status === undefined || !BILLING_STATUSES.has(fields.billing_status)) fields.billing_status = 'none';
  if (fields.failed_payments === undefined) fields.failed_payments = 0;
  if (fields.commitment_ends === undefined) {
    const months = numOr(plan?.commitment_months, 0);
    fields.commitment_ends = months > 0 && isDateKey(fields.start_date) ? addMonthsKey(fields.start_date, months) : null;
  }
}

// Payment rows: admins and staff with billing.view. Members get theirs only
// through myBilling.
function paymentReadScope(user) {
  if (isStaff(user) && can(user, 'billing.view')) return null;
  return { sql: '0', binds: [] };
}

// Booking rule: a Stripe-linked membership that is past due or unpaid can't
// book. Only when billing is connected; memberships with no Stripe link are
// untouched. -> null | failure result (staff get can_override).
async function gymBillingBookingBlock(env, who, staff) {
  if (!billingConnected(env)) return null;
  const all = await clientMemberships(env, who);
  const bad = all.find((m) => m.stripe_subscription_id && BILLING_BLOCKED.has(m.billing_status) && m.status !== 'ended');
  if (!bad) return null;
  return staff
    ? { success: false, error: 'This client\'s payment didn\'t go through. Ask them to update their card.', code: 'payment_past_due', can_override: true }
    : { success: false, error: 'Your payment didn\'t go through. Update your card to book.', code: 'payment_past_due' };
}

// The Stripe tax rate for a percentage (rates can't change, so one per pct).
async function stripeTaxRateFor(env, pct) {
  const key = `stripe_tax_rate:${pct}`;
  const saved = (await getState(env, key))?.value;
  if (saved) return saved;
  const tr = await stripe(env, 'tax_rates', { data: { display_name: 'Sales tax', percentage: pct, inclusive: false, metadata: { brigade: 'gym' } } });
  await setState(env, key, tr.id);
  return tr.id;
}

// Create or update the plan's Stripe product, card price, bank price and tax
// rate. Prices can't change in Stripe, so a changed amount makes new prices
// and archives the old ones. Returns the patched plan.
async function syncPlan(env, plan) {
  const price = centsOf(plan.price_cents);
  if (!(price > 0)) throw Object.assign(new Error('Set a price for this plan first.'), { code: 'no_price' });
  const interval = planInterval(plan);
  const count = Math.max(1, Math.round(numOr(plan.interval_count, 1)));
  const rates = await planRates(env, plan);
  const bank = bankPriceCents(price, rates.bank_discount_pct);
  const meta = { brigade: 'gym', plan_id: plan.id };
  const patch = {};
  if (plan.stripe_product_id) {
    await stripe(env, `products/${plan.stripe_product_id}`, { data: { name: plan.name || 'Membership', active: plan.is_active !== false } });
  } else {
    const prod = await stripe(env, 'products', { data: { name: plan.name || 'Membership', metadata: meta } });
    patch.stripe_product_id = prod.id;
  }
  const product = patch.stripe_product_id || plan.stripe_product_id;
  const signature = `${price}|${bank}|${interval}|${count}`;
  if (signature !== plan.stripe_price_signature || !plan.stripe_price_id || !plan.stripe_price_bank_id) {
    const recurring = interval === 'once' ? undefined : { interval, interval_count: count };
    const card = await stripe(env, 'prices', { data: { product, currency: 'usd', unit_amount: price, recurring, nickname: 'Card', metadata: { ...meta, method: 'card' } } });
    const bankP = await stripe(env, 'prices', { data: { product, currency: 'usd', unit_amount: bank, recurring, nickname: 'Bank', metadata: { ...meta, method: 'bank' } } });
    for (const old of [plan.stripe_price_id, plan.stripe_price_bank_id]) {
      if (old) await stripe(env, `prices/${old}`, { data: { active: false } }).catch(() => null);
    }
    Object.assign(patch, { stripe_price_id: card.id, stripe_price_bank_id: bankP.id, stripe_price_signature: signature });
  }
  patch.stripe_tax_rate_id = await stripeTaxRateFor(env, rates.tax_rate_pct);
  const fresh = await getEntityById(env, 'MembershipPlan', plan.id);
  await patchEntity(env, fresh, patch);
  return { ...fresh, ...patch };
}

// The client's Stripe customer: saved on the Client (or a membership), else new.
async function stripeCustomerFor(env, client) {
  if (client.stripe_customer_id) return client.stripe_customer_id;
  const mems = await selectEntities(env, 'Membership', `json_extract(data,'$.client_id') = ? AND json_extract(data,'$.stripe_customer_id') IS NOT NULL`, [client.id]);
  let id = mems[0]?.stripe_customer_id;
  if (!id) {
    const c = await stripe(env, 'customers', { data: { email: client.email || undefined, name: client.full_name || undefined, phone: client.phone || undefined, metadata: { brigade: 'gym', client_id: client.id } } });
    id = c.id;
  }
  const fresh = await getEntityById(env, 'Client', client.id);
  if (fresh) await patchEntity(env, fresh, { stripe_customer_id: id });
  return id;
}

/* Internal: start a Stripe Checkout for a plan. Used by startCheckout and by
 * SALES' publicCheckout. No permission checks here: callers do them.
 *   createCheckoutSession(env, { plan, client, method: 'card'|'bank', promo_code?,
 *     agreement_id?, membership_id?, success_url, cancel_url })
 *   -> { success: true, url, session_id } | { success: false, error, code }
 * Recurring plans -> subscription mode; interval 'once' -> payment mode. Bank
 * uses the plan's bank price. The tax rate is applied; promo codes are allowed
 * (or the given one is applied). Kind 'membership' needs a signed Agreement. */
async function createCheckoutSession(env, { plan, client, method = 'card', promo_code, agreement_id, membership_id, success_url, cancel_url } = {}) {
  if (!billingConnected(env)) return GYM_BILLING_NOT_CONNECTED;
  if (!plan || !client) return { success: false, error: 'Plan or member not found.', code: 'not_found' };
  if (plan.is_active === false) return { success: false, error: 'That plan isn\'t available.', code: 'plan_inactive' };
  if (!(centsOf(plan.price_cents) > 0)) return { success: false, error: 'That plan has no price yet.', code: 'no_price' };
  const bank = method === 'bank';
  { // RULES owns the agreement rule
    const no = await requireAgreement(env, plan, agreement_id, { client_id: client.id });
    if (no) return no;
  }
  try {
    const rates = await planRates(env, plan);
    const sig = `${centsOf(plan.price_cents)}|${bankPriceCents(centsOf(plan.price_cents), rates.bank_discount_pct)}|${planInterval(plan)}|${Math.max(1, Math.round(numOr(plan.interval_count, 1)))}`;
    let p = plan;
    if (!p.stripe_price_id || !p.stripe_price_bank_id || p.stripe_price_signature !== sig || !p.stripe_tax_rate_id) p = await syncPlan(env, plan);
    const taxRate = await stripeTaxRateFor(env, rates.tax_rate_pct);
    let discounts;
    if (promo_code) {
      const found = await stripe(env, `promotion_codes?code=${encodeURIComponent(String(promo_code).trim())}&active=true&limit=1`, { method: 'GET' });
      const promo = found?.data?.[0];
      if (!promo) return { success: false, error: 'That promo code isn\'t valid.', code: 'bad_promo' };
      discounts = [{ promotion_code: promo.id }];
    }
    const customer = await stripeCustomerFor(env, client);
    const once = planInterval(p) === 'once';
    const metadata = { brigade: 'gym', client_id: client.id, plan_id: p.id, membership_id: membership_id || undefined, agreement_id: agreement_id || undefined, method: bank ? 'bank' : 'card' };
    const session = await stripe(env, 'checkout/sessions', {
      data: {
        mode: once ? 'payment' : 'subscription',
        customer,
        client_reference_id: client.id,
        payment_method_types: [bank ? 'us_bank_account' : 'card'],
        line_items: [{ price: bank ? p.stripe_price_bank_id : p.stripe_price_id, quantity: 1, tax_rates: [taxRate] }],
        ...(discounts ? { discounts } : { allow_promotion_codes: true }),
        metadata,
        ...(once ? { payment_intent_data: { metadata } } : { subscription_data: { metadata } }),
        success_url, cancel_url,
      },
    });
    return { success: true, url: session.url, session_id: session.id };
  } catch (e) {
    return { success: false, error: e?.code === 'no_price' ? e.message : 'Couldn\'t start checkout. Try again.', code: e?.code || 'stripe_error', detail: String(e?.message || e).slice(0, 200) };
  }
}

// Which client a billing call is about: members -> themselves (or a linked
// child); staff -> client_id, with billing.view (and members.manage to change).
async function billingWho(env, user, clientId, { change = false } = {}) {
  if (isStaff(user)) {
    if (!can(user, 'billing.view') || (change && !can(user, 'members.manage'))) return { denied: true };
  }
  return resolveClassClient(env, user, clientId);
}

const membershipBillingSummary = (m) => ({
  id: m.id, plan_id: m.plan_id || null, plan_name: m.plan_name || '', status: m.status || 'active',
  start_date: m.start_date || null, end_date: m.end_date || null,
  billing_status: m.billing_status || 'none', payment_method: m.payment_method || null,
  card_brand: m.card_brand || null, card_last4: m.card_last4 || null,
  next_payment_date: m.next_payment_date || null, last_payment_date: m.last_payment_date || null,
  commitment_ends: m.commitment_ends || null, failed_payments: numOr(m.failed_payments, 0),
  stripe_linked: !!m.stripe_subscription_id,
});
const paymentSummary = (p) => ({
  id: p.id, membership_id: p.membership_id || null, amount_cents: centsOf(p.amount_cents), tax_cents: centsOf(p.tax_cents),
  discount_cents: centsOf(p.discount_cents), refunded_cents: centsOf(p.refunded_cents), status: p.status, method: p.method || null,
  paid_at: p.paid_at || null, description: p.description || '',
});

async function runGymBillingFunction(name, payload, { env, user, url }) {
  if (!user) return { success: false, error: 'Not logged in' };
  const origin = appOrigin(env, url);
  switch (name) {
    case 'billingStatus':
      return { success: true, connected: billingConnected(env), mode: billingMode(env) };

    case 'syncPlanToStripe': {
      if (!can(user, 'settings.manage') || !can(user, 'billing.view')) return NO_PERMISSION;
      if (!billingConnected(env)) return GYM_BILLING_NOT_CONNECTED;
      const ids = payload?.all ? (await selectEntities(env, 'MembershipPlan', `COALESCE(json_extract(data,'$.is_active'),1) NOT IN (0,'false')`)).filter((p) => centsOf(p.price_cents) > 0).map((p) => p.id) : [payload?.plan_id];
      const synced = []; const failed = [];
      for (const id of ids) {
        const plan = await getEntityById(env, 'MembershipPlan', id);
        if (!plan) { failed.push({ plan_id: id, error: 'Plan not found.' }); continue; }
        try {
          const p = await syncPlan(env, plan);
          synced.push({ plan_id: p.id, name: p.name, stripe_product_id: p.stripe_product_id, stripe_price_id: p.stripe_price_id, stripe_price_bank_id: p.stripe_price_bank_id, stripe_tax_rate_id: p.stripe_tax_rate_id });
          await audit(env, { actor: user.email, action: 'billing_plan_synced', target: 'MembershipPlan', targetId: p.id, detail: `${p.name}: ${p.stripe_price_id} / ${p.stripe_price_bank_id}`, request: null });
        } catch (e) {
          failed.push({ plan_id: id, name: plan.name, error: e?.code === 'no_price' ? e.message : 'Stripe didn\'t accept this plan.' });
        }
      }
      if (!payload?.all && failed.length) return { success: false, error: failed[0].error, failed };
      return { success: true, synced, failed, plan: synced[0] || null };
    }

    case 'startCheckout': {
      if (!billingConnected(env)) return GYM_BILLING_NOT_CONNECTED;
      const who = await billingWho(env, user, payload?.client_id, { change: true });
      if (who.denied) return NO_PERMISSION;
      if (who.error) return { success: false, error: who.error, code: 'no_client' };
      const plan = await getEntityById(env, 'MembershipPlan', payload?.plan_id);
      if (!plan) return { success: false, error: 'Plan not found.', code: 'not_found' };
      const method = payload?.method === 'bank' ? 'bank' : 'card';
      const r = await createCheckoutSession(env, {
        plan, client: who.client, method, promo_code: payload?.promo_code || undefined, agreement_id: payload?.agreement_id || undefined,
        membership_id: payload?.membership_id || undefined,
        success_url: `${origin}/Settings?billing=success`, cancel_url: `${origin}/Settings?billing=cancelled`,
      });
      if (r.success) await audit(env, { actor: user.email, action: 'billing_checkout_started', target: 'Client', targetId: who.client.id, detail: `${plan.name} (${method})${payload?.promo_code ? ` promo ${String(payload.promo_code).slice(0, 30)}` : ''}`, request: null });
      return r;
    }

    case 'billingPortal': {
      if (!billingConnected(env)) return GYM_BILLING_NOT_CONNECTED;
      const who = await billingWho(env, user, payload?.client_id);
      if (who.denied) return NO_PERMISSION;
      if (who.error) return { success: false, error: who.error, code: 'no_client' };
      const mems = await clientMemberships(env, who);
      const customer = who.client.stripe_customer_id || mems.find((m) => m.stripe_customer_id)?.stripe_customer_id;
      if (!customer) return { success: false, error: 'There\'s no card on file yet.', code: 'no_customer' };
      try {
        const s = await stripe(env, 'billing_portal/sessions', { data: { customer, return_url: `${origin}/Settings` } });
        return { success: true, url: s.url };
      } catch {
        return { success: false, error: 'Couldn\'t open billing. Try again.', code: 'stripe_error' };
      }
    }

    case 'myBilling': {
      const who = await billingWho(env, user, payload?.client_id);
      if (who.denied) return NO_PERMISSION;
      if (who.error) return { success: false, error: who.error, code: 'no_client' };
      const mems = await clientMemberships(env, who);
      const payments = (await selectEntities(env, 'Payment', `json_extract(data,'$.client_id') IN (${inList(who.clientIds)})`, who.clientIds))
        .sort((a, b) => String(b.paid_at || b.created_date).localeCompare(String(a.paid_at || a.created_date)))
        .slice(0, 50);
      const memberships = mems.filter((m) => m.status !== 'ended' || m.stripe_subscription_id).map(membershipBillingSummary);
      return {
        success: true, connected: billingConnected(env), mode: billingMode(env),
        client_id: who.client.id,
        past_due: memberships.some((m) => m.stripe_linked && BILLING_BLOCKED.has(m.billing_status)),
        has_card: !!(who.client.stripe_customer_id || mems.some((m) => m.stripe_customer_id)),
        memberships, payments: payments.map(paymentSummary),
      };
    }
    default:
      return { __unimplemented: true };
  }
}

/* ---- webhooks ---- */
// Gym events carry metadata.brigade = 'gym' (set at checkout) or point at a
// membership/payment we already know.
const metaOf = (o) => ({ ...(o?.subscription_details?.metadata || {}), ...(o?.parent?.subscription_details?.metadata || {}), ...(o?.metadata || {}) });
const subIdOf = (o) => idOf(o?.subscription) || idOf(o?.parent?.subscription_details?.subscription) || null;
const piIdOf = (o) => idOf(o?.payment_intent) || idOf(o?.payments?.data?.[0]?.payment?.payment_intent) || null;

async function membershipBySub(env, subId) {
  if (!subId) return null;
  return (await selectEntities(env, 'Membership', `json_extract(data,'$.stripe_subscription_id') = ?`, [subId]))[0] || null;
}
async function paymentBy(env, field, value) {
  if (!value) return null;
  return (await selectEntities(env, 'Payment', `json_extract(data,'$.${field}') = ?`, [value]))[0] || null;
}
async function isGymBillingEvent(env, event) {
  const o = event?.data?.object || {};
  const meta = metaOf(o);
  if (meta.brigade === 'gym' || meta.client_id) return true;
  if (event.type === 'charge.refunded') return !!(await paymentBy(env, 'stripe_payment_intent_id', piIdOf(o)) || await paymentBy(env, 'stripe_invoice_id', idOf(o.invoice)));
  const sub = event.type?.startsWith('customer.subscription.') ? o.id : subIdOf(o);
  return !!(await membershipBySub(env, sub));
}

// Card/bank details and period end from the subscription (expanded).
async function subscriptionDetails(env, subId) {
  try {
    const sub = await stripe(env, `subscriptions/${subId}?expand[]=default_payment_method`, { method: 'GET' });
    return subFields(sub);
  } catch { return {}; }
}
function subFields(sub) {
  const out = {};
  const pm = sub?.default_payment_method;
  if (pm && typeof pm === 'object') {
    if (pm.card) Object.assign(out, { card_brand: pm.card.brand || null, card_last4: pm.card.last4 || null, payment_method: 'card' });
    else if (pm.us_bank_account) Object.assign(out, { card_brand: pm.us_bank_account.bank_name || 'Bank', card_last4: pm.us_bank_account.last4 || null, payment_method: 'bank' });
  }
  const end = sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end;
  if (end) out.next_payment_date = unixToKey(end);
  return out;
}
function statusFromSub(sub, current) {
  if (current === 'comped') return 'comped';
  if (sub.pause_collection) return 'paused';
  return { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'unpaid', canceled: 'canceled', incomplete: 'past_due', incomplete_expired: 'canceled', paused: 'paused' }[sub.status] || current || 'none';
}

async function upsertPayment(env, existing, fields) {
  if (existing) { await patchEntity(env, existing, fields); return { ...existing, ...fields }; }
  return insertEntity(env, 'Payment', fields, 'stripe');
}

async function notifyBillingMember(env, membership, { title, message }) {
  const client = await getEntityById(env, 'Client', membership.client_id);
  const login = await clientLogin(env, client);
  if (!login) return false;
  await insertEntity(env, 'Notification', { user_id: login.id, type: 'billing', title, message, link: '/Settings', read: false }, 'system');
  const p = sendPushToUser(env, login.id, { title, body: String(message).slice(0, 140), url: '/Settings', tag: 'billing' });
  if (env.__waitUntil) env.__waitUntil(p); else await p;
  return true;
}

async function handleCheckoutCompleted(env, s) {
  const meta = metaOf(s);
  const client = await getEntityById(env, 'Client', meta.client_id);
  const plan = await getEntityById(env, 'MembershipPlan', meta.plan_id);
  if (!client || !plan) return 'unknown client or plan';
  const subId = idOf(s.subscription);
  const customer = idOf(s.customer);
  const method = meta.method === 'bank' || (s.payment_method_types || []).includes('us_bank_account') ? 'bank' : 'card';
  // Link: the membership named at checkout, the one already on this
  // subscription, an unlinked live one on this plan, or a new one.
  let m = (meta.membership_id && await getEntityById(env, 'Membership', meta.membership_id)) || await membershipBySub(env, subId);
  if (!m) {
    m = (await selectEntities(env, 'Membership', `json_extract(data,'$.client_id') = ? AND json_extract(data,'$.plan_id') = ?`, [client.id, plan.id]))
      .find((x) => x.status !== 'ended' && !x.stripe_subscription_id && (!isDateKey(x.end_date) || x.end_date >= programToday())) || null;
  }
  if (!m) {
    const fields = { client_id: client.id, plan_id: plan.id, start_date: programToday(), status: 'active' };
    await normalizeMembership(env, fields);
    m = await insertEntity(env, 'Membership', fields, 'stripe');
  }
  const patch = {
    stripe_customer_id: customer || m.stripe_customer_id || null,
    stripe_subscription_id: subId || m.stripe_subscription_id || null,
    payment_method: method,
    agreement_id: meta.agreement_id || m.agreement_id || null,
    billing_status: subId ? 'active' : (m.billing_status || 'none'),
    failed_payments: 0,
  };
  if (!m.commitment_ends && numOr(plan.commitment_months, 0) > 0) patch.commitment_ends = addMonthsKey(isDateKey(m.start_date) ? m.start_date : programToday(), Number(plan.commitment_months));
  if (subId) Object.assign(patch, await subscriptionDetails(env, subId));
  if (!subId && s.payment_status === 'paid') {
    const pi = piIdOf(s);
    await upsertPayment(env, await paymentBy(env, 'stripe_payment_intent_id', pi), {
      client_id: client.id, membership_id: m.id, stripe_invoice_id: idOf(s.invoice), stripe_payment_intent_id: pi,
      amount_cents: centsOf(s.amount_total), tax_cents: centsOf(s.total_details?.amount_tax), discount_cents: centsOf(s.total_details?.amount_discount),
      refunded_cents: 0, status: 'paid', method, paid_at: s.created ? new Date(s.created * 1000).toISOString() : nowISO(), description: plan.name || 'Payment',
    });
    patch.last_payment_date = programToday();
  }
  const fresh = await getEntityById(env, 'Membership', m.id);
  await patchEntity(env, fresh, patch);
  if (customer && client.stripe_customer_id !== customer) await patchEntity(env, client, { stripe_customer_id: customer });
  return `membership ${m.id} linked`;
}

async function handleInvoice(env, inv, paid) {
  const meta = metaOf(inv);
  const m = await membershipBySub(env, subIdOf(inv)) || (meta.membership_id && await getEntityById(env, 'Membership', meta.membership_id));
  if (!m) return 'no membership';
  const existing = await paymentBy(env, 'stripe_invoice_id', inv.id);
  const taxes = Array.isArray(inv.total_taxes) ? inv.total_taxes.reduce((n, t) => n + centsOf(t.amount), 0)
    : Array.isArray(inv.total_tax_amounts) ? inv.total_tax_amounts.reduce((n, t) => n + centsOf(t.amount), 0) : centsOf(inv.tax);
  const discount = Array.isArray(inv.total_discount_amounts) ? inv.total_discount_amounts.reduce((n, d) => n + centsOf(d.amount), 0) : 0;
  const line = inv.lines?.data?.[0];
  const base = {
    client_id: m.client_id, membership_id: m.id, stripe_invoice_id: inv.id, stripe_payment_intent_id: piIdOf(inv),
    tax_cents: taxes, discount_cents: discount, method: m.payment_method || 'card',
    description: line?.description || m.plan_name || 'Membership',
  };
  if (paid) {
    const paidAt = inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000).toISOString() : nowISO();
    await upsertPayment(env, existing, { ...base, amount_cents: centsOf(inv.amount_paid ?? inv.total), refunded_cents: centsOf(existing?.refunded_cents), status: existing?.status === 'refunded' || existing?.status === 'partially_refunded' ? existing.status : 'paid', paid_at: paidAt });
    const patch = { failed_payments: 0, past_due_since: null, last_payment_date: programToday(Date.parse(paidAt)) };
    if (!['comped', 'paused', 'canceled'].includes(m.billing_status)) patch.billing_status = 'active';
    if (line?.period?.end) patch.next_payment_date = unixToKey(line.period.end);
    await patchEntity(env, await getEntityById(env, 'Membership', m.id), patch);
    return 'paid';
  }
  if (!existing || existing.status === 'failed') {
    await upsertPayment(env, existing, { ...base, amount_cents: centsOf(inv.amount_due ?? inv.total), refunded_cents: 0, status: 'failed', paid_at: null });
  }
  const failed = numOr(m.failed_payments, 0) + 1;
  await patchEntity(env, await getEntityById(env, 'Membership', m.id), { billing_status: 'past_due', failed_payments: failed, past_due_since: m.billing_status === 'past_due' && m.past_due_since ? m.past_due_since : programToday() });
  const g = await gymBillingSettings(env);
  await notifyBillingMember(env, m, {
    title: 'Your payment didn\'t go through',
    message: g.retry_notice_text || 'We couldn\'t take your membership payment. Update your card in Settings to keep booking classes.',
  });
  return `failed (${failed})`;
}

async function handleSubscription(env, sub, deleted) {
  const m = await membershipBySub(env, sub.id) || (metaOf(sub).membership_id && await getEntityById(env, 'Membership', metaOf(sub).membership_id));
  if (!m) return 'no membership';
  const patch = { ...subFields(sub), stripe_subscription_id: sub.id };
  if (deleted) {
    patch.billing_status = m.billing_status === 'comped' ? 'comped' : 'canceled';
    patch.next_payment_date = null;
    if (!isDateKey(m.end_date)) patch.end_date = programToday();
  } else {
    patch.billing_status = statusFromSub(sub, m.billing_status);
  }
  await patchEntity(env, await getEntityById(env, 'Membership', m.id), patch);
  return patch.billing_status;
}

async function handleRefund(env, charge) {
  const p = await paymentBy(env, 'stripe_payment_intent_id', piIdOf(charge)) || await paymentBy(env, 'stripe_invoice_id', idOf(charge.invoice));
  if (!p) return 'no payment';
  const refunded = centsOf(charge.amount_refunded);
  const total = centsOf(p.amount_cents) || centsOf(charge.amount);
  await patchEntity(env, p, { ...(refunded > centsOf(p.refunded_cents) ? { refunded_at: nowISO() } : {}), refunded_cents: refunded, status: refunded >= total ? 'refunded' : refunded > 0 ? 'partially_refunded' : p.status });
  return `refunded ${refunded}`;
}

const GYM_EVENT_TYPES = new Set(['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded']);

// Apply one verified event. Same event id twice = applied once.
async function processGymBillingEvent(env, event, request) {
  if (!event?.id || !GYM_EVENT_TYPES.has(event.type)) return { received: true, ignored: true };
  const key = `stripe_evt:${event.id}`;
  const claim = await env.DB.prepare(
    'INSERT INTO app_state (key, value, updated_date) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING'
  ).bind(key, event.type, nowISO()).run();
  if (!claim?.meta?.changes) return { received: true, duplicate: true };
  const o = event.data?.object || {};
  let result;
  try {
    if (event.type === 'checkout.session.completed') result = await handleCheckoutCompleted(env, o);
    else if (event.type === 'invoice.paid') result = await handleInvoice(env, o, true);
    else if (event.type === 'invoice.payment_failed') result = await handleInvoice(env, o, false);
    else if (event.type === 'customer.subscription.updated') result = await handleSubscription(env, o, false);
    else if (event.type === 'customer.subscription.deleted') result = await handleSubscription(env, o, true);
    else if (event.type === 'charge.refunded') result = await handleRefund(env, o);
  } catch (e) {
    // Let Stripe retry: forget the claim.
    await env.DB.prepare('DELETE FROM app_state WHERE key = ?').bind(key).run();
    throw e;
  }
  await audit(env, { actor: 'stripe', action: `gym_billing_${event.type.replace(/\./g, '_')}`, target: 'Membership', targetId: o.id || '', detail: String(result || ''), request });
  return { received: true, result };
}

// POST /api/stripe/gym-webhook (the old /api/stripe/webhook also forwards gym events here).
async function handleGymWebhook(request, env) {
  const raw = await request.text();
  const ok = await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_GYM_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return err('Invalid signature.', 400);
  let event;
  try { event = JSON.parse(raw); } catch { return err('Bad payload.', 400); }
  try {
    return json(await processGymBillingEvent(env, event, request));
  } catch (e) {
    await recordError(env, { source: 'job', message: `Stripe webhook ${event?.type}: ${String(e?.message || e).slice(0, 200)}`, page: 'billing' });
    return err('Webhook failed.', 500);
  }
}
// ===== end Phase 4: CORE =====

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


/* ------------------------------ Ask Brigade ------------------------------ */
// A chat assistant for members (and parents). It reads through the same
// functions the screens use, so every rule still applies, and it never books or
// cancels by itself: it proposes an action and the member taps Confirm, which
// calls bookClass / cancelReservation like the buttons do.
const ASK_LIMIT_PER_HOUR = 40;
const ASK_MAX_TURNS = 12;
const ASK_MAX_CHARS = 1500;
const ASK_TOOLS = [
  { name: 'list_classes', description: 'Classes on the gym schedule between two dates (YYYY-MM-DD, at most 14 days), with spots left and whether the member is already booked. Use for "what classes are tomorrow", "is 6am full", and before proposing a booking.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, for_child_id: { type: 'string', description: 'Only when acting for one of the member\'s linked children (id from my_family).' } }, required: ['from', 'to'] } },
  { name: 'my_bookings', description: 'The member\'s upcoming bookings and waitlist spots, recent visits, and membership (plan, holds, end date).',
    input_schema: { type: 'object', properties: { for_child_id: { type: 'string' } } } },
  { name: 'my_family', description: 'Children the member can book for, if any.', input_schema: { type: 'object', properties: {} } },
  { name: 'propose_booking', description: 'Offer to book a class (or join its waitlist if full). Does NOT book: the member must tap Confirm. Call list_classes first to get the class id.',
    input_schema: { type: 'object', properties: { session_id: { type: 'string' }, for_child_id: { type: 'string' } }, required: ['session_id'] } },
  { name: 'propose_cancel', description: 'Offer to cancel one of the member\'s bookings or waitlist spots. Does NOT cancel: the member must tap Confirm. Get the booking id from my_bookings or list_classes.',
    input_schema: { type: 'object', properties: { reservation_id: { type: 'string' } }, required: ['reservation_id'] } },
];
const fmtClassTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: PROGRAM_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const compactSession = (c) => ({
  id: c.id, when: fmtClassTime(c.start_at), date: c.date, class: c.class_type_name, coach: c.coach_name || null,
  status: c.status, spots_left: c.spots_left ?? null, full: !!c.is_full, waitlist: c.waitlist_enabled !== false,
  booking_opens: fmtClassTime(c.windows?.booking_opens_at), booking_closes: fmtClassTime(c.windows?.booking_closes_at),
  late_cancel_after: fmtClassTime(c.windows?.late_cancel_at),
  mine: c.my_reservation ? { reservation_id: c.my_reservation.id, status: c.my_reservation.status, waitlist_position: c.my_reservation.waitlist_position } : null,
});
async function askTool(name, input, ctx, actions) {
  const child = input?.for_child_id ? String(input.for_child_id) : null;
  if (name === 'list_classes') {
    const from = isDateKey(input?.from) ? input.from : programToday();
    let to = isDateKey(input?.to) ? input.to : from;
    if (to < from) to = from;
    if (pDaysBetween(from, to) > 14) to = pAddDays(from, 14);
    const r = await runFunction('classSchedule', { from, to, ...(child ? { client_id: child } : {}) }, ctx);
    if (r?.success === false) return { error: r.error };
    return { classes: (r.sessions || []).filter((c) => c.status !== 'cancelled').map(compactSession) };
  }
  if (name === 'my_bookings') {
    const r = await runFunction('myClasses', child ? { client_id: child } : {}, ctx);
    if (r?.success === false) return { error: r.error };
    const pick = (x) => ({ reservation_id: x.id, when: fmtClassTime(x.start_at), class: x.class_type_name || x.class_name, status: x.status, waitlist_position: x.waitlist_position ?? null });
    return {
      upcoming: (r.upcoming || []).map(pick), recent: (r.recent || []).slice(0, 5).map(pick),
      memberships: (r.memberships || []).map((m) => ({ plan: m.plan_name || m.name, status: m.status, end_date: m.end_date || null, hold_from: m.hold_from || null, hold_to: m.hold_to || null })),
      on_hold: r.hold_now || null, notice: r.notice || null,
    };
  }
  if (name === 'my_family') {
    const r = await runFunction('myFamily', {}, ctx);
    return { children: r?.children || [] };
  }
  if (name === 'propose_booking') {
    const session = await getEntityById(ctx.env, 'ClassSession', String(input?.session_id || ''));
    if (!session || session.status !== 'scheduled') return { error: 'That class was not found or is cancelled.' };
    let who = 'you';
    if (child) {
      const fam = await runFunction('myFamily', {}, ctx);
      const kid = (fam?.children || []).find((c) => c.id === child);
      if (!kid) return { error: 'That child is not linked to this account.' };
      who = kid.full_name;
    }
    const summary = `Book ${who === 'you' ? '' : `${who} into `}${session.class_type_name} on ${fmtClassTime(session.start_at)}`;
    actions.push({ kind: 'book', session_id: session.id, ...(child ? { client_id: child } : {}), summary });
    return { proposed: summary, note: 'Shown to the member with a Confirm button. Tell them to tap Confirm; do not say it is booked.' };
  }
  if (name === 'propose_cancel') {
    const resv = await getEntityById(ctx.env, 'Reservation', String(input?.reservation_id || ''));
    const mineIds = await actableClientIds(ctx.env, ctx.user);
    if (!resv || (!mineIds.includes(resv.client_id) && resv.client_user_id !== ctx.user.id)) return { error: 'That booking was not found.' };
    if (!['reserved', 'waitlisted'].includes(resv.status)) return { error: 'That booking can no longer be cancelled.' };
    const session = await getEntityById(ctx.env, 'ClassSession', resv.session_id);
    const late = session && Date.now() >= Date.parse(sessionWindows(session, await getGymSettings(ctx.env)).late_cancel_at || 0) && resv.status === 'reserved';
    const summary = `Cancel ${resv.status === 'waitlisted' ? 'waitlist spot for ' : ''}${session?.class_type_name || 'class'} on ${fmtClassTime(session?.start_at || resv.start_at)}${late ? ' (late cancel)' : ''}`;
    actions.push({ kind: 'cancel', reservation_id: resv.id, summary, late: !!late });
    return { proposed: summary, late_cancel: !!late, note: 'Shown with a Confirm button. Do not say it is cancelled.' };
  }
  return { error: 'Unknown tool.' };
}
async function askBrigade(env, user, url, payload) {
  if (!env.LLM_API_KEY) return { success: false, error: 'Ask Brigade isn\'t switched on yet.' };
  const since = new Date(Date.now() - 3600000).toISOString();
  const used = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE actor = ? AND action = 'ask_brigade' AND created_date > ?`).bind(user.email, since).first();
  if ((used?.n || 0) >= ASK_LIMIT_PER_HOUR) return { success: false, error: 'You\'ve asked a lot this hour. Try again a bit later.' };
  const turns = (Array.isArray(payload?.messages) ? payload.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-ASK_MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.text.slice(0, ASK_MAX_CHARS) }));
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== 'user') return { success: false, error: 'Type a question first.' };
  await audit(env, { actor: user.email, action: 'ask_brigade', request: null });
  const now = new Date().toLocaleString('en-US', { timeZone: PROGRAM_TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const system = [
    'You are Ask Brigade, the assistant inside the Brigade Athletic Club app. Brigade is a CrossFit and strength gym.',
    `Right now it is ${now} (gym time, US Eastern). Today's date is ${programToday()}. Resolve "today", "tomorrow", "Thursday" from this.`,
    `You are talking with ${user.full_name || 'a member'}. Refer to people neutrally (they/them) unless told otherwise.`,
    'Keep answers short and plain: a sentence or two, or a short list. No markdown headings.',
    'Classes: use the tools to look things up. Never say a class is booked or cancelled. To book or cancel, call propose_booking or propose_cancel; the member then sees a Confirm button. If a class is full and has a waitlist, booking puts them on the waitlist; say so.',
    'If the member mentions a child, call my_family and act for that child with for_child_id.',
    'General fitness and nutrition questions (calories, protein, macros, technique, scaling, recovery): answer from your own knowledge. For branded or restaurant items say the number is an estimate. Give typical ranges for macros and suggest they confirm targets with their coach.',
    'Never diagnose injuries or illness; suggest talking with their coach or a doctor. You cannot change memberships, payments or accounts; point them to the front desk.',
  ].join('\n');
  const client = new Anthropic({ apiKey: env.LLM_API_KEY });
  const ctx = { env, user, url };
  const actions = [];
  const messages = [...turns];
  try {
    for (let step = 0; step < 6; step += 1) {
      const res = await client.messages.create({
        model: env.ASK_MODEL || env.LLM_MODEL || CLAUDE_DEFAULT_MODEL,
        max_tokens: 1200,
        system,
        tools: ASK_TOOLS,
        messages,
      });
      if (res.stop_reason === 'refusal') return { success: true, reply: 'I can\'t help with that one. Try asking your coach.', actions: [] };
      const uses = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) {
        const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        return { success: true, reply: reply || 'Done.', actions };
      }
      messages.push({ role: 'assistant', content: res.content });
      const results = [];
      for (const u of uses) {
        let out;
        try { out = await askTool(u.name, u.input || {}, ctx, actions); } catch (e) { out = { error: 'That lookup failed.' }; console.error('ask tool', u.name, e?.message); }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { success: true, reply: 'That took too many steps. Try asking in a simpler way.', actions };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error('ask brigade: check LLM_API_KEY');
    else console.error('ask brigade failed', e?.message);
    return { success: false, error: 'Ask Brigade is having trouble right now. Try again in a minute.' };
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
    ...GUARDIAN_SCHEMA,
  ];
  for (const s of stmts) await env.DB.prepare(s).run();
  await seedCoachingContent(env);
  await ensureWorkoutLibrary(env); // Phase 3 editor: sample movements + benchmarks
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
        if (!emailReady(env)) return json({ success: true, email_enabled: false });
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
          const { _rights: _r, _staffRole: _k, _roleName: roleName, ...pub } = user;
          return json({ ...pub, staff_role: staffRole(user), role_name: staffRole(user) === 'admin' ? 'Admin' : roleName || null, permissions: permissionsOf(user) });
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
          const PROTECTED = ['id', 'email', 'role', 'user_type', 'password_hash', 'beta_key_used', 'beta_key_verified', 'beta_key', 'billing', 'disabled', 'staff_role', 'sessions_valid_from', 'created_date', 'updated_date'];
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
          return json((await listEntities(env, type, { filter, sort, limit, user })).map((r) => redactFor(user, type, r)));
        }
        if (method === 'POST') {
          const body = await request.json();
          const list = Array.isArray(body) ? body : [body];

          const created = [];
          const prepared = [];
          for (const item of list) {
            const { id: _i, created_date: _c, updated_date: _u, created_by: _b, ...fields } = item || {};
            if (staffWriteDenied(type, user)) return err(isStaff(user) ? 'Your role doesn\'t allow this. Ask an admin.' : 'Only coaches can change this.', 403);
            const violation = await memberWriteViolation(env, user, type, fields);
            if (violation) return err(violation, 403);
            const staffLimit = staffFieldViolation(user, type, fields);
            if (staffLimit) return err(staffLimit, 403);
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
            if (type === 'Movement' || type === 'Benchmark') normalizeLibraryFields(type, fields); // Phase 3 editor
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
          return json(redactFor(user, type, rowToEntity(row)));
        }
        if (method === 'PUT') {
          const row = await getScopedEntity(env, type, id, user);
          if (!row) return err('Not found.', 404);
          const body = await request.json();
          const data = JSON.parse(row.data || '{}');
          const { id: _i, created_date: _c, updated_date: _u, created_by: _b, ...fields } = body || {};
          if (staffWriteDenied(type, user)) return err(isStaff(user) ? 'Your role doesn\'t allow this. Ask an admin.' : 'Only coaches can change this.', 403);
          const violation = await memberWriteViolation(env, user, type, fields, data);
          if (violation) return err(violation, 403);
          const staffLimit = staffFieldViolation(user, type, fields, data);
          if (staffLimit) return err(staffLimit, 403);
          if (sharedWriteDenied(type, row, user, fields)) return err('Only the author can edit this.', 403);
          if (type === 'ClassSession' && isStaff(user)) await normalizeClassSession(env, fields, data);
          if (type === 'Movement' || type === 'Benchmark') normalizeLibraryFields(type, fields); // Phase 3 editor
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
          return json(redactFor(user, type, { ...merged, id, created_by: row.created_by, created_date: row.created_date, updated_date: now }));
        }
        if (method === 'DELETE') {
          const row = await getScopedEntity(env, type, id, user);
          if (!row) return err('Not found.', 404);
          if (sharedWriteDenied(type, row, user)) return err('Only the author can delete this.', 403);
          if (staffWriteDenied(type, user)) return err(isStaff(user) ? 'Your role doesn\'t allow this. Ask an admin.' : 'Only coaches can change this.', 403);
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
      if (segs[1] === 'gym-webhook' && method === 'POST') return handleGymWebhook(request, env); // Phase 4 CORE
      // Webhook first: it is unauthenticated by design and verified by signature.
      if (segs[1] === 'webhook' && method === 'POST') {
        const raw = await request.text();
        const ok = await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
        if (!ok) return err('Invalid signature.', 400);

        let event;
        try { event = JSON.parse(raw); } catch { return err('Bad payload.', 400); }
        if (await isGymBillingEvent(env, event)) return json(await processGymBillingEvent(env, event, request)); // Phase 4 CORE
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
      let reminders;
      try { reminders = await runClassReminders(env); } catch (e) { reminders = { success: false, error: String(e?.message || e).slice(0, 200) }; }
      if (classes?.success === false) await recordError(env, { source: 'job', message: classes.error, page: 'classes' });
      if (reminders?.success === false) await recordError(env, { source: 'job', message: reminders.error, page: 'class reminders' });
      if (programs?.success === false) await recordError(env, { source: 'job', message: programs.error, page: 'programs' });
      const scheduleReminders = await runScheduleReminders(env).catch((e) => ({ success: false, error: String(e?.message || e).slice(0, 200) })); // Scheduling: REMIND
      if (scheduleReminders?.success === false) await recordError(env, { source: 'job', message: scheduleReminders.error, page: 'schedule reminders' }); // Scheduling: REMIND
      const billingRules = await runBillingRenewals(env).catch((e) => ({ success: false, error: String(e?.message || e).slice(0, 200) })); // Phase 4: RULES
      await setState(env, 'cron_last_ok', 'ok');
      return json({ ...programs, classes, reminders, billingRules, scheduleReminders });
    }

    // ===== Scheduling: REMIND (calendar feed route) =====
    // Public: the secret token in the path is the only auth. Never log it.
    if (segs[0] === 'calendar' && segs.length === 2) return serveCalendarFeed(env, request, segs[1]);
    // ===== end Scheduling: REMIND (calendar feed route) =====

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
      const result = await runFunction(name, payload, { env, user, url, request });
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
