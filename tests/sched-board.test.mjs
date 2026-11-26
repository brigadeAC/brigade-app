// Coach scheduling, manager side: board, shifts, publish, time off inbox.
// Runs the real API on a throwaway local database (see server.mjs). Sample people only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';

let srv; let api; let admin; let manager; let coach; let coach2; let coach3; let member; let crossfit;
const today = eastern().date;
const monday = (k) => addDays(k, -((new Date(`${k}T12:00:00Z`).getUTCDay() + 6) % 7));
const nextWeek = addDays(monday(today), 7);
const weekAfter = addDays(nextWeek, 7);

async function staff(email, name) {
  const inv = await api.fn('createInvite', { email, full_name: name }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: name, password: 'staff-pass-1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  return { token: reg.data.token, id: reg.data.user.id };
}

before(async () => {
  srv = await startServer();
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  admin = { token: first.data.token, id: first.data.user.id };
  manager = await staff('mgr@example.test', 'Mona Manager');
  coach = await staff('coach1@example.test', 'Cody Coach');
  coach2 = await staff('coach2@example.test', 'Bea Backup');
  coach3 = await staff('coach3@example.test', 'Otto Off');
  assert.equal((await api.fn('setStaffRole', { user_id: manager.id, role: 'manager' }, admin.token)).success, true);
  crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, admin.token);
  await api.create('GymSettings', { waiver_required: false }, admin.token);
  const c = await api.create('Client', { full_name: 'Max Member', email: 'max@example.test', status: 'active' }, admin.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Max Member', password: 'member-pass-1' });
  member = { token: reg.data.token, id: reg.data.user.id };
});
after(() => srv?.stop());

test('managers get coach_schedule.manage; coaches and members are refused', async () => {
  const m = (await api.call('GET', 'auth/me', undefined, manager.token)).data;
  assert.ok(m.permissions.includes('coach_schedule.manage'));
  const c = (await api.call('GET', 'auth/me', undefined, coach.token)).data;
  assert.ok(!c.permissions.includes('coach_schedule.manage'));
  for (const [fn, body] of [['scheduleBoard', {}], ['saveShift', { user_id: coach.id, date: nextWeek, start: '06:00', end: '10:00' }],
    ['deleteShift', { id: 'x' }], ['assignClassCoach', { session_id: 'x', coach_user_id: coach.id }], ['copyScheduleWeek', { from_week: nextWeek }],
    ['publishSchedule', { week_start: nextWeek }], ['timeOffInbox', {}], ['decideTimeOff', { id: 'x', approve: true }]]) {
    assert.equal((await api.fn(fn, body, coach.token)).code, 'forbidden', `coach ${fn}`);
    assert.equal((await api.fn(fn, body, member.token)).code, 'forbidden', `member ${fn}`);
  }
  const b = await api.fn('scheduleBoard', { week_start: addDays(nextWeek, 3) }, manager.token);
  assert.equal(b.success, true, JSON.stringify(b));
  assert.equal(b.week_start, nextWeek, 'snaps to Monday');
  assert.equal(b.days.length, 7);
  assert.ok(b.coaches.some((x) => x.id === coach.id));
});

test('shifts stay drafts until the week is published, then coaches are told', async () => {
  const s = await api.fn('saveShift', { user_id: coach.id, date: nextWeek, start: '06:00', end: '10:00', role_label: 'Coach' }, manager.token);
  assert.equal(s.success, true, JSON.stringify(s));
  assert.equal(s.shift.status, 'draft');
  assert.equal((await api.fn('saveShift', { user_id: coach.id, date: nextWeek, start: '10:00', end: '09:00' }, manager.token)).success, false);
  // CORE's mySchedule may not be merged yet; check it only when it exists.
  const hasMySchedule = Array.isArray((await api.fn('mySchedule', { from: nextWeek, to: addDays(nextWeek, 6) }, coach.token))?.items);
  if (hasMySchedule) {
    const mine = await api.fn('mySchedule', { from: nextWeek, to: addDays(nextWeek, 6) }, coach.token);
    assert.ok(!mine.items.some((i) => i.id === s.shift.id), 'draft hidden from coach');
  }
  let b = await api.fn('scheduleBoard', { week_start: nextWeek }, manager.token);
  assert.equal(b.status, 'draft');
  assert.equal(b.counts.drafts, 1);
  const pub = await api.fn('publishSchedule', { week_start: nextWeek }, manager.token);
  assert.equal(pub.success, true, JSON.stringify(pub));
  assert.equal(pub.published, 1);
  b = await api.fn('scheduleBoard', { week_start: nextWeek }, manager.token);
  assert.equal(b.status, 'published');
  assert.equal(b.shifts.find((x) => x.id === s.shift.id).status, 'published');
  assert.equal(b.counts.drafts, 0);
  if (hasMySchedule) {
    const mine = await api.fn('mySchedule', { from: nextWeek, to: addDays(nextWeek, 6) }, coach.token);
    assert.ok(mine.items.some((i) => i.id === s.shift.id), 'published shift visible to coach');
  }
  const notes = await api.list('Notification', coach.token);
  assert.ok(notes.some((n) => /schedule for the week of/.test(n.message)), JSON.stringify(notes));
  // An edit on a published week goes back to draft until it is published again.
  const e = await api.fn('saveShift', { id: s.shift.id, end: '11:00' }, manager.token);
  assert.equal(e.shift.status, 'draft');
  assert.equal((await api.fn('scheduleBoard', { week_start: nextWeek }, manager.token)).counts.drafts, 1);
  const log = JSON.stringify((await api.call('GET', 'audit?limit=200', undefined, admin.token)).data);
  assert.ok(log.includes('published week'));
});

test('saveShift warns on time off and outside availability; copy week skips time off', async () => {
  await api.create('Availability', { user_id: coach2.id, date: addDays(nextWeek, 1), blocks: { early: true, midday: false, evening: false }, note: '' }, admin.token);
  const w = await api.fn('saveShift', { user_id: coach2.id, date: addDays(nextWeek, 1), start: '15:00', end: '18:00' }, manager.token);
  assert.equal(w.success, true);
  assert.ok(w.warnings.some((x) => /availability/.test(x)), JSON.stringify(w.warnings));
  await api.create('TimeOffRequest', { user_id: coach3.id, user_name: 'Otto Off', start_date: addDays(weekAfter, 1), end_date: addDays(weekAfter, 1), part_day: null, reason: 'Trip', status: 'approved' }, admin.token);
  const o = await api.fn('saveShift', { user_id: coach3.id, date: addDays(weekAfter, 1), start: '06:00', end: '08:00' }, manager.token);
  assert.ok(o.warnings.some((x) => /time off/.test(x)));
  await api.fn('deleteShift', { id: o.shift.id }, manager.token);
  await api.fn('saveShift', { user_id: coach3.id, date: addDays(nextWeek, 1), start: '06:00', end: '08:00' }, manager.token);
  const cp = await api.fn('copyScheduleWeek', { from_week: nextWeek, to_week: weekAfter }, manager.token);
  assert.equal(cp.success, true, JSON.stringify(cp));
  assert.ok(cp.skipped.some((x) => x.user_name === 'Otto Off' && x.reason === 'time off'));
  const b = await api.fn('scheduleBoard', { week_start: weekAfter }, manager.token);
  assert.ok(b.shifts.length >= 2 && b.shifts.every((x) => x.status === 'draft'));
  assert.ok(!b.shifts.some((x) => x.user_id === coach3.id));
});

test('assignClassCoach goes through editClassSession', async () => {
  const s = await api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: 'Noon WOD', date: addDays(nextWeek, 2), start_time: '12:00', duration_min: 60, slot_id: null }, admin.token);
  let b = await api.fn('scheduleBoard', { week_start: nextWeek }, manager.token);
  assert.ok(b.classes.find((c) => c.id === s.id).needs_coach);
  assert.ok(b.counts.needs_coach >= 1);
  assert.equal((await api.fn('assignClassCoach', { session_id: s.id, coach_user_id: member.id }, manager.token)).success, false, 'members cannot coach');
  const r = await api.fn('assignClassCoach', { session_id: s.id, coach_user_id: coach2.id }, manager.token);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.session.coach_user_id, coach2.id);
  assert.equal(r.session.coach_name, 'Bea Backup');
  assert.equal(r.session.edited_manually, true);
  const log = JSON.stringify((await api.call('GET', 'audit?limit=200', undefined, admin.token)).data);
  assert.ok(log.includes('edited one class: coach'));
  b = await api.fn('scheduleBoard', { week_start: nextWeek }, manager.token);
  assert.ok(!b.classes.find((c) => c.id === s.id).needs_coach);
});

test('time off inbox suggests cover only from people who are free and not on time off', async () => {
  const day = addDays(nextWeek, 4);
  const cls = await api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: '6am CrossFit', date: day, start_time: '06:00', duration_min: 60, slot_id: null, coach_user_id: coach.id, coach_name: 'Cody Coach' }, admin.token);
  for (const who of [coach2, coach3]) await api.create('Availability', { user_id: who.id, date: day, blocks: { early: true, midday: true, evening: false }, note: '' }, admin.token);
  await api.create('TimeOffRequest', { user_id: coach3.id, user_name: 'Otto Off', start_date: day, end_date: day, part_day: null, reason: 'Wedding', status: 'approved' }, admin.token);
  const req = await api.create('TimeOffRequest', { user_id: coach.id, user_name: 'Cody Coach', start_date: day, end_date: day, part_day: null, reason: 'Doctor', status: 'pending' }, admin.token);
  const inbox = await api.fn('timeOffInbox', {}, manager.token);
  assert.equal(inbox.success, true, JSON.stringify(inbox));
  assert.equal(inbox.requests[0].status, 'pending', 'pending first');
  const mine = inbox.requests.find((x) => x.id === req.id);
  const a = mine.affected.find((x) => x.id === cls.id);
  assert.ok(a, JSON.stringify(mine.affected));
  const ids = a.cover_suggestions.map((x) => x.id);
  assert.ok(ids.includes(coach2.id), 'free and available');
  assert.ok(!ids.includes(coach3.id), 'on time off');
  assert.ok(!ids.includes(coach.id), 'not the requester');
  const d = await api.fn('decideTimeOff', { id: req.id, approve: true, note: 'Feel better' }, manager.token);
  assert.equal(d.success, true, JSON.stringify(d));
  assert.equal(d.request.status, 'approved');
  assert.equal(d.request.decided_by, manager.id);
  assert.equal((await api.fn('decideTimeOff', { id: req.id, approve: false }, manager.token)).success, false, 'decided once');
  const notes = await api.list('Notification', coach.token);
  assert.ok(notes.some((n) => n.title === 'Time off approved'));
  // Approving does not unassign the class.
  const b = await api.fn('scheduleBoard', { week_start: nextWeek }, manager.token);
  assert.equal(b.classes.find((c) => c.id === cls.id).coach_user_id, coach.id);
  const hist = await api.fn('timeOffInbox', { status: 'history' }, manager.token);
  assert.ok(hist.requests.every((x) => x.status !== 'pending'));
});
