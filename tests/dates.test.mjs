import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const inZone = (TZ, iso) => execFileSync(process.execPath, ['--input-type=module', '-e', `
  const RealDate = Date; const fixed = RealDate.parse('${iso}');
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
  const p = await import('${path.join(ROOT, 'src/lib/programs.js')}');
  const d = p.gymToday();
  console.log([p.todayKey(), p.toKey(d), d.getHours(), p.addDays(p.todayKey(), -7)].join(' '));`], { env: { ...process.env, TZ } }).toString().trim();

test('dates: today is the gym day wherever the phone is', () => {
  for (const TZ of ['America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC', 'Pacific/Honolulu']) {
    assert.equal(inZone(TZ, '2026-11-26T01:30:00Z'), '2026-11-25 2026-11-25 0 2026-11-18', `${TZ}, 8:30 PM at the gym`);
    assert.equal(inZone(TZ, '2026-11-25T05:30:00Z'), '2026-11-25 2026-11-25 0 2026-11-18', `${TZ}, 12:30 AM at the gym`);
    assert.equal(inZone(TZ, '2026-03-08T07:30:00Z'), '2026-03-08 2026-03-08 0 2026-03-01', `${TZ}, clock change night`);
  }
});

test('dates: no screen takes today from the phone', () => {
  const files = [];
  const walk = (d) => readdirSync(d).forEach((f) => { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.jsx?$/.test(f)) files.push(p); });
  walk(path.join(ROOT, 'src'));
  const banned = /format\(new Date\(\), ?["']yyyy-MM-dd|new Date\(\)\.toLocaleDateString\(["'](sv-SE|en-CA)|toISOString\(\)\.(split|slice\(0, ?10|substring\(0, ?10)|\bisToday\((?!\))/;
  const ok = /src\/(pages\/(BusinessHub|CRM|Settings)\.jsx|lib\/classes\.js)$/; // hidden pages, a file name, and UTC math on a key
  const hits = files.filter((f) => !ok.test(f)).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => [`${path.relative(ROOT, f)}:${i + 1}`, l]).filter(([, l]) => banned.test(l)).map(([w]) => w));
  assert.deepEqual(hits, []);
});
