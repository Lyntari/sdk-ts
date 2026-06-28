/**
 * Consent-flow SDK methods — 2 endpoints (cluster #65, mandate §4.13).
 *
 *   - `get` → consent-get EF — read the user's consent map.
 *   - `set` → consent-set EF — grant (`granted: true`) or one-tap revoke
 *     (`granted: false`) one consent type.
 *
 * Both consumer-facing, HMAC + JWT; the user is JWT-derived (caller doesn't
 * supply a user id).
 */

import type {
  GetConsentResponse,
  SetConsentRequest,
  SetConsentResponse,
} from '../schemas/index.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface ConsentMethods {
  /**
   * `consent-get` — read the authenticated user's consent map
   * (`consent_type` → `{granted, granted_at, revoked_at}`). Absent keys mean
   * never-set (not granted).
   */
  get(): Promise<GetConsentResponse>;

  /**
   * `consent-set` — grant or one-tap-revoke a single consent. `granted: true`
   * is opt-in; `granted: false` is the one-tap opt-out. Returns the full
   * updated consent map. Idempotent at the transport layer.
   */
  set(input: SetConsentRequest): Promise<SetConsentResponse>;
}

export function createConsentMethods(
  config: ClientConfig,
  state: ClientState,
): ConsentMethods {
  return {
    get: async () =>
      postWithHMAC<GetConsentResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'consent-get',
        body: {},
        ...jwtCallOpts(state, 'consent-get'),
        idempotencyKey: null,
      }),

    set: async (input) =>
      postWithHMAC<SetConsentResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'consent-set',
        body: input,
        ...jwtCallOpts(state, 'consent-set'),
        // idempotent: true
      }),
  };
}
