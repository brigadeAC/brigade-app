// Coach scheduling with shifts switched off (the default): the board shows
// classes and PT only, and shift actions are refused. Sample people only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, ADMIN } from './server.mjs';

let srv; let api; let admin;
const today = eastern().date;
const monday = (k) => addDays(k, -((new Date(`${k}T12:00:00Z`).getUTCDay() + 6) % 7));
const nextWeek = addDays(monday(today), 7);

before(async () => {
  srv = await startServer();
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  admin = { token: first.data.token, id: first.data.user.id };
});
after(() => srv?.stop());

test('shifts are off by default: hidden everywhere and shift actions refused', async () => {
  // An old shift row (e.g. from before the switch) must not show up anywhere.
  await api.create('StaffShift', { user_id: admin.id, user_name: 'Ada Admin', date: nextWeek, start: '06:00', end: '10:00', role_label: 'Coach', status: 'published' }, admin.token);
  const b = await api.fn('scheduleBoard', { week_start: nextWeek }, admin.token);
  assert.equal(b.success, true, JSON.stringify(b));
  assert.equal(b.shifts_enabled, false);
  assert.deepEqual(b.shifts, []);
  const mine = await api.fn('mySchedule', { from: nextWeek, to: addDays(nextWeek, 6) }, admin.token);
  assert.equal(mine.shifts_enabled, false);
  assert.ok(!mine.items.some((i) => i.kind === 'shift'));
  for (const [fn, body] of [['saveShift', { user_id: admin.id, date: nextWeek, start: '06:00', end: '10:00' }],
    ['copyScheduleWeek', { from_week: nextWeek }], ['publishSchedule', { week_start: nextWeek }]]) {
    const r = await api.fn(fn, body, admin.token);
    assert.equal(r.success, false, fn);
    assert.match(r.error, /turned off/);
  }
  assert.equal((await api.fn('getReminderPrefs', {}, admin.token)).shifts_enabled, false);
});
