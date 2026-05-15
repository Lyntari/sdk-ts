/**
 * Location tracker — stateful polling loop for server-derived stadium
 * presence. Factored out of the mobile `LocationContext.tsx` polling code
 * (commit history of `mobile/`) so any client can consume the same
 * algorithm without re-implementing it.
 *
 * Algorithm:
 *
 *   1. On every tick: call `getCurrentPosition()` for fresh coords; call
 *      `nearby-venues` for the row set; derive `stadiumId` from
 *      `rows[0]?.current_stadium_id ?? null`.
 *   2. Emit `onStateChange({inStadium, currentStadiumId, nearbyVenues,
 *      coordinates})` — every successful tick, no SDK-side de-dupe (the
 *      coordinate fields change every tick anyway, and React-style
 *      consumers de-dupe via setState's referential-equality default).
 *   3. If `inStadium === true`: POST `location-update` so the server-side
 *      proximity-notification cron's spatial gate sees a recent
 *      `app.user_locations` row. Errors there surface via `onError` but do
 *      NOT roll back the `onStateChange` emit — state is "atomic" with the
 *      `nearby-venues` result; the `update` POST is a downstream side
 *      effect.
 *
 * Triggers:
 *
 *   - `setInterval(pollIntervalMs)` — default 30s. Drives the cadence.
 *   - `start()` fires an immediate tick before the first interval fires.
 *   - `forceTick()` — caller-driven trigger outside the cadence (app-resume,
 *     permission-granted, pull-to-refresh, debug).
 *
 * In-flight de-dupe: a single shared promise. Concurrent interval fires +
 * `forceTick()` calls all await the same promise instead of starting a new
 * tick. Prevents double-fire under any combination of triggers.
 *
 * Stop semantics: `stop()` clears the interval but does NOT await an
 * in-flight tick. The in-flight tick checks the `running` flag before
 * emitting `onStateChange` and before POSTing `location-update`; late
 * callbacks are suppressed. Matches consumer unmount expectations.
 *
 * Errors: `getCurrentPosition`, `nearby-venues`, and `location-update`
 * failures route to `onError(err)`. The loop keeps polling — transient
 * failures shouldn't kill the tracker. Callers wire `onError` to inspect
 * `LyntariApiError.terminalForAuth` and call `tracker.stop()` if they want
 * to terminate on auth failures.
 */

import type { NearbyVenuesResponse } from '../schemas/index.js';
import type { LocationMethods } from './location.js';

/**
 * Minimal coordinate shape the tracker requires. Consumers may return a
 * superset (e.g., a Capacitor `Position` with altitude / heading / speed) —
 * TypeScript structural typing lets the extra fields flow through to
 * `onStateChange`'s `coordinates`.
 */
export interface LocationTrackerCoordinates {
  latitude: number;
  longitude: number;
  /** GPS accuracy radius in meters. Passed through to `location-update` when in stadium. */
  accuracy?: number;
}

/**
 * State emitted on every successful tick.
 *
 * `nearbyVenues` is the raw row array the server returned; consumers project
 * to their own venue type if needed (sort by distance, slice top-N, etc.).
 * Each row carries the same `current_stadium_id` when the array is
 * non-empty; empty array → caller is not inside any active stadium polygon.
 */
export interface LocationTrackerState {
  inStadium: boolean;
  currentStadiumId: string | null;
  nearbyVenues: NearbyVenuesResponse;
  coordinates: LocationTrackerCoordinates;
}

export interface LocationTrackerOptions {
  /** Platform-supplied position fetcher. The tracker calls this on every tick. */
  getCurrentPosition: () => Promise<LocationTrackerCoordinates>;
  /**
   * Fires after every successful tick (no SDK-side de-dupe). Consumers using
   * React state setters get implicit referential-equality de-dupe via React;
   * other consumers can compare incoming state to the last value if needed.
   */
  onStateChange: (state: LocationTrackerState) => void;
  /**
   * Fires when `getCurrentPosition`, `nearbyVenues`, or `location-update`
   * throws. The tracker keeps polling — wire to `tracker.stop()` if a
   * particular error should terminate the loop (e.g., terminal-auth errors).
   */
  onError?: (error: Error) => void;
  /**
   * Polling cadence in milliseconds. Default 30_000.
   *
   * The cadence is independent of OS position events — pure setInterval. On
   * iOS in low-accuracy mode, `Geolocation.watchPosition` can stay silent for
   * minutes on a stationary device; the explicit polling guarantees that
   * server-state transitions (e.g., a stadium-geofence row added while the
   * user is already at the location) are observed within `pollIntervalMs`.
   */
  pollIntervalMs?: number;
}

export interface LocationTracker {
  /**
   * Start polling. Fires an immediate tick AND schedules a setInterval at
   * `pollIntervalMs`. No-op if already running.
   */
  start(): void;
  /**
   * Stop polling. Clears the interval; any in-flight tick will complete its
   * fetches but the `onStateChange` and `location-update` POST are
   * suppressed (won't fire after stop). No-op if not running.
   */
  stop(): void;
  /**
   * Trigger a tick outside the polling cadence. Resolves after the tick
   * completes. If a tick is already in flight, returns the in-flight promise
   * instead of starting a new tick.
   */
  forceTick(): Promise<void>;
  /** Whether `start()` has been called and `stop()` has not. */
  isRunning(): boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Internal factory. Consumers call `client.location.createTracker(options)`;
 * the public API binds in `methods/location.ts`.
 *
 * Takes the `LocationMethods` reference so the tracker can call
 * `nearbyVenues` and `update` through the SDK's existing transport (HMAC +
 * JWT + retry behaviors all inherited).
 */
export function createLocationTrackerImpl(
  methods: LocationMethods,
  options: LocationTrackerOptions,
): LocationTracker {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let running = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  const handleError = (error: unknown): void => {
    if (options.onError) {
      const err = error instanceof Error ? error : new Error(String(error));
      try {
        options.onError(err);
      } catch {
        // Listener bugs must not corrupt the loop. Swallow.
      }
    }
  };

  const runTick = async (): Promise<void> => {
    let coords: LocationTrackerCoordinates;
    try {
      coords = await options.getCurrentPosition();
    } catch (error) {
      handleError(error);
      return;
    }

    let rows: NearbyVenuesResponse;
    try {
      rows = await methods.nearbyVenues({
        latitude: coords.latitude,
        longitude: coords.longitude,
      });
    } catch (error) {
      handleError(error);
      return;
    }

    // Suppress late callbacks if `stop()` ran while we were awaiting.
    if (!running) return;

    const stadiumId =
      (rows[0]?.current_stadium_id as string | undefined) ?? null;
    const inStadium = stadiumId !== null;

    try {
      options.onStateChange({
        inStadium,
        currentStadiumId: stadiumId,
        nearbyVenues: rows,
        coordinates: coords,
      });
    } catch {
      // Consumer-listener bugs must not corrupt the loop.
    }

    if (inStadium && running) {
      try {
        await methods.update({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          timestamp_ms: Date.now(),
        });
      } catch (error) {
        handleError(error);
      }
    }
  };

  const tick = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      void tick(); // immediate fire
      intervalId = setInterval(() => {
        void tick();
      }, pollIntervalMs);
    },
    stop(): void {
      if (!running) return;
      running = false;
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      // In-flight tick (if any) will complete its awaits and bail at the
      // `if (!running) return` checkpoint without emitting.
    },
    forceTick(): Promise<void> {
      // Tick regardless of running — caller may want a one-shot check
      // even when not in the steady-state polling loop. The `running`
      // guards inside `runTick` still apply: if `stop()` runs while we
      // await, the emit is suppressed.
      return tick();
    },
    isRunning(): boolean {
      return running;
    },
  };
}
