/**
 * Insights operator-flow EF schemas — 2 endpoints:
 *   - `record-insight-feedback` (POST, HMAC + JWT) — operator 👍/👎 with reason code
 *   - `update-insight-lifecycle` (POST, HMAC + JWT) — acknowledge / act / dismiss
 *
 * Both are operator-facing EFs called from Retool (and any other future operator
 * console). The operator user is derived from the authenticated session; the
 * SDK caller doesn't supply it.
 */

import { z } from 'zod';
import { UuidSchema } from './_common.js';

// === record-insight-feedback ==============================================

/**
 * Record-insight-feedback request. Operator clicks 👍 (useful) or 👎
 * (not_useful) on an insight; optionally provides a reason_code
 * (server-validated against the allowed-codes registry)
 * and free-form notes.
 *
 * `insight_id` — UUID of the target insight. Server returns 400 `rpc_validation_failed` if not found.
 * `sentiment` — 'useful' or 'not_useful'. Server returns 400 `rpc_validation_failed` on other values.
 * `reason_code` — optional; if present, must be one of the allowed values:
 *   'not_relevant', 'wrong_location', 'too_late', 'wrong_recommendation',
 *   'wrong_target', 'staff_unavailable', 'stale_data', 'other'. Server
 *   returns 400 `rpc_validation_failed` on mismatch.
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
 * feedback row's id.
 */
export const RecordInsightFeedbackResponseSchema = z.object({
  feedback_id: UuidSchema,
});

export type RecordInsightFeedbackRequest = z.infer<typeof RecordInsightFeedbackRequestSchema>;
export type RecordInsightFeedbackResponse = z.infer<typeof RecordInsightFeedbackResponseSchema>;

// === update-insight-lifecycle ==============================================

/**
 * Update-insight-lifecycle request. Operator transitions an insight
 * through the state machine:
 *
 *   fresh → {acknowledge, act, dismiss}
 *   acknowledged → {act, dismiss}
 *   acted (terminal)
 *   dismissed (terminal)
 *
 * Idempotent re-state on `acknowledge` (acknowledged → acknowledge is a no-op,
 * not an error). Terminal-state transitions return 400 `rpc_validation_failed`.
 *
 * `insight_id` — UUID of the target insight. Server returns 400 `rpc_validation_failed` if not found.
 * `action` — 'acknowledge' | 'act' | 'dismiss'. Server returns 400 `rpc_validation_failed` on other values.
 * `action_taken_text` — REQUIRED when action='act' (server returns 400 `rpc_validation_failed` otherwise);
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
