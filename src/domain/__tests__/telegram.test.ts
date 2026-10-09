import {
  sendTelegramMessage,
  type FetchLike,
} from '@/features/caregiver/telegram';

const okFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true }),
});

describe('sendTelegramMessage', () => {
  it('posts to the Bot API with the chat_id and text', async () => {
    let calledUrl = '';
    let calledBody = '';
    const spy: FetchLike = async (url, init) => {
      calledUrl = url;
      calledBody = init.body;
      return okFetch(url, init);
    };
    const res = await sendTelegramMessage('TOKEN123', '42', 'hola', spy);
    expect(res.ok).toBe(true);
    expect(calledUrl).toBe('https://api.telegram.org/botTOKEN123/sendMessage');
    expect(JSON.parse(calledBody)).toEqual({ chat_id: '42', text: 'hola' });
  });

  it('reports the API description on rejection', async () => {
    const bad: FetchLike = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'chat not found' }),
    });
    const res = await sendTelegramMessage('T', 'C', 'x', bad);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('chat not found');
  });

  it('refuses to send without config', async () => {
    const res = await sendTelegramMessage(null, '42', 'x', okFetch);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('sin configurar');
  });

  it('maps network failures to a friendly error', async () => {
    const down: FetchLike = async () => {
      throw new Error('offline');
    };
    const res = await sendTelegramMessage('T', 'C', 'x', down);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('sin conexión');
  });
});
