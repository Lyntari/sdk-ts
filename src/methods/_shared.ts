/**
 * Shared types + helpers for SDK method modules.
 *
 * `ClientConfig` — immutable per-client config (base URL + API key + HMAC
 * secret) passed to every transport call. Created once by `createLyntariClient`.
 *
 * `ClientState` — mutable per-client state. Holds the current access token
 * and an optional `onExpiredJwt` hook the transport calls when it receives
 * a 401 `expired_jwt`. Both fields are read at call time so mid-session
 * mutation (login, token rotation, lifecycle wiring) affects subsequent
 * calls without re-creating the client.
 */

export interface ClientConfig {
  /** Base URL (e.g., `https://<proj>.supabase.co/functions/v1`). No trailing slash. */
  readonly baseUrl: string;
  /** Public API key. Goes into `_auth.apiKey` for HMAC-mode and API-key-POST EFs. */
  readonly apiKey: string;
  /** HMAC signing secret. Used to compute the canonical signature. */
  readonly hmacSecret: string;
}

/**
 * Hook fired when transport receives `401 expired_jwt` on a JWT-required
 * call. Returns the rotated access token (transport retries once with it),
 * or `null` to surface the original `ExpiredJwtError`.
 */
export type ExpiredJwtHook = () => Promise<string | null>;

export interface ClientState {
  /** Current access token (JWT). `null` until `client.setAccessToken(...)` is called or the Auth lifecycle restores from storage. */
  accessToken: string | null;
  /** Set by the Auth lifecycle when wired; transport reads at call time for auto-refresh on `expired_jwt`. */
  onExpiredJwt: ExpiredJwtHook | null;
}

/**
 * Resolve the access token for a JWT-required method, throwing a clear
 * error when it isn't set. Keeps the failure mode local to the SDK rather
 * than letting the server return a confusing 401 `missing_jwt`.
 */
export function requireAccessToken(state: ClientState, methodSlug: string): string {
  if (state.accessToken === null) {
    throw new Error(
      `[@lyntari/sdk] ${methodSlug} requires an access token. ` +
        `Call client.setAccessToken(token) after a successful login/signup/refresh.`,
    );
  }
  return state.accessToken;
}

/**
 * Build the auth-related options for a JWT-required `postWithHMAC` call.
 * Bundles `accessToken` (resolved via `requireAccessToken`) with the
 * optional `onExpiredJwt` hook so JWT methods can spread the result into
 * their options object.
 */
export function jwtCallOpts(
  state: ClientState,
  methodSlug: string,
): { accessToken: string; onExpiredJwt: ExpiredJwtHook | undefined } {
  return {
    accessToken: requireAccessToken(state, methodSlug),
    onExpiredJwt: state.onExpiredJwt ?? undefined,
  };
}
