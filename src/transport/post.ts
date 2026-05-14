/**
 * `postWithHMAC` — signed POST primitive.
 *
 * The transport-layer signed-POST primitive. Called by typed method wrappers
 * (auth.login, visits.recordSignal, etc.); callers don't invoke this
 * directly.
 *
 * Behavior:
 *  - Sign body per `signRequest` (canonical algorithm, byte-for-byte parity
 *    with the Deno-side validator)
 *  - Inject `_auth` into the body before sending
 *  - Optionally inject `Idempotency-Key` (UUID default; callers can override)
 *  - On 401 `bad_signature`: retry ONCE with a fresh timestamp (clock-skew
 *    self-heal). Surface the second failure if it persists.
 *  - On 409 `visit_race_conflict` with `retry_safe: true`: sleep 100ms and
 *    retry ONCE. Orthogonal to auth — applies regardless of whether the
 *    Auth lifecycle is wired.
 *  - On 401 `expired_jwt`: if an `onExpiredJwt` hook is set, call it to get
 *    a refreshed access token and retry ONCE with the new token in `_auth`.
 *    Without a hook, surface as `ExpiredJwtError` (v0.1 caller-managed mode).
 *  - On any other non-2xx: parse the canonical envelope, throw the matching
 *    typed error via `envelopeToError`.
 *
 * The three retry categories are independent — each may fire at most once
 * per call. A safety cap of 4 dispatches bounds the loop in case a server
 * pathologically alternates error codes.
 */

import {
  canonicalPathForSlug,
  canonicalizeQuery,
  signRequest,
} from './hmac.js';
import {
  envelopeToError,
  TransportError,
  type ErrorEnvelope,
  BadSignatureError,
  ExpiredJwtError,
  LyntariApiError,
} from './errors.js';

export interface PostWithHmacOptions {
  /** Base URL (e.g., `https://<proj>.supabase.co/functions/v1`). No trailing slash. */
  baseUrl: string;
  /** Endpoint slug (e.g., `get-categories`). No leading slash. */
  slug: string;
  /** API key (public). Goes into `_auth.apiKey`. */
  apiKey: string;
  /** HMAC secret. Used to sign the canonical string. */
  hmacSecret: string;
  /** Request body (without `_auth`). May be `{}` for body-less POST endpoints. */
  body: Record<string, unknown>;
  /** Optional access token (JWT). Goes into `_auth.token`. Required for client EFs that use `validateHmacPostWithJwt`. */
  accessToken?: string;
  /** Optional idempotency key. Pass `null` to opt out for the small set of read-only POSTs that don't need it. */
  idempotencyKey?: string | null;
  /** Optional query string params. Default none. */
  query?: Record<string, string>;
  /**
   * Whether to retry once on `bad_signature` (clock-skew self-heal). Default `true`.
   * Set to `false` only in tests or when the caller wants to surface the first failure directly.
   */
  retryOnBadSignature?: boolean;
  /**
   * Hook called on `401 expired_jwt`. Returns the new access token to retry
   * with, or `null` to surface the original `ExpiredJwtError`. Wired by the
   * Auth lifecycle when constructed with `auth: { storage, ... }`; left
   * unset in caller-managed mode.
   */
  onExpiredJwt?: () => Promise<string | null>;
}

interface AuthBlock {
  apiKey: string;
  timestamp: string;
  signature: string;
  token?: string;
}

/**
 * Default UUID generator. Uses Web Crypto's `randomUUID` (available in Node
 * 19+, modern browsers, Deno). For Node 18 environments without it, callers
 * can pass `idempotencyKey` explicitly.
 */
function defaultIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback — not a true UUID, but unique enough for the small subset of
  // environments without `crypto.randomUUID`. Real UUIDs preferred when
  // available.
  return `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function dispatchSigned(
  opts: PostWithHmacOptions,
): Promise<unknown> {
  const path = canonicalPathForSlug(opts.slug);
  const query = opts.query
    ? canonicalizeQuery(new URLSearchParams(opts.query))
    : '';

  const { timestamp, signature } = await signRequest({
    apiKey: opts.apiKey,
    hmacSecret: opts.hmacSecret,
    method: 'POST',
    path,
    query,
    body: opts.body,
  });

  const auth: AuthBlock = {
    apiKey: opts.apiKey,
    timestamp,
    signature,
  };
  if (opts.accessToken) auth.token = opts.accessToken;

  const signedBody = { ...opts.body, _auth: auth };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (opts.idempotencyKey !== null) {
    headers['Idempotency-Key'] = opts.idempotencyKey ?? defaultIdempotencyKey();
  }

  const url = `${opts.baseUrl.replace(/\/$/, '')}/${opts.slug}${
    query ? `?${query}` : ''
  }`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(signedBody),
    });
  } catch (cause) {
    throw new TransportError(`fetch failed for POST ${url}`, cause);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new TransportError(
      `failed to parse JSON response from POST ${url} (status ${response.status})`,
      cause,
    );
  }

  if (response.ok) return parsed;

  const envelope = (parsed as { error?: ErrorEnvelope } | null)?.error;
  if (!envelope) {
    throw new TransportError(
      `POST ${url} returned non-2xx (${response.status}) with no canonical error envelope`,
      parsed,
    );
  }

  throw envelopeToError(response.status, envelope);
}

const VISIT_RACE_RETRY_DELAY_MS = 100;

/**
 * Sign + POST + parse with up-to-one retry per recoverable error category.
 *
 * - `bad_signature` → retry with fresh timestamp (clock-skew self-heal).
 * - `visit_race_conflict` (retry_safe=true) → 100ms backoff, retry.
 * - `expired_jwt` + `onExpiredJwt` hook → refresh token, retry with new JWT.
 *
 * Each category retries at most once per call. The 4-dispatch safety cap
 * bounds the loop even when the server pathologically alternates error
 * codes (3 categories × 1 retry each + the initial attempt).
 */
export async function postWithHMAC<T = unknown>(
  opts: PostWithHmacOptions,
): Promise<T> {
  const retryOnBadSignature = opts.retryOnBadSignature !== false;
  let currentOpts: PostWithHmacOptions = opts;
  let triedBadSignature = false;
  let triedRaceConflict = false;
  let triedExpiredJwt = false;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return (await dispatchSigned(currentOpts)) as T;
    } catch (err) {
      if (
        retryOnBadSignature &&
        err instanceof BadSignatureError &&
        !triedBadSignature
      ) {
        triedBadSignature = true;
        continue;
      }

      if (
        err instanceof LyntariApiError &&
        err.code === 'visit_race_conflict' &&
        err.retrySafe === true &&
        !triedRaceConflict
      ) {
        triedRaceConflict = true;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, VISIT_RACE_RETRY_DELAY_MS),
        );
        continue;
      }

      if (
        err instanceof ExpiredJwtError &&
        opts.onExpiredJwt &&
        !triedExpiredJwt
      ) {
        triedExpiredJwt = true;
        const newToken = await opts.onExpiredJwt();
        if (!newToken) throw err;
        currentOpts = { ...currentOpts, accessToken: newToken };
        continue;
      }

      throw err;
    }
  }

  // Unreachable in normal operation — the loop either returns or throws.
  // Defensive fallthrough surfaces a clear bug signal rather than hanging.
  throw new TransportError(
    `[@lyntari/sdk] postWithHMAC retry loop exceeded for slug=${opts.slug}; this is a bug`,
  );
}
