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

- **[push-integration.md](./docs/push-integration.md)** — push notification subscription lifecycle, trigger contract, server-composed copy, and the `notification-event` analytics surface.
- **[ibeacon-integration.md](./docs/ibeacon-integration.md)** — opt-in BLE iBeacon detection flow.

## License

Proprietary. See [`LICENSE`](./LICENSE). Use of this software requires a written agreement with Lyntari, Inc. This package is published publicly so partners under written agreement can install it via npm; use without such agreement is not licensed.
