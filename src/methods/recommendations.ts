/**
 * Recommendations SDK method — 1 endpoint (cluster #65, mandate §4.13).
 *
 *   - `get({ venue_id })` → recommendations EF — personalized ABO
 *     recommendations for a venue, gated by the two-level ABO gate +
 *     personalization consent + the #69 no-minors gate.
 *
 * Consumer-facing, HMAC + JWT; the user is JWT-derived. Pre-funding (before
 * the #67 consumer recommender ships) this returns an honest empty payload —
 * `items: []` with `abo_eligibility` reflecting the gate — not an error.
 *
 * SDK boundary: `items` are opaque ranked entries and `explanation_token` is an
 * opaque server-issued token. No model names, feature names, thresholds, or
 * internal identifiers cross this method.
 */

import type {
  GetRecommendationsRequest,
  GetRecommendationsResponse,
} from '../schemas/index.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface RecommendationsMethods {
  /**
   * `recommendations` — personalized ABO recommendations for `venue_id`.
   * Returns the recommendation set plus an `abo_eligibility` block naming the
   * gate state. Empty payload (`items: []`) when ineligible or pre-funding.
   */
  get(input: GetRecommendationsRequest): Promise<GetRecommendationsResponse>;
}

export function createRecommendationsMethods(
  config: ClientConfig,
  state: ClientState,
): RecommendationsMethods {
  return {
    get: async (input) =>
      postWithHMAC<GetRecommendationsResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'recommendations',
        body: input,
        ...jwtCallOpts(state, 'recommendations'),
        idempotencyKey: null,
      }),
  };
}
