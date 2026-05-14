/**
 * Generate `test-vectors/hmac.json` using the CANONICAL HMAC v4 algorithm.
 *
 * This script is the source-of-truth generator. It inlines the exact signing
 * logic from `_shared/hmac.ts` v4 (the deployed server-side validator) and
 * computes expected hashes/signatures for a curated set of fixtures.
 *
 * The vectors are then verified end-to-end by BOTH sides:
 *   - SDK side: `tests/hmac.test.ts` runs `src/transport/hmac.ts` against the
 *     fixtures and asserts byte-for-byte match.
 *   - EF side (separate, in the docs repo): a Deno script
 *     `docs/agent-tools/test-hmac-parity.ts` runs the deployed
 *     `_shared/hmac.ts` v4 against the same fixtures and asserts match.
 *
 * If both sides match the same vectors, both sides match each other.
 *
 * Run with: `node scripts/generate-test-vectors.mjs`
 *
 * Requires Node 19+ for `globalThis.crypto.subtle`. Output is deterministic;
 * re-running produces byte-identical output.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// --- Canonical signing algorithm (verbatim port from _shared/hmac.ts v4) ---
//
// Intentionally written independently from src/transport/hmac.ts to avoid a
// co-located bug: if the SDK port has a subtle algorithm error, this script
// must NOT replicate it. This script uses the canonical Deno-style helpers
// (btoa + String.fromCharCode for base64). The SDK port uses a manual
// base64 encoder. Different code paths producing the same expected output
// is the actual parity guarantee.

function toBase64Url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function computeBodyHash(body) {
  const text = JSON.stringify(body);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalizeQuery(searchParams) {
  return Array.from(searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

async function signCanonical(canonical, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(canonical));
  // Use btoa + String.fromCharCode (canonical Deno-side approach).
  return toBase64Url(btoa(String.fromCharCode(...new Uint8Array(sigBuf))));
}

// --- Fixture definitions ---

const HMAC_SECRET = 'test-hmac-secret-for-vector-generation-only-not-real';
const API_KEY = 'test-api-key-not-real';

// Fixed timestamps for deterministic output.
const T1 = 1715000000000; // May 6, 2024
const T2 = 1715000060000; // T1 + 60 seconds
const T3 = 1715000300000; // T1 + 5 minutes

const fixtures = [
  {
    name: 'empty-body-post',
    description: 'POST with empty body — read-only EFs (e.g., get-categories)',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T1,
    method: 'POST',
    slug: 'get-categories',
    query: {},
    body: {},
  },
  {
    name: 'simple-login-body',
    description: 'POST consumer-login with email + password',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T1,
    method: 'POST',
    slug: 'consumer-login',
    query: {},
    body: { email: 'test@example.com', password: 'hunter2' },
  },
  {
    name: 'nested-object-body',
    description: 'POST with nested object — notification-trigger style payload',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T1,
    method: 'POST',
    slug: 'notification-trigger',
    query: {},
    body: {
      trigger_type: 'beacon',
      venue_id: '550e8400-e29b-41d4-a716-446655440000',
      context: {
        beacon_uuid: 'fda50693-a4e2-4fb1-afcf-c6eb07647825',
        major: 1,
        minor: 42,
        rssi: -67,
      },
    },
  },
  {
    name: 'array-body',
    description: 'POST with array fields — visit-signals batch shape',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T2,
    method: 'POST',
    slug: 'visit-signals',
    query: {},
    body: {
      signal_type: 'arrival',
      venue_id: '550e8400-e29b-41d4-a716-446655440000',
      detected_beacons: ['fda50693-a4e2-4fb1-afcf-c6eb07647825', 'aabbccdd-1234-5678-90ab-cdef00112233'],
      timestamps_ms: [T1, T2],
    },
  },
  {
    name: 'null-fields-body',
    description: 'POST with explicit null fields (different from missing) — edge case for JSON.stringify',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T1,
    method: 'POST',
    slug: 'consumer-signup',
    query: {},
    body: {
      email: 'newuser@example.com',
      password: 'hunter2',
      display_name: null,
      referral_code: null,
    },
  },
  {
    name: 'iso-timestamp-body',
    description: 'POST with ISO-8601 timestamp string — common pattern for visit signals',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T2,
    method: 'POST',
    slug: 'visit-signals',
    query: {},
    body: {
      signal_type: 'served',
      venue_id: '550e8400-e29b-41d4-a716-446655440000',
      served_at: '2024-05-06T15:00:00.000Z',
    },
  },
  {
    name: 'discriminated-union-shape',
    description: 'POST with discriminated-union shape (signal_type=wait_register) — Phase 3 schema review pause point',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T2,
    method: 'POST',
    slug: 'visit-signals',
    query: {},
    body: {
      signal_type: 'wait_register',
      venue_id: '550e8400-e29b-41d4-a716-446655440000',
      registered_at: '2024-05-06T15:00:00.000Z',
      product_id: '11111111-2222-3333-4444-555555555555',
    },
  },
  {
    name: 'pos-current-visits-get-with-query',
    description: 'GET with query params — pos-current-visits style (uses API key auth, but useful for canonicalQuery testing)',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T1,
    method: 'GET',
    slug: 'pos-current-visits',
    query: { venue_id: '550e8400-e29b-41d4-a716-446655440000', limit: '50' },
    body: {},
  },
  {
    name: 'query-canonicalization-out-of-order',
    description: 'GET with query params provided out of alphabetical order — verifies canonicalQuery sort',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T1,
    method: 'GET',
    slug: 'pos-current-visits',
    query: { z_last: 'z', a_first: 'a', m_middle: 'm' },
    body: {},
  },
  {
    name: 'boundary-timestamp-5min',
    description: 'POST at exactly 5-minute timestamp boundary — verifies signing algorithm independent of skew check',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T3,
    method: 'POST',
    slug: 'auth-refresh',
    query: {},
    body: { refresh_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.test' },
  },
  {
    name: 'unicode-body',
    description: 'POST with non-ASCII characters in body — verifies UTF-8 encoding parity',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T1,
    method: 'POST',
    slug: 'consumer-signup',
    query: {},
    body: {
      email: 'unicode@example.com',
      password: 'hunter2',
      display_name: 'Müller François 日本語 🎉',
    },
  },
  {
    name: 'idempotency-context-uuid-body',
    description: 'POST with UUID-shaped fields (mimics idempotency-keyed flows like pos-close)',
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
    timestamp: T2,
    method: 'POST',
    slug: 'pos-close',
    query: {},
    body: {
      visit_id: '550e8400-e29b-41d4-a716-446655440000',
      closed_at: '2024-05-06T15:05:00.000Z',
      total_cents: 4999,
      items: [
        { product_id: '11111111-2222-3333-4444-555555555555', qty: 2, price_cents: 1500 },
        { product_id: '66666666-7777-8888-9999-aaaaaaaaaaaa', qty: 1, price_cents: 1999 },
      ],
    },
  },
];

async function buildFixture(input) {
  const canonicalPath = `/functions/v1/${input.slug}`;
  const canonicalQuery = canonicalizeQuery(new URLSearchParams(input.query));
  const expectedBodyHash = await computeBodyHash(input.body);
  const expectedCanonical = [
    String(input.timestamp),
    input.method,
    canonicalPath,
    canonicalQuery,
    expectedBodyHash,
  ].join('\n');
  const expectedSignature = await signCanonical(expectedCanonical, input.hmacSecret);
  return {
    ...input,
    canonicalPath,
    canonicalQuery,
    expectedBodyHash,
    expectedCanonical,
    expectedSignature,
  };
}

async function main() {
  const outputs = [];
  for (const fixture of fixtures) {
    outputs.push(await buildFixture(fixture));
  }

  const outputData = {
    description:
      'HMAC test vectors — generated by scripts/generate-test-vectors.mjs using the canonical HMAC v4 algorithm from _shared/hmac.ts v4. The SDK-side src/transport/hmac.ts must produce byte-for-byte identical output for each fixture.',
    algorithm: {
      bodyHash: 'SHA-256(JSON.stringify(body)) → lowercase hex',
      canonicalPath: '/functions/v1 + endpoint slug',
      canonicalQuery: 'searchParams sorted alphabetically by key, &-joined',
      canonical: '[timestamp, method, canonicalPath, canonicalQuery, bodyHash].join("\\n")',
      signature: 'HMAC-SHA256(canonical, hmacSecret) → base64 → base64url',
    },
    fixtureCount: outputs.length,
    fixtures: outputs,
  };

  const json = JSON.stringify(outputData, null, 2) + '\n';
  const outputPath = resolve(repoRoot, 'test-vectors', 'hmac.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, json, 'utf8');

  console.log(`Wrote ${outputs.length} fixtures to test-vectors/hmac.json`);
}

await main();
