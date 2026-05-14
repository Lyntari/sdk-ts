/**
 * `AuthLifecycle` — owns the access/refresh token lifecycle for clients
 * constructed with `auth: { storage, onEvent? }`.
 *
 * Responsibilities:
 *  - Restore stored auth from `TokenStorage` on `init()`.
 *  - Persist tokens + user + expiry across login/signup/refresh/logout.
 *  - Schedule auto-refresh `REFRESH_LEAD_MS` before `token_expires_at`.
 *  - Auto-attach the access token to outbound requests via shared
 *    `ClientState.accessToken`.
 *  - Classify refresh failures as `ok | revoked | transient` via the
 *    server's `terminal_for_auth` flag, and emit the matching `AuthEvent`.
 *  - Expose a wrapped `AuthMethods` surface where each token-issuing
 *    method (login/signup/refresh) writes through the lifecycle, and
 *    `logout`/`deleteAccount` clear local state after the EF call.
 *
 * Storage keys are stable string contracts of this module: `authToken`,
 * `refreshToken`, `authUser`, `user_id`, `token_expires_at`. The
 * `token_expires_at` value is a millis-string; server-issued `expires_at`
 * (ISO-8601) is converted to ms at the boundary so stored values stay
 * numeric. Implementations of `TokenStorage` must round-trip these keys
 * by value; the SDK does not depend on any particular storage backend.
 *
 * The `email` claim is reconstructed from the stored `authUser` JSON on
 * cold-start when present; signup/login persist whatever the caller passes
 * via `onTokensIssued` (the wrapped methods pass the request's `email`).
 */

import {
  type ConsumerLoginRequest,
  type ConsumerSignupRequest,
  type AuthRefreshRequest,
  type AuthRefreshResponse,
  type AuthLogoutRequest,
  type AuthLogoutResponse,
  type ResetPasswordRequest,
  type ResetPasswordResponse,
  type DeleteAccountRequest,
  type DeleteAccountResponse,
} from '../schemas/index.js';
import { LyntariApiError } from '../transport/errors.js';
import type { AuthMethods } from '../methods/auth.js';
import type { ClientState } from '../methods/_shared.js';
import type { TokenStorage } from '../storage/types.js';
import type {
  AuthEvent,
  AuthEventListener,
  AuthState,
  RefreshOutcome,
} from './types.js';

/** Refresh this far ahead of `expires_at`. 5 minutes is the SDK default. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

/** Stable `TokenStorage` keys — part of this module's public contract. */
const KEY_AUTH_TOKEN = 'authToken';
const KEY_REFRESH_TOKEN = 'refreshToken';
const KEY_AUTH_USER = 'authUser';
const KEY_USER_ID = 'user_id';
const KEY_TOKEN_EXPIRES_AT = 'token_expires_at';

interface StoredAuthUser {
  email: string;
  user_id: string;
}

interface LifecycleDeps {
  /** Persistence layer — `CapacitorPreferencesStorage` for Capacitor apps, `InMemoryStorage` for tests/Node, or any `TokenStorage` implementation. */
  readonly storage: TokenStorage;
  /** Shared `ClientState` from `createLyntariClient`. The lifecycle writes `accessToken` here so all method modules see it. */
  readonly state: ClientState;
  /** Raw `AuthMethods` (the unwrapped EF wrappers). The lifecycle calls these and adds persistence/scheduling on top. */
  readonly rawAuth: AuthMethods;
  /** Optional event handler attached at construction; subsequent listeners attach via `onEvent`. */
  readonly onEvent?: AuthEventListener;
}

export class AuthLifecycle {
  private readonly storage: TokenStorage;
  private readonly state: ClientState;
  private readonly rawAuth: AuthMethods;
  private readonly listeners = new Set<AuthEventListener>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private currentState: AuthState | null = null;
  private currentEmail: string | null = null;
  private currentRefreshToken: string | null = null;
  private initialized = false;

  constructor(deps: LifecycleDeps) {
    this.storage = deps.storage;
    this.state = deps.state;
    this.rawAuth = deps.rawAuth;
    if (deps.onEvent) this.listeners.add(deps.onEvent);
  }

  // === Public surface =====================================================

  /** Current auth state — `null` until login/restore succeeds. */
  get authState(): AuthState | null {
    return this.currentState;
  }

  /**
   * Subscribe to lifecycle events. Returns an unsubscribe function.
   * Multiple listeners are supported; each receives every event.
   */
  onEvent(listener: AuthEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Restore stored auth from `TokenStorage`. Call once after constructing
   * the client (idempotent — subsequent calls return the same outcome
   * without re-touching storage).
   *
   * Cold-start refresh policy: if the stored access token is past
   * `expires_at`, attempts a refresh immediately; on revoked, clears local
   * state; on transient, leaves the stored values intact and returns
   * `restored: false` so the caller appears logged-out for the session
   * and retries on next launch.
   */
  async init(): Promise<{ restored: boolean }> {
    if (this.initialized) {
      return { restored: this.currentState !== null };
    }
    this.initialized = true;

    const [storedAccessToken, storedRefreshToken, storedExpiresAt, storedUserId, storedAuthUser] =
      await Promise.all([
        this.storage.get(KEY_AUTH_TOKEN),
        this.storage.get(KEY_REFRESH_TOKEN),
        this.storage.get(KEY_TOKEN_EXPIRES_AT),
        this.storage.get(KEY_USER_ID),
        this.storage.get(KEY_AUTH_USER),
      ]);

    if (!storedAccessToken || !storedRefreshToken || !storedExpiresAt || !storedUserId) {
      return { restored: false };
    }

    const expiresAt = parseInt(storedExpiresAt, 10);
    if (Number.isNaN(expiresAt)) {
      // Corrupt stored value — clear and start fresh.
      await this.clearStorage();
      return { restored: false };
    }

    this.currentRefreshToken = storedRefreshToken;
    if (storedAuthUser) {
      try {
        const parsed = JSON.parse(storedAuthUser) as StoredAuthUser;
        if (parsed && typeof parsed.email === 'string') {
          this.currentEmail = parsed.email;
        }
      } catch {
        // Corrupt user JSON — non-fatal; email stays null.
      }
    }

    if (Date.now() >= expiresAt) {
      // Access token already expired — refresh now. Result determines restore.
      // Populate currentState from storage BEFORE refreshInternal so
      // handleRefreshSucceeded's `if (this.currentState)` guard sees a non-null
      // value and updates expires_at. Without this, cold-start with an expired
      // token leaves currentState null even after a successful refresh — the
      // SDK getter returns null, the React mirror sees null state, and the
      // route guard redirects to /auth despite the server-side refresh having
      // succeeded. user_id is invariant across refresh per the rawAuth contract.
      this.currentState = { user_id: storedUserId, expires_at: expiresAt };
      const outcome = await this.refreshInternal(storedRefreshToken);
      return { restored: outcome === 'ok' };
    }

    // Restore in-memory state from valid stored values.
    this.state.accessToken = storedAccessToken;
    this.currentState = { user_id: storedUserId, expires_at: expiresAt };
    this.scheduleRefresh(expiresAt);
    return { restored: true };
  }

  /**
   * Force a refresh on demand. Returns the new tokens on success, throws
   * `LyntariApiError` on revoked / `Error` on transient. Used by callers
   * that need to refresh ahead of the scheduled timer (e.g. before a
   * latency-sensitive operation).
   */
  async refresh(): Promise<AuthRefreshResponse> {
    if (!this.currentRefreshToken) {
      throw new Error('[@lyntari/sdk] auth.refresh(): no refresh token available');
    }
    const outcome = await this.refreshInternal(this.currentRefreshToken);
    if (outcome !== 'ok' || !this.lastRefreshResult) {
      // The internal path already emitted the matching event.
      throw new Error(`[@lyntari/sdk] auth.refresh() failed: ${outcome}`);
    }
    return this.lastRefreshResult;
  }

  /**
   * Auto-refresh used by the transport on `expired_jwt`. Returns the new
   * access token on success, `null` on revoked or transient (caller treats
   * both as "stop retrying"). On revoked, local state is also cleared.
   */
  async autoRefresh(): Promise<string | null> {
    if (!this.currentRefreshToken) return null;
    const outcome = await this.refreshInternal(this.currentRefreshToken);
    return outcome === 'ok' ? this.state.accessToken : null;
  }

  /**
   * Clear local state without calling `auth-logout`. Used after a `revoked`
   * refresh, by the wrapped `logout` / `deleteAccount` methods after the
   * server call settles, or when the caller wants to forcibly drop session
   * state.
   *
   * Emits `cleared` if the call represents a real state transition (i.e.,
   * `currentState` was non-null before this call). Calling `clear()` on
   * an already-empty lifecycle is a no-op and emits nothing — the event
   * signals a real transition, not the method's invocation.
   */
  async clear(): Promise<void> {
    const hadAuth = this.currentState !== null;
    await this.clearStorage();
    this.state.accessToken = null;
    this.currentState = null;
    this.currentEmail = null;
    this.currentRefreshToken = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (hadAuth) {
      this.emit({ type: 'cleared' });
    }
  }

  // === Wrapped AuthMethods surface ========================================

  /**
   * Returns a wrapped `AuthMethods` where each token-issuing method
   * persists through the lifecycle. The wrapped surface is shape-identical
   * to the raw surface — responses are unchanged; side effects are added.
   */
  wrapMethods(): AuthMethods {
    return {
      login: async (input: ConsumerLoginRequest) => {
        const result = await this.rawAuth.login(input);
        await this.handleTokensIssued({
          access_token: result.token,
          refresh_token: result.refresh_token,
          user_id: result.user_id,
          expires_at: result.expires_at,
          email: input.email,
        });
        return result;
      },

      signup: async (input: ConsumerSignupRequest) => {
        const result = await this.rawAuth.signup(input);
        await this.handleTokensIssued({
          access_token: result.token,
          refresh_token: result.refresh_token,
          user_id: result.user_id,
          expires_at: result.expires_at,
          email: input.email,
        });
        return result;
      },

      refresh: async (input: AuthRefreshRequest) => {
        const result = await this.rawAuth.refresh(input);
        await this.handleRefreshSucceeded(result);
        return result;
      },

      logout: async (input: AuthLogoutRequest) => {
        let result: AuthLogoutResponse;
        try {
          result = await this.rawAuth.logout(input);
        } finally {
          // Local clear is unconditional — auth-logout is contract-idempotent,
          // and even on network failure we want session state cleared.
          await this.clear();
        }
        return result;
      },

      resetPassword: async (input: ResetPasswordRequest): Promise<ResetPasswordResponse> => {
        return this.rawAuth.resetPassword(input);
      },

      deleteAccount: async (input?: DeleteAccountRequest): Promise<DeleteAccountResponse> => {
        const result = await this.rawAuth.deleteAccount(input);
        await this.clear();
        return result;
      },
    };
  }

  // === Internal ===========================================================

  /** Stash the last refresh result so `refresh()` can return it. */
  private lastRefreshResult: AuthRefreshResponse | null = null;

  private async refreshInternal(refreshToken: string): Promise<RefreshOutcome> {
    try {
      const result = await this.rawAuth.refresh({ refresh_token: refreshToken });
      await this.handleRefreshSucceeded(result);
      this.lastRefreshResult = result;
      return 'ok';
    } catch (err) {
      this.lastRefreshResult = null;
      if (err instanceof LyntariApiError && err.terminalForAuth === true) {
        await this.clear();
        this.emit({ type: 'authExpired', reason: 'revoked' });
        return 'revoked';
      }
      this.emit({ type: 'authError', cause: err });
      return 'transient';
    }
  }

  private async handleRefreshSucceeded(result: AuthRefreshResponse): Promise<void> {
    const expiresAtMs = new Date(result.expires_at).getTime();
    this.state.accessToken = result.access_token;
    this.currentRefreshToken = result.refresh_token;
    // user_id is unchanged across refresh — preserve existing currentState.user_id
    // if present; otherwise fall back to nothing (a refresh without a prior
    // login is an unusual path but we don't synthesize a user_id).
    if (this.currentState) {
      this.currentState = { user_id: this.currentState.user_id, expires_at: expiresAtMs };
    }
    await Promise.all([
      this.storage.set(KEY_AUTH_TOKEN, result.access_token),
      this.storage.set(KEY_REFRESH_TOKEN, result.refresh_token),
      this.storage.set(KEY_TOKEN_EXPIRES_AT, expiresAtMs.toString()),
    ]);
    this.scheduleRefresh(expiresAtMs);
    if (this.currentState) {
      this.emit({ type: 'tokenRefreshed', state: this.currentState });
    }
  }

  private async handleTokensIssued(input: {
    access_token: string;
    refresh_token: string;
    user_id: string;
    expires_at: string;
    email: string;
  }): Promise<void> {
    const expiresAtMs = new Date(input.expires_at).getTime();
    const authUser: StoredAuthUser = { email: input.email, user_id: input.user_id };

    this.state.accessToken = input.access_token;
    this.currentState = { user_id: input.user_id, expires_at: expiresAtMs };
    this.currentEmail = input.email;
    this.currentRefreshToken = input.refresh_token;

    await Promise.all([
      this.storage.set(KEY_AUTH_TOKEN, input.access_token),
      this.storage.set(KEY_REFRESH_TOKEN, input.refresh_token),
      this.storage.set(KEY_AUTH_USER, JSON.stringify(authUser)),
      this.storage.set(KEY_USER_ID, input.user_id),
      this.storage.set(KEY_TOKEN_EXPIRES_AT, expiresAtMs.toString()),
    ]);

    this.scheduleRefresh(expiresAtMs);
    this.emit({ type: 'tokenRefreshed', state: this.currentState });
  }

  private scheduleRefresh(expiresAtMs: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const delay = expiresAtMs - Date.now() - REFRESH_LEAD_MS;
    if (delay <= 0) {
      // Already past the refresh threshold — fire immediately on next tick.
      // Decoupling from the current call frame avoids reentrancy when the
      // caller triggered this from inside handleTokensIssued.
      const refreshToken = this.currentRefreshToken;
      if (refreshToken) {
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null;
          void this.refreshInternal(refreshToken);
        }, 0);
      }
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const refreshToken = this.currentRefreshToken;
      if (refreshToken) {
        void this.refreshInternal(refreshToken);
      }
    }, delay);
  }

  private async clearStorage(): Promise<void> {
    await Promise.all([
      this.storage.remove(KEY_AUTH_TOKEN),
      this.storage.remove(KEY_REFRESH_TOKEN),
      this.storage.remove(KEY_AUTH_USER),
      this.storage.remove(KEY_USER_ID),
      this.storage.remove(KEY_TOKEN_EXPIRES_AT),
    ]);
  }

  private emit(event: AuthEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener bugs must not corrupt lifecycle state.
      }
    }
  }
}
