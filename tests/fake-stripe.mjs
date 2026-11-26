// A tiny in-memory imitation of the Stripe REST endpoints gym billing uses.
// Nothing here talks to Stripe. Point the API at it with
// STRIPE_API_BASE=<fake.url> (see startServer's vars in server.mjs).
//
//   const fake = await startFakeStripe();
//   fake.url                       -> 'http://127.0.0.1:<port>'
//   fake.requests                  -> [{ method, path, query, body }] every call, in order
//   fake.calls(method, prefix)     -> requests filtered by method and path prefix ('/v1/prices')
//   fake.objects.<collection>      -> Map id -> object (customers, products, prices, ...)
//   fake.get(collection, id) / fake.all(collection)
//   fake.add(collection, fields) / fake.seed(...) -> store an object directly (promotion code, subscription)
//   fake.clear()                   -> empty the request log (objects stay)
//   fake.completeCheckout(sessionId, { last4, brand, bank }) -> { session, subscription }
//        marks the session complete and, for subscription mode, creates the
//        subscription with a default payment method (like Stripe does)
//   fake.invoiceFor(subscriptionId, { amount_paid, tax, discount, status }) -> invoice
//   fake.event(type, object)       -> a Stripe-shaped event { id: 'evt_test_N', type, data: { object } }
//   fake.reset(), fake.stop()
//
//   signedEvent(secret, event) -> { body, header }   header is a valid Stripe-Signature
//   postWebhook(base, secret, event, path?) -> { status, data }
import http from 'node:http';
import crypto from 'node:crypto';

const PREFIX = {
  customers: 'cus', products: 'prod', prices: 'price', coupons: 'coupon', promotion_codes: 'promo',
  tax_rates: 'txr', 'checkout/sessions': 'cs', 'billing_portal/sessions': 'bps', subscriptions: 'sub',
  invoices: 'in', invoiceitems: 'ii', refunds: 're', payment_intents: 'pi', payment_methods: 'pm', charges: 'ch', subscription_schedules: 'sub_sched',
};
const OBJECT = {
  customers: 'customer', products: 'product', prices: 'price', coupons: 'coupon', promotion_codes: 'promotion_code',
  tax_rates: 'tax_rate', 'checkout/sessions': 'checkout.session', 'billing_portal/sessions': 'billing_portal.session',
  subscriptions: 'subscription', invoices: 'invoice', invoiceitems: 'invoiceitem', refunds: 'refund',
  payment_intents: 'payment_intent', payment_methods: 'payment_method', charges: 'charge',
  subscription_schedules: 'subscription_schedule',
};

// Parse Stripe's bracketed form keys (metadata[a], line_items[0][price]) into objects/arrays.
export function parseForm(text) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const parts = rawKey.replace(/\]/g, '').split('[');
    let cur = out;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d*$/.test(parts[i + 1]);
      const key = p === '' && Array.isArray(cur) ? cur.length : (Array.isArray(cur) ? Number(p) : p);
      if (last) cur[key] = value;
      else {
        if (cur[key] === undefined) cur[key] = nextIsIndex ? [] : {};
        cur = cur[key];
      }
    });
  }
  return out;
}

const num = (v) => (v === undefined || v === '' ? v : Number.isFinite(Number(v)) ? Number(v) : v);
const bool = (v) => (v === 'true' ? true : v === 'false' ? false : v);

export async function startFakeStripe() {
  const objects = Object.fromEntries(Object.keys(PREFIX).map((c) => [c, new Map()]));
  const requests = [];
  let seq = 0;
  let evtSeq = 0;
  const now = () => Math.floor(Date.now() / 1000);
  const newId = (collection) => `${PREFIX[collection]}_test_${++seq}`;
  const add = (collection, fields = {}) => {
    const id = fields.id || newId(collection);
    const obj = { id, object: OBJECT[collection], created: now(), livemode: false, metadata: {}, ...fields };
    objects[collection].set(id, obj);
    return obj;
  };

  function create(collection, body) {
    const f = { ...body };
    if (collection === 'prices') {
      f.unit_amount = num(f.unit_amount);
      f.active = f.active === undefined ? true : bool(f.active);
      f.type = f.recurring ? 'recurring' : 'one_time';
      if (f.recurring) f.recurring = { ...f.recurring, interval_count: num(f.recurring.interval_count) || 1 };
    }
    if (collection === 'tax_rates') { f.percentage = num(f.percentage); f.inclusive = bool(f.inclusive) ?? false; f.active = true; }
    if (collection === 'products') f.active = f.active === undefined ? true : bool(f.active);
    if (collection === 'coupons') { f.percent_off = num(f.percent_off); f.amount_off = num(f.amount_off); f.valid = true; }
    if (collection === 'promotion_codes') f.active = f.active === undefined ? true : bool(f.active);
    if (collection === 'checkout/sessions') {
      f.status = 'open';
      f.payment_status = 'unpaid';
      f.allow_promotion_codes = bool(f.allow_promotion_codes);
      f.amount_total = (f.line_items || []).reduce((n, li) => n + (objects.prices.get(li.price)?.unit_amount || 0) * (num(li.quantity) || 1), 0);
    }
    if (collection === 'billing_portal/sessions') f.created = now();
    if (collection === 'subscriptions') { f.status = f.status || 'active'; f.current_period_start = now(); f.current_period_end = now() + 30 * 86400; }
    if (collection === 'subscription_schedules') f.status = 'active';
    if (collection === 'refunds') { f.amount = num(f.amount); f.status = 'succeeded'; }
    if (collection === 'payment_intents') { f.amount = num(f.amount); f.status = 'succeeded'; }
    if (collection === 'invoices') f.status = 'draft';
    if (collection === 'invoiceitems') f.amount = num(f.amount);
    const obj = add(collection, f);
    if (collection === 'checkout/sessions') obj.url = `https://checkout.stripe.test/c/pay/${obj.id}`;
    if (collection === 'billing_portal/sessions') obj.url = `https://billing.stripe.test/p/session/${obj.id}`;
    return obj;
  }

  function update(collection, obj, body) {
    for (const [k, v] of Object.entries(body)) {
      if (k === 'metadata') obj.metadata = { ...obj.metadata, ...v };
      else if (v === '') obj[k] = null; // Stripe clears a field with an empty string
      else obj[k] = typeof v === 'string' ? bool(num(v)) : v;
    }
    if (collection === 'subscriptions' && body.cancel_at_period_end !== undefined) obj.cancel_at_period_end = bool(body.cancel_at_period_end);
    return obj;
  }

  function list(collection, query) {
    let rows = [...objects[collection].values()];
    for (const [k, v] of Object.entries(query)) {
      if (['limit', 'expand', 'starting_after', 'ending_before'].includes(k)) continue;
      if (k === 'lookup_keys') { const keys = [].concat(v); rows = rows.filter((r) => keys.includes(r.lookup_key)); continue; }
      rows = rows.filter((r) => String(r[k]) === String(v));
    }
    const limit = Number(query.limit) || 10;
    return { object: 'list', data: rows.slice(0, limit), has_more: rows.length > limit, url: `/v1/${collection}` };
  }

  function route(method, path, query, body) {
    const p = path.replace(/^\/v1\//, '');
    const collection = Object.keys(PREFIX).sort((a, b) => b.length - a.length).find((c) => p === c || p.startsWith(`${c}/`));
    if (!collection) return [404, { error: { message: `Unknown endpoint ${path}` } }];
    const rest = p.slice(collection.length).replace(/^\//, '').split('/').filter(Boolean);
    if (!rest.length) {
      if (method === 'GET') return [200, list(collection, query)];
      if (method === 'POST') return [200, create(collection, body)];
      return [405, { error: { message: 'Method not allowed' } }];
    }
    const obj = objects[collection].get(rest[0]);
    if (!obj) return [404, { error: { message: `No such ${OBJECT[collection]}: '${rest[0]}'`, type: 'invalid_request_error' } }];
    if (rest[1] === 'pay' && collection === 'invoices') { obj.status = 'paid'; obj.amount_paid = obj.amount_due ?? obj.total ?? 0; return [200, obj]; }
    if (rest[1] === 'finalize' && collection === 'invoices') { obj.status = 'open'; return [200, obj]; }
    if (method === 'GET') {
      if (collection === 'subscriptions' && obj.default_payment_method && typeof obj.default_payment_method === 'string') {
        return [200, { ...obj, default_payment_method: objects.payment_methods.get(obj.default_payment_method) || obj.default_payment_method }];
      }
      return [200, obj];
    }
    if (method === 'POST') return [200, update(collection, obj, body)];
    if (method === 'DELETE') {
      if (collection === 'subscriptions') { obj.status = 'canceled'; obj.canceled_at = now(); return [200, obj]; }
      objects[collection].delete(obj.id);
      return [200, { id: obj.id, object: OBJECT[collection], deleted: true }];
    }
    return [405, { error: { message: 'Method not allowed' } }];
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://fake');
      const query = parseForm(u.search.slice(1));
      const body = raw ? parseForm(raw) : {};
      const entry = { method: req.method, path: u.pathname, query, body, auth: req.headers.authorization || '' };
      requests.push(entry);
      let status; let out;
      if (!/^Bearer sk_test_/.test(entry.auth)) { status = 401; out = { error: { message: 'Invalid API Key provided' } }; }
      else [status, out] = route(req.method, u.pathname, query, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url, requests, objects, add,
    seed: add, // seed('subscriptions', { customer, items: { data: [{ price }] }, current_period_start, current_period_end })
    get: (collection, id) => objects[collection].get(id),
    all: (collection) => [...objects[collection].values()],
    calls: (method, prefix) => requests.filter((r) => r.method === method && r.path.startsWith(prefix)),
    completeCheckout(sessionId, { last4 = '4242', brand = 'visa', bank = false } = {}) {
      const session = objects['checkout/sessions'].get(sessionId);
      if (!session) throw new Error(`No session ${sessionId}`);
      session.status = 'complete';
      session.payment_status = 'paid';
      let subscription = null;
      if (session.mode === 'subscription') {
        const pm = add('payment_methods', bank
          ? { type: 'us_bank_account', us_bank_account: { last4, bank_name: 'STRIPE TEST BANK' } }
          : { type: 'card', card: { last4, brand } });
        subscription = create('subscriptions', {
          customer: session.customer, metadata: { ...(session.subscription_data?.metadata || {}) },
          items: { object: 'list', data: (session.line_items || []).map((li) => ({ price: objects.prices.get(li.price) })) },
          default_payment_method: pm.id,
        });
        session.subscription = subscription.id;
      } else {
        const pi = create('payment_intents', { amount: session.amount_total, customer: session.customer, metadata: { ...(session.payment_intent_data?.metadata || {}) } });
        session.payment_intent = pi.id;
      }
      return { session, subscription };
    },
    invoiceFor(subscriptionId, { amount_paid = 10000, tax = 0, discount = 0, status = 'paid' } = {}) {
      const sub = objects.subscriptions.get(subscriptionId);
      const pi = create('payment_intents', { amount: amount_paid, customer: sub?.customer });
      const periodEnd = now() + 30 * 86400;
      return add('invoices', {
        customer: sub?.customer || null, subscription: subscriptionId, status,
        amount_paid: status === 'paid' ? amount_paid : 0, amount_due: amount_paid, total: amount_paid,
        payment_intent: pi.id,
        total_tax_amounts: tax ? [{ amount: tax }] : [], total_discount_amounts: discount ? [{ amount: discount }] : [],
        status_transitions: { paid_at: status === 'paid' ? now() : null },
        lines: { object: 'list', data: [{ description: 'Membership', period: { start: now(), end: periodEnd } }] },
        subscription_details: { metadata: { ...(sub?.metadata || {}) } },
      });
    },
    event(type, object) {
      return { id: `evt_test_${++evtSeq}_${Date.now()}`, object: 'event', type, created: now(), livemode: false, data: { object } };
    },
    reset() { requests.length = 0; for (const m of Object.values(objects)) m.clear(); },
    clear() { requests.length = 0; }, // forget the request log only
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Stripe-Signature: "t=<unix>,v1=<hex HMAC-SHA256 of `${t}.${body}`>" — the
// scheme verifyStripeSignature checks.
export function signedEvent(secret, event, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = typeof event === 'string' ? event : JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { body, header: `t=${timestamp},v1=${sig}` };
}

export async function postWebhook(base, secret, event, path = '/api/stripe/gym-webhook') {
  const { body, header } = signedEvent(secret, event);
  const res = await fetch(`${base}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': header } });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
