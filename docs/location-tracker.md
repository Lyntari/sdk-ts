# In-stadium tracker integration

**Audience:** partner clients integrating with the Lyntari backend.
**Pair with:** [`openapi.yaml`](../openapi.yaml) (the `nearby-venues` and
`location-update` endpoints).

This doc covers the `client.location.createTracker(...)` module that landed
in `@lyntari/sdk` v0.2.2 — the stateful polling loop that detects whether
the authenticated user is inside a stadium polygon, emits state changes
to your UI, and POSTs `location-update` so the server-side
proximity-notification cron's spatial gate has a fresh
`app.user_locations` row to evaluate.

If you're integrating without the SDK, follow the wire contract sections
directly; the tracker is a convenience layer over the same two EFs.

---

## Why a tracker — what problem this solves

Stadium presence has two state owners:

1. **The client** — knows the user's current GPS coordinates.
2. **The server** — knows which polygons exist (`app.stadium_geofences`)
   and whether a given point lies inside one.

A naive design tries to keep both in sync — the client downloads the
polygon catalog and runs its own `ST_Contains`. That worked until two
failure modes surfaced in production:

1. **Stale client cache.** A user who signed up *before* a stadium was
   seeded into the database stayed on the empty polygon list for the entire
   session; the server's `ST_Contains` would have said "inside," but the
   client never asked. Restart was the only workaround.

2. **Silent OS callbacks.** Mobile platforms use event-driven location
   callbacks (e.g., `Geolocation.watchPosition` on iOS in low-accuracy
   mode). On a stationary device, those events can pause for minutes
   between cell-tower handoffs. Server-side state changes during the
   silence (e.g., a fresh geofence row added) aren't observed until the
   device next moves — or the app restarts.

The tracker resolves both by making the server the sole containment
authority and driving the check on an explicit polling interval (default
30s) that runs independently of OS movement events.

For the deeper "why this architecture" discussion — including the
server-side `ST_Contains` policy and the wire-protocol life cycle of a
single `nearby-venues` call — see **`ARCHITECTURE.md` § TypeScript SDK and
Wire Protocol** and **§ Spatial containment authority** in the Lyntari
documentation set.

---

## Wire contract — what the tracker calls

The tracker uses two existing EFs. Both are documented in
[`openapi.yaml`](../openapi.yaml).

### `nearby-venues` (POST, HMAC + JWT) — every tick

Request:

```json
{ "latitude": <number>, "longitude": <number> }
```

Response (three-state semantic):

- **`[]`** — caller is not inside any active stadium polygon.
- **Non-empty array** — caller is inside the stadium identified by every
  row's `current_stadium_id`. Each row is a venue record; the
  `current_stadium_id` field is uniform across the response because the
  server filters returned venues to the stadium that contains the caller.

Schema-wise, the SDK exposes the row shape as a `passthrough` Zod object
with one typed field: `current_stadium_id: UuidSchema.optional()`. Other
fields (`id`, `name`, `latitude`, `longitude`, `distance`, etc.) flow
through unvalidated — consumers narrow to their own venue type.

### `location-update` (POST, HMAC + JWT, idempotent) — every tick *when in stadium*

Request:

```json
{
  "latitude": <number>,
  "longitude": <number>,
  "accuracy": <number-or-omit>,
  "timestamp_ms": <epoch-ms>
}
```

The server records the row, runs its own `ST_Contains` against the polygon
set (verifying the client's presence claim — the client doesn't get to
unilaterally declare "I'm in stadium X"), and writes `in_stadium = true`
when the point is inside. Downstream:

- The proximity-notification cron (`check-proximity-notifications`,
  every 5 min) selects users with a recent `app.user_locations` row in the
  current geofence.
- The wait-time-drop cron (`check-wait-time-notifications`, every 5 min)
  does the same.

Without a fresh `app.user_locations` row, neither cron sees the user as
present, regardless of what the client's UI says. The tracker's
`location-update` POST when in stadium is what unblocks those notification
paths.

Out-of-stadium ticks skip the POST — there's no signal for the server to
record, and writing rows for users far from any venue would pollute the
analytics surface.

---

## API surface

```ts
client.location.createTracker(options: LocationTrackerOptions): LocationTracker
```

```ts
interface LocationTrackerOptions {
  /** Platform-supplied position fetcher. SDK calls this on every tick. */
  getCurrentPosition: () => Promise<LocationTrackerCoordinates>;
  /** Fires after every successful tick. */
  onStateChange: (state: LocationTrackerState) => void;
  /** Fires when getCurrentPosition / nearbyVenues / update throws. */
  onError?: (error: Error) => void;
  /** Polling cadence in milliseconds. Default 30_000. */
  pollIntervalMs?: number;
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

---

## Lifecycle expectations

### Construction

The tracker is constructed eagerly but **does not call any EF until
`start()` is invoked**. `createTracker(...)` returns synchronously with
the lifecycle handle. Construct it once per session — typically at app
start or right after login.

### `start()` — immediate tick + interval scheduling

`start()` fires an immediate tick (so consumers don't wait
`pollIntervalMs` for initial state) AND schedules a `setInterval` at
`pollIntervalMs`. Subsequent calls are idempotent no-ops.

### `stop()` — interval clear + late-callback suppression

`stop()` clears the interval. Any tick that was already in flight when
`stop()` ran will complete its `getCurrentPosition` / `nearbyVenues`
fetches but check a `running` flag *before* emitting `onStateChange` and
*before* POSTing `location-update`. Late callbacks are suppressed.
Subsequent `stop()` calls are idempotent no-ops.

This matches consumer-unmount expectations — if your tracker is bound to a
React component's lifecycle, calling `tracker.stop()` in the cleanup
function guarantees no stray callbacks fire on the unmounted component.

### `forceTick()` — out-of-cadence trigger

Use cases:

- The app returned to foreground and you want to re-check immediately
  instead of waiting up to `pollIntervalMs` for the next interval fire.
- The user just granted location permission and you want to bootstrap
  state without waiting.
- A "pull to refresh" gesture on a presence-dependent screen.
- Debug-time manual trigger.

`forceTick()` returns a `Promise<void>` that resolves after the tick
completes. If a tick is already in flight, `forceTick()` returns the
in-flight promise — no double-fire. Safe to call concurrently with the
interval-driven cadence.

### `isRunning()`

Returns `true` between `start()` and `stop()` (inclusive of any in-flight
ticks). Useful for debug surfaces or guards against double-starting from
multiple React `useEffect` hooks.

### Error handling

The `onError` callback fires for any of:

- `getCurrentPosition` rejects (GPS unavailable, permission revoked,
  platform timeout, etc.).
- `nearbyVenues` throws (network failure, HMAC/JWT error, server 5xx,
  etc.).
- `update` throws (same categories — only fires after the in-stadium
  `onStateChange` already emitted).

The tracker keeps polling after errors — transient failures shouldn't
kill the loop. Callers that need to terminate on specific error types
(e.g., terminal-auth errors after a deleted account) should inspect the
error in `onError` and call `tracker.stop()` manually:

```ts
import { LyntariApiError } from '@lyntari/sdk';

const tracker = client.location.createTracker({
  ...,
  onError: (err) => {
    if (err instanceof LyntariApiError && err.terminalForAuth) {
      tracker.stop();
      // Route to login screen.
    } else {
      logger.warn('tracker error (will retry next tick)', err);
    }
  },
});
```

### Update-error nuance

When the in-stadium `update` POST fails, the `onStateChange` emit has
already fired for that tick. The state-change emit is "atomic" with the
`nearby-venues` result; the `update` POST is a downstream side effect that
can fail without rolling back the state. Your UI will show the user as
in-stadium even though the server didn't get the location-update — the
next successful tick recovers.

---

## Multiple trackers

Each `createTracker(...)` call returns an independent instance. Nothing is
shared across instances. Two trackers running concurrently in the same
client will each tick at their own cadence, each fire their own `onStateChange`,
and each POST `location-update` when in stadium. There's no concurrency
issue at the EF layer — the server is stateless w.r.t. tracker instances —
but you'll get duplicate `app.user_locations` rows per tick.

In practice, almost every consumer wants exactly one tracker bound to the
authenticated user. Multi-tracker setups are reserved for niche cases
(e.g., a single client managing tracking for several user identities).

---

## Stop-on-logout pattern

The tracker doesn't watch the Auth lifecycle. If you're using
managed-lifecycle mode, wire the lifecycle's `cleared` event to
`tracker.stop()`:

```ts
client.auth.onEvent?.((event) => {
  if (event.type === 'cleared') {
    tracker.stop();
  }
});
```

Or, equivalently, call `tracker.stop()` immediately before
`client.auth.logout(...)` or `client.auth.deleteAccount(...)` in your
own logout flow.

In caller-managed mode, manage the lifecycle the same way you manage
`setAccessToken(null)` — both should happen together.

---

## App background / foreground

The tracker continues polling while the app is in the foreground. When
the app is backgrounded:

- On Capacitor iOS/Android, `setInterval` continues to fire as long as
  the JS runtime is alive (typically a few minutes after backgrounding;
  longer if you have a foreground service on Android or background
  capabilities configured on iOS).
- When the JS runtime is suspended, polling pauses and resumes on
  foreground.

If your app needs reliable background presence detection across long
suspension windows (e.g., the user closes the app for 30+ minutes during
a game), you'll need a platform-native background-task mechanism that
calls `tracker.forceTick()` on resume — `setInterval` alone isn't
sufficient on iOS. See the Android Foreground Service pattern in the
mobile app's `LocationContext.tsx` for reference (consumer-side, not
SDK-side).

---

## Tunable cadence

`pollIntervalMs` defaults to 30 seconds. Considerations when tuning:

- **Lower** (e.g., 10s) — faster response to server-state changes, but
  proportionally higher EF call rate per user. At scale, this is the
  dominant load knob.
- **Higher** (e.g., 60s) — lower load, but presence transitions take
  longer to observe. Acceptable for low-stakes presence indicators.

30s was chosen because it matches the OS-level GPS cadence that
`Geolocation.watchPosition` typically delivers in low-accuracy mode, and
because the server-side cron jobs run every 5 minutes — a 30s presence
detection latency comfortably fits inside the 5-minute notification
window.

Do not set `pollIntervalMs` below ~5s; the server's `nearby-venues`
endpoint isn't rate-limited per-client today but a sustained sub-5s
cadence would be visible in the EF call rate and may trigger future
rate limits.

---

## Wire-protocol cross-references

The tracker is a thin convenience over the underlying wire protocol.
For the deeper "why" — request lifecycle, schema vendoring, server-side
spatial-containment policy, the proximity-notification cron's recency
window — see the Lyntari documentation set:

- **`ARCHITECTURE.md` § Location Tracking Pipeline** — end-to-end data
  flow from GPS fix to notification delivery.
- **`ARCHITECTURE.md` § TypeScript SDK and Wire Protocol** — the
  HMAC-signed request lifecycle, vendored-schema parity, and the
  `current_stadium_id` field's role in the v0.2.1+ contract.
- **`ARCHITECTURE.md` § Spatial containment authority** — why the
  server owns containment decisions and the client doesn't run its own
  polygon math.
- **`BACKEND.md` § RPC catalog** — `rpc_get_nearby_venues` and
  `rpc_update_user_location` definitions.
- **[`openapi.yaml`](../openapi.yaml)** — machine-readable contract for
  `nearby-venues` and `location-update`.

---

## When NOT to use the tracker

- **Single-shot location checks.** If you just want to fetch nearby
  venues once on a button press, call `client.location.nearbyVenues(...)`
  directly. The tracker is for sustained polling.
- **Background-only presence detection.** The tracker assumes the JS
  runtime is alive. For true background work (push-driven check-ins,
  geofence triggers from the OS), you'll need a native plugin to drive
  presence; the tracker is foreground-only.
- **Sub-minute presence accuracy.** If you genuinely need 1-second
  presence updates, `pollIntervalMs` lets you tune down, but consider
  whether the cost (EF load, battery on the client) is justified
  vs. piggybacking on an existing OS-level location stream and feeding
  it through `forceTick()` on each event.

---

## Versioning and stability

The tracker shipped in `@lyntari/sdk` v0.2.2. The `current_stadium_id`
field it relies on shipped in v0.2.1. Both are additive on the wire —
older SDK versions calling `nearby-venues` see an unfamiliar extra field
per row and pass it through harmlessly.

Pre-1.0 the API may still evolve. The public surface
(`LocationTracker`, `LocationTrackerOptions`, `LocationTrackerState`,
`LocationTrackerCoordinates`) is reachable via the top-level
`@lyntari/sdk` re-exports.
