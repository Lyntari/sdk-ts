/**
 * Events operator-flow SDK methods — 2 endpoints.
 *
 *   - `manageStaffing` → manage-venue-staffing EF (action: insert/close/close_all)
 *   - `managePhase` → manage-event-phases EF (action: started/ended/get_taxonomies)
 *
 * Both are operator-facing (Retool calls these from the staffing/phases dashboard).
 * Both require HMAC + JWT. Multi-action via discriminated union — the caller
 * passes `{action: 'insert', ...args}` and TypeScript narrows the required
 * args from the union member.
 */

import type {
  ManageVenueStaffingRequest,
  ManageVenueStaffingResponse,
  ManageEventPhasesRequest,
  ManageEventPhasesResponse,
} from '../schemas/index.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface EventsMethods {
  /**
   * `manage-venue-staffing` — operator manages venue staffing via action
   * discriminator. `insert` auto-closes prior open row for the same
   * (venue_id, role). `close` enforces "exists + currently-open" invariant.
   * `close_all` is a bulk operation across all roles for a venue. The
   * server derives the operator user from the authenticated session.
   */
  manageStaffing(
    input: ManageVenueStaffingRequest,
  ): Promise<ManageVenueStaffingResponse>;

  /**
   * `manage-event-phases` — operator manages event phase lifecycle via
   * action discriminator. `started` hard-validates `phase_name` against
   * the phase taxonomy for the event's sport; auto-closes any prior
   * open phase. `ended` closes the
   * most recent matching open phase. `get_taxonomies` is a read-only
   * action returning the phase catalog for a sport.
   */
  managePhase(
    input: ManageEventPhasesRequest,
  ): Promise<ManageEventPhasesResponse>;
}

export function createEventsMethods(
  config: ClientConfig,
  state: ClientState,
): EventsMethods {
  return {
    manageStaffing: async (input) =>
      postWithHMAC<ManageVenueStaffingResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'manage-venue-staffing',
        body: input,
        ...jwtCallOpts(state, 'manage-venue-staffing'),
        idempotencyKey: null,
      }),

    managePhase: async (input) =>
      postWithHMAC<ManageEventPhasesResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'manage-event-phases',
        body: input,
        ...jwtCallOpts(state, 'manage-event-phases'),
        idempotencyKey: null,
      }),
  };
}
