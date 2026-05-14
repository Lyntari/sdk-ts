/**
 * `PushSubscriptions` — owns the OneSignal subscription save lifecycle
 * end-to-end.
 *
 * Replaces the scattered orchestration that integrating clients would
 * otherwise stitch together themselves: cold-start subscription snapshot,
 * change-event listener wiring, pre-login buffering, and post-login flush.
 *
 * Behavior:
 *  1. On `start()`, attach a OneSignal `change` listener and snapshot the
 *     current subscription (covers the case where OneSignal produced a
 *     subscription_id before login — historically a 50-line workaround).
 *  2. When a subscription is observed:
 *       - If `user_id` is set, call `saveSubscription` and dedupe by id.
 *       - Otherwise, buffer the latest tuple and replay when `user_id`
 *         arrives via `onUserIdChange`.
 *  3. When `user_id` transitions to null (voluntary logout, `deleteAccount`,
 *     explicit `client.auth.clear()`, or terminal refresh failure — all
 *     surface as the lifecycle's `cleared` event), reset
 *     `lastSavedSubscriptionId` so the same subscription can be re-saved
 *     under the next user. The pending tuple is preserved — the OneSignal
 *     subscription is hardware-level and survives the auth lifecycle, so
 *     when a different user logs in on the same device, the bridge fires
 *     `tokenRefreshed` and `flushPending` saves under the new `user_id`
 *     without needing another `change` event.
 *  4. `saveSubscription` failures don't update `lastSavedSubscriptionId`,
 *     so the next change event (or a forced re-flush) retries.
 *
 * Idempotency: `start()` is a no-op if already started. `stop()` is the
 * inverse and is safe to call before `start()` or after `stop()`.
 *
 * Wired from `createLyntariClient` when `auth: { ... }` is configured —
 * the module requires the Auth lifecycle to provide `user_id` visibility.
 */

import type { NotificationsMethods } from '../methods/notifications.js';
import type {
  ForegroundNotificationPayload,
  NotificationOpenedPayload,
  OneSignalLike,
  OneSignalPushSubscriptionLike,
  OneSignalSubscriptionChangeEvent,
  PushPlatform,
  PushSubscriptionsInitializeOptions,
  PushSubscriptionsLogger,
  PushSubscriptionsStartOptions,
} from './types.js';

export interface PushSubscriptionsDeps {
  /** Bound `client.notifications.saveSubscription`. Idempotent server-side. */
  readonly saveSubscription: NotificationsMethods['saveSubscription'];
  /**
   * Bound `client.notifications.notificationEvent`. Used by `initialize()`
   * to auto-fire `received` / `opened` events when the host wires the
   * foreground / opened handlers; left absent when only `start()` is in use.
   */
  readonly notificationEvent?: NotificationsMethods['notificationEvent'];
  /** Returns the currently-authenticated user_id, or `null` pre-login. */
  readonly getUserId: () => string | null;
  /**
   * Subscribe to user_id transitions. Listener receives the new user_id
   * (login / refresh) or `null` (clear / authExpired). Returns an
   * unsubscribe function called by `stop()`.
   */
  readonly onUserIdChange: (listener: (userId: string | null) => void) => () => void;
  /** Optional logging hooks. Silent when absent. */
  readonly logger?: PushSubscriptionsLogger;
}

declare const globalThis: {
  OneSignal?: unknown;
  plugins?: { OneSignal?: unknown };
};

interface PendingSubscription {
  subscription_id: string;
  push_token: string | null;
  platform: PushPlatform;
}

export class PushSubscriptions {
  private state: 'idle' | 'started' = 'idle';
  private pending: PendingSubscription | null = null;
  private lastSavedSubscriptionId: string | null = null;
  private oneSignalRef: OneSignalLike | null = null;
  private getPlatform: (() => PushPlatform) | null = null;
  private changeListener: ((event: OneSignalSubscriptionChangeEvent) => void) | null = null;
  private authUnsubscribe: (() => void) | null = null;
  private foregroundListener: ((event: unknown) => void) | null = null;
  private foregroundOneSignal: unknown = null;

  constructor(private readonly deps: PushSubscriptionsDeps) {}

  /**
   * End-to-end OneSignal setup: namespace resolution + plugin init + event
   * listeners + subscription save lifecycle in one call. Subsumes the
   * orchestration an integrating client would otherwise wire by hand
   * (multi-tier OneSignal namespace fallback, multi-tier init API fallback,
   * foreground / opened listener wiring, manual event forwarding to
   * `notification-event`).
   *
   * Internally calls `start()` for the subscription save lifecycle, so
   * callers don't need a separate `start()` after `initialize()`. Use
   * `start()` directly only when you want subscription-save listening
   * without the OneSignal init shim (advanced cases — e.g., when the host
   * app already manages OneSignal init through its own framework).
   *
   * Failure modes:
   * - OneSignal namespace not resolvable → throws.
   * - All three init methods (`initialize`/`setAppId`/`_appID`) absent →
   *   logs a warning, proceeds with listener wiring on the assumption the
   *   plugin auto-initializes from build config. (Some Cordova builds do.)
   * - `notificationEvent` dep not provided → foreground/opened callbacks
   *   still fire but auto-reporting of `received` / `opened` is skipped.
   *
   * Idempotent on the OneSignal side — the plugin's own init guards
   * double-calls. The subscription-save listener is guarded by `state`
   * (a second `initialize()` is logged and ignored, matching `start()`).
   */
  initialize(opts: PushSubscriptionsInitializeOptions): void {
    if (this.state === 'started') {
      this.deps.logger?.warn?.(
        '[@lyntari/sdk push-subscriptions] initialize() ignored — already started',
      );
      return;
    }

    const oneSignal = opts.onesignal ?? resolveOneSignalFromGlobal();
    if (!oneSignal) {
      throw new Error(
        '[@lyntari/sdk push-subscriptions] OneSignal namespace not available — pass `opts.onesignal` or ensure window.OneSignal is loaded',
      );
    }

    // Initialize the OneSignal app id (probe for the available API in
    // descending version order).
    const os = oneSignal as unknown as Record<string, unknown>;
    if (typeof os.initialize === 'function') {
      (os.initialize as (id: string) => void)(opts.appId);
      this.deps.logger?.log?.('[@lyntari/sdk push-subscriptions] OneSignal.initialize(appId) called');
    } else if (typeof os.setAppId === 'function') {
      (os.setAppId as (id: string) => void)(opts.appId);
      this.deps.logger?.log?.('[@lyntari/sdk push-subscriptions] OneSignal.setAppId(appId) called');
    } else {
      os._appID = opts.appId;
      this.deps.logger?.warn?.(
        '[@lyntari/sdk push-subscriptions] OneSignal init API absent — set _appID directly',
      );
    }

    // Foreground notification handler. `Notifications.addEventListener` is
    // OneSignal v5; `setNotificationWillShowInForegroundHandler` is the
    // v4 fallback. Either path fires `onForegroundNotification` and
    // auto-reports `received` to notification-event.
    this.wireForegroundListener(oneSignal, opts.onForegroundNotification);

    // Opened handler — fires when the user taps the notification body.
    // Always exists on the OneSignal Cordova plugin surface (it's the
    // primary tap-routing hook). Auto-reports `opened` and dispatches
    // to the host's routing callback.
    this.wireOpenedHandler(oneSignal, opts.onNotificationOpened);

    // Subscription save lifecycle.
    this.start({ onesignal: oneSignal, getPlatform: opts.getPlatform });
  }

  private wireForegroundListener(
    oneSignal: OneSignalLike,
    onForegroundNotification?: (n: ForegroundNotificationPayload) => void,
  ): void {
    const os = oneSignal as unknown as Record<string, unknown>;
    const Notifications = os.Notifications as
      | undefined
      | {
          addEventListener?: (event: 'foregroundWillDisplay', listener: (event: unknown) => void) => void;
          removeEventListener?: (event: 'foregroundWillDisplay', listener: (event: unknown) => void) => void;
        };

    const reportReceived = (notification: ForegroundNotificationPayload) => {
      const id = (notification.additionalData as { notification_id?: unknown } | undefined)
        ?.notification_id;
      if (typeof id === 'string' && this.deps.notificationEvent) {
        void this.deps
          .notificationEvent({
            notification_id: id,
            event_type: 'received',
            timestamp_ms: Date.now(),
            meta: (notification.additionalData as Record<string, unknown>) ?? undefined,
          })
          .catch(() => {
            // Silent — engagement analytics shouldn't block UX.
          });
      }
    };

    if (Notifications && typeof Notifications.addEventListener === 'function') {
      this.foregroundOneSignal = oneSignal;
      this.foregroundListener = (event: unknown) => {
        const e = event as { notification?: ForegroundNotificationPayload; getNotification?: () => ForegroundNotificationPayload };
        const notification = e.notification ?? e.getNotification?.();
        if (notification) {
          onForegroundNotification?.(notification);
          reportReceived(notification);
        }
      };
      Notifications.addEventListener('foregroundWillDisplay', this.foregroundListener);
      this.deps.logger?.log?.('[@lyntari/sdk push-subscriptions] foreground listener registered (v5 API)');
      return;
    }

    // Legacy v4 API.
    if (typeof os.setNotificationWillShowInForegroundHandler === 'function') {
      (os.setNotificationWillShowInForegroundHandler as (cb: (event: unknown) => void) => void)(
        (event: unknown) => {
          const e = event as {
            notification?: ForegroundNotificationPayload;
            complete?: (n: ForegroundNotificationPayload) => void;
          };
          if (e.notification) {
            onForegroundNotification?.(e.notification);
            reportReceived(e.notification);
            e.complete?.(e.notification);
          }
        },
      );
      this.deps.logger?.log?.('[@lyntari/sdk push-subscriptions] foreground listener registered (v4 legacy API)');
      return;
    }

    this.deps.logger?.warn?.('[@lyntari/sdk push-subscriptions] no foreground notification API found');
  }

  private wireOpenedHandler(
    oneSignal: OneSignalLike,
    onNotificationOpened?: (payload: NotificationOpenedPayload) => void,
  ): void {
    const os = oneSignal as unknown as Record<string, unknown>;
    if (typeof os.setNotificationOpenedHandler !== 'function') {
      this.deps.logger?.warn?.('[@lyntari/sdk push-subscriptions] setNotificationOpenedHandler unavailable');
      return;
    }
    (os.setNotificationOpenedHandler as (cb: (jsonData: unknown) => void) => void)(
      (jsonData: unknown) => {
        const jd = jsonData as {
          notification?: { additionalData?: Record<string, unknown> };
          additionalData?: Record<string, unknown>;
        };
        const data = jd.notification?.additionalData ?? jd.additionalData ?? {};
        const notificationId = typeof data.notification_id === 'string' ? data.notification_id : undefined;

        // Auto-report `opened` to notification-event.
        if (notificationId && this.deps.notificationEvent) {
          void this.deps
            .notificationEvent({
              notification_id: notificationId,
              event_type: 'opened',
              timestamp_ms: Date.now(),
              meta: data,
            })
            .catch(() => {
              // Silent — engagement analytics shouldn't block routing.
            });
        }

        onNotificationOpened?.({ data, notificationId });
      },
    );
    this.deps.logger?.log?.('[@lyntari/sdk push-subscriptions] notification-opened handler registered');
  }

  /**
   * Wire OneSignal subscription saves to `client.notifications.saveSubscription`.
   * Idempotent — a second `start()` call is logged and ignored.
   */
  start(opts: PushSubscriptionsStartOptions): void {
    if (this.state === 'started') {
      this.deps.logger?.warn?.(
        '[@lyntari/sdk push-subscriptions] start() ignored — already started',
      );
      return;
    }
    this.state = 'started';
    this.oneSignalRef = opts.onesignal;
    this.getPlatform = opts.getPlatform;

    const pushSub = opts.onesignal.User.pushSubscription;

    this.changeListener = (event) => {
      const id = event.current?.id ?? null;
      const token = event.current?.token ?? null;
      this.handleSubscription(id, token);
    };
    pushSub.addEventListener('change', this.changeListener);

    // Snapshot any subscription that existed before the listener was attached.
    void this.snapshotCurrent(pushSub);

    this.authUnsubscribe = this.deps.onUserIdChange((userId) => {
      if (userId === null) {
        // Auth state cleared (voluntary logout, `deleteAccount`, explicit
        // `client.auth.clear()`, or terminal refresh failure — all four paths
        // fire `cleared` via lifecycle.clear()). Reset lastSavedSubscriptionId
        // so the SAME subscription_id can be saved under a different (or
        // re-authenticated) user — the OneSignal subscription is hardware-
        // level and survives the auth lifecycle. KEEP `pending` so the next
        // login flushes the device's current binding under the new user_id
        // without needing another OneSignal `change` event (which may never
        // fire on stable hardware).
        this.lastSavedSubscriptionId = null;
        return;
      }
      void this.flushPending();
    });
  }

  /**
   * Detach listeners and clear internal state. Safe to call before `start()`
   * or repeatedly. Cleans up both the subscription-change listener
   * (`start()`) and the foreground notification listener (`initialize()`).
   * The notification-opened handler is set via OneSignal's
   * `setNotificationOpenedHandler` which doesn't expose an unsubscribe
   * primitive across SDK versions — left in place; this is the OneSignal
   * Cordova plugin contract.
   */
  stop(): void {
    if (this.state === 'idle') return;
    this.state = 'idle';

    if (this.oneSignalRef && this.changeListener) {
      const pushSub = this.oneSignalRef.User.pushSubscription;
      pushSub.removeEventListener?.('change', this.changeListener);
    }
    if (this.foregroundOneSignal && this.foregroundListener) {
      const Notifications = (this.foregroundOneSignal as Record<string, unknown>).Notifications as
        | undefined
        | {
            removeEventListener?: (event: 'foregroundWillDisplay', listener: (event: unknown) => void) => void;
          };
      Notifications?.removeEventListener?.('foregroundWillDisplay', this.foregroundListener);
    }
    this.authUnsubscribe?.();

    this.oneSignalRef = null;
    this.getPlatform = null;
    this.changeListener = null;
    this.authUnsubscribe = null;
    this.foregroundListener = null;
    this.foregroundOneSignal = null;
    this.pending = null;
    this.lastSavedSubscriptionId = null;
  }

  // === Internal ===========================================================

  private async snapshotCurrent(pushSub: OneSignalPushSubscriptionLike): Promise<void> {
    let id: string | null = null;
    let token: string | null = null;
    try {
      if (typeof pushSub.getIdAsync === 'function') {
        id = (await pushSub.getIdAsync()) ?? null;
      } else if (pushSub.id != null) {
        id = pushSub.id;
      }
      if (typeof pushSub.getTokenAsync === 'function') {
        token = (await pushSub.getTokenAsync()) ?? null;
      } else if (pushSub.token != null) {
        token = pushSub.token;
      }
    } catch (err) {
      this.deps.logger?.warn?.(
        `[@lyntari/sdk push-subscriptions] snapshot failed: ${describeError(err)}`,
      );
      return;
    }
    if (id) {
      this.handleSubscription(id, token);
    }
  }

  private handleSubscription(id: string | null, token: string | null): void {
    if (!id) return;
    if (!this.getPlatform) return; // unreachable post-start
    const platform = this.getPlatform();
    this.pending = { subscription_id: id, push_token: token, platform };

    if (this.deps.getUserId() === null) {
      this.deps.logger?.log?.(
        '[@lyntari/sdk push-subscriptions] subscription captured, deferring save until login',
      );
      return;
    }
    void this.flushPending();
  }

  private async flushPending(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    if (pending.subscription_id === this.lastSavedSubscriptionId) return;
    if (this.deps.getUserId() === null) return;

    try {
      await this.deps.saveSubscription({
        subscription_id: pending.subscription_id,
        push_token: pending.push_token,
        platform: pending.platform,
      });
      this.lastSavedSubscriptionId = pending.subscription_id;
      this.deps.logger?.log?.('[@lyntari/sdk push-subscriptions] subscription saved');
    } catch (err) {
      // Leave lastSavedSubscriptionId unchanged so the next change event
      // (or a re-login) retries.
      this.deps.logger?.warn?.(
        `[@lyntari/sdk push-subscriptions] saveSubscription failed: ${describeError(err)}`,
      );
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Resolve the OneSignal namespace from browser globals. Returns `null` when
 * no global is present (Node/server environments).
 *
 * Walks the documented fallback chain for OneSignal Cordova/Capacitor
 * plugins:
 *
 *   `window.OneSignal` ?? `window.plugins.OneSignal`
 *   → `.default` ?? `.OneSignalPlugin` ?? itself
 *
 * The `.default` / `.OneSignalPlugin` unwraps cover the variations across
 * Cordova plugin packaging (some flavors expose the namespace under
 * `.default`, others under `.OneSignalPlugin`, others directly).
 */
function resolveOneSignalFromGlobal(): OneSignalLike | null {
  if (typeof globalThis === 'undefined') return null;
  const win = globalThis as { OneSignal?: unknown; plugins?: { OneSignal?: unknown } };
  const wrapper = win.OneSignal ?? win.plugins?.OneSignal;
  if (!wrapper) return null;
  const unwrapped =
    (wrapper as { default?: unknown }).default ??
    (wrapper as { OneSignalPlugin?: unknown }).OneSignalPlugin ??
    wrapper;
  return unwrapped as OneSignalLike;
}
