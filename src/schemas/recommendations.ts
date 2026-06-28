/**
 * Recommendations EF schema — 1 endpoint (cluster #65, mandate §4.13):
 *   - `recommendations` (POST, HMAC + JWT) — personalized ABO recommendations
 *     for a venue, gated by the two-level ABO gate + personalization consent +
 *     the #69 no-minors gate.
 *
 * **Backend/API-ready, not a live product.** Pre-funding (before the #67 consumer
 * recommender ships), `items` is `[]` and `abo_eligibility.enabled` reflects the
 * gate — an honest empty payload, not an error. The shape is the funded-exposure
 * seam.
 *
 * **SDK boundary:** `items` are opaque ranked entries (interpreted per
 * `recommendation_type`); `explanation_token` is an opaque server-issued token
 * that maps to canned operator copy server-side — no model names, feature names,
 * thresholds, or internal identifiers cross this contract.
 */

import { z } from 'zod';
import { UuidSchema } from './_common.js';

/**
 * ABO eligibility block. `enabled` is the effective gate (org `abo_enabled` AND
 * user `abo_user_eligible` AND personalization consent AND not minor-suppressed).
 * `reason` names the first failing gate when disabled
 * (`org_disabled` | `user_ineligible` | `no_consent` | `cohort_gate`), `null`
 * when enabled.
 */
export const AboEligibilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
});

/** One opaque ranked item. Interpreted per `recommendation_type`; structure is server-defined. */
export const RecommendationItemSchema = z.record(z.string(), z.unknown());

// === recommendations ======================================================

/** Recommendations request — recs for the given venue. JWT-derived user. */
export const GetRecommendationsRequestSchema = z.object({
  venue_id: UuidSchema,
});

/**
 * Recommendations response — the V2 §4.6 recommendation payload + the ABO
 * eligibility block. When `abo_eligibility.enabled` is `false` (or no recs yet),
 * `items` is `[]` and the recommendation fields are `null`.
 *
 * - `recommendation_id` — id of the recommendation set (null when none).
 * - `recommendation_type` — opaque category string (null when none).
 * - `items` — opaque ranked list (empty when none / ineligible).
 * - `score` / `confidence` — overall set score + confidence (null when none).
 * - `valid_until` — ISO-8601 expiry (null when none).
 * - `explanation_token` — opaque token mapping to canned copy server-side (null when none).
 */
export const GetRecommendationsResponseSchema = z.object({
  recommendation_id: UuidSchema.nullable(),
  user_id: UuidSchema.nullable(),
  venue_id: UuidSchema,
  recommendation_type: z.string().nullable(),
  items: z.array(RecommendationItemSchema),
  score: z.number().nullable(),
  confidence: z.number().nullable(),
  valid_until: z.string().nullable(),
  explanation_token: z.string().nullable(),
  abo_eligibility: AboEligibilitySchema,
});

export type GetRecommendationsRequest = z.infer<typeof GetRecommendationsRequestSchema>;
export type GetRecommendationsResponse = z.infer<typeof GetRecommendationsResponseSchema>;
