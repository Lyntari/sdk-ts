/**
 * HMAC signing — TS port of the canonical Deno-side `_shared/hmac.ts` v4.
 *
 * Byte-for-byte parity is non-negotiable: any deviation causes server-side
 * `bad_signature` rejection. The algorithm is:
 *
 *   1. bodyHash = SHA-256(JSON.stringify(body without _auth)) → lowercase hex
 *   2. canonicalPath = "/functions/v1" + endpoint slug ("/get-categories" etc.)
 *   3. canonicalQuery = searchParams sorted alphabetically by key, joined "&"
 *   4. canonical = [timestamp, method, canonicalPath, canonicalQuery, bodyHash].join("\n")
 *   5. signature = HMAC-SHA256(canonical, secret) → base64 → base64url
 *      (replace + with -, / with _, strip trailing =)
 *
 * Both sides use Web Crypto (`crypto.subtle`), available in:
 *   - Node 18+
 *   - Modern browsers
 *   - Deno (server-side)
 *
 * Test vectors live at `test-vectors/hmac.json`. They're generated from the
 * canonical Deno implementation by `scripts/generate-test-vectors.ts` and
 * consumed by `tests/hmac.test.ts` to verify this port produces identical
 * output. Drift is structurally caught.
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Convert standard base64 to base64url:
 *  - `+` → `-`
 *  - `/` → `_`
 *  - strip trailing `=` padding
 */
export function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Encode bytes as standard base64. Cross-platform (no `btoa` in Node <16,
 * present in Node 16+ and browsers; we use a manual encoder for portability).
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Manual encoder — avoids `btoa`/`Buffer` to keep this file environment-agnostic.
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    const c = bytes[i + 2] as number;
    out += BASE64_CHARS[a >> 2];
    out += BASE64_CHARS[((a & 0x03) << 4) | (b >> 4)];
    out += BASE64_CHARS[((b & 0x0f) << 2) | (c >> 6)];
    out += BASE64_CHARS[c & 0x3f];
  }
  if (i < bytes.length) {
    const a = bytes[i] as number;
    out += BASE64_CHARS[a >> 2];
    if (i + 1 < bytes.length) {
      const b = bytes[i + 1] as number;
      out += BASE64_CHARS[((a & 0x03) << 4) | (b >> 4)];
      out += BASE64_CHARS[(b & 0x0f) << 2];
      out += '=';
    } else {
      out += BASE64_CHARS[(a & 0x03) << 4];
      out += '==';
    }
  }
  return out;
}

/** SHA-256 of `JSON.stringify(body)` → lowercase hex. */
export async function computeBodyHash(body: unknown): Promise<string> {
  const text = JSON.stringify(body);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Canonicalize a query string by sorting params alphabetically by key.
 * Mirrors the Deno-side `canonicalizeQuery` — uses `String.localeCompare`
 * without locale args (default locale; consistent for ASCII keys).
 */
export function canonicalizeQuery(searchParams: URLSearchParams): string {
  return Array.from(searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Compute the HMAC-SHA256 signature for a canonical signing string.
 * Returns base64url-encoded signature.
 */
export async function signCanonical(canonical: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(canonical));
  return toBase64Url(bytesToBase64(new Uint8Array(sigBuf)));
}

export interface SignRequestInput {
  /** API key (the public key, included in `_auth.apiKey`). Not used in the signature itself. */
  apiKey: string;
  /** HMAC secret (server-side `HMAC_KEY`). Used to derive the HMAC key. */
  hmacSecret: string;
  /** HTTP method. */
  method: 'POST' | 'GET';
  /**
   * Canonical path including the `/functions/v1` prefix, e.g.
   * `/functions/v1/get-categories`. The SDK builds this from the endpoint
   * slug; callers don't construct it manually.
   */
  path: string;
  /**
   * Canonicalized query string (alphabetically sorted by key, `&`-joined,
   * empty string if no params).
   */
  query: string;
  /**
   * Request body (the object that will be JSON-stringified and sent), WITHOUT
   * the `_auth` block. The signer hashes this exactly as
   * `JSON.stringify(body)`. The caller injects `_auth` into the body after
   * signing.
   */
  body: unknown;
  /**
   * Optional fixed timestamp (ms epoch). Default `Date.now()`. Override for
   * deterministic test vectors.
   */
  timestamp?: number;
}

export interface SignRequestOutput {
  /** Stringified ms-epoch timestamp included in the canonical string and `_auth.timestamp`. */
  timestamp: string;
  /** Base64url-encoded HMAC-SHA256 signature. Goes into `_auth.signature`. */
  signature: string;
  /** Lowercase hex SHA-256 body hash (intermediate value, surfaced for debugging/test). */
  bodyHash: string;
  /** The canonical string that was signed (intermediate value, surfaced for debugging/test). */
  canonical: string;
}

/**
 * Sign a request per the canonical algorithm. Returns the timestamp,
 * signature, and intermediate values. The caller is responsible for
 * injecting `_auth` into the body and dispatching the request.
 */
export async function signRequest(input: SignRequestInput): Promise<SignRequestOutput> {
  const ts = String(input.timestamp ?? Date.now());
  const bodyHash = await computeBodyHash(input.body);
  const canonical = [ts, input.method, input.path, input.query, bodyHash].join('\n');
  const signature = await signCanonical(canonical, input.hmacSecret);
  return { timestamp: ts, signature, bodyHash, canonical };
}

/**
 * Construct the canonical path for a given endpoint slug.
 *   `"get-categories"` → `"/functions/v1/get-categories"`
 *
 * Accepts slugs with or without a leading slash.
 */
export function canonicalPathForSlug(slug: string): string {
  const cleaned = slug.startsWith('/') ? slug.slice(1) : slug;
  return `/functions/v1/${cleaned}`;
}
