// Class reports: attendance, fill, no-shows, members by plan. Staff only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';

let srv; let api; let coach; let member;
const today = eastern().date;
const yesterday = addDays(today, -1);
const c = {}; // name -> Client
const dowOf = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();

before(async () => {
  srv = await startServer(8813);
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  const inv = await api.fn('createInvite', { email: 'coach@example.test', full_name: 'Cody Coach' }, first.data.token);
  coach = (await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Cody Coach', password: 'coach-pass-1' })).data;
  // The setup account manages memberships and class setup, so make it a manager.
  assert.equal((await api.fn('setStaffRole', { user_id: coach.user.id, role: 'manager' }, first.data.token)).success, true);
  const t = coach.token;
  await api.create('GymSettings', { waiver_required: false }, t);
  const crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, t);
  const openGym = await api.create('ClassType', { name: 'Open Gym', reservable: false, default_capacity: null, default_duration_min: 60, is_active: true }, t);
  const unlimited = await api.create('MembershipPlan', { name: 'Unlimited', kind: 'unlimited', class_type_ids: [], is_active: true }, t);
  const punch = await api.create('MembershipPlan', { name: '10 Class Pass', kind: 'punch', limit_count: 10, limit_period: 'total', class_type_ids: [], is_active: true }, t);
  await api.create('MembershipPlan', { name: 'Old Plan', kind: 'unlimited', class_type_ids: [], is_active: false }, t);

  for (const [name, plan, extra] of [['alice', unlimited], ['bob', unlimited], ['cara', punch], ['dan', unlimited], ['eve', unlimited, { status: 'ended', end_date: yesterday }]]) {
    c[name] = await api.create('Client', { full_name: `${name[0].toUpperCase()}${name.slice(1)} Tester`, email: `${name}@example.test`, status: 'active' }, t);
    await api.create('Membership', { client_id: c[name].id, plan_id: plan.id, start_date: addDays(today, -60), status: 'active', ...(extra || {}) }, t);
  }
  const mi = await api.fn('createInvite', { client_id: c.alice.id }, t);
  member = (await api.call('POST', 'auth/register', { token: tokenOf(mi.link), full_name: 'Alice Tester', password: 'member-pass-1' })).data;

  const session = (type, date, time, extra = {}) => api.create('ClassSession', { class_type_id: type.id, class_type_name: type.name, date, start_time: time, duration_min: 60, slot_id: null, ...extra }, t);
  const res = (s, who, status, extra = {}) => api.create('Reservation', {
    session_id: s.id, class_type_id: s.class_type_id, class_name: s.class_type_name, date: s.date, start_at: s.start_at,
    client_id: c[who].id, client_name: c[who].full_name, status, ...extra,
  }, t);
  const morning = await session(crossfit, yesterday, '06:00', { capacity: 2 });
  await res(morning, 'alice', 'checked_in');
  await res(morning, 'bob', 'no_show');
  const evening = await session(crossfit, yesterday, '17:00', { capacity: 2 });
  await res(evening, 'bob', 'late_cancelled');
  await res(evening, 'alice', 'checked_in', { created_at_checkin: true, check_in_method: 'walk_in' });
  await session(crossfit, yesterday, '12:00', { capacity: 2, status: 'cancelled' });
  await res(await session(openGym, addDays(today, -20), '09:00'), 'cara', 'checked_in', { created_at_checkin: true, check_in_method: 'self' });
  await res(await session(crossfit, addDays(today, -40), '06:00', { capacity: 2 }), 'alice', 'checked_in');
});
after(() => srv?.stop());

const report = (payload = {}, token = coach.token) => api.fn('classReports', payload, token);

test('reports: staff only', async () => {
  const r = await report({}, member.token);
  assert.equal(r.success, false);
  assert.equal(r.members, undefined);
  assert.equal((await api.call('POST', 'functions/classReports', {})).status, 401);
});

test('reports: default range is the last 30 gym days', async () => {
  const r = await report();
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.to, today);
  assert.equal(r.from, addDays(today, -29));
  assert.equal(r.daily.length, 30);
  assert.equal(r.daily.find((d) => d.date === yesterday).check_ins, 2);
  assert.deepEqual(
    r.totals,
    { check_ins: 3, booked: 2, no_shows: 1, late_cancels: 1, members_attended: 2, sessions: 3, avg_fill_pct: 75, active_members: 4, inactive: 3 },
  );
});

test('reports: attendance and no-shows per member and per class', async () => {
  const r = await report();
  const m = Object.fromEntries(r.members.map((x) => [x.name, x]));
  assert.deepEqual([m['Alice Tester'].check_ins, m['Alice Tester'].booked, m['Alice Tester'].last_visit], [2, 1, yesterday], 'walk-in is a check-in, not a booking');
  assert.deepEqual([m['Bob Tester'].check_ins, m['Bob Tester'].no_shows, m['Bob Tester'].late_cancels], [0, 1, 1]);
  assert.equal(m['Cara Tester'].check_ins, 1);
  const k = Object.fromEntries(r.classes.map((x) => [x.name, x]));
  assert.deepEqual([k.CrossFit.sessions, k.CrossFit.check_ins, k.CrossFit.no_shows, k.CrossFit.late_cancels], [2, 2, 1, 1], 'cancelled class not counted');
  assert.deepEqual([k['Open Gym'].sessions, k['Open Gym'].check_ins], [1, 1]);
});

test('reports: class fill by day and time', async () => {
  const r = await report();
  assert.equal(r.fill.some((f) => f.name === 'Open Gym'), false, 'open gym has no fill');
  const six = r.fill.find((f) => f.time === '06:00');
  const five = r.fill.find((f) => f.time === '17:00');
  assert.deepEqual([six.dow, six.sessions, six.avg_booked, six.avg_capacity, six.fill_pct, six.full_sessions], [dowOf(yesterday), 1, 2, 2, 100, 1]);
  assert.deepEqual([five.fill_pct, five.full_sessions], [50, 0]);
});

test('reports: who has not been in for 14+ days', async () => {
  const r = await report();
  assert.deepEqual(r.inactive.map((x) => x.name), ['Bob Tester', 'Dan Tester', 'Cara Tester'], 'never first, ended members left out');
  const cara = r.inactive.find((x) => x.name === 'Cara Tester');
  assert.deepEqual([cara.days_since, cara.plans], [20, '10 Class Pass']);
});

test('reports: active members by plan', async () => {
  const r = await report();
  assert.deepEqual(r.plans.map((p) => [p.name, p.members]), [['Unlimited', 3], ['10 Class Pass', 1]], 'inactive plan with nobody is hidden');
});

test('reports: custom range, future end and bad range', async () => {
  const r = await report({ from: addDays(today, -45), to: addDays(today, 10) });
  assert.equal(r.to, today, 'stops at today');
  assert.equal(r.members.find((x) => x.name === 'Alice Tester').check_ins, 3);
  assert.equal(r.inactive.length, 3, 'inactive list is always as of today');
  assert.equal((await report({ from: today, to: addDays(today, -3) })).success, false);
  const long = await report({ from: addDays(today, -800), to: today });
  assert.equal(long.from, addDays(today, -365));
});
