import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  base64Of,
  hmacSha1,
  oauth1Authorize,
  oauth1Header,
  pct,
  type Oauth1Consumer,
} from './oauth1';

/**
 * Unofficial Garmin Connect client — same flow the Garmin Connect
 * mobile app runs: SSO sign-in page → ticket → OAuth1 preauthorized →
 * OAuth2 bearer. Based on the public behaviour documented by the OSS
 * ecosystem (garth / python-garminconnect / garmin-connect JS).
 *
 * The password is used once to mint tokens and is NEVER stored — only
 * the oauth1+oauth2 pair is persisted in AsyncStorage. When the OAuth2
 * access token expires we re-exchange the long-lived OAuth1 token;
 * only when that is revoked does the user need to log in again.
 *
 * Caveat: private API — Garmin can change any step without notice.
 * Every parser in garminApi.ts is defensive for that reason.
 */

const SSO_ORIGIN = 'https://sso.garmin.com';
const SSO_EMBED = `${SSO_ORIGIN}/sso/embed`;
const SIGNIN_URL = `${SSO_ORIGIN}/sso/signin`;
const GC_MODERN = 'https://connect.garmin.com/modern';
const API = 'https://connectapi.garmin.com';
const OAUTH_URL = `${API}/oauth-service/oauth`;
const CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';

const UA_APP = 'com.garmin.android.apps.connectmobile';
const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';

const STORE_KEY = 'garminConnect.tokens.v1';

interface StoredTokens {
  oauth1: { token: string; secret: string };
  oauth2: {
    access_token: string;
    refresh_token?: string;
    /** Unix seconds when the access token stops working. */
    expiresAt: number;
    refreshExpiresAt?: number;
  };
  displayName: string;
  /** Account email — kept only to show who is linked in Settings. */
  email: string;
}

let tokens: StoredTokens | null = null;

const qs = (o: Record<string, string | number | boolean>) =>
  Object.entries(o)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const parseFormBody = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
  }
  return out;
};

export class GarminAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'credentials'
      | 'mfa'
      | 'locked'
      | 'network'
      | 'reauth' = 'credentials',
  ) {
    super(message);
    this.name = 'GarminAuthError';
  }
}

async function fetchConsumer(): Promise<Oauth1Consumer> {
  const res = await fetch(CONSUMER_URL, { headers: { 'User-Agent': UA_BROWSER } });
  if (!res.ok) throw new GarminAuthError('No se pudo obtener el consumer OAuth', 'network');
  const j = (await res.json()) as { consumer_key: string; consumer_secret: string };
  return { key: j.consumer_key, secret: j.consumer_secret };
}

/** SSO dance: embed → signin page (csrf) → credentials POST → ticket. */
async function fetchTicket(
  email: string,
  password: string,
): Promise<string> {
  let cookie = '';
  const captureCookies = (res: Response) => {
    const raw = res.headers.get('set-cookie');
    if (!raw) return;
    const next = raw
      .split(/,(?=[^;,]+=)/)
      .map((part) => part.split(';', 1)[0].trim())
      .filter(Boolean);
    const jar = new Map(
      cookie
        .split(';')
        .map((part) => part.trim().split('=', 2))
        .filter(([name, value]) => name && value)
        .map(([name, value]) => [name, `${name}=${value}`]),
    );
    for (const entry of next) {
      const name = entry.slice(0, entry.indexOf('='));
      if (name) jar.set(name, entry);
    }
    cookie = [...jar.values()].join('; ');
  };
  const cookieHeaders = (): Record<string, string> =>
    cookie ? { Cookie: cookie } : {};

  // Step 1: seeds the SSO session cookie.
  const step1 = `${SSO_EMBED}?${qs({ clientId: 'GarminConnect', locale: 'en', service: GC_MODERN })}`;
  captureCookies(
    await fetch(step1, {
      headers: { 'User-Agent': UA_BROWSER, ...cookieHeaders() },
    }),
  );

  // Step 2: the sign-in widget page carries the _csrf hidden field.
  const step2 = `${SIGNIN_URL}?${qs({
    id: 'gauth-widget',
    embedWidget: 'true',
    locale: 'en',
    gauthHost: SSO_EMBED,
  })}`;
  const signinPage = await fetch(step2, {
    headers: { 'User-Agent': UA_BROWSER, ...cookieHeaders() },
  });
  captureCookies(signinPage);
  const page = await signinPage.text();
  const csrf = /name="_csrf"\s+value="(.+?)"/.exec(page)?.[1];
  if (!csrf) throw new GarminAuthError('Garmin cambió la página de login (sin csrf)', 'network');

  // Step 3: credentials. The embed variant answers with an HTML page
  // whose next redirect URL carries ?ticket=… instead of a 302.
  const signinParams = qs({
    id: 'gauth-widget',
    embedWidget: 'true',
    clientId: 'GarminConnect',
    locale: 'en',
    gauthHost: SSO_EMBED,
    service: SSO_EMBED,
    source: SSO_EMBED,
    redirectAfterAccountLoginUrl: SSO_EMBED,
    redirectAfterAccountCreationUrl: SSO_EMBED,
  });
  const body = `username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&embed=true&_csrf=${encodeURIComponent(csrf)}`;
  const res = await fetch(`${SIGNIN_URL}?${signinParams}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Dnt: '1',
      Origin: SSO_ORIGIN,
      Referer: step2,
      'User-Agent': UA_BROWSER,
      ...cookieHeaders(),
    },
    body,
  });
  captureCookies(res);
  const html = await res.text();

  const locked = /var status\s*=\s*"([^"]*)"/.exec(html)?.[1];
  if (locked) {
    throw new GarminAuthError(
      'Cuenta bloqueada — desbloquéala entrando en connect.garmin.com',
      'locked',
    );
  }
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  if (title.includes('Update Phone Number')) {
    throw new GarminAuthError(
      'Garmin pide confirmar el teléfono — entra en connect.garmin.com una vez',
      'locked',
    );
  }
  if (/MFA|mfa/i.test(title) || /name="mfa-code"/.test(html)) {
    throw new GarminAuthError(
      'Tu cuenta usa verificación en dos pasos (MFA) — desactívala para conectar',
      'mfa',
    );
  }
  const ticket = /ticket=([^'"&<\s]+)/.exec(html)?.[1];
  if (!ticket) {
    throw new GarminAuthError('Login rechazado — revisa email y contraseña', 'credentials');
  }
  return ticket;
}

async function fetchOauth1(
  consumer: Oauth1Consumer,
  ticket: string,
): Promise<{ token: string; secret: string }> {
  const url = `${OAUTH_URL}/preauthorized?${qs({
    ticket,
    'login-url': SSO_EMBED,
    'accepts-mfa-tokens': 'true',
  })}`;
  const params = oauth1Authorize('GET', url, consumer);
  const res = await fetch(url, {
    headers: { Authorization: oauth1Header(params), 'User-Agent': UA_APP },
  });
  const text = await res.text();
  if (!res.ok) throw new GarminAuthError(`OAuth1 rechazado (${res.status})`, 'reauth');
  const parsed = parseFormBody(text);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new GarminAuthError('Respuesta OAuth1 inesperada', 'reauth');
  }
  return { token: parsed.oauth_token, secret: parsed.oauth_token_secret };
}

async function exchangeOauth2(
  consumer: Oauth1Consumer,
  oauth1: { token: string; secret: string },
): Promise<StoredTokens['oauth2']> {
  // oauth-1.0a puts the oauth_* params on the query of this POST.
  const params = oauth1Authorize('POST', `${OAUTH_URL}/exchange/user/2.0`, consumer, {
    key: oauth1.token,
    secret: oauth1.secret,
  });
  const url = `${OAUTH_URL}/exchange/user/2.0?${qs(params)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA_APP, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new GarminAuthError(`Exchange OAuth2 rechazado (${res.status})`, 'reauth');
  const j = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    refresh_token_expires_in?: number;
  };
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expiresAt: now + j.expires_in,
    refreshExpiresAt: j.refresh_token_expires_in
      ? now + j.refresh_token_expires_in
      : undefined,
  };
}

export async function garminLogin(
  email: string,
  password: string,
): Promise<string> {
  const consumer = await fetchConsumer();
  const ticket = await fetchTicket(email.trim(), password);
  const oauth1 = await fetchOauth1(consumer, ticket);
  const oauth2 = await exchangeOauth2(consumer, oauth1);

  tokens = { oauth1, oauth2, displayName: '', email: email.trim() };
  let displayName = email.trim();
  try {
    const prof = (await garminGet('/userprofile-service/socialProfile')) as {
      displayName?: string;
    };
    if (prof.displayName) displayName = prof.displayName;
  } catch {
    // displayName is cosmetic — email is a fine fallback.
  }
  tokens = { ...tokens, displayName };
  await saveTokens();
  return displayName;
}

async function saveTokens(): Promise<void> {
  if (tokens) await AsyncStorage.setItem(STORE_KEY, JSON.stringify(tokens));
}

export async function loadGarminTokens(): Promise<StoredTokens | null> {
  if (tokens) return tokens;
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    tokens = raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    tokens = null;
  }
  return tokens;
}

export async function garminConnectedEmail(): Promise<string | null> {
  return (await loadGarminTokens())?.email ?? null;
}

export async function garminLogout(): Promise<void> {
  tokens = null;
  await AsyncStorage.removeItem(STORE_KEY);
}

/** Fresh bearer token; re-exchanges the OAuth1 credential on expiry. */
async function bearer(): Promise<string> {
  const t = await loadGarminTokens();
  if (!t) throw new GarminAuthError('No hay cuenta Garmin conectada', 'reauth');
  if (t.oauth2.expiresAt - 60 > Date.now() / 1000) return t.oauth2.access_token;
  const consumer = await fetchConsumer();
  const fresh = await exchangeOauth2(consumer, t.oauth1);
  tokens = { ...t, oauth2: fresh };
  await saveTokens();
  return fresh.access_token;
}

export async function garminGet(path: string): Promise<unknown> {
  let auth = await bearer();
  let res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${auth}`, 'User-Agent': UA_APP },
  });
  if (res.status === 401) {
    const t = await loadGarminTokens();
    if (!t) throw new GarminAuthError('Sesión Garmin caducada', 'reauth');
    const consumer = await fetchConsumer();
    const fresh = await exchangeOauth2(consumer, t.oauth1);
    tokens = { ...t, oauth2: fresh };
    await saveTokens();
    auth = fresh.access_token;
    res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${auth}`, 'User-Agent': UA_APP },
    });
  }
  if (res.status === 404) return null; // day without data is normal
  if (!res.ok) throw new Error(`Garmin API ${res.status} ${path}`);
  return res.json();
}

// Re-exports kept local so auth helpers stay tree-shakeable for tests.
export { base64Of, hmacSha1, pct };
