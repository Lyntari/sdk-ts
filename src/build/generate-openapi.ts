/**
 * OpenAPI 3.1 generator — emits `openapi.yaml` at the SDK repo root.
 *
 * Walks the canonical `efRegistry` (single source-of-truth for all 30 EFs)
 * and emits one OpenAPI path per entry, with request body / query / response
 * schemas wired from the same Zod definitions the SDK methods + EF runtime
 * validation use.
 *
 * Drift between SDK schemas and the committed `openapi.yaml` is structurally
 * impossible — re-running this script regenerates the YAML from the schemas.
 * The CI gate (`openapi-drift.yml`, separate file) runs the script then
 * `git diff --exit-code openapi.yaml` so a PR that changes a schema without
 * regenerating fails before merge.
 *
 * Run: `npm run generate:openapi`
 *
 * Notes on Zod → OpenAPI mapping:
 *  - Schemas are registered as named components (not inlined) so the emitted
 *    YAML stays compact and partners can `$ref` shared shapes.
 *  - `z.unknown()` becomes `{}` — open-shape passthrough, intentional for
 *    response bodies the EF passes through verbatim from RPC output.
 *  - `passthrough()` Zod objects map to `additionalProperties: true`.
 *  - Discriminated unions (`notification-trigger` response) emit OpenAPI
 *    `oneOf` with a discriminator hint.
 *  - The `_auth` block is NOT included in published request schemas — it's
 *    a transport-injected detail. OpenAPI documents the SDK boundary, not
 *    the on-the-wire body.
 *
 * Security schemes:
 *  - `HmacBody` — apiKey + timestamp + HMAC signature in `_auth` body field.
 *    Documented; not natively modeled by OpenAPI's `securitySchemes` (which
 *    assumes header/query/cookie). Partners using the SDK don't see this;
 *    partners hand-implementing follow the README's auth-model section.
 *  - `HmacJwtBody` — `HmacBody` + JWT in `_auth.token`.
 *  - `ApiKeyHeader` — `apikey` (and aliased `x-api-key`) HTTP header. Used
 *    by GET-with-API-key endpoints.
 *  - `ApiKeyBody` — apiKey in `_auth.apiKey` body field, no signature.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import { stringify as yamlStringify } from 'yaml';
import { z } from 'zod';

import {
  efRegistry,
  type EfRegistryEntry,
  type EfAuthMode,
  ErrorEnvelopeSchema,
  PaginationParamsSchema,
  // Auth response schemas
  ConsumerLoginResponseSchema,
  ConsumerSignupResponseSchema,
  AuthRefreshResponseSchema,
  AuthLogoutResponseSchema,
  ResetPasswordResponseSchema,
  DeleteAccountResponseSchema,
  // Auth request schemas
  ConsumerLoginRequestSchema,
  ConsumerSignupRequestSchema,
  AuthRefreshRequestSchema,
  AuthLogoutRequestSchema,
  ResetPasswordRequestSchema,
  DeleteAccountRequestSchema,
  // Visits
  VisitSignalsRequestSchema,
  VisitSignalsResponseSchema,
  PosCloseRequestSchema,
  PosCloseResponseSchema,
  PosCurrentVisitsResponseSchema,
  CongestionHistoryRequestSchema,
  CongestionHistoryResponseSchema,
  // Location
  NearbyVenuesRequestSchema,
  NearbyVenuesResponseSchema,
  LocationUpdateRequestSchema,
  LocationUpdateResponseSchema,
  BeaconDetectionRequestSchema,
  BeaconDetectionResponseSchema,
  BeaconConfigResponseSchema,
  // Notifications
  SaveSubscriptionRequestSchema,
  SaveSubscriptionResponseSchema,
  GetSubscriptionIdResponseSchema,
  SaveCategoryPreferencesRequestSchema,
  SaveCategoryPreferencesResponseSchema,
  GetCategoryPreferencesResponseSchema,
  GetNotificationPreferencesResponseSchema,
  UpdateNotificationPreferencesRequestSchema,
  UpdateNotificationPreferencesResponseSchema,
  NotificationTriggerRequestSchema,
  NotificationTriggerResponseSchema,
  NotificationEventRequestSchema,
  NotificationEventResponseSchema,
  // Reads
  CongestionStatusRequestSchema,
  CongestionStatusResponseSchema,
  StadiumZonesRequestSchema,
  StadiumZonesResponseSchema,
  StadiumGeofencesResponseSchema,
  WaitboardResponseSchema,
  GetProfileResponseSchema,
  GetVisitHistoryResponseSchema,
  GetNotificationHistoryResponseSchema,
  GetCategoriesResponseSchema,
} from '../schemas/index.js';

extendZodWithOpenApi(z);

// === Output path ============================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'openapi.yaml');

// === Auth mode → security scheme ===========================================

const SECURITY_SCHEME_NAME: Record<EfAuthMode, string> = {
  hmac: 'HmacBody',
  'hmac+jwt': 'HmacJwtBody',
  'api-key-get': 'ApiKeyHeader',
  'api-key-post': 'ApiKeyBody',
};

// === Build ==================================================================

function build(): void {
  const registry = new OpenAPIRegistry();

  // zod-to-openapi v7's `register()` returns a NEW schema instance with
  // metadata attached (the original schema is unchanged). For paths to emit
  // `$ref` instead of inlining, they must reference the RETURNED instance.
  // We keep a map keyed by the original schema → registered version so the
  // path-emit step can look up the metadata-bearing variant.
  const registered = new Map<z.ZodTypeAny, z.ZodTypeAny>();
  const reg = <T extends z.ZodTypeAny>(name: string, schema: T): T => {
    const result = registry.register(name, schema) as unknown as T;
    registered.set(schema, result);
    return result;
  };

  /** Lookup helper for path emit — falls back to the original if unregistered. */
  const refOrInline = (schema: z.ZodTypeAny): z.ZodTypeAny =>
    registered.get(schema) ?? schema;

  // --- Shared components ---------------------------------------------------

  reg('ErrorEnvelope', ErrorEnvelopeSchema);
  reg('PaginationParams', PaginationParamsSchema);

  // `AuthBlockSchema` (the `_auth` body field — `src/schemas/_common.ts`) is
  // transport-injected; not exposed on any path's request body. `AccessToken-
  // PairSchema` (also `_common.ts`) is a doc-only base that `ConsumerLogin-
  // Response` / `ConsumerSignupResponse` / `AuthRefreshResponse` happen to
  // share — the response schemas already inline the same shape. Both are
  // deliberately NOT registered as components (would emit unused-component
  // lint warnings) and not imported here.

  // --- Per-EF request + response components -------------------------------

  // Request schemas
  reg('ConsumerLoginRequest', ConsumerLoginRequestSchema);
  reg('ConsumerSignupRequest', ConsumerSignupRequestSchema);
  reg('AuthRefreshRequest', AuthRefreshRequestSchema);
  reg('AuthLogoutRequest', AuthLogoutRequestSchema);
  reg('ResetPasswordRequest', ResetPasswordRequestSchema);
  reg('DeleteAccountRequest', DeleteAccountRequestSchema);

  reg('VisitSignalsRequest', VisitSignalsRequestSchema);
  reg('PosCloseRequest', PosCloseRequestSchema);
  reg('CongestionHistoryRequest', CongestionHistoryRequestSchema);

  reg('NearbyVenuesRequest', NearbyVenuesRequestSchema);
  reg('LocationUpdateRequest', LocationUpdateRequestSchema);
  reg('BeaconDetectionRequest', BeaconDetectionRequestSchema);

  reg('SaveSubscriptionRequest', SaveSubscriptionRequestSchema);
  reg('SaveCategoryPreferencesRequest', SaveCategoryPreferencesRequestSchema);
  reg('UpdateNotificationPreferencesRequest', UpdateNotificationPreferencesRequestSchema);
  reg('NotificationTriggerRequest', NotificationTriggerRequestSchema);
  reg('NotificationEventRequest', NotificationEventRequestSchema);

  reg('CongestionStatusRequest', CongestionStatusRequestSchema);
  reg('StadiumZonesRequest', StadiumZonesRequestSchema);

  // Response schemas
  reg('ConsumerLoginResponse', ConsumerLoginResponseSchema);
  reg('ConsumerSignupResponse', ConsumerSignupResponseSchema);
  reg('AuthRefreshResponse', AuthRefreshResponseSchema);
  reg('AuthLogoutResponse', AuthLogoutResponseSchema);
  reg('ResetPasswordResponse', ResetPasswordResponseSchema);
  reg('DeleteAccountResponse', DeleteAccountResponseSchema);

  reg('VisitSignalsResponse', VisitSignalsResponseSchema);
  reg('PosCloseResponse', PosCloseResponseSchema);
  reg('PosCurrentVisitsResponse', PosCurrentVisitsResponseSchema);
  reg('CongestionHistoryResponse', CongestionHistoryResponseSchema);

  reg('NearbyVenuesResponse', NearbyVenuesResponseSchema);
  reg('LocationUpdateResponse', LocationUpdateResponseSchema);
  reg('BeaconDetectionResponse', BeaconDetectionResponseSchema);
  reg('BeaconConfigResponse', BeaconConfigResponseSchema);

  reg('SaveSubscriptionResponse', SaveSubscriptionResponseSchema);
  reg('GetSubscriptionIdResponse', GetSubscriptionIdResponseSchema);
  reg('SaveCategoryPreferencesResponse', SaveCategoryPreferencesResponseSchema);
  reg('GetCategoryPreferencesResponse', GetCategoryPreferencesResponseSchema);
  reg('GetNotificationPreferencesResponse', GetNotificationPreferencesResponseSchema);
  reg('UpdateNotificationPreferencesResponse', UpdateNotificationPreferencesResponseSchema);
  reg('NotificationTriggerResponse', NotificationTriggerResponseSchema);
  reg('NotificationEventResponse', NotificationEventResponseSchema);

  reg('CongestionStatusResponse', CongestionStatusResponseSchema);
  reg('StadiumZonesResponse', StadiumZonesResponseSchema);
  reg('StadiumGeofencesResponse', StadiumGeofencesResponseSchema);
  reg('WaitboardResponse', WaitboardResponseSchema);
  reg('GetProfileResponse', GetProfileResponseSchema);
  reg('GetVisitHistoryResponse', GetVisitHistoryResponseSchema);
  reg('GetNotificationHistoryResponse', GetNotificationHistoryResponseSchema);
  reg('GetCategoriesResponse', GetCategoriesResponseSchema);

  // --- Security schemes ----------------------------------------------------

  // OpenAPI's `securitySchemes` natively models header / query / cookie auth,
  // but Lyntari uses body-located auth for HMAC + JWT. The schemes below use
  // `apiKey` type with `in: header` as the OpenAPI primitive; the actual
  // location (body field) is documented in `description` so partners reading
  // the spec know to follow the README's auth-model section.

  registry.registerComponent('securitySchemes', 'HmacBody', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Lyntari-Auth (body-located, see description)',
    description:
      'HMAC-signed POST. Auth lives in the request body as `_auth: { apiKey, timestamp, signature }`. ' +
      'The signature is `HMAC-SHA256(canonical_string, hmacSecret)` over `timestamp\\nmethod\\npath\\nquery\\nbodyHash` ' +
      'with the body hash computed AFTER `_auth` is removed. The SDK transport (`postWithHMAC`) injects `_auth` ' +
      'automatically; partners hand-rolling the protocol should follow the README "Auth model" section.',
  });

  registry.registerComponent('securitySchemes', 'HmacJwtBody', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Lyntari-Auth-JWT (body-located, see description)',
    description:
      'Same as `HmacBody` plus a JWT access token in `_auth.token`. Used by user-facing methods that ' +
      'require an authenticated identity. The JWT is issued by `consumer-login`, `consumer-signup`, or ' +
      '`auth-refresh`; clients persist it and pass it via `client.setAccessToken(token)` in the SDK.',
  });

  registry.registerComponent('securitySchemes', 'ApiKeyHeader', {
    type: 'apiKey',
    in: 'header',
    name: 'apikey',
    description:
      'API key in the `apikey` header (also accepted as `x-api-key`). Used by read-only GET endpoints. ' +
      'For `pos-current-visits`, the API key is the venue-bound POS credential (NOT the consumer apiKey).',
  });

  registry.registerComponent('securitySchemes', 'ApiKeyBody', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Lyntari-ApiKey-Body (body-located, see description)',
    description:
      'API key in `_auth.apiKey` body field, no HMAC signature. Used by `congestion-history` ' +
      '(admin/analytics endpoint).',
  });

  // --- Paths ---------------------------------------------------------------

  for (const entry of efRegistry) {
    registerPath(registry, entry, refOrInline);
  }

  // --- Generate document ---------------------------------------------------

  const generator = new OpenApiGeneratorV31(registry.definitions);

  const document = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Lyntari API',
      version: '0.1.0',
      description:
        'Public API for the Lyntari real-time stadium concession wait-time platform. ' +
        '30 endpoints across auth, visits, location, notifications, and reads. ' +
        'Generated from the canonical Zod schemas in `@lyntari/sdk` v0.1; do not hand-edit.',
      license: { name: 'Proprietary', identifier: 'UNLICENSED' },
      contact: { name: 'Lyntari, Inc.', email: 'support@lyntari.com' },
    },
    servers: [
      {
        url: 'https://cylxaiizkxfpohcdgeui.supabase.co/functions/v1',
        description: 'Production',
      },
    ],
    tags: [
      { name: 'auth', description: 'Authentication, signup, password reset, account lifecycle.' },
      { name: 'visits', description: 'Visit signal emission, POS close, history, congestion.' },
      { name: 'location', description: 'Location updates, nearby venues, beacon detection/config.' },
      {
        name: 'notifications',
        description: 'OneSignal subscriptions, category/notification preferences, push trigger and events.',
      },
      { name: 'reads', description: 'Read-only endpoints for stadium, profile, history, categories.' },
    ],
  });

  // --- Serialize + write ---------------------------------------------------

  const yamlContent = yamlStringify(document, {
    aliasDuplicateObjects: false, // keep YAML readable; partners read this
    lineWidth: 100,
  });

  writeFileSync(
    OUTPUT_PATH,
    `# Lyntari API — OpenAPI 3.1 spec.\n` +
      `# Generated by src/build/generate-openapi.ts from src/schemas/*.\n` +
      `# DO NOT EDIT BY HAND. Run \`npm run generate:openapi\` to regenerate.\n` +
      `# A pre-commit hook (.githooks/pre-commit) auto-regenerates this file\n` +
      `# when staged changes touch src/schemas/ or src/build/generate-openapi.ts.\n` +
      `# CI also runs the generator on every push and fails on drift — see\n` +
      `# .github/workflows/openapi-drift.yml.\n\n` +
      yamlContent,
    'utf8',
  );

  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`  ${efRegistry.length} paths`);
  console.log(`  ${Object.keys(registry.definitions).length} component definitions`);
}

// === Per-path registration ==================================================

const TAGS_BY_DOMAIN: Array<{ slugs: string[]; tag: string }> = [
  {
    tag: 'auth',
    slugs: [
      'consumer-login',
      'consumer-signup',
      'auth-refresh',
      'auth-logout',
      'reset-password',
      'delete-account',
    ],
  },
  {
    tag: 'visits',
    slugs: ['visit-signals', 'pos-close', 'pos-current-visits', 'congestion-history'],
  },
  {
    tag: 'location',
    slugs: ['nearby-venues', 'location-update', 'beacon-detection', 'beacon-config'],
  },
  {
    tag: 'notifications',
    slugs: [
      'save-subscription',
      'get-subscription-id',
      'save-category-preferences',
      'get-category-preferences',
      'get-notification-preferences',
      'update-notification-preferences',
      'notification-trigger',
      'notification-event',
    ],
  },
  {
    tag: 'reads',
    slugs: [
      'congestion-status',
      'stadium-zones',
      'stadium-geofences',
      'waitboard',
      'get-profile',
      'get-visit-history',
      'get-notification-history',
      'get-categories',
    ],
  },
];

function tagFor(slug: string): string {
  for (const { tag, slugs } of TAGS_BY_DOMAIN) {
    if (slugs.includes(slug)) return tag;
  }
  return 'misc';
}

function registerPath(
  registry: OpenAPIRegistry,
  entry: EfRegistryEntry,
  refOrInline: (schema: z.ZodTypeAny) => z.ZodTypeAny,
): void {
  const securityScheme = SECURITY_SCHEME_NAME[entry.auth];
  const errorRef = { $ref: '#/components/schemas/ErrorEnvelope' };

  // Strip `/functions/v1` prefix — the `servers` field carries it.
  const openApiPath = entry.path.replace(/^\/functions\/v1/, '');

  const responses: Record<string, {
    description: string;
    content: { 'application/json': { schema: z.ZodTypeAny | { $ref: string } } };
  }> = {
    200: {
      description: 'Success.',
      content: {
        'application/json': { schema: refOrInline(entry.responseSchema) },
      },
    },
    400: {
      description:
        'Validation failed — body did not match the request schema. ' +
        '`error.code` is `validation_failed` with `details: { field, issues }`.',
      content: { 'application/json': { schema: errorRef } },
    },
    401: {
      description:
        'Authentication failed — bad signature, expired/invalid JWT, missing API key, etc.',
      content: { 'application/json': { schema: errorRef } },
    },
    500: {
      description: 'Server error.',
      content: { 'application/json': { schema: errorRef } },
    },
  };

  // Idempotent endpoints can return 409 idempotency_key_conflict.
  if (entry.idempotent) {
    responses[409] = {
      description:
        'Idempotency-Key conflict — same key was previously used with a different request body. ' +
        '`error.code` is `idempotency_key_conflict` with `details.existing_request_hash_prefix`.',
      content: { 'application/json': { schema: errorRef } },
    };
  }

  // Idempotent POSTs document the `Idempotency-Key` header explicitly so
  // partners hand-rolling the call know it's accepted. Type matches
  // openapi3-ts `ParameterObject` shape (zod-to-openapi accepts that).
  const parameters: Array<{
    name: string;
    in: 'header' | 'query' | 'path' | 'cookie';
    required?: boolean;
    description?: string;
    schema?: { type: 'string' | 'number' | 'integer' | 'boolean' };
  }> = [];

  if (entry.idempotent) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description:
        'Optional UUID. SDK transport auto-generates a fresh one per call; ' +
        'pass an explicit key to coordinate idempotency across multiple calls. ' +
        '24h server-side TTL.',
      schema: { type: 'string' },
    });
  }

  const requestBody =
    entry.method === 'POST'
      ? {
          required: true,
          content: {
            'application/json': { schema: refOrInline(entry.requestSchema) },
          },
        }
      : undefined;

  registry.registerPath({
    method: entry.method.toLowerCase() as 'get' | 'post',
    path: openApiPath,
    operationId: operationIdFor(entry.slug),
    summary: summaryFor(entry),
    description: descriptionFor(entry),
    tags: [tagFor(entry.slug)],
    security: [{ [securityScheme]: [] }],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { request: { body: requestBody } } : {}),
    responses,
  });
}

function summaryFor(entry: EfRegistryEntry): string {
  return `${entry.method} ${entry.slug}`;
}

/**
 * Convert an EF slug (`consumer-login`, `get-profile`) to a camelCase
 * operationId (`consumerLogin`, `getProfile`) — standard OpenAPI convention
 * and what generators (`openapi-generator`, etc.) consume to name methods
 * in client libraries.
 */
function operationIdFor(slug: string): string {
  return slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function descriptionFor(entry: EfRegistryEntry): string {
  const parts: string[] = [];
  parts.push(`Auth: \`${entry.auth}\`.`);
  if (entry.idempotent) {
    parts.push(`Idempotency-Key honored (24h TTL).`);
  }
  if (entry.auth === 'hmac' || entry.auth === 'hmac+jwt') {
    parts.push(
      `Body is signed via HMAC-SHA256 over the canonical string \`timestamp\\nmethod\\npath\\nquery\\nbodyHash\` ` +
        `with the signature in \`_auth.signature\`. The SDK transport injects \`_auth\` automatically.`,
    );
  }
  return parts.join(' ');
}

build();
