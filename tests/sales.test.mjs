// Phase 4 SALES: public join page, promo codes, billing dashboard, QuickBooks CSV.
// Runs the real API on throwaway databases against a fake Stripe (no keys, no network).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, eastern, addDays, tokenOf, ADMIN } from './server.mjs';
import { startFakeStripe, postWebhook } from './fake-stripe.mjs';

let fake; let srv; let off; let api; let offApi; let admin; let coach; let manager;
let unlimited; let privatePlan; let trial; let intro; let offPlan; let offTrial;
const today = eastern().date;
const month = today.slice(0, 7);

async function staff(a, email, name, role) {
  const inv = await a.fn('createInvite', { email, full_name: name }, admin.token);
  const reg = await a.call('POST', 'auth/register', { token: tokenOf(inv.link), full_name: name, password: 'staff-pass-1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  if (role) assert.equal((await a.fn('setStaffRole', { user_id: reg.data.user.id, role }, admin.token)).success, true);
  return { token: reg.data.token, id: reg.data.user.id };
}
const WHSEC = 'whsec_fake';
const checkoutCalls = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions');
const unixOf = (iso) => Math.floor(Date.parse(iso) / 1000);
// Payments come only from Stripe: send a signed invoice webhook for a Stripe-linked membership.
async function invoiceEvent({ id, sub, amount, tax = 0, discount = 0, at, description, failed = false, periodEnd }) {
  const inv = {
    id, object: 'invoice', subscription: sub, status: failed ? 'open' : 'paid',
    amount_paid: failed ? 0 : amount, amount_due: amount, total: amount, payment_intent: `pi_${id}`,
    total_tax_amounts: tax ? [{ amount: tax }] : [], total_discount_amounts: discount ? [{ amount: discount }] : [],
    status_transitions: { paid_at: failed ? null : unixOf(at) },
    lines: { object: 'list', data: [{ description, period: { start: unixOf(at), end: periodEnd || unixOf(at) + 30 * 86400 } }] },
  };
  const r = await postWebhook(srv.base, WHSEC, fake.event(failed ? 'invoice.payment_failed' : 'invoice.paid', inv));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return inv;
}

before(async () => {
  fake = await startFakeStripe();
  fake.seed('products', { id: 'prod_secret', name: 'Unlimited' }); // the plan below says it is already in Stripe
  [srv, off] = await Promise.all([
    startServer(0, { vars: { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: fake.url, SALES_RATE_LIMIT: 8 } }),
    startServer(0),
  ]);
  api = client(srv.base);
  offApi = client(off.base);
  const first = await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  admin = { token: first.data.token };
  coach = await staff(api, 'coach@example.test', 'Cody Coach');
  manager = await staff(api, 'manager@example.test', 'Mona Manager', 'manager');
  await api.create('GymSettings', { waiver_required: false, tax_rate_pct: 2.98, bank_discount_pct: 2.89 }, admin.token);
  unlimited = await api.create('MembershipPlan', {
    name: 'Unlimited', kind: 'unlimited', is_active: true, public: true, price_cents: 18900, interval: 'month', commitment_months: 6,
    description: 'Every class, every day.', stripe_product_id: 'prod_secret', stripe_price_id: 'price_secret', buyout_cents: 9900, class_type_ids: [],
  }, admin.token);
  privatePlan = await api.create('MembershipPlan', { name: 'Staff Comp', kind: 'comp', is_active: true, public: false, price_cents: 0 }, admin.token);
  trial = await api.create('MembershipPlan', { name: 'Free Trial Class', kind: 'trial', is_active: true, public: true, price_cents: 0, interval: 'once' }, admin.token);
  intro = await api.create('MembershipPlan', { name: '7 for $7', kind: 'intro', is_active: true, public: true, price_cents: 700, interval: 'once' }, admin.token);
  await api.create('MembershipPlan', { name: 'Old Plan', kind: 'unlimited', is_active: false, public: true, price_cents: 15000 }, admin.token);

  const offFirst = await offApi.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' });
  const offAdmin = offFirst.data.token;
  offPlan = await offApi.create('MembershipPlan', { name: 'Unlimited', kind: 'unlimited', is_active: true, public: true, price_cents: 18900, interval: 'month' }, offAdmin);
  offTrial = await offApi.create('MembershipPlan', { name: 'Free Trial Class', kind: 'trial', is_active: true, public: true, price_cents: 0 }, offAdmin);
});
after(async () => { srv?.stop(); off?.stop(); await fake?.stop(); });

test('publicPlans works signed out, lists only public active plans, and hides private fields', async () => {
  const r = await api.fn('publicPlans', {});
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.connected, true);
  const names = r.plans.map((p) => p.name).sort();
  assert.deepEqual(names, ['7 for $7', 'Free Trial Class', 'Unlimited']);
  const u = r.plans.find((p) => p.name === 'Unlimited');
  assert.equal(u.group, 'membership');
  assert.equal(u.price_cents, 18900);
  assert.equal(u.bank_price_cents, Math.round(18900 * (1 - 2.89 / 100)));
  assert.equal(u.tax_note, 'plus 2.98% tax');
  assert.equal(u.commitment_months, 6);
  assert.equal(r.plans.find((p) => p.name === 'Free Trial Class').group, 'try');
  assert.equal(r.plans.find((p) => p.name === '7 for $7').group, 'try');
  const allowed = new Set(['id', 'name', 'kind', 'group', 'free', 'description', 'price_cents', 'interval', 'interval_count', 'commitment_months',
    'bank_discount_pct', 'bank_price_cents', 'tax_rate_pct', 'tax_note']);
  for (const p of r.plans) for (const k of Object.keys(p)) assert.ok(allowed.has(k), `unexpected field ${k}`);
  const text = JSON.stringify(r);
  for (const secret of ['prod_secret', 'price_secret', 'buyout_cents', '9900', 'Staff Comp', privatePlan.id]) assert.ok(!text.includes(secret), secret);
  assert.ok(r.agreement.text.length > 20);
});

test('publicCheckout checks its input', async () => {
  const base = { plan_id: unlimited.id, full_name: 'Pat Prospect', email: 'pat@example.test', phone: '423-555-0100', method: 'card', signed_name: 'Pat Prospect' };
  assert.equal((await api.fn('publicCheckout', { ...base, email: 'nope' })).success, false);
  assert.equal((await api.fn('publicCheckout', { ...base, plan_id: privatePlan.id })).success, false, 'private plans cannot be bought');
  const unsigned = await api.fn('publicCheckout', { ...base, signed_name: '' });
  assert.equal(unsigned.code, 'agreement_required');
  assert.equal(checkoutCalls().length, 0);
});

test('publicCheckout creates a lead, signs the agreement and opens Stripe Checkout', async () => {
  const r = await api.fn('publicCheckout', {
    plan_id: unlimited.id, full_name: 'Pat Prospect', email: 'Pat@Example.test', phone: '423-555-0100', method: 'bank', signed_name: 'pat prospect',
  });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.match(r.url, /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_/);
  const call = checkoutCalls().at(-1);
  assert.equal(call.body.mode, 'subscription');
  assert.deepEqual(call.body.payment_method_types, ['us_bank_account']);
  assert.equal(fake.get('customers', call.body.customer).email, 'pat@example.test');
  assert.match(call.body.success_url, /\/JoinBrigade\?joined=1$/);
  const clients = await api.list('Client', admin.token);
  const lead = clients.find((c) => c.email === 'pat@example.test');
  assert.equal(lead.status, 'lead');
  assert.equal(call.body.metadata.client_id, lead.id);
  const agreements = await api.list('Agreement', admin.token);
  assert.ok(agreements.some((a) => a.client_id === lead.id && a.plan_id === unlimited.id && a.signed_name === 'pat prospect'));
});

test('publicCheckout answers the same way for a known email and does not duplicate the client', async () => {
  const existing = await api.create('Client', { full_name: 'Known Person', email: 'known@example.test', status: 'active' }, admin.token);
  const known = await api.fn('publicCheckout', { plan_id: intro.id, full_name: 'Known Person', email: 'known@example.test', phone: '4235550101', method: 'card' });
  const fresh = await api.fn('publicCheckout', { plan_id: intro.id, full_name: 'New Person', email: 'new@example.test', phone: '4235550102', method: 'card' });
  assert.deepEqual(Object.keys(known).sort(), Object.keys(fresh).sort());
  assert.equal(known.kind, fresh.kind);
  assert.ok(!JSON.stringify(known).includes(existing.id));
  assert.ok(!('client_id' in known));
  assert.equal(checkoutCalls().at(-1).body.mode, 'payment', 'one-time intro offer');
  const clients = await api.list('Client', admin.token);
  assert.equal(clients.filter((c) => c.email === 'known@example.test').length, 1);
  assert.equal(clients.find((c) => c.email === 'known@example.test').status, 'active', 'existing client untouched');
});

test('free trial: no charge, creates a lead and records the request', async () => {
  const before = checkoutCalls().length;
  const r = await api.fn('publicCheckout', { plan_id: trial.id, full_name: 'Tess Trial', email: 'tess@example.test', phone: '4235550103' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.kind, 'trial');
  assert.ok(!r.url && !r.link, 'no checkout and no invite link returned');
  assert.equal(checkoutCalls().length, before);
  const lead = (await api.list('Client', admin.token)).find((c) => c.email === 'tess@example.test');
  assert.equal(lead.status, 'lead');
  const msgs = await api.list('ContactMessage', admin.token);
  assert.ok(msgs.some((m) => m.email === 'tess@example.test' && /Free trial/.test(m.subject)));
});

test('without billing connected: plans still show, paid checkout says contact us, free trial still works', async () => {
  const plans = await offApi.fn('publicPlans', {});
  assert.equal(plans.connected, false);
  assert.equal(plans.plans.length, 2);
  const r = await offApi.fn('publicCheckout', { plan_id: offPlan.id, full_name: 'Olive Off', email: 'olive@example.test', phone: '4235550104', method: 'card', signed_name: 'Olive Off' });
  assert.equal(r.success, false);
  assert.equal(r.code, 'billing_not_connected');
  const t = await offApi.fn('publicCheckout', { plan_id: offTrial.id, full_name: 'Olive Off', email: 'olive@example.test', phone: '4235550104' });
  assert.equal(t.success, true);
});

test('promo codes: create sends a coupon and a promotion code to Stripe; only settings.manage edits', async () => {
  assert.equal((await api.fn('listPromoCodes', {}, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('savePromoCode', { code: 'NOPE', percent_off: 10, duration: 'once' }, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('savePromoCode', { code: 'BAD', percent_off: 10, amount_off_cents: 500, duration: 'once' }, admin.token)).success, false);
  const r = await api.fn('savePromoCode', { code: 'summer25', percent_off: 25, duration: 'repeating', duration_in_months: 3, expires_on: addDays(today, 30), max_redemptions: 50 }, manager.token);
  assert.equal(r.success, true, JSON.stringify(r));
  const coupon = fake.requests.find((x) => x.path === '/v1/coupons');
  assert.equal(coupon.body.percent_off, '25');
  assert.equal(coupon.body.duration, 'repeating');
  assert.equal(coupon.body.duration_in_months, '3');
  const promo = fake.requests.find((x) => x.path === '/v1/promotion_codes' && x.method === 'POST');
  assert.equal(promo.body.code, 'SUMMER25');
  assert.equal(promo.body.coupon, coupon.body && r.promo_code.coupon_id);
  assert.equal(promo.body.max_redemptions, '50');
  assert.ok(Number(promo.body.expires_at) > Date.now() / 1000);
  const amt = await api.fn('savePromoCode', { code: 'TENOFF', amount_off_cents: 1000, duration: 'once' }, admin.token);
  assert.equal(amt.success, true);
  assert.equal(fake.requests.filter((x) => x.path === '/v1/coupons').at(-1).body.amount_off, '1000');
  assert.equal((await api.fn('savePromoCode', { code: 'SUMMER25', percent_off: 5, duration: 'once' }, admin.token)).success, false, 'duplicate');
  const list = await api.fn('listPromoCodes', {}, manager.token);
  assert.equal(list.codes.length, 2);
  const arch = await api.fn('archivePromoCode', { id: r.promo_code.id }, admin.token);
  assert.equal(arch.promo_code.active, false);
  assert.equal(fake.all('promotion_codes').find((x) => x.code === 'SUMMER25').active, false);
  const off = await offApi.call('POST', 'auth/login', { email: ADMIN.email, password: ADMIN.password });
  const offList = await offApi.fn('listPromoCodes', {}, off.data.token);
  assert.equal(offList.connected, false);
  assert.equal((await offApi.fn('savePromoCode', { code: 'X123', percent_off: 5, duration: 'once' }, off.data.token)).code, 'billing_not_connected');
});

test('billing dashboard and QuickBooks CSV from seeded payments', async () => {
  const a = await api.create('Client', { full_name: 'Alex Able', email: 'alex@example.test', status: 'active' }, admin.token);
  const b = await api.create('Client', { full_name: '=HYPERLINK("http://evil")', email: 'evil@example.test', status: 'active' }, admin.token);
  const c = await api.create('Client', { full_name: 'Casey, "CJ" Jones', email: 'cj@example.test', status: 'active' }, admin.token);
  const linked = { stripe_customer_id: 'cus_dash', payment_method: 'card' };
  const mA = await api.create('Membership', { client_id: a.id, plan_id: unlimited.id, start_date: addDays(today, -60), status: 'active', billing_status: 'active', stripe_subscription_id: 'sub_dash_a', ...linked }, admin.token);
  const mB = await api.create('Membership', { client_id: b.id, plan_id: unlimited.id, start_date: addDays(today, -60), status: 'active', billing_status: 'active', failed_payments: 1, stripe_subscription_id: 'sub_dash_b', ...linked }, admin.token);
  await api.create('Membership', { client_id: c.id, plan_id: unlimited.id, start_date: addDays(today, -60), status: 'active', billing_status: 'paused', stripe_subscription_id: 'sub_dash_c', ...linked, payment_method: 'bank' }, admin.token);
  await api.create('Membership', { client_id: c.id, plan_id: unlimited.id, start_date: addDays(today, -60), status: 'active', billing_status: 'comped' }, admin.token);
  const at = `${today}T16:00:00.000Z`;
  const lastMonth = addDays(`${month}-01`, -5);
  await invoiceEvent({ id: 'in_old', sub: 'sub_dash_a', amount: 99999, at: `${lastMonth}T16:00:00.000Z` });
  await invoiceEvent({ id: 'in_1', sub: 'sub_dash_a', amount: 19463, tax: 563, at, description: 'Unlimited', periodEnd: unixOf(`${addDays(today, 3)}T16:00:00.000Z`) });
  const in2 = await invoiceEvent({ id: 'in_2', sub: 'sub_dash_c', amount: 10000, tax: 290, discount: 500, at, description: '-1+1 tricky' });
  await postWebhook(srv.base, WHSEC, fake.event('charge.refunded', { id: 'ch_dash_2', object: 'charge', amount: 10000, amount_refunded: 2500, payment_intent: in2.payment_intent }));
  await invoiceEvent({ id: 'in_3', sub: 'sub_dash_b', amount: 19463, at, failed: true }); // second failed payment for mB
  assert.equal((await api.list('Payment', admin.token)).length, 4);

  assert.equal((await api.fn('billingDashboard', {}, coach.token)).code, 'forbidden');
  assert.equal((await api.fn('exportPaymentsCsv', {}, coach.token)).code, 'forbidden');
  const d = await api.fn('billingDashboard', { month }, manager.token);
  assert.equal(d.success, true, JSON.stringify(d));
  assert.equal(d.revenue.gross_cents, 29463);
  assert.equal(d.revenue.refunded_cents, 2500);
  assert.equal(d.revenue.net_cents, 26963);
  assert.equal(d.revenue.tax_cents, 853);
  assert.equal(d.revenue.failed, 1);
  assert.deepEqual(d.counts, { active: 1, past_due: 1, paused: 1, comped: 1 });
  assert.equal(d.past_due.length, 1);
  assert.equal(d.past_due[0].failed_payments, 2);
  assert.equal(d.past_due[0].plan, 'Unlimited');
  assert.equal(d.past_due[0].since, today);
  assert.ok(d.renewals.some((r) => r.membership_id === mA.id && r.date === addDays(today, 3)));
  assert.equal(d.refunds[0].refunded_cents, 2500);

  const e = await api.fn('exportPaymentsCsv', { from: `${month}-01`, to: today }, manager.token);
  assert.equal(e.success, true, JSON.stringify(e));
  assert.equal(e.count, 2, 'failed and older payments left out');
  const lines = e.csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,Customer,Description,Amount,Tax,Discount,Refunded,Method,Stripe id');
  const us = `${today.slice(5, 7)}/${today.slice(8, 10)}/${today.slice(0, 4)}`;
  assert.ok(lines.includes(`${us},Alex Able,Unlimited,194.63,5.63,0.00,0.00,card,in_1`), e.csv);
  assert.ok(lines.includes(`${us},"Casey, ""CJ"" Jones",'-1+1 tricky,100.00,2.90,5.00,25.00,bank,in_2`), e.csv);
  assert.ok(!e.csv.includes('HYPERLINK'), 'failed payment not exported');

  // Formula guard on a customer name in an exported row.
  await invoiceEvent({ id: 'in_4', sub: 'sub_dash_b', amount: 100, at, description: '@SUM(A1)' });
  const e2 = await api.fn('exportPaymentsCsv', { from: today, to: today }, admin.token);
  assert.ok(e2.csv.includes(`${us},"'=HYPERLINK(""http://evil"")",'@SUM(A1),1.00`), e2.csv);
  assert.equal((await api.fn('exportPaymentsCsv', { from: today, to: addDays(today, -1) }, admin.token)).success, false);
});

test('public checkout is rate limited per address', async () => {
  let limited = null;
  for (let i = 0; i < 20 && !limited; i += 1) {
    const r = await api.fn('publicCheckout', { plan_id: 'missing', full_name: 'Rita Rapid', email: 'rita@example.test', phone: '4235550199' });
    if (r.code === 'rate_limited') limited = i;
  }
  assert.ok(limited !== null, 'should be refused after too many tries');
  assert.equal((await api.fn('publicCheckout', { plan_id: trial.id, full_name: 'Rita Rapid', email: 'rita@example.test', phone: '4235550199' })).code, 'rate_limited');
});
