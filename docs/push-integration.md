# Push notification integration

**Audience:** partner clients integrating with the Lyntari backend.
**Pair with:** [`openapi.yaml`](../openapi.yaml) (the `save-subscription`,
`get-subscription-id`, `notification-trigger`, `notification-event` endpoints).

This doc covers the end-to-end push lifecycle: subscription register → trigger
contract → server-composed copy → client event recording. If your client uses
`@lyntari/sdk` in managed-lifecycle mode,
`client.pushSubscriptions.initialize(...)` wires most of this in one call —
see [§ Using `@lyntari/sdk`](#using-lyntarisdk) below. If you're integrating
without the SDK, follow the wire contract sections directly.

---

## Provider — OneSignal

Lyntari uses OneSignal as the push delivery layer. The backend's
`notification-trigger` Edge Function posts to OneSignal's REST API
(`https://onesignal.com/api/v1/notifications`) with OneSignal-shaped
payload (`app_id`, `include_subscription_ids`, `headings`, `contents`,
`data`). Partner clients integrate the OneSignal SDK on the device side;
the SDK's `PushSubscriptions` types are OneSignal-shaped.

---

## OneSignal app

The Lyntari backend dispatches push notifications through a single
OneSignal app. Partners integrating push subscriptions wire the OneSignal
Web/Mobile SDK with the App ID Lyntari provides at integration time, plus
the appropriate platform identifier (FCM Sender ID for Android, APNs cert
for iOS) configured in the OneSignal dashboard.

- **OneSignal App ID:** `<provided by Lyntari at integration>`

---

## Subscription lifecycle

### 1. Initialize OneSignal SDK

On app startup, after the user has been authenticated (post-login or
post-signup), initialize the OneSignal SDK and request notification
permission per platform conventions. Do not request permission on first
launch before the user has any context for what notifications you'll send —
that's a one-shot decision and a "no" is hard to reverse.

### 2. Capture the subscription identifier

OneSignal provides a stable subscription identifier once the user has
granted permission. The SDK exposes it as:

- iOS / Android (Native): `OneSignal.User.pushSubscription.id` (or platform
  equivalent depending on SDK version)
- Web: equivalent property on the OneSignal JS SDK

This is what Lyntari calls `subscription_id`. It is the OneSignal-internal
identifier that maps a user to their device push channel(s).

A user may have multiple subscription IDs (one per device); Lyntari stores
the most recent one wholesale. The latest device wins.

### 3. Optionally capture the push token

OneSignal also exposes the platform-native push token (APNs / FCM). Lyntari
stores this as `push_token` for diagnostic purposes; it is **not** used for
delivery (OneSignal handles delivery internally). If the SDK doesn't expose
the token (some SDK versions delay it), pass `null`.

### 4. Save the subscription

POST to `save-subscription`:

```json
{
  "subscription_id": "<onesignal-subscription-id>",
  "push_token":      "<apns-or-fcm-token-or-null>",
  "platform":        "ios" | "android" | "web"
}
```

`save-subscription` is HMAC + JWT and idempotent. Repeated calls with the
same `subscription_id` are server-side no-ops; calling it again with a new
ID rotates the binding to that ID.

### 5. Verify the binding (optional)

POST to `get-subscription-id` to confirm what the backend has on file for
the current user:

```json
{ "subscription_id": "<onesignal-subscription-id-or-null>" }
```

Returns `null` if the user has no subscription on file. Useful for
diagnostic / troubleshooting flows ("notifications aren't arriving — let me
check what the backend thinks the subscription is").

### When to call `save-subscription`

**On login / signup**, after the OneSignal SDK has produced a subscription
ID — the user has just authenticated and the binding may have changed since
last use (different device, fresh install, OS-level permission flip).

**On OneSignal subscription refresh** — some SDK lifecycle events fire when
the underlying subscription rotates (token refresh, OS reset). When the SDK
emits a "subscription changed" event, post the new ID to `save-subscription`.

**On notification permission change** — when the user toggles permission
from off to on, the SDK may produce a new subscription ID. Post it.

You do NOT need to call `save-subscription` before every push — the binding
is durable. Call it on lifecycle events, not as a heartbeat.

### Unbinding (logout)

There is no explicit unbind endpoint. On logout, the client should:

1. Call `auth-logout` to revoke the refresh token.
2. Optionally call `OneSignal.logout()` (or platform equivalent) to clear
   the SDK's local user binding so the next login starts clean.

The backend retains the last-known `subscription_id` for the user;
`notification-trigger` will not fire if the user has no active session
because the trigger is JWT-authenticated. Stale subscription IDs after
logout are not a security or correctness issue — they are at most a
"notification sent to a logged-out device" risk, which the cooldowns and
in-stadium gating already mitigate.

### Account deletion

`delete-account` soft-deletes the user; the server clears the subscription
record and purges remaining state after a retention window.

Clients should call `OneSignal.logout()` and clear local OneSignal state on
delete-account success to prevent OS-level notification UI from claiming
the user is still subscribed.

---

## Triggering a notification

The Lyntari backend emits push notifications via OneSignal. Notification copy
(title, body) is generated **server-side** in `notification-trigger` from a
structured `meta` object; clients do not — and cannot — supply free-form
`title` or `body` strings.

### Why server-owned copy

The `API_KEY` and `HMAC_KEY` are bundled in client builds and are
explicitly designed to be public — they authenticate the *application*,
not the user. If `notification-trigger` accepted client-composed copy,
anyone with those keys could compose notifications with arbitrary
title/body. Server ownership of copy generation eliminates this.

`meta.heading`, `meta.message`, and `meta.buttons` are silently stripped
before the OneSignal API call. Do not attempt to send these fields.

### Trigger types

The SDK schema (`NotificationTriggerRequestSchema`) constrains `trigger_type`
to four values. Sending any other value returns `400 validation_failed`.

| `trigger_type`   | Use case                                       | Required `meta` fields            |
| ---------------- | ---------------------------------------------- | --------------------------------- |
| `proximity`      | User is within GPS proximity of a venue        | `distance` (m); optionally `floor`, `section` |
| `beacon`         | BLE beacon detection from venue's beacon set   | `proximity` (`immediate` / `near` / `far`) |
| `wait_time_drop` | Wait time at a venue dropped significantly     | `previous_wait`, `current_wait` (minutes) |
| `short_wait`     | Wait time at a venue is currently short        | `previous_wait`, `current_wait` (minutes) |

Server-side cooldowns prevent spam: a per-user, per-venue, per-trigger-type
window suppresses repeats. Specific durations are not part of the public
contract — when a request is suppressed the response carries
`{sent: false, reason: 'cooldown_active'}`, which is the load-bearing
signal for clients.

A user must also be physically inside the venue's stadium geofence for a
notification to fire — outside the geofence, the response is
`{sent: false, reason: 'outside_stadium'}`.

### Request shape

```json
{
  "trigger_type": "proximity",
  "venue_id": "550e8400-e29b-41d4-a716-446655440000",
  "context": {
    "distance": 47,
    "floor": 2,
    "section": "B"
  }
}
```

`venue_id` is a UUID v4. `context` is the structured metadata bag passed
to the server-side composer (the server reads it as `meta`). Schema-level
validation is permissive on `context` — the field shape is enforced by
the per-trigger composer at runtime.

### Server-composed copy by `trigger_type`

The current server-side composer generates copy by `trigger_type`:

#### `proximity`

```
title: "{venue_name} Nearby! 📍"
body:  "Only {distance}m away{location_desc}. Check it out!"
```

`location_desc` is built from `meta.floor` + `meta.section`:
- both present → ` on Floor {floor}, Section {section}`
- floor only → ` on Floor {floor}`
- section only → ` in Section {section}`
- neither → empty

`meta.distance` defaults to `50` if missing or non-numeric. Distance is
rounded to the nearest meter.

#### `beacon`

```
title: "You're right at {venue_name}! 👋"     (proximity = "immediate")
title: "{venue_name} is close by 👋"           (proximity = "far")
title: "You're near {venue_name}! 👋"          (proximity = "near" / default)
body:  "Tap to check in at {venue_name}"
```

Beacon notifications do **not** carry payload-level action buttons.
Notification body taps deep-link to the venue detail page via the
`data.venue_id` field — partner clients should route on body tap, not
expect button taps.

#### `wait_time_drop` / `short_wait`

Both share copy:

```
title: "{venue_name} Wait Time Dropped! ⏱️"
body:  "Wait time dropped from {previous_wait} to {current_wait} minutes. Great time to visit!"
```

`meta.previous_wait` defaults to `15`; `meta.current_wait` defaults to `3`.

#### Default (unrecognized `trigger_type`)

Validation rejects unknown trigger types at the SDK boundary, so this
branch is unreachable from properly-validated callers. If somehow reached,
the default copy is:

```
title: "Lyntari Update"
body:  "Check out what's happening at the stadium"
```

### OneSignal payload assembly

For reference — clients do not construct this themselves. The EF builds:

```json
{
  "app_id": "<ONESIGNAL_APP_ID>",
  "include_subscription_ids": ["<onesignal_subscription_id>"],
  "headings": { "en": "<title>" },
  "contents": { "en": "<body>" },
  "data": {
    "type": "<trigger_type>",
    "notification_id": "<uuid>",
    "trigger_type": "<trigger_type>",
    "venue_id": "<uuid>",
    "venue_name": "<string>",
    "user_id": "<uuid>",
    "<...meta fields excluding heading/message/buttons>"
  }
}
```

The `data` block is what the client receives in the foreground / background
notification handler. It is the canonical surface for routing — clients
deep-link to a venue page on body tap via `data.venue_id`.

`notification_id` is generated server-side and is the key clients use to
record open / click / dismiss events via `notification-event`.

### Response shape

`200 OK`:

```json
{
  "sent": true,
  "notification_id": "<uuid>",
  "request_id": "req_<uuid>"
}
```

When `sent: false`, the response includes a `reason` string explaining why:

| `reason`              | Meaning                                                      |
| --------------------- | ------------------------------------------------------------ |
| `outside_stadium`     | User's latest GPS fix is outside the venue's stadium geofence |
| `cooldown_active`     | A notification of the same trigger was sent within the cooldown window |
| `category_disabled`   | User has the venue's category disabled in their preferences  |
| `no_subscription`     | User has no active OneSignal subscription on file            |

`sent: false` with a known reason is a successful 200 — the call did its job
of asking, and the server declined to send. Treat it as informational, not
an error.

### Categories and user preferences

Venues belong to categories; users opt in/out of categories via
`save-category-preferences`. A `notification-trigger` with a `venue_id`
whose category is disabled by the user returns
`{sent: false, reason: 'category_disabled'}` regardless of cooldowns.

The category catalog is fetched via `get-categories`. The current user's
preferences are fetched via `get-category-preferences` and replaced wholesale
via `save-category-preferences` (empty array clears all preferences).

### Idempotency

`notification-trigger` is idempotency-keyed at the transport layer. Repeats
of the same request with the same `Idempotency-Key` header replay the cached
response (including `sent: true|false`) within the cache TTL. A duplicate
request with no key behaves as a fresh call and may produce a duplicate push
if cooldowns have elapsed.

---

## Client handler responsibilities

When a push arrives:

1. **Display.** Render the notification per platform conventions
   (foreground vs. background).
2. **Route on body tap.** Read `data.venue_id` from the data block and
   navigate to your client's venue detail page (e.g., `/venue/<venue_id>`).
   Notifications do not carry deep-link URLs; routing is per-client.
3. **Record interactions** via `notification-event`:
   - `notification_id` (from `data.notification_id`)
   - `event_type`: `received` | `opened` | `dismissed`
   - `timestamp_ms`: epoch ms
   - `meta` (optional)

If you use `@lyntari/sdk` in managed-lifecycle mode, `received` and `opened`
event recording is automatic — see below.

### Using `@lyntari/sdk`

Partners on the official TypeScript SDK can wire the entire push lifecycle
with one call. Mounted on `client.pushSubscriptions` when the client is
constructed with managed-lifecycle mode (`auth: { storage, onEvent? }`):

```ts
client.pushSubscriptions.initialize?.({
  appId: ONESIGNAL_APP_ID,
  getPlatform: () => Capacitor.getPlatform() as 'ios' | 'android' | 'web',
  onForegroundNotification: (notification) => {
    // Render your in-app banner with notification.title / .body / .additionalData
  },
  onNotificationOpened: ({ data, notificationId }) => {
    // Route on body tap. Typical: data.venue_id → /venue/<id>
    const venueId = typeof data.venue_id === 'string' ? data.venue_id : null;
    if (venueId) navigate(`/venue/${venueId}`);
  },
});
```

The SDK module owns: OneSignal namespace resolution (window globals with
fallbacks), plugin init (v5 → v4 → legacy), foreground + opened event
listeners, automatic `received` / `opened` event reporting via
`notification-event`, and the subscription save lifecycle (snapshot pre-
existing subscription, listen for `change` events, dedupe by id, buffer
pre-login captures and flush on `tokenRefreshed`).

Partners not using the SDK should follow the manual flows above (subscription
lifecycle § 1-5 + the `notification-event` posting in client handler
responsibilities § 3).

---

## Troubleshooting

**"User isn't receiving notifications"**

1. `get-subscription-id` — confirm the backend has a non-null
   `subscription_id` for the user.
2. Check OneSignal dashboard: search by external_user_id (= Lyntari user ID)
   and confirm the subscription is "subscribed" status.
3. `notification-trigger` returns `{sent: false, reason: ...}` — the reason
   field is canonical:
   - `no_subscription` — backend has null on file. Re-call `save-subscription`.
   - `outside_stadium` — user's latest GPS fix is outside the venue
     geofence; not a subscription problem.
   - `category_disabled` — user has opted out of the venue's category.
   - `cooldown_active` — last notification of this trigger was within the
     cooldown window.

**"Subscription ID changed but backend still has the old one"**

The SDK's "subscription changed" event isn't firing, or the client isn't
calling `save-subscription` on it. Most SDK versions emit this event
reliably; double-check the wiring. As a fallback, call `save-subscription`
on every successful login. With `client.pushSubscriptions.initialize(...)`,
this is automatic — the module flushes any pending subscription on
`tokenRefreshed`.

**"Notifications work against one environment but not another"**

Confirm the client is configured with the correct `baseUrl` and that the
user account exists in the target environment. The OneSignal subscription
is bound to the OneSignal-internal user, keyed by the Lyntari user ID —
the same OneSignal app sees distinct subscriptions per Lyntari environment
because the user IDs differ.

---

## Versioning and stability

The `trigger_type` enum is part of the public contract — adding a new
value is a server-side rollout that lands in the SDK schema before the
server accepts it. Removing a value is a breaking change.

Copy strings are server-owned and may change at any time without a contract
bump — clients render whatever the server produced. Do not depend on exact
title/body text in tests; assert structural fields (`notification_id`,
`trigger_type`, `venue_id`) instead.

---

## Privacy and PII

`subscription_id` and `push_token` are credentials — Lyntari treats them
as such and redacts them from server logs. Partner clients should treat
them similarly: do not log them, do not surface them in error messages,
and clear them from local state on logout.
