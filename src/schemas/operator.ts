/**
 * Operator server-to-server surface — 3 endpoints (cluster #89, §36.2).
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
