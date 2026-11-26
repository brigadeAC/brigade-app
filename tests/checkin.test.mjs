// Coach check-in from the class roster, and today's classes on the coach home.
// Runs the real API on a throwaway local database (see server.mjs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';

let srv; let api; let coach; let crossfit; let unlimited;
const members = {};
let seq = 0;

async function addMember(name) {
  const email = `${name}@example.test`;
  const c = await api.create('Client', { full_name: `${name} Tester`, email, status: 'active' }, coach.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, coach.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: `${name} Tester`, password: 'member-pass-1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  await api.create('Membership', { client_id: c.id, plan_id: unlimited.id, start_date: addDays(eastern().date, -30), status: 'active' }, coach.token);
  members[name] = { token: reg.data.token, client: c };
  return members[name];
}
const makeClass = (hoursOut, extra = {}) => {
  const { date, time } = eastern(Date.now() + hoursOut * 3600000);
  seq += 1;
  return api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: `Class ${seq}`, date, start_time: time, duration_min: 60, slot_id: null, ...extra }, coach.token);
};
const roster = (s) => api.fn('classRoster', { session_id: s.id }, coach.token);
const statusOf = async (s, resId) => (await roster(s)).reservations.find((r) => r.id === resId)?.status;

before(async () => {
  srv = await startServer(8798);
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  const admin = { token: first.data.token };
  const inv = await api.fn('createInvite', { email: 'coach@example.test', full_name: 'Cody Coach' }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Cody Coach', password: 'coach-pass-1' });
  coach = { token: reg.data.token, id: reg.data.user.id };
  crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, coach.token);
  unlimited = await api.create('MembershipPlan', { name: 'Unlimited', kind: 'unlimited', class_type_ids: [], is_active: true }, coach.token);
  await api.create('GymSettings', { waiver_required: false }, coach.token);
  for (const n of ['dana', 'eli', 'fay']) await addMember(n);
});
after(() => srv?.stop());

test('coach checks in a booked member with one call, and undo puts them back to booked', async () => {
  const s = await makeClass(-0.2);
  const b = await api.fn('bookClass', { session_id: s.id, client_id: members.dana.client.id }, coach.token);
  assert.equal(b.success, true, JSON.stringify(b));
  const inn = await api.fn('checkIn', { reservation_id: b.reservation.id }, coach.token);
  assert.equal(inn.success, true, JSON.stringify(inn));
  assert.equal(inn.reservation.check_in_method, 'coach');
  assert.equal(inn.session.checked_in_count, 1);
  assert.equal((await api.fn('checkIn', { reservation_id: b.reservation.id }, coach.token)).already, true, 'second tap is harmless');
  const undo = await api.fn('undoCheckIn', { reservation_id: b.reservation.id }, coach.token);
  assert.equal(undo.success, true);
  assert.equal(undo.reservation.status, 'reserved');
  assert.equal(undo.session.checked_in_count, 0);
  assert.equal(undo.session.reserved_count, 1, 'still holds a spot');
});

test('walk-in: coach adds someone who is not booked; undo removes them', async () => {
  const s = await makeClass(-0.1);
  const w = await api.fn('checkIn', { session_id: s.id, client_id: members.eli.client.id }, coach.token);
  assert.equal(w.success, true, JSON.stringify(w));
  assert.equal(w.reservation.check_in_method, 'walk_in');
  assert.equal(w.session.reserved_count, 1);
  const undo = await api.fn('undoCheckIn', { reservation_id: w.reservation.id }, coach.token);
  assert.equal(undo.reservation.status, 'cancelled');
  assert.equal(undo.session.reserved_count, 0, 'spot is free again');
  assert.equal(undo.session.checked_in_count, 0);
});

test('coach can check in someone from the waitlist (with override when full)', async () => {
  const s = await makeClass(-0.1, { capacity: 1 });
  const first = await api.fn('bookClass', { session_id: s.id, client_id: members.dana.client.id }, coach.token);
  const wl = await api.fn('bookClass', { session_id: s.id, client_id: members.fay.client.id }, coach.token);
  assert.equal(first.status, 'reserved');
  assert.equal(wl.status, 'waitlisted');
  const full = await api.fn('checkIn', { reservation_id: wl.reservation.id }, coach.token);
  assert.equal(full.code, 'class_full');
  assert.equal(full.can_override, true);
  assert.equal((await api.fn('checkIn', { reservation_id: wl.reservation.id, override: true }, coach.token)).success, true);
  assert.equal(await statusOf(s, wl.reservation.id), 'checked_in');
});

test('members cannot check in, undo or see the roster for anyone else', async () => {
  const s = await makeClass(0.2); // inside the member self check-in window
  const b = await api.fn('bookClass', { session_id: s.id, client_id: members.eli.client.id }, coach.token);
  const { dana } = members;
  // Naming someone else is refused.
  const other = await api.fn('checkIn', { session_id: s.id, client_id: members.eli.client.id }, dana.token);
  assert.equal(other.success, false);
  // A reservation id from a member is ignored: Eli stays booked.
  await api.fn('checkIn', { session_id: s.id, reservation_id: b.reservation.id }, dana.token);
  assert.equal(await statusOf(s, b.reservation.id), 'reserved');
  // Coach-only actions.
  assert.equal((await api.fn('undoCheckIn', { reservation_id: b.reservation.id }, dana.token)).success, false);
  assert.equal((await api.fn('classRoster', { session_id: s.id }, dana.token)).success, false);
  // No sign-in at all.
  assert.equal((await api.call('POST', 'functions/checkIn', { reservation_id: b.reservation.id })).status, 401);
  // A member's own check-in still works inside the window (existing rule).
  const own = await api.fn('checkIn', { session_id: s.id }, members.fay.token);
  assert.equal(own.success, true, JSON.stringify(own));
  assert.equal(own.reservation.check_in_method, 'self');
});

test("coach home: today's classes come back with time, coach and booked/capacity", async () => {
  const today = eastern().date;
  const s = await api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: 'Home Class', date: today, start_time: '00:05', duration_min: 60, slot_id: null, capacity: 12, coach_id: coach.id, coach_name: 'Cody Coach' }, coach.token);
  await api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: 'Tomorrow Class', date: addDays(today, 1), start_time: '09:00', duration_min: 60, slot_id: null }, coach.token);
  await api.fn('checkIn', { session_id: s.id, client_id: members.fay.client.id }, coach.token);
  const r = await api.fn('classSchedule', { from: today, to: today }, coach.token);
  assert.equal(r.success, true);
  assert.equal(r.today, today, 'server decides today in gym time');
  assert.ok(r.sessions.every((x) => x.date === today));
  assert.ok(!r.sessions.some((x) => x.class_type_name === 'Tomorrow Class'));
  const row = r.sessions.find((x) => x.id === s.id);
  assert.equal(row.start_time, '00:05');
  assert.equal(row.coach_name, 'Cody Coach');
  assert.equal(row.capacity, 12);
  assert.equal(row.reserved_count, 1);
  assert.equal(row.checked_in_count, 1);
});
