/**
 * Read-flow EF schemas — 8 endpoints:
 *   - `congestion-status` (POST, HMAC + JWT) — current congestion per zone
 *   - `stadium-zones` (POST, HMAC + JWT) — zone catalog + outer geofence
 *   - `stadium-geofences` (GET, API key) — all stadium geofences
 *   - `waitboard` (GET, API key) — public wait-time digest
 *   - `get-profile` (POST, HMAC + JWT, empty body) — current user's profile
 *   - `get-visit-history` (POST, HMAC + JWT) — paginated visit log
 *   - `get-notification-history` (POST, HMAC + JWT) — paginated notification log
 *   - `get-categories` (POST, HMAC + JWT, empty body) — category catalog
 *
 * Notable contract details:
 *
 * - **`congestion-status` and `stadium-zones` use `p_*` parameter names**
 *   verbatim at the wire (`p_stadium_id`) — same convention as
 *   `congestion-history`. Both are HMAC + JWT.
 *
 * - **`stadium-zones` response** is `{zones, geofence}`. `geofence` is
 *   nullable; `zones` is an open array.
 *
 * - **`stadium-geofences` and `waitboard`** are GET-with-API-key
 *   (anonymous-style read endpoints). Empty bodies, no query params. Both
 *   return arrays, with `[]` substituted on null. `waitboard` is typed as
 *   `Array<WaitboardRow>`; `stadium-geofences` is typed as
 *   `Array<StadiumGeofenceRow>`.
 *
 * - **`get-profile` returns 404 `profile_not_found`** when no profile is
 *   found for the authenticated user. 200 otherwise.
 *
 * - **`get-visit-history` and `get-notification-history`** share the same
 *   pagination contract: `limit ∈ [1, 100]` (default 20), `offset >= 0`
 *   (default 0). Server returns 400 `validation_failed` on bounds violations.
 *   Reuses `PaginationParamsSchema` from `_common.ts`.
 *
 * - **`get-categories`** body is empty from the SDK's perspective;
 *   user_id derives from JWT.
 */

import { z } from 'zod';
import { IsoTimestampSchema, PaginationParamsSchema, UuidSchema } from './_common.js';

// === congestion-status ====================================================

/**
 * Congestion-status request. `p_stadium_id` is the wire field. Server
 * returns 400 `missing_required_fields` if absent.
 */
export const CongestionStatusRequestSchema = z.object({
  p_stadium_id: UuidSchema,
});

/**
 * Congestion-status response. Typically per-zone congestion percentages
 * and timestamps. Schema is `z.unknown()` to keep the transport
 * permissive; consumers can narrow at the callsite.
 */
export const CongestionStatusResponseSchema = z.unknown();

export type CongestionStatusRequest = z.infer<typeof CongestionStatusRequestSchema>;
export type CongestionStatusResponse = z.infer<typeof CongestionStatusResponseSchema>;

// === stadium-zones ========================================================

/**
 * Stadium-zones request. Same `p_stadium_id` field as
 * `congestion-status`.
 */
export const StadiumZonesRequestSchema = z.object({
  p_stadium_id: UuidSchema,
});

/**
 * Stadium-zones response. `{zones: [...], geofence: ... | null}`.
 * `zones` element shape is open; `geofence` is the outer stadium polygon
 * (nullable).
 */
export const StadiumZonesResponseSchema = z.object({
  zones: z.array(z.record(z.string(), z.unknown())),
  geofence: z.unknown().nullable(),
});

export type StadiumZonesRequest = z.infer<typeof StadiumZonesRequestSchema>;
export type StadiumZonesResponse = z.infer<typeof StadiumZonesResponseSchema>;

// === stadium-geofences ====================================================

/**
 * Stadium-geofences — GET with API key in `apikey` / `x-api-key` header.
 * No body, no query params.
 */
export const StadiumGeofencesRequestSchema = z.object({});

/**
 * Single geofence row in the stadium-geofences response. The server
 * returns active geofences ordered by name.
 *
 * `boundary` is a GeoJSON geometry — typically a Polygon or MultiPolygon.
 * The SDK schema accepts any JSON value here rather than encoding the
 * full GeoJSON spec; consumers using a GeoJSON-aware library (e.g.,
 * `@types/geojson`) can narrow at the callsite.
 */
export const StadiumGeofenceRowSchema = z
  .object({
    id: UuidSchema,
    org_id: UuidSchema,
    name: z.string(),
    boundary: z.unknown(),
    active: z.boolean(),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .passthrough();

/**
 * Stadium-geofences response. Server returns the RPC array verbatim, or
 * `[]` when null. Each row is a `StadiumGeofenceRow`; `passthrough()`
 * accepts future field additions without breaking.
 */
export const StadiumGeofencesResponseSchema = z.array(StadiumGeofenceRowSchema);

export type StadiumGeofenceRow = z.infer<typeof StadiumGeofenceRowSchema>;
export type StadiumGeofencesRequest = z.infer<typeof StadiumGeofencesRequestSchema>;
export type StadiumGeofencesResponse = z.infer<typeof StadiumGeofencesResponseSchema>;

// === waitboard ============================================================

/**
 * Waitboard — GET with API key. Public wait-time digest endpoint, used by
 * marketing site and unauthenticated displays. No body, no query params.
 */
export const WaitboardRequestSchema = z.object({});

/**
 * Single row in the waitboard array — one venue's current wait + ETA
 * snapshot.
 *
 * Every field is nullable — the underlying ETA snapshot may be missing or
 * stale for venues that haven't reported recently. Clients defensively
 * fall back when fields are null.
 *
 * `conf_label` is `text` server-side without a CHECK constraint; the
 * deployed system writes one of `'High' | 'Medium' | 'Low'` but the schema
 * accepts any string to avoid breaking partners on a future widening.
 */
export const WaitboardRowSchema = z
  .object({
    venue_id: UuidSchema.nullable(),
    venue_name: z.string().nullable(),
    org_id: UuidSchema.nullable(),
    image_url: z.string().nullable(),
    category: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    p50_minutes: z.number().nullable(),
    p80_minutes: z.number().nullable(),
    p90_minutes: z.number().nullable(),
    queue_len: z.number().int().nullable(),
    service_rate_per_min: z.number().nullable(),
    as_of: IsoTimestampSchema.nullable(),
    is_stale: z.boolean().nullable(),
    eta_range: z.string().nullable(),
    conf: z.number().nullable(),
    conf_label: z.string().nullable(),
  })
  .passthrough();

/**
 * Waitboard response — an array of `WaitboardRow` (or `[]`).
 * `passthrough()` accepts future field additions without breaking.
 */
export const WaitboardResponseSchema = z.array(WaitboardRowSchema);

export type WaitboardRow = z.infer<typeof WaitboardRowSchema>;
export type WaitboardRequest = z.infer<typeof WaitboardRequestSchema>;
export type WaitboardResponse = z.infer<typeof WaitboardResponseSchema>;

// === get-profile ==========================================================

/**
 * Get-profile request — empty body, JWT-derived user_id.
 *
 * Marked `.strict()` per the empty-body contract precedent (see
 * `GetCategoriesRequestSchema` JSDoc). Unexpected client fields surface
 * as 400 `validation_failed` with `details.field` set to the unrecognized
 * key — same convention as the preferences/subscription empty-body GETs.
 */
export const GetProfileRequestSchema = z.object({}).strict();

/**
 * Get-profile response. Server returns `{id, email, created_at}` for the
 * authenticated user. Returns 404 `profile_not_found` (raised as
 * `LyntariApiError`, not this schema) when no profile is found. Schema is
 * `passthrough()` so future additions (e.g., `display_name`, `avatar_url`)
 * don't break clients.
 */
export const GetProfileResponseSchema = z
  .object({
    id: UuidSchema,
    email: z.string(),
    created_at: IsoTimestampSchema,
  })
  .passthrough();

export type GetProfileRequest = z.infer<typeof GetProfileRequestSchema>;
export type GetProfileResponse = z.infer<typeof GetProfileResponseSchema>;

// === get-visit-history ====================================================

/**
 * Get-visit-history request. `limit` defaults to 20 and is bounded
 * `[1, 100]`; `offset` defaults to 0 and must be `>= 0`. Server returns
 * 400 `validation_failed` with `details.field` on bounds violations.
 *
 * Reuses `PaginationParamsSchema` from `_common.ts` for consistency with
 * `get-notification-history`.
 */
export const GetVisitHistoryRequestSchema = PaginationParamsSchema;

/**
 * Single visit row in the visit-history response.
 *
 * - `venue_name` is nullable; may be null if the venue record was deleted
 *   after the visit.
 * - `end_ts` is nullable while the visit is open.
 * - `vcs_band` is a literal-union bucketing (or null when no banding is
 *   available for the visit). The wire contract exposes only the bucket;
 *   any underlying numeric is server-internal and not part of the public
 *   surface.
 */
export const VisitHistoryRowSchema = z
  .object({
    visit_id: UuidSchema,
    venue_id: UuidSchema,
    venue_name: z.string().nullable(),
    start_ts: IsoTimestampSchema,
    end_ts: IsoTimestampSchema.nullable(),
    closed_reason: z.string(),
    vcs_band: z.enum(['high', 'medium', 'low']).nullable(),
  })
  .passthrough();

/**
 * Get-visit-history response — `{total_count, visits: [...]}`, the
 * canonical paginated-list wrapper used across the read surface (matches
 * `get-categories`, `get-notification-history`).
 *
 * `passthrough()` on the wrapper accepts future field additions; row
 * shape is `VisitHistoryRow` (see above).
 */
export const GetVisitHistoryResponseSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    visits: z.array(VisitHistoryRowSchema),
  })
  .passthrough();

export type VisitHistoryRow = z.infer<typeof VisitHistoryRowSchema>;
export type GetVisitHistoryRequest = z.infer<typeof GetVisitHistoryRequestSchema>;
export type GetVisitHistoryResponse = z.infer<typeof GetVisitHistoryResponseSchema>;

// === get-notification-history =============================================

/**
 * Get-notification-history request. Same pagination contract as
 * `get-visit-history` — `limit ∈ [1, 100]` (default 20), `offset >= 0`
 * (default 0).
 */
export const GetNotificationHistoryRequestSchema = PaginationParamsSchema;

/**
 * Single notification row in the notification-history response.
 *
 * Server-internal storage fields are deliberately excluded from this row
 * shape. If a future surface needs a field currently held server-side,
 * promote it to the typed projection or to `meta`.
 *
 * Lifecycle timestamps (`sent_at`, `opened_at`, `clicked_at`, `dismissed_at`)
 * are all nullable — populated only when the corresponding lifecycle event
 * fires. `venue_id` / `venue_name` are nullable for non-venue notifications.
 */
export const NotificationHistoryRowSchema = z
  .object({
    id: UuidSchema,
    notification_type: z.string(),
    trigger_type: z.string().nullable(),
    venue_id: UuidSchema.nullable(),
    venue_name: z.string().nullable(),
    title: z.string().nullable(),
    body: z.string().nullable(),
    sent_at: IsoTimestampSchema.nullable(),
    opened_at: IsoTimestampSchema.nullable(),
    clicked_at: IsoTimestampSchema.nullable(),
    dismissed_at: IsoTimestampSchema.nullable(),
    meta: z.record(z.string(), z.unknown()).nullable(),
  })
  .passthrough();

/**
 * Get-notification-history response — `{total_count, notifications: [...]}`,
 * same paginated-list wrapper as `get-visit-history`.
 */
export const GetNotificationHistoryResponseSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    notifications: z.array(NotificationHistoryRowSchema),
  })
  .passthrough();

export type NotificationHistoryRow = z.infer<typeof NotificationHistoryRowSchema>;
export type GetNotificationHistoryRequest = z.infer<typeof GetNotificationHistoryRequestSchema>;
export type GetNotificationHistoryResponse = z.infer<typeof GetNotificationHistoryResponseSchema>;

// === get-categories =======================================================

/**
 * Get-categories request — empty body. Server forwards JWT-derived
 * `user_id` to the RPC for forward-compat with per-tenant category
 * overrides (current v1 RPC ignores it and returns the global list).
 *
 * Marked `.strict()` so that any unexpected client field is rejected with
 * a 400 `validation_failed` rather than silently dropped. The contract is
 * "send `{}` only"; an extra field is a client bug worth surfacing. When
 * the RPC eventually grows real client-supplied parameters, the field is
 * added to the schema deliberately — strict-by-default means the SDK and
 * EF stay in lock-step on the contract.
 */
export const GetCategoriesRequestSchema = z.object({}).strict();

/**
 * Single category row in the get-categories response — `{id,
 * display_name, icon_id, sort_order}`, sorted by `sort_order` ASC.
 *
 * `id` is the stable category identifier consumers key off (e.g., 'pizza',
 * 'sandwiches'); it's intentionally a plain string rather than a UUID.
 * `icon_id` is an opaque server-controlled hint; clients map it (or the
 * `id`) to their own asset.
 */
export const CategoryRowSchema = z
  .object({
    id: z.string(),
    display_name: z.string(),
    icon_id: z.string(),
    sort_order: z.number().int(),
  })
  .passthrough();

/**
 * Get-categories response — `{categories: [...]}` wrapper around an
 * ordered array of `CategoryRow`. Returns 500 `database_error` when the
 * server has no catalog available (defensive — should always return at
 * least `{categories: []}`).
 */
export const GetCategoriesResponseSchema = z
  .object({
    categories: z.array(CategoryRowSchema),
  })
  .passthrough();

export type CategoryRow = z.infer<typeof CategoryRowSchema>;
export type GetCategoriesRequest = z.infer<typeof GetCategoriesRequestSchema>;
export type GetCategoriesResponse = z.infer<typeof GetCategoriesResponseSchema>;
