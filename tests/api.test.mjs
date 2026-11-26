import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN, CRON_SECRET } from './server.mjs';
import { makeAuthenticator } from './authenticator.mjs';

let srv; let api; let admin; let coach;
const members = {}; // name -> { token, client, email, password }
let crossfit; let openGym; let unlimited;
const PW = 'member-pass-1';
let seq = 0;

async function addMember(name, { plan = unlimited, membership = {} } = {}) {
  const email = `${name}@example.test`;
  const c = await api.create('Client', { full_name: `${name} Tester`, email, status: 'active' }, coach.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, coach.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: `${name} Tester`, password: PW });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  if (plan) await api.create('Membership', { client_id: c.id, plan_id: plan.id, start_date: addDays(eastern().date, -30), status: 'active', ...membership }, coach.token);
  members[name] = { token: reg.data.token, client: c, email, id: reg.data.user.id };
  return members[name];
}
// A one-off class; `hoursOut` from now in gym time.
const makeClass = (hoursOut, extra = {}) => {
  const { date, time } = eastern(Date.now() + hoursOut * 3600000);
  seq += 1;
  return api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: `Class ${seq}`, date, start_time: time, duration_min: 60, slot_id: null, ...extra }, coach.token);
};
const book = (m, s, extra = {}) => api.fn('bookClass', { session_id: s.id, ...extra }, m.token);
const roster = async (s) => (await api.fn('classRoster', { session_id: s.id }, coach.token));

before(async () => {
  srv = await startServer();
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  admin = { token: first.data.token, id: first.data.user.id };
  const inv = await api.fn('createInvite', { email: 'coach@example.test', full_name: 'Cody Coach' }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Cody Coach', password: 'coach-pass-1' });
  coach = { token: reg.data.token, id: reg.data.user.id };
  crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, coach.token);
  openGym = await api.create('ClassType', { name: 'Open Gym', reservable: false, default_capacity: null, default_duration_min: 60, is_active: true }, coach.token);
  unlimited = await api.create('MembershipPlan', { name: 'Unlimited', kind: 'unlimited', class_type_ids: [], is_active: true }, coach.token);
  await api.create('GymSettings', { waiver_required: false }, coach.token);
  for (const n of ['alice', 'bob', 'cara']) await addMember(n);
});
after(() => srv?.stop());

/* ---------------- accounts ---------------- */
test('strangers cannot create an account of any type', async () => {
  for (const body of [
    { email: 'x1@example.test', password: PW, user_type: 'independent' },
    { email: 'x2@example.test', password: PW, user_type: 'client' },
    { email: 'x3@example.test', password: PW, user_type: 'trainer', beta_key: 'ANY' },
    { email: 'alice@example.test', password: PW, user_type: 'client' },
  ]) assert.equal((await api.call('POST', 'auth/register', body)).status, 403, body.email);
});
test('an unclaimed admin email cannot be registered by a stranger', async () => {
  const r = await api.call('POST', 'auth/register', { email: 'second.admin@example.test', password: PW });
  assert.equal(r.status, 403);
});
test('invite links: wrong, used, replaced and tampered links fail', async () => {
  assert.equal((await api.call('POST', 'auth/link-info', { token: 'nope' })).status, 410);
  assert.equal((await api.call('POST', 'auth/register', { token: { $ne: 1 }, password: PW })).status, 410);
  const c = await api.create('Client', { full_name: 'Link Test', email: 'link@example.test', status: 'active' }, coach.token);
  const one = await api.fn('createInvite', { client_id: c.id }, coach.token);
  const two = await api.fn('createInvite', { client_id: c.id }, coach.token);
  assert.equal((await api.call('POST', 'auth/link-info', { token: tokenOf(one.link) })).status, 410, 'old link off');
  const info = await api.call('POST', 'auth/link-info', { token: tokenOf(two.link) });
  assert.equal(info.data.email, 'link@example.test');
  // The link decides who the account is for, not the request.
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(two.link), email: ADMIN.email, user_type: 'trainer', role: 'admin', password: PW });
  assert.equal(reg.data.user.email, 'link@example.test');
  assert.equal(reg.data.user.user_type, 'client');
  assert.notEqual(reg.data.user.role, 'admin');
  assert.equal((await api.call('POST', 'auth/register', { token: tokenOf(two.link), password: PW })).status, 410, 'works once');
  const linked = (await api.call('GET', `entities/Client/${c.id}`, undefined, coach.token)).data;
  assert.equal(linked.user_id, reg.data.user.id, 'client record is tied to the login');
});
test('two people opening one invite at once: only one account', async () => {
  const c = await api.create('Client', { full_name: 'Race', email: 'race@example.test', status: 'active' }, coach.token);
  const t = tokenOf((await api.fn('createInvite', { client_id: c.id }, coach.token)).link);
  const rs = await Promise.all([1, 2, 3].map(() => api.call('POST', 'auth/register', { token: t, password: PW })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
});
test('short passwords are refused and do not use up the link', async () => {
  const c = await api.create('Client', { full_name: 'Shorty', email: 'short@example.test', status: 'active' }, coach.token);
  const t = tokenOf((await api.fn('createInvite', { client_id: c.id }, coach.token)).link);
  assert.equal((await api.call('POST', 'auth/register', { token: t, password: 'short' })).status, 400);
  assert.equal((await api.call('POST', 'auth/register', { token: t, password: PW })).status, 200);
});
test('who may invite and reset', async () => {
  const a = members.alice;
  assert.equal((await api.fn('createInvite', { client_id: a.client.id }, a.token)).success, false, 'member');
  assert.equal((await api.fn('createInvite', { email: 'n@example.test' }, coach.token)).success, false, 'coach inviting coach');
  assert.equal((await api.fn('createInvite', { client_id: a.client.id }, coach.token)).code, 'has_account');
  assert.equal((await api.fn('createResetLink', { client_id: a.client.id }, coach.token)).success, false, 'coach reset');
  assert.equal((await api.fn('createResetLink', { user_id: admin.id }, a.token)).success, false, 'member reset');
  assert.equal((await api.fn('listTeam', {}, coach.token)).success, false);
  assert.equal((await api.call('POST', 'functions/createInvite', { email: 'n@example.test' })).status, 401, 'signed out');
});
test('password reset: works once, signs out old sessions', async () => {
  const m = await addMember('reset');
  const old = m.token;
  await new Promise((r) => setTimeout(r, 1100));
  const link = (await api.fn('createResetLink', { client_id: m.client.id }, admin.token)).link;
  const t = tokenOf(link);
  assert.equal((await api.call('POST', 'auth/register', { token: t, password: PW })).status, 410, 'a reset link is not an invite');
  const r = await api.call('POST', 'auth/reset', { token: t, password: 'brand-new-pass' });
  assert.equal(r.status, 200);
  assert.equal((await api.call('GET', 'auth/me', undefined, old)).status, 401, 'old session');
  assert.equal((await api.call('GET', 'auth/me', undefined, r.data.token)).status, 200, 'new session');
  assert.equal((await api.call('POST', 'auth/reset', { token: t, password: 'another-pass' })).status, 410);
  assert.equal((await api.call('POST', 'auth/login', { email: m.email, password: PW })).status, 401);
  assert.equal((await api.call('POST', 'auth/login', { email: m.email, password: 'brand-new-pass' })).status, 200);
});
test('change password needs the current one', async () => {
  const m = await addMember('change');
  assert.equal((await api.call('POST', 'auth/change-password', { current_password: 'wrong', password: 'next-pass-1' }, m.token)).status, 400);
  assert.equal((await api.call('POST', 'auth/change-password', { current_password: PW, password: 'x' }, m.token)).status, 400);
  const ok = await api.call('POST', 'auth/change-password', { current_password: PW, password: 'next-pass-1' }, m.token);
  assert.equal(ok.status, 200);
  assert.equal((await api.call('GET', 'auth/me', undefined, ok.data.token)).status, 200);
  assert.equal((await api.call('POST', 'auth/change-password', { current_password: 'a', password: 'next-pass-2' })).status, 401);
});
test('lockout after 10 wrong passwords, cleared by a reset', async () => {
  const m = await addMember('locked');
  for (let i = 0; i < 10; i += 1) await api.call('POST', 'auth/login', { email: m.email, password: 'nope' });
  assert.equal((await api.call('POST', 'auth/login', { email: m.email, password: PW })).status, 429);
  const t = tokenOf((await api.fn('createResetLink', { client_id: m.client.id }, admin.token)).link);
  await api.call('POST', 'auth/reset', { token: t, password: 'after-lock-1' });
  assert.equal((await api.call('POST', 'auth/login', { email: m.email, password: 'after-lock-1' })).status, 200);
});
test('forgot password gives the same answer for any email', async () => {
  const a = await api.call('POST', 'auth/forgot', { email: members.alice.email });
  const b = await api.call('POST', 'auth/forgot', { email: 'nobody@example.test' });
  assert.deepEqual(a, b);
});
test('turning off a coach signs them out; admins are protected', async () => {
  const inv = await api.fn('createInvite', { email: 'temp@example.test', full_name: 'Temp' }, admin.token);
  const reg = (await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Temp', password: PW })).data;
  assert.equal((await api.fn('setCoachAccess', { user_id: reg.user.id, disabled: true }, coach.token)).success, false, 'coach cannot');
  assert.equal((await api.fn('setCoachAccess', { user_id: reg.user.id, disabled: true }, admin.token)).success, true);
  assert.equal((await api.call('GET', 'entities/Client', undefined, reg.token)).status, 401);
  assert.equal((await api.call('POST', 'auth/login', { email: 'temp@example.test', password: PW })).status, 403);
  assert.equal((await api.fn('setCoachAccess', { user_id: admin.id, disabled: true }, admin.token)).success, false);
  assert.equal((await api.fn('setCoachAccess', { user_id: reg.user.id, disabled: false }, admin.token)).success, true);
  assert.equal((await api.call('POST', 'auth/login', { email: 'temp@example.test', password: PW })).status, 200);
});
test('members cannot raise their own privileges', async () => {
  const a = members.alice;
  await api.call('PUT', 'auth/me', { role: 'admin', user_type: 'trainer', email: ADMIN.email, billing: { plan: 'studio' }, disabled: false, sessions_valid_from: 0, id: admin.id }, a.token);
  const me = (await api.call('GET', 'auth/me', undefined, a.token)).data;
  assert.equal(me.user_type, 'client'); assert.notEqual(me.role, 'admin'); assert.equal(me.email, a.email); assert.equal(me.id, a.id); assert.equal(me.billing, undefined);
  assert.equal((await api.call('PUT', `entities/User/${a.id}`, { role: 'admin' }, a.token)).status, 405);
  const users = await api.list('User', a.token);
  assert.deepEqual(users.map((u) => u.id), [a.id]);
});
test('server functions need a sign-in', async () => {
  for (const n of ['sendInviteEmail', 'sendResourceEmail', 'sendSessionReminder', 'aiPersonalizedPlans', 'generateJournalPrompt', 'parseRecipeFromText', 'searchFoods', 'bookClass', 'classRoster']) {
    assert.equal((await api.call('POST', `functions/${n}`, {})).status, 401, n);
  }
  assert.equal((await api.fn('sendResourceEmail', { to: 'x@example.test' }, members.alice.token)).success, false);
  for (const p of ['entities/Client', 'audit', 'auth/export']) assert.equal((await api.call('GET', p)).status, 401, p);
  assert.equal((await api.call('GET', 'audit', undefined, coach.token)).status, 403);
});

/* ---------------- privacy ---------------- */
test("members see only their own records", async () => {
  const { alice, bob } = members;
  const note = await api.create('ProgressLog', { client_id: bob.client.id, date: eastern().date, weight: 200 }, bob.token);
  const clients = await api.list('Client', alice.token);
  assert.deepEqual([...new Set(clients.map((c) => c.email))], [alice.email]);
  assert.equal((await api.call('GET', `entities/Client/${bob.client.id}`, undefined, alice.token)).status, 404);
  assert.ok(note?.id, 'bob saved his own log');
  assert.equal((await api.call('GET', `entities/ProgressLog/${note.id}`, undefined, alice.token)).status, 404);
  assert.notEqual((await api.call('PUT', `entities/ProgressLog/${note.id}`, { weight: 1 }, alice.token)).status, 200);
  assert.notEqual((await api.call('DELETE', `entities/ProgressLog/${note.id}`, undefined, alice.token)).status, 200);
  assert.equal((await api.fn('classRoster', { session_id: 'x' }, alice.token)).success, false);
  for (const t of ['Membership', 'Reservation', 'Message', 'Notification']) {
    const rows = await api.list(t, alice.token);
    for (const r of rows) assert.ok(!JSON.stringify(r).includes(bob.client.id), t);
  }
});
test('members cannot write gym records', async () => {
  const a = members.alice;
  const s = await makeClass(48);
  for (const [t, body] of [['ClassSession', { class_type_id: crossfit.id, date: eastern().date, start_time: '10:00' }], ['ClassSlot', { class_type_id: crossfit.id }], ['ClassType', { name: 'x' }], ['MembershipPlan', { name: 'x' }], ['GymSettings', { booking_open_hours: 9999 }], ['Membership', { client_id: a.client.id, plan_id: unlimited.id }], ['Reservation', { session_id: s.id, client_id: a.client.id, status: 'checked_in' }]]) {
    assert.equal((await api.call('POST', `entities/${t}`, body, a.token)).status, 403, t);
  }
  assert.equal((await api.update('ClassSession', s.id, { capacity: 1 }, a.token)).status, 403);
});

/* ---------------- booking rules ---------------- */
test('booking window: default, class override and single-class override', async () => {
  const a = members.alice;
  assert.equal((await book(a, await makeClass(24 * 3))).success, true);
  assert.equal((await book(a, await makeClass(24 * 10))).code, 'booking_not_open');
  assert.equal((await book(a, await makeClass(24 * 10, { booking_open_hours: 336 }))).success, true);
  const s = await makeClass(24 * 3 + 2, { booking_open_hours: 24 });
  assert.equal((await book(a, s)).code, 'booking_not_open');
  await api.update('ClassSession', s.id, { overrides: { booking_open_hours: 120 } }, coach.token);
  assert.equal((await book(a, s)).success, true);
});
test('booking closes an hour before class', async () => {
  assert.equal((await book(members.alice, await makeClass(0.75))).code, 'booking_closed');
  assert.equal((await book(members.alice, await makeClass(1.5))).success, true);
});
test('no double booking', async () => {
  const s = await makeClass(30);
  await Promise.all([book(members.alice, s), book(members.alice, s), book(members.alice, s)]);
  assert.equal((await roster(s)).session.reserved_count, 1);
});
test('last spot: one gets in, the rest are waitlisted in order, cancel promotes', async () => {
  const s = await makeClass(40, { capacity: 1 });
  const rs = await Promise.all(['alice', 'bob', 'cara'].map((n) => book(members[n], s)));
  assert.equal(rs.filter((r) => r.status === 'reserved').length, 1, JSON.stringify(rs.map((r) => r.status || r.error)));
  assert.equal(rs.filter((r) => r.status === 'waitlisted').length, 2);
  const first = rs.findIndex((r) => r.status === 'reserved');
  const names = ['alice', 'bob', 'cara'];
  const c = await api.fn('cancelReservation', { reservation_id: rs[first].reservation.id }, members[names[first]].token);
  assert.equal(c.success, true);
  const now = await roster(s);
  assert.equal(now.session.reserved_count, 1);
  assert.equal(now.session.waitlist_count, 1);
});
test('late cancel does not promote the waitlist', async () => {
  const s = await makeClass(4, { capacity: 1 });
  const a = await book(members.alice, s);
  assert.equal((await book(members.bob, s)).status, 'waitlisted');
  await api.fn('cancelReservation', { reservation_id: a.reservation.id }, members.alice.token);
  const r = await roster(s);
  assert.equal(r.session.reserved_count, 0);
  assert.equal(r.session.waitlist_count, 1);
});
test('a member cannot cancel or book for someone else', async () => {
  const s = await makeClass(50);
  const a = await book(members.alice, s);
  assert.equal((await api.fn('cancelReservation', { reservation_id: a.reservation.id }, members.bob.token)).success, false);
  assert.equal((await book(members.bob, s, { client_id: members.cara.client.id })).success, false);
});
test('weekly limit: 2 a week, counted per week, staff can override', async () => {
  const plan = await api.create('MembershipPlan', { name: 'Two a week', kind: 'limited', limit_count: 2, limit_period: 'week', class_type_ids: [], is_active: true }, coach.token);
  const m = await addMember('limited', { plan });
  // Three classes on one day, so they always share a Monday-to-Sunday week.
  const day = 24 * 2;
  const s = [await makeClass(day), await makeClass(day), await makeClass(day)];
  assert.equal((await book(m, s[0])).success, true);
  assert.equal((await book(m, s[1])).success, true);
  assert.equal((await book(m, s[2])).success, false);
  const forced = await api.fn('bookClass', { session_id: s[2].id, client_id: m.client.id }, coach.token);
  assert.equal(forced.can_override, true);
  assert.equal((await api.fn('bookClass', { session_id: s[2].id, client_id: m.client.id, override: true }, coach.token)).success, true);
});
test('racing the weekly limit cannot beat it', async () => {
  const plan = await api.create('MembershipPlan', { name: 'One a week', kind: 'limited', limit_count: 1, limit_period: 'week', class_type_ids: [], is_active: true }, coach.token);
  const m = await addMember('racer', { plan });
  const s = await Promise.all([1, 2, 3].map(() => makeClass(48)));
  const rs = await Promise.all(s.map((x) => book(m, x)));
  assert.equal(rs.filter((r) => r.success).length, 1);
});
test('punch card: used at check-in, returned on undo, stops at zero', async () => {
  const plan = await api.create('MembershipPlan', { name: 'Punch', kind: 'punch', limit_count: 1, limit_period: 'total', duration_days: 90, class_type_ids: [], is_active: true }, coach.token);
  const m = await addMember('puncher', { plan });
  const used = async () => (await api.list('Membership', coach.token)).find((x) => x.client_id === m.client.id).sessions_used;
  const s = await makeClass(0.2);
  const inn = await api.fn('checkIn', { session_id: s.id, client_id: m.client.id }, coach.token);
  assert.equal(inn.success, true, inn.error);
  assert.equal(await used(), 1);
  assert.equal((await book(m, await makeClass(30))).success, false, 'no visits left');
  assert.equal((await api.fn('undoCheckIn', { reservation_id: inn.reservation.id }, coach.token)).success, true);
  assert.equal(await used(), 0);
});
test('no membership, expired membership and wrong class type are refused', async () => {
  const none = await addMember('nomember', { plan: null });
  assert.equal((await book(none, await makeClass(30))).success, false);
  const old = await addMember('expired', { membership: { end_date: addDays(eastern().date, -1) } });
  assert.equal((await book(old, await makeClass(30))).success, false);
  const plan = await api.create('MembershipPlan', { name: 'Open gym only', kind: 'unlimited', class_type_ids: [openGym.id], is_active: true }, coach.token);
  const og = await addMember('ogonly', { plan });
  assert.equal((await book(og, await makeClass(30))).success, false);
});
test('waiver: required when on, accepted once signed', async () => {
  const gs = (await api.list('GymSettings', coach.token))[0];
  await api.update('GymSettings', gs.id, { waiver_required: true }, coach.token);
  const m = await addMember('waiver');
  const s = await makeClass(30);
  assert.equal((await book(m, s)).code, 'waiver_required');
  await api.create('Contract', { client_id: m.client.id, type: 'waiver', title: 'Liability Waiver', status: 'signed' }, coach.token);
  assert.equal((await book(m, s)).success, true);
  await api.update('GymSettings', gs.id, { waiver_required: false }, coach.token);
});

/* ---------------- holds and end dates ---------------- */
const membershipOf = async (m) => (await api.list('Membership', coach.token)).find((x) => x.client_id === m.client.id);
const hold = (mem, from, to, extra = {}) => api.fn('holdMembership', { membership_id: mem.id, from, to, reason: 'Knee injury', ...extra }, coach.token);
test('hold: blocks booking on those days, cancels bookings then, members cannot set one', async () => {
  const m = await addMember('holder');
  const today = eastern().date;
  const inHold = await makeClass(30);
  const booked = await book(m, inHold);
  assert.equal(booked.success, true);
  const mem = await membershipOf(m);
  // Members can't hold or end their own membership.
  for (const n of ['holdMembership', 'setMembershipEndDate']) {
    assert.equal((await api.fn(n, { membership_id: mem.id, from: today, to: addDays(today, 3), reason: 'x', end_date: today }, m.token)).success, false);
  }
  assert.equal((await hold(mem, today, addDays(today, 3), { reason: '' })).success, false, 'reason needed');
  assert.equal((await hold(mem, addDays(today, 3), today)).success, false, 'backwards dates');
  const h = await hold(mem, today, addDays(today, 3));
  assert.equal(h.success, true, h.error);
  assert.equal(h.cancelled_bookings, 1);
  assert.equal((await hold(mem, addDays(today, 2), addDays(today, 5))).success, false, 'overlap');
  assert.equal((await roster(inHold)).session.reserved_count, 0);
  const r = await book(m, await makeClass(26));
  assert.equal(r.code, 'on_hold');
  assert.match(r.error, /^Your membership is on hold until [A-Z][a-z]{2} \d{1,2}\.$/);
  const staff = await api.fn('bookClass', { session_id: inHold.id, client_id: m.client.id }, coach.token);
  assert.match(staff.error, /^This client's membership is on hold until/);
  assert.equal((await book(m, await makeClass(24 * 5))).success, true, 'after the hold');
  const mine = await api.fn('myClasses', {}, m.token);
  assert.deepEqual(mine.memberships[0].hold_now, { from: today, to: addDays(today, 3) });
  const log = (await api.call('GET', 'audit?limit=50', undefined, admin.token)).data;
  assert.ok(log.some((x) => x.action === 'holdMembership' && x.target_id === mem.id && /Knee injury/.test(x.detail)));
});
test('hold: ending early lets them book again, cancelling removes it, end date moves with it', async () => {
  const today = eastern().date;
  const m = await addMember('traveler', { membership: { end_date: addDays(today, 60) } });
  let mem = await membershipOf(m);
  // Started two days ago (recorded late), runs to day 9.
  assert.equal((await hold(mem, addDays(today, -2), addDays(today, 9), { reason: 'Travel' })).success, true);
  mem = await membershipOf(m);
  assert.equal(mem.end_date, addDays(today, 72), 'pushed back 12 days');
  assert.equal((await book(m, await makeClass(30))).code, 'on_hold');
  const e = await api.fn('endMembershipHold', { membership_id: mem.id, hold_id: mem.holds[0].id }, coach.token);
  assert.equal(e.success, true, e.error);
  assert.equal(e.membership.holds[0].to, addDays(today, -1));
  assert.equal(e.membership.end_date, addDays(today, 62), 'unused hold days given back');
  assert.equal((await book(m, await makeClass(30))).success, true);
  // A future hold, then cancelled: kept as history, no longer blocks.
  mem = await membershipOf(m);
  assert.equal((await hold(mem, addDays(today, 20), addDays(today, 24))).success, true);
  mem = await membershipOf(m);
  assert.equal(mem.end_date, addDays(today, 67));
  const fut = mem.holds.find((x) => x.status === 'active' && x.from > today);
  const c = await api.fn('cancelMembershipHold', { membership_id: mem.id, hold_id: fut.id }, coach.token);
  assert.equal(c.success, true, c.error);
  assert.equal(c.membership.end_date, addDays(today, 62));
  assert.equal(c.membership.holds.length, 2, 'history kept');
  assert.equal(c.membership.holds.find((x) => x.id === fut.id).status, 'cancelled');
});
test('hold days do not count against a weekly limit', async () => {
  const plan = await api.create('MembershipPlan', { name: 'One a week (hold)', kind: 'limited', limit_count: 1, limit_period: 'week', class_type_ids: [], is_active: true }, coach.token);
  const m = await addMember('weekly', { plan });
  const s = await makeClass(30);
  assert.equal((await book(m, s)).success, true);
  const mem = await membershipOf(m);
  const h = await hold(mem, s.date, s.date);
  assert.equal(h.success, true, h.error);
  await api.fn('cancelMembershipHold', { membership_id: mem.id, hold_id: h.membership.holds[0].id }, coach.token);
  // The booking the hold cancelled no longer uses up the week.
  assert.equal((await book(m, await makeClass(30))).success, true);
});
test('end date: no booking after it, history stays', async () => {
  const m = await addMember('leaver');
  const today = eastern().date;
  const before = await makeClass(3);
  assert.equal((await book(m, before)).success, true);
  const later = await makeClass(24 * 4);
  assert.equal((await book(m, later)).success, true);
  const mem = await membershipOf(m);
  assert.equal((await api.fn('setMembershipEndDate', { membership_id: mem.id, end_date: addDays(mem.start_date, -1) }, coach.token)).success, false);
  const e = await api.fn('setMembershipEndDate', { membership_id: mem.id, end_date: addDays(today, 1), reason: 'Moving away' }, coach.token);
  assert.equal(e.success, true, e.error);
  assert.equal(e.cancelled_bookings, 1, 'only the class after the end date');
  const r = await book(m, await makeClass(24 * 5));
  assert.equal(r.code, 'membership_ended');
  assert.match(r.error, /^Your membership ends [A-Z][a-z]{2} \d{1,2}, so you can't book classes after that\.$/);
  // Past the end date: still signed in, still sees their records.
  await api.fn('setMembershipEndDate', { membership_id: mem.id, end_date: addDays(today, -1) }, coach.token);
  const mine = await api.fn('myClasses', {}, m.token);
  assert.equal(mine.success, true);
  assert.equal(mine.memberships.length, 0);
  assert.equal(mine.past_memberships[0].end_date, addDays(today, -1));
  assert.ok((await api.list('Reservation', m.token)).length >= 2, 'bookings kept');
  assert.match((await book(m, await makeClass(30))).error, /^Your membership ended/);
  // Clearing the end date brings it back.
  assert.equal((await api.fn('setMembershipEndDate', { membership_id: mem.id, end_date: null }, coach.token)).success, true);
  assert.equal((await book(m, await makeClass(30))).success, true);
});

/* ---------------- check-in ---------------- */
test('self check-in opens 30 minutes before class', async () => {
  assert.equal((await api.fn('checkIn', { session_id: (await makeClass(2)).id }, members.alice.token)).code, 'checkin_not_open');
  const s = await makeClass(0.2);
  assert.equal((await api.fn('checkIn', { session_id: s.id }, members.alice.token)).success, true);
  assert.equal((await api.fn('checkIn', { session_id: s.id }, members.alice.token)).already, true);
  assert.equal((await roster(s)).session.checked_in_count, 1);
});
test('self check-in closes 30 minutes after start', async () => {
  assert.equal((await api.fn('checkIn', { session_id: (await makeClass(-0.75)).id }, members.alice.token)).code, 'checkin_closed');
});
test('coach: check in, undo, no-show, walk-in; not for a future day', async () => {
  const early = await makeClass(0.3);
  const eb = await api.fn('bookClass', { session_id: early.id, client_id: members.cara.client.id }, coach.token);
  assert.equal((await api.fn('markNoShow', { reservation_id: eb.reservation.id }, coach.token)).code, 'class_not_started');
  const s = await makeClass(-0.3);
  const b = await api.fn('bookClass', { session_id: s.id, client_id: members.alice.client.id }, coach.token);
  const args = { session_id: s.id, client_id: members.alice.client.id, reservation_id: b.reservation.id };
  assert.equal((await api.fn('checkIn', args, coach.token)).success, true);
  assert.equal((await api.fn('undoCheckIn', args, coach.token)).success, true);
  assert.equal((await api.fn('markNoShow', args, coach.token)).success, true);
  assert.equal((await api.fn('checkIn', args, coach.token)).success, true, 'no-show then arrives');
  assert.equal((await api.fn('checkIn', { session_id: s.id, client_id: members.bob.client.id }, coach.token)).success, true, 'walk-in');
  assert.equal((await roster(s)).session.checked_in_count, 2);
  assert.equal((await api.fn('markNoShow', args, members.bob.token)).success, false, 'member cannot');
  assert.equal((await api.fn('checkIn', { session_id: (await makeClass(50)).id, client_id: members.bob.client.id }, coach.token)).code, 'checkin_not_open');
});
test('open gym takes check-ins, not reservations', async () => {
  const s = await makeClass(0.2, { class_type_id: openGym.id });
  assert.equal((await book(members.alice, s)).code, 'not_reservable');
  assert.equal((await api.fn('checkIn', { session_id: s.id }, members.alice.token)).success, true);
});
test('cancelling a class releases everyone and tells them', async () => {
  const s = await makeClass(60);
  await book(members.alice, s); await book(members.bob, s);
  const r = await api.fn('cancelClassSession', { session_id: s.id, reason: 'Holiday' }, coach.token);
  assert.equal(r.affected, 2);
  assert.equal((await book(members.cara, s)).code, 'class_cancelled');
  const notes = await api.list('Notification', members.alice.token);
  assert.ok(notes.some((n) => n.type === 'class' && /Holiday|cancel/i.test(`${n.title} ${n.message}`)));
  assert.equal((await api.fn('cancelClassSession', { session_id: s.id }, members.alice.token)).success, false);
});

test('booking, waitlist, cancel and moving up each tell the member', async () => {
  const s = await makeClass(45, { capacity: 1 });
  const name = s.class_type_name;
  const mine = async (m) => (await api.list('Notification', m.token)).filter((n) => n.type === 'class' && n.message.includes(name));
  const a = await book(members.alice, s);
  assert.equal(a.status, 'reserved');
  assert.equal((await book(members.bob, s)).status, 'waitlisted');
  assert.ok((await mine(members.alice)).some((n) => n.title === 'You are booked'));
  assert.ok((await mine(members.bob)).some((n) => /waitlist/i.test(n.title) && /number 1/.test(n.message)));
  assert.equal((await mine(members.cara)).length, 0, 'nobody else hears about it');
  assert.equal((await api.fn('cancelReservation', { reservation_id: a.reservation.id }, members.alice.token)).success, true);
  assert.ok((await mine(members.alice)).some((n) => n.title === 'Booking cancelled' && /You cancelled/.test(n.message)));
  assert.ok((await mine(members.bob)).some((n) => n.title === 'You are in'));
  const b = await api.fn('bookClass', { session_id: (await makeClass(46)).id, client_id: members.cara.client.id }, coach.token);
  assert.equal(b.success, true);
  await api.fn('cancelReservation', { reservation_id: b.reservation.id }, coach.token);
  const caraNotes = (await api.list('Notification', members.cara.token)).filter((n) => n.message.includes(b.session.class_type_name));
  assert.ok(caraNotes.some((n) => n.title === 'You are booked'), 'a coach booking for a member tells the member');
  assert.ok(caraNotes.some((n) => /The gym cancelled/.test(n.message)));
});
test('class reminders: sent once, at the right time, and not when turned off', async () => {
  const dan = await addMember('dan');
  const eve = await addMember('eve');
  const off = await api.call('PUT', 'auth/me', { notifications: { class_reminders: false } }, eve.token);
  assert.equal(off.status, 200);
  const moveTo = (s, hoursOut) => { const { date, time } = eastern(Date.now() + hoursOut * 3600000); return api.update('ClassSession', s.id, { date, start_time: time }, coach.token); };
  const due = await makeClass(26); // booked well ahead, then the class comes within 2 hours
  const early = await makeClass(27); // still more than 2 hours away
  assert.equal((await book(dan, due)).success, true);
  assert.equal((await book(eve, due)).success, true);
  assert.equal((await book(dan, early)).success, true);
  await moveTo(due, 1.5);
  await moveTo(early, 2.5);
  const late = await makeClass(1.5); // booked inside the reminder window: the booking notice is enough
  assert.equal((await book(dan, late)).success, true);
  const ticks = await Promise.all([1, 2, 3].map(() => api.call('POST', 'cron/program-tick', {}, null, { 'x-cron-secret': CRON_SECRET })));
  for (const t of ticks) assert.equal(t.status, 200);
  await api.call('POST', 'cron/program-tick', {}, null, { 'x-cron-secret': CRON_SECRET });
  const reminders = async (m, s) => (await api.list('Notification', m.token)).filter((n) => n.title === 'Class reminder' && n.message.includes(s.class_type_name));
  const got = await reminders(dan, due);
  assert.equal(got.length, 1, 'sent exactly once');
  assert.match(got[0].message, /starts (today|tomorrow) at \d{1,2}:\d{2} (AM|PM)/);
  assert.equal((await reminders(eve, due)).length, 0, 'turned off');
  assert.equal((await reminders(dan, early)).length, 0, 'not early');
  assert.equal((await reminders(dan, late)).length, 0, 'not right after booking');
  // A member can choose 3 hours before; the class 2.5 hours out is then due.
  await api.call('PUT', 'auth/me', { notifications: { class_reminder_minutes: 180 } }, dan.token);
  await api.call('POST', 'cron/program-tick', {}, null, { 'x-cron-secret': CRON_SECRET });
  assert.equal((await reminders(dan, early)).length, 1);
});

/* ---------------- schedule ---------------- */
test('weekly slot: makes classes once, follows edits, keeps booked ones', async () => {
  const today = eastern().date;
  const target = addDays(today, 2);
  const dow = new Date(`${target}T12:00:00Z`).getUTCDay();
  const slot = await api.create('ClassSlot', { class_type_id: crossfit.id, day_of_week: dow, start_time: '09:30', duration_min: 60, start_date: today, is_active: true }, coach.token);
  const mine = async () => (await api.fn('classSchedule', { from: today, to: addDays(today, 60) }, coach.token)).sessions.filter((s) => s.slot_id === slot.id);
  const first = await mine();
  assert.equal(first.length, 3);
  await api.fn('classTick', {}, coach.token); await api.fn('classTick', {}, coach.token);
  assert.equal((await mine()).length, 3, 'no duplicates');
  await book(members.alice, first[0]);
  const edit = await api.update('ClassSlot', slot.id, { start_time: '08:30' }, coach.token);
  assert.equal(edit.data.class_sync.booked_kept, 1);
  const after = await mine();
  assert.equal(after[0].start_time, '09:30', 'booked class keeps its time');
  assert.equal(after[1].start_time, '08:30');
  await api.update('ClassSlot', slot.id, { booking_open_hours: 30 * 24 }, coach.token);
  const far = await mine();
  assert.ok(far.at(-1).date >= addDays(today, 24), 'calendar reaches the booking window');
  await api.update('ClassSlot', slot.id, { is_active: false }, coach.token);
  assert.equal((await mine()).filter((s) => s.status === 'scheduled').length, 1, 'only the booked class stays');
});
test('class times stay put across the clock change', async () => {
  // 9:30 in Chattanooga is 13:30 UTC in summer and 14:30 in winter.
  const mk = (date) => api.create('ClassSession', { class_type_id: crossfit.id, date, start_time: '09:30', duration_min: 60, slot_id: null }, coach.token);
  assert.equal((await mk('2027-03-13')).start_at, '2027-03-13T14:30:00.000Z');
  assert.equal((await mk('2027-03-14')).start_at, '2027-03-14T13:30:00.000Z');
  assert.equal((await mk('2027-11-06')).start_at, '2027-11-06T13:30:00.000Z');
  assert.equal((await mk('2027-11-07')).start_at, '2027-11-07T14:30:00.000Z');
});
test('a one-time class never repeats', async () => {
  const s = await makeClass(70);
  await api.fn('classTick', {}, coach.token);
  const all = (await api.fn('classSchedule', { from: eastern().date, to: addDays(eastern().date, 60) }, coach.token)).sessions;
  assert.equal(all.filter((x) => x.class_type_name === s.class_type_name).length, 1);
});

/* ---------------- one-class edits and holiday changes ---------------- */
const dowOf = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
const daySessions = async (date, token = coach.token) => (await api.fn('classSchedule', { from: date, to: date }, token));
const activeOn = async (date) => (await daySessions(date)).sessions.filter((x) => x.status === 'scheduled');

test('edit one class: time, coach and capacity change for that date only', async () => {
  const today = eastern().date;
  const target = addDays(today, 3);
  const slot = await api.create('ClassSlot', { class_type_id: crossfit.id, day_of_week: dowOf(target), start_time: '07:00', duration_min: 60, start_date: today, end_date: addDays(target, 7), is_active: true }, coach.token);
  const ofSlot = async () => (await api.fn('classSchedule', { from: today, to: addDays(target, 7) }, coach.token)).sessions.filter((x) => x.slot_id === slot.id);
  const [one, next] = await ofSlot();
  assert.equal(next.date, addDays(target, 7));
  await book(members.alice, one); await book(members.bob, one);
  assert.equal((await api.fn('editClassSession', { session_id: one.id, start_time: '08:00' }, members.alice.token)).success, false, 'members cannot edit');
  const r = await api.fn('editClassSession', { session_id: one.id, start_time: '08:00', capacity: 1, coach_user_id: coach.id }, coach.token);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.session.start_time, '08:00');
  assert.equal(r.session.coach_name, 'Cody Coach');
  assert.equal(r.session.capacity, 1);
  assert.equal(r.notified, 2);
  assert.match(r.warnings[0], /Nobody was removed/);
  const people = (await roster(one)).reservations.filter((x) => x.status === 'reserved');
  assert.equal(people.length, 2, 'both keep their spot');
  assert.ok(people.every((x) => x.start_at === r.session.start_at), 'bookings follow the new time');
  const notes = await api.list('Notification', members.alice.token);
  assert.ok(notes.some((n) => n.title === 'Class time changed' && /8:00 AM/.test(n.message)));
  assert.equal((await book(members.cara, one)).status, 'waitlisted', 'class is full at the new capacity');
  // The weekly template and next week's class are untouched, even after a tick.
  await api.fn('classTick', {}, coach.token);
  const after = await ofSlot();
  assert.equal(after[0].start_time, '08:00', 'the edit sticks');
  assert.equal(after[1].start_time, '07:00');
  assert.equal(after[1].capacity, 20);
  // Raising capacity again lets the waitlist in.
  const up = await api.fn('editClassSession', { session_id: one.id, capacity: 5 }, coach.token);
  assert.equal(up.warnings.length, 0);
  assert.equal(up.session.reserved_count, 3);
  assert.equal((await api.fn('editClassSession', { session_id: one.id, start_time: '25:00' }, coach.token)).success, false);
  await api.update('ClassSlot', slot.id, { is_active: false }, coach.token);
});

test('holiday: closing a day cancels and tells everyone, and stays closed', async () => {
  const today = eastern().date;
  const target = addDays(today, 4);
  const slot = await api.create('ClassSlot', { class_type_id: crossfit.id, day_of_week: dowOf(target), start_time: '06:00', duration_min: 60, start_date: target, end_date: target, is_active: true }, coach.token);
  const [s] = (await activeOn(target)).filter((x) => x.slot_id === slot.id);
  const oneOff = await api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: 'Holiday WOD', date: target, start_time: '10:00', duration_min: 60, slot_id: null }, coach.token);
  await book(members.alice, s);
  assert.equal((await api.fn('classDayChange', { date: target, mode: 'closed' }, members.alice.token)).success, false, 'members cannot close the gym');
  const r = await api.fn('classDayChange', { date: target, mode: 'closed', reason: 'Thanksgiving' }, coach.token);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(r.cancelled >= 2);
  assert.ok(r.notified >= 1, 'booked member told');
  assert.equal((await activeOn(target)).length, 0, 'no classes that day');
  const sched = await daySessions(target, members.alice.token);
  assert.equal(sched.day_changes[0].mode, 'closed');
  assert.equal(sched.day_changes[0].reason, 'Thanksgiving');
  const notes = await api.list('Notification', members.alice.token);
  assert.ok(notes.some((n) => n.title === 'Class cancelled' && /Thanksgiving/.test(n.message)));
  assert.equal((await roster(s)).reservations[0].status, 'cancelled_by_gym', 'booking released');
  await api.fn('classTick', {}, coach.token);
  assert.equal((await activeOn(target)).length, 0, 'the scheduled job does not bring classes back');
  assert.equal((await api.fn('classDayChange', { date: target, mode: 'shift', shift_minutes: 30 }, coach.token)).success, false, 'one change per day');
  const undo = await api.fn('classDayChange', { date: target, mode: 'normal' }, coach.token);
  assert.equal(undo.success, true);
  const back = await activeOn(target);
  assert.ok(back.some((x) => x.id === s.id) && back.some((x) => x.id === oneOff.id), 'classes come back after undo');
  assert.equal((await daySessions(target)).day_changes.length, 0);
  await api.update('ClassSlot', slot.id, { is_active: false }, coach.token);
});

test('holiday: a day can run another day\'s schedule, or shift every class', async () => {
  const today = eastern().date;
  const target = addDays(today, 7); // a date no other test puts a class on
  const otherDow = (dowOf(target) + 2) % 7;
  const normal = await api.create('ClassSlot', { class_type_id: crossfit.id, day_of_week: dowOf(target), start_time: '05:30', duration_min: 60, start_date: target, end_date: target, is_active: true }, coach.token);
  const other = await api.create('ClassSlot', { class_type_id: openGym.id, day_of_week: otherDow, start_time: '09:00', duration_min: 120, start_date: today, end_date: target, is_active: true }, coach.token);
  const [n] = (await activeOn(target)).filter((x) => x.slot_id === normal.id);
  await book(members.bob, n);
  assert.equal((await api.fn('classDayChange', { date: target, mode: 'use_day', use_day_of_week: dowOf(target) }, coach.token)).success, false, 'same weekday is refused');
  const r = await api.fn('classDayChange', { date: target, mode: 'use_day', use_day_of_week: otherDow }, coach.token);
  assert.equal(r.success, true, JSON.stringify(r));
  let day = await activeOn(target);
  assert.ok(!day.some((x) => x.slot_id === normal.id), 'the normal class is off');
  assert.ok(day.some((x) => x.slot_id === other.id && x.start_time === '09:00'), 'the other day\'s class runs');
  assert.ok((await api.list('Notification', members.bob.token)).some((n2) => /schedule/.test(n2.message)));
  await api.fn('classTick', {}, coach.token);
  day = await activeOn(target);
  assert.equal(day.filter((x) => x.slot_id === other.id).length, 1, 'still swapped after a tick');
  assert.equal((await api.fn('classDayChange', { date: target, mode: 'normal' }, coach.token)).success, true);
  day = await activeOn(target);
  assert.ok(day.some((x) => x.slot_id === normal.id) && !day.some((x) => x.slot_id === other.id), 'undo puts the normal day back');

  // Shift every class an hour later; bookings stay and people are told.
  await book(members.cara, day.find((x) => x.slot_id === normal.id));
  const sh = await api.fn('classDayChange', { date: target, mode: 'shift', shift_minutes: 60 }, coach.token);
  assert.equal(sh.success, true, JSON.stringify(sh));
  assert.ok(sh.notified >= 1);
  day = await activeOn(target);
  const moved = day.find((x) => x.slot_id === normal.id);
  assert.equal(moved.start_time, '06:30');
  assert.equal(moved.reserved_count, 1);
  await api.fn('classTick', {}, coach.token);
  assert.equal((await activeOn(target)).find((x) => x.slot_id === normal.id).start_time, '06:30', 'tick keeps the shift');
  assert.equal((await api.fn('classDayChange', { date: target, mode: 'normal' }, coach.token)).success, true);
  assert.equal((await activeOn(target)).find((x) => x.slot_id === normal.id).start_time, '05:30');
  assert.equal((await api.fn('classDayChange', { date: target, mode: 'shift', shift_minutes: -400 }, coach.token)).success, false, 'cannot shift past midnight');
  for (const sl of [normal, other]) await api.update('ClassSlot', sl.id, { is_active: false }, coach.token);
});

/* ---------------- programs and the scheduled job ---------------- */
test('scheduled job needs its secret and reports a heartbeat', async () => {
  assert.equal((await api.call('POST', 'cron/program-tick', {})).status, 401);
  assert.equal((await api.call('POST', 'cron/program-tick', {}, null, { 'x-cron-secret': 'wrong-cron-secre' })).status, 401);
  assert.equal((await api.call('POST', 'cron/program-tick', {}, null, { 'x-cron-secret': CRON_SECRET })).status, 200);
  const st = await api.fn('systemStatus', {}, admin.token);
  assert.equal(st.cron_ok, true);
  assert.equal((await api.fn('systemStatus', {}, coach.token)).success, false);
});
test('programs: today shows today, messages send once, nothing goes early', async () => {
  const p = await api.create('Program', { name: 'Reset', duration_weeks: 1, status: 'published', kind: 'program' }, coach.token);
  const l1 = await api.create('Lesson', { title: 'Day one lesson' }, coach.token);
  const l2 = await api.create('Lesson', { title: 'Day two lesson' }, coach.token);
  await api.create('ProgramItem', { program_id: p.id, day: 1, type: 'lesson', lesson_id: l1.id, sort: 0 }, coach.token);
  await api.create('ProgramItem', { program_id: p.id, day: 2, type: 'lesson', lesson_id: l2.id, sort: 0 }, coach.token);
  await api.create('ProgramItem', { program_id: p.id, day: 1, type: 'message', text: 'Welcome to day one', send_time: '00:00', sort: 1 }, coach.token);
  await api.create('ProgramItem', { program_id: p.id, day: 2, type: 'message', text: 'This is day two', send_time: '00:00', sort: 1 }, coach.token);
  const cara = members.cara;
  await api.update('Client', cara.client.id, { trainer_id: coach.id }, coach.token);
  const enroll = { program_id: p.id, client_id: cara.client.id, start_date: eastern().date };
  assert.equal((await api.fn('enrollInProgram', enroll, members.alice.token)).success, false, 'member cannot');
  const e = await api.fn('enrollInProgram', enroll, coach.token);
  assert.equal(e.success, true, e.error);
  assert.equal((await api.fn('enrollInProgram', enroll, coach.token)).success, false, 'no double enroll');
  const today = JSON.stringify(await api.fn('programTodayForMe', {}, cara.token));
  assert.ok(today.includes('Day one lesson'));
  assert.ok(!JSON.stringify(await api.fn('programTodayForMe', {}, members.bob.token)).includes('Day one lesson'), 'not for others');
  await Promise.all([1, 2, 3].map(() => api.call('POST', 'cron/program-tick', {}, null, { 'x-cron-secret': CRON_SECRET })));
  const msgs = (await api.list('Message', cara.token)).map((m) => m.content);
  assert.equal(msgs.filter((m) => m === 'Welcome to day one').length, 1, 'sent exactly once');
  assert.equal(msgs.filter((m) => m === 'This is day two').length, 0, 'tomorrow is not sent early');
});

/* ---------------- passkeys ---------------- */
test('passkeys: set up, sign in, and every way it must refuse', async () => {
  const { origin, hostname } = new URL(srv.base);
  const A = members.alice; const B = members.bob;
  const add = async (key, token, over = {}) => {
    const o = (await api.call('POST', 'auth/passkeys/add-options', {}, token)).data;
    return api.call('POST', 'auth/passkeys/add', { response: key.create(o, { origin, rp: hostname, ...over }) }, token);
  };
  const signIn = async (key, over = {}) => {
    const o = (await api.call('POST', 'auth/passkeys/login-options', {})).data;
    const response = key.get(o, { origin, rp: hostname, ...over });
    return { response, res: await api.call('POST', 'auth/passkeys/login', { response }) };
  };
  assert.equal((await api.call('POST', 'auth/passkeys/add-options', {})).status, 401, 'signed out');
  const key = makeAuthenticator();
  assert.equal((await add(key, A.token, { origin: 'https://evil.test' })).status, 400, 'wrong site');
  assert.equal((await add(key, A.token, { uv: false })).status, 400, 'no face or fingerprint');
  const first = await add(key, A.token);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.ok((await api.list('Notification', A.token)).some((n) => n.title === 'New sign-in method added'));

  const ok = await signIn(key);
  assert.equal(ok.res.status, 200, JSON.stringify(ok.res.data));
  assert.equal(ok.res.data.user.email, A.email);
  assert.equal((await api.call('GET', 'auth/me', undefined, ok.res.data.token)).status, 200);
  assert.equal((await api.call('POST', 'auth/passkeys/login', { response: ok.response })).status, 401, 'no replay');
  assert.equal((await signIn(key, { origin: 'https://evil.test' })).res.status, 401, 'wrong site');
  assert.equal((await signIn(key, { uv: false })).res.status, 401, 'no face or fingerprint');
  assert.equal((await signIn(makeAuthenticator())).res.status, 401, 'unknown key');
  const impostor = makeAuthenticator(); impostor.id = key.id;
  assert.equal((await signIn(impostor)).res.status, 401, 'right id, wrong key');
  assert.equal((await api.call('POST', 'auth/passkeys/login', {})).status, 401);
  assert.equal((await api.call('POST', 'auth/passkeys/login', { response: { id: key.id } })).status, 401);

  // Challenges belong to one person and one purpose.
  const bobs = (await api.call('POST', 'auth/passkeys/add-options', {}, B.token)).data;
  const stolen = makeAuthenticator().create(bobs, { origin, rp: hostname });
  assert.equal((await api.call('POST', 'auth/passkeys/add', { response: stolen }, A.token)).status, 400, "someone else's challenge");
  const loginO = (await api.call('POST', 'auth/passkeys/login-options', {})).data;
  assert.equal((await api.call('POST', 'auth/passkeys/add', { response: makeAuthenticator().create(loginO, { origin, rp: hostname }) }, A.token)).status, 400, 'login challenge');

  const listA = (await api.call('GET', 'auth/passkeys/list', undefined, A.token)).data.passkeys;
  assert.equal(listA.length, 1);
  assert.deepEqual(Object.keys(listA[0]).sort(), ['created_date', 'id', 'last_used', 'name']);
  assert.equal((await api.call('GET', 'auth/passkeys/list', undefined, B.token)).data.passkeys.length, 0);
  assert.equal((await api.call('DELETE', `auth/passkeys/list/${listA[0].id}`, undefined, B.token)).status, 404, 'not yours');
  assert.equal((await add(key, B.token)).status, 409, 'a key has one owner');
  assert.equal((await signIn(key)).res.data.user.email, A.email);
  assert.equal((await api.call('DELETE', `auth/passkeys/list/${listA[0].id}`, undefined, A.token)).status, 200);
  assert.equal((await signIn(key)).res.status, 401, 'removed');
});
test('passkeys: a password reset removes them, and turned-off accounts stay out', async () => {
  const { origin, hostname } = new URL(srv.base);
  const key = makeAuthenticator();
  const inv = await api.fn('createInvite', { email: 'pk.coach@example.test', full_name: 'Pat Coach' }, admin.token);
  assert.ok(inv.link, JSON.stringify(inv));
  const pat = (await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Pat Coach', password: PW })).data;
  const add = async (token) => {
    const o = (await api.call('POST', 'auth/passkeys/add-options', {}, token)).data;
    assert.equal((await api.call('POST', 'auth/passkeys/add', { response: key.create(o, { origin, rp: hostname }) }, token)).status, 200);
  };
  const signIn = async () => {
    const o = (await api.call('POST', 'auth/passkeys/login-options', {})).data;
    return (await api.call('POST', 'auth/passkeys/login', { response: key.get(o, { origin, rp: hostname }) })).status;
  };
  await add(pat.token);
  assert.equal(await signIn(), 200);
  const off = await api.fn('setCoachAccess', { user_id: pat.user.id, disabled: true }, admin.token);
  assert.equal(off.success, true, JSON.stringify(off));
  assert.equal(await signIn(), 403, 'turned off');
  await api.fn('setCoachAccess', { user_id: pat.user.id, disabled: false }, admin.token);
  assert.equal(await signIn(), 200, 'turned back on');
  const link = (await api.fn('createResetLink', { user_id: pat.user.id }, admin.token)).link;
  assert.equal((await api.call('POST', 'auth/reset', { token: tokenOf(link), password: 'pat-new-pass' })).status, 200);
  assert.equal(await signIn(), 401, 'reset removes passkeys');
});

/* ---------------- errors ---------------- */
test('app errors are recorded, counted and shown to admins', async () => {
  const body = { source: 'page', message: 'Boom in test', page: '/Classes' };
  assert.equal((await api.call('POST', 'client-error', body)).status, 401);
  await api.call('POST', 'client-error', body, members.alice.token);
  await api.call('POST', 'client-error', body, members.alice.token);
  const st = await api.fn('systemStatus', {}, admin.token);
  assert.equal(st.errors.find((x) => x.message === 'Boom in test').hits, 2);
  const notes = (await api.list('Notification', admin.token)).filter((n) => n.title === 'App error');
  assert.equal(notes.length, 1);
});
