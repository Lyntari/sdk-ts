/**
 * `getWithApiKey` — unsigned GET primitive for read-only API-key-auth EFs.
 *
 * Used by the small set of read-only EFs that authenticate with an API key
 * in a header rather than HMAC in body (e.g., `waitboard`, `pos-current-visits`).
 * The Edge Functions validate via `validateApiKeyGet` / `validatePosApiKeyGet`
 * in the canonical `_shared/hmac.ts`.
 *
 * No HMAC, no body, no idempotency. Just a header-authed GET.
 */

import {
  envelopeToError,
  TransportError,
  type ErrorEnvelope,
} from './errors.js';

export interface GetWithApiKeyOptions {
  /** Base URL (e.g., `https://<proj>.supabase.co/functions/v1`). No trailing slash. */
  baseUrl: string;
  /** Endpoint slug (e.g., `waitboard`). No leading slash. */
  slug: string;
  /**
   * API key. Sent in both `apikey` and `x-api-key` headers (matches what
   * `validateApiKeyGet` accepts).
   */
  apiKey: string;
  /** Optional query string params. Default none. */
  query?: Record<string, string>;
}

export async function getWithApiKey<T = unknown>(
  opts: GetWithApiKeyOptions,
): Promise<T> {
  const queryString = opts.query
    ? new URLSearchParams(opts.query).toString()
    : '';

  const url = `${opts.baseUrl.replace(/\/$/, '')}/${opts.slug}${
    queryString ? `?${queryString}` : ''
  }`;

  const headers: Record<string, string> = {
    apikey: opts.apiKey,
    'x-api-key': opts.apiKey,
  };

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers });
  } catch (cause) {
    throw new TransportError(`fetch failed for GET ${url}`, cause);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new TransportError(
      `failed to parse JSON response from GET ${url} (status ${response.status})`,
      cause,
    );
  }

  if (response.ok) return parsed as T;

  const envelope = (parsed as { error?: ErrorEnvelope } | null)?.error;
  if (!envelope) {
    throw new TransportError(
      `GET ${url} returned non-2xx (${response.status}) with no canonical error envelope`,
      parsed,
    );
  }

  throw envelopeToError(response.status, envelope);
}
