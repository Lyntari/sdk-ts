/**
 * Shared Zod primitives reused across every endpoint schema.
 *
 * This file is the foundation for `auth.ts`, `visits.ts`, `location.ts`,
 * `notifications.ts`, and `reads.ts`. It captures:
 *
 * - **`AuthBlockSchema`** — the `_auth` body field (apiKey + timestamp +
 *   signature + optional JWT) that the transport layer injects into every
 *   POST. Authored EF request schemas use `withAuth(schema)` to extend
 *   themselves with `_auth` for OpenAPI documentation purposes; the actual
 *   transport in `src/transport/post.ts` adds the field at send time.
 * - **`ErrorEnvelopeSchema`** — the canonical server error response, mirroring
 *   `ErrorEnvelope` in `src/transport/errors.ts`. Used by every EF response
 *   spec to document the non-2xx shape.
 * - **`PaginationParamsSchema`** — `limit` (1–100) + `offset` (≥0) used by
 *   `get-visit-history` and `get-notification-history`. Server-side defaults
 *   (limit=20, offset=0) are documented but not encoded — server is canonical.
 * - **Primitives** — `UuidSchema`, `IsoTimestampSchema`, `TimestampMsSchema`,
 *   `EmailSchema`, `LatitudeSchema`, `LongitudeSchema`. Each is reused
 *   verbatim; if the server widens (e.g. accepts non-strict ISO-8601), the
 *   primitive widens once here, not 30 times across endpoint files.
 */

import { z } from 'zod';

// === Primitives ============================================================

/** Server-validated UUID v4. Used for venue_id, user_id, visit_id, etc. */
export const UuidSchema = z.string().uuid();

/**
 * ISO 8601 timestamp string, e.g. `2024-05-06T15:00:00.000Z`. Server returns
 * these for `created_at`, `start_ts`, `expires_at`, etc. Strict by default
 * (`.datetime()` requires a timezone designator).
 */
export const IsoTimestampSchema = z.string().datetime();

/**
 * Epoch milliseconds — the canonical timestamp for client-emitted signals
 * (`visit-signals`, `location-update`, `beacon-detection`,
 * `notification-event`). Server reads `timestamp_ms` only.
 */
export const TimestampMsSchema = z.number().int().nonnegative();

/** Email address. Server runs additional validation; this is a syntactic guard. */
export const EmailSchema = z.string().email();

/** Geo latitude in degrees, [-90, 90]. */
export const LatitudeSchema = z.number().min(-90).max(90);

/** Geo longitude in degrees, [-180, 180]. */
export const LongitudeSchema = z.number().min(-180).max(180);

// === Auth block ============================================================

/**
 * `_auth` block embedded by the transport layer in every authenticated POST
 * body. SDK callers never construct this — `postWithHMAC` injects it. It is
 * exposed as a Zod schema solely so OpenAPI generation can document the
 * server-visible body shape.
 *
 * The `token` (JWT access token) is omitted on auth-flow EFs that issue it
 * (`consumer-login`, `consumer-signup`, `auth-refresh`) and on the small set
 * of EFs that take HMAC-only auth (`auth-logout`, `reset-password`).
 */
export const AuthBlockSchema = z.object({
  apiKey: z.string(),
  timestamp: z.string(),
  signature: z.string(),
  token: z.string().optional(),
});

/**
 * Wrap a request body schema with the server-injected `_auth` field for
 * OpenAPI documentation. SDK callers do NOT pass `_auth` — the transport
 * layer adds it. This helper makes the dual reality explicit:
 *
 *   - The exported public input type for the SDK method is the inner schema.
 *   - The OpenAPI request body documents the schema returned by `withAuth`.
 *
 * Return type is inferred from `ZodObject.extend` — the resulting shape is
 * `T & { _auth: typeof AuthBlockSchema }`, but spelling it out as an
 * explicit annotation runs into Zod's internal `extendShape` helper, which
 * isn't structurally identical to plain intersection. Inference matches
 * cleanly.
 */
export function withAuth<T extends z.ZodRawShape>(shape: z.ZodObject<T>) {
  return shape.extend({ _auth: AuthBlockSchema });
}

// === Error envelope ========================================================

/**
 * Canonical server error response. Every non-2xx response from any EF is
 * shaped this way. Mirrors `ErrorEnvelope` in `src/transport/errors.ts` —
 * the transport layer parses this and throws a typed `LyntariApiError`
 * subclass per `error.code`.
 */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string(),
    details: z.unknown().optional(),
    retry_safe: z.boolean().optional(),
    terminal_for_auth: z.boolean().optional(),
  }),
});

// === Pagination ============================================================

/**
 * Pagination query params for paginated EFs (`get-visit-history`,
 * `get-notification-history`). Server-side defaults: `limit=20`, `offset=0`.
 * Server returns `validation_failed` if `limit ∉ [1, 100]` or `offset < 0`.
 */
export const PaginationParamsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

// === Auth tokens ===========================================================

/**
 * Common shape returned by `consumer-login` and `consumer-signup`. Note
 * `expires_at` is an ISO-8601 string; convert to ms at the boundary if
 * needed.
 */
export const AccessTokenPairSchema = z.object({
  token: z.string(),
  refresh_token: z.string(),
  user_id: UuidSchema,
  expires_at: IsoTimestampSchema,
});

// === Type aliases ==========================================================

export type AuthBlock = z.infer<typeof AuthBlockSchema>;
export type ErrorEnvelopeShape = z.infer<typeof ErrorEnvelopeSchema>;
export type PaginationParams = z.infer<typeof PaginationParamsSchema>;
export type AccessTokenPair = z.infer<typeof AccessTokenPairSchema>;
