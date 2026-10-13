import {
    base64Of,
    hmacSha1,
    oauth1Authorize,
    oauth1Header,
    pct,
} from '@/features/garmin/oauth1';

const hex = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

describe('hmacSha1 (RFC 2202 vectors)', () => {
  it('case 1 — 20×0x0b key, "Hi There"', () => {
    const key = String.fromCharCode(0x0b).repeat(20);
    expect(hex(hmacSha1(key, 'Hi There'))).toBe(
      'b617318655057264e28bc0b6fb378c8ef146be00',
    );
  });

  it('case 2 — "Jefe", "what do ya want for nothing?"', () => {
    expect(hex(hmacSha1('Jefe', 'what do ya want for nothing?'))).toBe(
      'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79',
    );
  });

  it('case 6 — key longer than the block size is hashed first', () => {
    const key = new Array<number>(80).fill(0xaa); // raw bytes, not utf8
    expect(
      hex(
        hmacSha1(
          key,
          'Test Using Larger Than Block-Size Key - Hash Key First',
        ),
      ),
    ).toBe('aa4ae5e15272d00e95705637ce8a3b55ed402112');
  });
});

describe('pct', () => {
  it('leaves unreserved chars alone', () => {
    expect(pct('abcXYZ019-._~')).toBe('abcXYZ019-._~');
  });

  it('escapes RFC 3986 reserved chars encodeURIComponent misses', () => {
    expect(pct("!'()*")).toBe('%21%27%28%29%2A');
    expect(pct('a b&c=d')).toBe('a%20b%26c%3Dd');
  });
});

describe('oauth1Authorize (RFC 5849 §3.4.1 example)', () => {
  it('reproduces the reference signature', () => {
    const params = oauth1Authorize(
      'GET',
      'http://photos.example.net/photos?file=vacation.jpg&size=original',
      { key: 'dpf43f3p2l4k3l03', secret: 'kd94hf93k423kf44' },
      { key: 'nnch734d00sl2jdk', secret: 'pfkkdhi9sl3r4s00' },
      { nonce: 'kllo9940pd9333jh', timestamp: 1191242096 },
    );
    expect(params.oauth_signature).toBe('tR3+Ty81lMeYAr/Fid0kMTYa/WM=');
    expect(params.oauth_nonce).toBe('kllo9940pd9333jh');
    expect(params.oauth_timestamp).toBe('1191242096');
    expect(params.oauth_token).toBe('nnch734d00sl2jdk');
  });

  it('signs without a token (request-token flow)', () => {
    const params = oauth1Authorize(
      'GET',
      'https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=ST-123',
      { key: 'ck', secret: 'cs' },
      undefined,
      { nonce: 'n', timestamp: 1700000000 },
    );
    expect(params.oauth_token).toBeUndefined();
    expect(typeof params.oauth_signature).toBe('string');
    expect(params.oauth_signature!.length).toBeGreaterThan(0);
  });
});

describe('oauth1Header', () => {
  it('only ships oauth_* params, quoted and sorted', () => {
    const header = oauth1Header({
      oauth_signature: 'sig',
      oauth_nonce: 'abc',
      ticket: 'ST-not-included',
    });
    expect(header.startsWith('OAuth ')).toBe(true);
    expect(header).toContain('oauth_nonce="abc"');
    expect(header).toContain('oauth_signature="sig"');
    expect(header).not.toContain('ticket');
  });
});

describe('base64Of', () => {
  it('pads short inputs', () => {
    expect(base64Of([0x61])).toBe('YQ==');
    expect(base64Of([0x61, 0x62])).toBe('YWI=');
    expect(base64Of([0x61, 0x62, 0x63])).toBe('YWJj');
  });
});
