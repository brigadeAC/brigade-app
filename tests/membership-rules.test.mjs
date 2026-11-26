// Phase 4 RULES: agreement, holds pausing Stripe, plan changes, cancel and
// buyout, refunds, comps, renewals and permissions. Runs the real API on a
// throwaway database against a fake Stripe (no network, no keys).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN, CRON_SECRET } from './server.mjs';
import { startFakeStripe, postWebhook } from './fake-stripe.mjs';

let srv; let api; let fake; let admin; let coach; let manager; let member;
let planA; let planB; let dropIn; let maxClient;
const today = eastern().date;
const unix = (key) => Math.floor(Date.parse(`${key}T12:00:00Z`) / 1000);

async function staff(email, name) {
  const inv = await api.fn('createInvite', { email, full_name: name }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: name, password: 'staff-pass-1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  return { token: reg.data.token, id: reg.data.user.id };
}
const get = async (type, id) => (await api.call('GET', `entities/${type}/${id}`, undefined, admin.token)).data;
const WHSEC = 'whsec_fake';
const reqsTo = (method, path) => fake.requests.filter((r) => r.method === method && r.path === `/v1/${path}`);
const auditLog = async () => JSON.stringify((await api.call('GET', 'audit?limit=500', undefined, admin.token)).data);

// A Stripe-linked membership with a live subscription in the fake.
let subN = 0;
async function stripeMembership(extra = {}) {
  subN += 1;
  const subId = `sub_seed_${subN}`;
  fake.seed('subscriptions', {
    id: subId, status: 'active', customer: `cus_seed_${subN}`,
    current_period_start: unix(addDays(today, -10)), current_period_end: unix(addDays(today, 20)),
    items: { object: 'list', data: [{ id: `si_seed_${subN}`, price: { id: 'price_a' } }] },
  });
  return api.create('Membership', {
    client_id: maxClient.id, plan_id: planA.id, start_date: addDays(today, -40), status: 'active',
    billing_status: 'active', stripe_customer_id: `cus_seed_${subN}`, stripe_subscription_id: subId, payment_method: 'card',
    card_last4: '4242', card_brand: 'visa', commitment_ends: null, ...extra,
  }, admin.token);
}
const localMembership = (extra = {}) => api.create('Membership', {
  client_id: maxClient.id, plan_id: planA.id, start_date: addDays(today, -40), status: 'active', billing_status: 'none', commitment_ends: null, ...extra, // null: no commitment unless the test sets one
}, admin.token);

// A paid Payment the real way: a Stripe-linked membership and a signed
// invoice.paid webhook (Payments can't be written through the entity API).
async function paidPayment(amount) {
  const m = await stripeMembership();
  const inv = fake.invoiceFor(m.stripe_subscription_id, { amount_paid: amount });
  const r = await postWebhook(srv.base, WHSEC, fake.event('invoice.paid', inv));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = (await api.list('Payment', admin.token)).find((x) => x.stripe_invoice_id === inv.id);
  assert.ok(p, 'webhook wrote the Payment');
  return p;
}

before(async () => {
  fake = await startFakeStripe();
  srv = await startServer(undefined, { vars: { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: fake.url } });
  api = client(srv.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  admin = { token: first.data.token, id: first.data.user.id };
  coach = await staff('coach@example.test', 'Cody Coach');
  manager = await staff('manager@example.test', 'Mona Manager');
  assert.equal((await api.fn('setStaffRole', { user_id: manager.id, role: 'manager' }, admin.token)).success, true);
  await api.create('GymSettings', { waiver_required: false }, admin.token);
  planA = await api.create('MembershipPlan', { name: 'Unlimited 12 mo', kind: 'membership', interval: 'month', interval_count: 1, price_cents: 15000, commitment_months: 12, buyout_cents: 30000, stripe_price_id: 'price_a', is_active: true }, admin.token);
  planB = await api.create('MembershipPlan', { name: '3x a week', kind: 'membership', interval: 'month', interval_count: 1, price_cents: 12000, commitment_months: 0, stripe_price_id: 'price_b', is_active: true }, admin.token);
  dropIn = await api.create('MembershipPlan', { name: 'Drop-in', kind: 'drop_in', interval: 'once', price_cents: 2500, is_active: true }, admin.token);
  maxClient = await api.create('Client', { full_name: 'Max Member', email: 'max@example.test', status: 'active' }, admin.token);
  const inv = await api.fn('createInvite', { client_id: maxClient.id }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Max Member', password: 'member-pass-1' });
  member = { token: reg.data.token, id: reg.data.user.id };
});
after(async () => { srv?.stop(); await fake?.stop(); });

test('agreement: sample text, settings.manage bumps the version, members sign the current one', async () => {
  const a = await api.fn('agreementText', {}, member.token);
  assert.equal(a.version, 1);
  assert.equal(a.is_sample, true);
  assert.match(a.text, /SAMPLE/);
  const pub = await api.call('POST', 'functions/agreementText', {});
  assert.equal(pub.data.version, 1, 'readable signed-out for the join page');
  assert.equal((await api.fn('saveAgreementText', { text: 'x'.repeat(40) }, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('saveAgreementText', { text: 'x'.repeat(40) }, member.token)).code, 'forbidden');
  const saved = await api.fn('saveAgreementText', { text: 'Brigade membership terms, version two. Be kind, pay on time.' }, manager.token);
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal(saved.version, 2);
  const s = await api.fn('signAgreement', { plan_id: planA.id, signed_name: 'Max Member' }, member.token);
  assert.equal(s.success, true, JSON.stringify(s));
  assert.equal(s.text_version, 2);
  const ag = await get('Agreement', s.agreement_id);
  assert.equal(ag.client_id, maxClient.id);
  assert.equal(ag.signed_name, 'Max Member');
  assert.match(ag.text, /version two/);
  assert.equal((await api.fn('signAgreement', { plan_id: planA.id, signed_name: '' }, member.token)).success, false, 'needs a typed name');
  assert.equal((await api.fn('signAgreement', { plan_id: planA.id, client_id: 'someone-else', signed_name: 'Max' }, member.token)).success, false, 'only for themselves');
  const forged = await api.call('POST', 'entities/Agreement', { client_id: maxClient.id, plan_id: planA.id, text_version: 2 }, member.token);
  assert.notEqual(forged.status, 200, 'members cannot write Agreement rows directly');
});

test('checkout requirement: requireAgreement passes only a current, matching agreement', async () => {
  const s = await api.fn('signAgreement', { plan_id: planA.id, signed_name: 'Max Member' }, member.token);
  assert.equal((await api.fn('checkAgreement', { plan_id: planA.id, agreement_id: s.agreement_id }, member.token)).success, true);
  assert.equal((await api.fn('checkAgreement', { plan_id: planA.id }, member.token)).code, 'agreement_required');
  assert.equal((await api.fn('checkAgreement', { plan_id: planB.id, agreement_id: s.agreement_id }, member.token)).code, 'agreement_required', 'signed for another plan');
  const drop = await api.fn('checkAgreement', { plan_id: dropIn.id }, member.token);
  assert.equal(drop.success, true);
  assert.equal(drop.required, false, 'drop-ins need no agreement');
  await api.fn('saveAgreementText', { text: 'Brigade membership terms, version three. New rules.' }, admin.token);
  const stale = await api.fn('checkAgreement', { plan_id: planA.id, agreement_id: s.agreement_id }, member.token);
  assert.equal(stale.code, 'agreement_required', 'old version no longer counts');
  assert.match(stale.error, /changed/);
});

test('a hold pauses Stripe collection and ending it resumes', async () => {
  const m = await stripeMembership();
  fake.clear();
  const h = await api.fn('holdMembership', { membership_id: m.id, from: today, to: addDays(today, 5), reason: 'Travel' }, manager.token);
  assert.equal(h.success, true, JSON.stringify(h));
  const pause = reqsTo('POST', `subscriptions/${m.stripe_subscription_id}`);
  assert.equal(pause.length, 1);
  assert.equal(pause[0].body.pause_collection.behavior, 'void');
  assert.ok(Number(pause[0].body.pause_collection.resumes_at) > unix(addDays(today, 5)) - 86400);
  let fresh = await get('Membership', m.id);
  assert.equal(fresh.billing_status, 'paused');
  const holdId = fresh.holds[0].id;
  fake.clear();
  const end = await api.fn('cancelMembershipHold', { membership_id: m.id, hold_id: holdId }, manager.token);
  assert.equal(end.success, true, JSON.stringify(end));
  const resume = reqsTo('POST', `subscriptions/${m.stripe_subscription_id}`);
  assert.equal(resume.length, 1);
  assert.equal(resume[0].body.pause_collection, '');
  fresh = await get('Membership', m.id);
  assert.equal(fresh.billing_status, 'active');
  // A hold that starts later doesn't pause today.
  fake.clear();
  await api.fn('holdMembership', { membership_id: m.id, from: addDays(today, 10), to: addDays(today, 12), reason: 'Later trip' }, manager.token);
  assert.equal(fake.requests.length, 0);
});

test('changePlan now prorates; next_cycle schedules at the period end', async () => {
  const m = await stripeMembership();
  fake.clear();
  const now = await api.fn('changePlan', { membership_id: m.id, plan_id: planB.id, when: 'now' }, manager.token);
  assert.equal(now.success, true, JSON.stringify(now));
  const upd = reqsTo('POST', `subscriptions/${m.stripe_subscription_id}`);
  assert.equal(upd.length, 1);
  assert.equal(upd[0].body.items[0].id, `si_seed_${subN}`);
  assert.equal(upd[0].body.items[0].price, 'price_b');
  assert.equal(upd[0].body.proration_behavior, 'create_prorations');
  assert.equal(now.membership.plan_id, planB.id);

  const m2 = await stripeMembership();
  fake.clear();
  const later = await api.fn('changePlan', { membership_id: m2.id, plan_id: planB.id, when: 'next_cycle' }, manager.token);
  assert.equal(later.success, true, JSON.stringify(later));
  const created = reqsTo('POST', 'subscription_schedules');
  assert.equal(created.length, 1);
  assert.equal(created[0].body.from_subscription, m2.stripe_subscription_id);
  const sched = fake.requests.find((r) => r.method === 'POST' && r.path.startsWith('/v1/subscription_schedules/'));
  assert.equal(sched.body.phases[0].items[0].price, 'price_a');
  assert.equal(sched.body.phases[1].items[0].price, 'price_b');
  assert.equal(sched.body.phases[1].proration_behavior, 'none');
  assert.equal(reqsTo('POST', `subscriptions/${m2.stripe_subscription_id}`).length, 0, 'no immediate price change');
  assert.equal(later.membership.plan_id, planA.id);
  assert.equal(later.membership.pending_plan_id, planB.id);
  assert.equal(later.membership.pending_plan_from, addDays(today, 20));
  assert.equal((await api.fn('changePlan', { membership_id: m2.id, plan_id: planB.id, when: 'whenever' }, manager.token)).success, false);
});

test('cancel inside the commitment needs a confirmed buyout, then charges it and cancels', async () => {
  const m = await stripeMembership({ commitment_ends: addDays(today, 120) });
  fake.clear();
  const ask = await api.fn('cancelMembership', { membership_id: m.id, reason: 'Moving away' }, manager.token);
  assert.equal(ask.success, false);
  assert.equal(ask.code, 'buyout_required');
  assert.equal(ask.buyout_cents, 30000);
  assert.equal(fake.requests.length, 0, 'nothing charged before confirming');
  const done = await api.fn('cancelMembership', { membership_id: m.id, reason: 'Moving away', confirm_buyout: true }, manager.token);
  assert.equal(done.success, true, JSON.stringify(done));
  const item = reqsTo('POST', 'invoiceitems');
  assert.equal(item.length, 1);
  assert.equal(item[0].body.amount, '30000');
  assert.equal(item[0].body.customer, m.stripe_customer_id);
  assert.equal(reqsTo('POST', 'invoices').length, 1);
  assert.ok(fake.requests.some((r) => /^\/v1\/invoices\/.+\/pay$/.test(r.path)));
  assert.equal(reqsTo('DELETE', `subscriptions/${m.stripe_subscription_id}`).length, 1);
  const fresh = await get('Membership', m.id);
  assert.equal(fresh.billing_status, 'canceled');
  assert.equal(fresh.end_date, today);
  assert.equal(fresh.buyout_cents, 30000);
});

test('cancel after the commitment ends at the period end', async () => {
  const m = await stripeMembership({ commitment_ends: addDays(today, -5) });
  fake.clear();
  const done = await api.fn('cancelMembership', { membership_id: m.id, reason: 'Done for now' }, manager.token);
  assert.equal(done.success, true, JSON.stringify(done));
  const upd = reqsTo('POST', `subscriptions/${m.stripe_subscription_id}`);
  assert.equal(upd.length, 1);
  assert.equal(upd[0].body.cancel_at_period_end, 'true');
  assert.equal(reqsTo('POST', 'invoiceitems').length, 0, 'no buyout');
  assert.equal(done.ends, addDays(today, 19));
  const fresh = await get('Membership', m.id);
  assert.equal(fresh.cancel_at_period_end, true);
  assert.equal(fresh.end_date, addDays(today, 19));
});

test('refunds: partial then the rest, through Stripe; Payment updated', async () => {
  const p = await paidPayment(15000);
  fake.clear();
  const part = await api.fn('refundPayment', { payment_id: p.id, amount_cents: 5000, reason: 'Missed week' }, manager.token);
  assert.equal(part.success, true, JSON.stringify(part));
  assert.equal(part.payment.refunded_cents, 5000);
  assert.equal(part.payment.status, 'partially_refunded');
  const r = reqsTo('POST', 'refunds');
  assert.equal(r.length, 1);
  assert.equal(r[0].body.payment_intent, p.stripe_payment_intent_id);
  assert.equal(r[0].body.amount, '5000');
  assert.equal((await api.fn('refundPayment', { payment_id: p.id, amount_cents: 20000 }, manager.token)).success, false, 'not more than is left');
  assert.equal((await api.fn('refundPayment', { payment_id: p.id, amount_cents: -5 }, manager.token)).success, false);
  const rest = await api.fn('refundPayment', { payment_id: p.id, reason: 'Cancelled' }, manager.token);
  assert.equal(rest.success, true, JSON.stringify(rest));
  assert.equal(rest.payment.refunded_cents, 15000);
  assert.equal(rest.payment.status, 'refunded');
  assert.equal(reqsTo('POST', 'refunds')[1].body.amount, '10000');
  assert.equal((await api.fn('refundPayment', { payment_id: p.id }, manager.token)).success, false, 'nothing left');
});

test('comp: no charges until the date, then back to normal', async () => {
  const m = await stripeMembership();
  fake.clear();
  const c = await api.fn('compMembership', { membership_id: m.id, until: addDays(today, 30), reason: 'Coach family' }, manager.token);
  assert.equal(c.success, true, JSON.stringify(c));
  assert.equal(c.membership.billing_status, 'comped');
  assert.equal(c.membership.comped_until, addDays(today, 30));
  const upd = reqsTo('POST', `subscriptions/${m.stripe_subscription_id}`);
  assert.equal(upd[0].body.pause_collection.behavior, 'void');
  assert.ok(upd[0].body.pause_collection.resumes_at);
  assert.equal((await api.fn('compMembership', { membership_id: m.id, until: addDays(today, -1) }, manager.token)).success, false, 'no past dates');
  const end = await api.fn('compMembership', { membership_id: m.id, end: true }, manager.token);
  assert.equal(end.success, true, JSON.stringify(end));
  assert.equal(end.membership.billing_status, 'active');
});

test('permissions: coaches and members cannot change billing; managers can', async () => {
  const m = await localMembership();
  const p = await paidPayment(1000);
  const calls = [
    ['changePlan', { membership_id: m.id, plan_id: planB.id, when: 'now' }],
    ['cancelMembership', { membership_id: m.id, reason: 'x' }],
    ['refundPayment', { payment_id: p.id, amount_cents: 100 }],
    ['compMembership', { membership_id: m.id, until: null }],
    ['memberBilling', { client_id: maxClient.id }],
    ['upcomingRenewals', {}],
    ['runBillingRules', {}],
  ];
  for (const [fn, body] of calls) {
    assert.equal((await api.fn(fn, body, coach.token)).code, 'forbidden', `coach ${fn}`);
    assert.equal((await api.fn(fn, body, member.token)).code, 'forbidden', `member ${fn}`);
  }
  const mb = await api.fn('memberBilling', { client_id: maxClient.id }, manager.token);
  assert.equal(mb.success, true, JSON.stringify(mb));
  assert.equal(mb.connected, true);
  assert.equal(mb.can_change, true);
  assert.ok(mb.memberships.some((x) => x.id === m.id && x.plan?.id === planA.id));
  assert.ok(mb.payments.some((x) => x.id === p.id));
  assert.ok(mb.agreements.length >= 1);
  assert.equal(mb.agreements[0].text, undefined, 'list leaves out the full text');
  // Coaches don't see the new money fields on a membership.
  const seen = (await api.call('GET', `entities/Membership/${m.id}`, undefined, coach.token)).data;
  assert.equal(seen.billing_status, undefined);
});

test('memberships with no Stripe link change locally, with no Stripe calls', async () => {
  fake.clear();
  const a = await localMembership({ commitment_ends: addDays(today, 60), next_payment_date: addDays(today, 9) });
  const now = await api.fn('changePlan', { membership_id: a.id, plan_id: planB.id, when: 'now' }, manager.token);
  assert.equal(now.success, true, JSON.stringify(now));
  assert.equal(now.membership.plan_id, planB.id);
  const later = await api.fn('changePlan', { membership_id: a.id, plan_id: planA.id, when: 'next_cycle' }, manager.token);
  assert.equal(later.success, true, JSON.stringify(later));
  assert.equal(later.membership.pending_plan_from, addDays(today, 9));
  // Back on plan A (12-month plan, buyout 30000) inside the commitment.
  const b = await localMembership({ commitment_ends: addDays(today, 60) });
  const ask = await api.fn('cancelMembership', { membership_id: b.id, reason: 'Injury' }, manager.token);
  assert.equal(ask.code, 'buyout_required');
  const done = await api.fn('cancelMembership', { membership_id: b.id, reason: 'Injury', confirm_buyout: true }, manager.token);
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.membership.end_date, today);
  const c = await localMembership({ next_payment_date: addDays(today, 4) });
  const after = await api.fn('cancelMembership', { membership_id: c.id, reason: 'Moving' }, manager.token);
  assert.equal(after.success, true, JSON.stringify(after));
  assert.equal(after.membership.end_date, addDays(today, 3));
  const comp = await api.fn('compMembership', { membership_id: a.id, until: null }, manager.token);
  assert.equal(comp.success, true, JSON.stringify(comp));
  assert.equal(comp.membership.billing_status, 'comped');
  // (No local cash refund here: Payments come only from Stripe webhooks now.)
  assert.equal(fake.requests.length, 0);
});

test('renewals: commitments end, scheduled changes apply, 7-day list is stored', async () => {
  const ended = await localMembership({ commitment_ends: addDays(today, -1) });
  const due = await localMembership({ next_payment_date: addDays(today, 3) });
  const sched = await localMembership({ pending_plan_id: planB.id, pending_plan_from: today });
  const ups = await api.fn('upcomingRenewals', { days: 7 }, manager.token);
  assert.equal(ups.success, true, JSON.stringify(ups));
  assert.ok(ups.renewals.some((r) => r.membership_id === due.id && r.reason === 'payment' && r.date === addDays(today, 3)));
  const cron = await api.call('POST', 'cron/program-tick', {}, undefined, { 'x-cron-secret': CRON_SECRET });
  assert.equal(cron.status, 200, JSON.stringify(cron.data));
  assert.equal(cron.data.billingRules.success, true, JSON.stringify(cron.data.billingRules));
  assert.ok(cron.data.billingRules.commitments_ended >= 1);
  assert.equal((await get('Membership', ended.id)).commitment_ended, true);
  assert.equal((await get('Membership', sched.id)).plan_id, planB.id);
  const again = await api.call('POST', 'cron/program-tick', {}, undefined, { 'x-cron-secret': CRON_SECRET });
  assert.equal(again.data.billingRules.skipped, true, 'once a day');
  assert.equal((await api.fn('runBillingRules', {}, manager.token)).success, true);
});

test('every money action is in the audit log', async () => {
  const log = await auditLog();
  for (const a of ['agreement_text_updated', 'agreement_signed', 'billing_paused', 'billing_resumed', 'plan_changed',
    'membership_buyout', 'membership_canceled', 'payment_refunded', 'membership_comped', 'comp_ended', 'commitment_ended']) {
    assert.ok(log.includes(a), `audit has ${a}`);
  }
});
