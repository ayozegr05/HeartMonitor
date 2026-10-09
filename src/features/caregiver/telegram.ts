/**
 * Telegram caregiver channel — the phone talks to the Bot API directly
 * over HTTPS. No backend, no account service: the bot token + chat_id
 * live in local settings, matching the local-first architecture.
 *
 * The fetch function is injectable so tests can assert the request.
 */

export interface TelegramResult {
  ok: boolean;
  error?: string;
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchLikeResponse>;

export async function sendTelegramMessage(
  botToken: string | null,
  chatId: string | null,
  text: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<TelegramResult> {
  if (!botToken || !chatId) return { ok: false, error: 'sin configurar' };
  try {
    const res = await fetchFn(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
    );
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (res.ok && data?.ok) return { ok: true };
    return {
      ok: false,
      error: data?.description ?? `HTTP ${res.status}`,
    };
  } catch {
    return { ok: false, error: 'sin conexión' };
  }
}
