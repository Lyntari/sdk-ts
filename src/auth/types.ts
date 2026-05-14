/**
 * Public types for the Auth lifecycle module.
 *
 * Discriminated `AuthEvent` covers the three refresh outcomes (success,
 * server-terminal revocation, transient failure) plus a `cleared` state-
 * transition signal:
 *
 *  - `tokenRefreshed` — refresh succeeded; access token rotated, state
 *    updated, refresh re-scheduled.
 *  - `authExpired` — server signaled `terminal_for_auth: true` (refresh
 *    token revoked, expired, or user removed). Stored auth is cleared and
 *    the caller must re-authenticate. The matching `cleared` event also
 *    fires before this one (from `clear()`) — `authExpired` carries the
 *    server-side reason; `cleared` carries the state-transition signal.
 *  - `authError` — transient failure (network, parse, 5xx without
 *    `terminal_for_auth`). Stored auth is preserved; the lifecycle will
 *    retry on the next opportunity (next scheduled tick, next on-demand
 *    refresh, or next `expired_jwt` triggered retry).
 *  - `cleared` — local auth state was just cleared (voluntary logout,
 *    `deleteAccount`, an explicit `client.auth.clear()` call, or the
 *    terminal-refresh-failure path). Fires whenever a non-null `AuthState`
 *    transitions to null. Consumers that maintain user-scoped state
 *    (e.g., `PushSubscriptions`) listen for this to know when to drop it;
 *    consumers that only care about server-side terminal failures use
 *    `authExpired`. Does NOT fire when `clear()` is called against an
 *    already-empty state — the event signals a real transition.
 */

export interface AuthState {
  readonly user_id: string;
  /** Absolute expiry time in epoch milliseconds. */
  readonly expires_at: number;
}

export type AuthEvent =
  | {
      readonly type: 'tokenRefreshed';
      readonly state: AuthState;
    }
  | {
      readonly type: 'authExpired';
      /** Reason surfaced from the server's `terminal_for_auth` error. */
      readonly reason: 'revoked';
    }
  | {
      readonly type: 'authError';
      /** Transient failure cause — network, parse, non-terminal server error. */
      readonly cause: unknown;
    }
  | {
      readonly type: 'cleared';
    };

export type AuthEventListener = (event: AuthEvent) => void;

/**
 * Refresh outcome tri-state. Returned by the Auth module's internal refresh
 * path so callers (transport retry, scheduler tick, on-demand `refresh()`)
 * can branch on success / server-terminal revocation / transient failure.
 */
export type RefreshOutcome = 'ok' | 'revoked' | 'transient';
