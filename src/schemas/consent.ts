/**
 * Consent-flow EF schemas — 2 endpoints (cluster #65, mandate §4.13):
 *   - `consent-get` (POST, HMAC + JWT, empty body) — read the user's consent map
 *   - `consent-set` (POST, HMAC + JWT, idempotency) — grant / one-tap revoke one consent
 *
 * Both are consumer-facing; the user is JWT-derived (the SDK caller doesn't
 * supply a user id). Opt-in / one-tap opt-out is the same `consent-set` call with
 * `granted: true` / `granted: false`. `consent_type` values are public wire
 * contract (no proprietary internals).
 */

import { z } from 'zod';

// === shared shapes ========================================================

/**
 * Allowed consent types. Public wire contract — expandable server-side via the
 * `app.user_consent` CHECK constraint; the SDK pins the current set (a server
 * widening is a deliberate SDK bump).
 *
 * - `notifications` — push / in-app notification delivery
 * - `personalization` — ABO personalized recommendations (the gate the
 *   recommendations surface checks)
 * - `profile_vectors` — pseudonymous behavioral profile-vector retention
 * - `cross_venue` — profile portability across venues (also mirrored to the
 *   cross-venue portability flag server-side)
 */
export const ConsentTypeSchema = z.enum([
  'notifications',
  'personalization',
  'profile_vectors',
  'cross_venue',
]);

/** One consent record's state. Timestamps are ISO-8601 (nullable). */
export const ConsentEntrySchema = z.object({
  granted: z.boolean(),
  granted_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

/**
 * The consent map — `consent_type` → its current state. Absent keys mean the
 * user has never set that consent (treated as not-granted). Open record so a
 * server-side consent-type addition doesn't trip SDK validation.
 */
export const ConsentStateSchema = z.record(z.string(), ConsentEntrySchema);

// === consent-get ==========================================================

/**
 * Consent-get request — empty body, JWT-derived user. `.strict()` per the
 * empty-body contract precedent (unexpected client fields → 400 validation_failed).
 */
export const GetConsentRequestSchema = z.object({}).strict();

/** Consent-get response — `{consent: <map>}`. */
export const GetConsentResponseSchema = z.object({
  consent: ConsentStateSchema,
});

export type GetConsentRequest = z.infer<typeof GetConsentRequestSchema>;
export type GetConsentResponse = z.infer<typeof GetConsentResponseSchema>;

// === consent-set ==========================================================

/**
 * Consent-set request — grant or revoke one consent type. `granted: true` is
 * opt-in; `granted: false` is the one-tap opt-out. Latest-state upsert
 * server-side. Idempotent (re-setting the same value is a no-op).
 */
export const SetConsentRequestSchema = z.object({
  consent_type: ConsentTypeSchema,
  granted: z.boolean(),
});

/** Consent-set response — the full updated `{consent: <map>}`. */
export const SetConsentResponseSchema = z.object({
  consent: ConsentStateSchema,
});

export type SetConsentRequest = z.infer<typeof SetConsentRequestSchema>;
export type SetConsentResponse = z.infer<typeof SetConsentResponseSchema>;
