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
import {
  createLocationTrackerImpl,
  type LocationTracker,
  type LocationTrackerOptions,
} from './location-tracker.js';

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

  /**
   * Create a stateful in-stadium tracker. Polls `nearby-venues` on a
   * configurable interval, derives stadium presence from the server's
   * `current_stadium_id` row field, emits state via `onStateChange`, and
   * POSTs `location-update` when the user is in a stadium (which unblocks
   * the server-side notification cron's spatial gate).
   *
   * See `LocationTrackerOptions` for the option set and `LocationTracker`
   * for the returned lifecycle surface (`start`, `stop`, `forceTick`,
   * `isRunning`).
   *
   * Each `createTracker(...)` call returns an independent instance; nothing
   * is shared across calls. Multiple trackers per client are supported (rare
   * in practice — most consumers want a single tracker bound to the
   * authenticated user).
   */
  createTracker(options: LocationTrackerOptions): LocationTracker;
}

export function createLocationMethods(
  config: ClientConfig,
  state: ClientState,
): LocationMethods {
  // Declared upfront so the `createTracker` arrow below can close over the
  // self-reference. By the time the consumer calls `createTracker(...)`, the
  // object literal has finished initializing and `methods` is fully populated.
  const methods: LocationMethods = {
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

    createTracker: (options) => createLocationTrackerImpl(methods, options),
  };

  return methods;
}
