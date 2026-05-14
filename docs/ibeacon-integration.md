# iBeacon integration

**Audience:** partner clients integrating with the Lyntari backend that wish
to support beacon-triggered notifications.
**Pair with:** [`openapi.yaml`](../openapi.yaml) (the `beacon-config`,
`beacon-detection`, `notification-trigger` endpoints),
[`push-integration.md`](./push-integration.md).

> **Optional, opt-in feature.** BLE beacon scanning is not a required core
> capability. Many venues will never deploy beacons; many users will never opt
> into Bluetooth. Clients that don't support beacon scanning can ignore this
> document — every other notification path (proximity, wait_time_drop,
> short_wait) works without beacons.

---

## Overview

Beacon-triggered notifications fire when the client app detects a registered
BLE beacon for a venue and the user is inside the venue's stadium geofence.
The flow:

1. Client fetches the active beacon catalog via `beacon-config`.
2. Client subscribes to BLE iBeacon advertisements matching the catalog.
3. On detection, client posts to `beacon-detection` (logging) and to
   `notification-trigger` with `trigger_type = "beacon"` (the user-visible
   action).

`beacon-detection` is the diagnostic / analytics signal; `notification-trigger`
is what produces the push. They are separate endpoints; clients call both
when a beacon is detected with sufficient confidence.

---

## Beacon catalog

`beacon-config` (GET, API key only, no JWT) returns the active beacon
catalog:

```json
[
  {
    "beacon_uuid": "fda50693-a4e2-4fb1-afcf-c6eb07647825",
    "major":       1,
    "minor":       42,
    "venue_id":    "550e8400-e29b-41d4-a716-446655440000",
    "venue_name":  "Concession Stand A"
  },
  ...
]
```

The catalog is global to the deployment — not per-user — and is intended to
be cached by the client. Suggested cache: 1 hour. Refresh on app foreground
if older than the cache TTL or on explicit user action ("refresh venues").

iBeacon identification triple is `(beacon_uuid, major, minor)`. The client's
BLE scanner should be configured to monitor advertisements matching any of
the catalog's UUID/major/minor combinations. Most BLE platforms allow a
short list of UUIDs to monitor; if the catalog grows beyond what the
platform supports, scope down to the venue(s) the user is currently near.

---

## Detection contract

When the client detects a beacon advertisement, post to `beacon-detection`:

```json
{
  "beacon_uuid": "fda50693-a4e2-4fb1-afcf-c6eb07647825",
  "major":        1,
  "minor":        42,
  "rssi":         -67,
  "distance":     1.4,
  "timestamp_ms": 1715000000000
}
```

| Field          | Type    | Notes                                                  |
| -------------- | ------- | ------------------------------------------------------ |
| `beacon_uuid`  | UUID    | iBeacon proximity UUID (lowercase)                     |
| `major`        | integer | iBeacon major (0-65535)                                |
| `minor`        | integer | iBeacon minor (0-65535)                                |
| `rssi`         | integer | Received signal strength in dBm (typically -30 to -100)|
| `distance`     | number  | Estimated meters from beacon (platform-derived)        |
| `timestamp_ms` | integer | Epoch ms at detection                                  |

The server logs the detection (currently a no-op when no beacons are
configured for the deployment, but the contract is stable). It does not
produce a notification — that's a separate `notification-trigger` call.

---

## Notification trigger contract

After `beacon-detection`, post to `notification-trigger` with
`trigger_type = "beacon"`:

```json
{
  "trigger_type": "beacon",
  "venue_id":     "<venue_id from beacon-config>",
  "context": {
    "proximity":    "immediate" | "near" | "far",
    "beacon_uuid":  "fda50693-a4e2-4fb1-afcf-c6eb07647825",
    "major":        1,
    "minor":        42,
    "rssi":         -67
  }
}
```

`proximity` is the client-side classification of the detection's confidence:

- `immediate` — user is right at the beacon (typically `distance < 1m`,
  `rssi > -50`)
- `near` — within range (typically `distance 1-3m`, `rssi -50 to -70`)
- `far` — detected but not close (typically `distance > 3m`, `rssi < -70`)

These thresholds are guidance; clients tune to their device profiles.

The server-composed copy switches on `proximity` (see
[`push-integration.md`](./push-integration.md), "beacon" section). The push
notification does NOT carry payload-level action buttons — body tap
deep-links to the venue detail page via `data.venue_id`.

---

## Cooldowns

`notification-trigger` enforces a per-user, per-venue, per-trigger-type
cooldown server-side. Suppressed calls return
`{sent: false, reason: 'cooldown_active'}` — that's the load-bearing
signal; clients should branch on it rather than tracking cooldown windows
themselves.

A client-side cooldown (e.g., a few minutes of in-memory dedup per venue)
is recommended as a network-savings optimization — but it's redundant
with the server gate, not a substitute.

`beacon-detection` does NOT enforce notification cooldowns because it's a
logging signal — every detection that meets the client's confidence
threshold should be posted, even if no notification fires.

---

## Geofence gating

Beacon notifications are gated by the user being inside the venue's
stadium geofence. A beacon detection outside the geofence is logged but
does not produce a notification — the response is
`{sent: false, reason: 'outside_stadium'}`.

This is intentional: a stale or rogue beacon advertisement from outside the
stadium shouldn't be able to spoof a notification. Clients should still post
the detection (it's diagnostic) but expect no push.

---

## Using `@lyntari/sdk`

The SDK exports helpers for decoding raw BLE scan results and managing the
stale-entry eviction loop most clients implement:

```ts
import { parseIBeaconData, cleanupStaleBeacons } from '@lyntari/sdk';

// In your BLE scan callback:
const parsed = parseIBeaconData(scanResult);
// → { uuid, major, minor, rssi, proximity, accuracy } | null

// In your periodic cleanup tick:
cleanupStaleBeacons(detectedBeacons, 10_000); // drop entries older than 10s
```

`parseIBeaconData` decodes the canonical Apple iBeacon manufacturer-data byte
layout (company ID 0x004C, type 0x02, length 0x15, UUID + big-endian major /
minor + tx_power). Returns `null` on missing / short / wrong-prefix frames —
silent failure for tight scan-callback loops. The proximity band thresholds
match Apple's published values (< 0.5m immediate / < 3m near / else far).

`cleanupStaleBeacons` is a generic in-place eviction over any
`Map<string, { lastSeen: number }>`. `now` is injectable for tests; defaults
to `Date.now()`.

Neither helper touches the BLE plugin or wire protocol — they're pure-math
decoders. Wire your BLE source (Capacitor BLE plugin, native iOS / Android,
Web Bluetooth) per platform conventions and feed the raw scan callbacks
through `parseIBeaconData`.

---

## Privacy

Beacon detection data is sensitive — it's a precise indoor-location signal.
Lyntari treats it as such on the server side:

- `beacon_uuid`, `major`, `minor` are not written to server logs (they
  could correlate to a venue location).
- Bare RSSI / distance values are kept (purely numeric, no identifier).
- Full request bodies are never written to server logs.

The detection record itself is stored server-side and subject to Lyntari's
data retention policy.

Partner clients should:

- Disable beacon scanning when the user has not opted into Bluetooth /
  precise location.
- Provide a clear opt-out in the app's notification settings.
- Avoid logging beacon UUIDs or raw advertisement data in client-side logs.

---

## When to skip the beacon path entirely

If the client app:

- Doesn't have the OS permissions for BLE scanning, OR
- Is targeting a venue that hasn't deployed beacons (most venues today),

then skip everything in this document. The other notification triggers
(`proximity`, `wait_time_drop`, `short_wait`) provide the user-visible value;
beacons are the +1 for indoor venues that have invested in the hardware.

We recommend gating the entire beacon code path on a runtime feature flag
for exactly this reason — beacons should be an opt-in code path you can turn
off without re-shipping the app.
