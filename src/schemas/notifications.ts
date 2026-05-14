/**
 * Notification-flow EF schemas — 8 endpoints:
 *   - `save-subscription` (POST, HMAC + JWT, idempotency) — register OneSignal sub
 *   - `get-subscription-id` (POST, HMAC + JWT, empty body) — fetch current sub id
 *   - `save-category-preferences` (POST, HMAC + JWT, idempotency) — replace category list
 *   - `get-category-preferences` (POST, HMAC + JWT, empty body) — fetch category list
 *   - `get-notification-preferences` (POST, HMAC + JWT, empty body) — fetch frequency settings
 *   - `update-notification-preferences` (POST, HMAC + JWT, idempotency) — replace frequency settings
 *   - `notification-trigger` (POST, HMAC + JWT) — emit push notification
 *   - `notification-event` (POST, HMAC + JWT, idempotency) — record delivery/click/dismiss event
 *
 * **Why these schemas are flat, not discriminated unions:**
 *
 * - **`notification-trigger` looks like it should be a `trigger_type`-
 *   discriminated union, but the deployed contract is flat.** The top-level
 *   body shape does NOT vary by `trigger_type` — the server reads
 *   `{venue_id, trigger_type, meta?}`
 *   identically for every value, then `switch (trigger_type)` only inside the
 *   OneSignal payload formatter to vary push copy (title, body, action
 *   buttons). The shape variance lives inside `meta`, not the top-level body.
 *   So the SDK schema models `trigger_type` as a `z.enum(...)` of the four
 *   known-handled values (server falls through to a generic "Lyntari Update"
 *   for unknowns; rejecting unknowns at the SDK boundary is a deliberate
 *   tightening). `meta` stays open as `Record<string, unknown>`.
 *
 * - **`notification-event` looks like it should be an `event_type`-
 *   discriminated union, but the deployed contract is flat.** Server
 *   validates only `notification_id` + `event_type` are present, then
 *   passes through to the RPC verbatim. `event_type` is `z.string()` here
 *   — the wire contract
 *   accepts any string and the supported enum is a server-side concern that
 *   may evolve. Per-event meta variance lives inside `meta`. Documented
 *   common values in the JSDoc, but not enforced.
 *
 * Notable contract details:
 *
 * - **`notification-trigger` request shape** is `{venue_id, trigger_type, meta?}`.
 *   `subscription_id` is rejected with `unsupported_field` if submitted —
 *   the server resolves the active subscription from the authenticated user.
 *
 * - **Response variants on `notification-trigger`**: the server returns one of
 *   `{sent: false, reason: 'not_preferred_category'|'no_active_subscription', ...}`
 *   or `{sent: true, ...data}` — both HTTP 200. Schema documents both
 *   via a passthrough union with `sent: boolean` as the discriminator.
 *
 * - **`update-notification-preferences` enforces validation ranges**:
 *   `frequency_limit_minutes ∈ [5, 240]`, `min_wait_threshold_minutes`
 *   either `null` or `[5, 60]`. Server returns 400 `validation_failed` on
 *   bounds violations; SDK schema mirrors these so callers fail fast.
 *
 * - **`save-subscription` accepts `push_token: string | null`** explicitly —
 *   the server passes null through verbatim. Required field is
 *   `subscription_id` only; `push_token` and `platform` default
 *   server-side.
 */

import { z } from 'zod';
import { TimestampMsSchema, UuidSchema } from './_common.js';

// === save-subscription ====================================================

/**
 * Save-subscription request. `subscription_id` is the OneSignal subscription
 * id (required). `push_token` is the FCM/APNs token; nullable on platforms
 * where it isn't yet available. `platform` defaults to `'unknown'` on the
 * server when omitted; common values are `'ios'`, `'android'`, `'web'`.
 */
export const SaveSubscriptionRequestSchema = z.object({
  subscription_id: z.string().min(1),
  push_token: z.string().nullable().optional(),
  platform: z.string().optional(),
});

/**
 * Save-subscription response. Schema is `passthrough()` against an
 * empty base since the server's return shape is open.
 */
export const SaveSubscriptionResponseSchema = z.record(z.string(), z.unknown());

export type SaveSubscriptionRequest = z.infer<typeof SaveSubscriptionRequestSchema>;
export type SaveSubscriptionResponse = z.infer<typeof SaveSubscriptionResponseSchema>;

// === get-subscription-id ==================================================

/**
 * Get-subscription-id request — empty body, JWT-derived user_id.
 *
 * Marked `.strict()` so any unexpected client field is rejected with a 400
 * `validation_failed` rather than silently dropped — matches the
 * empty-body contract precedent in `GetCategoriesRequestSchema` and
 * `DeleteAccountRequestSchema`.
 */
export const GetSubscriptionIdRequestSchema = z.object({}).strict();

/**
 * Get-subscription-id response — `{subscription_id: string | null}`.
 * `null` when the user has no active subscription.
 */
export const GetSubscriptionIdResponseSchema = z.object({
  subscription_id: z.string().nullable(),
});

export type GetSubscriptionIdRequest = z.infer<typeof GetSubscriptionIdRequestSchema>;
export type GetSubscriptionIdResponse = z.infer<typeof GetSubscriptionIdResponseSchema>;

// === save-category-preferences ============================================

/**
 * Save-category-preferences request — replaces the user's category list
 * wholesale. Empty array clears all preferences. Server returns 400
 * `missing_required_fields` if `categories` isn't an array.
 */
export const SaveCategoryPreferencesRequestSchema = z.object({
  categories: z.array(z.string()),
});

/**
 * Save-category-preferences response. Echoes the saved category list.
 * Falls back to the input list if the server-side read-back fails (best-
 * effort behavior).
 */
export const SaveCategoryPreferencesResponseSchema = z.object({
  categories: z.array(z.string()),
});

export type SaveCategoryPreferencesRequest = z.infer<typeof SaveCategoryPreferencesRequestSchema>;
export type SaveCategoryPreferencesResponse = z.infer<typeof SaveCategoryPreferencesResponseSchema>;

// === get-category-preferences =============================================

/**
 * Get-category-preferences request — empty body, JWT-derived user_id.
 *
 * Marked `.strict()` per the empty-body contract precedent (see
 * `GetCategoriesRequestSchema` JSDoc). Unexpected client fields are
 * surfaced as 400 `validation_failed` rather than silently dropped.
 */
export const GetCategoryPreferencesRequestSchema = z.object({}).strict();

/**
 * Get-category-preferences response — `{preferences: [...]}`. Element
 * shape is open (typically `{category: string, ...}`).
 */
export const GetCategoryPreferencesResponseSchema = z.object({
  preferences: z.array(z.record(z.string(), z.unknown())),
});

export type GetCategoryPreferencesRequest = z.infer<typeof GetCategoryPreferencesRequestSchema>;
export type GetCategoryPreferencesResponse = z.infer<typeof GetCategoryPreferencesResponseSchema>;

// === get-notification-preferences =========================================

/**
 * Get-notification-preferences request — empty body, JWT-derived user_id.
 *
 * Marked `.strict()` per the empty-body contract precedent. Unexpected
 * client fields surface as 400 `validation_failed`.
 */
export const GetNotificationPreferencesRequestSchema = z.object({}).strict();

/**
 * Get-notification-preferences response — typically
 * `{enabled, frequency_limit_minutes, min_wait_threshold_minutes, ...}`.
 * Schema is `passthrough()` against the documented base shape.
 */
export const GetNotificationPreferencesResponseSchema = z
  .object({
    enabled: z.boolean().optional(),
    frequency_limit_minutes: z.number().int().optional(),
    min_wait_threshold_minutes: z.number().int().nullable().optional(),
  })
  .passthrough();

export type GetNotificationPreferencesRequest = z.infer<
  typeof GetNotificationPreferencesRequestSchema
>;
export type GetNotificationPreferencesResponse = z.infer<
  typeof GetNotificationPreferencesResponseSchema
>;

// === update-notification-preferences ======================================

/**
 * Update-notification-preferences request. All three fields are
 * client-controlled:
 *
 * - `enabled` — required boolean
 * - `frequency_limit_minutes` — required integer in `[5, 240]`
 * - `min_wait_threshold_minutes` — `null` or integer in `[5, 60]`. `null`
 *   disables the wait-time threshold gate.
 *
 * Server returns 400 `validation_failed` with `details.field` indicating
 * which field violated bounds.
 */
export const UpdateNotificationPreferencesRequestSchema = z.object({
  enabled: z.boolean(),
  frequency_limit_minutes: z.number().int().min(5).max(240),
  min_wait_threshold_minutes: z.number().int().min(5).max(60).nullable(),
});

/**
 * Update-notification-preferences response. Schema is `passthrough()`
 * against the same base shape as the GET — the server typically echoes
 * the saved state.
 */
export const UpdateNotificationPreferencesResponseSchema = z
  .object({
    enabled: z.boolean().optional(),
    frequency_limit_minutes: z.number().int().optional(),
    min_wait_threshold_minutes: z.number().int().nullable().optional(),
  })
  .passthrough();

export type UpdateNotificationPreferencesRequest = z.infer<
  typeof UpdateNotificationPreferencesRequestSchema
>;
export type UpdateNotificationPreferencesResponse = z.infer<
  typeof UpdateNotificationPreferencesResponseSchema
>;

// === notification-trigger =================================================

/**
 * Trigger-type enum. The server accepts arbitrary strings (no
 * enforcement) but only the four values listed render meaningful push
 * copy via the OneSignal formatter. Unknown values fall through to a
 * generic "Lyntari Update" — almost always unintended. SDK enforces the
 * known set; widening is a deliberate change.
 *
 * - `proximity` — user is geographically near a venue (uses `meta.distance`,
 *   `meta.floor`, `meta.section`).
 * - `beacon` — beacon detected (uses `meta.proximity` ∈
 *   `'immediate'|'near'|'far'`). Notification body taps deep-link to the
 *   venue detail page via `data.venue_id` (no payload-level action
 *   buttons — see push-integration.md).
 * - `wait_time_drop` — observed wait time fell (uses `meta.previous_wait`,
 *   `meta.current_wait`).
 * - `short_wait` — wait time is currently low (same meta fields as above).
 */
export const NotificationTriggerTypeSchema = z.enum([
  'proximity',
  'beacon',
  'wait_time_drop',
  'short_wait',
]);

/**
 * Notification-trigger request.
 *
 * Submitting `subscription_id` is rejected by the server with
 * `unsupported_field` — the schema therefore omits it; the server resolves
 * the active subscription from the authenticated user.
 *
 * `meta` is open by design: per-trigger-type fields (distance, proximity,
 * previous_wait, etc.) live here and are not validated structurally.
 */
export const NotificationTriggerRequestSchema = z.object({
  venue_id: UuidSchema,
  trigger_type: NotificationTriggerTypeSchema,
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Notification-trigger response. The server returns one of two HTTP-200
 * shapes — discriminated by `sent: boolean`:
 *
 * - `{sent: false, reason: 'not_preferred_category' | 'no_active_subscription' | string,
 *     venue_category?, notification_id?, request_id}` — push was suppressed
 *     for documented reasons.
 * - `{sent: true, ...data, request_id}` — push was emitted. Server
 *     fields spread verbatim (typically `notification_id`, `created_at`,
 *     etc.).
 *
 * Schema is a discriminated union on `sent` to give callers a clean type
 * narrow.
 */
export const NotificationTriggerResponseSchema = z.discriminatedUnion('sent', [
  z
    .object({
      sent: z.literal(false),
      reason: z.string(),
      venue_category: z.string().nullable().optional(),
      notification_id: UuidSchema.optional(),
      request_id: z.string(),
    })
    .passthrough(),
  z
    .object({
      sent: z.literal(true),
      request_id: z.string(),
    })
    .passthrough(),
]);

export type NotificationTriggerRequest = z.infer<typeof NotificationTriggerRequestSchema>;
export type NotificationTriggerResponse = z.infer<typeof NotificationTriggerResponseSchema>;

// === notification-event ===================================================

/**
 * Notification-event request. Records a delivery/interaction event against
 * a previously-emitted notification.
 *
 * `notification_id` and `event_type` are required (server returns 400
 * `missing_required_fields` otherwise). `event_type` is `z.string()`
 * intentionally — the wire contract accepts any string and the supported
 * enum evolves server-side. Common values today:
 *
 * - `received` — notification arrived in foreground (handler observed it)
 * - `opened` — user tapped the notification body
 * - `dismissed` — user swiped/cleared the notification
 *
 * `timestamp_ms` defaults server-side. `meta` is open for per-event-type
 * payload fields.
 */
export const NotificationEventRequestSchema = z.object({
  notification_id: UuidSchema,
  event_type: z.string().min(1),
  timestamp_ms: TimestampMsSchema.optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Notification-event response. Schema is `passthrough()` against an
 * open record.
 */
export const NotificationEventResponseSchema = z.record(z.string(), z.unknown());

export type NotificationEventRequest = z.infer<typeof NotificationEventRequestSchema>;
export type NotificationEventResponse = z.infer<typeof NotificationEventResponseSchema>;
