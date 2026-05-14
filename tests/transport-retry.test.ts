/**
 * Transport retry tests — the two new behaviors added for SDK program S2/S4/S6.
 *
 *  - `visit_race_conflict` (409 + retry_safe=true) → 100ms backoff, single retry.
 *    Orthogonal to auth — applies regardless of whether lifecycle is wired.
 *  - `expired_jwt` (401) → if `onExpiredJwt` returns a new token, retry once
 *    with the new token in `_auth`; otherwise surface the original error.
 *
 * Existing `bad_signature` retry coverage lives in `methods.test.ts`.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockedFunction,
} from 'vitest';
import {
  createLyntariClient,
  InMemoryStorage,
  ExpiredJwtError,
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

describe('transport retry — visit_race_conflict', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      hmacSecret: HMAC_SECRET,
    });
    client.setAccessToken('jwt-test');
  });

  it('retries once on visit_race_conflict with retry_safe=true', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 409,
        body: {
          error: {
            code: 'visit_race_conflict',
            message: 'race',
            request_id: 'req-1',
            retry_safe: true,
          },
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: { ok: true } }),
    );

    await expect(
      client.visits.recordSignal({
        venue_id: 'v-1',
        signal_type: 'manual_checkin',
        timestamp_ms: Date.now(),
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on visit_race_conflict when retry_safe is false', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 409,
        body: {
          error: {
            code: 'visit_race_conflict',
            message: 'race',
            request_id: 'req-1',
            retry_safe: false,
          },
        },
      }),
    );

    await expect(
      client.visits.recordSignal({
        venue_id: 'v-1',
        signal_type: 'manual_checkin',
        timestamp_ms: Date.now(),
      }),
    ).rejects.toMatchObject({ code: 'visit_race_conflict' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error if the retry also fails', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 409,
        body: {
          error: {
            code: 'visit_race_conflict',
            message: 'race',
            request_id: 'req-1',
            retry_safe: true,
          },
        },
      }),
    );

    await expect(
      client.visits.recordSignal({
        venue_id: 'v-1',
        signal_type: 'manual_checkin',
        timestamp_ms: Date.now(),
      }),
    ).rejects.toMatchObject({ code: 'visit_race_conflict' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('transport retry — expired_jwt auto-refresh', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;
  let storage: InMemoryStorage;

  beforeEach(async () => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    storage = new InMemoryStorage();
    client = createLyntariClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      hmacSecret: HMAC_SECRET,
      auth: { storage },
    });

    // Prime the lifecycle with a login so it has a refresh token and
    // wired onExpiredJwt hook.
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          token: 'jwt-old',
          refresh_token: 'r-1',
          user_id: 'u-1',
          expires_at: isoFromNowMin(30),
        },
      }),
    );
    await client.auth.login({ email: 'a@b.c', password: 'pw' });
    fetchMock.mockClear(); // Reset call count after priming so each test asserts only its own fetches.
  });

  it('auto-refreshes on expired_jwt and retries the original call', async () => {
    // First call → expired_jwt
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        body: {
          error: { code: 'expired_jwt', message: 'expired', request_id: 'req-1' },
        },
      }),
    );
    // Refresh call → new tokens
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { access_token: 'jwt-new', refresh_token: 'r-2', expires_at: isoFromNowMin(30) },
      }),
    );
    // Retry of original call → success
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: { profile: { id: 'u-1' } } }),
    );

    const result = await client.reads.profile();

    expect(result).toEqual({ profile: { id: 'u-1' } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.getAccessToken()).toBe('jwt-new');
  });

  it('surfaces ExpiredJwtError when no auth lifecycle is wired', async () => {
    const bareClient = createLyntariClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      hmacSecret: HMAC_SECRET,
    });
    bareClient.setAccessToken('jwt-old');

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 401,
        body: {
          error: { code: 'expired_jwt', message: 'expired', request_id: 'req-1' },
        },
      }),
    );

    await expect(bareClient.reads.profile()).rejects.toBeInstanceOf(ExpiredJwtError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces original error when refresh fails with terminal_for_auth', async () => {
    // Profile call → expired_jwt
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        body: {
          error: { code: 'expired_jwt', message: 'expired', request_id: 'req-1' },
        },
      }),
    );
    // Refresh call → revoked (terminal_for_auth)
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        body: {
          error: {
            code: 'refresh_token_revoked',
            message: 'revoked',
            request_id: 'req-2',
            terminal_for_auth: true,
          },
        },
      }),
    );

    await expect(client.reads.profile()).rejects.toBeInstanceOf(ExpiredJwtError);
    // Storage cleared by the lifecycle's terminal-failure path.
    expect(client.getAccessToken()).toBeNull();
  });
});
