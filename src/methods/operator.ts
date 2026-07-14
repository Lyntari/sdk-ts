/**
 * Operator server-to-server SDK methods (cluster #89, §36.2; extended by
 * clusters #83/#84 coverage reads and #85 venue onboarding + ingestion).
 *
 *   - `manageApiKeys` → `manage-api-keys` EF (HMAC + operator JWT) — issue /
 *     rotate / revoke the org's own partner API keys. The raw key is returned
 *     once on issue/rotate.
 *   - `insights` / `recommendations` → `operator-insights` /
 *     `operator-recommendations` EFs — read the org's persona-packaged insights
 *     and staffing recommendations, authenticated by a per-partner API key (not
 *     the consumer HMAC key). The key is bound to one org server-side.
 *
 * The two read methods take the partner API key as their first argument — it is
 * a distinct credential from the client's consumer `apiKey`, issued via
 * `manageApiKeys({ action: 'issue' })`.
 */

import type {
  ManageApiKeyRequest,
  ManageApiKeyResponse,
  OperatorReadRequest,
  OperatorInsightsResponse,
  OperatorRecommendationsResponse,
  OperatorAuditLogRequest,
  OperatorAuditLogResponse,
  OperatorSensorCoverageRequest,
  OperatorSensorCoverageResponse,
  OperatorExternalFeedCoverageRequest,
  OperatorExternalFeedCoverageResponse,
  OperatorWhatIfRequest,
  OperatorWhatIfResponse,
  PosConnectRequest,
  PosConnectResponse,
  OperatorOnboardRequest,
  OperatorOnboardResponse,
} from '../schemas/index.js';
import { postWithHMAC } from '../transport/post.js';
import { postWithApiKey } from '../transport/postApiKey.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface OperatorMethods {
  /**
   * `manage-api-keys` — issue / rotate / revoke this org's partner API keys.
   * HMAC + operator JWT (the org is the JWT `sub`). `issue` and `rotate` return
   * `{ key }` with the raw `api_key` exactly once; `revoke` returns `{ revoked }`.
   */
  manageApiKeys(input: ManageApiKeyRequest): Promise<ManageApiKeyResponse>;

  /**
   * `operator-insights` — the org's persona-packaged insights. Authenticated by
   * a partner API key (first arg). A `target_org` that isn't the key's own org
   * is rejected with `org_access_denied`.
   */
  insights(partnerApiKey: string, input?: OperatorReadRequest): Promise<OperatorInsightsResponse>;

  /**
   * `operator-recommendations` — the org's staffing recommendations.
   * Authenticated by a partner API key (first arg).
   */
  recommendations(partnerApiKey: string, input?: OperatorReadRequest): Promise<OperatorRecommendationsResponse>;

  /**
   * `operator-audit-log` — the org's immutable security-event audit log (SOC 2
   * evidence): auth, access, config, DSR, api-key, and isolation events, each
   * org-attributed and tamper-evident. Authenticated by a partner API key (first
   * arg); a `target_org` that isn't the key's own org is rejected.
   */
  auditLog(partnerApiKey: string, input?: OperatorAuditLogRequest): Promise<OperatorAuditLogResponse>;

  /**
   * `operator-sensor-coverage` — the org's whole-crowd sensor coverage: which
   * sources (ticket-scan / turnstile / access-control / WiFi-probe / app-signal)
   * cover which zones, their coverage confidence, and each source's freshness
   * (`last_reading_at` + `is_stale`). Authenticated by a partner API key (first
   * arg); a `target_org` that isn't the key's own org is rejected.
   */
  sensorCoverage(partnerApiKey: string, input?: OperatorSensorCoverageRequest): Promise<OperatorSensorCoverageResponse>;

  /**
   * `operator-external-feed-coverage` — the org's Tier-2 external-detector feed
   * coverage: which feeds (screening / acoustic / drone / fire / medical /
   * camera-CV) cover which zones, their coverage confidence, and each feed's
   * freshness (`last_signal_at` + `is_stale`). Authenticated by a partner API key
   * (first arg); a `target_org` that isn't the key's own org is rejected.
   */
  externalFeedCoverage(partnerApiKey: string, input?: OperatorExternalFeedCoverageRequest): Promise<OperatorExternalFeedCoverageResponse>;

  /**
   * `operator-what-if` — a bounded, guarded scenario projection for a venue.
   * The caller supplies a small parameter set (`attendance`, `closed_zones`,
   * `event_phase`, `service_rate_multiplier`) and gets back projected wait /
   * congestion tier / staffing need. NOT a live simulation — the server answers
   * from a deterministic surrogate, and out-of-range parameters are rejected.
   * Authenticated by a partner API key (first arg); a `target_org` that isn't
   * the key's own org is rejected. Rate-limited server-side.
   */
  whatIf(partnerApiKey: string, input: OperatorWhatIfRequest): Promise<OperatorWhatIfResponse>;

  /**
   * `pos-connect` — begin POS onboarding for a venue. Returns the aggregator's
   * hosted connect-widget (iFrame) URL; the venue admin opens it and authorizes
   * their POS inside the aggregator (which owns the OAuth + raw credentials).
   * Normalized order events then flow to Lyntari's ingest. Authenticated by a
   * partner API key (first arg); a `target_org` that isn't the key's own org is
   * rejected.
   */
  connectPos(partnerApiKey: string, input: PosConnectRequest): Promise<PosConnectResponse>;

  /**
   * `operator-onboard` — per-venue onboarding config CRUD (action-dispatched):
   * `venue_config` reads the venue's current onboarding config; the register /
   * submit actions configure sensor sources, external feeds, and declarative
   * ingest mappings. Provisioning a NEW org is deliberately not here (that is an
   * internal/admin operation). Authenticated by a partner API key (first arg);
   * a `target_org` that isn't the key's own org is rejected.
   *
   * The convenience wrappers below (`venueConfig`, `registerSensorSource`,
   * `registerExternalSource`, `submitIngestMapping`) call this with the right
   * `action`.
   */
  onboard(partnerApiKey: string, input: OperatorOnboardRequest): Promise<OperatorOnboardResponse>;

  /** `operator-onboard` (`venue_config`) — read a venue's onboarding config (sensors, feeds, POS connection, mappings, status). */
  venueConfig(partnerApiKey: string, input: { venue_id: string; target_org?: string }): Promise<OperatorOnboardResponse>;

  /** `operator-onboard` (`register_sensor_source`) — register a whole-crowd sensor source for a venue. */
  registerSensorSource(
    partnerApiKey: string,
    input: Extract<OperatorOnboardRequest, { action: 'register_sensor_source' }> extends infer T
      ? Omit<T & { action: 'register_sensor_source' }, 'action'>
      : never,
  ): Promise<OperatorOnboardResponse>;

  /** `operator-onboard` (`register_external_source`) — register a Tier-2 external feed for a venue. */
  registerExternalSource(
    partnerApiKey: string,
    input: Omit<Extract<OperatorOnboardRequest, { action: 'register_external_source' }>, 'action'>,
  ): Promise<OperatorOnboardResponse>;

  /** `operator-onboard` (`submit_mapping`) — submit a declarative raw-export → canonical-stream ingest mapping. */
  submitIngestMapping(
    partnerApiKey: string,
    input: Omit<Extract<OperatorOnboardRequest, { action: 'submit_mapping' }>, 'action'>,
  ): Promise<OperatorOnboardResponse>;
}

export function createOperatorMethods(
  config: ClientConfig,
  state: ClientState,
): OperatorMethods {
  return {
    manageApiKeys: async (input) =>
      postWithHMAC<ManageApiKeyResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'manage-api-keys',
        body: input,
        ...jwtCallOpts(state, 'manage-api-keys'),
        idempotencyKey: null,
      }),

    insights: async (partnerApiKey, input = {}) =>
      postWithApiKey<OperatorInsightsResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-insights',
        apiKey: partnerApiKey,
        body: input,
      }),

    recommendations: async (partnerApiKey, input = {}) =>
      postWithApiKey<OperatorRecommendationsResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-recommendations',
        apiKey: partnerApiKey,
        body: input,
      }),

    auditLog: async (partnerApiKey, input = {}) =>
      postWithApiKey<OperatorAuditLogResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-audit-log',
        apiKey: partnerApiKey,
        body: input,
      }),

    sensorCoverage: async (partnerApiKey, input = {}) =>
      postWithApiKey<OperatorSensorCoverageResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-sensor-coverage',
        apiKey: partnerApiKey,
        body: input,
      }),

    externalFeedCoverage: async (partnerApiKey, input = {}) =>
      postWithApiKey<OperatorExternalFeedCoverageResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-external-feed-coverage',
        apiKey: partnerApiKey,
        body: input,
      }),

    whatIf: async (partnerApiKey, input) =>
      postWithApiKey<OperatorWhatIfResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-what-if',
        apiKey: partnerApiKey,
        body: input,
      }),

    connectPos: async (partnerApiKey, input) =>
      postWithApiKey<PosConnectResponse>({
        baseUrl: config.baseUrl,
        slug: 'pos-connect',
        apiKey: partnerApiKey,
        body: input,
      }),

    onboard: async (partnerApiKey, input) =>
      postWithApiKey<OperatorOnboardResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-onboard',
        apiKey: partnerApiKey,
        body: input,
      }),

    venueConfig: async (partnerApiKey, input) =>
      postWithApiKey<OperatorOnboardResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-onboard',
        apiKey: partnerApiKey,
        body: { action: 'venue_config', ...input },
      }),

    registerSensorSource: async (partnerApiKey, input) =>
      postWithApiKey<OperatorOnboardResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-onboard',
        apiKey: partnerApiKey,
        body: { action: 'register_sensor_source', ...input },
      }),

    registerExternalSource: async (partnerApiKey, input) =>
      postWithApiKey<OperatorOnboardResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-onboard',
        apiKey: partnerApiKey,
        body: { action: 'register_external_source', ...input },
      }),

    submitIngestMapping: async (partnerApiKey, input) =>
      postWithApiKey<OperatorOnboardResponse>({
        baseUrl: config.baseUrl,
        slug: 'operator-onboard',
        apiKey: partnerApiKey,
        body: { action: 'submit_mapping', ...input },
      }),
  };
}
