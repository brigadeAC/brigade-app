// Ask Brigade: sign-in required, and it stays off without an AI key.
// (The test server has no AI key, so nothing here calls a model.)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, ADMIN } from './server.mjs';

let srv; let api; let admin;
before(async () => {
  srv = await startServer();
  api = client(srv.base);
  admin = (await api.call('POST', 'auth/register', { email: ADMIN.email, password: ADMIN.password, full_name: 'Ada Admin' })).data;
});
after(() => srv?.stop());

test('Ask Brigade needs a signed-in user', async () => {
  const r = await api.call('POST', 'functions/askBrigade', { messages: [{ role: 'user', text: 'hi' }] });
  assert.equal(r.status, 401);
});

test('Ask Brigade says plainly when AI is not set up', async () => {
  const r = await api.fn('askBrigade', { messages: [{ role: 'user', text: 'What classes are tomorrow?' }] }, admin.token);
  assert.equal(r.success, false);
  assert.match(r.error, /switched on/);
});
