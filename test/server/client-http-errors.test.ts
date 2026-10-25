import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LinaClient } from '../../src/shared/client.js';

let requests = 0;
const server = createServer((req, res) => {
  requests++;
  if (req.url === '/api/health') {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>Gateway unavailable</html>');
  } else if (req.url === '/api/sessions') {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Sign in again');
  } else if (req.url === '/api/settings') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>This is another service</html>');
  } else {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
  }
});
let client: LinaClient;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = new LinaClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'test-only' });
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

describe('HTTP errors from a tunnel or proxy', () => {
  it('retains the gateway status for an HTML failure response', async () => {
    await expect(client.health()).rejects.toMatchObject({ status: 502, message: 'HTTP 502 Bad Gateway' });
  });
  it('retains the unauthorized status for a plain-text sign-in failure', async () => {
    await expect(client.sessions()).rejects.toMatchObject({ status: 401, message: 'HTTP 401 Unauthorized' });
  });
  it('reports an invalid successful response without a JSON parser exception', async () => {
    await expect(client.getSettings()).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
  });
  it('never replays a mutation because its error response is not JSON', async () => {
    const before = requests;
    await expect(client.control('test-session', 'cancel')).rejects.toMatchObject({ status: 403 });
    expect(requests - before).toBe(1);
  });
});
