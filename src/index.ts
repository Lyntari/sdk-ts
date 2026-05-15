/**
 * `@lyntari/sdk` public entry point.
 *
 * Exports:
 *  - `createLyntariClient` — the v0.1 client factory; produces a typed
 *    facade over all 30 Edge Functions grouped by domain.
 *  - All transport primitives + typed errors (re-exported from
 *    `./transport/index.ts`) — for callers who want lower-level access.
 *  - All schemas + inferred types (re-exported from `./schemas/index.ts`) —
 *    for callers building integrations against the request/response shapes
 *    or generating OpenAPI from the registry.
 *  - The Auth lifecycle surface — `TokenStorage`, `InMemoryStorage`,
 *    `CapacitorPreferencesStorage`, `AuthEvent` / `AuthState` — for clients
 *    that opt into managed token persistence + auto-refresh.
 *
 * Two modes:
 *
 * **v0.1 caller-managed mode** (the original surface — used by partner
 * integrations, tests, Node consumers):
 *
 * ```ts
 * const client = createLyntariClient({
 *   baseUrl: 'https://<project>.supabase.co/functions/v1',
 *   apiKey: process.env.LYNTARI_API_KEY!,
 *   hmacSecret: process.env.LYNTARI_HMAC_KEY!,
 * });
 *
 * const { token } = await client.auth.login({ email, password });
 * client.setAccessToken(token);
 * ```
 *
 * **Managed-lifecycle mode** (for clients that want persistence +
 * auto-refresh + revoked-vs-transient classification):
 *
 * ```ts
 * import { Preferences } from '@capacitor/preferences';
 *
 * const client = createLyntariClient({
 *   baseUrl, apiKey, hmacSecret,
 *   auth: {
 *     storage: new CapacitorPreferencesStorage(Preferences),
 *     onEvent: (e) => { if (e.type === 'authExpired') showLoginScreen(); },
 *   },
 * });
 *
 * await client.auth.init();   // restore from storage (cold start)
 * await client.auth.login({ email, password });  // auto-persists, schedules refresh
 * ```
 */

import { AuthLifecycle } from './auth/lifecycle.js';
import type {
  AuthEventListener,
  AuthState,
} from './auth/types.js';
import { createAuthMethods, type AuthMethods } from './methods/auth.js';
import { createLocationMethods, type LocationMethods } from './methods/location.js';
import {
  createNotificationsMethods,
  type NotificationsMethods,
} from './methods/notifications.js';
import { createReadsMethods, type ReadsMethods } from './methods/reads.js';
import { createVisitsMethods, type VisitsMethods } from './methods/visits.js';
import type { ClientConfig, ClientState } from './methods/_shared.js';
import { PushSubscriptions } from './push-subscriptions/module.js';
import type {
  PushSubscriptionsInitializeOptions,
  PushSubscriptionsStartOptions,
} from './push-subscriptions/types.js';
import type { TokenStorage } from './storage/types.js';
import type { AuthRefreshResponse } from './schemas/index.js';

/** Configuration for the managed-lifecycle mode. */
export interface AuthLifecycleConfig {
  /** Persistence layer for the five Capacitor Preferences keys. */
  storage: TokenStorage;
  /** Optional event handler attached at construction. Additional listeners can attach via `client.auth.onEvent`. */
  onEvent?: AuthEventListener;
}

/** Full configuration accepted by `createLyntariClient`. */
export interface CreateClientConfig extends ClientConfig {
  /** Opt into managed token persistence + auto-refresh. Omit for v0.1 caller-managed mode. */
  auth?: AuthLifecycleConfig;
}

/** Lifecycle surface mounted on `client.auth` when constructed with `auth: { ... }`. */
export interface AuthLifecycleSurface {
  /** Current auth state — `null` until `init()` restores or login succeeds. */
  readonly state: AuthState | null;
  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  onEvent(listener: AuthEventListener): () => void;
  /** Restore stored auth from `TokenStorage`. Idempotent; call once at app start. */
  init(): Promise<{ restored: boolean }>;
  /** Force a refresh on demand using the in-memory refresh token. Throws on revoked/transient (see `AuthEvent` for the matching event). The wrapped `refresh(input)` raw-method wrapper is still available for callers that have the refresh token in hand. */
  forceRefresh(): Promise<AuthRefreshResponse>;
  /** Clear local + stored auth state without calling `auth-logout`. */
  clear(): Promise<void>;
}

/**
 * Composite `client.auth` namespace. The base `AuthMethods` are always
 * present; lifecycle members (`state`, `onEvent`, `init`, `refresh`, `clear`)
 * are present only when `createLyntariClient` is called with `auth: { ... }`.
 * Use `'init' in client.auth` to narrow at runtime when needed.
 */
export type ClientAuthNamespace = AuthMethods & Partial<AuthLifecycleSurface>;

/**
 * `client.pushSubscriptions` surface. Mounted only when the Auth lifecycle
 * is wired (`auth: { ... }`) — the module needs `client.auth.state.user_id`
 * visibility to defer pre-login saves and flush on login. In caller-managed
 * mode, `start` / `stop` are `undefined`.
 *
 * See `src/push-subscriptions/module.ts` for the orchestration the module
 * encapsulates (snapshot-current, listen-on-change, dedupe-by-id,
 * buffer-pre-login, flush-on-login).
 */
export interface PushSubscriptionsSurface {
  /**
   * End-to-end OneSignal setup: namespace resolution + plugin init + event
   * listeners + subscription save lifecycle in one call. Resolves
   * `window.OneSignal` (or `window.plugins.OneSignal`) when `opts.onesignal`
   * is omitted. Internally calls `start()` for the subscription-save lifecycle.
   * Use this on hosted clients (mobile apps); use `start()` directly only
   * when the host already manages OneSignal init.
   */
  initialize(opts: PushSubscriptionsInitializeOptions): void;
  /**
   * Wire OneSignal subscription saves to `client.notifications.saveSubscription`.
   * Idempotent — a second `start()` call is logged and ignored.
   */
  start(opts: PushSubscriptionsStartOptions): void;
  /** Detach listeners and clear internal state. */
  stop(): void;
}

export interface LyntariClient {
  /** Auth-flow methods: login, signup, refresh, logout, resetPassword, deleteAccount. Lifecycle members (`state`, `onEvent`, `init`, `refresh`, `clear`) present only when constructed with `auth: { ... }`. */
  readonly auth: ClientAuthNamespace;
  /** Visit-flow methods: recordSignal, posClose, posCurrentVisits, congestionHistory. */
  readonly visits: VisitsMethods;
  /** Location-flow methods: nearbyVenues, update, beaconDetection, beaconConfig. */
  readonly location: LocationMethods;
  /** Notification-flow methods: 8 methods covering subscriptions, preferences, trigger, event. */
  readonly notifications: NotificationsMethods;
  /** Read-flow methods: 8 methods covering stadium reads, profile, history, categories. */
  readonly reads: ReadsMethods;
  /** OneSignal subscription save orchestration. `start` / `stop` are `undefined` in caller-managed mode (no auth lifecycle). */
  readonly pushSubscriptions: Partial<PushSubscriptionsSurface>;

  /**
   * Set (or clear) the access token used by JWT-required methods. Pass the
   * `token` field returned by `auth.login`, `auth.signup`, or `auth.refresh`.
   * Pass `null` to clear (e.g., on logout).
   *
   * In managed-lifecycle mode the lifecycle writes the token automatically;
   * direct calls to `setAccessToken` still work but are unnecessary.
   */
  setAccessToken(token: string | null): void;

  /**
   * Read the currently-set access token. Returns `null` before login or
   * after logout. Provided primarily for tests + diagnostic logging;
   * callers normally don't need to inspect this.
   */
  getAccessToken(): string | null;
}

export function createLyntariClient(config: CreateClientConfig): LyntariClient {
  const frozenConfig: ClientConfig = Object.freeze({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    hmacSecret: config.hmacSecret,
  });

  const state: ClientState = { accessToken: null, onExpiredJwt: null };

  const rawAuth = createAuthMethods(frozenConfig, state);
  const notifications = createNotificationsMethods(frozenConfig, state);

  let authNamespace: ClientAuthNamespace = rawAuth;
  let pushSubscriptionsSurface: Partial<PushSubscriptionsSurface> = {};

  if (config.auth) {
    const lifecycle = new AuthLifecycle({
      storage: config.auth.storage,
      state,
      rawAuth,
      onEvent: config.auth.onEvent,
    });

    // Wire the transport's expired_jwt hook to the lifecycle so JWT-required
    // methods auto-refresh on 401 expired_jwt.
    state.onExpiredJwt = () => lifecycle.autoRefresh();

    const wrappedAuth = lifecycle.wrapMethods();
    Object.defineProperty(wrappedAuth, 'state', {
      get: () => lifecycle.authState,
      enumerable: true,
      configurable: false,
    });
    authNamespace = Object.assign(wrappedAuth, {
      onEvent: (listener: AuthEventListener) => lifecycle.onEvent(listener),
      init: () => lifecycle.init(),
      forceRefresh: () => lifecycle.refresh(),
      clear: () => lifecycle.clear(),
    });

    // Mount PushSubscriptions: depends on the lifecycle for user_id awareness.
    // `tokenRefreshed` carries the new user_id; `cleared` signals auth state
    // dropped to null (voluntary logout / deleteAccount / explicit clear() /
    // terminal refresh failure — `clear()` emits `cleared` in all four paths).
    // `authError` is transient and doesn't touch user_id. `authExpired`
    // carries the server-side terminal-failure reason for UX consumers; the
    // matching state-transition signal is `cleared` (which is what
    // PushSubscriptions needs), and `cleared` always fires immediately
    // before `authExpired` in that path, so we don't subscribe to
    // `authExpired` here — avoids a redundant double-null.
    const pushSubscriptions = new PushSubscriptions({
      saveSubscription: notifications.saveSubscription,
      notificationEvent: notifications.notificationEvent,
      getUserId: () => lifecycle.authState?.user_id ?? null,
      onUserIdChange: (listener) =>
        lifecycle.onEvent((event) => {
          if (event.type === 'tokenRefreshed') listener(event.state.user_id);
          else if (event.type === 'cleared') listener(null);
        }),
    });
    pushSubscriptionsSurface = {
      initialize: (opts) => pushSubscriptions.initialize(opts),
      start: (opts) => pushSubscriptions.start(opts),
      stop: () => pushSubscriptions.stop(),
    };
  }

  return {
    auth: authNamespace,
    visits: createVisitsMethods(frozenConfig, state),
    location: createLocationMethods(frozenConfig, state),
    notifications,
    reads: createReadsMethods(frozenConfig, state),
    pushSubscriptions: pushSubscriptionsSurface,
    setAccessToken: (token) => {
      state.accessToken = token;
    },
    getAccessToken: () => state.accessToken,
  };
}

// === Re-exports ===========================================================

export * from './transport/index.js';
export * from './schemas/index.js';
export type { ClientConfig, ClientState, ExpiredJwtHook } from './methods/_shared.js';
export type { AuthMethods } from './methods/auth.js';
export type { VisitsMethods } from './methods/visits.js';
export type { LocationMethods } from './methods/location.js';
export type { NotificationsMethods } from './methods/notifications.js';
export type { ReadsMethods } from './methods/reads.js';

// Auth lifecycle + storage surface
export type { TokenStorage } from './storage/types.js';
export { InMemoryStorage } from './storage/memory.js';
export {
  CapacitorPreferencesStorage,
  type CapacitorPreferencesLike,
} from './storage/capacitor.js';
export { AuthLifecycle } from './auth/lifecycle.js';
export type {
  AuthEvent,
  AuthEventListener,
  AuthState,
  RefreshOutcome,
} from './auth/types.js';

// PushSubscriptions module surface
export { PushSubscriptions } from './push-subscriptions/module.js';
export type { PushSubscriptionsDeps } from './push-subscriptions/module.js';
export type {
  ForegroundNotificationPayload,
  NotificationOpenedPayload,
  OneSignalLike,
  OneSignalPushSubscriptionLike,
  OneSignalSubscriptionChangeEvent,
  PushPlatform,
  PushSubscriptionsInitializeOptions,
  PushSubscriptionsLogger,
  PushSubscriptionsStartOptions,
} from './push-subscriptions/types.js';

// iBeacon parsing helpers (BLE scan-result decoder + stale-entry eviction)
export { parseIBeaconData, cleanupStaleBeacons } from './ibeacon/index.js';
export type { IBeaconParsed, IBeaconScanResult } from './ibeacon/index.js';

// Location tracker — polling-loop module exposed via client.location.createTracker
export type {
  LocationTracker,
  LocationTrackerCoordinates,
  LocationTrackerOptions,
  LocationTrackerState,
} from './methods/location-tracker.js';
