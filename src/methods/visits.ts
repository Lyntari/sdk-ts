/**
 * Visit-flow SDK methods — 4 endpoints across three auth modes.
 *
 * - `recordSignal` (visit-signals): HMAC + JWT, idempotent. Client emits
 *   `manual_checkin`; other signal types are server-emitted via different
 *   paths and rejected here at the SDK boundary.
 * - `posClose` (pos-close): HMAC + JWT, idempotent. Venue-side close-out;
 *   user_id is JWT-derived.
 * - `posCurrentVisits` (pos-current-visits): GET + POS API key. The API
 *   key carries venue scope; no body, no query params. Caller MUST pass
 *   the POS-specific key (NOT the consumer `apiKey` from client config).
 * - `congestionHistory` (congestion-history): POST + API key in body, no
 *   HMAC, no JWT. Admin/analytics endpoint.
 */

import type {
  CongestionHistoryRequest,
  CongestionHistoryResponse,
  PosCloseRequest,
  PosCloseResponse,
  PosCurrentVisitsResponse,
  VisitSignalsRequest,
  VisitSignalsResponse,
} from '../schemas/index.js';
import { getWithApiKey } from '../transport/get.js';
import { postWithApiKey } from '../transport/postApiKey.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface VisitsMethods {
  /**
   * `visit-signals` — emit a client-side `manual_checkin` signal at a venue.
   * SDK boundary locks `signal_type` to `'manual_checkin'` (the only
   * client-emittable value); pos_mark / beacon_proximity / beacon_exit are
   * server-emitted via other paths.
   *
   * Idempotency: transport injects a default UUID; pass an explicit key
   * via the SDK's transport layer if cross-call coordination is needed.
   */
  recordSignal(input: VisitSignalsRequest): Promise<VisitSignalsResponse>;

  /**
   * `pos-close` — venue-side close of an open visit. user_id is JWT-derived.
   * Idempotent at the transport layer.
   */
  posClose(input: PosCloseRequest): Promise<PosCloseResponse>;

  /**
   * `pos-current-visits` — list open visits at the venue bound to the POS
   * credential. No body, no query params; the API key IS the venue scope.
   *
   * **The `posApiKey` argument is the POS-specific credential**, NOT the
   * consumer `apiKey` from the client config. POS API keys are issued
   * per-deployment and validated server-side.
   */
  posCurrentVisits(posApiKey: string): Promise<PosCurrentVisitsResponse>;

  /**
   * `congestion-history` — paginated congestion history for a stadium.
   * Auth via `_auth.apiKey` in body (no HMAC, no JWT). Admin/analytics
   * surface; access controlled by API key issuance, not user identity.
   */
  congestionHistory(input: CongestionHistoryRequest): Promise<CongestionHistoryResponse>;
}

export function createVisitsMethods(
  config: ClientConfig,
  state: ClientState,
): VisitsMethods {
  return {
    recordSignal: async (input) =>
      postWithHMAC<VisitSignalsResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'visit-signals',
        body: input,
        ...jwtCallOpts(state, 'visit-signals'),
        // idempotent: true
      }),

    posClose: async (input) =>
      postWithHMAC<PosCloseResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'pos-close',
        body: input,
        ...jwtCallOpts(state, 'pos-close'),
        // idempotent: true
      }),

    posCurrentVisits: async (posApiKey) =>
      getWithApiKey<PosCurrentVisitsResponse>({
        baseUrl: config.baseUrl,
        slug: 'pos-current-visits',
        apiKey: posApiKey,
      }),

    congestionHistory: async (input) =>
      postWithApiKey<CongestionHistoryResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        slug: 'congestion-history',
        body: input as Record<string, unknown>,
      }),
  };
}
