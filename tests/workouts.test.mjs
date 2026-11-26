// Daily class workouts: libraries, publish rules, coach notes, copy forward.
// Runs the real API on a throwaway local database (see server.mjs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';

let srv; let api; let admin; let coach; let member; let crossfit;

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
  coach = await staff('coach@example.test', 'Cody Coach');
  crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, admin.token);
  const c = await api.create('Client', { full_name: 'Max Member', email: 'max@example.test', status: 'active' }, admin.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Max Member', password: 'member-pass-1' });
  member = { token: reg.data.token, id: reg.data.user.id, client: c };
});
after(() => srv?.stop());

const sections = [
  { kind: 'strength', title: 'Back squat', description: '5x5', scoring: { type: 'load', unit: 'lb' }, movement_ids: ['mv_back_squat'] },
  { kind: 'metcon', title: 'Fran', description: '21-15-9', scoring: { type: 'time', time_cap_sec: 600 }, movement_ids: ['mv_thruster', 'mv_pull_up'], benchmark_id: 'bm_fran' },
];

test('the sample movement and benchmark libraries appear, readable by members', async () => {
  const lib = await api.fn('workoutLibrary', {}, member.token);
  assert.equal(lib.success, true, JSON.stringify(lib));
  assert.ok(lib.movements.length >= 40, `movements: ${lib.movements.length}`);
  assert.ok(lib.benchmarks.length >= 15, `benchmarks: ${lib.benchmarks.length}`);
  const squat = lib.movements.find((m) => m.name === 'Back Squat');
  assert.equal(squat.is_lift, true);
  assert.equal(lib.movements.find((m) => m.name === 'Burpee').is_lift, false);
  const fran = lib.benchmarks.find((b) => b.name === 'Fran');
  assert.equal(fran.scoring.type, 'time');
  assert.equal(fran.scoring.lower_is_better, true);
  assert.equal(lib.benchmarks.find((b) => b.name === 'Cindy').scoring.type, 'rounds_reps');
  assert.equal(lib.benchmarks.find((b) => b.name === 'Deadlift 1RM').scoring.type, 'load');
  // Plain entity reads work for everyone; only programs.manage writes.
  const list = await api.list('Movement', member.token);
  assert.ok(Array.isArray(list) && list.length >= 40);
  assert.equal((await api.call('POST', 'entities/Movement', { name: 'Sneaky', category: 'other' }, member.token)).status, 403);
  const made = await api.call('POST', 'entities/Movement', { name: 'Devil Press', category: 'weightlifting', is_lift: false, aliases: [] }, coach.token);
  assert.equal(made.status, 200, JSON.stringify(made.data));
});

test('a coach saves and publishes; a member cannot save', async () => {
  const day = addDays(eastern().date, 20);
  const r = await api.fn('saveWorkout', { date: day, class_type_id: null, title: 'Leg day', sections, coach_notes: 'Watch knees', status: 'draft' }, coach.token);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.workout.sections.length, 2);
  assert.equal(r.workout.sections[1].scoring.lower_is_better, true);
  assert.ok(r.workout.sections[0].id && r.workout.sections[0].id !== r.workout.sections[1].id);
  const pub = await api.fn('saveWorkout', { id: r.workout.id, status: 'published', publish_at: null }, coach.token);
  assert.equal(pub.success, true, JSON.stringify(pub));
  assert.equal(pub.workout.status, 'published');
  assert.equal(pub.workout.title, 'Leg day');
  const dup = await api.fn('saveWorkout', { date: day, class_type_id: null, title: 'Again', sections: [] }, coach.token);
  assert.equal(dup.code, 'duplicate');
  // Members get nowhere, by function or by the entity routes.
  assert.equal((await api.fn('saveWorkout', { date: addDays(day, 1), title: 'Mine', sections: [] }, member.token)).code, 'forbidden');
  assert.equal((await api.fn('deleteWorkout', { id: r.workout.id }, member.token)).code, 'forbidden');
  assert.equal((await api.call('POST', 'entities/Workout', { date: addDays(day, 2), status: 'published' }, member.token)).status, 403);
  assert.equal((await api.update('Workout', r.workout.id, { title: 'Hacked' }, member.token)).status, 403);
});

test('members see a workout only once published and its time has passed, never coach notes', async () => {
  const today = eastern().date;
  const ct = crossfit.id;
  const d = await api.fn('saveWorkout', { date: today, class_type_id: ct, title: 'Draft day', sections, coach_notes: 'Secret', status: 'draft' }, coach.token);
  assert.equal(d.success, true, JSON.stringify(d));
  const visible = async () => (await api.fn('listWorkouts', { from: today, to: today }, member.token)).workouts.map((w) => w.id);
  assert.ok(!(await visible()).includes(d.workout.id), 'draft hidden');
  assert.deepEqual((await api.fn('todayWorkout', { date: today, class_type_id: ct }, member.token)).workouts, []);
  assert.equal((await api.call('GET', `entities/Workout/${d.workout.id}`, undefined, member.token)).status, 404);
  // Published for tomorrow evening: still hidden.
  const future = new Date(Date.now() + 86400000).toISOString();
  await api.fn('saveWorkout', { id: d.workout.id, status: 'published', publish_at: future }, coach.token);
  assert.ok(!(await visible()).includes(d.workout.id), 'future publish hidden');
  assert.ok(!(await api.list('Workout', member.token)).some((w) => w.id === d.workout.id));
  // Staff still see it, notes and all.
  const asCoach = (await api.fn('listWorkouts', { from: today, to: today }, coach.token)).workouts.find((w) => w.id === d.workout.id);
  assert.equal(asCoach.coach_notes, 'Secret');
  // Publish now: visible, notes stripped everywhere.
  await api.fn('saveWorkout', { id: d.workout.id, status: 'published', publish_at: null }, coach.token);
  const seen = (await api.fn('listWorkouts', { from: today, to: today }, member.token)).workouts.find((w) => w.id === d.workout.id);
  assert.ok(seen, 'visible after publish');
  assert.equal(seen.coach_notes, undefined);
  const t = await api.fn('todayWorkout', { date: today, class_type_id: ct }, member.token);
  assert.equal(t.workouts.length, 1);
  assert.equal(t.workouts[0].id, d.workout.id);
  assert.equal(t.workouts[0].coach_notes, undefined);
  assert.equal(t.movements.mv_back_squat.name, 'Back Squat');
  assert.equal(t.benchmarks.bm_fran.name, 'Fran');
  assert.equal((await api.call('GET', `entities/Workout/${d.workout.id}`, undefined, member.token)).data.coach_notes, undefined);
  assert.ok((await api.list('Workout', member.token)).every((w) => w.coach_notes === undefined));
  // A past publish time counts as published too.
  const past = await api.fn('saveWorkout', { date: today, class_type_id: null, title: 'Everyone', sections: [], status: 'published', publish_at: new Date(Date.now() - 60000).toISOString() }, coach.token);
  assert.equal(past.success, true, JSON.stringify(past));
  assert.ok((await visible()).includes(past.workout.id));
  // Class-specific beats the all-classes version; other classes fall back to it.
  assert.equal((await api.fn('todayWorkout', { date: today, class_type_id: ct }, member.token)).workouts[0].id, d.workout.id);
  assert.equal((await api.fn('todayWorkout', { date: today, class_type_id: 'other-type' }, member.token)).workouts[0].id, past.workout.id);
});

test('copy week forward makes drafts on the new dates', async () => {
  const start = addDays(eastern().date, 40);
  for (let i = 0; i < 3; i += 1) {
    const r = await api.fn('saveWorkout', { date: addDays(start, i), title: `Day ${i + 1}`, sections, coach_notes: 'n', status: 'published', publish_at: null }, coach.token);
    assert.equal(r.success, true, JSON.stringify(r));
  }
  const to = addDays(start, 7);
  assert.equal((await api.fn('copyWorkouts', { from_date: start, to_date: to, days: 7 }, member.token)).code, 'forbidden');
  const c = await api.fn('copyWorkouts', { from_date: start, to_date: to, days: 7 }, coach.token);
  assert.equal(c.success, true, JSON.stringify(c));
  assert.equal(c.created.length, 3);
  assert.deepEqual(c.created.map((w) => w.date).sort(), [to, addDays(to, 1), addDays(to, 2)]);
  assert.ok(c.created.every((w) => w.status === 'draft' && w.publish_at === null));
  assert.equal(c.created.find((w) => w.date === to).title, 'Day 1');
  // Running it again skips days that already have a workout.
  const again = await api.fn('copyWorkouts', { from_date: start, to_date: to, days: 7 }, coach.token);
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped.length, 3);
  // Members don't see the copies.
  assert.equal((await api.fn('listWorkouts', { from: to, to: addDays(to, 6) }, member.token)).workouts.length, 0);
});

test('publish on the gym default time uses the setting', async () => {
  await api.create('GymSettings', { waiver_required: false, workout_publish_days_before: 1, workout_publish_time: '20:00' }, admin.token);
  const day = addDays(eastern().date, 60);
  const r = await api.fn('saveWorkout', { date: day, title: 'Default time', sections: [], status: 'published', publish_at: 'default' }, coach.token);
  assert.equal(r.success, true, JSON.stringify(r));
  const p = eastern(Date.parse(r.workout.publish_at));
  assert.equal(p.date, addDays(day, -1));
  assert.equal(p.time, '20:00');
});
