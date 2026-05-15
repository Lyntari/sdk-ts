# In-stadium tracker integration

**Audience:** partner clients integrating with the Lyntari backend that wish
to track whether the authenticated user is inside a stadium polygon and
keep the server informed so notification cron jobs can target them.
**Pair with:** [`openapi.yaml`](../openapi.yaml) (the `nearby-venues` and
`location-update` endpoints).

The `client.location.createTracker(...)` module shipped in `@lyntari/sdk`
v0.2.2. It's the recommended way to integrate stadium presence — clients
that prefer to drive the polling themselves can call the underlying EFs
directly (see [§ Without the SDK](#without-the-sdk) at the end).

---

## Overview

The tracker is a polling loop that, on a configurable cadence (default 30
seconds):

1. Calls a platform-supplied `getCurrentPosition()` to obtain fresh GPS
   coordinates.
2. Calls `nearby-venues` with those coordinates. The response's first row
   carries a `current_stadium_id` field when the caller is inside a
   stadium polygon, or the response is `[]` when not.
3. Emits an `onStateChange(state)` event with `{inStadium, currentStadiumId,
   nearbyVenues, coordinates}`.
4. When in a stadium, posts `location-update` with the same coordinates so
   the server's proximity-notification cron sees a recent
   `app.user_locations` row for the user.

Out-of-stadium ticks skip the `location-update` POST.

---

## Quick start

```ts
import { Geolocation } from '@capacitor/geolocation';

const tracker = client.location.createTracker({
  getCurrentPosition: async () => {
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: false,
      maximumAge: 30_000,
      timeout: 30_000,
    });
    return {
      latitude:  pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy:  pos.coords.accuracy,
    };
  },
  onStateChange: (state) => {
    // state.inStadium:           boolean
    // state.currentStadiumId:    uuid | null
    // state.nearbyVenues:        array of venue rows (raw from nearby-venues)
    // state.coordinates:         the coords the tick was based on
    setUserLocation(state);   // wire into your app state / UI
  },
  onError: (err) => {
    logger.warn('tracker error', err);
  },
  // pollIntervalMs: 30_000,   // optional; default 30s
});

tracker.start();
```

Call `tracker.stop()` when the user logs out, the consumer unmounts, or
the app backgrounds for long enough that you want to release the
polling loop.

---

## API surface

```ts
interface LocationTrackerOptions {
  getCurrentPosition: () => Promise<LocationTrackerCoordinates>;
  onStateChange: (state: LocationTrackerState) => void;
  onError?: (error: Error) => void;
  pollIntervalMs?: number;   // default 30_000
}

interface LocationTrackerCoordinates {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

interface LocationTrackerState {
  inStadium: boolean;
  currentStadiumId: string | null;
  nearbyVenues: NearbyVenuesResponse;   // raw rows from nearby-venues
  coordinates: LocationTrackerCoordinates;
}

interface LocationTracker {
  start(): void;
  stop(): void;
  forceTick(): Promise<void>;
  isRunning(): boolean;
}
```

`nearbyVenues` in the emitted state is the raw row array — each row is an
open record with `current_stadium_id?: uuid` typed; other fields (`id`,
`name`, `latitude`, `longitude`, `distance`, etc.) pass through
unvalidated. Project to your own venue type as needed.

---

## Lifecycle methods

| Method | Behavior |
| --- | --- |
| `start()` | Fires an immediate tick AND schedules a `setInterval` at `pollIntervalMs`. Idempotent — second `start()` is a no-op. |
| `stop()` | Clears the interval. Safe to call during an in-flight tick — any callback queued by that tick is suppressed. Idempotent — second `stop()` is a no-op. |
| `forceTick()` | Runs a tick outside the polling cadence. Returns the in-flight promise if a tick is already running (so concurrent `forceTick()` calls don't fire duplicate `nearby-venues` requests). Resolves after the tick completes. |
| `isRunning()` | Returns `true` between `start()` and `stop()`. |

`forceTick()` use cases:

- App returned to foreground — refresh state without waiting for the next
  interval.
- User just granted location permission — bootstrap state immediately.
- Pull-to-refresh on a presence-dependent screen.
- Debug-time manual trigger.

---

## Callbacks

### `onStateChange(state)`

Fires after every successful tick — both interval-driven and
`forceTick()`-driven. There is no SDK-side de-duplication; the
`coordinates` field changes on every tick, so React-style consumers
already de-dupe via setState's referential-equality default.

### `onError(error)`

Fires when `getCurrentPosition`, `nearbyVenues`, or `location-update`
throws or rejects. The tracker keeps polling — transient failures
(network blips, GPS timeouts) shouldn't kill the loop.

To terminate on terminal-auth errors (e.g., a deleted account whose
refresh token won't refresh), inspect the error and call
`tracker.stop()`:

```ts
import { LyntariApiError } from '@lyntari/sdk';

onError: (err) => {
  if (err instanceof LyntariApiError && err.terminalForAuth) {
    tracker.stop();
    routeToLogin();
  } else {
    logger.warn('tracker error (will retry next tick)', err);
  }
}
```

When the in-stadium `location-update` POST fails, `onError` fires but
the prior `onStateChange` for that tick has already emitted — the
state-change is "atomic" with the `nearby-venues` result and isn't
rolled back by a downstream `location-update` failure.

---

## Stop on logout

The tracker doesn't watch the Auth lifecycle. Wire the lifecycle's
`cleared` event to `tracker.stop()`:

```ts
client.auth.onEvent?.((event) => {
  if (event.type === 'cleared') tracker.stop();
});
```

Or call `tracker.stop()` immediately before
`client.auth.logout(...)` / `client.auth.deleteAccount(...)` in your own
logout flow. In caller-managed mode, do this alongside
`setAccessToken(null)`.

---

## App background / foreground

The tracker continues polling while the app is in the foreground. On
Capacitor iOS/Android, `setInterval` continues firing as long as the JS
runtime is alive — typically a few minutes after backgrounding without
a foreground service.

For long suspension windows (e.g., the user closes the app for 30+
minutes during a game), wire a platform-native foreground-event handler
to `tracker.forceTick()` on resume so state is fresh before the user
sees the UI.

---

## Tunable cadence

`pollIntervalMs` defaults to 30 seconds.

| Value | Tradeoff |
| --- | --- |
| Lower (e.g., 10s) | Faster response to state transitions; proportionally higher EF call rate. |
| Default (30s) | Matches the OS-level GPS cadence in low-accuracy mode and fits comfortably inside the server's 5-minute notification cron window. |
| Higher (e.g., 60s) | Lower load; presence transitions take longer to observe. Acceptable for low-stakes presence indicators. |

Don't drop below ~5s — `nearby-venues` isn't per-client rate-limited
today but sustained sub-5s polling would be visible at scale and may
trigger future limits.

---

## When NOT to use the tracker

- **Single-shot location checks.** Call `client.location.nearbyVenues(...)`
  directly. The tracker is for sustained polling.
- **Background-only presence detection.** The tracker assumes the JS
  runtime is alive. True background work (OS-driven geofence triggers,
  push-driven check-ins) needs a native plugin; the tracker is
  foreground-only.
- **Sub-second presence accuracy.** `pollIntervalMs` lets you tune
  down, but consider whether the cost (EF load, client battery) is
  justified vs. piggybacking on an existing OS-level location stream
  and feeding it through `forceTick()` on each event.

---

## Without the SDK

The tracker is a convenience layer over two existing EFs. Partners not
using the SDK can implement the same loop manually:

1. On a 30s cadence, fetch fresh coordinates from your platform.
2. POST to `nearby-venues` with `{latitude, longitude}`.
3. Extract `currentStadiumId = rows[0]?.current_stadium_id ?? null`.
4. If non-null, POST to `location-update` with `{latitude, longitude,
   accuracy?, timestamp_ms}`.

Refer to [`openapi.yaml`](../openapi.yaml) for the request/response
contracts. The server is stateless w.r.t. polling cadence — manage
your own start / stop / dedup / error handling.

---

## Versioning and stability

The `current_stadium_id` field shipped in `@lyntari/sdk` v0.2.1; the
tracker module shipped in v0.2.2. Both are additive on the wire — older
SDK versions calling `nearby-venues` see an unfamiliar extra field per
row and pass it through harmlessly.

The tracker's option set, returned method set, and emitted state shape
are part of the public contract. Pre-1.0 the API may still evolve; pin
exact SDK versions in production per the SDK README's pre-1.0 guidance.
