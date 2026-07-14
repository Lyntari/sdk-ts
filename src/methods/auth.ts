/**
 * Auth-flow SDK methods — 6 endpoints.
 *
 * Five HMAC-only POSTs (`consumer-login`, `consumer-signup`, `auth-refresh`,
 * `auth-logout`, `reset-password`) and one HMAC+JWT POST with idempotency
 * (`delete-account`).
 *
 * Token-issuing methods (`login`, `signup`, `refresh`) return an access token
 * + refresh token in their response. In caller-managed mode, the caller
 * persists tokens and calls `client.setAccessToken(...)` themselves. In
 * managed-lifecycle mode (`auth: { storage, ... }` passed to
 * `createLyntariClient`), these raw methods are wrapped by the lifecycle —
 * each token-issuing call automatically persists, schedules refresh, and
 * emits a `tokenRefreshed` event.
 *
 * Response shapes are returned as raw `z.infer<typeof ResponseSchema>` —
 * v0.1 doesn't run runtime response validation. Many response schemas are
 * intentionally permissive (`z.unknown()`, open records); blanket parse
 * would catch little while adding cost. Turn on per-method when a specific
 * schema becomes tight enough to provide signal.
 */

import type {
  AuthLogoutRequest,
  AuthLogoutResponse,
  AuthRefreshRequest,
  AuthRefreshResponse,
  ConsumerLoginRequest,
  ConsumerLoginResponse,
  ConsumerSignupRequest,
  ConsumerSignupResponse,
  DeleteAccountRequest,
  DeleteAccountResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
} from '../schemas/index.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface AuthMethods {
  /**
   * `consumer-login` — exchange email + password for an access/refresh token pair.
   *
   * On success the caller MUST persist `refresh_token` (long-lived, opaque)
   * and call `client.setAccessToken(token)` so subsequent JWT-required
   * methods include the token in the `_auth` block.
   */
  login(input: ConsumerLoginRequest): Promise<ConsumerLoginResponse>;

  /**
   * `consumer-signup` — create a user + issue tokens. Open signup — no
   * invite-code or beta-passcode gating.
   */
  signup(input: ConsumerSignupRequest): Promise<ConsumerSignupResponse>;

  /**
   * `auth-refresh` — rotate access + refresh tokens. Pass the current
   * `refresh_token`; the server returns a new pair and revokes the old
   * refresh token.
   */
  refresh(input: AuthRefreshRequest): Promise<AuthRefreshResponse>;

  /**
   * `auth-logout` — revoke the current refresh token. Always returns 200
   * `{revoked, request_id}` per the R1 contract — idempotent and safe to
   * call with an unknown token.
   */
  logout(input: AuthLogoutRequest): Promise<AuthLogoutResponse>;

  /**
   * `request-password-reset` — begin the forgot-password flow for an email.
   * Always returns the same `{message}` whether or not the account exists (no
   * enumeration). If it exists, a single-use reset token is delivered
   * out-of-band. Pair with `resetPassword` to complete.
   */
  requestPasswordReset(input: RequestPasswordResetRequest): Promise<RequestPasswordResetResponse>;

  /**
   * `reset-password` — complete a forgot-password flow with the single-use
   * `token` from `requestPasswordReset` + the `new_password`. Returns
   * `{success}`; raises on an invalid/expired/used token.
   */
  resetPassword(input: ResetPasswordRequest): Promise<ResetPasswordResponse>;

  /**
   * `change-password` — change the authenticated user's password (HMAC + JWT;
   * the user is the JWT `sub`). `client.setAccessToken(token)` must be set.
   * The session-JWT factor — a caller can only change their own password.
   */
  changePassword(input: ChangePasswordRequest): Promise<ChangePasswordResponse>;

  /**
   * `delete-account` — soft-delete the authenticated user (JWT-derived).
   * Empty body; the call is idempotency-keyed at the transport layer
   * (default UUID) so a duplicate retry replays the cached response.
   *
   * `client.setAccessToken(token)` must have been called first; throws if
   * no access token is set.
   */
  deleteAccount(input?: DeleteAccountRequest): Promise<DeleteAccountResponse>;
}

export function createAuthMethods(
  config: ClientConfig,
  state: ClientState,
): AuthMethods {
  return {
    login: async (input) =>
      postWithHMAC<ConsumerLoginResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'consumer-login',
        body: input,
        idempotencyKey: null,
      }),

    signup: async (input) =>
      postWithHMAC<ConsumerSignupResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'consumer-signup',
        body: input,
        idempotencyKey: null,
      }),

    refresh: async (input) =>
      postWithHMAC<AuthRefreshResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'auth-refresh',
        body: input,
        idempotencyKey: null,
      }),

    logout: async (input) =>
      postWithHMAC<AuthLogoutResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'auth-logout',
        body: input,
        idempotencyKey: null,
      }),

    requestPasswordReset: async (input) =>
      postWithHMAC<RequestPasswordResetResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'request-password-reset',
        body: input,
        idempotencyKey: null,
      }),

    resetPassword: async (input) =>
      postWithHMAC<ResetPasswordResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'reset-password',
        body: input,
        idempotencyKey: null,
      }),

    changePassword: async (input) =>
      postWithHMAC<ChangePasswordResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'change-password',
        body: input,
        ...jwtCallOpts(state, 'change-password'),
        idempotencyKey: null,
      }),

    deleteAccount: async (input = {}) =>
      postWithHMAC<DeleteAccountResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'delete-account',
        body: input,
        ...jwtCallOpts(state, 'delete-account'),
        // idempotent: true → leave undefined to auto-generate UUID
      }),
  };
}
