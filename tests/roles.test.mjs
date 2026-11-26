// Roles and permissions: admin, manager, coach, member.
// Runs the real API on a throwaway local database (see server.mjs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';

let srv; let api; let admin; let coach; let manager; let member;
let plan; let crossfit; let membership; let kid;

async function staff(email, name) {
  const inv = await api.fn('createInvite', { email, full_name: name }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: name, password: 'staff-pass-1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  return { token: reg.data.token, id: reg.data.user.id };
}
const me = async (who) => (await api.call('GET', 'auth/me', undefined, who.token)).data;

before(async () => {
  srv = await startServer();
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  admin = { token: first.data.token, id: first.data.user.id };
  coach = await staff('coach@example.test', 'Cody Coach');
  manager = await staff('manager@example.test', 'Mona Manager');
  crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, admin.token);
  plan = await api.create('MembershipPlan', { name: 'Unlimited', kind: 'unlimited', class_type_ids: [], is_active: true }, admin.token);
  await api.create('GymSettings', { waiver_required: false }, admin.token);
  const c = await api.create('Client', { full_name: 'Max Member', email: 'max@example.test', status: 'active' }, admin.token);
  membership = await api.create('Membership', { client_id: c.id, plan_id: plan.id, start_date: addDays(eastern().date, -30), status: 'active' }, admin.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Max Member', password: 'member-pass-1' });
  member = { token: reg.data.token, id: reg.data.user.id, client: c };
  kid = await api.create('Client', { full_name: 'Kit Kid', status: 'active' }, admin.token);
});
after(() => srv?.stop());

test('new staff start as coaches; sign-in reports role and permissions', async () => {
  const c = await me(coach);
  assert.equal(c.staff_role, 'coach');
  assert.ok(c.permissions.includes('classes.run'));
  assert.ok(!c.permissions.includes('members.manage'));
  const a = await me(admin);
  assert.equal(a.staff_role, 'admin');
  assert.ok(a.permissions.includes('staff.manage'));
  const m = await me(member);
  assert.equal(m.staff_role, null);
  assert.deepEqual(m.permissions, []);
});

test('only an admin can change roles, and every change is audited', async () => {
  assert.equal((await api.fn('setStaffRole', { user_id: manager.id, role: 'manager' }, coach.token)).success, false);
  assert.equal((await api.fn('setStaffRole', { user_id: manager.id, role: 'manager' }, member.token)).success, false);
  assert.equal((await api.fn('setStaffRole', { user_id: member.id, role: 'manager' }, admin.token)).success, false, 'members are not staff');
  assert.equal((await api.fn('setStaffRole', { user_id: manager.id, role: 'owner' }, admin.token)).success, false, 'unknown role');
  const r = await api.fn('setStaffRole', { user_id: manager.id, role: 'manager' }, admin.token);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal((await me(manager)).staff_role, 'manager');
  const log = (await api.call('GET', 'audit?limit=200', undefined, admin.token)).data;
  assert.ok(JSON.stringify(log).includes('role_changed'));
  const team = await api.fn('listTeam', {}, admin.token);
  assert.equal(team.team.find((t) => t.id === manager.id).staff_role, 'manager');
  assert.equal((await api.fn('listTeam', {}, manager.token)).success, false, 'managers cannot manage staff');
});

test('nobody can give themselves a role by editing their profile', async () => {
  await api.call('PUT', 'auth/me', { staff_role: 'manager', role: 'admin', user_type: 'trainer' }, coach.token);
  assert.equal((await me(coach)).staff_role, 'coach');
  await api.call('PUT', 'auth/me', { staff_role: 'manager', user_type: 'trainer' }, member.token);
  const m = await me(member);
  assert.equal(m.staff_role, null);
  assert.equal(m.user_type, 'client');
});

test('a coach runs classes but cannot change memberships, schedule, families or see reports', async () => {
  const today = eastern().date;
  assert.equal((await api.fn('holdMembership', { membership_id: membership.id, from: today, to: addDays(today, 3), reason: 'Trip' }, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('setMembershipEndDate', { membership_id: membership.id, end_date: addDays(today, 30) }, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('classReports', {}, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('classDayChange', { date: addDays(today, 9), mode: 'closed', reason: 'Holiday' }, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('linkGuardian', { client_id: kid.id, guardian_client_id: member.client.id }, coach.token)).code, 'forbidden');
  for (const [type, body] of [
    ['Membership', { client_id: member.client.id, plan_id: plan.id, start_date: today, status: 'active' }],
    ['MembershipPlan', { name: 'Sneaky', kind: 'unlimited', is_active: true }],
    ['ClassSlot', { class_type_id: crossfit.id, day_of_week: 1, start_time: '07:00', duration_min: 60, start_date: today, is_active: true }],
    ['GymSettings', { waiver_required: false }],
  ]) {
    const r = await api.call('POST', `entities/${type}`, body, coach.token);
    assert.equal(r.status, 403, `${type}: ${JSON.stringify(r.data)}`);
  }
  // What a coach can still do: run a class.
  const { date, time } = eastern(Date.now() + 2 * 3600000);
  const s = await api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: 'CrossFit', date, start_time: time, duration_min: 60, slot_id: null }, coach.token);
  assert.ok(s.id, JSON.stringify(s));
  assert.equal((await api.fn('classRoster', { session_id: s.id }, coach.token)).success, true);
  assert.equal((await api.fn('editClassSession', { session_id: s.id, capacity: 15 }, coach.token)).success, true);
  assert.equal((await api.fn('createInvite', { client_id: kid.id }, coach.token)).success, false, 'kid has no email');
});

test('a manager handles memberships, schedule, families, booking rules and reports, but not staff', async () => {
  const today = eastern().date;
  const h = await api.fn('holdMembership', { membership_id: membership.id, from: addDays(today, 10), to: addDays(today, 12), reason: 'Trip' }, manager.token);
  assert.equal(h.success, true, JSON.stringify(h));
  assert.equal((await api.fn('classReports', {}, manager.token)).success, true);
  const l = await api.fn('linkGuardian', { client_id: kid.id, guardian_client_id: member.client.id }, manager.token);
  assert.equal(l.success, true, JSON.stringify(l));
  const slot = await api.call('POST', 'entities/ClassSlot', { class_type_id: crossfit.id, day_of_week: 2, start_time: '07:00', duration_min: 60, start_date: today, is_active: true }, manager.token);
  assert.equal(slot.status, 200, JSON.stringify(slot.data));
  assert.equal((await api.call('POST', 'entities/GymSettings', { waiver_required: false }, manager.token)).status, 200);
  assert.equal((await api.fn('createInvite', { email: 'new.coach@example.test', full_name: 'New Coach' }, manager.token)).success, false, 'only admins invite staff');
  assert.equal((await api.fn('setStaffRole', { user_id: coach.id, role: 'manager' }, manager.token)).success, false);
});

test('members get no staff powers', async () => {
  assert.equal((await api.fn('classReports', {}, member.token)).success, false);
  assert.equal((await api.fn('holdMembership', { membership_id: membership.id }, member.token)).success, false);
  assert.equal((await api.call('POST', 'entities/ClassSlot', { class_type_id: crossfit.id, day_of_week: 3, start_time: '07:00' }, member.token)).status, 403);
});

test('admins create a role, tick its rights, assign it, and remove it when unused', async () => {
  assert.equal((await api.fn('listRoles', {}, manager.token)).success, false, 'only admins see roles');
  assert.equal((await api.fn('saveRole', { name: 'Sneaky', rights: ['reports.view'] }, manager.token)).success, false);
  const list = await api.fn('listRoles', {}, admin.token);
  assert.ok(list.rights.length >= 10 && list.roles.some((r) => r.key === 'coach') && list.roles.some((r) => r.key === 'manager'));
  assert.equal((await api.fn('saveRole', { name: 'Bad', rights: ['staff.manage'] }, admin.token)).success, false, 'staff.manage is admin only');
  const made = await api.fn('saveRole', { name: 'Front desk', rights: ['reports.view', 'members.invite'] }, admin.token);
  assert.equal(made.success, true, JSON.stringify(made));
  const desk = await staff('desk@example.test', 'Dee Desk');
  assert.equal((await api.fn('setStaffRole', { user_id: desk.id, role: made.key }, admin.token)).success, true);
  const m = await me(desk);
  assert.equal(m.role_name, 'Front desk');
  assert.deepEqual(m.permissions, ['members.invite', 'reports.view']);
  assert.equal((await api.fn('classReports', {}, desk.token)).success, true);
  assert.equal((await api.fn('holdMembership', { membership_id: membership.id }, desk.token)).code, 'forbidden');
  // Change the role's rights: takes effect on the next request.
  assert.equal((await api.fn('saveRole', { key: made.key, name: 'Front desk', rights: ['members.invite'] }, admin.token)).success, true);
  assert.equal((await api.fn('classReports', {}, desk.token)).code, 'forbidden');
  assert.equal((await api.fn('deleteRole', { key: made.key }, admin.token)).success, false, 'still in use');
  assert.equal((await api.fn('deleteRole', { key: 'coach' }, admin.token)).success, false, 'built-in roles stay');
  await api.fn('setStaffRole', { user_id: desk.id, role: 'coach' }, admin.token);
  assert.equal((await api.fn('deleteRole', { key: made.key }, admin.token)).success, true);
  const log = JSON.stringify((await api.call('GET', 'audit?limit=500', undefined, admin.token)).data);
  assert.ok(log.includes('role_created') && log.includes('role_updated') && log.includes('role_deleted'));
});

test('coaches never see rates or payments; managers and admins do', async () => {
  const p = await api.create('MembershipPlan', { name: 'Premium', kind: 'unlimited', price_label: '$199', is_active: true }, admin.token);
  const c = await api.create('Client', { full_name: 'Pat Payer', status: 'active', rate: 199, payment_method: 'Visa 4242' }, admin.token);
  const asCoach = (await api.call('GET', `entities/MembershipPlan/${p.id}`, undefined, coach.token)).data;
  assert.equal(asCoach.price_label, undefined);
  assert.equal(asCoach.name, 'Premium');
  const coachList = (await api.call('GET', 'entities/Client', undefined, coach.token)).data;
  const pat = coachList.find((x) => x.id === c.id);
  assert.ok(pat && pat.rate === undefined && pat.payment_method === undefined);
  assert.equal((await api.call('GET', `entities/MembershipPlan/${p.id}`, undefined, manager.token)).data.price_label, '$199');
  assert.equal((await api.call('GET', `entities/Client/${c.id}`, undefined, admin.token)).data.rate, 199);
  // A coach editing the record can't change or wipe the hidden price.
  await api.update('Client', c.id, { full_name: 'Pat P.', rate: 1 }, coach.token);
  assert.equal((await api.call('GET', `entities/Client/${c.id}`, undefined, admin.token)).data.rate, 199);
});

test('personal training clients: coaching details only for their coach, managers and admins', async () => {
  const other = await staff('other.coach@example.test', 'Olly Other');
  const pt = await api.create('Client', { full_name: 'Tara Training', status: 'active', personal_training: true, trainer_id: coach.id, injuries: 'Left knee', medical_notes: 'Asthma' }, admin.token);
  const group = await api.create('Client', { full_name: 'Gus Group', status: 'active', injuries: 'Shoulder' }, admin.token);
  await api.create('ClientNote', { client_id: pt.id, note: 'PT note', category: 'medical' }, coach.token);
  await api.create('ClientNote', { client_id: group.id, note: 'Group note' }, coach.token);
  // Her own coach sees everything.
  const mine = (await api.call('GET', `entities/Client/${pt.id}`, undefined, coach.token)).data;
  assert.equal(mine.injuries, 'Left knee');
  assert.ok((await api.call('GET', 'entities/ClientNote', undefined, coach.token)).data.some((n) => n.note === 'PT note'));
  // Another coach sees her basics but not her coaching details.
  const theirs = (await api.call('GET', `entities/Client/${pt.id}`, undefined, other.token)).data;
  assert.equal(theirs.full_name, 'Tara Training');
  assert.equal(theirs.injuries, undefined);
  assert.equal(theirs.details_limited, true);
  const otherNotes = (await api.call('GET', 'entities/ClientNote', undefined, other.token)).data;
  assert.ok(!otherNotes.some((n) => n.note === 'PT note'), 'PT note hidden');
  assert.ok(otherNotes.some((n) => n.note === 'Group note'), 'group members stay open to every coach');
  assert.equal((await api.call('GET', `entities/Client/${group.id}`, undefined, other.token)).data.injuries, 'Shoulder');
  // They can't edit her or take her over.
  assert.equal((await api.update('Client', pt.id, { notes: 'x' }, other.token)).status, 403);
  assert.equal((await api.update('Client', group.id, { personal_training: true, trainer_id: coach.id }, other.token)).status, 403);
  // Managers see everything.
  assert.equal((await api.call('GET', `entities/Client/${pt.id}`, undefined, manager.token)).data.injuries, 'Left knee');
  assert.ok((await api.call('GET', 'entities/ClientNote', undefined, manager.token)).data.some((n) => n.note === 'PT note'));
});
