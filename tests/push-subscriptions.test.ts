/**
 * PushSubscriptions module tests.
 *
 * Exercises the orchestration the cutover relies on:
 *
 *  - Subscription captured while logged in → immediate save.
 *  - Subscription captured pre-login → buffered → flushed on user_id arrival.
 *  - Dedupe by subscription_id (no re-save of same id).
 *  - Rotation: new id saves even under the same user.
 *  - Pre-existing subscription on start: snapshot via getIdAsync.
 *  - Logout clears buffer (no save under wrong user on next login).
 *  - saveSubscription failure: no lastSaved update; next event retries.
 *  - stop(): listener detached, no further saves.
 *  - start() called twice: no-op (warn).
 *
 * Uses a hand-rolled OneSignal mock (vi.fn for saveSubscription) — no
 * actual Capacitor / OneSignal SDK is loaded.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';
import {
  PushSubscriptions,
  type OneSignalLike,
  type OneSignalPushSubscriptionLike,
  type OneSignalSubscriptionChangeEvent,
  type PushSubscriptionsDeps,
} from '../src/push-subscriptions/module.js';
import { createLyntariClient, InMemoryStorage, type LyntariClient } from '../src/index.js';

type ChangeListener = (event: OneSignalSubscriptionChangeEvent) => void;

interface OneSignalMock {
  oneSignal: OneSignalLike;
  /** Fire a `change` event with the given id/token; also updates the current snapshot. */
  fireChange(id: string | null, token: string | null): void;
  /** Set current snapshot without firing a change event (e.g., pre-existing subscription on start). */
  setCurrent(id: string | null, token: string | null): void;
  /** Number of times the listener was removed. */
  removeCalls: number;
  /** Currently-attached listeners (for assertions). */
  changeListeners: ChangeListener[];
}

function mockOneSignal(initialId: string | null = null, initialToken: string | null = null): OneSignalMock {
  let currentId = initialId;
  let currentToken = initialToken;
  const changeListeners: ChangeListener[] = [];
  let removeCalls = 0;
  const pushSub: OneSignalPushSubscriptionLike = {
    get id() {
      return currentId;
    },
    get token() {
      return currentToken;
    },
    getIdAsync: async () => currentId,
    getTokenAsync: async () => currentToken,
    addEventListener: (event, listener) => {
      if (event === 'change') changeListeners.push(listener);
    },
    removeEventListener: (event, listener) => {
      if (event !== 'change') return;
      const idx = changeListeners.indexOf(listener);
      if (idx >= 0) changeListeners.splice(idx, 1);
      removeCalls++;
    },
  };
  const oneSignal: OneSignalLike = { User: { pushSubscription: pushSub } };
  return {
    oneSignal,
    fireChange: (id, token) => {
      currentId = id;
      currentToken = token;
      for (const l of [...changeListeners]) l({ current: { id, token } });
    },
    setCurrent: (id, token) => {
      currentId = id;
      currentToken = token;
    },
    get removeCalls() {
      return removeCalls;
    },
    changeListeners,
  };
}

interface Harness {
  module: PushSubscriptions;
  saveSubscription: ReturnType<typeof vi.fn>;
  setUserId(uid: string | null): void;
  os: OneSignalMock;
  /** Allows tests to wait for the snapshotCurrent microtask cascade. */
  flush(): Promise<void>;
}

function setup(opts: { initialUserId?: string | null; initialSubId?: string | null; initialToken?: string | null } = {}): Harness {
  const saveSubscription = vi.fn().mockResolvedValue({ ok: true });
  let currentUserId: string | null = opts.initialUserId ?? null;
  const userIdListeners: Array<(uid: string | null) => void> = [];

  const deps: PushSubscriptionsDeps = {
    saveSubscription,
    getUserId: () => currentUserId,
    onUserIdChange: (listener) => {
      userIdListeners.push(listener);
      return () => {
        const idx = userIdListeners.indexOf(listener);
        if (idx >= 0) userIdListeners.splice(idx, 1);
      };
    },
  };

  const module = new PushSubscriptions(deps);
  const os = mockOneSignal(opts.initialSubId ?? null, opts.initialToken ?? null);

  return {
    module,
    saveSubscription,
    os,
    setUserId(uid) {
      currentUserId = uid;
      for (const l of [...userIdListeners]) l(uid);
    },
    async flush() {
      // Let any pending microtasks settle (snapshotCurrent, flushPending).
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('PushSubscriptions — change events', () => {
  let h: Harness;

  beforeEach(() => {
    h = setup({ initialUserId: 'u-1' });
    h.module.start({ onesignal: h.os.oneSignal, getPlatform: () => 'ios' });
  });

  it('saves immediately when subscription arrives and user_id is set', async () => {
    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();

    expect(h.saveSubscription).toHaveBeenCalledTimes(1);
    expect(h.saveSubscription).toHaveBeenCalledWith({
      subscription_id: 'sub-A',
      push_token: 'tok-A',
      platform: 'ios',
    });
  });

  it('dedupes repeat events with the same subscription_id', async () => {
    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();
    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();
    h.os.fireChange('sub-A', null); // token wobble — still same id
    await h.flush();

    expect(h.saveSubscription).toHaveBeenCalledTimes(1);
  });

  it('saves a rotated subscription_id under the same user', async () => {
    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();
    h.os.fireChange('sub-B', 'tok-B');
    await h.flush();

    expect(h.saveSubscription).toHaveBeenCalledTimes(2);
    expect(h.saveSubscription).toHaveBeenNthCalledWith(1, {
      subscription_id: 'sub-A',
      push_token: 'tok-A',
      platform: 'ios',
    });
    expect(h.saveSubscription).toHaveBeenNthCalledWith(2, {
      subscription_id: 'sub-B',
      push_token: 'tok-B',
      platform: 'ios',
    });
  });

  it('ignores change events with no subscription_id', async () => {
    h.os.fireChange(null, null);
    await h.flush();
    expect(h.saveSubscription).not.toHaveBeenCalled();
  });
});

describe('PushSubscriptions — pre-login buffer', () => {
  it('buffers when user_id is null and flushes on login', async () => {
    const h = setup({ initialUserId: null });
    h.module.start({ onesignal: h.os.oneSignal, getPlatform: () => 'android' });

    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();
    expect(h.saveSubscription).not.toHaveBeenCalled();

    // Login arrives.
    h.setUserId('u-1');
    await h.flush();

    expect(h.saveSubscription).toHaveBeenCalledTimes(1);
    expect(h.saveSubscription).toHaveBeenCalledWith({
      subscription_id: 'sub-A',
      push_token: 'tok-A',
      platform: 'android',
    });
  });

  it('only the latest pre-login subscription is saved on login', async () => {
    const h = setup({ initialUserId: null });
    h.module.start({ onesignal: h.os.oneSignal, getPlatform: () => 'ios' });

    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();
    h.os.fireChange('sub-B', 'tok-B');
    await h.flush();

    h.setUserId('u-1');
    await h.flush();

    expect(h.saveSubscription).toHaveBeenCalledTimes(1);
    expect(h.saveSubscription).toHaveBeenCalledWith({
      subscription_id: 'sub-B',
      push_token: 'tok-B',
      platform: 'ios',
    });
  });

  it('userId=null clears lastSavedSubscriptionId but preserves pending — re-login under a different user_id saves automatically', async () => {
    // Models the production cross-account flow: user A logged in with a
    // subscription saved → user A logs out → user B logs in on the same
    // device. The OneSignal subscription is hardware-level and survives the
    // auth lifecycle; the module should re-bind it under user B without
    // requiring a fresh `change` event (which OneSignal may never fire on
    // stable hardware).
    const h = setup({ initialUserId: 'u-1' });
    h.module.start({ onesignal: h.os.oneSignal, getPlatform: () => 'ios' });

    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();
    expect(h.saveSubscription).toHaveBeenCalledTimes(1);

    // Logout → bridge fires listener(null). lastSavedSubscriptionId is
    // cleared; pending is preserved.
    h.setUserId(null);
    await h.flush();

    // Re-login as a different user → bridge fires listener('u-2'). The
    // module flushes pending under u-2 — same subscription_id, new user_id.
    h.setUserId('u-2');
    await h.flush();

    expect(h.saveSubscription).toHaveBeenCalledTimes(2);
    expect(h.saveSubscription).toHaveBeenNthCalledWith(2, {
      subscription_id: 'sub-A',
      push_token: 'tok-A',
      platform: 'ios',
    });
  });

});

describe('PushSubscriptions — snapshot on start', () => {
  it('saves a pre-existing subscription when started while logged in', async () => {
    const h = setup({
      initialUserId: 'u-1',
      initialSubId: 'sub-existing',
      initialToken: 'tok-existing',
    });
    h.module.start({ onesignal: h.os.oneSignal, getPlatform: () => 'web' });
    await h.flush();

    expect(h.saveSubscription).toHaveBeenCalledTimes(1);
    expect(h.saveSubscription).toHaveBeenCalledWith({
      subscription_id: 'sub-existing',
      push_token: 'tok-existing',
      platform: 'web',
    });
  });

  it('buffers a pre-existing subscription when started pre-login, flushes on login', async () => {
    const h = setup({
      initialUserId: null,
      initialSubId: 'sub-existing',
      initialToken: null,
    });
    h.module.start({ onesignal: h.os.oneSignal, getPlatform: () => 'ios' });
    await h.flush();
    expect(h.saveSubscription).not.toHaveBeenCalled();

    h.setUserId('u-1');
    await h.flush();
    expect(h.saveSubscription).toHaveBeenCalledTimes(1);
    expect(h.saveSubscription).toHaveBeenCalledWith({
      subscription_id: 'sub-existing',
      push_token: null,
      platform: 'ios',
    });
  });

  it('falls back to sync id when getIdAsync is absent', async () => {
    const h = setup({ initialUserId: 'u-1' });
    // Replace pushSubscription with one lacking async getters.
    const sub: OneSignalPushSubscriptionLike = {
      id: 'sub-sync',
      token: 'tok-sync',
      addEventListener: () => {
        /* no-op */
      },
    };
    const os: OneSignalLike = { User: { pushSubscription: sub } };
    h.module.start({ onesignal: os, getPlatform: () => 'android' });
    await h.flush();

    expect(h.saveSubscription).toHaveBeenCalledWith({
      subscription_id: 'sub-sync',
      push_token: 'tok-sync',
      platform: 'android',
    });
  });

  it('snapshot does nothing when there is no existing subscription', async () => {
    const h = setup({ initialUserId: 'u-1' });
    h.module.start({ onesignal: h.os.oneSignal, getPlatform: () => 'ios' });
    await h.flush();
    expect(h.saveSubscription).not.toHaveBeenCalled();
  });
});

describe('PushSubscriptions — saveSubscription failures', () => {
  it('does not crash on saveSubscription rejection; retries on next change event', async () => {
    const h = setup({ initialUserId: 'u-1' });
    h.saveSubscription.mockRejectedValueOnce(new Error('network down'));
    h.module.start({ onesignal: h.os.oneSignal, getPlatform: () => 'ios' });

    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();
    expect(h.saveSubscription).toHaveBeenCalledTimes(1);

    // Second event with same id retries (because lastSaved wasn't updated).
    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();
    expect(h.saveSubscription).toHaveBeenCalledTimes(2);
  });
});

describe('PushSubscriptions — lifecycle controls', () => {
  it('stop() removes the listener and ignores subsequent change events', async () => {
    const h = setup({ initialUserId: 'u-1' });
    h.module.start({ onesignal: h.os.oneSignal, getPlatform: () => 'ios' });

    expect(h.os.changeListeners.length).toBe(1);

    h.module.stop();
    expect(h.os.changeListeners.length).toBe(0);
    expect(h.os.removeCalls).toBe(1);

    h.os.fireChange('sub-A', 'tok-A');
    await h.flush();
    expect(h.saveSubscription).not.toHaveBeenCalled();
  });

  it('start() called twice warns and is a no-op', () => {
    const warn = vi.fn();
    const h = setup({ initialUserId: 'u-1' });
    // Inject a logger via a new deps wrapper.
    const moduleWithLogger = new PushSubscriptions({
      saveSubscription: h.saveSubscription,
      getUserId: () => 'u-1',
      onUserIdChange: () => () => {
        /* no-op */
      },
      logger: { warn },
    });
    moduleWithLogger.start({ onesignal: h.os.oneSignal, getPlatform: () => 'ios' });
    moduleWithLogger.start({ onesignal: h.os.oneSignal, getPlatform: () => 'ios' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h.os.changeListeners.length).toBe(1); // listener attached once
  });

  it('stop() before start() is a no-op', () => {
    const h = setup({ initialUserId: 'u-1' });
    expect(() => h.module.stop()).not.toThrow();
    expect(h.os.removeCalls).toBe(0);
  });
});

/**
 * End-to-end via the createLyntariClient bridge.
 *
 * The describe blocks above test the `PushSubscriptions` module in isolation
 * by injecting `getUserId` / `onUserIdChange` callbacks directly. They prove
 * "given a userId-changed-to-null event, the module clears its state and
 * re-saves on the next login." What they CANNOT prove on their own is that
 * the real lifecycle → bridge → module wiring delivers that null event on
 * the production logout / deleteAccount / explicit-clear paths.
 *
 * Pre-fix, the bridge listened only for `authExpired`, which doesn't fire on
 * voluntary logout. The module-isolation tests passed because the harness
 * fabricated a userId-null transition that production didn't actually
 * produce — the mock matched the desired behavior, not actual production.
 *
 * The tests in this block use the real `createLyntariClient` factory with
 * `InMemoryStorage` and mocked `fetch` to verify the full chain end-to-end.
 */
describe('PushSubscriptions — end-to-end via createLyntariClient bridge', () => {
  let fetchMock: MockedFunction<typeof fetch>;
  let storage: InMemoryStorage;
  let client: LyntariClient;
  let os: OneSignalMock;

  const isoFromNowMin = (min: number): string =>
    new Date(Date.now() + min * 60 * 1000).toISOString();

  const mockResponse = (init: { ok: boolean; status: number; body: unknown }): Response =>
    ({ ok: init.ok, status: init.status, json: async () => init.body } as unknown as Response);

  const loginResponse = (userId: string, refreshSuffix: string) =>
    mockResponse({
      ok: true,
      status: 200,
      body: {
        token: `jwt-${userId}`,
        refresh_token: `r-${refreshSuffix}`,
        user_id: userId,
        expires_at: isoFromNowMin(30),
      },
    });

  const saveSubscriptionResponse = () =>
    mockResponse({ ok: true, status: 200, body: { ok: true } });

  const logoutResponse = () =>
    mockResponse({ ok: true, status: 200, body: { revoked: true } });

  const saveSubscriptionCallCount = (): number =>
    fetchMock.mock.calls.filter(([url]) => url.toString().includes('save-subscription')).length;

  /**
   * Poll until `predicate()` returns true or `timeoutMs` elapses. The async
   * chain that fires `save-subscription` runs through a `void this.flushPending()`
   * kicked off from the lifecycle's `emit()` listener fanout — its
   * completion depends on Web Crypto's HMAC compute (microtask-scheduled),
   * `await fetch()` (mocked but still microtask-scheduled), and
   * `response.json()`. Fixed `setTimeout(0)` ticks are inherently brittle
   * across schedulers (Node 22 / Node 20 / threads pool vs forks pool
   * differ in microtask scheduling), so we poll the assertion condition
   * directly and time out with diagnostics if the chain stalls.
   */
  const waitUntil = async (
    predicate: () => boolean,
    timeoutMs = 3000,
  ): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        const urls = fetchMock.mock.calls.map(([u]) => u.toString()).join(', ');
        throw new Error(
          `waitUntil timed out after ${timeoutMs}ms. fetch URLs so far: [${urls}]`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const waitForSaveCount = (target: number): Promise<void> =>
    waitUntil(() => saveSubscriptionCallCount() >= target);

  beforeEach(() => {
    fetchMock = vi.fn() as MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    storage = new InMemoryStorage();
    client = createLyntariClient({
      baseUrl: 'https://example.test/functions/v1',
      apiKey: 'pk-test',
      hmacSecret: 'sk-test',
      auth: { storage },
    });
    os = mockOneSignal();
    client.pushSubscriptions.start!({
      onesignal: os.oneSignal,
      getPlatform: () => 'ios',
    });
  });

  afterEach(() => {
    // Detach push-subscriptions listeners + lifecycle subscriptions so
    // prior-test instances don't keep references that could race with the
    // next test's mocked fetch / OneSignal mock.
    client.pushSubscriptions.stop?.();
  });

  it('voluntary logout via client.auth.logout enables save-subscription under a new user', async () => {
    // === User A logs in, subscription fires, save-A captured ===
    fetchMock.mockResolvedValueOnce(loginResponse('u-A', 'A'));
    await client.auth.login({ email: 'a@b.c', password: 'pw' });

    fetchMock.mockResolvedValueOnce(saveSubscriptionResponse());
    os.fireChange('sub-X', 'tok-X');
    await waitForSaveCount(1);

    // === User A logs out voluntarily ===
    fetchMock.mockResolvedValueOnce(logoutResponse());
    await client.auth.logout({ refresh_token: 'r-A' });

    // === User B logs in on the same device ===
    // The lifecycle's `tokenRefreshed` fires the bridge's listener with u-B.
    // PushSubscriptions' flushPending sees the prior pending (sub-X) and an
    // empty lastSavedSubscriptionId (cleared by the bridge's `cleared`
    // notification fired during logout). save-X fires under user B.
    fetchMock.mockResolvedValueOnce(loginResponse('u-B', 'B'));
    fetchMock.mockResolvedValueOnce(saveSubscriptionResponse());
    await client.auth.login({ email: 'b@c.d', password: 'pw' });
    await waitForSaveCount(2);

    // Sanity: pin the final count + URL signature.
    expect(saveSubscriptionCallCount()).toBe(2);
    const allUrls = fetchMock.mock.calls.map(([u]) => u.toString());
    expect(allUrls).toEqual([
      'https://example.test/functions/v1/consumer-login',
      'https://example.test/functions/v1/save-subscription',
      'https://example.test/functions/v1/auth-logout',
      'https://example.test/functions/v1/consumer-login',
      'https://example.test/functions/v1/save-subscription',
    ]);
  });

  // `client.auth.clear()` and `client.auth.deleteAccount()` exercise the
  // same `lifecycle.clear()` path that `client.auth.logout()` uses; the
  // shared `cleared` event emission is verified in `auth-lifecycle.test.ts`
  // ("clear() emits cleared", "logout (with successful EF call) emits
  // cleared", etc.). The voluntary-logout case above proves the bridge
  // wiring delivers that event to PushSubscriptions correctly — no need to
  // duplicate the bridge-integration test for the other two entry points.
});

describe('PushSubscriptions — initialize() (end-to-end OneSignal setup)', () => {
  // Build a richer OneSignal mock that includes the `initialize`/`setAppId`
  // shim, the `setNotificationOpenedHandler`, and the v5 / v4 foreground
  // notification listener surfaces. Distinct from `mockOneSignal()` above —
  // those tests only need the `User.pushSubscription` change-listener shape.
  interface InitMockOpts {
    /** Which init API to expose: 'v5' (initialize), 'v4' (setAppId), 'legacy' (_appID only). */
    initApi?: 'v5' | 'v4' | 'legacy';
    /** Which foreground API to expose: 'v5' (Notifications.addEventListener), 'v4' (setNotificationWillShowInForegroundHandler), 'none'. */
    foregroundApi?: 'v5' | 'v4' | 'none';
  }
  function makeInitMock(opts: InitMockOpts = {}) {
    const initApi = opts.initApi ?? 'v5';
    const foregroundApi = opts.foregroundApi ?? 'v5';
    const calls: Record<string, unknown[]> = { init: [], setAppId: [], appIdProp: [], openedHandlers: [], foregroundListeners: [] };
    const mock: any = {
      User: {
        pushSubscription: {
          id: null,
          token: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      },
      setNotificationOpenedHandler: (cb: (jsonData: unknown) => void) => {
        calls.openedHandlers.push(cb);
      },
    };
    if (initApi === 'v5') {
      mock.initialize = (id: string) => calls.init.push(id);
    } else if (initApi === 'v4') {
      mock.setAppId = (id: string) => calls.setAppId.push(id);
    }
    // 'legacy': neither method, so initialize() will fall through to _appID.

    if (foregroundApi === 'v5') {
      mock.Notifications = {
        addEventListener: (event: string, listener: (event: unknown) => void) => {
          if (event === 'foregroundWillDisplay') calls.foregroundListeners.push(listener);
        },
        removeEventListener: vi.fn(),
      };
    } else if (foregroundApi === 'v4') {
      mock.setNotificationWillShowInForegroundHandler = (cb: (event: unknown) => void) => {
        calls.foregroundListeners.push(cb);
      };
    }
    return { mock, calls };
  }

  function setupForInit() {
    const saveSubscription = vi.fn().mockResolvedValue({ ok: true });
    const notificationEvent = vi.fn().mockResolvedValue({ ok: true });
    let currentUserId: string | null = 'u-1';
    const userIdListeners: Array<(uid: string | null) => void> = [];
    const deps: PushSubscriptionsDeps = {
      saveSubscription,
      notificationEvent,
      getUserId: () => currentUserId,
      onUserIdChange: (l) => {
        userIdListeners.push(l);
        return () => {
          const i = userIdListeners.indexOf(l);
          if (i >= 0) userIdListeners.splice(i, 1);
        };
      },
    };
    return { module: new PushSubscriptions(deps), saveSubscription, notificationEvent };
  }

  it('calls OneSignal.initialize(appId) when the v5 API is available', () => {
    const { mock, calls } = makeInitMock({ initApi: 'v5' });
    const { module } = setupForInit();
    module.initialize({ appId: 'app-123', getPlatform: () => 'ios', onesignal: mock });
    expect(calls.init).toEqual(['app-123']);
    expect(calls.setAppId).toEqual([]);
  });

  it('falls back to setAppId when initialize is absent', () => {
    const { mock, calls } = makeInitMock({ initApi: 'v4' });
    const { module } = setupForInit();
    module.initialize({ appId: 'app-456', getPlatform: () => 'android', onesignal: mock });
    expect(calls.setAppId).toEqual(['app-456']);
    expect(calls.init).toEqual([]);
  });

  it('falls back to setting _appID directly when both init methods are absent', () => {
    const { mock } = makeInitMock({ initApi: 'legacy' });
    const { module } = setupForInit();
    module.initialize({ appId: 'app-789', getPlatform: () => 'web', onesignal: mock });
    expect(mock._appID).toBe('app-789');
  });

  it('throws when OneSignal namespace cannot be resolved', () => {
    const { module } = setupForInit();
    expect(() =>
      module.initialize({ appId: 'x', getPlatform: () => 'ios' /* no onesignal */ }),
    ).toThrow(/OneSignal namespace not available/);
  });

  it('wires setNotificationOpenedHandler and fires onNotificationOpened + auto-reports opened', async () => {
    const { mock, calls } = makeInitMock();
    const { module, notificationEvent } = setupForInit();
    const onOpened = vi.fn();
    module.initialize({
      appId: 'a',
      getPlatform: () => 'ios',
      onesignal: mock,
      onNotificationOpened: onOpened,
    });
    expect(calls.openedHandlers.length).toBe(1);
    const handler = calls.openedHandlers[0] as (jsonData: unknown) => void;
    handler({
      notification: { additionalData: { venue_id: 'v-1', notification_id: 'n-7', trigger_type: 'beacon' } },
    });
    expect(onOpened).toHaveBeenCalledWith({
      data: { venue_id: 'v-1', notification_id: 'n-7', trigger_type: 'beacon' },
      notificationId: 'n-7',
    });
    // Auto-report
    await Promise.resolve();
    expect(notificationEvent).toHaveBeenCalledTimes(1);
    expect(notificationEvent.mock.calls[0]![0]).toMatchObject({
      notification_id: 'n-7',
      event_type: 'opened',
    });
  });

  it('wires foreground listener via v5 Notifications.addEventListener', async () => {
    const { mock, calls } = makeInitMock({ foregroundApi: 'v5' });
    const { module, notificationEvent } = setupForInit();
    const onFg = vi.fn();
    module.initialize({
      appId: 'a',
      getPlatform: () => 'ios',
      onesignal: mock,
      onForegroundNotification: onFg,
    });
    expect(calls.foregroundListeners.length).toBe(1);
    const listener = calls.foregroundListeners[0] as (event: unknown) => void;
    listener({
      notification: { title: 'Hello', body: 'World', additionalData: { notification_id: 'n-fg-1' } },
    });
    expect(onFg).toHaveBeenCalledWith({
      title: 'Hello',
      body: 'World',
      additionalData: { notification_id: 'n-fg-1' },
    });
    await Promise.resolve();
    expect(notificationEvent).toHaveBeenCalledWith({
      notification_id: 'n-fg-1',
      event_type: 'received',
      timestamp_ms: expect.any(Number),
      meta: { notification_id: 'n-fg-1' },
    });
  });

  it('falls back to v4 setNotificationWillShowInForegroundHandler when v5 unavailable', () => {
    const { mock, calls } = makeInitMock({ foregroundApi: 'v4' });
    const { module } = setupForInit();
    const onFg = vi.fn();
    module.initialize({
      appId: 'a',
      getPlatform: () => 'ios',
      onesignal: mock,
      onForegroundNotification: onFg,
    });
    expect(calls.foregroundListeners.length).toBe(1);
    const cb = calls.foregroundListeners[0] as (event: unknown) => void;
    const complete = vi.fn();
    cb({ notification: { title: 'A', body: 'B' }, complete });
    expect(onFg).toHaveBeenCalledWith({ title: 'A', body: 'B' });
    expect(complete).toHaveBeenCalledWith({ title: 'A', body: 'B' });
  });

  it('skips auto-reporting when notificationEvent dep is absent', async () => {
    const { mock, calls } = makeInitMock();
    const saveSubscription = vi.fn().mockResolvedValue({ ok: true });
    let currentUserId: string | null = 'u-1';
    const module = new PushSubscriptions({
      saveSubscription,
      // notificationEvent intentionally omitted
      getUserId: () => currentUserId,
      onUserIdChange: () => () => undefined,
    });
    const onOpened = vi.fn();
    module.initialize({
      appId: 'a',
      getPlatform: () => 'ios',
      onesignal: mock,
      onNotificationOpened: onOpened,
    });
    const handler = calls.openedHandlers[0] as (jsonData: unknown) => void;
    handler({ notification: { additionalData: { notification_id: 'n' } } });
    // No throw, no crash, handler still dispatched.
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when called twice', () => {
    const { mock, calls } = makeInitMock();
    const { module } = setupForInit();
    module.initialize({ appId: 'a', getPlatform: () => 'ios', onesignal: mock });
    module.initialize({ appId: 'a', getPlatform: () => 'ios', onesignal: mock });
    expect(calls.init.length).toBe(1);
  });
});
