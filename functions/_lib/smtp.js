// Sends one email through a mailbox's SMTP server (Mailwish, or any other).
// The connection is always encrypted before the password is sent.
const enc = new TextEncoder();
const b64 = (text) => btoa(String.fromCharCode(...enc.encode(text)));
const wrap = (s) => s.replace(/.{76}/g, '$&\r\n');
const oneLine = (s) => String(s ?? '').replace(/[\r\n\0]+/g, ' ').trim();
const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const ADDRESS = /^[^\s<>"(),:;@]+@[^\s<>"(),:;@]+\.[^\s<>"(),:;@]+$/;

// "Name <a@b.c>" or "a@b.c"
export function parseAddress(v) {
  const text = oneLine(v);
  const m = /^(.*)<([^<>]+)>$/.exec(text);
  const address = (m ? m[2] : text).trim();
  if (!ADDRESS.test(address)) throw new Error('That email address does not look right.');
  return { address, name: m ? m[1].replace(/["\\]/g, '').trim() : '' };
}

export function buildMessage({ from, to, subject, html, now = new Date(), id = crypto.randomUUID() }) {
  const boundary = `b_${id}`;
  const show = (a) => (a.name ? `${/^[\x20-\x7e]*$/.test(a.name) ? `"${a.name}"` : word(a.name)} <${a.address}>` : a.address);
  const text = String(html || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2: $1')
    .replace(/<(br|\/p|\/h\d|\/div|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64(body))}\r\n`;
  return [
    `From: ${show(from)}`, `To: ${to.map(show).join(', ')}`, `Subject: ${word(oneLine(subject))}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${id}@${from.address.split('@')[1]}>`,
    'MIME-Version: 1.0', 'Auto-Submitted: auto-generated', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    part('text/plain', text) + part('text/html', String(html || '')) + `--${boundary}--`,
  ].join('\r\n');
}

// `connect` is cloudflare:sockets' connect; tests pass their own.
export async function smtpSend(connect, { host, port = 587, user, pass, from, to, subject, html, timeoutMs = 15000 }) {
  const sender = parseAddress(from);
  const people = (Array.isArray(to) ? to : [to]).map(parseAddress);
  const message = buildMessage({ from: sender, to: people, subject, html });
  let socket = connect({ hostname: host, port: Number(port) }, { secureTransport: Number(port) === 465 ? 'on' : 'starttls', allowHalfOpen: false });
  let reader; let writer; let buffer = '';
  const open = () => { reader = socket.readable.getReader(); writer = socket.writable.getWriter(); buffer = ''; };
  const dec = new TextDecoder();
  const reply = async () => {
    const lines = [];
    for (;;) {
      const i = buffer.indexOf('\n');
      if (i >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
        lines.push(line);
        if (/^\d{3}( |$)/.test(line)) return { code: Number(line.slice(0, 3)), lines };
      } else {
        const { value, done } = await reader.read();
        if (done) throw new Error('The mail server hung up.');
        buffer += dec.decode(value, { stream: true });
      }
    }
  };
  const say = async (line, ok, what) => {
    if (line !== null) await writer.write(enc.encode(`${line}\r\n`));
    const r = await reply();
    if (!ok.includes(r.code)) {
      const err = new Error(`${what} (${r.code})`); err.code = r.code; throw err;
    }
    return r;
  };
  const talk = async () => {
    open();
    const name = sender.address.split('@')[1];
    await say(null, [220], 'The mail server refused the connection');
    let hello = await say(`EHLO ${name}`, [250], 'The mail server refused the connection');
    if (Number(port) !== 465) {
      if (!hello.lines.some((l) => /STARTTLS/i.test(l))) throw new Error('The mail server does not offer encryption.');
      await say('STARTTLS', [220], 'The mail server could not start encryption');
      // Anything sent before encryption started can't be trusted.
      if (buffer) throw new Error('The mail server sent unexpected data.');
      reader.releaseLock(); writer.releaseLock();
      socket = socket.startTls();
      open();
      hello = await say(`EHLO ${name}`, [250], 'The mail server refused the connection');
    }
    await say(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235], 'The mailbox email or password was not accepted');
    await say(`MAIL FROM:<${sender.address}>`, [250], 'The mail server refused the sender');
    for (const p of people) await say(`RCPT TO:<${p.address}>`, [250, 251], 'The mail server refused the recipient');
    await say('DATA', [354], 'The mail server refused the message');
    await say(`${message.replace(/^\./gm, '..')}\r\n.`, [250], 'The mail server refused the message');
    // Accepted: a messy goodbye doesn't matter.
    await writer.write(enc.encode('QUIT\r\n')).catch(() => {});
  };
  let timer;
  const work = talk();
  work.catch(() => {});
  try {
    await Promise.race([work, new Promise((_, no) => { timer = setTimeout(() => no(new Error('The mail server took too long.')), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
    try { const c = socket.close(); c?.catch?.(() => {}); } catch { /* already closed */ }
  }
}
