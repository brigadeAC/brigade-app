import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { buildMessage, parseAddress, smtpSend } from '../functions/_lib/smtp.js';

// A pretend mail server. `over` changes its answers.
async function fakeServer(over = {}) {
  const log = []; let tls = false;
  const server = net.createServer((s) => {
    let data = null; let buf = '';
    if (over.silent) return;
    s.write('220-hello\r\n220 ready\r\n');
    s.on('error', () => {});
    s.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data !== null) {
          if (line === '.') { log.push({ data }); data = null; s.write(over.accept || '250 ok\r\n'); } else data += `${line}\n`;
          continue;
        }
        log.push({ line, tls });
        if (line.startsWith('EHLO')) s.write(over.noTls || tls ? '250-me\r\n250 AUTH PLAIN\r\n' : '250-me\r\n250 STARTTLS\r\n');
        else if (line === 'STARTTLS') s.write(over.inject ? '220 go\r\n250 injected\r\n' : '220 go\r\n');
        else if (line.startsWith('AUTH')) s.write(over.auth || '235 ok\r\n');
        else if (line.startsWith('RCPT')) s.write(over.rcpt || '250 ok\r\n');
        else if (line === 'DATA') { data = ''; s.write('354 go\r\n'); } else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const connect = ({ hostname, port }, opts) => {
    const s = net.connect(port, hostname); s.on('error', () => {});
    const wrap = () => ({ readable: Readable.toWeb(s), writable: Writable.toWeb(s), close: () => s.destroy(), startTls: () => { tls = true; return again; } });
    const first = wrap();
    // node streams can be wrapped once, so the "encrypted" socket reuses them
    const again = { ...first };
    connect.opts = opts;
    return first;
  };
  return { log, connect, port: server.address().port, stop: () => server.close() };
}
const base = (f) => ({ host: '127.0.0.1', port: f.port, user: 'gym@example.test', pass: 's3cret', from: 'Brigade <gym@example.test>', to: 'm@example.test', subject: 'Hi', html: '<p>Hello</p>' });

test('email: encrypts first, then signs in and sends', async () => {
  const f = await fakeServer();
  await smtpSend(f.connect, { ...base(f), subject: 'Réset\r\nBcc: evil@example.test', html: '<p>Tap <a href="https://x.test/Login#reset=abc">here</a></p>' });
  f.stop();
  assert.equal(f.connect.opts.secureTransport, 'starttls');
  assert.equal(f.log.find((l) => l.line?.startsWith('AUTH')).tls, true, 'password only after encryption');
  const { data } = f.log.find((l) => l.data);
  const headers = data.split('\n\n')[0];
  assert.ok(!/^Bcc:/m.test(headers), 'no header injection');
  assert.match(headers, /^From: "Brigade" <gym@example.test>$/m);
  assert.match(headers, /^Subject: =\?UTF-8\?B\?/m);
  const parts = data.split('base64\n\n').slice(1).map((p) => Buffer.from(p.split('\n--')[0], 'base64').toString());
  assert.equal(parts[0], 'Tap here: https://x.test/Login#reset=abc');
  assert.match(parts[1], /^<p>Tap/);
});
test('email: refuses to send a password without encryption', async () => {
  const f = await fakeServer({ noTls: true });
  await assert.rejects(smtpSend(f.connect, base(f)), /encryption/);
  f.stop();
  assert.ok(!f.log.some((l) => l.line?.startsWith('AUTH')));
});
test('email: stops if data arrives before encryption starts', async () => {
  const f = await fakeServer({ inject: true });
  await assert.rejects(smtpSend(f.connect, base(f)), /unexpected data/);
  f.stop();
});
test('email: clear errors, and the password never appears in them', async () => {
  for (const [over, re] of [[{ auth: '535 no s3cret\r\n' }, /not accepted/], [{ rcpt: '550 no\r\n' }, /recipient/], [{ accept: '554 spam\r\n' }, /refused the message/]]) {
    const f = await fakeServer(over);
    await assert.rejects(smtpSend(f.connect, base(f)), (e) => re.test(e.message) && !e.message.includes('s3cret'));
    f.stop();
  }
  const f = await fakeServer({ silent: true });
  await assert.rejects(smtpSend(f.connect, { ...base(f), timeoutMs: 300 }), /too long/);
  f.stop();
});
test('email: bad addresses never reach the server', () => {
  for (const v of ['', 'x', 'a@b', 'a@b.test>\r\nRCPT TO:<c@d.test', 'a b@c.test', null]) assert.throws(() => parseAddress(v));
  assert.deepEqual(parseAddress('Bri "x" <a@b.test>'), { address: 'a@b.test', name: 'Bri x' });
  const m = buildMessage({ from: parseAddress('a@b.test'), to: [parseAddress('c@d.test')], subject: 'x', html: 'y'.repeat(500) });
  assert.ok(m.split('\r\n').every((l) => l.length <= 998));
});
