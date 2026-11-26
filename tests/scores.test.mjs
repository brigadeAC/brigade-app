// Workout scores, leaderboard and weekly streak (Phase 3: MEMBER).
// Runs the real API on a throwaway local database (see server.mjs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';

let srv; let api; let admin; let coach;
const m = {};
const kids = {};
const today = eastern().date;

async function addMember(name, last) {
  const email = `${name}@example.test`;
  const c = await api.create('Client', { full_name: `${name} ${last}`, email, status: 'active' }, coach.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, coach.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: `${name} ${last}`, password: 'member-pass-1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  m[name] = { token: reg.data.token, client: c };
  return m[name];
}

const SECTIONS = [
  { id: 's1', kind: 'warmup', title: 'Warm-up', description: '3 rounds easy', scoring: { type: 'none', lower_is_better: false }, movement_ids: [], benchmark_id: null },
  { id: 's2', kind: 'strength', title: 'Back Squat', description: '5-5-5', scoring: { type: 'load', unit: 'lb', lower_is_better: false }, movement_ids: [], benchmark_id: null },
  { id: 's3', kind: 'metcon', title: 'Fran', description: '21-15-9', scoring: { type: 'time', time_cap_sec: 600, lower_is_better: true }, movement_ids: [], benchmark_id: null },
  { id: 's4', kind: 'metcon', title: 'AMRAP 12', description: '5 pull-ups, 10 push-ups, 15 squats', scoring: { type: 'rounds_reps', reps_per_round: 30, lower_is_better: false }, movement_ids: [], benchmark_id: null },
];
const makeWorkout = (extra = {}) => api.create('Workout', {
  date: today, class_type_id: null, title: 'Test day', sections: SECTIONS, coach_notes: 'secret', status: 'published', publish_at: null, ...extra,
}, admin.token);
const log = (who, w, section_id, value, extra = {}) => api.fn('logScore', { workout_id: w.id, section_id, division: 'rx', value, comment: '', ...extra }, who.token);

let wod;
before(async () => {
  srv = await startServer();
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  admin = { token: first.data.token };
  const inv = await api.fn('createInvite', { email: 'coach@example.test', full_name: 'Cody Coach' }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Cody Coach', password: 'coach-pass-1' });
  coach = { token: reg.data.token, id: reg.data.user.id }; // default role: coach (has classes.run)
  await addMember('ava', 'Stone');
  await addMember('ben', 'Hart');
  await addMember('cal', 'Ng');
  await addMember('pam', 'Parent');
  kids.kit = await api.create('Client', { full_name: 'Kit Parent', status: 'active' }, coach.token);
  assert.equal((await api.fn('linkGuardian', { client_id: kids.kit.id, guardian_client_id: m.pam.client.id }, admin.token)).success, true);
  wod = await makeWorkout();
  assert.ok(wod.id, JSON.stringify(wod));
});
after(() => srv?.stop());

test('a member logs a score, and logging again updates it', async () => {
  const r = await log(m.ava, wod, 's3', { seconds: 245 }, { comment: 'Unbroken thrusters' });
  assert.equal(r.success, true, r.error);
  assert.equal(r.score.client_id, m.ava.client.id);
  assert.equal(r.score.sort_value, 245);
  assert.equal(r.score.display, '4:05');
  assert.equal(r.score.date, today);
  const again = await log(m.ava, wod, 's3', { seconds: 230 }, { division: 'rx_plus' });
  assert.equal(again.success, true, again.error);
  assert.equal(again.updated, true);
  assert.equal(again.score.id, r.score.id, 'same record');
  assert.equal(again.score.sort_value, 230);
  const mine = await api.fn('myScores', {}, m.ava.token);
  assert.equal(mine.scores.filter((s) => s.section_id === 's3').length, 1, 'one score per section');
  assert.equal(mine.scores[0].workout_title, 'Test day');
  // Put it back to Rx for the leaderboard test.
  assert.equal((await log(m.ava, wod, 's3', { seconds: 245 })).success, true);
});

test('a member cannot log or delete a score for another member', async () => {
  const r = await log(m.ben, wod, 's3', { seconds: 300 }, { client_id: m.ava.client.id });
  assert.equal(r.success, false);
  assert.equal(r.code, 'forbidden');
  const avaScore = (await api.fn('myScores', {}, m.ava.token)).scores.find((s) => s.section_id === 's3');
  assert.equal((await api.fn('deleteScore', { score_id: avaScore.id }, m.ben.token)).success, false);
  // Scores are written only through logScore, never the raw entity API.
  const raw = await api.call('POST', 'entities/WorkoutScore', { workout_id: wod.id, section_id: 's3', client_id: m.ben.client.id, sort_value: 1 }, m.ben.token);
  assert.equal(raw.status, 403);
  // A parent cannot log for someone else's child or another adult.
  assert.equal((await log(m.pam, wod, 's3', { seconds: 300 }, { client_id: m.cal.client.id })).success, false);
});

test('a parent logs and deletes a score for their linked child', async () => {
  const r = await log(m.pam, wod, 's4', { rounds: 5, reps: 12 }, { client_id: kids.kit.id, division: 'scaled' });
  assert.equal(r.success, true, r.error);
  assert.equal(r.score.client_id, kids.kit.id);
  const kidScores = await api.fn('myScores', { client_id: kids.kit.id }, m.pam.token);
  assert.equal(kidScores.scores.length, 1);
  assert.equal((await api.fn('myScores', {}, m.pam.token)).scores.length, 0, 'not on the parent\'s own list');
  assert.equal((await api.fn('myScores', { client_id: kids.kit.id }, m.ben.token)).success, false, 'others cannot read it');
  assert.equal((await api.fn('deleteScore', { score_id: r.score.id }, m.pam.token)).success, true);
  assert.equal((await api.fn('myScores', { client_id: kids.kit.id }, m.pam.token)).scores.length, 0);
});

test('staff with classes.run can log or fix any member\'s score', async () => {
  const r = await log(m.ben, wod, 's2', { load: 225, unit: 'lb' });
  assert.equal(r.success, true, r.error);
  assert.equal((await log(coach, wod, 's2', { load: 255, unit: 'lb' })).success, false, 'staff must name the member');
  const fix = await log(coach, wod, 's2', { load: 235, unit: 'lb' }, { client_id: m.ben.client.id });
  assert.equal(fix.success, true, fix.error);
  assert.equal(fix.score.id, r.score.id, 'fixed in place');
  assert.equal(fix.score.sort_value, 235);
  const audit = (await api.call('GET', 'audit?limit=200', undefined, admin.token)).data;
  assert.ok(audit.some((e) => e.action === 'score_updated' && e.target_id === r.score.id));
});

test('sort_value: time, capped time, rounds + reps and load', async () => {
  const capped = await log(m.ben, wod, 's3', { capped: true, reps: 40 });
  assert.equal(capped.success, true, capped.error);
  assert.ok(capped.score.sort_value > 600, 'capped ranks below every finisher');
  assert.equal(capped.score.display, 'Capped, 40 reps');
  const capped2 = await log(m.cal, wod, 's3', { capped: true, reps: 60 });
  assert.ok(capped2.score.sort_value < capped.score.sort_value, 'more reps before the cap is better');
  assert.equal((await log(m.cal, wod, 's3', { seconds: 700 })).code, 'bad_value', 'over the cap without ticking it');
  assert.equal((await log(m.cal, wod, 's3', { seconds: 0 })).success, false);

  const rr = await log(m.cal, wod, 's4', { rounds: 7, reps: 12 });
  assert.equal(rr.score.sort_value, 7012);
  assert.equal(rr.score.display, '7 rounds + 12');
  assert.equal((await log(m.cal, wod, 's4', { rounds: 7, reps: 31 })).success, false, 'more extra reps than a round');

  const kg = await log(m.cal, wod, 's2', { load: 100, unit: 'kg' });
  assert.equal(kg.success, true, kg.error);
  assert.equal(kg.score.value.load, 100);
  assert.equal(kg.score.value.unit, 'kg');
  assert.ok(Math.abs(kg.score.sort_value - 220.46) < 0.01, 'compared in the section\'s unit');
  assert.equal((await log(m.cal, wod, 's2', { load: -5 })).success, false);
  assert.equal((await log(m.cal, wod, 's1', { done: true })).success, false, 'warm-up is not scored');
  assert.equal((await log(m.cal, wod, 's3', { seconds: 200 }, { division: 'beast' })).success, false, 'unknown division');
});

test('leaderboard ranks by score, Rx+ then Rx then Scaled, and filters by division', async () => {
  // s3 now: ava 4:05 Rx, ben capped 40 Rx, cal capped 60 Rx. Add a scaled and an Rx+ score.
  await addMember('dee', 'Vance');
  await addMember('eli', 'Moss');
  assert.equal((await log(m.dee, wod, 's3', { seconds: 150 }, { division: 'scaled', comment: 'Light bar' })).success, true);
  assert.equal((await log(m.eli, wod, 's3', { seconds: 400 }, { division: 'rx_plus' })).success, true);
  const board = await api.fn('leaderboard', { workout_id: wod.id, section_id: 's3' }, m.ben.token);
  assert.equal(board.success, true, board.error);
  assert.deepEqual(board.rows.map((r) => r.name), ['eli M.', 'ava S.', 'cal N.', 'ben H.', 'dee V.']);
  assert.deepEqual(board.rows.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(board.rows.find((r) => r.name === 'dee V.').comment, 'Light bar');
  assert.equal(board.rows.find((r) => r.name === 'ben H.').mine, true);
  assert.equal(board.rows.find((r) => r.name === 'ava S.').mine, false);
  assert.ok(!('client_id' in board.rows[0]), 'no member ids on the board');
  const rx = await api.fn('leaderboard', { workout_id: wod.id, section_id: 's3', division: 'rx' }, m.ben.token);
  assert.deepEqual(rx.rows.map((r) => r.name), ['ava S.', 'cal N.', 'ben H.']);
  // Higher is better for rounds + reps; default section is the first metcon.
  assert.equal((await log(m.ava, wod, 's4', { rounds: 8, reps: 0 })).success, true);
  const amrap = await api.fn('leaderboard', { workout_id: wod.id, section_id: 's4' }, m.dee.token);
  assert.deepEqual(amrap.rows.map((r) => r.name), ['ava S.', 'cal N.']);
  const dflt = await api.fn('leaderboard', { workout_id: wod.id }, m.dee.token);
  assert.equal(dflt.section.id, 's3');
  assert.deepEqual(dflt.sections.map((s) => s.id), ['s2', 's3', 's4']);
  assert.equal((await api.fn('leaderboard', { workout_id: wod.id }, coach.token)).success, true, 'staff see it too');
});

test('drafts, scheduled and future workouts cannot be scored or seen', async () => {
  const draft = await makeWorkout({ status: 'draft', title: 'Draft' });
  assert.equal((await log(m.ava, draft, 's3', { seconds: 200 })).code, 'not_published');
  assert.equal((await log(coach, draft, 's3', { seconds: 200 }, { client_id: m.ava.client.id })).code, 'not_published');
  assert.equal((await api.fn('leaderboard', { workout_id: draft.id }, m.ava.token)).success, false);
  const later = await makeWorkout({ title: 'Later', publish_at: new Date(Date.now() + 3600000).toISOString() });
  assert.equal((await log(m.ava, later, 's3', { seconds: 200 })).code, 'not_published');
  const tomorrow = await makeWorkout({ title: 'Tomorrow', date: addDays(today, 1) });
  assert.equal((await log(m.ava, tomorrow, 's3', { seconds: 200 })).code, 'too_early');
  const day = await api.fn('todayWorkout', { date: today }, m.ava.token);
  assert.ok(day.workouts.some((w) => w.id === wod.id));
  assert.ok(!day.workouts.some((w) => w.id === draft.id || w.id === later.id), 'members see published only');
  assert.ok(day.workouts.every((w) => !('coach_notes' in w)), 'coach notes stay with staff');
});

test('weekly streak counts consecutive weeks with a score or check-in', async () => {
  const fay = await addMember('fay', 'Lowe');
  assert.deepEqual(
    (({ weeks, this_week_count }) => ({ weeks, this_week_count }))(await api.fn('weeklyStreak', {}, fay.token)),
    { weeks: 0, this_week_count: 0 },
  );
  // Last week and the week before, by score.
  for (const n of [7, 14]) {
    const w = await makeWorkout({ date: addDays(today, -n), title: `Past ${n}` });
    assert.equal((await log(fay, w, 's3', { seconds: 300 })).success, true);
  }
  let s = await api.fn('weeklyStreak', {}, fay.token);
  assert.equal(s.weeks, 2, 'this week has nothing yet, the streak still stands');
  assert.equal(s.this_week_count, 0);
  // Three weeks back by class check-in.
  await api.fn('setStaffRole', { user_id: coach.id, role: 'manager' }, admin.token);
  const d = addDays(today, -21);
  const sess = await api.create('ClassSession', { class_type_id: null, class_type_name: 'CrossFit', date: d, start_time: '09:00', duration_min: 60, slot_id: null }, coach.token);
  const res = await api.create('Reservation', { session_id: sess.id, date: d, client_id: fay.client.id, status: 'checked_in' }, coach.token);
  assert.ok(res.id, JSON.stringify(res));
  s = await api.fn('weeklyStreak', {}, fay.token);
  assert.equal(s.weeks, 3);
  // A score today counts this week too.
  assert.equal((await log(fay, wod, 's3', { seconds: 320 })).success, true);
  s = await api.fn('weeklyStreak', {}, fay.token);
  assert.equal(s.weeks, 4);
  assert.equal(s.this_week_count, 1);
  // A gap breaks it: nothing five weeks back counts.
  const w5 = await makeWorkout({ date: addDays(today, -35), title: 'Old' });
  assert.equal((await log(fay, w5, 's3', { seconds: 300 })).success, true);
  assert.equal((await api.fn('weeklyStreak', {}, fay.token)).weeks, 4);
  // Others cannot read it.
  assert.equal((await api.fn('weeklyStreak', { client_id: fay.client.id }, m.ava.token)).success, false);
});
