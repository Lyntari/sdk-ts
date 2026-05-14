/**
 * Read-flow SDK methods — 8 endpoints.
 *
 * Six HMAC+JWT POSTs (`congestionStatus`, `stadiumZones`, `profile`,
 * `visitHistory`, `notificationHistory`, `categories`) and two GETs with
 * API key (`stadiumGeofences`, `waitboard`).
 *
 * `visitHistory` and `notificationHistory` return the canonical paginated-
 * list wrapper `{total_count, <plural>: [...]}` — same shape as
 * `get-categories`. Element schemas are RPC-defined and kept permissive
 * (`z.record(z.string(), z.unknown())`) so RPC-side field additions don't
 * trigger SDK validation failures.
 *
 * Runtime response validation is deferred — many response schemas are
 * intentionally permissive (`z.unknown()`, open records); blanket
 * `responseSchema.parse(raw)` would catch almost nothing while adding cost.
 * Turn on per-method when a specific schema becomes tight enough to
 * provide signal.
 */

import type {
  CongestionStatusRequest,
  CongestionStatusResponse,
  GetCategoriesResponse,
  GetNotificationHistoryRequest,
  GetNotificationHistoryResponse,
  GetProfileResponse,
  GetVisitHistoryRequest,
  GetVisitHistoryResponse,
  StadiumGeofencesResponse,
  StadiumZonesRequest,
  StadiumZonesResponse,
  WaitboardResponse,
} from '../schemas/index.js';
import { getWithApiKey } from '../transport/get.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface ReadsMethods {
  /**
   * `congestion-status` — current per-zone congestion for a stadium.
   * Body uses the `p_*` RPC parameter convention (`p_stadium_id`).
   */
  congestionStatus(input: CongestionStatusRequest): Promise<CongestionStatusResponse>;

  /**
   * `stadium-zones` — zone catalog + outer geofence for a stadium.
   * Returns `{zones, geofence}` — `zones` is an array of zone records;
   * `geofence` is the outer polygon (nullable).
   */
  stadiumZones(input: StadiumZonesRequest): Promise<StadiumZonesResponse>;

  /**
   * `stadium-geofences` — all stadium geofences in the deployment. GET +
   * API key (no JWT, no body). Returns an array.
   */
  stadiumGeofences(): Promise<StadiumGeofencesResponse>;

  /**
   * `waitboard` — public wait-time digest. GET + API key (no JWT, no body).
   * Used by marketing site and unauthenticated displays.
   */
  waitboard(): Promise<WaitboardResponse>;

  /**
   * `get-profile` — current authenticated user's profile. Empty body
   * (`.strict()`); user_id is JWT-derived. Returns 404 `profile_not_found`
   * (surfaces as `LyntariApiError` with that code) when the user has no
   * profile row.
   */
  profile(): Promise<GetProfileResponse>;

  /**
   * `get-visit-history` — paginated visit log for the authenticated user.
   * `limit` defaults to 20 (server-side); `offset` defaults to 0.
   * Schema enforces `limit ∈ [1, 100]` and `offset ≥ 0` at the SDK boundary.
   *
   * Returns `{total_count, visits: [...]}`. Visit element shape is
   * RPC-defined: `{visit_id, venue_id, venue_name, start_ts, end_ts,
   * closed_reason, vcs_band}`.
   */
  visitHistory(input?: GetVisitHistoryRequest): Promise<GetVisitHistoryResponse>;

  /**
   * `get-notification-history` — paginated notification log for the
   * authenticated user. Same pagination contract as `visitHistory`.
   *
   * Returns `{total_count, notifications: [...]}`. Notification element
   * shape is RPC-defined: `{id, notification_type, trigger_type, venue_id,
   * venue_name, title, body, sent_at, opened_at, clicked_at, dismissed_at,
   * meta}`.
   */
  notificationHistory(
    input?: GetNotificationHistoryRequest,
  ): Promise<GetNotificationHistoryResponse>;

  /**
   * `get-categories` — fetch the venue category catalog. Empty body
   * (`.strict()`); server uses the JWT-derived user identity for any
   * future per-tenant overrides (currently ignored).
   */
  categories(): Promise<GetCategoriesResponse>;
}

export function createReadsMethods(
  config: ClientConfig,
  state: ClientState,
): ReadsMethods {
  return {
    congestionStatus: async (input) =>
      postWithHMAC<CongestionStatusResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'congestion-status',
        body: input,
        ...jwtCallOpts(state, 'congestion-status'),
        idempotencyKey: null,
      }),

    stadiumZones: async (input) =>
      postWithHMAC<StadiumZonesResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'stadium-zones',
        body: input,
        ...jwtCallOpts(state, 'stadium-zones'),
        idempotencyKey: null,
      }),

    stadiumGeofences: async () =>
      getWithApiKey<StadiumGeofencesResponse>({
        baseUrl: config.baseUrl,
        slug: 'stadium-geofences',
        apiKey: config.apiKey,
      }),

    waitboard: async () =>
      getWithApiKey<WaitboardResponse>({
        baseUrl: config.baseUrl,
        slug: 'waitboard',
        apiKey: config.apiKey,
      }),

    profile: async () =>
      postWithHMAC<GetProfileResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'get-profile',
        body: {},
        ...jwtCallOpts(state, 'get-profile'),
        idempotencyKey: null,
      }),

    visitHistory: async (input = {}) =>
      postWithHMAC<GetVisitHistoryResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'get-visit-history',
        body: input,
        ...jwtCallOpts(state, 'get-visit-history'),
        idempotencyKey: null,
      }),

    notificationHistory: async (input = {}) =>
      postWithHMAC<GetNotificationHistoryResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'get-notification-history',
        body: input,
        ...jwtCallOpts(state, 'get-notification-history'),
        idempotencyKey: null,
      }),

    categories: async () =>
      postWithHMAC<GetCategoriesResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'get-categories',
        body: {},
        ...jwtCallOpts(state, 'get-categories'),
        idempotencyKey: null,
      }),
  };
}
