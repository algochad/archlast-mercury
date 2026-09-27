import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearLegacyPersistedAuth,
  getAccessToken,
  getCsrfToken,
  getRefreshToken,
  hydrateRefreshTokenStorage,
  setAccessToken,
  setRefreshToken,
} from './authToken';

function clearCsrfCookies(): void {
  // jsdom: expire each cookie so the store is empty between tests.
  document.cookie = 'mercury_csrf=; Max-Age=0; path=/';
  document.cookie = 'paracord_csrf=; Max-Age=0; path=/';
}

describe('authToken', () => {
  beforeEach(() => {
    localStorage.clear();
    clearCsrfCookies();
    setAccessToken(null);
    setRefreshToken(null);
  });

  afterEach(() => {
    clearCsrfCookies();
  });

  it('stores access token in memory only', () => {
    setAccessToken('  access-token  ');
    expect(getAccessToken()).toBe('access-token');
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('stores and clears refresh token in memory for same-origin API', () => {
    setRefreshToken('refresh-token');
    expect(getRefreshToken()).toBe('refresh-token');

    setRefreshToken(null);
    expect(getRefreshToken()).toBeNull();
  });

  it('hydrates refresh token from legacy localStorage in web mode', async () => {
    localStorage.setItem('paracord:refresh-token', 'hydrated-token');

    await hydrateRefreshTokenStorage();

    expect(getRefreshToken()).toBe('hydrated-token');
  });

  it('never persists the refresh token at rest in web mode', () => {
    setRefreshToken('refresh-token');

    expect(getRefreshToken()).toBe('refresh-token');
    // The refresh token must live in memory only — no localStorage copy that
    // an XSS payload could exfiltrate for persistent account takeover.
    expect(localStorage.getItem('paracord:auth:refresh-token')).toBeNull();
    expect(localStorage.getItem('paracord:refresh-token')).toBeNull();
  });

  it('purges any wrapped refresh token left by older web builds', async () => {
    localStorage.setItem(
      'paracord:auth:refresh-token',
      JSON.stringify({ iv: 'aaaa', ct: 'bbbb' }),
    );

    await hydrateRefreshTokenStorage();

    expect(localStorage.getItem('paracord:auth:refresh-token')).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('clears legacy auth keys without clearing refresh token', () => {
    localStorage.setItem('token', 'legacy-token');
    localStorage.setItem('auth-storage', '{"state":{}}');
    setRefreshToken('refresh-token');

    clearLegacyPersistedAuth();

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('auth-storage')).toBeNull();
    expect(getRefreshToken()).toBe('refresh-token');
  });

  describe('getCsrfToken', () => {
    it('returns mercury_csrf when set', () => {
      document.cookie = 'mercury_csrf=mercury-value-123';
      expect(getCsrfToken()).toBe('mercury-value-123');
    });

    it('falls back to paracord_csrf when mercury_csrf is absent', () => {
      document.cookie = 'paracord_csrf=legacy-value-456';
      expect(getCsrfToken()).toBe('legacy-value-456');
    });

    it('prefers mercury_csrf when both cookies are present', () => {
      document.cookie = 'mercury_csrf=mercury-wins';
      document.cookie = 'paracord_csrf=legacy-loses';
      expect(getCsrfToken()).toBe('mercury-wins');
    });

    it('decodes a URI-encoded mercury_csrf value', () => {
      document.cookie = `mercury_csrf=${encodeURIComponent('a/b c+d=e')}`;
      expect(getCsrfToken()).toBe('a/b c+d=e');
    });

    it('returns null when no CSRF cookie is set', () => {
      expect(getCsrfToken()).toBeNull();
    });

    it('skips an empty mercury_csrf and falls back to the legacy cookie', () => {
      document.cookie = 'mercury_csrf=';
      document.cookie = 'paracord_csrf=legacy-fallback';
      // An empty mercury_csrf carries no token — the readable legacy value must still be usable
      // during a rolling deploy where the server may have set either name.
      expect(getCsrfToken()).toBe('legacy-fallback');
    });
  });
});
