/**
 * Privacy SDK methods — 1 endpoint (cluster #79).
 *
 *   - `submitDsr` → `dsr` EF — submit a data-subject request (access / deletion
 *     / portability) against the authenticated subject's own data.
 *
 * Consumer-facing, HMAC + JWT; the subject is JWT-derived (the caller supplies
 * no user id). Idempotent at the transport layer — a retried submit with the
 * same `Idempotency-Key` replays the original result rather than filing a
 * duplicate request.
 */

import type { SubmitDsrRequest, SubmitDsrResponse } from '../schemas/index.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface PrivacyMethods {
  /**
   * `dsr` — submit a data-subject request for the authenticated subject.
   * `request_type` is `'access'` (a copy of your data), `'deletion'` (erase
   * your personal data), or `'portability'` (a machine-readable export).
   * Returns the request record: an opaque `dsr_id`, the accepted
   * `request_type`, and a verb-specific `result`. Idempotent at the transport
   * layer.
   */
  submitDsr(input: SubmitDsrRequest): Promise<SubmitDsrResponse>;
}

export function createPrivacyMethods(
  config: ClientConfig,
  state: ClientState,
): PrivacyMethods {
  return {
    submitDsr: async (input) =>
      postWithHMAC<SubmitDsrResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'dsr',
        body: input,
        ...jwtCallOpts(state, 'dsr'),
        // idempotent: true
      }),
  };
}
