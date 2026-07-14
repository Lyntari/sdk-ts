/**
 * Operator server-to-server surface (cluster #89, §36.2; extended by clusters
 * #83/#84 coverage reads and #85 venue onboarding + ingestion).
 *
 *   - `operator-insights` / `operator-recommendations` (POST, per-partner API key
 *     in `_auth.apiKey`) — read the caller org's persona-packaged insights /
 *     staffing recommendations. The key is bound to one org server-side; passing
 *     a `target_org` for a different org is rejected (`org_access_denied`).
 *   - `manage-api-keys` (POST, HMAC + operator JWT) — issue / rotate / revoke the
 *     org's own partner API keys. The raw key is returned exactly once at
 *     issue/rotate and is not retrievable again.
 *
 * These describe the wire contract only — no internal model, scoring, or feature
 * detail crosses this boundary (the insight/recommendation shapes are the
 * operator-decision fields, not the ML columns that produced them).
 */

import { z } from 'zod';

// === api-key management (operator JWT) ====================================

export const IssuedApiKeySchema = z.object({
  /** Opaque key id (safe to store / reference). */
  id: z.string(),
  /** The raw API key — returned ONCE at issue/rotate, never retrievable again. */
  api_key: z.string(),
  /** Non-secret display prefix. */
  key_prefix: z.string(),
  org_id: z.string(),
  scopes: z.array(z.string()),
});

export const ManageApiKeyRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('issue'),
    label: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    expires_at: z.string().datetime().optional(),
  }),
  z.object({ action: z.literal('rotate'), key_id: z.string() }),
  z.object({ action: z.literal('revoke'), key_id: z.string() }),
]);

/** issue/rotate return `{ key }`; revoke returns `{ revoked }`. */
export const ManageApiKeyResponseSchema = z.object({
  key: IssuedApiKeySchema.optional(),
  revoked: z.boolean().optional(),
});

// === operator reads (partner API key) =====================================

export const OperatorReadRequestSchema = z.object({
  /** Optional; must equal the key's own org — a different org is rejected. */
  target_org: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const OperatorInsightSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  urgency: z.string().nullable(),
  confidence: z.number().nullable(),
  venue_id: z.string().nullable(),
  venue_name: z.string().nullable(),
  valid_until: z.string().nullable(),
  lifecycle_state: z.string().nullable(),
  created_at: z.string().nullable(),
});

export const OperatorInsightsResponseSchema = z.object({
  insights: z.array(OperatorInsightSchema),
  org_id: z.string(),
});

export const OperatorRecommendationSchema = z.object({
  recommendation_id: z.string(),
  venue_id: z.string().nullable(),
  venue_name: z.string().nullable(),
  from_zone_name: z.string().nullable(),
  to_zone_name: z.string().nullable(),
  role_type: z.string().nullable(),
  staff_count_to_move: z.number().nullable(),
  confidence: z.number().nullable(),
  urgency: z.string().nullable(),
  valid_until: z.string().nullable(),
  status: z.string().nullable(),
  created_at: z.string().nullable(),
});

export const OperatorRecommendationsResponseSchema = z.object({
  recommendations: z.array(OperatorRecommendationSchema),
  org_id: z.string(),
});

// === audit log (partner API key; cluster #80, §4.7) =======================

export const OperatorAuditLogRequestSchema = z.object({
  /** Optional; must equal the key's own org — a different org is rejected. */
  target_org: z.string().uuid().optional(),
  /** Filter by category: `auth` | `access` | `config` | `dsr` | `api_key` | `isolation`. */
  category: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const OperatorAuditEventSchema = z.object({
  id: z.number(),
  occurred_at: z.string(),
  actor_type: z.string().nullable(),
  actor_id: z.string().nullable(),
  event_category: z.string(),
  event_type: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  outcome: z.string(),
  request_id: z.string().nullable(),
  /** Event-specific structured detail (opaque; shape depends on `event_type`). */
  detail: z.unknown(),
});

export const OperatorAuditLogResponseSchema = z.object({
  events: z.array(OperatorAuditEventSchema),
  org_id: z.string(),
});

// === sensor coverage (partner API key; cluster #83, §4.10) ================

export const OperatorSensorCoverageRequestSchema = z.object({
  /** Optional; must equal the key's own org — a different org is rejected. */
  target_org: z.string().uuid().optional(),
});

export const OperatorSensorSourceSchema = z.object({
  /** `ticket_scan` | `turnstile` | `access_control` | `wifi_probe` | `app_signal`. */
  source_type: z.string(),
  venue_id: z.string().nullable(),
  /** Zone this source covers; null for a venue-wide source. */
  zone_id: z.string().nullable(),
  active: z.boolean(),
  coverage_confidence: z.number().nullable(),
  label: z.string().nullable(),
  /** ISO timestamp of the freshest reading for this source, or null if none yet. */
  last_reading_at: z.string().nullable(),
  /** True when no reading has landed within the freshness window (or ever). */
  is_stale: z.boolean(),
});

export const OperatorSensorCoverageResponseSchema = z.object({
  coverage: z.array(OperatorSensorSourceSchema),
  org_id: z.string(),
});

// === external-feed coverage (partner API key; cluster #84, §4.11) ==========

export const OperatorExternalFeedCoverageRequestSchema = z.object({
  /** Optional; must equal the key's own org — a different org is rejected. */
  target_org: z.string().uuid().optional(),
});

export const OperatorExternalFeedSchema = z.object({
  /** `screening` | `acoustic` | `drone` | `fire` | `medical` | `camera_cv`. */
  feed_type: z.string(),
  venue_id: z.string().nullable(),
  /** Zone this feed covers; null for a venue-wide feed. */
  zone_id: z.string().nullable(),
  active: z.boolean(),
  coverage_confidence: z.number().nullable(),
  label: z.string().nullable(),
  /** ISO timestamp of the freshest signal from this feed, or null if none yet. */
  last_signal_at: z.string().nullable(),
  /** True when no signal has landed within the freshness window (or ever). */
  is_stale: z.boolean(),
});

export const OperatorExternalFeedCoverageResponseSchema = z.object({
  coverage: z.array(OperatorExternalFeedSchema),
  org_id: z.string(),
});

// === what-if projection (partner API key; cluster #85, §4.12 / §21.2) ======
//
// A bounded, guarded query surface — the operator asks a small parameter set
// (attendance / closed zones / event phase / relative service rate) and gets a
// projected wait / congestion / staffing picture. It is NOT a live simulation
// run: the server answers from a deterministic surrogate. The bounds + auth +
// rate-limit are the model-extraction defense, so a caller cannot sweep the
// surface to reconstruct the underlying model.

export const OperatorWhatIfRequestSchema = z.object({
  /** Optional; must equal the key's own org — a different org is rejected. */
  target_org: z.string().uuid().optional(),
  /** Venue the scenario is projected for. */
  venue_id: z.string().uuid(),
  scenario: z.object({
    /** Projected attendance. Server-bounded; out-of-range is rejected. */
    attendance: z.number().int().min(0),
    /** How many zones are closed in the scenario (default 0). Server-bounded. */
    closed_zones: z.number().int().min(0).optional(),
    /** Event phase the scenario models. */
    event_phase: z
      .enum(['pregame', 'ingress', 'active', 'halftime', 'egress', 'postgame'])
      .optional(),
    /** Relative service-rate multiplier (1 = as-configured). Server-bounded. */
    service_rate_multiplier: z.number().positive().optional(),
  }),
});

export const OperatorWhatIfResponseSchema = z.object({
  /** How the projection was produced (an opaque, server-chosen basis label). */
  basis: z.string(),
  venue_id: z.string(),
  /** Echo of the (validated) scenario the projection was computed for. */
  scenario: z.object({
    attendance: z.number(),
    closed_zones: z.number(),
    event_phase: z.string(),
    service_rate_multiplier: z.number(),
  }),
  projection: z.object({
    projected_wait_minutes: z.number(),
    projected_congestion_tier: z.number().int(),
    projected_staffing_need: z.number().int(),
    /** Scenario-vs-reference load ratio (a projection output, not a threshold). */
    load_factor: z.number(),
  }),
});

// === POS connect (partner API key; cluster #85, §4.12, JC-1) ================
//
// Returns the aggregator's hosted connect-widget (iFrame) URL. The venue admin
// opens it and authorizes their POS *inside the aggregator* — the aggregator
// owns the OAuth handshake and the raw POS credentials; Lyntari only persists
// the resulting connection id. Normalized order events then arrive at the
// `pos-webhook` ingress. Aggregators: `omnivore`/`olo` (primary), `rutter`
// (fallback for Square/Clover-only venue mixes).

export const PosConnectRequestSchema = z.object({
  /** Optional; must equal the key's own org — a different org is rejected. */
  target_org: z.string().uuid().optional(),
  venue_id: z.string().uuid(),
  /** Which aggregator hosts the connect widget. */
  aggregator: z.enum(['omnivore', 'olo', 'rutter']),
});

export const PosConnectResponseSchema = z.object({
  /** Aggregator-hosted connect-widget URL the venue admin opens to authorize the POS. */
  connect_url: z.string(),
  aggregator: z.string(),
  /** Connection lifecycle state: `pending` until the venue completes the widget. */
  status: z.string(),
  /** Opaque id of the persisted connection row. */
  connection_row_id: z.string(),
});

// === operator onboarding config (partner API key; cluster #85, §4.12, JC-5) =
//
// A single action-dispatched surface for per-venue onboarding config CRUD:
// read the venue's onboarding config, register a sensor source or an external
// feed (which zones ↔ which sources), and submit a declarative ingest mapping
// (a raw-export → canonical-stream column map). Provisioning a brand-new org is
// deliberately NOT here — that is an internal/admin operation (`venue-provision`).

export const OperatorOnboardRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('venue_config'),
    target_org: z.string().uuid().optional(),
    venue_id: z.string().uuid(),
  }),
  z.object({
    action: z.literal('register_sensor_source'),
    target_org: z.string().uuid().optional(),
    venue_id: z.string().uuid(),
    source_type: z.enum(['ticket_scan', 'turnstile', 'access_control', 'wifi_probe']),
    zone_id: z.string().uuid().optional(),
    coverage_confidence: z.number().min(0).max(1).optional(),
    label: z.string().optional(),
  }),
  z.object({
    action: z.literal('register_external_source'),
    target_org: z.string().uuid().optional(),
    venue_id: z.string().uuid(),
    feed_type: z.string(),
    zone_id: z.string().uuid().optional(),
    coverage_confidence: z.number().min(0).max(1).optional(),
    label: z.string().optional(),
  }),
  z.object({
    action: z.literal('submit_mapping'),
    target_org: z.string().uuid().optional(),
    /** Null / omitted = an org-level default mapping (applies to all venues). */
    venue_id: z.string().uuid().optional(),
    source_format: z.string(),
    stream: z.string(),
    column_map: z.record(z.unknown()).optional(),
    transforms: z.record(z.unknown()).optional(),
    label: z.string().optional(),
  }),
]);

/** The onboarding surface echoes the action and returns the action-specific result payload. */
export const OperatorOnboardResponseSchema = z.object({
  action: z.string(),
  /** Action-specific payload (the venue config object, or the created row's ids). */
  result: z.unknown(),
});

export type IssuedApiKey = z.infer<typeof IssuedApiKeySchema>;
export type ManageApiKeyRequest = z.infer<typeof ManageApiKeyRequestSchema>;
export type ManageApiKeyResponse = z.infer<typeof ManageApiKeyResponseSchema>;
export type OperatorReadRequest = z.infer<typeof OperatorReadRequestSchema>;
export type OperatorInsight = z.infer<typeof OperatorInsightSchema>;
export type OperatorInsightsResponse = z.infer<typeof OperatorInsightsResponseSchema>;
export type OperatorRecommendation = z.infer<typeof OperatorRecommendationSchema>;
export type OperatorRecommendationsResponse = z.infer<typeof OperatorRecommendationsResponseSchema>;
export type OperatorAuditLogRequest = z.infer<typeof OperatorAuditLogRequestSchema>;
export type OperatorAuditEvent = z.infer<typeof OperatorAuditEventSchema>;
export type OperatorAuditLogResponse = z.infer<typeof OperatorAuditLogResponseSchema>;
export type OperatorSensorCoverageRequest = z.infer<typeof OperatorSensorCoverageRequestSchema>;
export type OperatorSensorSource = z.infer<typeof OperatorSensorSourceSchema>;
export type OperatorSensorCoverageResponse = z.infer<typeof OperatorSensorCoverageResponseSchema>;
export type OperatorExternalFeedCoverageRequest = z.infer<typeof OperatorExternalFeedCoverageRequestSchema>;
export type OperatorExternalFeed = z.infer<typeof OperatorExternalFeedSchema>;
export type OperatorExternalFeedCoverageResponse = z.infer<typeof OperatorExternalFeedCoverageResponseSchema>;
export type OperatorWhatIfRequest = z.infer<typeof OperatorWhatIfRequestSchema>;
export type OperatorWhatIfResponse = z.infer<typeof OperatorWhatIfResponseSchema>;
export type PosConnectRequest = z.infer<typeof PosConnectRequestSchema>;
export type PosConnectResponse = z.infer<typeof PosConnectResponseSchema>;
export type OperatorOnboardRequest = z.infer<typeof OperatorOnboardRequestSchema>;
export type OperatorOnboardResponse = z.infer<typeof OperatorOnboardResponseSchema>;
