// stub: owned by CORE — swap for tests/fake-stripe.mjs at merge.
// A tiny local Stripe imitation for the SALES tests: checkout sessions,
// coupons and promotion codes. Records every request so tests can assert.
import http from 'node:http';

export async function startFakeStripe() {
  const requests = [];
  const store = { promotion_codes: [] };
  let n = 0;
  const id = (prefix) => `${prefix}_test_${++n}`;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = Object.fromEntries(new URLSearchParams(raw));
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const p = url.pathname;
      if (req.method === 'POST' && p === '/v1/checkout/sessions') {
        const sid = id('cs');
        return send(200, { id: sid, object: 'checkout.session', url: `https://checkout.stripe.test/${sid}`, mode: body.mode, metadata: {} });
      }
      if (req.method === 'POST' && p === '/v1/coupons') return send(200, { id: id('coupon'), object: 'coupon', ...body });
      if (req.method === 'POST' && p === '/v1/promotion_codes') {
        const promo = { id: id('promo'), object: 'promotion_code', code: body.code, coupon: { id: body.coupon }, active: true, times_redeemed: 0 };
        store.promotion_codes.push(promo);
        return send(200, promo);
      }
      if (req.method === 'GET' && p === '/v1/promotion_codes') {
        const list = store.promotion_codes.filter((x) => (!url.searchParams.get('code') || x.code === url.searchParams.get('code'))
          && (url.searchParams.get('active') !== 'true' || x.active));
        return send(200, { object: 'list', data: list });
      }
      const m = /^\/v1\/promotion_codes\/([\w-]+)$/.exec(p);
      if (req.method === 'POST' && m) {
        const promo = store.promotion_codes.find((x) => x.id === m[1]);
        if (!promo) return send(404, { error: { message: 'No such promotion code' } });
        if ('active' in body) promo.active = body.active === 'true';
        return send(200, promo);
      }
      return send(404, { error: { message: `Fake Stripe has no ${req.method} ${p}` } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, store, stop: () => server.close() };
}
