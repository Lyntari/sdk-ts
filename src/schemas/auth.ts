/**
 * Auth-flow EF schemas — 6 endpoints:
 *   - `consumer-login`, `consumer-signup` (issue access + refresh tokens)
 *   - `auth-refresh` (rotate access + refresh tokens)
 *   - `auth-logout` (revoke refresh token)
 *   - `reset-password` (set new password)
 *   - `delete-account` (soft-delete user, JWT-required)
 *
 * Each schema mirrors the deployed Edge Function's contract. Server-side
 * `_auth` block injection is documented in `_common.ts` via `withAuth(...)`;
 * the SDK transport layer adds `_auth` automatically — callers do not.
 *
 * Notable contract details:
 *
 * - `auth-refresh` returns `access_token` (not `token` — different from login/
 *   signup which return `token`). Preserved verbatim.
 * - `auth-refresh`, `auth-logout`, `reset-password` are HMAC-only (no JWT
 *   required). `delete-account` requires HMAC + JWT.
 * - `auth-logout` always returns HTTP 200 by contract — even for not-found,
 *   already-revoked, or expired tokens. The `revoked: boolean` field is the
 *   actual outcome. 4xx only on malformed requests; 5xx only on server faults.
 * - `consumer-signup` request shape is flat: `{email, password}`. Signup
 *   is open — no `betaPasscode` field, no invite-code gating. No signup-
 *   mode discriminated union exists in the server contract.
 * - `delete-account` request body is empty (`{}`) — the user_id is derived
 *   from the JWT `sub` claim. No client-visible soft-vs-hard branch.
 */

import { z } from 'zod';
import {
  AccessTokenPairSchema,
  EmailSchema,
  IsoTimestampSchema,
  UuidSchema,
} from './_common.js';

/**
 * Top-25 most commonly-breached passwords, lowercase. Used by
 * `ConsumerSignupRequestSchema` and `ResetPasswordRequestSchema` below to
 * reject obvious-weak choices.
 *
 * Per NIST 800-63B SP3 (2017+), composition rules (must-have-digit, must-have-
 * symbol) are explicitly discouraged because they drive users to predictable
 * variations. The recommended bar is length + dictionary check against known
 * breached passwords. This list is the in-EF/in-SDK equivalent of a tiny
 * breach-corpus check — the heaviest hitters get caught without requiring an
 * HIBP integration. Bigger lists (rockyou-top-1k, HIBP API) are a follow-up.
 *
 * Comparison is case-insensitive: `.toLowerCase()` runs against the candidate
 * password before the Set lookup. The list itself is all-lowercase by
 * convention; do not add mixed-case entries.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'qwertyuiop',
  'iloveyou',
  'admin123',
  'welcome1',
  'welcome123',
  'monkey123',
  'football1',
  'baseball1',
  'letmein1',
  'starwars',
  'dragon123',
  'master123',
  'mustang1',
  'shadow12',
  'sunshine',
  'princess',
  'whatever',
  'changeme',
]);

/**
 * Reusable password schema for consumer-facing flows (signup, reset). Length
 * is enforced at min(8); the blocklist refines the string to reject obvious-
 * common choices. Custom error messages surface verbatim through Zod's
 * `error.issues[0].message` so the EF layer can return them as
 * `details.field: 'password'` for the UI to render.
 */
const PasswordSchema = z
  .string()
  .min(8, { message: 'Password must be at least 8 characters long.' })
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), {
    message: 'This password is too common. Please choose something more unique.',
  });

// === consumer-login =======================================================

export const ConsumerLoginRequestSchema = z.object({
  email: EmailSchema,
  // Login uses z.string() — we don't apply the strength rules to existing
  // accounts (a user whose password happens to be on the blocklist still
  // needs to be able to log in and rotate). Signup + reset apply the rules.
  password: z.string(),
});

/**
 * Login response is the canonical access-token pair: `token`, `refresh_token`,
 * `user_id`, `expires_at` (ISO-8601). Identical to consumer-signup minus the
 * `message` field.
 */
export const ConsumerLoginResponseSchema = AccessTokenPairSchema;

export type ConsumerLoginRequest = z.infer<typeof ConsumerLoginRequestSchema>;
export type ConsumerLoginResponse = z.infer<typeof ConsumerLoginResponseSchema>;

// === consumer-signup ======================================================

/**
 * Signup request is a flat pair: email, password. Signup is open — no
 * beta-passcode or invite-code gating.
 */
export const ConsumerSignupRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});

/**
 * Signup returns the access-token pair plus a server `message` field
 * (`"Account created successfully"`).
 */
export const ConsumerSignupResponseSchema = AccessTokenPairSchema.extend({
  message: z.string(),
});

export type ConsumerSignupRequest = z.infer<typeof ConsumerSignupRequestSchema>;
export type ConsumerSignupResponse = z.infer<typeof ConsumerSignupResponseSchema>;

// === auth-refresh =========================================================

export const AuthRefreshRequestSchema = z.object({
  refresh_token: z.string(),
});

/**
 * Refresh response uses `access_token` (not `token` like login/signup). This
 * naming asymmetry is preserved from the deployed contract — fixing it would
 * be a breaking server-side change.
 *
 * On error, the server may set `terminal_for_auth: true` on the error
 * envelope to signal the client must re-authenticate (refresh-token revoked,
 * expired, or user no longer exists). See `ErrorEnvelopeSchema` in `_common.ts`.
 */
export const AuthRefreshResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: IsoTimestampSchema,
});

export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;
export type AuthRefreshResponse = z.infer<typeof AuthRefreshResponseSchema>;

// === auth-logout ==========================================================

export const AuthLogoutRequestSchema = z.object({
  refresh_token: z.string(),
});

/**
 * Logout always returns HTTP 200 by contract. The
 * `revoked: boolean` field tells the caller whether revocation actually
 * occurred. `reason` is `"not_found_or_already_revoked"` when `revoked: false`.
 * `request_id` echoes the X-Request-Id header.
 *
 * 4xx is reserved for malformed requests / auth failures; 5xx for genuine
 * server faults. Idempotent: the same token submitted twice is safe.
 */
export const AuthLogoutResponseSchema = z.object({
  revoked: z.boolean(),
  reason: z.string().optional(),
  request_id: z.string(),
});

export type AuthLogoutRequest = z.infer<typeof AuthLogoutRequestSchema>;
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponseSchema>;

// === reset-password (token flow — cluster #89 Backend-008) ================

/**
 * Reset a password with a single-use, expiring token obtained via
 * `request-password-reset` and delivered out-of-band. Replaces the pre-#89
 * HMAC-only `{email, new_password}` shape, which let any holder of the shared
 * API key set a new password for any account. `new_password` follows
 * `PasswordSchema` (min length + common-password blocklist).
 */
export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(16),
  new_password: PasswordSchema,
});

export const ResetPasswordResponseSchema = z.object({
  success: z.boolean(),
});

export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponseSchema>;

// === request-password-reset (cluster #89) =================================

/**
 * Begin the forgot-password flow. Returns the same 200 shape whether or not the
 * email exists (no account enumeration); when it exists, a single-use token is
 * delivered out-of-band.
 */
export const RequestPasswordResetRequestSchema = z.object({
  email: EmailSchema,
});

export const RequestPasswordResetResponseSchema = z.object({
  message: z.string(),
});

export type RequestPasswordResetRequest = z.infer<typeof RequestPasswordResetRequestSchema>;
export type RequestPasswordResetResponse = z.infer<typeof RequestPasswordResetResponseSchema>;

// === change-password (authenticated — cluster #89) ========================

/**
 * Change the authenticated user's password. HMAC + JWT — the user is derived
 * from the JWT `sub`, so a caller can only change their OWN password. This is
 * the session-JWT factor that closes the shared-secret takeover for logged-in
 * users. `new_password` follows `PasswordSchema`.
 */
export const ChangePasswordRequestSchema = z.object({
  new_password: PasswordSchema,
});

export const ChangePasswordResponseSchema = z.object({
  success: z.boolean(),
});

export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponseSchema>;

// === delete-account =======================================================

/**
 * Delete account is a JWT-required EF that takes an empty body — the
 * `user_id` is derived from the JWT `sub` claim. The deployed contract has
 * no client-visible soft-vs-hard discriminator; soft delete is automatic
 * with a 5-day server-side hard-delete window.
 *
 * Idempotency is supported: clients may pass an `Idempotency-Key` header to
 * make retries safe. The transport layer adds the header automatically.
 *
 * Marked `.strict()` so any unexpected client field is rejected with a 400
 * `validation_failed` rather than silently dropped — same precedent as
 * `GetCategoriesRequestSchema`. The contract is "send `{}` only"; an extra
 * field is a client bug worth surfacing. SDK and EF stay in lock-step on
 * the empty-body shape.
 */
export const DeleteAccountRequestSchema = z.object({}).strict();

/**
 * Response includes `success: true` and `user_id`, plus any extra fields the
 * underlying RPC returns (server uses `...data` spread). The shape is open
 * via `passthrough()` so future RPC additions don't break clients.
 */
export const DeleteAccountResponseSchema = z
  .object({
    success: z.boolean(),
    user_id: UuidSchema,
  })
  .passthrough();

export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;
