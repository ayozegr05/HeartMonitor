/**
 * Minimal OAuth 1.0a (HMAC-SHA1) signer in pure TypeScript — Garmin's
 * token exchange (`preauthorized` + `exchange/user/2.0`) still speaks
 * OAuth1 and Hermes ships no crypto primitives, so SHA-1 is implemented
 * here. Verified against the RFC 2202 HMAC-SHA1 vectors and the RFC 5849
 * signature example in `__tests__/oauth1.test.ts`.
 */

const utf8 = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const first = s.charCodeAt(i);
    let c = first;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const second = s.charCodeAt(i + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        i++;
        c = 0x10000 + ((c & 0x3ff) << 10) + (second & 0x3ff);
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63),
        );
      } else {
        // WHATWG TextEncoder replaces an unpaired surrogate with U+FFFD.
        out.push(0xef, 0xbf, 0xbd);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0xfffd;
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
};

function sha1(bytes: number[]): number[] {
  const msg = bytes.slice();
  const bitLen = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 7; i >= 0; i--) msg.push((bitLen / 2 ** (i * 8)) & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Array<number>(80);
  for (let i = 0; i < msg.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] =
        (msg[i + t * 4] << 24) |
        (msg[i + t * 4 + 1] << 16) |
        (msg[i + t * 4 + 2] << 8) |
        msg[i + t * 4 + 3];
    }
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      const k = Math.floor(t / 20);
      const f =
        k === 0
          ? (b & c) | (~b & d)
          : k === 2
            ? (b & c) | (b & d) | (c & d)
            : b ^ c ^ d;
      const kv = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6][k];
      const tmp =
        ((((a << 5) | (a >>> 27)) + f + e + kv + w[t]) & 0xffffffff) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].flatMap((h) => [
    (h >>> 24) & 0xff,
    (h >>> 16) & 0xff,
    (h >>> 8) & 0xff,
    h & 0xff,
  ]);
}

export function hmacSha1(keyInput: string | number[], message: string): number[] {
  let key = typeof keyInput === 'string' ? utf8(keyInput) : keyInput.slice();
  if (key.length > 64) key = sha1(key);
  const ipad = new Array<number>(64).fill(0x36);
  const opad = new Array<number>(64).fill(0x5c);
  for (let i = 0; i < key.length; i++) {
    ipad[i] ^= key[i];
    opad[i] ^= key[i];
  }
  return sha1(opad.concat(sha1(ipad.concat(utf8(message)))));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Of(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : null;
    const c = i + 2 < bytes.length ? bytes[i + 2] : null;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === null ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === null ? '=' : B64[c & 63];
  }
  return out;
}

/** RFC 3986 percent-encoding — stricter than encodeURIComponent. */
export const pct = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export interface Oauth1Consumer {
  key: string;
  secret: string;
}
export interface Oauth1Token {
  key: string;
  secret: string;
}

const randomNonce = (): string => {
  const bytes = new Array<number>(16);
  const cryptoApi = (
    globalThis as {
      crypto?: { getRandomValues?: (target: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (cryptoApi?.getRandomValues) {
    const secure = cryptoApi.getRandomValues(new Uint8Array(16));
    for (let i = 0; i < secure.length; i++) bytes[i] = secure[i];
  } else {
    // Older Hermes runtimes have no Web Crypto. OAuth nonce uniqueness is
    // still preserved as a fallback, but secure randomness is preferred.
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Computes the OAuth1 parameter set (including `oauth_signature`) for a
 * request. Query params already in `url` join the signature base; the
 * caller can place the result in the `Authorization: OAuth …` header or
 * in the query string — Garmin accepts both.
 */
export function oauth1Authorize(
  method: string,
  url: string,
  consumer: Oauth1Consumer,
  token?: Oauth1Token,
  fixed?: { nonce: string; timestamp: number },
): Record<string, string> {
  const qIndex = url.indexOf('?');
  const base = qIndex < 0 ? url : url.slice(0, qIndex);
  const pairs: [string, string][] = [];
  if (qIndex >= 0) {
    for (const part of url.slice(qIndex + 1).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      pairs.push(
        eq < 0
          ? [decodeURIComponent(part), '']
          : [
              decodeURIComponent(part.slice(0, eq)),
              decodeURIComponent(part.slice(eq + 1)),
            ],
      );
    }
  }

  const params: Record<string, string> = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: fixed?.nonce ?? randomNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(
      fixed?.timestamp ?? Math.floor(Date.now() / 1000),
    ),
    oauth_version: '1.0',
  };
  if (token) params.oauth_token = token.key;

  for (const [k, v] of pairs) params[k] = v;

  const normalized = Object.keys(params)
    .map((k) => [pct(k), pct(params[k])] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${pct(base)}&${pct(normalized)}`;
  const signingKey = `${pct(consumer.secret)}&${pct(token?.secret ?? '')}`;
  params.oauth_signature = base64Of(hmacSha1(signingKey, baseString));
  return params;
}

/** `Authorization: OAuth k="v",…` header value. */
export function oauth1Header(params: Record<string, string>): string {
  const parts = Object.keys(params)
    .filter((k) => k.startsWith('oauth_'))
    .sort()
    .map((k) => `${k}="${pct(params[k])}"`);
  return `OAuth ${parts.join(',')}`;
}
