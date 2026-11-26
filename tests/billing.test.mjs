// Gym billing (Phase 4 CORE) against a fake Stripe. Never reaches real Stripe:
// the API's STRIPE_API_BASE points at tests/fake-stripe.mjs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';
import { startFakeStripe, postWebhook, signedEvent } from './fake-stripe.mjs';

const WHSEC = 'whsec_fake';
let fake; let srv; let off; let api; let offApi;
let admin; let coach; let max; let nia;
let monthly; let dropIn; let crossfit;

async function setupGym(a) {
  const first = await a.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  return { token: first.data.token, id: first.data.user.id };
}
async function member(a, adminTok, email, name) {
  const c = await a.create('Client', { full_name: name, email, status: 'active' }, adminTok);
  const inv = await a.fn('createInvite', { client_id: c.id }, adminTok);
  const reg = await a.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: name, password: 'member-pass-1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  return { token: reg.data.token, id: reg.data.user.id, client: c };
}
const membershipsOf = async (c) => (await api.list('Membership', admin.token)).filter((m) => m.client_id === c.id);
let seq = 0;
const makeClass = async () => {
  const { date, time } = eastern(Date.now() + (26 + (seq++)) * 3600000);
  return api.create('ClassSession', { class_type_id: crossfit.id, class_type_name: 'CrossFit', date, start_time: time, duration_min: 60, slot_id: null }, admin.token);
};
const hook = (event) => postWebhook(srv.base, WHSEC, event);
// A membership agreement, signed the real way (RULES' signAgreement).
const agreementFor = async (who, plan) => {
  const r = await api.fn('signAgreement', { plan_id: plan.id, signed_name: who.client.full_name }, who.token);
  assert.equal(r.success, true, JSON.stringify(r));
  return { id: r.agreement_id };
};

before(async () => {
  fake = await startFakeStripe();
  [srv, off] = await Promise.all([
    startServer(undefined, { vars: { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: fake.url } }),
    startServer(),
  ]);
  api = client(srv.base);
  offApi = client(off.base);
  admin = await setupGym(api);
  const inv = await api.fn('createInvite', { email: 'coach@example.test', full_name: 'Cody Coach' }, admin.token);
  const reg = await api.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: 'Cody Coach', password: 'staff-pass-1' });
  coach = { token: reg.data.token, id: reg.data.user.id };
  await api.create('GymSettings', { waiver_required: false }, admin.token);
  crossfit = await api.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, admin.token);
  monthly = await api.create('MembershipPlan', { name: 'Unlimited', kind: 'unlimited', is_active: true, price_cents: 18900, interval: 'month', interval_count: 1, commitment_months: 6, buyout_cents: 20000 }, admin.token);
  dropIn = await api.create('MembershipPlan', { name: 'Drop-In', kind: 'drop_in', limit_count: 1, limit_period: 'total', duration_days: 1, is_active: true, price_cents: 2500, interval: 'once' }, admin.token);
  max = await member(api, admin.token, 'max@example.test', 'Max Member');
  nia = await member(api, admin.token, 'nia@example.test', 'Nia Member');
});
after(async () => { srv?.stop(); off?.stop(); await fake?.stop(); });

test('not connected: status says so, money calls refuse, booking unchanged', async () => {
  const a = await setupGym(offApi);
  assert.deepEqual(await offApi.fn('billingStatus', {}, a.token), { success: true, connected: false, mode: null });
  const plan = await offApi.create('MembershipPlan', { name: 'Unlimited', kind: 'unlimited', is_active: true, price_cents: 18900, interval: 'month' }, a.token);
  assert.equal((await offApi.fn('syncPlanToStripe', { plan_id: plan.id }, a.token)).code, 'billing_not_connected');
  const m = await member(offApi, a.token, 'off@example.test', 'Off Member');
  assert.equal((await offApi.fn('startCheckout', { plan_id: plan.id, method: 'card' }, m.token)).code, 'billing_not_connected');
  assert.equal((await offApi.fn('billingPortal', {}, m.token)).code, 'billing_not_connected');
  const mine = await offApi.fn('myBilling', {}, m.token);
  assert.equal(mine.success, true);
  assert.equal(mine.connected, false);
  // A past-due flag on a Stripe-linked membership doesn't block booking when billing is off.
  await offApi.create('GymSettings', { waiver_required: false }, a.token);
  const ct = await offApi.create('ClassType', { name: 'CrossFit', reservable: true, default_capacity: 20, default_duration_min: 60, is_active: true }, a.token);
  await offApi.create('Membership', { client_id: m.client.id, plan_id: plan.id, start_date: addDays(eastern().date, -5), status: 'active', stripe_subscription_id: 'sub_x', billing_status: 'past_due' }, a.token);
  const { date, time } = eastern(Date.now() + 26 * 3600000);
  const s = await offApi.create('ClassSession', { class_type_id: ct.id, class_type_name: 'CrossFit', date, start_time: time, duration_min: 60, slot_id: null }, a.token);
  assert.equal((await offApi.fn('bookClass', { session_id: s.id }, m.token)).status, 'reserved');
});

test('connected (test mode); only settings + billing staff can sync plans', async () => {
  assert.deepEqual(await api.fn('billingStatus', {}, max.token), { success: true, connected: true, mode: 'test' });
  assert.equal((await api.fn('syncPlanToStripe', { plan_id: monthly.id }, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('syncPlanToStripe', { plan_id: monthly.id }, max.token)).code, 'forbidden');
});

test('syncPlanToStripe creates a product, a card price, a bank price and a tax rate', async () => {
  const r = await api.fn('syncPlanToStripe', { plan_id: monthly.id }, admin.token);
  assert.equal(r.success, true, JSON.stringify(r));
  const product = fake.get('products', r.plan.stripe_product_id);
  assert.equal(product.name, 'Unlimited');
  const card = fake.get('prices', r.plan.stripe_price_id);
  const bank = fake.get('prices', r.plan.stripe_price_bank_id);
  assert.equal(card.unit_amount, 18900);
  assert.equal(bank.unit_amount, Math.round(18900 * (1 - 0.0289)));
  assert.deepEqual([card.recurring.interval, bank.recurring.interval], ['month', 'month']);
  assert.equal(card.product, product.id);
  const tax = fake.get('tax_rates', r.plan.stripe_tax_rate_id);
  assert.equal(tax.percentage, 2.98);
  assert.equal(tax.inclusive, false);
  const saved = (await api.list('MembershipPlan', admin.token)).find((p) => p.id === monthly.id);
  assert.equal(saved.stripe_price_id, card.id);
  // Same price again: nothing new; changed price: new prices, old ones archived, one tax rate.
  const before = fake.all('prices').length;
  await api.fn('syncPlanToStripe', { plan_id: monthly.id }, admin.token);
  assert.equal(fake.all('prices').length, before);
  await api.update('MembershipPlan', monthly.id, { price_cents: 19900 }, admin.token);
  const r2 = await api.fn('syncPlanToStripe', { plan_id: monthly.id }, admin.token);
  assert.equal(fake.get('prices', r2.plan.stripe_price_id).unit_amount, 19900);
  assert.equal(fake.get('prices', card.id).active, false);
  assert.equal(fake.all('tax_rates').length, 1);
  assert.equal(fake.all('products').length, 1);
  const all = await api.fn('syncPlanToStripe', { all: true }, admin.token);
  assert.equal(all.success, true);
  assert.equal(all.synced.length, 2, 'both priced plans');
  assert.equal(fake.get('prices', (await api.list('MembershipPlan', admin.token)).find((p) => p.id === dropIn.id).stripe_price_id).recurring, undefined, 'drop-in is one-time');
});

test('startCheckout: card vs bank subscription, one-time drop-in, promo codes, agreement', async () => {
  const noAgreement = await api.fn('startCheckout', { plan_id: monthly.id, method: 'card' }, max.token);
  assert.equal(noAgreement.code, 'agreement_required');
  const ag = await agreementFor(max, monthly);
  const plan = (await api.list('MembershipPlan', admin.token)).find((p) => p.id === monthly.id);

  const card = await api.fn('startCheckout', { plan_id: monthly.id, method: 'card', agreement_id: ag.id }, max.token);
  assert.equal(card.success, true, JSON.stringify(card));
  assert.match(card.url, /^https:\/\/checkout\.stripe\.test\//);
  const cs = fake.get('checkout/sessions', card.session_id);
  assert.equal(cs.mode, 'subscription');
  assert.deepEqual(cs.payment_method_types, ['card']);
  assert.equal(cs.line_items[0].price, plan.stripe_price_id);
  assert.deepEqual(cs.line_items[0].tax_rates, [plan.stripe_tax_rate_id]);
  assert.equal(cs.allow_promotion_codes, true);
  assert.equal(cs.metadata.client_id, max.client.id);
  assert.equal(cs.metadata.plan_id, monthly.id);
  assert.equal(cs.metadata.agreement_id, ag.id);
  assert.equal(cs.subscription_data.metadata.client_id, max.client.id);
  assert.ok(fake.get('customers', cs.customer), 'customer created');

  const bank = await api.fn('startCheckout', { plan_id: monthly.id, method: 'bank', agreement_id: ag.id }, max.token);
  const bs = fake.get('checkout/sessions', bank.session_id);
  assert.deepEqual(bs.payment_method_types, ['us_bank_account']);
  assert.equal(bs.line_items[0].price, plan.stripe_price_bank_id);
  assert.equal(bs.customer, cs.customer, 'same customer reused');

  const once = await api.fn('startCheckout', { plan_id: dropIn.id, method: 'card' }, nia.token);
  assert.equal(once.success, true, 'drop-ins need no agreement');
  const os = fake.get('checkout/sessions', once.session_id);
  assert.equal(os.mode, 'payment');
  assert.equal(os.payment_intent_data.metadata.plan_id, dropIn.id);

  assert.equal((await api.fn('startCheckout', { plan_id: dropIn.id, method: 'card', promo_code: 'NOPE' }, nia.token)).code, 'bad_promo');
  const promo = fake.add('promotion_codes', { code: 'BRIGADE10', active: true, coupon: 'coupon_x' });
  const withPromo = await api.fn('startCheckout', { plan_id: dropIn.id, method: 'card', promo_code: 'BRIGADE10' }, nia.token);
  const ps = fake.get('checkout/sessions', withPromo.session_id);
  assert.deepEqual(ps.discounts, [{ promotion_code: promo.id }]);
  assert.equal(ps.allow_promotion_codes, undefined);

  // Coaches can't start checkouts for members; a member can't for someone else.
  assert.equal((await api.fn('startCheckout', { plan_id: dropIn.id, client_id: nia.client.id, method: 'card' }, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('startCheckout', { plan_id: dropIn.id, client_id: nia.client.id, method: 'card' }, max.token)).success, false);
});

let maxSub;
test('webhooks: checkout + invoice.paid -> active membership and a Payment; duplicates applied once', async () => {
  const ag = await agreementFor(max, monthly);
  const start = await api.fn('startCheckout', { plan_id: monthly.id, method: 'card', agreement_id: ag.id }, max.token);
  const { session, subscription } = fake.completeCheckout(start.session_id, { last4: '4242', brand: 'visa' });
  maxSub = subscription.id;
  const done = await hook(fake.event('checkout.session.completed', session));
  assert.equal(done.status, 200, JSON.stringify(done.data));
  let [m] = await membershipsOf(max.client);
  assert.ok(m, 'membership created');
  assert.equal(m.stripe_subscription_id, subscription.id);
  assert.equal(m.billing_status, 'active');
  assert.equal(m.card_last4, '4242');
  assert.equal(m.card_brand, 'visa');
  assert.equal(m.payment_method, 'card');
  assert.equal(m.agreement_id, ag.id);
  assert.ok(m.commitment_ends > eastern().date, 'six-month commitment');

  const inv = fake.invoiceFor(subscription.id, { amount_paid: 20493, tax: 593 });
  const paid = fake.event('invoice.paid', inv);
  assert.equal((await hook(paid)).status, 200);
  const again = await hook(paid);
  assert.equal(again.data.duplicate, true);
  const payments = (await api.list('Payment', admin.token)).filter((p) => p.client_id === max.client.id);
  assert.equal(payments.length, 1, 'same event twice = one Payment');
  assert.equal(payments[0].amount_cents, 20493);
  assert.equal(payments[0].tax_cents, 593);
  assert.equal(payments[0].status, 'paid');
  assert.equal(payments[0].stripe_invoice_id, inv.id);
  [m] = await membershipsOf(max.client);
  assert.equal(m.last_payment_date, eastern().date);
  assert.ok(m.next_payment_date > eastern().date);

  const mine = await api.fn('myBilling', {}, max.token);
  assert.equal(mine.connected, true);
  assert.equal(mine.past_due, false);
  assert.equal(mine.memberships[0].card_last4, '4242');
  assert.equal(mine.payments.length, 1);
  assert.equal(mine.payments[0].amount_cents, 20493);
  const portal = await api.fn('billingPortal', {}, max.token);
  assert.match(portal.url, /^https:\/\/billing\.stripe\.test\//);
  assert.equal(fake.get('billing_portal/sessions', portal.url.split('/').pop()).customer, m.stripe_customer_id);
});

test('one-time checkout writes the Payment from the session', async () => {
  const start = await api.fn('startCheckout', { plan_id: dropIn.id, method: 'card' }, nia.token);
  const { session } = fake.completeCheckout(start.session_id);
  session.total_details = { amount_tax: 75, amount_discount: 0 };
  assert.equal((await hook(fake.event('checkout.session.completed', session))).status, 200);
  const [m] = await membershipsOf(nia.client);
  assert.equal(m.kind, 'drop_in');
  assert.equal(m.stripe_subscription_id, null);
  const mine = await api.fn('myBilling', {}, nia.token);
  assert.equal(mine.payments.length, 1);
  assert.equal(mine.payments[0].amount_cents, 2500);
  assert.equal(mine.payments[0].tax_cents, 75);
});

test('failed payment -> past due, notice sent, booking blocked; paid again -> unblocked', async () => {
  const s = await makeClass();
  const failed = fake.invoiceFor(maxSub, { amount_paid: 20493, status: 'open' });
  assert.equal((await hook(fake.event('invoice.payment_failed', failed))).status, 200);
  let [m] = await membershipsOf(max.client);
  assert.equal(m.billing_status, 'past_due');
  assert.equal(m.failed_payments, 1);
  const notes = await api.list('Notification', max.token);
  assert.ok(notes.some((n) => n.type === 'billing' && /didn't go through/.test(n.title)), JSON.stringify(notes));
  const blocked = await api.fn('bookClass', { session_id: s.id }, max.token);
  assert.equal(blocked.code, 'payment_past_due');
  assert.match(blocked.error, /Update your card to book/);
  assert.equal((await api.fn('myBilling', {}, max.token)).past_due, true);
  // Staff see why and may override.
  const staffTry = await api.fn('bookClass', { session_id: s.id, client_id: max.client.id }, admin.token);
  assert.equal(staffTry.can_override, true);
  // Second failure counts up; then a paid invoice clears it.
  await hook(fake.event('invoice.payment_failed', fake.invoiceFor(maxSub, { status: 'open' })));
  [m] = await membershipsOf(max.client);
  assert.equal(m.failed_payments, 2);
  await hook(fake.event('invoice.paid', { ...failed, status: 'paid', amount_paid: 20493, status_transitions: { paid_at: Math.floor(Date.now() / 1000) } }));
  [m] = await membershipsOf(max.client);
  assert.equal(m.billing_status, 'active');
  assert.equal(m.failed_payments, 0);
  assert.equal((await api.fn('bookClass', { session_id: s.id }, max.token)).status, 'reserved');
  const pays = (await api.list('Payment', admin.token)).filter((p) => p.stripe_invoice_id === failed.id);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].status, 'paid', 'the failed Payment became paid');
});

test('subscription updated / deleted map onto billing status', async () => {
  const sub = fake.get('subscriptions', maxSub);
  await hook(fake.event('customer.subscription.updated', { ...sub, status: 'active', pause_collection: { behavior: 'void' } }));
  let [m] = await membershipsOf(max.client);
  assert.equal(m.billing_status, 'paused');
  await hook(fake.event('customer.subscription.updated', { ...sub, status: 'unpaid', pause_collection: null }));
  [m] = await membershipsOf(max.client);
  assert.equal(m.billing_status, 'unpaid');
  assert.equal((await api.fn('bookClass', { session_id: (await makeClass()).id }, max.token)).code, 'payment_past_due');
  await hook(fake.event('customer.subscription.updated', { ...sub, status: 'active', pause_collection: null }));
  [m] = await membershipsOf(max.client);
  assert.equal(m.billing_status, 'active');
});

test('refund webhook marks the Payment refunded (partly, then fully)', async () => {
  const [p] = (await api.list('Payment', admin.token)).filter((x) => x.client_id === max.client.id && x.amount_cents === 20493 && x.status === 'paid');
  await hook(fake.event('charge.refunded', { id: 'ch_test_r1', object: 'charge', amount: 20493, amount_refunded: 5000, payment_intent: p.stripe_payment_intent_id }));
  let fresh = (await api.list('Payment', admin.token)).find((x) => x.id === p.id);
  assert.equal(fresh.refunded_cents, 5000);
  assert.equal(fresh.status, 'partially_refunded');
  await hook(fake.event('charge.refunded', { id: 'ch_test_r1', object: 'charge', amount: 20493, amount_refunded: 20493, payment_intent: p.stripe_payment_intent_id }));
  fresh = (await api.list('Payment', admin.token)).find((x) => x.id === p.id);
  assert.equal(fresh.status, 'refunded');
});

test('webhook signatures are checked; the old route forwards gym events', async () => {
  const ev = fake.event('invoice.paid', fake.invoiceFor(maxSub));
  assert.equal((await postWebhook(srv.base, 'whsec_wrong', ev)).status, 400);
  const { body } = signedEvent(WHSEC, ev);
  const unsigned = await fetch(`${srv.base}/api/stripe/gym-webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  assert.equal(unsigned.status, 400);
  const old = signedEvent(WHSEC, ev, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  const stale = await fetch(`${srv.base}/api/stripe/gym-webhook`, { method: 'POST', body: old.body, headers: { 'stripe-signature': old.header } });
  assert.equal(stale.status, 400, 'old timestamps are rejected');
  const viaOld = await postWebhook(srv.base, WHSEC, ev, '/api/stripe/webhook');
  assert.equal(viaOld.status, 200);
  assert.equal(viaOld.data.result, 'paid');
});

test('members only see their own billing; coaches see no money', async () => {
  assert.equal((await api.fn('myBilling', { client_id: max.client.id }, nia.token)).success, false);
  assert.equal((await api.fn('billingPortal', { client_id: max.client.id }, nia.token)).success, false);
  const niaMine = await api.fn('myBilling', {}, nia.token);
  assert.ok(niaMine.payments.every((p) => p.amount_cents === 2500), 'only Nia\'s own receipts');
  // Payments aren't readable or writable through the entity API by members or coaches.
  assert.deepEqual(await api.list('Payment', nia.token), []);
  assert.deepEqual(await api.list('Payment', coach.token), []);
  assert.equal((await api.call('POST', 'entities/Payment', { client_id: nia.client.id, amount_cents: 1, status: 'paid' }, nia.token)).status, 403);
  assert.equal((await api.call('POST', 'entities/Payment', { client_id: nia.client.id, amount_cents: 1, status: 'paid' }, admin.token)).status, 403, 'Payments come only from Stripe');
  assert.equal((await api.fn('myBilling', { client_id: max.client.id }, coach.token)).code, 'forbidden');
  // Coaches read memberships and plans without any money or billing fields.
  const money = ['price_cents', 'billing_status', 'stripe_customer_id', 'stripe_subscription_id', 'card_last4', 'card_brand', 'failed_payments', 'next_payment_date', 'last_payment_date', 'payment_method', 'stripe_price_id', 'stripe_price_bank_id', 'buyout_cents', 'tax_rate_pct', 'bank_discount_pct'];
  const mems = (await api.list('Membership', coach.token)).filter((m) => m.client_id === max.client.id);
  assert.ok(mems.length > 0);
  const plans = await api.list('MembershipPlan', coach.token);
  const clients = (await api.list('Client', coach.token)).filter((c) => c.id === max.client.id);
  for (const rec of [...mems, ...plans, ...clients]) for (const f of money) assert.equal(rec[f], undefined, `${f} visible to a coach`);
  // Admin (billing.view) does see them.
  assert.ok((await api.list('Membership', admin.token)).some((m) => m.card_last4 === '4242'));
  assert.ok(fake.requests.every((r) => r.auth === 'Bearer sk_test_fake'), 'every call used the test key against the fake');
});

test('subscription deleted -> canceled, membership ends, no next payment', async () => {
  const sub = fake.get('subscriptions', maxSub);
  assert.equal((await hook(fake.event('customer.subscription.deleted', { ...sub, status: 'canceled' }))).status, 200);
  const [m] = await membershipsOf(max.client);
  assert.equal(m.billing_status, 'canceled');
  assert.equal(m.next_payment_date, null);
  assert.equal(m.end_date, eastern().date);
});
