/**
 * Typed error hierarchy mirroring the canonical Lyntari error envelope.
 *
 * Server responses on error always have shape:
 *   { error: { code, message, request_id, details?, retry_safe?, terminal_for_auth? } }
 *
 * The SDK parses this envelope and throws an appropriate `LyntariApiError`
 * subclass per `error.code`. Callers can `instanceof`-check specific subclasses
 * for branch-on-error logic without inspecting the string code.
 *
 * Field semantics:
 * - `retry_safe`: per-request — server says this specific request is safe
 *   to retry (e.g. `visit_race_conflict`).
 * - `terminal_for_auth`: per-session — server says the client's stored auth
 *   state is dead and the user must re-authenticate (e.g.
 *   `refresh_token_revoked`). Distinct from `retry_safe`: a `terminal_for_auth`
 *   error is also `retry_safe: false`, but a `retry_safe: false` error is
 *   not necessarily auth-terminal.
 *
 * Subclasses are added for codes the SDK has special handling for
 * (auto-retry, etc.). Codes without a dedicated subclass surface as the
 * base `LyntariApiError`; callers can still inspect `.code` and `.status`.
 */

export interface ErrorEnvelope {
  code: string;
  message: string;
  request_id: string;
  details?: unknown;
  retry_safe?: boolean;
  terminal_for_auth?: boolean;
}

/** Base error for any non-2xx response from the Lyntari API. */
export class LyntariApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId: string;
  public readonly details?: unknown;
  public readonly retrySafe?: boolean;
  public readonly terminalForAuth?: boolean;
  /**
   * The human-readable server message, unwrapped. This is the value SDK
   * consumers should surface in UI when they need to show an error to the
   * end user — it's just `envelope.message`, no bracketed code prefix and
   * no `(request_id: …)` suffix.
   *
   * `.message` (inherited from `Error`) keeps the `[code] message (request_id: id)`
   * format so debug logs and `console.error` calls still carry the full context.
   * Pick one or the other based on audience: UI → `userMessage`; logs → `message`.
   */
  public readonly userMessage: string;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(`[${envelope.code}] ${envelope.message} (request_id: ${envelope.request_id})`);
    this.name = 'LyntariApiError';
    this.status = status;
    this.code = envelope.code;
    this.requestId = envelope.request_id;
    this.details = envelope.details;
    this.retrySafe = envelope.retry_safe;
    this.terminalForAuth = envelope.terminal_for_auth;
    this.userMessage = envelope.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HMAC signature mismatch — usually clock skew or wrong HMAC key. SDK retries once before surfacing. */
export class BadSignatureError extends LyntariApiError {
  constructor(envelope: ErrorEnvelope) {
    super(401, envelope);
    this.name = 'BadSignatureError';
    Object.setPrototypeOf(this, BadSignatureError.prototype);
  }
}

/** JWT expired. SDK can attempt token refresh + single retry if a refresh hook is wired. */
export class ExpiredJwtError extends LyntariApiError {
  constructor(envelope: ErrorEnvelope) {
    super(401, envelope);
    this.name = 'ExpiredJwtError';
    Object.setPrototypeOf(this, ExpiredJwtError.prototype);
  }
}

/** JWT shape or signature invalid. Not retryable — caller should re-authenticate. */
export class InvalidJwtError extends LyntariApiError {
  constructor(envelope: ErrorEnvelope) {
    super(401, envelope);
    this.name = 'InvalidJwtError';
    Object.setPrototypeOf(this, InvalidJwtError.prototype);
  }
}

/** Idempotency-Key conflict — same key, different request fingerprint. Caller bug. */
export class IdempotencyKeyConflictError extends LyntariApiError {
  constructor(envelope: ErrorEnvelope) {
    super(409, envelope);
    this.name = 'IdempotencyKeyConflictError';
    Object.setPrototypeOf(this, IdempotencyKeyConflictError.prototype);
  }
}

/** Body validation failed against the EF's request schema. `details` contains Zod issues. */
export class ValidationError extends LyntariApiError {
  constructor(envelope: ErrorEnvelope) {
    super(400, envelope);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/** Clock skew exceeded the 5-minute window. Caller should sync their clock. */
export class ClockSkewError extends LyntariApiError {
  constructor(envelope: ErrorEnvelope) {
    super(400, envelope);
    this.name = 'ClockSkewError';
    Object.setPrototypeOf(this, ClockSkewError.prototype);
  }
}

/** Rate-limit hit. `details.retry_after_ms` (when present) is the recommended wait. */
export class RateLimitError extends LyntariApiError {
  constructor(envelope: ErrorEnvelope) {
    super(429, envelope);
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * Network or parse-level transport error — server didn't return a recognizable
 * envelope, or fetch itself failed. Use `cause` to inspect the underlying error.
 */
export class TransportError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TransportError';
    this.cause = cause;
    Object.setPrototypeOf(this, TransportError.prototype);
  }
}

/**
 * Map an error envelope from a server response to the right typed subclass.
 * Unknown codes fall through to the base `LyntariApiError`.
 */
export function envelopeToError(status: number, envelope: ErrorEnvelope): LyntariApiError {
  switch (envelope.code) {
    case 'bad_signature':
      return new BadSignatureError(envelope);
    case 'expired_jwt':
      return new ExpiredJwtError(envelope);
    case 'invalid_jwt':
    case 'missing_jwt':
    case 'user_id_mismatch':
      return new InvalidJwtError(envelope);
    case 'idempotency_key_conflict':
      return new IdempotencyKeyConflictError(envelope);
    case 'validation_failed':
    case 'invalid_request':
      return new ValidationError(envelope);
    case 'clock_skew_exceeded':
      return new ClockSkewError(envelope);
    case 'rate_limited':
      return new RateLimitError(envelope);
    default:
      return new LyntariApiError(status, envelope);
  }
}
