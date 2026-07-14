/**
 * Operator server-to-server SDK methods — 3 endpoints (cluster #89, §36.2).
 *
 *   - `manageApiKeys` → `manage-api-keys` EF (HMAC + operator JWT) — issue /
 *     rotate / revoke the org's own partner API keys. The raw key is returned
 *     once on issue/rotate.
 *   - `insights` / `recommendations` → `operator-insights` /
 *     `operator-recommendations` EFs — read the org's persona-packaged insights
 *     and staffing recommendations, authenticated by a per-partner API key (not
 *     the consumer HMAC key). The key is bound to one org server-side.
 *
 * The two read methods take the partner API key as their first argument — it is
 * a distinct credential from the client's consumer `apiKey`, issued via
 * `manageApiKeys({ action: 'issue' })`.
 */

import type {
  ManageApiKeyRequest,
  ManageApiKeyResponse,
  OperatorReadRequest,
  OperatorInsightsResponse,
  OperatorRecommendationsResponse,
} from '../schemas/index.js';
import { postWithHMAC } from '../transport/post.js';
import { postWithApiKey } from '../transport/postApiKey.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface OperatorMethods {
  /**
   * `manage-api-keys` — issue / rotate / revoke this org's partner API keys.
   * HMAC + operator JWT (the org is the JWT `sub`). `issue` and `rotate` return
   * `{ key }` with the raw `api_key` exactly once; `revoke` returns `{ revoked }`.
   */
  manageApiKeys(input: ManageApiKeyRequest): Promise<ManageApiKeyResponse>;

  /**
   * `operator-insights` — the org's persona-packaged insights. Authenticated by
   * a partner API key (first arg). A `target_org` that isn't the key's own org
   * is rejected with `org_access_denied`.
   */
  insights(partnerApiKey: string, input?: OperatorReadRequest): Promise<OperatorInsightsResponse>;

  /**
   * `operator-recommendations` — the org's staffing recommendations.
   * Authenticated by a partner API key (first arg).
   */
  recommendations(partnerApiKey: string, input?: OperatorReadRequest): Promise<OperatorRecommendationsResponse>;
}

export function createOperatorMethods(
  config: ClientConfig,
  state: ClientState,
): OperatorMethods {
  return {
    manageApiKeys: async (input) =>
      postWithHMAC<ManageApiKeyResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'manage-api-keys',
        body: input,
        ...jwtCallOpts(state, 'manage-api-keys'),
        idempotencyKey: null,
      }),

    insights: async (partnerApiKey, input = {}) =>
      postWithApiKey<OperatorInsightsResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-insights',
        apiKey: partnerApiKey,
        body: input,
      }),

    recommendations: async (partnerApiKey, input = {}) =>
      postWithApiKey<OperatorRecommendationsResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-recommendations',
        apiKey: partnerApiKey,
        body: input,
      }),
  };
}
