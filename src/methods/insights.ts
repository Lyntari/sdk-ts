/**
 * Insights operator-flow SDK methods — 2 endpoints (shipped 2026-05-20, cluster #13).
 *
 *   - `recordFeedback` → record-insight-feedback EF → rpc_record_insight_feedback
 *   - `updateLifecycle` → update-insight-lifecycle EF → rpc_update_insight_lifecycle
 *
 * Both are operator-facing (Retool calls these from the insights dashboard).
 * Both require HMAC + JWT; the EF derives p_operator_user_id from the JWT
 * sub claim — caller doesn't supply it.
 */

import type {
  RecordInsightFeedbackRequest,
  RecordInsightFeedbackResponse,
  UpdateInsightLifecycleRequest,
  UpdateInsightLifecycleResponse,
} from '../schemas/index.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface InsightsMethods {
  /**
   * `record-insight-feedback` — operator clicks 👍/👎 on an insight.
   * `reason_code` validated server-side against `ops.config.insight_feedback_reason_codes`.
   * `notes` is free-form operator context. Returns the new
   * `ml.insight_feedback.id`.
   */
  recordFeedback(input: RecordInsightFeedbackRequest): Promise<RecordInsightFeedbackResponse>;

  /**
   * `update-insight-lifecycle` — operator transitions an insight through
   * the state machine (`acknowledge` / `act` / `dismiss`).
   * `action_taken_text` is required when `action='act'` (server raises
   * `rpc_validation_failed` otherwise). Idempotent re-state on
   * `acknowledge` (acknowledged → acknowledge is a no-op).
   */
  updateLifecycle(
    input: UpdateInsightLifecycleRequest,
  ): Promise<UpdateInsightLifecycleResponse>;
}

export function createInsightsMethods(
  config: ClientConfig,
  state: ClientState,
): InsightsMethods {
  return {
    recordFeedback: async (input) =>
      postWithHMAC<RecordInsightFeedbackResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'record-insight-feedback',
        body: input,
        ...jwtCallOpts(state, 'record-insight-feedback'),
        idempotencyKey: null,
      }),

    updateLifecycle: async (input) =>
      postWithHMAC<UpdateInsightLifecycleResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'update-insight-lifecycle',
        body: input,
        ...jwtCallOpts(state, 'update-insight-lifecycle'),
        idempotencyKey: null,
      }),
  };
}
