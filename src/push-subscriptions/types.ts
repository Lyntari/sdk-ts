/**
 * Public types for the `PushSubscriptions` module.
 *
 * The module abstracts the OneSignal SDK behind a minimal structural
 * interface (`OneSignalLike`) so the SDK package has zero direct OneSignal
 * dependency. Consumers pass the OneSignal namespace at `start()` time.
 *
 * Platform is also injected (`getPlatform`) — Capacitor's `getPlatform()`
 * lives in `@capacitor/core`, which the SDK deliberately does not depend on.
 */

/**
 * The current-subscription payload OneSignal hands to `change` listeners.
 * Fields are nullable because OneSignal may emit `change` events with a
 * subscription_id but no push_token (token arrives later) and vice versa.
 */
export interface OneSignalSubscriptionChangeEvent {
  readonly current: {
    readonly id?: string | null;
    readonly token?: string | null;
  };
}

/**
 * Minimal `OneSignal.User.pushSubscription` surface. Matches both v5 sync
 * properties and async getters — the module prefers async when available
 * (more reliable on cold-start where the sync property may not be hydrated
 * yet) and falls back to sync.
 */
export interface OneSignalPushSubscriptionLike {
  readonly id?: string | null;
  readonly token?: string | null;
  getIdAsync?(): Promise<string | null>;
  getTokenAsync?(): Promise<string | null>;
  addEventListener(
    event: 'change',
    listener: (event: OneSignalSubscriptionChangeEvent) => void,
  ): void;
  removeEventListener?(
    event: 'change',
    listener: (event: OneSignalSubscriptionChangeEvent) => void,
  ): void;
}

/**
 * Minimal OneSignal SDK surface. Consumers pass the resolved OneSignal
 * namespace (e.g., `window.OneSignal` from the Cordova plugin or the
 * `onesignal-cordova-plugin` default export). When `initialize()` is
 * called without an explicit `onesignal` field, the module attempts
 * window-global resolution and walks the documented v5 namespace fallbacks
 * (`.default`, `.OneSignalPlugin`, then the wrapper itself).
 *
 * The `Notifications` namespace and `setNotificationOpenedHandler` /
 * `initialize` / `setAppId` properties are duck-typed at access time —
 * not modeled here — because they're optional across OneSignal SDK
 * versions and the module probes for each.
 */
export interface OneSignalLike {
  readonly User: {
    readonly pushSubscription: OneSignalPushSubscriptionLike;
  };
}

/**
 * Options for `PushSubscriptions.initialize()` — the end-to-end OneSignal
 * setup call that replaces the previously-scattered per-client init,
 * event-listener wiring, and subscription save orchestration.
 *
 * Passing `onesignal` is optional in browser/Capacitor environments where
 * the plugin attaches to `window.OneSignal` (or `window.plugins.OneSignal`
 * under older Cordova builds). The module will resolve the namespace via
 * those globals and walk `.default` / `.OneSignalPlugin` / the wrapper
 * itself. Pass an explicit namespace when running outside that resolver's
 * coverage (server-side, testing, or non-Cordova platforms).
 *
 * `appId` is the OneSignal application id. The module probes for the
 * concrete init method in this order:
 *   1. `OneSignal.initialize(appId)` (v5 modern API)
 *   2. `OneSignal.setAppId(appId)` (v4 legacy API)
 *   3. `OneSignal._appID = appId` (last-resort property set; v3-era)
 *
 * `getPlatform` returns the wire-protocol platform string (`'ios'`,
 * `'android'`, `'web'`, or any other string the server accepts). Called
 * on each `change` event to attach a fresh platform value to the
 * subscription save.
 *
 * `onForegroundNotification` is invoked when OneSignal delivers a push
 * while the app is in the foreground — the host renders an in-app banner
 * or similar. Called with the raw OneSignal notification object
 * (`{ title, body, additionalData, ... }`); the module also auto-fires
 * a `received` event to `notification-event` for analytics. Returning
 * from the callback is non-blocking.
 *
 * `onNotificationOpened` fires when the user taps the notification body.
 * Receives the raw OneSignal data block (`additionalData` from the
 * payload) — typically `{ venue_id, trigger_type, notification_id, ... }`
 * per the `INTEGRATION_PUSH_PAYLOAD.md` contract. Host implements routing
 * (deep-link to a venue page, etc.). The module auto-fires an `opened`
 * event to `notification-event` so consumers don't have to.
 */
export interface PushSubscriptionsInitializeOptions {
  /** OneSignal application id. */
  readonly appId: string;
  /** Returns the wire-protocol `platform` string. */
  readonly getPlatform: () => PushPlatform;
  /** Override the window-global resolver. Optional in browser/Capacitor. */
  readonly onesignal?: OneSignalLike;
  /** Foreground push handler. SDK auto-reports `received` to notification-event. */
  readonly onForegroundNotification?: (notification: ForegroundNotificationPayload) => void;
  /** Notification-body-tap handler. SDK auto-reports `opened` to notification-event. */
  readonly onNotificationOpened?: (data: NotificationOpenedPayload) => void;
}

/**
 * Subset of the OneSignal notification shape passed to foreground handlers.
 * OneSignal returns a richer object; the module documents only the fields
 * that have a stable wire-protocol meaning across SDK versions.
 */
export interface ForegroundNotificationPayload {
  readonly title?: string;
  readonly body?: string;
  readonly additionalData?: Record<string, unknown>;
}

/**
 * Payload passed to the notification-opened callback. `data` is the raw
 * `additionalData` block emitted by `notification-trigger` (see
 * `INTEGRATION_PUSH_PAYLOAD.md`). `notificationId` is broken out for
 * convenience (it's also in `data.notification_id`).
 */
export interface NotificationOpenedPayload {
  readonly data: Record<string, unknown>;
  readonly notificationId?: string;
}

/**
 * Platform string passed to `save-subscription`. The server accepts
 * arbitrary strings and defaults to `'unknown'`; Capacitor clients typically pass
 * `'ios'`, `'android'`, or `'web'` via `Capacitor.getPlatform()`. The
 * union widens to `string` for non-Capacitor integrators.
 */
export type PushPlatform = 'ios' | 'android' | 'web' | (string & {});

export interface PushSubscriptionsStartOptions {
  /** OneSignal namespace reference — provides the `User.pushSubscription` surface. */
  readonly onesignal: OneSignalLike;
  /** Returns the wire-protocol `platform` string. Called per save (idempotent). */
  readonly getPlatform: () => PushPlatform;
}

/** Optional logger hooks. Default is silent. */
export interface PushSubscriptionsLogger {
  log?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}
