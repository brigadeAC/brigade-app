// Coach scheduling, coach side (CORE): my schedule, availability, time off,
// and the staff-only scheduling entities. Runs the real API on a throwaway
// local database (see server.mjs). Sample data only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';

let srv; let api; let admin; let coach; let other; let member;
const today = eastern().date;
const SCHED_TYPES = ['StaffShift', 'Availability', 'TimeOffRequest', 'ScheduleWeek'];

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
  coach = await staff('sched.coach@example.test', 'Cody Coach');
  other = await staff('sched.other@example.test', 'Olly Other');
  const c = await api.create('Client', { full_name: 'Max Member', email: 'max.sched@example.test', status: 'active' }, admin.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Max Member', password: 'member-pass-1' });
  member = { token: reg.data.token, id: reg.data.user.id };
  const crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, admin.token);
  // Day 3: a 6:00 class (Cody coaches) and a 10:00–11:00 PT session.
  await api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: 'CrossFit', date: addDays(today, 3), start_time: '06:00', duration_min: 60, coach_user_id: coach.id, coach_name: 'Cody Coach', slot_id: null }, admin.token);
  await api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: 'CrossFit', date: addDays(today, 3), start_time: '17:00', duration_min: 60, coach_user_id: other.id, coach_name: 'Olly Other', slot_id: null }, admin.token);
  await api.create('Session', { client_id: c.id, client_name: 'Pat PT', trainer_id: coach.id, date: addDays(today, 3), start_time: '10:00', end_time: '11:00', type: 'personal_training', status: 'scheduled' }, admin.token);
  await api.create('Session', { client_id: c.id, client_name: 'Cancelled PT', trainer_id: coach.id, date: addDays(today, 4), start_time: '10:00', end_time: '11:00', type: 'personal_training', status: 'cancelled' }, admin.token);
});
after(() => srv?.stop());

test('my schedule lists my classes and PT sessions with hours', async () => {
  const r = await api.fn('mySchedule', { from: addDays(today, 1), to: addDays(today, 7) }, coach.token);
  assert.equal(r.success, true, JSON.stringify(r));
  const kinds = r.items.map((i) => `${i.kind}:${i.title}:${i.start}-${i.end}`);
  assert.deepEqual(kinds, ['class:CrossFit:06:00-07:00', 'pt:Pat PT:10:00-11:00']);
  assert.equal(r.hours_total, 2);
  // Default range is this Monday–Sunday.
  const d = await api.fn('mySchedule', {}, coach.token);
  assert.equal(d.success, true);
  assert.equal(addDays(d.from, 6), d.to);
  assert.equal(new Date(`${d.from}T12:00:00Z`).getUTCDay(), 1);
  // Too long a range is refused.
  assert.equal((await api.fn('mySchedule', { from: today, to: addDays(today, 70) }, coach.token)).success, false);
  // Only schedule managers may look at someone else's.
  assert.equal((await api.fn('mySchedule', { user_id: coach.id }, other.token)).code, 'forbidden');
  const asAdmin = await api.fn('mySchedule', { user_id: coach.id, from: addDays(today, 1), to: addDays(today, 7) }, admin.token);
  assert.equal(asAdmin.items.length, 2);
});

test('availability: two-week grid, save inside the window, copy a week', async () => {
  const empty = await api.fn('myAvailability', {}, coach.token);
  assert.equal(empty.days.length, 14);
  assert.equal(empty.days[0].date, today);
  assert.deepEqual(empty.days[0].blocks, { early: false, midday: false, evening: false });
  assert.equal((await api.fn('saveAvailability', { days: [{ date: addDays(today, -1), blocks: { early: true } }] }, coach.token)).success, false, 'no past dates');
  assert.equal((await api.fn('saveAvailability', { days: [{ date: addDays(today, 28), blocks: { early: true } }] }, coach.token)).success, false, 'four weeks max');
  assert.equal((await api.fn('saveAvailability', { days: [{ date: addDays(today, 27), blocks: { evening: true } }] }, coach.token)).success, true);
  assert.equal((await api.fn('copyAvailabilityLastWeek', {}, coach.token)).success, false, 'nothing saved yet this week');
  const week = Array.from({ length: 7 }, (_, i) => ({ date: addDays(today, i), blocks: { early: i % 2 === 0, midday: false, evening: true, junk: true }, note: i === 0 ? 'Late start' : '' }));
  const saved = await api.fn('saveAvailability', { days: week }, coach.token);
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.deepEqual(saved.days[0].blocks, { early: true, midday: false, evening: true });
  // Saving the same day again updates it, not a second row.
  await api.fn('saveAvailability', { days: [{ date: today, blocks: { midday: true }, note: 'Changed' }] }, coach.token);
  const copied = await api.fn('copyAvailabilityLastWeek', {}, coach.token);
  assert.equal(copied.success, true, JSON.stringify(copied));
  assert.equal(copied.copied, 7);
  const after14 = await api.fn('myAvailability', {}, coach.token);
  assert.equal(after14.days[0].note, 'Changed');
  assert.deepEqual(after14.days[7].blocks, { early: false, midday: true, evening: false }, 'same weekday as today');
  assert.deepEqual(after14.days[8].blocks, after14.days[1].blocks);
  assert.ok(after14.days.every((d) => d.saved));
  const rows = await api.list('Availability', coach.token);
  assert.equal(rows.filter((r) => r.date === today).length, 1);
  // Coaches don't see each other's availability through the entity API.
  assert.equal((await api.list('Availability', other.token)).length, 0);
});

test('time off: impact, request, overlap, cancel', async () => {
  const day = addDays(today, 3);
  assert.equal((await api.fn('timeOffImpact', { start_date: addDays(today, -2), end_date: today }, coach.token)).success, false, 'no past dates');
  assert.equal((await api.fn('timeOffImpact', { start_date: day, end_date: addDays(day, 1), part_day: { start: '09:00', end: '12:00' } }, coach.token)).success, false, 'part day is one day only');
  const whole = await api.fn('timeOffImpact', { start_date: day, end_date: day }, coach.token);
  assert.deepEqual(whole.affected.map((a) => a.kind), ['class', 'pt']);
  const part = await api.fn('timeOffImpact', { start_date: day, end_date: day, part_day: { start: '09:00', end: '12:00' } }, coach.token);
  assert.deepEqual(part.affected.map((a) => a.label), ['Pat PT']);

  const r = await api.fn('requestTimeOff', { start_date: day, end_date: addDays(day, 1), reason: 'Family wedding' }, coach.token);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.request.status, 'pending');
  assert.equal(r.request.affected.length, 2);
  const again = await api.fn('requestTimeOff', { start_date: addDays(day, 1), end_date: addDays(day, 2) }, coach.token);
  assert.equal(again.code, 'overlap');

  // The admin (a schedule manager) is told.
  const notes = await api.list('Notification', admin.token);
  assert.ok(notes.some((n) => n.user_id === admin.id && n.title === 'Time off request' && !String(n.message).includes('wedding')));

  // It shows on my schedule, the day grayed out.
  const s = await api.fn('mySchedule', { from: day, to: addDays(day, 1) }, coach.token);
  assert.equal(s.items.filter((i) => i.kind === 'time_off').length, 2);
  assert.equal(s.time_off[0].reason, 'Family wedding');

  const mine = await api.fn('myTimeOff', {}, coach.token);
  assert.equal(mine.requests.length, 1);
  assert.equal((await api.fn('cancelTimeOff', { id: r.request.id }, other.token)).success, false, 'not theirs');
  const c = await api.fn('cancelTimeOff', { id: r.request.id }, coach.token);
  assert.equal(c.request.status, 'cancelled');
  assert.equal((await api.fn('cancelTimeOff', { id: r.request.id }, coach.token)).success, false, 'already cancelled');
  // Free again: a new request for the same days works.
  assert.equal((await api.fn('requestTimeOff', { start_date: day, end_date: day, part_day: { start: '09:00', end: '12:00' }, reason: 'Dentist' }, coach.token)).success, true);
  // A second part-day request that doesn't overlap is fine.
  assert.equal((await api.fn('requestTimeOff', { start_date: day, end_date: day, part_day: { start: '14:00', end: '15:00' } }, coach.token)).success, true);
});

test('a coach cannot read another coach\'s time-off reason', async () => {
  const r = await api.fn('requestTimeOff', { start_date: addDays(today, 10), end_date: addDays(today, 11), reason: 'Private medical thing' }, other.token);
  assert.equal(r.success, true, JSON.stringify(r));
  const list = await api.list('TimeOffRequest', coach.token);
  assert.ok(!JSON.stringify(list).includes('Private medical thing'));
  assert.ok(!list.some((x) => x.id === r.request.id));
  const get = await api.call('GET', `entities/TimeOffRequest/${r.request.id}`, undefined, coach.token);
  assert.equal(get.status, 404);
  assert.ok(!JSON.stringify(get.data).includes('Private medical thing'));
  // Their own and the manager's views keep it.
  assert.equal((await api.call('GET', `entities/TimeOffRequest/${r.request.id}`, undefined, other.token)).data.reason, 'Private medical thing');
  assert.equal((await api.call('GET', `entities/TimeOffRequest/${r.request.id}`, undefined, admin.token)).data.reason, 'Private medical thing');
  // A coach can't look at someone else's schedule (and its time off) either.
  assert.equal((await api.fn('mySchedule', { user_id: other.id }, coach.token)).code, 'forbidden');
});

test('members cannot list, get or write the scheduling entities, or call the functions', async () => {
  const req = (await api.list('TimeOffRequest', admin.token))[0];
  assert.ok(req, 'there is a request to probe');
  for (const type of SCHED_TYPES) {
    const l = await api.call('GET', `entities/${type}`, undefined, member.token);
    assert.equal(l.status, 200);
    assert.deepEqual(l.data, [], `${type} list`);
    const w = await api.call('POST', `entities/${type}`, { user_id: member.id, date: today, status: 'published' }, member.token);
    assert.equal(w.status, 403, `${type} write`);
  }
  assert.equal((await api.call('GET', `entities/TimeOffRequest/${req.id}`, undefined, member.token)).status, 404);
  const avail = (await api.list('Availability', admin.token))[0];
  assert.equal((await api.call('GET', `entities/Availability/${avail.id}`, undefined, member.token)).status, 404);
  assert.equal((await api.call('PUT', `entities/TimeOffRequest/${req.id}`, { status: 'approved' }, member.token)).status, 404);
  for (const name of ['mySchedule', 'myAvailability', 'saveAvailability', 'copyAvailabilityLastWeek', 'timeOffImpact', 'requestTimeOff', 'cancelTimeOff', 'myTimeOff']) {
    assert.equal((await api.fn(name, {}, member.token)).success, false, name);
  }
});

test('generic entity writes need coach_schedule.manage; coaches see only published shifts', async () => {
  const shift = { user_id: coach.id, user_name: 'Cody Coach', date: addDays(today, 5), start: '12:00', end: '15:00', role_label: 'Front desk', note: '' };
  // A coach can't write shifts (or approve their own time off) through the entity API.
  assert.equal((await api.call('POST', 'entities/StaffShift', { ...shift, status: 'published' }, coach.token)).status, 403);
  const mine = (await api.list('TimeOffRequest', coach.token)).find((x) => x.status === 'pending');
  assert.equal((await api.update('TimeOffRequest', mine.id, { status: 'approved' }, coach.token)).status, 403, 'no self-approval');
  // A schedule manager (admin here) can.
  const draft = await api.call('POST', 'entities/StaffShift', { ...shift, status: 'draft' }, admin.token);
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const pub = await api.call('POST', 'entities/StaffShift', { ...shift, date: addDays(today, 6), status: 'published' }, admin.token);
  assert.equal(pub.status, 200);
  // Coaches see published shifts only; managers see drafts too.
  const coachList = await api.list('StaffShift', coach.token);
  assert.deepEqual(coachList.map((x) => x.id), [pub.data.id]);
  assert.equal((await api.call('GET', `entities/StaffShift/${draft.data.id}`, undefined, coach.token)).status, 404);
  assert.equal((await api.list('StaffShift', admin.token)).length, 2);
  // My schedule shows the published shift, not the draft.
  const s = await api.fn('mySchedule', { from: addDays(today, 5), to: addDays(today, 6) }, coach.token);
  assert.deepEqual(s.items.map((i) => `${i.kind}:${i.date}:${i.title}`), [`shift:${addDays(today, 6)}:Front desk`]);
  assert.equal(s.hours_total, 3);
});
