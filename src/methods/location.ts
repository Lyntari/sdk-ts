/**
 * Location-flow SDK methods — 4 endpoints.
 *
 * - `nearbyVenues` (nearby-venues): HMAC + JWT, no idempotency. Discovery
 *   query by lat/lng with optional radius.
 * - `update` (location-update): HMAC + JWT, idempotent. Push current
 *   location; server may fire a downstream notification-eligibility check
 *   when `in_stadium: true` (fire-and-forget; transparent to caller).
 * - `beaconDetection` (beacon-detection): HMAC + JWT, idempotent. iBeacon
 *   sample; server returns prompt-eligibility decision.
 * - `beaconConfig` (beacon-config): GET + API key. Beacon catalog for the
 *   deployment.
 */

import type {
  BeaconConfigResponse,
  BeaconDetectionRequest,
  BeaconDetectionResponse,
  LocationUpdateRequest,
  LocationUpdateResponse,
  NearbyVenuesRequest,
  NearbyVenuesResponse,
} from '../schemas/index.js';
import { getWithApiKey } from '../transport/get.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface LocationMethods {
  /**
   * `nearby-venues` — list venues within `radius_meters` of `(latitude,
   * longitude)`. Server applies a default radius when omitted. Lat/lng are
   * range-validated at the SDK boundary (`[-90, 90]` / `[-180, 180]`).
   */
  nearbyVenues(input: NearbyVenuesRequest): Promise<NearbyVenuesResponse>;

  /**
   * `location-update` — push current location for the authenticated user.
   * Side effect: the server may trigger a downstream notification-
   * eligibility check when it determines the user is in a stadium.
   * Transparent to the caller. Idempotent at the transport layer.
   */
  update(input: LocationUpdateRequest): Promise<LocationUpdateResponse>;

  /**
   * `beacon-detection` — emit an iBeacon sample. Server returns a decision
   * record indicating whether the client should subsequently call
   * `notifications.trigger` with a `beacon` trigger type.
   */
  beaconDetection(input: BeaconDetectionRequest): Promise<BeaconDetectionResponse>;

  /**
   * `beacon-config` — fetch the beacon catalog for the deployment bound
   * to the client's API key. No body, no query params.
   */
  beaconConfig(): Promise<BeaconConfigResponse>;
}

export function createLocationMethods(
  config: ClientConfig,
  state: ClientState,
): LocationMethods {
  return {
    nearbyVenues: async (input) =>
      postWithHMAC<NearbyVenuesResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'nearby-venues',
        body: input,
        ...jwtCallOpts(state, 'nearby-venues'),
        idempotencyKey: null,
      }),

    update: async (input) =>
      postWithHMAC<LocationUpdateResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'location-update',
        body: input,
        ...jwtCallOpts(state, 'location-update'),
        // idempotent: true
      }),

    beaconDetection: async (input) =>
      postWithHMAC<BeaconDetectionResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'beacon-detection',
        body: input,
        ...jwtCallOpts(state, 'beacon-detection'),
        // idempotent: true
      }),

    beaconConfig: async () =>
      getWithApiKey<BeaconConfigResponse>({
        baseUrl: config.baseUrl,
        slug: 'beacon-config',
        apiKey: config.apiKey,
      }),
  };
}
