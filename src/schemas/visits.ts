/**
 * Visit-flow EF schemas — 4 endpoints:
 *   - `visit-signals` (POST, HMAC + JWT) — record a client-emitted signal
 *   - `pos-close` (POST, HMAC + JWT) — venue-side close-out, JWT-derived user
 *   - `pos-current-visits` (GET, POS API key) — venue-bound list of open visits
 *   - `congestion-history` (POST, API key in body, no HMAC) — admin-style history
 *
 * Notable contract details:
 *
 * - **visit-signals is NOT a discriminated union from the client's perspective.**
 *   The server accepts `signal_type: string` without enum enforcement, but
 *   the only client-emittable value is `manual_checkin`. `pos_mark` is
 *   server-emitted via `pos-close`; `beacon_proximity` / `beacon_exit` are
 *   reserved server-emitted values. The schema therefore uses
 *   `z.literal('manual_checkin')` to reject anything else at SDK boundary —
 *   widening this is a deliberate decision.
 *
 * - **pos-current-visits** is a GET authenticated by a per-deployment
 *   POS credential carried in the `apikey` / `x-api-key` header. The
 *   credential IS the venue scope — no `venue_id` query param. The
 *   credential differs from the consumer API key.
 *
 * - **congestion-history** uses API-key-in-body auth (`_auth.apiKey`,
 *   no HMAC, no JWT). Schema is authored against the contract; calling
 *   the endpoint requires a `postWithApiKey` transport primitive that doesn't
 *   exist in the SDK yet.
 *
 * - Both `visit-signals` and `pos-close` strip `meta.org_id` server-side
 *   (defensive — server derives `org_id` from `venue_id`). Don't include it.
 */

import { z } from 'zod';
import { TimestampMsSchema, UuidSchema } from './_common.js';

// === visit-signals ========================================================

/**
 * Visit signal request. Optional body-level `idempotency_key` provides
 * server-side dedup keyed by that value; this is distinct from the
 * `Idempotency-Key` HTTP header managed by the SDK transport. Clients
 * almost always want the header (transport injects it). The body field
 * is exposed for callers that need an explicit dedup key.
 */
export const VisitSignalsRequestSchema = z.object({
  venue_id: UuidSchema,
  signal_type: z.literal('manual_checkin'),
  timestamp_ms: TimestampMsSchema,
  meta: z.record(z.string(), z.unknown()).optional(),
  idempotency_key: z.string().optional(),
});

/**
 * Visit signal response. The server returns one of two outcomes:
 *   - `{ status: 200, result: 'accepted', request_id }` — new signal recorded
 *   - `{ status: 200, result: 'duplicate', request_id }` — server-side
 *     idempotency dedup hit (same `idempotency_key` body field).
 *
 * Both are HTTP 200 — the result string is the actual outcome.
 */
export const VisitSignalsResponseSchema = z.object({
  status: z.literal(200),
  result: z.enum(['accepted', 'duplicate']),
  request_id: z.string(),
});

export type VisitSignalsRequest = z.infer<typeof VisitSignalsRequestSchema>;
export type VisitSignalsResponse = z.infer<typeof VisitSignalsResponseSchema>;

// === pos-close ============================================================

/**
 * POS-close request. Server reads `venue_id` + `timestamp_ms` + optional
 * `meta`; user_id is derived from JWT, org_id from venue_id (defensively
 * stripped from `meta`).
 */
export const PosCloseRequestSchema = z.object({
  venue_id: UuidSchema,
  timestamp_ms: TimestampMsSchema,
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POS-close response. Documented shape is `{success, visit_id,
 * order_id}`, but the server spreads its result without enforcement.
 * Schema is `passthrough()` to avoid over-tightening against undocumented
 * future fields.
 */
export const PosCloseResponseSchema = z
  .object({
    success: z.boolean(),
    visit_id: UuidSchema,
    order_id: z.string(),
  })
  .passthrough();

export type PosCloseRequest = z.infer<typeof PosCloseRequestSchema>;
export type PosCloseResponse = z.infer<typeof PosCloseResponseSchema>;

// === pos-current-visits ===================================================

/**
 * POS current visits — GET with POS credential (venue-bound API key in
 * `apikey` / `x-api-key` header). No request body, no query params: the
 * credential lookup yields the venue scope.
 *
 * The request schema is empty by design; included for symmetry with the
 * other endpoints and OpenAPI generation.
 */
export const PosCurrentVisitsRequestSchema = z.object({});

/**
 * POS current visits response — an array of current visits (or `[]`).
 * Element shape is server-defined and not enforced — schema accepts any
 * object.
 */
export const PosCurrentVisitsResponseSchema = z.array(z.record(z.string(), z.unknown()));

export type PosCurrentVisitsRequest = z.infer<typeof PosCurrentVisitsRequestSchema>;
export type PosCurrentVisitsResponse = z.infer<typeof PosCurrentVisitsResponseSchema>;

// === congestion-history ===================================================

/**
 * Congestion history request.
 *
 * Required: `p_stadium_id`. Optional: `p_zone_id`, `p_from`, `p_to`
 * (all ISO-8601 timestamps when present).
 */
export const CongestionHistoryRequestSchema = z.object({
  p_stadium_id: UuidSchema,
  p_zone_id: UuidSchema.optional(),
  p_from: z.string().optional(),
  p_to: z.string().optional(),
});

/**
 * Congestion history response. Element shape is server-defined; schema
 * accepts any value to keep the transport layer permissive.
 */
export const CongestionHistoryResponseSchema = z.unknown();

export type CongestionHistoryRequest = z.infer<typeof CongestionHistoryRequestSchema>;
export type CongestionHistoryResponse = z.infer<typeof CongestionHistoryResponseSchema>;
