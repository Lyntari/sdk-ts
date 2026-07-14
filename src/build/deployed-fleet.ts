/**
 * Deployed Edge Function fleet manifest (cluster #89, SDK-001).
 *
 * The `openapi-drift` gate checks spec-vs-SDK-schemas — it structurally cannot
 * see an EF that is deployed but absent from `src/schemas`. This manifest closes
 * that gap: it enumerates EVERY deployed EF slug and marks whether it is exposed
 * through `@lyntari/sdk`. The `fleet-drift` test asserts a bijection between the
 * `sdk: true` slugs here and `efRegistry`, so:
 *   - deploying a client-callable EF without registering its schema fails CI, and
 *   - registering a schema whose EF isn't in the fleet fails CI.
 *
 * `sdk: false` entries are the legitimate non-SDK surface: the cron-only family
 * (`X-Internal-Token`), the operator-JWT login, and demo/util functions. Keep
 * this list in lock-step with the deployed fleet — update it whenever an EF is
 * deployed or retired. (A live-fleet cross-check against the Supabase API is a
 * credentialed CI follow-up; this manifest is the reviewable source of truth.)
 */

export interface FleetEntry {
  readonly slug: string;
  /** Exposed as a typed method in `@lyntari/sdk` (⇒ must be in `efRegistry`). */
  readonly sdk: boolean;
  /** Why a `sdk: false` EF is intentionally not in the SDK. */
  readonly exemptReason?: 'cron-internal-token' | 'operator-login' | 'demo-util';
}

export const DEPLOYED_FLEET: readonly FleetEntry[] = [
  // --- auth (SDK) ---
  { slug: 'consumer-login', sdk: true },
  { slug: 'consumer-signup', sdk: true },
  { slug: 'auth-refresh', sdk: true },
  { slug: 'auth-logout', sdk: true },
  { slug: 'reset-password', sdk: true },
  { slug: 'request-password-reset', sdk: true },
  { slug: 'change-password', sdk: true },
  { slug: 'delete-account', sdk: true },
  // --- visits (SDK) ---
  { slug: 'visit-signals', sdk: true },
  { slug: 'pos-close', sdk: true },
  { slug: 'pos-current-visits', sdk: true },
  { slug: 'congestion-history', sdk: true },
  // --- location (SDK) ---
  { slug: 'nearby-venues', sdk: true },
  { slug: 'location-update', sdk: true },
  { slug: 'beacon-detection', sdk: true },
  { slug: 'beacon-config', sdk: true },
  // --- notifications (SDK) ---
  { slug: 'save-subscription', sdk: true },
  { slug: 'get-subscription-id', sdk: true },
  { slug: 'save-category-preferences', sdk: true },
  { slug: 'get-category-preferences', sdk: true },
  { slug: 'get-notification-preferences', sdk: true },
  { slug: 'update-notification-preferences', sdk: true },
  { slug: 'notification-event', sdk: true },
  { slug: 'notification-trigger', sdk: true },
  // --- reads (SDK) ---
  { slug: 'waitboard', sdk: true },
  { slug: 'congestion-status', sdk: true },
  { slug: 'stadium-zones', sdk: true },
  { slug: 'stadium-geofences', sdk: true },
  { slug: 'get-profile', sdk: true },
  { slug: 'get-visit-history', sdk: true },
  { slug: 'get-notification-history', sdk: true },
  { slug: 'get-categories', sdk: true },
  // --- insights + events (SDK) ---
  { slug: 'record-insight-feedback', sdk: true },
  { slug: 'update-insight-lifecycle', sdk: true },
  { slug: 'manage-venue-staffing', sdk: true },
  { slug: 'manage-event-phases', sdk: true },
  // --- consent + recommendations + privacy (SDK) ---
  { slug: 'consent-get', sdk: true },
  { slug: 'consent-set', sdk: true },
  { slug: 'recommendations', sdk: true },
  { slug: 'dsr', sdk: true },
  // --- operator S2S (SDK, cluster #89) ---
  { slug: 'operator-insights', sdk: true },
  { slug: 'operator-recommendations', sdk: true },
  { slug: 'manage-api-keys', sdk: true },

  // --- NON-SDK surface (exempt) ---
  { slug: 'admin-login', sdk: false, exemptReason: 'operator-login' },
  { slug: 'refresh-demo-data', sdk: false, exemptReason: 'demo-util' },
  { slug: 'check-wait-time-notifications', sdk: false, exemptReason: 'cron-internal-token' },
  { slug: 'check-proximity-notifications', sdk: false, exemptReason: 'cron-internal-token' },
  { slug: 'ml-run-inference', sdk: false, exemptReason: 'cron-internal-token' },
  { slug: 'ml-run-optimizer', sdk: false, exemptReason: 'cron-internal-token' },
  { slug: 'ml-run-eval', sdk: false, exemptReason: 'cron-internal-token' },
  { slug: 'ml-run-retraining', sdk: false, exemptReason: 'cron-internal-token' },
  { slug: 'ops-alert-notify', sdk: false, exemptReason: 'cron-internal-token' },
];
