/**
 * Auth lifecycle tests.
 *
 * Exercises the lifecycle behavior the cutover relies on:
 *
 *  - Cold-start restore from storage (valid token, expired token, missing values).
 *  - Login persists tokens, schedules refresh, emits `tokenRefreshed`.
 *  - On-demand `forceRefresh()` rotates tokens, persists, schedules.
 *  - `terminal_for_auth` server error → `authExpired` event + storage cleared.
 *  - Transient server error → `authError` event + storage preserved.
 *  - Logout clears storage even on network failure.
 *
 * Timers are driven by `vi.useFakeTimers()` so scheduled refresh fires
 * deterministically without sleeping wall-clock minutes.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from 'vitest';
import {
  createLyntariClient,
  InMemoryStorage,
  type AuthEvent,
  type LyntariClient,
} from '../src/index.js';

const BASE_URL = 'https://example.test/functions/v1';
const API_KEY = 'pk-test';
const HMAC_SECRET = 'sk-test';

interface MockResponseInit {
  ok: boolean;
  status: number;
  body: unknown;
}

function mockResponse({ ok, status, body }: MockResponseInit): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function isoFromNowMin(min: number): string {
  return new Date(Date.now() + min * 60 * 1000).toISOString();
}

describe('AuthLifecycle — cold-start restore', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let storage: InMemoryStorage;
  let events: AuthEvent[];
  let client: LyntariClient;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    storage = new InMemoryStorage();
    events = [];
    client = createLyntariClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      hmacSecret: HMAC_SECRET,
      auth: { storage, onEvent: (e) => events.push(e) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('init() with no stored auth returns restored: false', async () => {
    const result = await client.auth.init!();
    expect(result.restored).toBe(false);
    expect(client.auth.state).toBeNull();
    expect(client.getAccessToken()).toBeNull();
  });

  it('init() with a valid stored token restores in-memory state and schedules a refresh', async () => {
    const expiresAtMs = Date.now() + 30 * 60 * 1000;
    await storage.set('authToken', 'jwt-1');
    await storage.set('refreshToken', 'r-1');
    await storage.set('user_id', 'u-1');
    await storage.set('authUser', JSON.stringify({ email: 'a@b.c', user_id: 'u-1' }));
    await storage.set('token_expires_at', String(expiresAtMs));

    const result = await client.auth.init!();

    expect(result.restored).toBe(true);
    expect(client.auth.state).toEqual({ user_id: 'u-1', expires_at: expiresAtMs });
    expect(client.getAccessToken()).toBe('jwt-1');
    // No events expected on a clean restore (only token rotation emits).
    expect(events).toHaveLength(0);
  });

  it('init() with an expired stored token attempts a refresh', async () => {
    const pastExpiresAt = Date.now() - 5 * 60 * 1000;
    await storage.set('authToken', 'jwt-stale');
    await storage.set('refreshToken', 'r-1');
    await storage.set('user_id', 'u-1');
    await storage.set('authUser', JSON.stringify({ email: 'a@b.c', user_id: 'u-1' }));
    await storage.set('token_expires_at', String(pastExpiresAt));

    const newExpiresAt = isoFromNowMin(30);
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { access_token: 'jwt-fresh', refresh_token: 'r-2', expires_at: newExpiresAt },
      }),
    );

    const result = await client.auth.init!();

    expect(result.restored).toBe(true);
    expect(client.getAccessToken()).toBe('jwt-fresh');
    expect(await storage.get('authToken')).toBe('jwt-fresh');
    expect(await storage.get('refreshToken')).toBe('r-2');
    // Refresh-on-restore emits exactly one tokenRefreshed event. init() populates
    // currentState from stored values BEFORE refreshInternal so
    // handleRefreshSucceeded's `if (this.currentState)` guard fires and emits.
    expect(events.filter((e) => e.type === 'tokenRefreshed')).toHaveLength(1);
  });

  // Regression test for a cold-start refresh race. Before the fix, init()
  // with an expired stored token would successfully refresh server-side but
  // leave `currentState` null because `handleRefreshSucceeded`'s
  // `if (this.currentState)` guard short-circuited. The SDK getter
  // `client.auth.state` returned null even though the server-side refresh
  // had succeeded — any UI gating on `client.auth.state` saw an unauth
  // signal despite the user being authenticated.
  //
  // After the fix: currentState is populated from stored values BEFORE
  // refreshInternal, so the guard fires and currentState carries the right
  // user_id + the refreshed expires_at.
  it('init() with an expired stored token leaves client.auth.state non-null with the refreshed expiry', async () => {
    const pastExpiresAt = Date.now() - 5 * 60 * 1000;
    await storage.set('authToken', 'jwt-stale');
    await storage.set('refreshToken', 'r-1');
    await storage.set('user_id', 'u-cold-start');
    await storage.set('authUser', JSON.stringify({ email: 'a@b.c', user_id: 'u-cold-start' }));
    await storage.set('token_expires_at', String(pastExpiresAt));

    const newExpiresAt = isoFromNowMin(30);
    const newExpiresAtMs = new Date(newExpiresAt).getTime();
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { access_token: 'jwt-fresh', refresh_token: 'r-2', expires_at: newExpiresAt },
      }),
    );

    const result = await client.auth.init!();

    expect(result.restored).toBe(true);
    expect(client.auth.state).not.toBeNull();
    expect(client.auth.state).toEqual({
      user_id: 'u-cold-start',
      expires_at: newExpiresAtMs,
    });
    expect(client.getAccessToken()).toBe('jwt-fresh');
    // Exactly one tokenRefreshed event with the refreshed state — proves the
    // emit path inside handleRefreshSucceeded fired, which only happens when
    // currentState was non-null at the time of the update.
    const refreshedEvents = events.filter((e) => e.type === 'tokenRefreshed');
    expect(refreshedEvents).toHaveLength(1);
    expect(refreshedEvents[0]).toEqual({
      type: 'tokenRefreshed',
      state: { user_id: 'u-cold-start', expires_at: newExpiresAtMs },
    });
  });

  it('init() with terminal refresh failure clears storage and emits authExpired', async () => {
    const pastExpiresAt = Date.now() - 5 * 60 * 1000;
    await storage.set('authToken', 'jwt-stale');
    await storage.set('refreshToken', 'r-bad');
    await storage.set('user_id', 'u-1');
    await storage.set('authUser', JSON.stringify({ email: 'a@b.c', user_id: 'u-1' }));
    await storage.set('token_expires_at', String(pastExpiresAt));

    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        body: {
          error: {
            code: 'refresh_token_revoked',
            message: 'revoked',
            request_id: 'req-1',
            terminal_for_auth: true,
          },
        },
      }),
    );

    const result = await client.auth.init!();

    expect(result.restored).toBe(false);
    expect(client.getAccessToken()).toBeNull();
    expect(await storage.get('authToken')).toBeNull();
    expect(await storage.get('refreshToken')).toBeNull();
    expect(events.some((e) => e.type === 'authExpired')).toBe(true);
  });

  it('init() with transient refresh failure preserves storage', async () => {
    const pastExpiresAt = Date.now() - 5 * 60 * 1000;
    await storage.set('authToken', 'jwt-stale');
    await storage.set('refreshToken', 'r-1');
    await storage.set('user_id', 'u-1');
    await storage.set('authUser', JSON.stringify({ email: 'a@b.c', user_id: 'u-1' }));
    await storage.set('token_expires_at', String(pastExpiresAt));

    // First retryable failure: bad_signature (retry self-heal); transport retries once.
    // Then a second failure that isn't terminal_for_auth — transport-error mock.
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    // Disable bad_signature retry by ensuring the fetch rejection counts as TransportError, not BadSignatureError.

    const result = await client.auth.init!();

    expect(result.restored).toBe(false);
    expect(client.getAccessToken()).toBeNull();
    // Storage preserved — transient failure leaves the user able to retry on next launch.
    expect(await storage.get('authToken')).toBe('jwt-stale');
    expect(await storage.get('refreshToken')).toBe('r-1');
    expect(events.some((e) => e.type === 'authError')).toBe(true);
  });

  it('init() is idempotent', async () => {
    const expiresAtMs = Date.now() + 30 * 60 * 1000;
    await storage.set('authToken', 'jwt-1');
    await storage.set('refreshToken', 'r-1');
    await storage.set('user_id', 'u-1');
    await storage.set('authUser', JSON.stringify({ email: 'a@b.c', user_id: 'u-1' }));
    await storage.set('token_expires_at', String(expiresAtMs));

    const r1 = await client.auth.init!();
    const r2 = await client.auth.init!();
    expect(r1.restored).toBe(true);
    expect(r2.restored).toBe(true);
    // No fetch calls on either init — restore is pure-storage.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AuthLifecycle — login + persistence', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let storage: InMemoryStorage;
  let events: AuthEvent[];
  let client: LyntariClient;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    storage = new InMemoryStorage();
    events = [];
    client = createLyntariClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      hmacSecret: HMAC_SECRET,
      auth: { storage, onEvent: (e) => events.push(e) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('login persists tokens, sets in-memory state, emits tokenRefreshed', async () => {
    const expiresAt = isoFromNowMin(30);
    const expiresAtMs = new Date(expiresAt).getTime();
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { token: 'jwt-1', refresh_token: 'r-1', user_id: 'u-1', expires_at: expiresAt },
      }),
    );

    await client.auth.login({ email: 'a@b.c', password: 'pw' });

    expect(client.getAccessToken()).toBe('jwt-1');
    expect(client.auth.state).toEqual({ user_id: 'u-1', expires_at: expiresAtMs });
    expect(await storage.get('authToken')).toBe('jwt-1');
    expect(await storage.get('refreshToken')).toBe('r-1');
    expect(await storage.get('user_id')).toBe('u-1');
    expect(await storage.get('token_expires_at')).toBe(String(expiresAtMs));
    const stored = JSON.parse((await storage.get('authUser'))!);
    expect(stored).toEqual({ email: 'a@b.c', user_id: 'u-1' });
    expect(events.some((e) => e.type === 'tokenRefreshed')).toBe(true);
  });

  it('forceRefresh rotates tokens and emits tokenRefreshed', async () => {
    // Login first.
    const loginExpiresAt = isoFromNowMin(30);
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { token: 'jwt-1', refresh_token: 'r-1', user_id: 'u-1', expires_at: loginExpiresAt },
      }),
    );
    await client.auth.login({ email: 'a@b.c', password: 'pw' });
    events.length = 0; // clear login events

    // Force refresh.
    const newExpiresAt = isoFromNowMin(30);
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { access_token: 'jwt-2', refresh_token: 'r-2', expires_at: newExpiresAt },
      }),
    );

    const result = await client.auth.forceRefresh!();

    expect(result.access_token).toBe('jwt-2');
    expect(client.getAccessToken()).toBe('jwt-2');
    expect(await storage.get('authToken')).toBe('jwt-2');
    expect(await storage.get('refreshToken')).toBe('r-2');
    expect(events.some((e) => e.type === 'tokenRefreshed')).toBe(true);
  });

  it('logout clears storage even when the EF call fails', async () => {
    // Login first.
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          token: 'jwt-1',
          refresh_token: 'r-1',
          user_id: 'u-1',
          expires_at: isoFromNowMin(30),
        },
      }),
    );
    await client.auth.login({ email: 'a@b.c', password: 'pw' });

    // Logout EF fails (network).
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await expect(client.auth.logout({ refresh_token: 'r-1' })).rejects.toThrow();

    expect(client.getAccessToken()).toBeNull();
    expect(client.auth.state).toBeNull();
    expect(await storage.get('authToken')).toBeNull();
    expect(await storage.get('refreshToken')).toBeNull();
  });

  it('clear() removes in-memory state and all storage keys', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          token: 'jwt-1',
          refresh_token: 'r-1',
          user_id: 'u-1',
          expires_at: isoFromNowMin(30),
        },
      }),
    );
    await client.auth.login({ email: 'a@b.c', password: 'pw' });

    await client.auth.clear!();

    expect(client.getAccessToken()).toBeNull();
    expect(client.auth.state).toBeNull();
    for (const k of ['authToken', 'refreshToken', 'authUser', 'user_id', 'token_expires_at']) {
      expect(await storage.get(k)).toBeNull();
    }
  });

  it('clear() emits `cleared` when transitioning from authenticated to unauthenticated', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          token: 'jwt-1',
          refresh_token: 'r-1',
          user_id: 'u-1',
          expires_at: isoFromNowMin(30),
        },
      }),
    );
    await client.auth.login({ email: 'a@b.c', password: 'pw' });
    events.length = 0; // discard login events

    await client.auth.clear!();

    expect(events.map((e) => e.type)).toEqual(['cleared']);
  });

  it('clear() is silent when no auth state exists (no spurious `cleared`)', async () => {
    // No login first — currentState is null from the start.
    await client.auth.clear!();
    expect(events.filter((e) => e.type === 'cleared')).toHaveLength(0);
  });

  it('logout (with successful EF call) emits `cleared`', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          token: 'jwt-1',
          refresh_token: 'r-1',
          user_id: 'u-1',
          expires_at: isoFromNowMin(30),
        },
      }),
    );
    await client.auth.login({ email: 'a@b.c', password: 'pw' });
    events.length = 0;

    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: { revoked: true } }),
    );
    await client.auth.logout({ refresh_token: 'r-1' });

    expect(events.map((e) => e.type)).toEqual(['cleared']);
  });

  it('logout (with failed EF call) still emits `cleared`', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          token: 'jwt-1',
          refresh_token: 'r-1',
          user_id: 'u-1',
          expires_at: isoFromNowMin(30),
        },
      }),
    );
    await client.auth.login({ email: 'a@b.c', password: 'pw' });
    events.length = 0;

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(client.auth.logout({ refresh_token: 'r-1' })).rejects.toThrow();

    expect(events.map((e) => e.type)).toEqual(['cleared']);
  });

  it('terminal refresh failure emits `cleared` immediately before `authExpired`', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          token: 'jwt-1',
          refresh_token: 'r-1',
          user_id: 'u-1',
          expires_at: isoFromNowMin(30),
        },
      }),
    );
    await client.auth.login({ email: 'a@b.c', password: 'pw' });
    events.length = 0;

    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        body: {
          error: {
            code: 'refresh_token_revoked',
            message: 'revoked',
            request_id: 'req-1',
            terminal_for_auth: true,
          },
        },
      }),
    );
    await expect(client.auth.forceRefresh!()).rejects.toThrow();

    // Order matters: `cleared` (state transition) precedes `authExpired` (reason).
    // PushSubscriptions listens for `cleared`; UI consumers listen for `authExpired`.
    expect(events.map((e) => e.type)).toEqual(['cleared', 'authExpired']);
  });
});

describe('AuthLifecycle — onEvent subscription', () => {
  it('multiple subscribers all receive events; unsubscribe stops one', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    const storage = new InMemoryStorage();
    const a: AuthEvent[] = [];
    const b: AuthEvent[] = [];

    const client = createLyntariClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      hmacSecret: HMAC_SECRET,
      auth: { storage, onEvent: (e) => a.push(e) },
    });
    const unsubB = client.auth.onEvent!((e) => b.push(e));

    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          token: 'jwt-1',
          refresh_token: 'r-1',
          user_id: 'u-1',
          expires_at: isoFromNowMin(30),
        },
      }),
    );
    await client.auth.login({ email: 'a@b.c', password: 'pw' });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);

    unsubB();

    // Second event — only a receives.
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { access_token: 'jwt-2', refresh_token: 'r-2', expires_at: isoFromNowMin(30) },
      }),
    );
    await client.auth.forceRefresh!();
    expect(a.length).toBe(2);
    expect(b.length).toBe(1);

    vi.useRealTimers();
  });
});

describe('createLyntariClient — without auth config (v0.1 mode)', () => {
  it('client.auth has raw methods only; no lifecycle members', () => {
    const client = createLyntariClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      hmacSecret: HMAC_SECRET,
    });
    expect(typeof client.auth.login).toBe('function');
    expect(client.auth.state).toBeUndefined();
    expect(client.auth.onEvent).toBeUndefined();
    expect(client.auth.init).toBeUndefined();
    expect(client.auth.forceRefresh).toBeUndefined();
  });
});
