// stub: owned by CORE — swap for tests/fake-stripe.mjs at merge.
// A tiny local Stripe stand-in for the membership rules tests: stores objects
// in memory, answers in Stripe's shape and records every request.
import http from 'node:http';

export async function startFakeStripe() {
  const objects = new Map();
  const requests = [];
  let n = 0;
  const prefix = { subscriptions: 'sub', subscription_schedules: 'sub_sched', invoiceitems: 'ii', invoices: 'in', refunds: 're', customers: 'cus' };
  const object = { subscriptions: 'subscription', subscription_schedules: 'subscription_schedule', invoiceitems: 'invoiceitem', invoices: 'invoice', refunds: 'refund', customers: 'customer' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = Object.fromEntries(new URLSearchParams(raw));
      const path = req.url.split('?')[0].replace(/^\/v1\//, '');
      requests.push({ method: req.method, path, body });
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      const [type, id, action] = path.split('/');
      if (!object[type]) return send(404, { error: { message: `Unknown path ${path}` } });
      if (req.method === 'POST' && !id) {
        n += 1;
        const obj = { id: `${prefix[type]}_test_${n}`, object: object[type], ...body };
        if (type === 'invoices') obj.status = 'draft';
        objects.set(obj.id, obj);
        return send(200, obj);
      }
      const obj = objects.get(id);
      if (!obj) return send(404, { error: { message: `No such ${object[type]}: ${id}` } });
      if (req.method === 'GET') return send(200, obj);
      if (req.method === 'DELETE') { obj.status = 'canceled'; return send(200, obj); }
      if (action === 'pay') { obj.status = 'paid'; return send(200, obj); }
      Object.assign(obj, body);
      return send(200, obj);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    // Put a Stripe-shaped object in place (e.g. an existing subscription).
    seed: (obj) => { objects.set(obj.id, obj); return obj; },
    get: (id) => objects.get(id),
    clear: () => { requests.length = 0; },
    stop: () => new Promise((r) => server.close(() => r())),
  };
}
