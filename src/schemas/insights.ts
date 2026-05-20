/**
 * Insights operator-flow EF schemas — 2 endpoints (shipped 2026-05-20, cluster #13):
 *   - `record-insight-feedback` (POST, HMAC + JWT) — operator 👍/👎 with reason code
 *   - `update-insight-lifecycle` (POST, HMAC + JWT) — acknowledge / act / dismiss
 *
 * Both are operator-facing EFs called from Retool (and any other future operator
 * console). Both wrap cluster #7 RPCs (`rpc_record_insight_feedback`,
 * `rpc_update_insight_lifecycle`). p_operator_user_id is JWT-derived; the EF
 * passes `jwtSub` so the SDK caller doesn't need to supply it.
 *
 * **Vendoring status (cluster #13 deferral):** the deployed EFs use INLINE Zod
 * schemas that mirror the shapes here. The schema-vendoring drift gate
 * (per CLAUDE.md "Source of truth") is deferred until the next sdk-ts release
 * cycle generates vendored copies via `docs/agent-tools/vendor-schemas.ts`.
 * Until then, treat these schemas + the EF inline schemas as a manually-kept
 * pair. Pre-prod-promotion only; no prod consumer drift risk.
 */

import { z } from 'zod';
import { UuidSchema } from './_common.js';

// === record-insight-feedback ==============================================

/**
 * Record-insight-feedback request. Operator clicks 👍 (useful) or 👎
 * (not_useful) on an `ops.insights` row; optionally provides a reason_code
 * (server validates against `ops.config.insight_feedback_reason_codes`)
 * and free-form notes.
 *
 * `insight_id` — FK to ops.insights.id. Server raises 23503 if not found.
 * `sentiment` — 'useful' or 'not_useful'. Server raises 22023 if other.
 * `reason_code` — optional; if present, must be in the seeded allowed set
 *   ('not_relevant', 'wrong_location', 'too_late', 'wrong_recommendation',
 *   'wrong_target', 'staff_unavailable', 'stale_data', 'other'). Server
 *   validates against ops.config, raises 22023 on mismatch.
 * `notes` — optional free-form text (operator-context). No length cap server-side.
 */
export const RecordInsightFeedbackRequestSchema = z.object({
  insight_id: UuidSchema,
  sentiment: z.enum(['useful', 'not_useful']),
  reason_code: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

/**
 * Record-insight-feedback response: `{feedback_id: uuid}`. The new
 * `ml.insight_feedback.id`. Wrapped by the EF (`rpc_record_insight_feedback`
 * returns the uuid as a bare JSON value).
 */
export const RecordInsightFeedbackResponseSchema = z.object({
  feedback_id: UuidSchema,
});

export type RecordInsightFeedbackRequest = z.infer<typeof RecordInsightFeedbackRequestSchema>;
export type RecordInsightFeedbackResponse = z.infer<typeof RecordInsightFeedbackResponseSchema>;

// === update-insight-lifecycle ==============================================

/**
 * Update-insight-lifecycle request. Operator transitions an `ops.insights`
 * row through the state machine:
 *
 *   fresh → {acknowledge, act, dismiss}
 *   acknowledged → {act, dismiss}
 *   acted (terminal)
 *   dismissed (terminal)
 *
 * Idempotent re-state on `acknowledge` (acknowledged → acknowledge is a no-op,
 * not an error). Terminal-state transitions raise 22023.
 *
 * `insight_id` — FK to ops.insights.id. Server raises 23503 if not found.
 * `action` — 'acknowledge' | 'act' | 'dismiss'. Server raises 22023 on other values.
 * `action_taken_text` — REQUIRED when action='act' (server raises 22023 otherwise);
 *   IGNORED when action='acknowledge' or 'dismiss'.
 */
export const UpdateInsightLifecycleRequestSchema = z.object({
  insight_id: UuidSchema,
  action: z.enum(['acknowledge', 'act', 'dismiss']),
  action_taken_text: z.string().nullable().optional(),
});

/**
 * Update-insight-lifecycle response: `{ok: true, insight_id, action}` on
 * success. The RPC itself returns void; the EF wraps with a confirmation
 * envelope for client clarity.
 */
export const UpdateInsightLifecycleResponseSchema = z.object({
  ok: z.literal(true),
  insight_id: UuidSchema,
  action: z.enum(['acknowledge', 'act', 'dismiss']),
});

export type UpdateInsightLifecycleRequest = z.infer<typeof UpdateInsightLifecycleRequestSchema>;
export type UpdateInsightLifecycleResponse = z.infer<typeof UpdateInsightLifecycleResponseSchema>;
