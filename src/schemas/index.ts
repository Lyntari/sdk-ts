/**
 * Schema registry — central export point for all 30 EF request/response
 * schemas plus a metadata table used by the OpenAPI build pipeline and the
 * SDK method generator.
 *
 * Two responsibilities:
 *
 * 1. **Re-export every schema and type** from the five domain modules
 *    (`auth`, `visits`, `location`, `notifications`, `reads`) plus the
 *    primitives in `_common`. Single import point: `@lyntari/sdk/schemas`.
 *
 * 2. **`efRegistry`** — a typed array of `EfRegistryEntry` rows keyed by
 *    `slug`, capturing for each EF: HTTP method, canonical path, auth
 *    mode, idempotency support, and the Zod request/response schemas.
 *    The OpenAPI build walks this list to emit `paths` + `components.schemas`,
 *    and the future SDK method generator uses the same source-of-truth.
 *
 * Auth modes mirror the deployed EF validation primitives:
 *
 *   - `hmac`         — `validateHmacPost`. HMAC signature on `_auth` block,
 *                      JWT optional (if present, just passed through to
 *                      handler — used by token-issuing flows).
 *   - `hmac+jwt`     — `validateHmacPostWithJwt`. HMAC + required JWT;
 *                      `user_id` is JWT-derived.
 *   - `api-key-get`  — `validateApiKeyGet` or `validatePosApiKeyGet`. API key
 *                      in `apikey` / `x-api-key` header. GET-only.
 *   - `api-key-post` — `validateApiKeyPost`. API key in `_auth.apiKey` body
 *                      field, no HMAC, no JWT. POST-only. Currently used by
 *                      `congestion-history` only; calling this from the SDK
 *                      requires the `postWithApiKey` transport primitive.
 *
 * `idempotent: true` indicates the EF wraps its RPC in the server-side
 * idempotency layer — clients should pass `Idempotency-Key` headers
 * (transport-injected by default) for safe retries on flaky networks.
 */

import { z } from 'zod';

import * as Auth from './auth.js';
import * as Visits from './visits.js';
import * as Location from './location.js';
import * as Notifications from './notifications.js';
import * as Reads from './reads.js';

// === Re-exports ===========================================================

export * from './_common.js';
export * from './auth.js';
export * from './visits.js';
export * from './location.js';
export * from './notifications.js';
export * from './reads.js';

// === Registry types =======================================================

export type EfAuthMode = 'hmac' | 'hmac+jwt' | 'api-key-get' | 'api-key-post';
export type EfMethod = 'GET' | 'POST';

export interface EfRegistryEntry {
  /** EF slug (last path segment under `/functions/v1/`). */
  readonly slug: string;
  /** HTTP method the deployed EF accepts. */
  readonly method: EfMethod;
  /** Canonical request path used in HMAC signing and OpenAPI docs. */
  readonly path: string;
  /** Server-side validation primitive used to authenticate the request. */
  readonly auth: EfAuthMode;
  /**
   * Whether the EF wraps its RPC in the server-side idempotency layer.
   * When `true`, the `Idempotency-Key` header is honored for safe retries.
   */
  readonly idempotent: boolean;
  /** Zod schema for the request body (sans `_auth` block, which the transport injects). */
  readonly requestSchema: z.ZodTypeAny;
  /** Zod schema for the success response body. */
  readonly responseSchema: z.ZodTypeAny;
}

const path = (slug: string): string => `/functions/v1/${slug}`;

// === Registry =============================================================

/**
 * The canonical EF registry. Order is auth → visits → location →
 * notifications → reads, matching the schema-file layout. 30 entries total.
 */
export const efRegistry: readonly EfRegistryEntry[] = [
  // --- auth (6) ----------------------------------------------------------
  {
    slug: 'consumer-login',
    method: 'POST',
    path: path('consumer-login'),
    auth: 'hmac',
    idempotent: false,
    requestSchema: Auth.ConsumerLoginRequestSchema,
    responseSchema: Auth.ConsumerLoginResponseSchema,
  },
  {
    slug: 'consumer-signup',
    method: 'POST',
    path: path('consumer-signup'),
    auth: 'hmac',
    idempotent: false,
    requestSchema: Auth.ConsumerSignupRequestSchema,
    responseSchema: Auth.ConsumerSignupResponseSchema,
  },
  {
    slug: 'auth-refresh',
    method: 'POST',
    path: path('auth-refresh'),
    auth: 'hmac',
    idempotent: false,
    requestSchema: Auth.AuthRefreshRequestSchema,
    responseSchema: Auth.AuthRefreshResponseSchema,
  },
  {
    slug: 'auth-logout',
    method: 'POST',
    path: path('auth-logout'),
    auth: 'hmac',
    idempotent: false,
    requestSchema: Auth.AuthLogoutRequestSchema,
    responseSchema: Auth.AuthLogoutResponseSchema,
  },
  {
    slug: 'reset-password',
    method: 'POST',
    path: path('reset-password'),
    auth: 'hmac',
    idempotent: false,
    requestSchema: Auth.ResetPasswordRequestSchema,
    responseSchema: Auth.ResetPasswordResponseSchema,
  },
  {
    slug: 'delete-account',
    method: 'POST',
    path: path('delete-account'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Auth.DeleteAccountRequestSchema,
    responseSchema: Auth.DeleteAccountResponseSchema,
  },

  // --- visits (4) --------------------------------------------------------
  {
    slug: 'visit-signals',
    method: 'POST',
    path: path('visit-signals'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Visits.VisitSignalsRequestSchema,
    responseSchema: Visits.VisitSignalsResponseSchema,
  },
  {
    slug: 'pos-close',
    method: 'POST',
    path: path('pos-close'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Visits.PosCloseRequestSchema,
    responseSchema: Visits.PosCloseResponseSchema,
  },
  {
    slug: 'pos-current-visits',
    method: 'GET',
    path: path('pos-current-visits'),
    auth: 'api-key-get',
    idempotent: false,
    requestSchema: Visits.PosCurrentVisitsRequestSchema,
    responseSchema: Visits.PosCurrentVisitsResponseSchema,
  },
  {
    slug: 'congestion-history',
    method: 'POST',
    path: path('congestion-history'),
    auth: 'api-key-post',
    idempotent: false,
    requestSchema: Visits.CongestionHistoryRequestSchema,
    responseSchema: Visits.CongestionHistoryResponseSchema,
  },

  // --- location (4) ------------------------------------------------------
  {
    slug: 'nearby-venues',
    method: 'POST',
    path: path('nearby-venues'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Location.NearbyVenuesRequestSchema,
    responseSchema: Location.NearbyVenuesResponseSchema,
  },
  {
    slug: 'location-update',
    method: 'POST',
    path: path('location-update'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Location.LocationUpdateRequestSchema,
    responseSchema: Location.LocationUpdateResponseSchema,
  },
  {
    slug: 'beacon-detection',
    method: 'POST',
    path: path('beacon-detection'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Location.BeaconDetectionRequestSchema,
    responseSchema: Location.BeaconDetectionResponseSchema,
  },
  {
    slug: 'beacon-config',
    method: 'GET',
    path: path('beacon-config'),
    auth: 'api-key-get',
    idempotent: false,
    requestSchema: Location.BeaconConfigRequestSchema,
    responseSchema: Location.BeaconConfigResponseSchema,
  },

  // --- notifications (8) -------------------------------------------------
  {
    slug: 'save-subscription',
    method: 'POST',
    path: path('save-subscription'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Notifications.SaveSubscriptionRequestSchema,
    responseSchema: Notifications.SaveSubscriptionResponseSchema,
  },
  {
    slug: 'get-subscription-id',
    method: 'POST',
    path: path('get-subscription-id'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Notifications.GetSubscriptionIdRequestSchema,
    responseSchema: Notifications.GetSubscriptionIdResponseSchema,
  },
  {
    slug: 'save-category-preferences',
    method: 'POST',
    path: path('save-category-preferences'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Notifications.SaveCategoryPreferencesRequestSchema,
    responseSchema: Notifications.SaveCategoryPreferencesResponseSchema,
  },
  {
    slug: 'get-category-preferences',
    method: 'POST',
    path: path('get-category-preferences'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Notifications.GetCategoryPreferencesRequestSchema,
    responseSchema: Notifications.GetCategoryPreferencesResponseSchema,
  },
  {
    slug: 'get-notification-preferences',
    method: 'POST',
    path: path('get-notification-preferences'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Notifications.GetNotificationPreferencesRequestSchema,
    responseSchema: Notifications.GetNotificationPreferencesResponseSchema,
  },
  {
    slug: 'update-notification-preferences',
    method: 'POST',
    path: path('update-notification-preferences'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Notifications.UpdateNotificationPreferencesRequestSchema,
    responseSchema: Notifications.UpdateNotificationPreferencesResponseSchema,
  },
  {
    slug: 'notification-trigger',
    method: 'POST',
    path: path('notification-trigger'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Notifications.NotificationTriggerRequestSchema,
    responseSchema: Notifications.NotificationTriggerResponseSchema,
  },
  {
    slug: 'notification-event',
    method: 'POST',
    path: path('notification-event'),
    auth: 'hmac+jwt',
    idempotent: true,
    requestSchema: Notifications.NotificationEventRequestSchema,
    responseSchema: Notifications.NotificationEventResponseSchema,
  },

  // --- reads (8) ---------------------------------------------------------
  {
    slug: 'congestion-status',
    method: 'POST',
    path: path('congestion-status'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Reads.CongestionStatusRequestSchema,
    responseSchema: Reads.CongestionStatusResponseSchema,
  },
  {
    slug: 'stadium-zones',
    method: 'POST',
    path: path('stadium-zones'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Reads.StadiumZonesRequestSchema,
    responseSchema: Reads.StadiumZonesResponseSchema,
  },
  {
    slug: 'stadium-geofences',
    method: 'GET',
    path: path('stadium-geofences'),
    auth: 'api-key-get',
    idempotent: false,
    requestSchema: Reads.StadiumGeofencesRequestSchema,
    responseSchema: Reads.StadiumGeofencesResponseSchema,
  },
  {
    slug: 'waitboard',
    method: 'GET',
    path: path('waitboard'),
    auth: 'api-key-get',
    idempotent: false,
    requestSchema: Reads.WaitboardRequestSchema,
    responseSchema: Reads.WaitboardResponseSchema,
  },
  {
    slug: 'get-profile',
    method: 'POST',
    path: path('get-profile'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Reads.GetProfileRequestSchema,
    responseSchema: Reads.GetProfileResponseSchema,
  },
  {
    slug: 'get-visit-history',
    method: 'POST',
    path: path('get-visit-history'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Reads.GetVisitHistoryRequestSchema,
    responseSchema: Reads.GetVisitHistoryResponseSchema,
  },
  {
    slug: 'get-notification-history',
    method: 'POST',
    path: path('get-notification-history'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Reads.GetNotificationHistoryRequestSchema,
    responseSchema: Reads.GetNotificationHistoryResponseSchema,
  },
  {
    slug: 'get-categories',
    method: 'POST',
    path: path('get-categories'),
    auth: 'hmac+jwt',
    idempotent: false,
    requestSchema: Reads.GetCategoriesRequestSchema,
    responseSchema: Reads.GetCategoriesResponseSchema,
  },
];

/**
 * Look up a registry entry by slug. Returns `undefined` for unknown slugs.
 * Convenience helper for OpenAPI generation and SDK method dispatch.
 */
export function findEf(slug: string): EfRegistryEntry | undefined {
  return efRegistry.find((entry) => entry.slug === slug);
}
