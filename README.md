# @lyntari/sdk

Official Lyntari API SDK — typed methods, runtime validation, HMAC-signed transport for Node 18+, modern browsers, and Capacitor mobile clients.

> **Pre-1.0 — pin exact versions in production until 1.0.** Minor-version updates may include breaking changes.

## Quickstart — caller-managed mode

Best for partner integrations, scripts, Node consumers, tests.

```ts
import { createLyntariClient } from '@lyntari/sdk';

const client = createLyntariClient({
  baseUrl: 'https://<project>.supabase.co/functions/v1',
  apiKey: process.env.LYNTARI_API_KEY!,
  hmacSecret: process.env.LYNTARI_HMAC_KEY!,
});

const { token } = await client.auth.login({ email, password });
client.setAccessToken(token);

const profile = await client.reads.profile();
await client.visits.recordSignal({
  venue_id,
  signal_type: 'manual_checkin',
  timestamp_ms: Date.now(),
});
```

Callers handle `ExpiredJwtError`: call `client.auth.refresh({ refresh_token })`, then `client.setAccessToken(newToken)`.

## Quickstart — managed-lifecycle mode

Best for long-running mobile/desktop clients that want persistent auth + auto-refresh.

```ts
import { Preferences } from '@capacitor/preferences';
import {
  createLyntariClient,
  CapacitorPreferencesStorage,
  InMemoryStorage,
  type AuthEvent,
} from '@lyntari/sdk';

const client = createLyntariClient({
  baseUrl, apiKey, hmacSecret,
  auth: {
    storage: new CapacitorPreferencesStorage(Preferences),
    onEvent: (e: AuthEvent) => {
      if (e.type === 'authExpired') showLoginScreen();
    },
  },
});

await client.auth.init();  // restore from storage (idempotent; call at app start)

if (!client.auth.state) {
  await client.auth.login({ email, password });
}
// From here, every JWT-required call auto-refreshes on `expired_jwt`;
// the lifecycle persists rotated tokens and schedules the next refresh.
```

In managed-lifecycle mode the SDK owns:

- Persistent storage across the five stable storage keys (`authToken`, `refreshToken`, `authUser`, `user_id`, `token_expires_at`).
- Pre-expiry refresh scheduling.
- Auto-refresh on `401 expired_jwt` (transport-level retry with the rotated token).
- Discriminated `AuthEvent` surface distinguishing `tokenRefreshed` / `authExpired` / `authError`.

Use `InMemoryStorage` in tests or Node consumers; bring your own adapter implementing `TokenStorage` for other platforms (browser `localStorage`, encrypted filesystem, etc.).

## OneSignal push subscriptions

Mounted on `client.pushSubscriptions` when the client is constructed in managed-lifecycle mode. One call wires the entire orchestration:

```ts
import { Capacitor } from '@capacitor/core';
// `OneSignal` here is the namespace from `onesignal-cordova-plugin` or
// whatever your platform's OneSignal SDK exposes — the SDK references it
// structurally via `OneSignalLike` and has no direct OneSignal dependency.
const OneSignal = window.OneSignal;

client.pushSubscriptions.start?.({
  onesignal: OneSignal,
  getPlatform: () => Capacitor.getPlatform() as 'ios' | 'android' | 'web',
});
```

Behavior:

- Snapshots any subscription that existed before `start()` (covers OneSignal initializing before login).
- Listens for `change` events on `OneSignal.User.pushSubscription` and calls `client.notifications.saveSubscription` on each settled id.
- Dedupes by `subscription_id` — repeat events with the same id are no-ops.
- Buffers events when `user_id` is `null` and flushes on login.
- Clears the buffer + last-saved id on `authExpired` so a subsequent login under a different account doesn't inherit the prior user's binding.
- `saveSubscription` rejections don't update last-saved — the next change event retries.

Call `client.pushSubscriptions.stop?.()` to detach listeners.

## In-stadium tracker

`client.location.createTracker(...)` is a stateful polling module that detects
when the authenticated user is inside a stadium polygon and keeps the server
informed. Mounted on `client.location` in both client modes — does not depend
on the managed-lifecycle Auth surface — but in practice callers want the
tracker to run for the lifetime of an authenticated session, so most
consumers create it after login and `stop()` it on logout.

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
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
  },
  onStateChange: (state) => {
    // state: { inStadium, currentStadiumId, nearbyVenues, coordinates }
    setUserLocation(state);  // wire into your UI / app state
  },
  onError: (err) => logger.error('tracker error', err),
  // pollIntervalMs: 30_000,  // optional; default 30s
});

tracker.start();
// Later, e.g. on logout or app teardown:
tracker.stop();
```

Each tick:

1. The SDK calls your `getCurrentPosition` for fresh coords.
2. It calls `client.location.nearbyVenues({latitude, longitude})`.
3. Extracts `currentStadiumId = result[0]?.current_stadium_id ?? null` and
   emits `onStateChange({inStadium, currentStadiumId, nearbyVenues, coordinates})`.
4. If `inStadium === true`, POSTs `client.location.update({latitude, longitude,
   accuracy, timestamp_ms})` so the server-side proximity-notification cron's
   spatial gate sees a fresh `app.user_locations` row.

Behavior:

- **Polling-only.** The 30s `setInterval` drives the cadence; the tracker
  does not consume OS movement events. This is deliberate — on iOS in
  low-accuracy mode, `Geolocation.watchPosition` can stay silent for
  minutes on a stationary device, missing server-state transitions like
  a stadium-geofence row added after the user has already arrived. Polling
  guarantees that any transition is observed within `pollIntervalMs`.
- **`start()` fires an immediate tick** before the first interval. Don't
  wait 30s on app launch to get initial state.
- **`stop()` clears the interval** and suppresses late callbacks from any
  in-flight tick. Safe to call on consumer unmount.
- **`forceTick()` runs a tick outside the cadence.** Returns the in-flight
  promise if a tick is already running (no double-fire). Use for
  app-resume, permission-granted, pull-to-refresh, manual debug.
- **In-flight de-dupe.** Overlapping `setInterval` fires + `forceTick()`
  calls all await the same shared promise — `nearby-venues` is never called
  concurrently for the same tracker.
- **Errors route to `onError(err)`.** The loop keeps polling on transient
  failures (network blips, GPS timeouts). To terminate on terminal-auth
  errors, inspect `err` in `onError` and call `tracker.stop()`:
  `if (err instanceof LyntariApiError && err.terminalForAuth) tracker.stop();`.
- **`onStateChange` fires every successful tick** with no SDK-side de-dupe.
  Coordinates change every tick so any de-dupe degenerates to identity;
  React-style consumers using setState get implicit referential-equality
  filtering for free.
- **`isRunning()`** reflects whether `start()` has been called and `stop()`
  has not. Idempotent — second `start()` is a no-op.

Deep-dive in [`docs/location-tracker.md`](./docs/location-tracker.md).

## Transport retry behaviors

`postWithHMAC` retries up to once per category, max one of each per call:

| Trigger | Action |
| --- | --- |
| `401 bad_signature` | Re-sign with a fresh timestamp (clock-skew self-heal). |
| `409 visit_race_conflict` + `retry_safe: true` | Brief backoff, retry the same request. |
| `401 expired_jwt` + Auth lifecycle wired | Refresh the access token and retry once. |

See `src/index.ts` for the full client surface and [`openapi.yaml`](./openapi.yaml) for the machine-readable API contract.

## Integration workflows

End-to-end workflow guides live in [`docs/`](./docs/):

- **[location-tracker.md](./docs/location-tracker.md)** — in-stadium presence polling, the `current_stadium_id` wire contract, and how the tracker plays with `nearby-venues` + `location-update`.
- **[push-integration.md](./docs/push-integration.md)** — push notification subscription lifecycle, trigger contract, server-composed copy, and the `notification-event` analytics surface.
- **[ibeacon-integration.md](./docs/ibeacon-integration.md)** — opt-in BLE iBeacon detection flow.

## License

Proprietary. See [`LICENSE`](./LICENSE). Use of this software requires a written agreement with Lyntari, Inc. This package is published publicly so partners under written agreement can install it via npm; use without such agreement is not licensed.
