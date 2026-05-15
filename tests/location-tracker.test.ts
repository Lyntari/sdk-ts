/**
 * Tests for `client.location.createTracker(...)` — the polling-loop module
 * extracted from the mobile-side LocationContext.tsx in v0.2.2.
 *
 * Strategy: instantiate the tracker against a stub `LocationMethods` (DI via
 * the implementation factory `createLocationTrackerImpl` exported from
 * methods/location-tracker.ts), use vitest fake timers to drive setInterval
 * cadence, and assert on the order + shape of `onStateChange` / `onError` /
 * `update` calls.
 *
 * We don't exercise the actual HMAC transport here — that's covered by
 * `methods.test.ts` and `transport-retry.test.ts`. The tracker's job is the
 * polling state machine; the EF wire-up is mocked.
 *
 * Test matrix (matches PLAN_extract-location-tracker.md, 13 cases):
 *   1.  Tick when not in stadium
 *   2.  Tick when in stadium (incl. update POST)
 *   3.  Transition out → in across two ticks
 *   4.  start() fires an immediate tick
 *   5.  stop() clears interval; no further ticks
 *   6.  stop() during in-flight suppresses late emit + update
 *   7.  forceTick() outside the cadence resolves after tick completes
 *   8.  forceTick() during in-flight returns the same in-flight promise
 *   9.  getCurrentPosition throws → onError, no onStateChange
 *  10.  nearbyVenues throws → onError, no onStateChange
 *  11.  update throws → onError, but onStateChange already fired
 *  12.  custom pollIntervalMs honored
 *  13.  isRunning() reflects start/stop transitions
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import { createLocationTrackerImpl } from '../src/methods/location-tracker.js';
import type {
  LocationTracker,
  LocationTrackerCoordinates,
  LocationTrackerState,
} from '../src/methods/location-tracker.js';
import type { LocationMethods } from '../src/methods/location.js';
import type {
  NearbyVenuesResponse,
  LocationUpdateResponse,
} from '../src/schemas/index.js';

const COORDS: LocationTrackerCoordinates = {
  latitude: 34.92319212,
  longitude: -117.89001095,
  accuracy: 10,
};

const STADIUM_ID = 'b47f4b9d-e1f9-444a-aef4-8adf666befbc';

const ROWS_INSIDE: NearbyVenuesResponse = [
  { id: 'venue-1', name: 'Snack Corner', current_stadium_id: STADIUM_ID },
  { id: 'venue-2', name: 'Pizza Express', current_stadium_id: STADIUM_ID },
];

const ROWS_OUTSIDE: NearbyVenuesResponse = [];

/**
 * Build a `LocationMethods` stub with `nearbyVenues` and `update` mocked.
 * The other methods are unused by the tracker; we stub them as throwing to
 * surface accidental coupling.
 */
function makeMethods(): {
  methods: LocationMethods;
  nearbyVenues: Mock;
  update: Mock;
} {
  const nearbyVenues = vi.fn();
  const update = vi.fn();
  const methods: LocationMethods = {
    nearbyVenues: nearbyVenues as unknown as LocationMethods['nearbyVenues'],
    update: update as unknown as LocationMethods['update'],
    beaconDetection: () => {
      throw new Error('tracker should not call beaconDetection');
    },
    beaconConfig: () => {
      throw new Error('tracker should not call beaconConfig');
    },
    createTracker: () => {
      throw new Error('tracker should not call createTracker recursively');
    },
  };
  return { methods, nearbyVenues, update };
}

/**
 * Helper for tests that need fake timers + sequential async assertions.
 * `vi.advanceTimersByTimeAsync` advances the clock AND flushes pending
 * microtasks (so promise chains resolve before the next assertion).
 */
async function flushTickAfter(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('LocationTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Case 1: tick when not in stadium ────────────────────────────────────
  it('emits inStadium=false + does not call update when outside any stadium', async () => {
    const { methods, nearbyVenues, update } = makeMethods();
    nearbyVenues.mockResolvedValue(ROWS_OUTSIDE);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();
    const onError = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
      onError,
    });

    tracker.start();
    await flushTickAfter(0); // immediate tick

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(nearbyVenues).toHaveBeenCalledTimes(1);
    expect(nearbyVenues).toHaveBeenCalledWith({
      latitude: COORDS.latitude,
      longitude: COORDS.longitude,
    });
    expect(update).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith({
      inStadium: false,
      currentStadiumId: null,
      nearbyVenues: ROWS_OUTSIDE,
      coordinates: COORDS,
    });

    tracker.stop();
  });

  // ── Case 2: tick when in stadium ────────────────────────────────────────
  it('emits inStadium=true + calls update when inside a stadium', async () => {
    const { methods, nearbyVenues, update } = makeMethods();
    nearbyVenues.mockResolvedValue(ROWS_INSIDE);
    update.mockResolvedValue({} as LocationUpdateResponse);
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
    });

    tracker.start();
    await flushTickAfter(0);

    expect(onStateChange).toHaveBeenCalledWith({
      inStadium: true,
      currentStadiumId: STADIUM_ID,
      nearbyVenues: ROWS_INSIDE,
      coordinates: COORDS,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      latitude: COORDS.latitude,
      longitude: COORDS.longitude,
      accuracy: COORDS.accuracy,
      timestamp_ms: now,
    });

    tracker.stop();
  });

  // ── Case 3: transition out → in across two ticks ────────────────────────
  it('emits two distinct states across an out-of-stadium → in-stadium transition', async () => {
    const { methods, nearbyVenues, update } = makeMethods();
    nearbyVenues
      .mockResolvedValueOnce(ROWS_OUTSIDE)
      .mockResolvedValueOnce(ROWS_INSIDE);
    update.mockResolvedValue({} as LocationUpdateResponse);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const states: LocationTrackerState[] = [];

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange: (s) => states.push(s),
      pollIntervalMs: 30_000,
    });

    tracker.start();
    await flushTickAfter(0);

    // Drive the next interval tick.
    await flushTickAfter(30_000);

    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({
      inStadium: false,
      currentStadiumId: null,
    });
    expect(states[1]).toMatchObject({
      inStadium: true,
      currentStadiumId: STADIUM_ID,
    });
    expect(update).toHaveBeenCalledTimes(1); // only on the in-stadium tick

    tracker.stop();
  });

  // ── Case 4: start() fires an immediate tick ─────────────────────────────
  it('start() fires an immediate tick, not waiting for the first interval', async () => {
    const { methods, nearbyVenues } = makeMethods();
    nearbyVenues.mockResolvedValue(ROWS_OUTSIDE);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
      pollIntervalMs: 30_000,
    });

    tracker.start();
    // Don't advance timers — just flush microtasks. The immediate tick
    // should be queued by start().
    await flushTickAfter(0);

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledTimes(1);

    tracker.stop();
  });

  // ── Case 5: stop() clears the interval ──────────────────────────────────
  it('stop() clears the interval; no further ticks fire', async () => {
    const { methods, nearbyVenues } = makeMethods();
    nearbyVenues.mockResolvedValue(ROWS_OUTSIDE);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
      pollIntervalMs: 30_000,
    });

    tracker.start();
    await flushTickAfter(0); // immediate tick
    expect(onStateChange).toHaveBeenCalledTimes(1);

    tracker.stop();

    // Advance well past several would-be intervals.
    await flushTickAfter(120_000);

    expect(onStateChange).toHaveBeenCalledTimes(1); // unchanged
  });

  // ── Case 6: stop() during in-flight tick suppresses late callbacks ──────
  it('suppresses late onStateChange + update when stop() runs during an in-flight tick', async () => {
    const { methods, nearbyVenues, update } = makeMethods();

    // Resolve nearbyVenues only when we explicitly let it.
    let resolveNearby: (rows: NearbyVenuesResponse) => void = () => {};
    nearbyVenues.mockImplementation(
      () =>
        new Promise<NearbyVenuesResponse>((resolve) => {
          resolveNearby = resolve;
        }),
    );
    update.mockResolvedValue({} as LocationUpdateResponse);

    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();
    const onError = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
      onError,
    });

    tracker.start();
    // Let the immediate tick begin — getCurrentPosition fires.
    await Promise.resolve();
    await Promise.resolve();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(nearbyVenues).toHaveBeenCalledTimes(1);
    // nearbyVenues is hanging; the tick is in-flight.

    // Stop while in-flight.
    tracker.stop();

    // Now let nearbyVenues resolve with in-stadium rows.
    resolveNearby(ROWS_INSIDE);
    await flushTickAfter(0);

    expect(onStateChange).not.toHaveBeenCalled(); // suppressed
    expect(update).not.toHaveBeenCalled(); // suppressed
    expect(onError).not.toHaveBeenCalled();
  });

  // ── Case 7: forceTick() outside the interval cadence ────────────────────
  it('forceTick() triggers a tick mid-cadence and resolves after it completes', async () => {
    const { methods, nearbyVenues } = makeMethods();
    nearbyVenues.mockResolvedValue(ROWS_OUTSIDE);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
      pollIntervalMs: 30_000,
    });

    tracker.start();
    await flushTickAfter(0); // immediate tick
    expect(onStateChange).toHaveBeenCalledTimes(1);

    // Advance only 1s — well short of the 30s interval. Then force.
    await flushTickAfter(1_000);
    expect(onStateChange).toHaveBeenCalledTimes(1); // no interval tick yet

    const forcePromise = tracker.forceTick();
    await flushTickAfter(0);
    await forcePromise;

    expect(onStateChange).toHaveBeenCalledTimes(2); // immediate + forced

    tracker.stop();
  });

  // ── Case 8: forceTick() during in-flight returns the same promise ───────
  it('forceTick() called twice rapidly returns the same in-flight promise', async () => {
    const { methods, nearbyVenues } = makeMethods();

    let resolveNearby: (rows: NearbyVenuesResponse) => void = () => {};
    nearbyVenues.mockImplementation(
      () =>
        new Promise<NearbyVenuesResponse>((resolve) => {
          resolveNearby = resolve;
        }),
    );
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
    });

    tracker.start();
    // Let the immediate tick reach the nearbyVenues await — it's now hanging.
    await Promise.resolve();
    await Promise.resolve();
    expect(nearbyVenues).toHaveBeenCalledTimes(1);

    // Two rapid forceTick calls during the in-flight.
    const p1 = tracker.forceTick();
    const p2 = tracker.forceTick();

    expect(p1).toBe(p2); // identical in-flight promise

    // Resolve the in-flight; both await the same completion.
    resolveNearby(ROWS_OUTSIDE);
    await flushTickAfter(0);
    await p1;

    // nearbyVenues still only called ONCE (no double-fire).
    expect(nearbyVenues).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledTimes(1);

    tracker.stop();
  });

  // ── Case 9: getCurrentPosition throws → onError, no emit ────────────────
  it('routes getCurrentPosition errors to onError and skips the emit', async () => {
    const { methods, nearbyVenues } = makeMethods();
    const err = new Error('gps unavailable');
    const getCurrentPosition = vi.fn().mockRejectedValue(err);
    const onStateChange = vi.fn();
    const onError = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
      onError,
    });

    tracker.start();
    await flushTickAfter(0);

    expect(onError).toHaveBeenCalledWith(err);
    expect(nearbyVenues).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();

    tracker.stop();
  });

  // ── Case 10: nearbyVenues throws → onError, no emit ─────────────────────
  it('routes nearbyVenues errors to onError and skips the emit', async () => {
    const { methods, nearbyVenues, update } = makeMethods();
    const err = new Error('network blip');
    nearbyVenues.mockRejectedValue(err);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();
    const onError = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
      onError,
    });

    tracker.start();
    await flushTickAfter(0);

    expect(onError).toHaveBeenCalledWith(err);
    expect(onStateChange).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();

    tracker.stop();
  });

  // ── Case 11: update throws → onError, emit already fired ────────────────
  it('routes update errors to onError but keeps the prior onStateChange emit', async () => {
    const { methods, nearbyVenues, update } = makeMethods();
    nearbyVenues.mockResolvedValue(ROWS_INSIDE);
    const err = new Error('location-update failed');
    update.mockRejectedValue(err);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();
    const onError = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
      onError,
    });

    tracker.start();
    await flushTickAfter(0);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ inStadium: true, currentStadiumId: STADIUM_ID }),
    );
    expect(onError).toHaveBeenCalledWith(err);

    tracker.stop();
  });

  // ── Case 12: custom pollIntervalMs ──────────────────────────────────────
  it('honors custom pollIntervalMs', async () => {
    const { methods, nearbyVenues } = makeMethods();
    nearbyVenues.mockResolvedValue(ROWS_OUTSIDE);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);
    const onStateChange = vi.fn();

    const tracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange,
      pollIntervalMs: 5_000,
    });

    tracker.start();
    await flushTickAfter(0); // immediate
    expect(onStateChange).toHaveBeenCalledTimes(1);

    // Advance 4.5s — should NOT yet hit the next interval.
    await flushTickAfter(4_500);
    expect(onStateChange).toHaveBeenCalledTimes(1);

    // Advance another 0.5s to cross the 5s threshold.
    await flushTickAfter(500);
    expect(onStateChange).toHaveBeenCalledTimes(2);

    // And another 5s for the next interval tick.
    await flushTickAfter(5_000);
    expect(onStateChange).toHaveBeenCalledTimes(3);

    tracker.stop();
  });

  // ── Case 13: isRunning() reflects state ─────────────────────────────────
  it('isRunning() reflects start/stop transitions', async () => {
    const { methods, nearbyVenues } = makeMethods();
    nearbyVenues.mockResolvedValue(ROWS_OUTSIDE);
    const getCurrentPosition = vi.fn().mockResolvedValue(COORDS);

    const tracker: LocationTracker = createLocationTrackerImpl(methods, {
      getCurrentPosition,
      onStateChange: () => {},
    });

    expect(tracker.isRunning()).toBe(false);

    tracker.start();
    expect(tracker.isRunning()).toBe(true);
    await flushTickAfter(0);
    expect(tracker.isRunning()).toBe(true);

    tracker.stop();
    expect(tracker.isRunning()).toBe(false);

    // Idempotent: stop() on a stopped tracker is fine.
    tracker.stop();
    expect(tracker.isRunning()).toBe(false);

    // Restart works.
    tracker.start();
    expect(tracker.isRunning()).toBe(true);
    await flushTickAfter(0);

    tracker.stop();
  });
});
