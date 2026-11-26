// Guardian accounts: a parent books for a linked child; nobody else can.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';

let srv; let api; let admin; let coach;
let crossfit; let unlimited;
const PW = 'member-pass-1';
let seq = 0;
const m = {}; // members with logins
const kids = {}; // child Client records (no login, no email)

async function addMember(name, { plan = unlimited } = {}) {
  const email = `${name}@example.test`;
  const c = await api.create('Client', { full_name: `${name} Parent`, email, status: 'active' }, coach.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, coach.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: `${name} Parent`, password: PW });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  if (plan) await api.create('Membership', { client_id: c.id, plan_id: plan.id, start_date: addDays(eastern().date, -30), status: 'active' }, coach.token);
  m[name] = { token: reg.data.token, client: c, email, id: reg.data.user.id };
  return m[name];
}
async function addChild(name, { plan = unlimited, membership = {} } = {}) {
  const c = await api.create('Client', { full_name: `${name} Kid`, status: 'active' }, coach.token);
  if (plan) kids[`${name}Membership`] = await api.create('Membership', { client_id: c.id, plan_id: plan.id, start_date: addDays(eastern().date, -30), status: 'active', ...membership }, coach.token);
  kids[name] = c;
  return c;
}
const makeClass = (hoursOut, extra = {}) => {
  const { date, time } = eastern(Date.now() + hoursOut * 3600000);
  seq += 1;
  return api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: `Kids ${seq}`, date, start_time: time, duration_min: 60, slot_id: null, ...extra }, coach.token);
};
const link = (child, guardian, token = coach.token) => api.fn('linkGuardian', { client_id: child.id, guardian_client_id: guardian.client.id }, token);
const unlink = (child, guardian, token = coach.token) => api.fn('unlinkGuardian', { client_id: child.id, guardian_client_id: guardian.client.id }, token);
const bookFor = (who, s, child) => api.fn('bookClass', { session_id: s.id, client_id: child.id }, who.token);
const auditActions = async () => (await api.call('GET', 'audit?limit=1000', undefined, admin.token)).data;

before(async () => {
  srv = await startServer(8798);
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  admin = { token: first.data.token, id: first.data.user.id };
  const inv = await api.fn('createInvite', { email: 'coach@example.test', full_name: 'Cody Coach' }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Cody Coach', password: 'coach-pass-1' });
  coach = { token: reg.data.token, id: reg.data.user.id };
  // The setup account manages memberships and class setup, so make it a manager.
  assert.equal((await api.fn('setStaffRole', { user_id: coach.id, role: 'manager' }, admin.token)).success, true);
  crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, coach.token);
  unlimited = await api.create('MembershipPlan', { name: 'Unlimited', kind: 'unlimited', class_type_ids: [], is_active: true }, coach.token);
  await api.create('GymSettings', { waiver_required: false }, coach.token);
  await addMember('pat', { plan: null }); // a parent who does not train
  await addMember('quinn'); // another parent
  await addMember('rory'); // a member with no children
  await addChild('sam');
  await addChild('tess');
  await addChild('uma', { plan: null });
});
after(() => srv?.stop());

test('only staff can link guardians, and linking is audited', async () => {
  assert.equal((await link(kids.sam, m.pat, m.pat.token)).success, false, 'a member cannot link themselves');
  assert.equal((await link(kids.sam, m.pat, m.rory.token)).success, false, 'a member cannot link anyone');
  assert.equal((await api.fn('clientFamily', { client_id: kids.sam.id }, m.pat.token)).success, false);
  assert.equal((await api.call('POST', 'functions/linkGuardian', {})).status, 401, 'signed out');
  const r = await link(kids.sam, m.pat);
  assert.equal(r.success, true, r.error);
  assert.equal((await link(kids.sam, m.pat)).already, true, 'linking twice is harmless');
  assert.equal((await link(kids.tess, m.quinn)).success, true);
  assert.equal((await link(kids.uma, m.pat)).success, true);
  const fam = await api.fn('clientFamily', { client_id: kids.sam.id }, coach.token);
  assert.deepEqual(fam.guardians.map((g) => g.id), [m.pat.client.id]);
  assert.equal(fam.guardians[0].has_login, true);
  const famPat = await api.fn('clientFamily', { client_id: m.pat.client.id }, coach.token);
  assert.deepEqual(famPat.children.map((c) => c.id).sort(), [kids.sam.id, kids.uma.id].sort());
  const log = await auditActions();
  assert.ok(log.some((e) => e.action === 'guardian_linked' && e.target_id === kids.sam.id), 'audit entry');
});

test('a client cannot be linked to themselves or to a guardian without an email', async () => {
  assert.equal((await api.fn('linkGuardian', { client_id: m.pat.client.id, guardian_client_id: m.pat.client.id }, coach.token)).success, false);
  assert.equal((await api.fn('linkGuardian', { client_id: kids.tess.id, guardian_client_id: kids.sam.id }, coach.token)).success, false);
  assert.equal((await api.fn('linkGuardian', { client_id: m.pat.client.id, guardian_client_id: kids.sam.id }, coach.token)).success, false, 'no reverse links');
});

test('a guardian sees their children', async () => {
  const fam = await api.fn('myFamily', {}, m.pat.token);
  assert.deepEqual(fam.children.map((c) => c.full_name).sort(), ['sam Kid', 'uma Kid']);
  assert.deepEqual((await api.fn('myFamily', {}, m.rory.token)).children, []);
});

test('a guardian books, views and cancels for their child, under the child\'s name', async () => {
  const s = await makeClass(30);
  const b = await bookFor(m.pat, s, kids.sam);
  assert.equal(b.success, true, b.error);
  assert.equal(b.reservation.client_id, kids.sam.id);
  assert.equal(b.reservation.client_name, 'sam Kid');
  assert.equal(b.reservation.booked_by, m.pat.id);
  // Child's view has the class; the parent's own view does not.
  const childView = await api.fn('myClasses', { client_id: kids.sam.id }, m.pat.token);
  assert.equal(childView.success, true, childView.error);
  assert.ok(childView.upcoming.some((r) => r.id === b.reservation.id));
  const ownView = await api.fn('myClasses', {}, m.pat.token);
  assert.ok(!ownView.upcoming.some((r) => r.id === b.reservation.id));
  const sched = await api.fn('classSchedule', { from: s.date, to: s.date, client_id: kids.sam.id }, m.pat.token);
  assert.equal(sched.sessions.find((x) => x.id === s.id).my_reservation.id, b.reservation.id);
  // The child (no login) is on the coach's roster by name, ready for check-in.
  const roster = await api.fn('classRoster', { session_id: s.id }, coach.token);
  assert.ok(roster.reservations.some((r) => r.client_name === 'sam Kid' && r.status === 'reserved'));
  const c = await api.fn('cancelReservation', { reservation_id: b.reservation.id }, m.pat.token);
  assert.equal(c.success, true, c.error);
  const log = await auditActions();
  assert.ok(log.some((e) => e.target_id === b.reservation.id && /guardian/.test(e.detail)), 'booking audit notes the guardian');
});

test('the child\'s own rules apply: plan, holds, booking window, waitlist', async () => {
  assert.equal((await bookFor(m.pat, await makeClass(30), kids.uma)).code, 'no_membership', 'uma has no plan, even though pat is the booker');
  assert.equal((await bookFor(m.pat, await makeClass(24 * 10), kids.sam)).code, 'booking_not_open');
  const s = await makeClass(31, { capacity: 1 });
  assert.equal((await api.fn('bookClass', { session_id: s.id }, m.rory.token)).status, 'reserved');
  assert.equal((await bookFor(m.pat, s, kids.sam)).status, 'waitlisted');
  // A parent with no plan of their own still cannot book for themselves.
  assert.equal((await api.fn('bookClass', { session_id: (await makeClass(30)).id }, m.pat.token)).code, 'no_membership');
  // Child on hold: refused.
  await api.update('Membership', kids.samMembership.id, { status: 'on_hold', hold_from: addDays(eastern().date, -1), hold_to: null }, coach.token);
  assert.equal((await bookFor(m.pat, await makeClass(30), kids.sam)).success, false);
  await api.update('Membership', kids.samMembership.id, { status: 'active', hold_from: null, hold_to: null }, coach.token);
});

test('a non-guardian cannot book, cancel or view a child\'s classes', async () => {
  const s = await makeClass(32);
  const b = await bookFor(m.pat, s, kids.sam);
  assert.equal(b.success, true, b.error);
  for (const who of [m.rory, m.quinn]) {
    assert.equal((await bookFor(who, await makeClass(32), kids.sam)).success, false, 'book');
    assert.equal((await api.fn('cancelReservation', { reservation_id: b.reservation.id }, who.token)).success, false, 'cancel');
    assert.equal((await api.fn('myClasses', { client_id: kids.sam.id }, who.token)).success, false, 'view classes');
    assert.equal((await api.fn('classSchedule', { client_id: kids.sam.id }, who.token)).success, false, 'view schedule');
    assert.equal((await api.fn('checkIn', { session_id: s.id, client_id: kids.sam.id }, who.token)).success, false, 'check in');
    assert.equal((await api.call('GET', `entities/Client/${kids.sam.id}`, undefined, who.token)).status, 404, 'client record');
  }
  // A guardian acts only for their own children, never another member or child.
  assert.equal((await bookFor(m.pat, await makeClass(32), kids.tess)).success, false, 'another family\'s child');
  assert.equal((await bookFor(m.pat, await makeClass(32), m.rory.client)).success, false, 'another adult member');
  assert.equal((await api.fn('myClasses', { client_id: m.rory.client.id }, m.pat.token)).success, false);
  assert.equal((await api.fn('myClasses', { client_id: kids.tess.id }, m.pat.token)).success, false);
  const t = await bookFor(m.quinn, await makeClass(33), kids.tess);
  assert.equal(t.success, true, t.error);
  assert.equal((await api.fn('cancelReservation', { reservation_id: t.reservation.id }, m.pat.token)).success, false);
  await api.fn('cancelReservation', { reservation_id: b.reservation.id }, m.pat.token);
});

test('a child can have two guardians; unlinking stops access and keeps the records', async () => {
  assert.equal((await link(kids.sam, m.quinn)).success, true);
  const s = await makeClass(34);
  const b = await bookFor(m.quinn, s, kids.sam);
  assert.equal(b.success, true, b.error);
  assert.equal((await bookFor(m.pat, s, kids.sam)).code, 'already_booked', 'both guardians see one booking');
  const r = await unlink(kids.sam, m.quinn);
  assert.equal(r.success, true, r.error);
  assert.equal((await unlink(kids.sam, m.quinn)).success, false, 'already unlinked');
  assert.equal((await unlink(kids.sam, m.pat, m.pat.token)).success, false, 'members cannot unlink');
  assert.equal((await api.fn('cancelReservation', { reservation_id: b.reservation.id }, m.quinn.token)).success, false);
  assert.equal((await bookFor(m.quinn, await makeClass(35), kids.sam)).success, false);
  assert.ok(!(await api.fn('myFamily', {}, m.quinn.token)).children.some((c) => c.id === kids.sam.id));
  // Nothing was deleted: the child and the booking are still there.
  assert.equal((await api.call('GET', `entities/Client/${kids.sam.id}`, undefined, coach.token)).status, 200);
  assert.equal((await api.fn('classRoster', { session_id: s.id }, coach.token)).reservations.filter((x) => x.status === 'reserved').length, 1);
  // Pat is still a guardian and can cancel it.
  assert.equal((await api.fn('cancelReservation', { reservation_id: b.reservation.id }, m.pat.token)).success, true);
  const log = await auditActions();
  assert.ok(log.some((e) => e.action === 'guardian_unlinked' && e.target_id === kids.sam.id));
  // Relinking works again.
  assert.equal((await link(kids.sam, m.quinn)).success, true);
  assert.equal((await unlink(kids.sam, m.quinn)).success, true);
});

test('a coach checks in a child who has no login', async () => {
  const s = await makeClass(0.2);
  const inn = await api.fn('checkIn', { session_id: s.id, client_id: kids.sam.id }, coach.token);
  assert.equal(inn.success, true, inn.error);
  assert.equal(inn.reservation.client_name, 'sam Kid');
  // And a guardian can self check-in their child in the window.
  const s2 = await makeClass(0.2);
  const g = await api.fn('checkIn', { session_id: s2.id, client_id: kids.sam.id }, m.pat.token);
  assert.equal(g.success, true, g.error);
  assert.equal(g.reservation.client_id, kids.sam.id);
});
