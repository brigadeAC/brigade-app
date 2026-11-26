// Coach scheduling, REMIND: reminder settings, the cron reminder step and the
// phone calendar (.ics) feed. Runs the real API on a throwaway local database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN, CRON_SECRET } from './server.mjs';

let srv; let api; let admin; let cody; let bea; let member; let crossfit;

async function staff(email, name) {
  const inv = await api.fn('createInvite', { email, full_name: name }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: name, password: 'staff-pass-1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  return { token: reg.data.token, id: reg.data.user.id };
}
const tick = () => api.call('POST', 'cron/program-tick', {}, null, { 'x-cron-secret': CRON_SECRET });
const feed = async (url) => {
  const path = new URL(url).pathname;
  const res = await fetch(`${srv.base}${path}`);
  return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text() };
};
const shift = (who, date, start, end, extra = {}) => api.create('StaffShift', {
  user_id: who.id, user_name: 'x', date, start, end, role_label: 'Front desk', note: '', status: 'published', ...extra,
}, admin.token);
const klass = (who, date, time, name) => api.create('ClassSession', {
  class_type_id: crossfit.id, class_type_name: name, date, start_time: time, duration_min: 60, slot_id: null, coach_user_id: who.id, coach_name: 'x',
}, admin.token);
const pt = (who, date, time, extra = {}) => api.create('Session', {
  trainer_id: who.id, client_id: 'client-sample-1', client_name: 'Pat Example', date, start_time: time, type: 'personal_training', status: 'scheduled', ...extra,
}, admin.token);

// Checks the RFC 5545 basics and returns the unfolded events.
function parseIcs(text) {
  assert.ok(text.endsWith('\r\n'), 'ends with CRLF');
  const raw = text.slice(0, -2).split('\r\n');
  for (const l of raw) {
    assert.ok(!l.includes('\n') && !l.includes('\r'), 'no bare line breaks');
    assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `line over 75 octets: ${l}`);
  }
  const lines = [];
  for (const l of raw) { if (l.startsWith(' ')) lines[lines.length - 1] += l.slice(1); else lines.push(l); }
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines.at(-1), 'END:VCALENDAR');
  assert.ok(lines.includes('VERSION:2.0'));
  assert.ok(lines.some((l) => l.startsWith('PRODID:')));
  const events = [];
  let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { assert.equal(cur, null, 'nested event'); cur = {}; continue; }
    if (l === 'END:VEVENT') { events.push(cur); cur = null; continue; }
    if (cur) { const i = l.indexOf(':'); cur[l.slice(0, i)] = l.slice(i + 1); }
  }
  assert.equal(cur, null, 'unclosed event');
  for (const e of events) {
    assert.ok(e.UID, 'UID');
    assert.match(e.DTSTAMP, /^\d{8}T\d{6}Z$/);
    assert.ok(e.SUMMARY);
    assert.ok(e.DTSTART || e['DTSTART;VALUE=DATE'], 'DTSTART');
    if (e.DTSTART) assert.match(e.DTSTART, /^\d{8}T\d{6}Z$/);
  }
  assert.equal(new Set(events.map((e) => e.UID)).size, events.length, 'UIDs unique');
  return events;
}

before(async () => {
  srv = await startServer();
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  admin = { token: first.data.token, id: first.data.user.id };
  cody = await staff('cody@example.test', 'Cody Coach');
  bea = await staff('bea@example.test', 'Bea Coach');
  crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, admin.token);
  await api.create('GymSettings', { waiver_required: false }, admin.token);
  const c = await api.create('Client', { full_name: 'Max Member', email: 'max@example.test', status: 'active' }, admin.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Max Member', password: 'member-pass-1' });
  member = { token: reg.data.token, id: reg.data.user.id };
});
after(() => srv?.stop());

test('reminder settings: defaults, save, bad values refused, members get nothing', async () => {
  const d = await api.fn('getReminderPrefs', {}, bea.token);
  assert.equal(d.success, true, JSON.stringify(d));
  assert.deepEqual(d.prefs, { shifts: 60, classes: 60, pt: 30 });
  const s = await api.fn('saveReminderPrefs', { shifts: null, pt: 120 }, bea.token);
  assert.deepEqual(s.prefs, { shifts: null, classes: 60, pt: 120 });
  assert.deepEqual((await api.fn('getReminderPrefs', {}, bea.token)).prefs, { shifts: null, classes: 60, pt: 120 });
  assert.equal((await api.fn('saveReminderPrefs', { classes: 7 }, bea.token)).code, 'bad_minutes');
  assert.equal((await api.fn('getReminderPrefs', {}, member.token)).code, 'forbidden');
  assert.equal((await api.fn('saveReminderPrefs', { pt: 60 }, member.token)).code, 'forbidden');
  assert.equal((await api.fn('calendarFeedLink', {}, member.token)).code, 'forbidden');
  assert.equal((await api.call('POST', 'functions/calendarFeedLink', {})).status, 401);
});

test('reminders fire once, follow each coach\'s settings, skip drafts', async () => {
  const at = (mins) => eastern(Date.now() + mins * 60000);
  const s = at(45); const e = at(105);
  const longName = `Barbell ${Date.now()}`;
  await shift(cody, s.date, s.time, e.time);
  await shift(cody, at(30).date, at(30).time, e.time, { status: 'draft', role_label: 'Draft desk' });
  await klass(cody, s.date, s.time, longName);
  await pt(cody, s.date, s.time);
  await shift(bea, s.date, s.time, e.time, { role_label: 'Open gym' }); // Bea turned shift reminders off

  const r1 = await tick();
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.scheduleReminders?.success, true, JSON.stringify(r1.data.scheduleReminders));
  await tick(); // a second run must not repeat anything
  const mine = async (who, title) => (await api.list('Notification', who.token)).filter((n) => n.title === title);
  const shifts = await mine(cody, 'Shift reminder');
  assert.equal(shifts.length, 1, JSON.stringify(shifts));
  assert.match(shifts[0].message, /Front desk shift today|Front desk shift tomorrow/);
  assert.equal(shifts[0].link, '/MySchedule');
  const classes = await mine(cody, 'Coaching reminder');
  assert.equal(classes.length, 1);
  assert.ok(classes[0].message.includes(longName));
  assert.equal((await mine(cody, 'PT reminder')).length, 0, 'PT default is 30 minutes: not yet');
  assert.ok(!(await api.list('Notification', cody.token)).some((n) => n.message.includes('Draft desk')), 'drafts never remind');
  assert.equal((await mine(bea, 'Shift reminder')).length, 0, 'turned off');

  await api.fn('saveReminderPrefs', { pt: 60 }, cody.token);
  await tick();
  await tick();
  const pts = await mine(cody, 'PT reminder');
  assert.equal(pts.length, 1);
  assert.match(pts[0].message, /PT with Pat /);
  assert.ok(!pts[0].message.includes('Example'));
  assert.equal((await mine(cody, 'Shift reminder')).length, 1, 'still once');
});

test('calendar feed: valid iCalendar with only that coach\'s items', async () => {
  const today = eastern().date;
  const day = addDays(today, 3);
  await shift(cody, day, '09:00', '13:00', { role_label: 'Front desk; mornings, Mon' });
  await shift(cody, day, '14:00', '15:00', { status: 'draft', role_label: 'Secret draft' });
  await shift(cody, day, '15:00', '16:00', { role_label: `Very long role label ${'é'.repeat(40)} end` });
  await shift(bea, day, '09:00', '13:00', { role_label: 'Bea only shift' });
  await klass(cody, day, '06:00', 'CrossFit, AM');
  await klass(bea, day, '07:00', 'Bea class');
  await pt(cody, day, '11:00');
  await pt(cody, day, '12:00', { client_name: 'Gone Away', status: 'cancelled' });
  await pt(bea, day, '11:00', { client_name: 'Bea Client' });
  await api.create('TimeOffRequest', { user_id: cody.id, user_name: 'Cody', start_date: addDays(today, 10), end_date: addDays(today, 11), part_day: null, reason: 'private reason', status: 'approved' }, admin.token);
  await api.create('TimeOffRequest', { user_id: cody.id, user_name: 'Cody', start_date: addDays(today, 20), end_date: addDays(today, 20), part_day: null, reason: 'pending reason', status: 'pending' }, admin.token);
  await api.create('StaffShift', { user_id: cody.id, date: addDays(today, 90), start: '09:00', end: '10:00', role_label: 'Too far', status: 'published' }, admin.token);

  const link = await api.fn('calendarFeedLink', {}, cody.token);
  assert.equal(link.success, true, JSON.stringify(link));
  assert.match(link.url, /\/api\/calendar\/[A-Za-z0-9_-]{64}\.ics$/);
  assert.ok(link.webcal_url.startsWith('webcal://'));
  assert.equal((await api.fn('calendarFeedLink', {}, cody.token)).url, link.url, 'same link until reset');

  const res = await feed(link.url);
  assert.equal(res.status, 200, res.body);
  assert.match(res.type, /^text\/calendar/);
  const events = parseIcs(res.body);
  const sums = events.map((e) => e.SUMMARY);
  assert.ok(sums.includes('Front desk\\; mornings\\, Mon shift'), JSON.stringify(sums));
  assert.ok(sums.includes(`Very long role label ${'é'.repeat(40)} end shift`), 'folded line unfolds intact');
  assert.ok(sums.includes('Coach: CrossFit\\, AM'));
  assert.ok(sums.includes('PT: Pat'));
  assert.ok(sums.includes('Time off'));
  const off = events.find((e) => e.SUMMARY === 'Time off');
  assert.equal(off['DTSTART;VALUE=DATE'], addDays(today, 10).replace(/-/g, ''));
  assert.equal(off['DTEND;VALUE=DATE'], addDays(today, 12).replace(/-/g, ''), 'DTEND is the day after');
  for (const bad of ['Example', 'Secret draft', 'Bea', 'Gone Away', 'private reason', 'pending reason', 'Too far', 'max@example.test']) {
    assert.ok(!res.body.includes(bad), `feed must not include ${bad}`);
  }
  // 9:00 Eastern is 13:00 or 14:00 UTC depending on daylight time.
  const desk = events.find((e) => e.SUMMARY.startsWith('Front desk\\;'));
  assert.match(desk.DTSTART, new RegExp(`^${day.replace(/-/g, '')}T1[34]0000Z$`));
  // UIDs are stable between fetches.
  const again = parseIcs((await feed(link.url)).body);
  assert.deepEqual(again.map((e) => e.UID).sort(), events.map((e) => e.UID).sort());

  const beaEvents = parseIcs((await feed((await api.fn('calendarFeedLink', {}, bea.token)).url)).body);
  assert.ok(beaEvents.some((e) => e.SUMMARY === 'Bea only shift shift'));
  assert.ok(beaEvents.some((e) => e.SUMMARY === 'PT: Bea'));
  assert.ok(!beaEvents.some((e) => /Front desk|CrossFit/.test(e.SUMMARY)));
});

test('calendar feed: bad or tampered tokens fail, reset revokes the old link', async () => {
  const link = (await api.fn('calendarFeedLink', {}, cody.token)).url;
  const token = /calendar\/([\w-]+)\.ics$/.exec(link)[1];
  const flip = (c) => (c === 'A' ? 'B' : 'A');
  assert.equal((await fetch(`${srv.base}/api/calendar/${token.slice(0, -1)}${flip(token.at(-1))}.ics`)).status, 404, 'tampered MAC');
  assert.equal((await fetch(`${srv.base}/api/calendar/${flip(token[0])}${token.slice(1)}.ics`)).status, 404, 'tampered id');
  assert.equal((await fetch(`${srv.base}/api/calendar/nope.ics`)).status, 404);
  assert.equal((await fetch(`${srv.base}/api/calendar/${token}.ics`, { method: 'POST' })).status, 405);

  const fresh = await api.fn('resetCalendarFeed', {}, cody.token);
  assert.equal(fresh.success, true);
  assert.notEqual(fresh.url, link);
  assert.equal((await feed(link)).status, 404, 'old link revoked');
  assert.equal((await feed(fresh.url)).status, 200);
  assert.equal((await api.fn('calendarFeedLink', {}, cody.token)).url, fresh.url);
  const log = (await api.call('GET', 'audit?limit=200', undefined, admin.token)).data;
  const row = log.find((l) => l.action === 'calendar_feed_reset');
  assert.ok(row, 'reset is audited');
  assert.ok(!JSON.stringify(log).includes(token) && !JSON.stringify(log).includes(/calendar\/([\w-]+)\.ics$/.exec(fresh.url)[1]), 'tokens never logged');
});

test('members cannot read the scheduling entities', async () => {
  assert.deepEqual(await api.list('StaffShift', member.token), []);
  assert.deepEqual(await api.list('TimeOffRequest', member.token), []);
  assert.equal((await api.call('POST', 'entities/StaffShift', { user_id: member.id, date: eastern().date, start: '09:00', end: '10:00', status: 'published' }, member.token)).status, 403);
});
