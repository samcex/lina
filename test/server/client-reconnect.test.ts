import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinaClient } from '../../src/shared/client.js';

afterEach(() => vi.unstubAllGlobals());
describe('client reads after a daemon restart', () => {
  it('retries a disconnected read once on a fresh connection', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('socket closed')).mockResolvedValueOnce(new Response(JSON.stringify([])));
    vi.stubGlobal('fetch', fetch);
    const client = new LinaClient({ baseUrl: 'http://127.0.0.1:7077', token: 'test' });
    expect(await client.previews('session')).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('refreshes the daemon address before retrying a disconnected read', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('connection refused')).mockResolvedValueOnce(new Response(JSON.stringify([])));
    vi.stubGlobal('fetch', fetch);
    const client = new LinaClient({ baseUrl: 'http://127.0.0.1:7077', token: 'old', refresh: async () => ({ baseUrl: 'http://127.0.0.1:7078', token: 'new' }) });
    expect(await client.sessions()).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:7077/api/sessions', 'http://127.0.0.1:7078/api/sessions']);
    expect(fetch.mock.calls[1][1].headers.authorization).toBe('Bearer new');
  });
  it('never replays a mutation or retries an HTTP permission error', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('socket closed'));
    vi.stubGlobal('fetch', fetch);
    const client = new LinaClient({ baseUrl: 'http://127.0.0.1:7077', token: 'test' });
    await expect(client.startPreview('session', { command: 'npm run dev' })).rejects.toThrow('socket closed');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    await expect(client.previews('session')).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
