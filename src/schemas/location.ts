/**
 * Location-flow EF schemas — 4 endpoints:
 *   - `nearby-venues` (POST, HMAC + JWT) — venue discovery by lat/lng
 *   - `location-update` (POST, HMAC + JWT, idempotency) — push current location
 *   - `beacon-detection` (POST, HMAC + JWT, idempotency) — record beacon RSSI sample
 *   - `beacon-config` (GET, API key header) — fetch beacon catalog for the deployment
 *
 * Notable contract details:
 *
 * - **`location-update` triggers a downstream notification-eligibility
 *   check** server-side when the server determines the user is in a
 *   stadium. The cascade is fire-and-forget — clients see a normal
 *   location-update response shape and don't need to model the cascade.
 *
 * - **`nearby-venues` body is `{latitude, longitude, radius_meters?}`**.
 *   `radius_meters` defaults server-side when omitted.
 *
 * - **`beacon-detection`** accepts iBeacon-shaped fields (`beacon_uuid`,
 *   `major`, `minor`, `rssi?`, `distance?`, `timestamp_ms?`). `user_id` is
 *   JWT-derived; if `timestamp_ms` is omitted, the server defaults it.
 *
 * - **`beacon-config` is a GET with no body and no query params** —
 *   `apikey` header carries auth, deployment scoping is server-side.
 *   Response is an array; element shape is open.
 *
 * - All response payloads are passed through verbatim from server output.
 *   Schemas use `passthrough()` / `z.record(z.string(), z.unknown())` to
 *   avoid over-tightening against undocumented future fields.
 */

import { z } from 'zod';
import {
  LatitudeSchema,
  LongitudeSchema,
  TimestampMsSchema,
  UuidSchema,
} from './_common.js';

// === nearby-venues ========================================================

/**
 * Nearby-venues request. `radius_meters` is optional; the server omits it
 * from the RPC body when not provided, and the RPC supplies its own default.
 * Server returns 400 `missing_required_fields` if `latitude` / `longitude`
 * are absent.
 */
export const NearbyVenuesRequestSchema = z.object({
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  radius_meters: z.number().positive().optional(),
});

/**
 * Nearby-venues response — array of venue rows.
 *
 * **Three-state stadium-presence semantic** (server-derived; load-bearing for
 * the mobile in-stadium gate as of `@lyntari/sdk` v0.3.0):
 *
 *   - `[]`                                       → the caller's `(latitude,
 *                                                  longitude)` is not inside
 *                                                  any active stadium polygon.
 *   - `[{ ..., current_stadium_id: <uuid> }, ...]` → caller is inside that
 *                                                  stadium. Every row carries
 *                                                  the same `current_stadium_id`
 *                                                  because the underlying RPC
 *                                                  filters rows to that
 *                                                  stadium's bound venues.
 *
 * Element shape is open (`passthrough()`); `current_stadium_id` is documented
 * but its presence is conditional on the response being non-empty. Other
 * fields (`id`, `name`, `distance`, `wait_time_minutes`, etc.) pass through
 * verbatim and are not validated here.
 *
 * Wire compatibility: this is additive on the wire. Callers iterating the
 * array continue to work — the typed `current_stadium_id` field is the only
 * new typed addition.
 */
export const NearbyVenuesResponseSchema = z.array(
  z
    .object({
      current_stadium_id: UuidSchema.optional(),
    })
    .passthrough(),
);

export type NearbyVenuesRequest = z.infer<typeof NearbyVenuesRequestSchema>;
export type NearbyVenuesResponse = z.infer<typeof NearbyVenuesResponseSchema>;

// === location-update ======================================================

/**
 * Location-update request. `accuracy` is optional (GPS accuracy radius in
 * meters); `timestamp_ms` is optional and defaults to server-side `Date.now()`
 * when omitted. `user_id` is JWT-derived — never included in the body.
 *
 * The EF wraps the RPC call in the idempotency layer; clients should pass an
 * `Idempotency-Key` header (the SDK transport injects it automatically) for
 * safe retries on flaky networks.
 */
export const LocationUpdateRequestSchema = z.object({
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  accuracy: z.number().nonnegative().optional(),
  timestamp_ms: TimestampMsSchema.optional(),
});

/**
 * Location-update response. The known field `in_stadium: boolean`
 * triggers a server-side downstream notification check when true —
 * clients don't need to react to this directly. Other fields (current
 * zone, distance, etc.) pass through verbatim.
 *
 * Schema is `passthrough()` to accept future RPC additions without breaking.
 */
export const LocationUpdateResponseSchema = z
  .object({
    in_stadium: z.boolean().optional(),
  })
  .passthrough();

export type LocationUpdateRequest = z.infer<typeof LocationUpdateRequestSchema>;
export type LocationUpdateResponse = z.infer<typeof LocationUpdateResponseSchema>;

// === beacon-detection =====================================================

/**
 * Beacon-detection request — iBeacon sample with optional RSSI/distance.
 * `beacon_uuid`, `major`, `minor` are required (server returns 400
 * `missing_required_fields` otherwise). `rssi` and `distance` are optional;
 * the server stores them as-is. `timestamp_ms` defaults server-side.
 *
 * Wrapped in the idempotency layer — same retry-safety guarantees as
 * `location-update`.
 */
export const BeaconDetectionRequestSchema = z.object({
  beacon_uuid: UuidSchema,
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  rssi: z.number().optional(),
  distance: z.number().nonnegative().optional(),
  timestamp_ms: TimestampMsSchema.optional(),
});

/**
 * Beacon-detection response.
 *
 * Three response shapes the client may see:
 *
 *  1. **Unknown beacon** — the iBeacon triple doesn't match any active
 *     beacon. Returns
 *     `{should_prompt: false, reason: 'unknown_beacon', venue_id: null, band: null}`.
 *  2. **Known beacon, no prompt** — the band is out-of-range, the user
 *     already has an active visit at the venue, or a server-side gate
 *     declined. Returns
 *     `{should_prompt: false, reason: <reason>, venue_id, band}`.
 *     Known `reason` values include `'out_of_band'`,
 *     `'active_visit_at_venue'`, `'cooldown_active'`, `'not_in_stadium'`.
 *  3. **Known beacon, prompt** — band is `immediate` or `near`, no active
 *     visit, no gate declined. Returns
 *     `{should_prompt: true, reason: null, venue_id, band}`. Client
 *     should subsequently call `notifications.trigger` with
 *     `trigger_type: 'beacon'`.
 *
 * `band` is one of `'immediate' | 'near' | 'far' | 'unknown'` (or `null`
 * on the unknown-beacon branch). `reason` is a free-form string when
 * non-null so the server can introduce new gate-decline codes without
 * breaking partners. Server-side side effects are transparent to the
 * caller.
 */
export const BeaconDetectionResponseSchema = z
  .object({
    should_prompt: z.boolean(),
    reason: z.string().nullable(),
    venue_id: UuidSchema.nullable(),
    band: z.enum(['immediate', 'near', 'far', 'unknown']).nullable(),
  })
  .passthrough();

export type BeaconDetectionRequest = z.infer<typeof BeaconDetectionRequestSchema>;
export type BeaconDetectionResponse = z.infer<typeof BeaconDetectionResponseSchema>;

// === beacon-config ========================================================

/**
 * Beacon-config — GET with API key in `apikey` / `x-api-key` header. No
 * request body, no query params: deployment scoping is server-side (the
 * anon-key role is bound to a single Supabase project).
 *
 * Request schema is empty by design; included for symmetry with the other
 * endpoints and OpenAPI generation.
 */
export const BeaconConfigRequestSchema = z.object({});

/**
 * Beacon-config response. Server returns the beacon-config array
 * verbatim, or `[]` when the deployment has no beacons. Element shape is
 * RPC-defined.
 */
export const BeaconConfigResponseSchema = z.array(z.record(z.string(), z.unknown()));

export type BeaconConfigRequest = z.infer<typeof BeaconConfigRequestSchema>;
export type BeaconConfigResponse = z.infer<typeof BeaconConfigResponseSchema>;
