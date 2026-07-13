/**
 * SDK method wrapper tests — mocked-fetch coverage.
 *
 * Verifies the wiring between `createLyntariClient` → method modules →
 * transport primitives across all four auth modes:
 *
 *   - `hmac` (auth flows like login)
 *   - `hmac+jwt` (most user-facing reads/mutations; requires accessToken)
 *   - `api-key-get` (waitboard, beacon-config, pos-current-visits)
 *   - `api-key-post` (congestion-history)
 *
 * Plus ancillary behaviors: client state mutation via `setAccessToken`,
 * the `requireAccessToken` guard, error envelope mapping to typed errors,
 * and idempotency-key header injection rules.
 *
 * The 30 methods are mechanical wiring around 4 transport calls; once the
 * 4 modes are validated we trust TypeScript + the transport-layer tests
 * (49 tests in hmac.test.ts) for the rest.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import {
  createLyntariClient,
  IdempotencyKeyConflictError,
  ValidationError,
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

describe('createLyntariClient', () => {
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
  });

  it('exposes all 5 domain namespaces + setAccessToken/getAccessToken', () => {
    expect(typeof client.auth).toBe('object');
    expect(typeof client.visits).toBe('object');
    expect(typeof client.location).toBe('object');
    expect(typeof client.notifications).toBe('object');
    expect(typeof client.reads).toBe('object');
    expect(typeof client.setAccessToken).toBe('function');
    expect(typeof client.getAccessToken).toBe('function');
    expect(client.getAccessToken()).toBeNull();
  });

  it('setAccessToken mutates state visible to getAccessToken', () => {
    expect(client.getAccessToken()).toBeNull();
    client.setAccessToken('jwt-abc');
    expect(client.getAccessToken()).toBe('jwt-abc');
    client.setAccessToken(null);
    expect(client.getAccessToken()).toBeNull();
  });
});

// === hmac mode (no JWT) ====================================================

describe('auth.login (hmac mode)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
  });

  it('POSTs to /consumer-login with email + password + _auth (apiKey, timestamp, signature)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          token: 'jwt-1',
          refresh_token: 'r-1',
          user_id: '7d42f058-b23e-4c33-804b-e78c01d9a443',
          expires_at: '2026-05-09T12:00:00.000Z',
        },
      }),
    );

    const result = await client.auth.login({ email: 'a@b.c', password: 'pw' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/consumer-login`);
    expect(init?.method).toBe('POST');

    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.email).toBe('a@b.c');
    expect(sentBody.password).toBe('pw');
    expect(sentBody._auth).toBeDefined();
    expect(sentBody._auth.apiKey).toBe(API_KEY);
    expect(typeof sentBody._auth.timestamp).toBe('string');
    expect(typeof sentBody._auth.signature).toBe('string');
    // login is non-JWT-issuing-side: no token in _auth (this is a token-issuing call)
    expect(sentBody._auth.token).toBeUndefined();

    expect(result.token).toBe('jwt-1');
    expect(result.user_id).toBe('7d42f058-b23e-4c33-804b-e78c01d9a443');
  });

  it('does NOT send Idempotency-Key for non-idempotent endpoints (idempotencyKey: null)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { token: 't', refresh_token: 'r', user_id: 'u', expires_at: '2026-01-01T00:00:00.000Z' },
      }),
    );

    await client.auth.login({ email: 'a@b.c', password: 'pw' });

    const headers = (fetchMock.mock.calls[0]![1]?.headers as Record<string, string>) ?? {};
    expect(headers['Idempotency-Key']).toBeUndefined();
    expect(headers['idempotency-key']).toBeUndefined();
  });
});

// === hmac+jwt mode =========================================================

describe('reads.profile (hmac+jwt mode)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
  });

  it('throws a clear error when accessToken is unset', async () => {
    await expect(client.reads.profile()).rejects.toThrow(/requires an access token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('injects the access token into _auth.token when set', async () => {
    client.setAccessToken('jwt-abc.def.ghi');
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: { id: 'u', email: 'x@y.z', created_at: '2026-01-01' } }),
    );

    await client.reads.profile();

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(sentBody._auth.token).toBe('jwt-abc.def.ghi');
  });
});

describe('auth.deleteAccount (hmac+jwt + idempotent)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
    client.setAccessToken('jwt-1');
  });

  it('auto-generates an Idempotency-Key for idempotent endpoints', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: { deleted: true } }),
    );

    await client.auth.deleteAccount();

    const headers = (fetchMock.mock.calls[0]![1]?.headers as Record<string, string>) ?? {};
    expect(headers['Idempotency-Key']).toBeDefined();
    expect(typeof headers['Idempotency-Key']).toBe('string');
    expect(headers['Idempotency-Key']!.length).toBeGreaterThan(0);
  });

  it('sends an empty body (no extra fields)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: { deleted: true } }),
    );

    await client.auth.deleteAccount();

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(Object.keys(sentBody).sort()).toEqual(['_auth']);
  });
});

// === api-key-get mode ======================================================

describe('reads.waitboard (api-key-get mode)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
  });

  it('GETs /waitboard with apikey + x-api-key headers, no body, no JWT', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: [{ venue_id: 'v1', current_wait_minutes: 12 }] }),
    );

    const result = await client.reads.waitboard();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/waitboard`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();

    const headers = init?.headers as Record<string, string>;
    expect(headers['apikey']).toBe(API_KEY);
    expect(headers['x-api-key']).toBe(API_KEY);

    expect(Array.isArray(result)).toBe(true);
  });
});

describe('visits.posCurrentVisits (api-key-get with POS-specific key)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
  });

  it('uses the POS-specific key, NOT the consumer apiKey from config', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: [] }));

    await client.visits.posCurrentVisits('pos-key-deployment-A');

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers['apikey']).toBe('pos-key-deployment-A');
    expect(headers['x-api-key']).toBe('pos-key-deployment-A');
    expect(headers['apikey']).not.toBe(API_KEY);
  });
});

// === api-key-post mode =====================================================

describe('visits.congestionHistory (api-key-post mode)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
  });

  it('POSTs to /congestion-history with _auth.apiKey ONLY (no signature, no timestamp)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: [{ congestion_pct: 0.42 }] }),
    );

    await client.visits.congestionHistory({
      p_stadium_id: 'b47f4b9d-e1f9-444a-aef4-8adf666befbc',
      p_from: '2026-05-08T00:00:00.000Z',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/congestion-history`);
    expect(init?.method).toBe('POST');

    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.p_stadium_id).toBe('b47f4b9d-e1f9-444a-aef4-8adf666befbc');
    expect(sentBody._auth).toEqual({ apiKey: API_KEY });
    // CRITICAL: no signature/timestamp/token in this auth mode
    expect(sentBody._auth.signature).toBeUndefined();
    expect(sentBody._auth.timestamp).toBeUndefined();
    expect(sentBody._auth.token).toBeUndefined();
  });
});

// === Error envelope mapping ================================================

describe('error envelope mapping', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
  });

  it('maps 400 validation_failed to ValidationError', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 400,
        body: {
          error: {
            code: 'validation_failed',
            message: 'Required',
            request_id: 'req_xyz',
            details: { field: 'email', issues: [{ code: 'invalid_type', path: ['email'] }] },
          },
        },
      }),
    );

    await expect(client.auth.login({ email: 'bad', password: 'pw' })).rejects.toBeInstanceOf(
      ValidationError,
    );

    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 400,
        body: { error: { code: 'validation_failed', message: '', request_id: 'req_2' } },
      }),
    );

    try {
      await client.auth.login({ email: 'bad', password: 'pw' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const err = e as ValidationError;
      expect(err.code).toBe('validation_failed');
      expect(err.status).toBe(400);
      expect(err.requestId).toBe('req_2');
    }
  });

  it('maps 409 idempotency_key_conflict to IdempotencyKeyConflictError', async () => {
    client.setAccessToken('jwt-1');
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 409,
        body: {
          error: {
            code: 'idempotency_key_conflict',
            message: 'Idempotency key was previously used with a different request body.',
            request_id: 'req_conf',
            details: { existing_request_hash_prefix: 'ab12cd34' },
          },
        },
      }),
    );

    await expect(client.auth.deleteAccount()).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });
});

// === insights operator EFs (hmac+jwt mode) =================================

describe('insights.recordFeedback (hmac+jwt mode)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
    client.setAccessToken('jwt-operator-1');
  });

  it('POSTs to /record-insight-feedback with insight_id + sentiment + _auth (jwt + signature)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { feedback_id: '9c5cf26a-7e1d-4f3a-8c91-7a0b1f5d6e22' },
      }),
    );

    const result = await client.insights.recordFeedback({
      insight_id: '7d42f058-b23e-4c33-804b-e78c01d9a443',
      sentiment: 'useful',
      reason_code: null,
      notes: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/record-insight-feedback`);
    expect(init?.method).toBe('POST');

    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.insight_id).toBe('7d42f058-b23e-4c33-804b-e78c01d9a443');
    expect(sentBody.sentiment).toBe('useful');
    expect(sentBody._auth.apiKey).toBe(API_KEY);
    expect(sentBody._auth.token).toBe('jwt-operator-1');
    expect(typeof sentBody._auth.timestamp).toBe('string');
    expect(typeof sentBody._auth.signature).toBe('string');

    // non-idempotent: no Idempotency-Key header
    const headers = (init?.headers as Record<string, string>) ?? {};
    expect(headers['Idempotency-Key']).toBeUndefined();

    expect(result.feedback_id).toBe('9c5cf26a-7e1d-4f3a-8c91-7a0b1f5d6e22');
  });
});

describe('insights.updateLifecycle (hmac+jwt mode)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
    client.setAccessToken('jwt-operator-2');
  });

  it('POSTs to /update-insight-lifecycle with action + action_taken_text passed through', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          ok: true,
          insight_id: '7d42f058-b23e-4c33-804b-e78c01d9a443',
          action: 'act',
        },
      }),
    );

    const result = await client.insights.updateLifecycle({
      insight_id: '7d42f058-b23e-4c33-804b-e78c01d9a443',
      action: 'act',
      action_taken_text: 'Dispatched 3 runners to gate 7',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/update-insight-lifecycle`);
    expect(init?.method).toBe('POST');

    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.action).toBe('act');
    expect(sentBody.action_taken_text).toBe('Dispatched 3 runners to gate 7');
    expect(sentBody._auth.token).toBe('jwt-operator-2');

    expect(result.ok).toBe(true);
    expect(result.action).toBe('act');
  });
});

// === events operator EFs (hmac+jwt mode, discriminated union) ==============

describe('events.manageStaffing (hmac+jwt mode, discriminated union)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;
  const VENUE_ID = '3d7d62b4-45ed-471c-93e9-4a01fe4825c1';
  const STAFFING_ID = 'a91b1f00-2c1f-4a44-8a55-bb9c8a8e7e02';

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
    client.setAccessToken('jwt-operator-events');
  });

  it('action=insert — POSTs venue_id + role + staff_count, returns staffing_id', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { ok: true, action: 'insert', staffing_id: STAFFING_ID },
      }),
    );

    const result = await client.events.manageStaffing({
      action: 'insert',
      venue_id: VENUE_ID,
      role: 'cashier',
      staff_count: 3,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/manage-venue-staffing`);
    expect(init?.method).toBe('POST');
    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.action).toBe('insert');
    expect(sentBody.venue_id).toBe(VENUE_ID);
    expect(sentBody.role).toBe('cashier');
    expect(sentBody.staff_count).toBe(3);
    expect(sentBody._auth.token).toBe('jwt-operator-events');
    expect(typeof sentBody._auth.signature).toBe('string');

    // type narrowing: insert response has staffing_id
    if (result.action === 'insert') {
      expect(result.staffing_id).toBe(STAFFING_ID);
    } else {
      throw new Error('expected action=insert response');
    }
  });

  it('action=close — POSTs staffing_id only, returns ok envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: { ok: true, action: 'close' } }),
    );

    const result = await client.events.manageStaffing({
      action: 'close',
      staffing_id: STAFFING_ID,
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(sentBody.action).toBe('close');
    expect(sentBody.staffing_id).toBe(STAFFING_ID);
    // close branch does NOT carry venue_id / role / staff_count
    expect(sentBody.venue_id).toBeUndefined();
    expect(sentBody.role).toBeUndefined();
    expect(sentBody.staff_count).toBeUndefined();

    expect(result.action).toBe('close');
    expect(result.ok).toBe(true);
  });

  it('action=close_all — POSTs venue_id, returns closed_count', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { ok: true, action: 'close_all', closed_count: 4 },
      }),
    );

    const result = await client.events.manageStaffing({
      action: 'close_all',
      venue_id: VENUE_ID,
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(sentBody.action).toBe('close_all');
    expect(sentBody.venue_id).toBe(VENUE_ID);

    if (result.action === 'close_all') {
      expect(result.closed_count).toBe(4);
    } else {
      throw new Error('expected action=close_all response');
    }
  });
});

describe('events.managePhase (hmac+jwt mode, discriminated union)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;
  const EVENT_ID = 'b47f4b9d-e1f9-444a-aef4-8adf666befbc';
  const PHASE_ROW_ID = 'c5a2f1d3-9e8b-4d7a-b612-1f0e3d9c5a6b';

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
    client.setAccessToken('jwt-operator-phases');
  });

  it('action=started — POSTs event_id + phase_name, server hard-validates name; client returns phase_row_id', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { ok: true, action: 'started', phase_row_id: PHASE_ROW_ID },
      }),
    );

    const result = await client.events.managePhase({
      action: 'started',
      event_id: EVENT_ID,
      phase_name: 'Q2',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/manage-event-phases`);
    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.action).toBe('started');
    expect(sentBody.event_id).toBe(EVENT_ID);
    expect(sentBody.phase_name).toBe('Q2');
    expect(sentBody._auth.token).toBe('jwt-operator-phases');

    if (result.action === 'started') {
      expect(result.phase_row_id).toBe(PHASE_ROW_ID);
    } else {
      throw new Error('expected action=started response');
    }
  });

  it('action=ended — POSTs event_id + phase_name, returns ok envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: { ok: true, action: 'ended' } }),
    );

    const result = await client.events.managePhase({
      action: 'ended',
      event_id: EVENT_ID,
      phase_name: 'halftime',
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(sentBody.action).toBe('ended');
    expect(sentBody.event_id).toBe(EVENT_ID);
    expect(sentBody.phase_name).toBe('halftime');

    expect(result.action).toBe('ended');
    expect(result.ok).toBe(true);
  });

  it('action=get_taxonomies — POSTs sport, returns phases array (read-only path)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          ok: true,
          action: 'get_taxonomies',
          phases: [
            { sport: 'NFL', phase_name: 'pre_game', phase_index: 0 },
            { sport: 'NFL', phase_name: 'Q1', phase_index: 1 },
            { sport: 'NFL', phase_name: 'Q2', phase_index: 2 },
            { sport: 'NFL', phase_name: 'halftime', phase_index: 3 },
            { sport: 'NFL', phase_name: 'Q3', phase_index: 4 },
            { sport: 'NFL', phase_name: 'Q4', phase_index: 5 },
            { sport: 'NFL', phase_name: 'OT', phase_index: 6 },
            { sport: 'NFL', phase_name: 'post', phase_index: 7 },
          ],
        },
      }),
    );

    const result = await client.events.managePhase({
      action: 'get_taxonomies',
      sport: 'NFL',
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(sentBody.action).toBe('get_taxonomies');
    expect(sentBody.sport).toBe('NFL');

    if (result.action === 'get_taxonomies') {
      expect(result.phases.length).toBe(8);
      expect(result.phases[0]).toMatchObject({ phase_name: 'pre_game' });
    } else {
      throw new Error('expected action=get_taxonomies response');
    }
  });
});

// === consent consumer EFs (hmac+jwt mode) ==================================

describe('consent.get (hmac+jwt mode)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
    client.setAccessToken('jwt-consumer-1');
  });

  it('throws a clear error when accessToken is unset', async () => {
    client.setAccessToken(null);
    await expect(client.consent.get()).rejects.toThrow(/requires an access token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs an empty body to /consent-get with _auth (jwt + signature), no Idempotency-Key', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          consent: {
            personalization: { granted: true, granted_at: '2026-06-28T10:00:00.000Z', revoked_at: null },
          },
        },
      }),
    );

    const result = await client.consent.get();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/consent-get`);
    expect(init?.method).toBe('POST');

    const sentBody = JSON.parse(init?.body as string);
    // empty body apart from the injected _auth block
    expect(Object.keys(sentBody).sort()).toEqual(['_auth']);
    expect(sentBody._auth.token).toBe('jwt-consumer-1');
    expect(typeof sentBody._auth.signature).toBe('string');

    // non-idempotent: no Idempotency-Key header
    const headers = (init?.headers as Record<string, string>) ?? {};
    expect(headers['Idempotency-Key']).toBeUndefined();

    expect(result.consent.personalization?.granted).toBe(true);
  });
});

describe('consent.set (hmac+jwt + idempotent)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
    client.setAccessToken('jwt-consumer-2');
  });

  it('POSTs a grant to /consent-set and auto-generates an Idempotency-Key', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          consent: {
            personalization: { granted: true, granted_at: '2026-06-28T10:05:00.000Z', revoked_at: null },
          },
        },
      }),
    );

    const result = await client.consent.set({ consent_type: 'personalization', granted: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/consent-set`);
    expect(init?.method).toBe('POST');

    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.consent_type).toBe('personalization');
    expect(sentBody.granted).toBe(true);
    expect(sentBody._auth.token).toBe('jwt-consumer-2');

    // idempotent endpoint: transport injects a default Idempotency-Key
    const headers = (init?.headers as Record<string, string>) ?? {};
    expect(headers['Idempotency-Key']).toBeDefined();
    expect(headers['Idempotency-Key']!.length).toBeGreaterThan(0);

    expect(result.consent.personalization?.granted).toBe(true);
  });

  it('POSTs a one-tap revoke (granted: false) and reflects the revoked state', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          consent: {
            personalization: { granted: false, granted_at: '2026-06-28T10:05:00.000Z', revoked_at: '2026-06-28T11:00:00.000Z' },
          },
        },
      }),
    );

    const result = await client.consent.set({ consent_type: 'personalization', granted: false });

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(sentBody.granted).toBe(false);
    expect(result.consent.personalization?.granted).toBe(false);
    expect(result.consent.personalization?.revoked_at).toBe('2026-06-28T11:00:00.000Z');
  });
});

// === recommendations consumer EF (hmac+jwt mode) ===========================

describe('recommendations.get (hmac+jwt mode)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
    client.setAccessToken('jwt-consumer-3');
  });

  it('POSTs venue_id to /recommendations and parses the empty-payload (ineligible) shape', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          recommendation_id: null,
          user_id: null,
          venue_id: '3d7d62b4-45ed-471c-93e9-4a01fe4825c1',
          recommendation_type: null,
          items: [],
          score: null,
          confidence: null,
          valid_until: null,
          explanation_token: null,
          abo_eligibility: { enabled: false, reason: 'org_disabled' },
        },
      }),
    );

    const result = await client.recommendations.get({
      venue_id: '3d7d62b4-45ed-471c-93e9-4a01fe4825c1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/recommendations`);
    expect(init?.method).toBe('POST');

    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.venue_id).toBe('3d7d62b4-45ed-471c-93e9-4a01fe4825c1');
    expect(sentBody._auth.token).toBe('jwt-consumer-3');
    expect(typeof sentBody._auth.signature).toBe('string');

    // non-idempotent: no Idempotency-Key header
    const headers = (init?.headers as Record<string, string>) ?? {};
    expect(headers['Idempotency-Key']).toBeUndefined();

    expect(result.items).toEqual([]);
    expect(result.abo_eligibility.enabled).toBe(false);
    expect(result.abo_eligibility.reason).toBe('org_disabled');
  });

  it('parses an eligible payload with opaque items + explanation token', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          recommendation_id: '9c5cf26a-7e1d-4f3a-8c91-7a0b1f5d6e22',
          user_id: '7d42f058-b23e-4c33-804b-e78c01d9a443',
          venue_id: '3d7d62b4-45ed-471c-93e9-4a01fe4825c1',
          recommendation_type: 'concession',
          items: [{ entity_id: 'opaque-1', rank: 1 }, { entity_id: 'opaque-2', rank: 2 }],
          score: 0.82,
          confidence: 0.61,
          valid_until: '2026-06-28T23:59:59.000Z',
          explanation_token: 'tok_opaque_abc123',
          abo_eligibility: { enabled: true, reason: null },
        },
      }),
    );

    const result = await client.recommendations.get({
      venue_id: '3d7d62b4-45ed-471c-93e9-4a01fe4825c1',
    });

    expect(result.items.length).toBe(2);
    expect(result.recommendation_type).toBe('concession');
    expect(result.explanation_token).toBe('tok_opaque_abc123');
    expect(result.abo_eligibility.enabled).toBe(true);
    expect(result.abo_eligibility.reason).toBeNull();
  });
});

// === privacy / DSR consumer EF (hmac+jwt + idempotent) =====================

describe('privacy.submitDsr (hmac+jwt + idempotent)', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let client: LyntariClient;

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    client = createLyntariClient({ baseUrl: BASE_URL, apiKey: API_KEY, hmacSecret: HMAC_SECRET });
    client.setAccessToken('jwt-consumer-4');
  });

  it('POSTs a deletion request to /dsr, auto-generates an Idempotency-Key, and parses the request record', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          dsr: {
            dsr_id: 'a3f0c8e2-1d44-4b91-9c7e-8f2a6b0d1e33',
            request_type: 'erasure',
            result: { status: 'completed' },
          },
        },
      }),
    );

    const result = await client.privacy.submitDsr({ request_type: 'deletion' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/dsr`);
    expect(init?.method).toBe('POST');

    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.request_type).toBe('deletion');
    expect(sentBody._auth.token).toBe('jwt-consumer-4');
    expect(typeof sentBody._auth.signature).toBe('string');

    // idempotent endpoint: transport injects a default Idempotency-Key
    const headers = (init?.headers as Record<string, string>) ?? {};
    expect(headers['Idempotency-Key']).toBeDefined();
    expect(headers['Idempotency-Key']!.length).toBeGreaterThan(0);

    expect(result.dsr.dsr_id).toBe('a3f0c8e2-1d44-4b91-9c7e-8f2a6b0d1e33');
    expect(result.dsr.request_type).toBe('erasure');
  });

  it('accepts the access and portability verbs', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { dsr: { dsr_id: 'd1', request_type: 'access', result: {} } },
      }),
    );

    await client.privacy.submitDsr({ request_type: 'access' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string).request_type).toBe('access');

    await client.privacy.submitDsr({ request_type: 'portability' });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]?.body as string).request_type).toBe('portability');
  });
});

// === idempotency-key explicit override =====================================

describe('idempotency-key explicit override', () => {
  it('the underlying transport accepts a caller-supplied idempotency key', async () => {
    // Note: v0.1 method wrappers don't expose an `opts` parameter for
    // overriding the idempotency key. Callers needing key coordination
    // across multiple SDK calls drop down to the transport layer
    // (`postWithHMAC` directly) — documented as a v0.1 non-feature in
    // the SDK README. This test pins the transport-level surface so a
    // future v0.2 method-level option can be added without contract
    // surprise.
    const { postWithHMAC } = await import('../src/transport/post.js');
    const fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { ok: true } }));

    await postWithHMAC({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      hmacSecret: HMAC_SECRET,
      slug: 'visit-signals',
      body: {
        venue_id: '3d7d62b4-45ed-471c-93e9-4a01fe4825c1',
        signal_type: 'manual_checkin',
        timestamp_ms: 1_700_000_000_000,
      },
      accessToken: 'jwt-1',
      idempotencyKey: 'caller-supplied-key-123',
    });

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('caller-supplied-key-123');
  });
});
