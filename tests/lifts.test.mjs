// Lifts: PR detection, lift history, PR list, who may see or change a lift,
// and the percentage chart math.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';
import { percentTable, roundToPlate, estimate1RM, convertLoad } from '../src/lib/lifts.js';

let srv; let api; let admin; let coach;
const PW = 'member-pass-1';
const m = {};
let kid;
const mv = {};
const today = eastern().date;
const day = (n) => addDays(today, -n);

async function addMember(name) {
  const email = `${name}@example.test`;
  const c = await api.create('Client', { full_name: `${name} Lifter`, email, status: 'active' }, coach.token);
  const inv = await api.fn('createInvite', { client_id: c.id }, coach.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: `${name} Lifter`, password: PW });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  m[name] = { token: reg.data.token, client: c, email };
}
const save = (who, body) => api.fn('saveLiftEntry', body, who.token);
// A class workout with one section, and a score on it, written directly by staff.
async function classScore(clientRec, section, score, date) {
  const w = await api.create('Workout', { date, class_type_id: null, title: 'WOD', status: 'published', publish_at: null, coach_notes: '', sections: [{ id: 's1', description: '', movement_ids: [], benchmark_id: null, ...section }] }, coach.token);
  const s = await api.create('WorkoutScore', { workout_id: w.id, section_id: 's1', date, client_id: clientRec.id, division: 'rx', comment: '', is_pr: false, ...score }, coach.token);
  return { workout: w, score: s };
}

before(async () => {
  srv = await startServer();
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  admin = { token: first.data.token };
  const inv = await api.fn('createInvite', { email: 'coach@example.test', full_name: 'Cody Coach' }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Cody Coach', password: 'coach-pass-1' });
  coach = { token: reg.data.token };
  for (const [k, name] of [['squat', 'Back Squat'], ['dead', 'Deadlift'], ['clean', 'Clean'], ['press', 'Strict Press']]) {
    mv[k] = await api.create('Movement', { name, category: 'weightlifting', is_lift: true, aliases: [] }, coach.token);
  }
  mv.burpee = await api.create('Movement', { name: 'Burpee', category: 'gymnastics', is_lift: false, aliases: [] }, coach.token);
  await addMember('ann');
  await addMember('ben');
  await addMember('pam'); // a parent
  kid = await api.create('Client', { full_name: 'Kit Kid', status: 'active' }, coach.token);
  const l = await api.fn('linkGuardian', { client_id: kid.id, guardian_client_id: m.pam.client.id }, admin.token);
  assert.equal(l.success, true, l.error);
});
after(() => srv?.stop());

test('percentage chart rounds to 5 lb or 2.5 kg', () => {
  assert.equal(roundToPlate(112.5, 'lb'), 115);
  assert.equal(roundToPlate(111, 'lb'), 110);
  assert.equal(roundToPlate(87.125, 'kg'), 87.5);
  assert.equal(roundToPlate(86.2, 'kg'), 85);
  const lb = percentTable(315, 'lb');
  assert.equal(lb.length, 11);
  assert.deepEqual(lb[0], { pct: 50, load: 160 }); // 157.5 -> 160
  assert.deepEqual(lb.find((r) => r.pct === 85), { pct: 85, load: 270 }); // 267.75
  assert.deepEqual(lb[lb.length - 1], { pct: 100, load: 315 });
  const kg = percentTable(102.5, 'kg');
  assert.deepEqual(kg.find((r) => r.pct === 85), { pct: 85, load: 87.5 });
  assert.ok(kg.every((r) => (r.load * 10) % 25 === 0), 'every load is a 2.5 kg step');
  assert.deepEqual(percentTable(0, 'lb'), []);
  assert.equal(estimate1RM(200, 1), 200);
  assert.ok(Math.abs(estimate1RM(200, 5) - 233.333) < 0.01);
  assert.ok(Math.abs(convertLoad(100, 'kg', 'lb') - 220.462) < 0.01);
});

test('checkPr on logged lifts: first is a baseline, same rep count, kg vs lb, excludes self', async () => {
  const a = m.ann;
  const first = await save(a, { movement_id: mv.squat.id, load: 100, unit: 'kg', reps: 1, date: day(30) });
  assert.equal(first.success, true, first.error);
  assert.equal(first.pr, false, 'the first result has nothing to beat');
  assert.equal(first.previous, null);

  const heavier = await save(a, { movement_id: mv.squat.id, load: 225, unit: 'lb', reps: 1, date: day(20) });
  assert.equal(heavier.pr, true, '225 lb beats 100 kg (220.5 lb)');
  assert.equal(heavier.previous, 220.5);
  assert.equal(heavier.entry.is_pr, true);

  const lighter = await save(a, { movement_id: mv.squat.id, load: 101, unit: 'kg', reps: 1, date: day(15) });
  assert.equal(lighter.pr, false, '101 kg (222.7 lb) is under 225 lb');
  assert.equal(lighter.previous, 102.1, 'previous best shown in kg');

  const triple = await save(a, { movement_id: mv.squat.id, load: 240, unit: 'lb', reps: 3, date: day(14) });
  assert.equal(triple.pr, false, 'a first triple is not compared with singles');

  // Editing the 225 down to 224 still beats every OTHER single (220.5, 222.7).
  const edited = await save(a, { id: heavier.entry.id, load: 224 });
  assert.equal(edited.success, true, edited.error);
  assert.equal(edited.pr, true, 'the entry being saved is ignored');
  assert.equal(edited.previous, 222.7);
  assert.equal(edited.entry.load, 224);
  assert.equal(edited.entry.date, day(20), 'unchanged fields are kept');

  const bad = await save(a, { movement_id: mv.squat.id, load: 0, unit: 'lb', reps: 1 });
  assert.equal(bad.success, false);
  assert.equal((await save(a, { movement_id: 'nope', load: 100, reps: 1 })).success, false);
  assert.equal((await save(a, { movement_id: mv.squat.id, load: 100, reps: 1, date: addDays(today, 2) })).success, false, 'no future dates');
});

test('class strength scores count toward lift PRs', async () => {
  const a = m.ann;
  const { score } = await classScore(a.client, { kind: 'strength', title: 'Clean 1RM', scoring: { type: 'load', unit: 'kg', lower_is_better: false }, movement_ids: [mv.clean.id] }, { value: { load: 90, unit: 'kg' }, sort_value: 90 }, day(10));
  const lower = await save(a, { movement_id: mv.clean.id, load: 85, unit: 'kg', reps: 1, date: day(5) });
  assert.equal(lower.pr, false);
  assert.equal(lower.previous, 90);
  // What logScore asks: the class score itself, excluded while it is being saved.
  const asLog = await api.fn('checkPr', { workout_id: score.workout_id, section_id: 's1', load: 95, sort_value: 95, exclude_id: score.id }, a.token);
  assert.equal(asLog.success, true, asLog.error);
  assert.equal(asLog.is_pr, true, '95 kg beats the 85 kg logged lift');
  assert.equal(asLog.previous, 85);
  // A "5x3" section compares triples, not singles.
  const { score: s3 } = await classScore(a.client, { kind: 'strength', title: 'Clean', description: '5x3 building', scoring: { type: 'load', unit: 'kg', lower_is_better: false }, movement_ids: [mv.clean.id] }, { value: { load: 70, unit: 'kg' }, sort_value: 70 }, day(4));
  const trip = await api.fn('checkPr', { workout_id: s3.workout_id, section_id: 's1', load: 80, sort_value: 80 }, a.token);
  assert.equal(trip.is_pr, true);
  assert.equal(trip.previous, 70);
  const hist = await api.fn('liftHistory', { movement_id: mv.clean.id }, a.token);
  assert.equal(hist.success, true, hist.error);
  assert.deepEqual(hist.entries.map((e) => e.source), ['class', 'lift', 'class'], 'newest first');
  assert.equal(hist.entries[0].reps, 3);
  assert.equal(hist.one_rm.load, 90);
});

test('benchmark PRs: lower time is better, first result is the baseline', async () => {
  const fran = await api.create('Benchmark', { name: 'Fran', kind: 'girl', description: '21-15-9', scoring: { type: 'time', lower_is_better: true } }, coach.token);
  const sec = { kind: 'metcon', title: 'Fran', scoring: { type: 'time', lower_is_better: true }, benchmark_id: fran.id, movement_ids: [mv.burpee.id] };
  const { workout, score } = await classScore(m.ben.client, sec, { value: { seconds: 300 }, sort_value: 300 }, day(40));
  const ask = (sv, extra = {}) => api.fn('checkPr', { workout_id: workout.id, section_id: 's1', sort_value: sv, ...extra }, m.ben.token);
  assert.deepEqual(await ask(280), { success: true, is_pr: true, previous: 300 });
  assert.deepEqual(await ask(320), { success: true, is_pr: false, previous: 300 });
  assert.deepEqual(await ask(320, { exclude_id: score.id }), { success: true, is_pr: false, previous: null }, 'only result = baseline');
  // Without a workout, benchmark_id alone uses the benchmark's own scoring.
  assert.equal((await api.fn('checkPr', { benchmark_id: fran.id, sort_value: 250 }, m.ben.token)).is_pr, true);
  // A higher-is-better benchmark.
  const cindy = await api.create('Benchmark', { name: 'Cindy', kind: 'girl', description: 'AMRAP 20', scoring: { type: 'rounds_reps', lower_is_better: false } }, coach.token);
  await classScore(m.ben.client, { kind: 'metcon', title: 'Cindy', scoring: { type: 'rounds_reps', lower_is_better: false }, benchmark_id: cindy.id }, { value: { rounds: 18, reps: 5 }, sort_value: 18005 }, day(35));
  assert.equal((await api.fn('checkPr', { benchmark_id: cindy.id, sort_value: 19000 }, m.ben.token)).is_pr, true);
  assert.equal((await api.fn('checkPr', { benchmark_id: cindy.id, sort_value: 17000 }, m.ben.token)).is_pr, false);
  const prs = await api.fn('prList', {}, m.ben.token);
  assert.equal(prs.success, true, prs.error);
  assert.deepEqual(prs.benchmarks.map((b) => [b.name, b.best.sort_value]), [['Cindy', 18005], ['Fran', 300]]);
});

test('liftHistory: best per rep count and estimated 1RM', async () => {
  const b = m.ben;
  for (const [load, reps, n] of [[300, 1, 9], [280, 3, 8], [250, 5, 7], [310, 1, 6], [200, 10, 5], [305, 1, 4]]) {
    const r = await save(b, { movement_id: mv.dead.id, load, unit: 'lb', reps, date: day(n) });
    assert.equal(r.success, true, r.error);
  }
  const h = await api.fn('liftHistory', { movement_id: mv.dead.id }, b.token);
  assert.equal(h.success, true, h.error);
  assert.equal(h.movement.name, 'Deadlift');
  assert.equal(h.entries.length, 6);
  assert.equal(h.entries[0].load, 305, 'newest first');
  const best = Object.fromEntries(h.bests.map((x) => [x.reps, x.load]));
  assert.deepEqual(best, { 1: 310, 3: 280, 5: 250, 10: 200 });
  assert.deepEqual(h.one_rm, { load: 310, date: day(6) });
  // Epley: 200 x 10 = 266.7; 280 x 3 = 308; 250 x 5 = 291.7; best single 310.
  assert.equal(h.est_1rm.load, 310);
  const r = await save(b, { movement_id: mv.press.id, load: 100, unit: 'lb', reps: 5, date: day(3) });
  assert.equal(r.success, true);
  const p = await api.fn('liftHistory', { movement_id: mv.press.id }, b.token);
  assert.equal(p.one_rm, null, 'no true single yet');
  assert.equal(p.est_1rm.load, 116.7);
  const prs = await api.fn('prList', {}, b.token);
  const dl = prs.lifts.find((x) => x.movement_id === mv.dead.id);
  assert.equal(dl.one_rm.load, 310);
  assert.equal(dl.count, 6);
  assert.ok(prs.lifts.some((x) => x.name === 'Strict Press'));
});

test('members only see and change their own lifts; staff with classes.run can fix them', async () => {
  const annEntry = (await api.fn('liftHistory', { movement_id: mv.squat.id }, m.ann.token)).entries.find((e) => e.source === 'lift');
  assert.ok(annEntry);
  const asBen = { client_id: m.ann.client.id, movement_id: mv.squat.id };
  assert.equal((await api.fn('liftHistory', asBen, m.ben.token)).success, false, 'no peeking at another member');
  assert.equal((await api.fn('prList', { client_id: m.ann.client.id }, m.ben.token)).success, false);
  assert.equal((await save(m.ben, { ...asBen, load: 500, unit: 'lb', reps: 1 })).success, false, 'cannot log for someone else');
  assert.equal((await save(m.ben, { id: annEntry.id, load: 1 })).success, false, 'cannot edit someone else\'s lift');
  assert.equal((await api.fn('deleteLiftEntry', { id: annEntry.id }, m.ben.token)).success, false, 'cannot delete it');
  // Not through the plain entity API either.
  const raw = await api.list('LiftEntry', m.ben.token);
  assert.ok(Array.isArray(raw) && raw.every((e) => e.client_id === m.ben.client.id), 'list shows only own lifts');
  const direct = await api.call('POST', 'entities/LiftEntry', { client_id: m.ben.client.id, movement_id: mv.squat.id, load: 999, unit: 'lb', reps: 1, is_pr: true }, m.ben.token);
  assert.notEqual(direct.status, 200, 'members write lifts only through saveLiftEntry');
  const direct2 = await api.update('LiftEntry', annEntry.id, { load: 1 }, m.ben.token);
  assert.notEqual(direct2.status, 200);

  // Staff can view and fix a member's lift.
  assert.equal((await api.fn('liftHistory', asBen, coach.token)).success, true);
  assert.equal((await api.fn('liftHistory', { movement_id: mv.squat.id }, coach.token)).success, false, 'staff must pick a member');
  const fix = await save(coach, { id: annEntry.id, note: 'Fixed by coach' });
  assert.equal(fix.success, true, fix.error);
  assert.equal(fix.entry.note, 'Fixed by coach');
  const added = await save(coach, { client_id: m.ann.client.id, movement_id: mv.press.id, load: 40, unit: 'kg', reps: 1, date: day(1) });
  assert.equal(added.success, true, added.error);
  assert.equal(added.entry.client_id, m.ann.client.id);
  assert.equal((await api.fn('deleteLiftEntry', { id: added.entry.id }, m.ann.token)).success, true, 'a member deletes their own');
  assert.equal((await api.fn('liftHistory', { movement_id: mv.press.id }, m.ann.token)).entries.length, 0);
});

test('a parent logs and sees lifts for a linked child, nobody else does', async () => {
  const r = await save(m.pam, { client_id: kid.id, movement_id: mv.squat.id, load: 45, unit: 'lb', reps: 5, date: day(2) });
  assert.equal(r.success, true, r.error);
  assert.equal(r.entry.client_id, kid.id);
  const h = await api.fn('liftHistory', { client_id: kid.id, movement_id: mv.squat.id }, m.pam.token);
  assert.equal(h.success, true, h.error);
  assert.equal(h.entries.length, 1);
  assert.equal((await api.fn('liftHistory', { movement_id: mv.squat.id }, m.pam.token)).entries.length, 0, "the child's lifts are not the parent's");
  const edit = await save(m.pam, { id: r.entry.id, load: 55 });
  assert.equal(edit.success, true, edit.error);
  assert.equal((await api.fn('liftHistory', { client_id: kid.id, movement_id: mv.squat.id }, m.ann.token)).success, false);
  assert.equal((await save(m.ann, { id: r.entry.id, load: 1 })).success, false);
  assert.equal((await api.fn('deleteLiftEntry', { id: r.entry.id }, m.ann.token)).success, false);
  assert.equal((await api.fn('deleteLiftEntry', { id: r.entry.id }, m.pam.token)).success, true);
});

test('liftMovements lists only lifts from the library', async () => {
  const r = await api.fn('liftMovements', {}, m.ann.token);
  assert.equal(r.success, true);
  // The gym's sample library is added too, so check for ours and that nothing non-lift slips in.
  const names = r.movements.map((x) => x.name);
  for (const n of ['Back Squat', 'Clean', 'Deadlift', 'Strict Press']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('Burpee'));
  assert.ok(r.movements.every((x) => x.is_lift !== false));
});
