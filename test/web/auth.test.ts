import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrap, forgetToken } from '../../web/src/lib/auth.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
}
function page(hostname: string, hash = '') {
  const location = { hostname, hash, search: '', pathname: '/' };
  vi.stubGlobal('window', { location });
  vi.stubGlobal('history', { replaceState: vi.fn((_state, _title, next: string) => { location.hash = next.includes('#') ? next.slice(next.indexOf('#')) : ''; }) });
  vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('localStorage', storage());
  return location;
}
afterEach(() => vi.unstubAllGlobals());

describe('mobile token bootstrap', () => {
  it.each(['127.0.0.1', 'localhost'])('survives an installed-app relaunch on %s', (host) => {
    const location = page(host, '#token=secret&session=ses1');
    expect(bootstrap()).toEqual({ token: 'secret', session: 'ses1', fixture: false });
    expect(location.hash).toBe('#s=ses1');
    expect(localStorage.getItem('lina.token')).toBe('secret');
    vi.stubGlobal('sessionStorage', storage());
    location.hash = '';
    expect(bootstrap().token).toBe('secret');
  });
  it.each(['example.com', '127.0.0.1.evil.com', 'localhost.evil.com', '::1'])('never reads or persists a token on %s', (host) => {
    const location = page(host, '#token=fresh');
    localStorage.setItem('lina.token', 'old');
    vi.mocked(localStorage.setItem).mockClear();
    expect(bootstrap().token).toBe('fresh');
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem).not.toHaveBeenCalled();
    location.hash = '';
    expect(bootstrap().token).toBe('fresh'); // sessionStorage still works.
    vi.stubGlobal('sessionStorage', storage());
    expect(bootstrap().token).toBeNull();
  });
  it('updates an old persistent token from the fragment and migrates a session token', () => {
    page('localhost', '#token=new');
    localStorage.setItem('lina.token', 'old');
    expect(bootstrap().token).toBe('new');
    expect(localStorage.getItem('lina.token')).toBe('new');
    localStorage.removeItem('lina.token');
    expect(bootstrap().token).toBe('new');
    expect(localStorage.getItem('lina.token')).toBe('new');
  });
  it('forgets both stores so a fresh launch has no token', () => {
    page('localhost', '#token=secret');
    bootstrap();
    forgetToken();
    expect(sessionStorage.getItem('lina.token')).toBeNull();
    expect(localStorage.getItem('lina.token')).toBeNull();
    expect(bootstrap().token).toBeNull();
  });
  it('can bootstrap and forget when browser storage is disabled', () => {
    page('localhost', '#token=secret');
    const broken = { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); }, removeItem: () => { throw Error('blocked'); } };
    vi.stubGlobal('sessionStorage', broken);
    vi.stubGlobal('localStorage', broken);
    expect(bootstrap().token).toBe('secret');
    expect(() => forgetToken()).not.toThrow();
    expect(bootstrap().token).toBeNull();
  });
});
