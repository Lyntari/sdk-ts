/**
 * `postWithApiKey` — POST primitive for API-key-in-body EFs.
 *
 * The third auth mode after HMAC-POST and API-key-GET. Currently used by
 * `congestion-history` only — admin/analytics endpoint that authenticates
 * via `_auth.apiKey` in the request body without HMAC signing or JWT.
 *
 * Behavior:
 *  - Inject `_auth.apiKey` into the body before sending
 *  - No HMAC, no timestamp, no signature, no JWT
 *  - No idempotency (the EFs that use this auth mode are read-only)
 *  - On non-2xx: parse the canonical envelope, throw the matching typed error
 */

import {
  envelopeToError,
  TransportError,
  type ErrorEnvelope,
} from './errors.js';

export interface PostWithApiKeyOptions {
  /** Base URL (e.g., `https://<proj>.supabase.co/functions/v1`). No trailing slash. */
  baseUrl: string;
  /** Endpoint slug (e.g., `congestion-history`). No leading slash. */
  slug: string;
  /** API key (public). Goes into `_auth.apiKey`. */
  apiKey: string;
  /** Request body (without `_auth`). */
  body: Record<string, unknown>;
  /** Optional query string params. Default none. */
  query?: Record<string, string>;
}

export async function postWithApiKey<T = unknown>(
  opts: PostWithApiKeyOptions,
): Promise<T> {
  const queryString = opts.query
    ? new URLSearchParams(opts.query).toString()
    : '';

  const url = `${opts.baseUrl.replace(/\/$/, '')}/${opts.slug}${
    queryString ? `?${queryString}` : ''
  }`;

  const signedBody = { ...opts.body, _auth: { apiKey: opts.apiKey } };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  if (response.ok) return parsed as T;

  const envelope = (parsed as { error?: ErrorEnvelope } | null)?.error;
  if (!envelope) {
    throw new TransportError(
      `POST ${url} returned non-2xx (${response.status}) with no canonical error envelope`,
      parsed,
    );
  }

  throw envelopeToError(response.status, envelope);
}
