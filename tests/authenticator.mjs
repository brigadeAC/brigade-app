// A pretend phone: makes real ES256 passkeys and signs with them.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64 = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => createHash('sha256').update(b).digest();
const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
const cbor = (v) => {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
};

export function makeAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const self = { id: b64(randomBytes(16)) };
  let handle;
  const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const authData = (rp, uv, extra, at) => Buffer.concat([sha(rp), Buffer.from([0x01 | (uv ? 0x04 : 0) | (at ? 0x40 : 0)]), Buffer.alloc(4), extra]);
  const wrap = (response) => ({ id: self.id, rawId: self.id, type: 'public-key', clientExtensionResults: {}, response });
  self.create = (o, { origin, rp, uv = true }) => {
    handle = o.user?.id;
    const id = Buffer.from(self.id, 'base64url');
    const ad = authData(rp, uv, Buffer.concat([Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]), true);
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
    return wrap({ clientDataJSON: b64(clientData('webauthn.create', o.challenge, origin)), attestationObject: b64(att), transports: ['internal'] });
  };
  self.get = (o, { origin, rp, uv = true }) => {
    const cd = clientData('webauthn.get', o.challenge, origin);
    const ad = authData(rp, uv, Buffer.alloc(0), false);
    return wrap({ clientDataJSON: b64(cd), authenticatorData: b64(ad), userHandle: handle, signature: b64(sign('sha256', Buffer.concat([ad, sha(cd)]), privateKey)) });
  };
  return self;
}
