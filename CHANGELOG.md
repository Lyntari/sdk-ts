# Changelog

All notable changes to `@lyntari/sdk` are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Versioning convention (cluster #42, 2026-05-27).** Going forward, version headers are written as `## vX.Y.Z` (or `## vX.Y.Z - <one-line summary>`) with no date stamp. Release dates live in git tags + npm package metadata. The earlier `## vX.Y.Z - Unreleased` → CI-stamps-on-tag pattern was retired (the stamping step in `.github/workflows/publish.yml` was removed at the same time). Historical sections written under the old convention — including the dated v0.2.0 header and the v0.2.1 / v0.2.2 / v0.2.3 sections still tagged `- Unreleased` — are preserved as-is. New version sections added below should use the simpler format.

## v0.2.6 - enterprise operator surface + auth hardening

### Added (operator server-to-server surface)

- **New `client.operator` domain** for the enterprise server-to-server surface:
  - `client.operator.manageApiKeys({ action })` — issue / rotate / revoke the org's own partner API keys (HMAC + operator JWT). `issue` and `rotate` return `{ key }` with the raw `api_key` exactly once; `revoke` returns `{ revoked }`. Wraps the `manage-api-keys` Edge Function.
  - `client.operator.insights(partnerApiKey, { target_org?, limit? })` — the org's persona-packaged insights, authenticated by a per-partner API key (distinct from the consumer `apiKey`). A `target_org` that isn't the key's own org is rejected with `org_access_denied`. Wraps `operator-insights`.
  - `client.operator.recommendations(partnerApiKey, { target_org?, limit? })` — the org's staffing recommendations, same partner-key auth. Wraps `operator-recommendations`.
  - Backed by `src/schemas/operator.ts`; coverage in `tests/methods.test.ts`.

### Added / Changed (auth hardening)

- `client.auth.changePassword({ new_password })` — **new.** Change the authenticated user's password (HMAC + JWT; the user is the JWT `sub`). The session-JWT factor for logged-in users.
- `client.auth.requestPasswordReset({ email })` — **new.** Begin the forgot-password flow; returns a uniform `{ message }` regardless of whether the account exists (no enumeration). A single-use reset token is delivered out-of-band when the account exists.
- `client.auth.resetPassword({ token, new_password })` — **BREAKING.** Now takes a single-use `token` (from `requestPasswordReset`) instead of `{ email, new_password }`. The prior shape allowed any holder of the shared API key to set a new password for any account; the token flow closes that. Returns `{ success }`.

### Added (integration tooling)

- **OpenAPI now advertises a sandbox server** (development environment) alongside production, so integrators can test against non-production data.
- **Fleet-drift gate** (`src/build/deployed-fleet.ts` + `tests/fleet-drift.test.ts`) — asserts a bijection between the SDK-exposed deployed EFs and the schema registry, catching a deployed-but-undocumented endpoint that the spec-vs-schemas gate can't see.

## v0.2.5 - consent + recommendations surface

### Added (consumer surface)

- `client.consent.get()` — read the authenticated user's consent map (`consent_type` → `{ granted, granted_at, revoked_at }`). Absent keys mean the user has never set that consent (treated as not-granted). HMAC + JWT auth; the user is JWT-derived (no user id argument). Wraps the `consent-get` Edge Function. Backed by `GetConsentRequestSchema` / `GetConsentResponseSchema` in `src/schemas/consent.ts`; happy-path coverage in `tests/methods.test.ts`.

- `client.consent.set({ consent_type, granted })` — grant (`granted: true`) or one-tap-revoke (`granted: false`) a single consent type, returning the full updated consent map. `consent_type` is one of `notifications` / `personalization` / `profile_vectors` / `cross_venue` (public wire contract, expandable server-side). HMAC + JWT auth; idempotent (re-setting the same value is a no-op). Wraps the `consent-set` Edge Function. Backed by `SetConsentRequestSchema` / `SetConsentResponseSchema` in `src/schemas/consent.ts`; grant + revoke coverage in `tests/methods.test.ts`.

- `client.recommendations.get({ venue_id })` — personalized recommendations for a venue, with an `abo_eligibility: { enabled, reason }` block carried alongside the recommendation payload (`recommendation_id`, `recommendation_type`, `items[]`, `score`, `confidence`, `valid_until`, `explanation_token`). When recommendations aren't available for the caller, `items` is `[]` and the recommendation fields are `null` — an honest empty payload, not an error. `items` are opaque ranked entries (interpreted per `recommendation_type`) and `explanation_token` is an opaque server-issued token. HMAC + JWT auth; the user is JWT-derived. Wraps the `recommendations` Edge Function. Backed by `GetRecommendationsRequestSchema` / `GetRecommendationsResponseSchema` in `src/schemas/recommendations.ts`; eligible + empty-payload coverage in `tests/methods.test.ts`.

## v0.2.4 - documentation cleanup release

Documentation + tooling cleanup, no behavior change in the SDK runtime. Validates the simplified `publish.yml` workflow (cluster #42) in isolation before any feature release. Specifically:

- **CHANGELOG backfill** — adds entries for the four operator-surface SDK methods (`client.insights.recordFeedback`, `client.insights.updateLifecycle`, `client.events.manageStaffing`, `client.events.managePhase`) that landed in the v0.2.2 unreleased train but weren't documented at the time. See the v0.2.2 section below for the per-method shape.
- **Versioning convention retired** — `## vX.Y.Z - Unreleased` → CI-stamps-release-date pattern removed. Future entries use `## vX.Y.Z` (with an optional one-line summary like this section's header) and release dates live in git tags + npm package metadata. Historical sections preserved as-is.
- **`publish.yml` simplified** — removed the stamp-release-date step (which broke during v0.2.3 release prep), the `fetch-depth: 0` on Checkout (only needed for a never-implemented post-publish push-back-to-main), and the orphaned post-publish comment block. The workflow now has 9 steps with no broken dependencies.

**No new methods, no schema changes, no transport changes, no test additions.** SDK consumers upgrading from v0.2.3 see no observable difference — the upgrade exists solely to flush the documentation backfill + validate the simplified release tooling.

## v0.2.3 - Unreleased

### Changed

- Internal documentation cleanup per CLAUDE.md sdk-ts boundary directive — no behavior change, no wire contract change, no method signature change. Scrubs internal SQL identifiers, RPC names, RPC parameter names, internal config keys, SQLSTATE codes, and internal cluster-tracking markers from docstrings and public JSDoc. See [Lyntari/sdk-ts#5](https://github.com/Lyntari/sdk-ts/pull/5) for the cleanup audit + the resulting diff.

## v0.2.2 - Unreleased

### Added (operator surface — clusters #13 + #14)

- `client.insights.recordFeedback({ insightId, sentiment, reasonCode?, operatorUserId?, notes? })` — 👍 / 👎 feedback path for operator-facing insights. Sentiment is the discriminator (`useful` / `not_useful`); `reasonCode` is validated server-side against the `ops.config.insight_feedback_reason_codes` allowed-codes registry. HMAC + JWT auth. Wraps the `record-insight-feedback` Edge Function (deployed May 2026). Backed by `RecordInsightFeedbackRequestSchema` / `RecordInsightFeedbackResponseSchema` in `src/schemas/insights.ts`; happy-path + invalid-reason-code tests in `tests/methods.test.ts`.

- `client.insights.updateLifecycle({ insightId, action, actionTakenText? })` — operator state-machine transitions for insights (`acknowledge` / `act` / `dismiss`). `action='act'` requires `actionTakenText`; the server returns the new lifecycle state derived from the `(acknowledged_at, acted_at, dismissed_at)` triple. HMAC + JWT auth. Wraps the `update-insight-lifecycle` Edge Function. Backed by `UpdateInsightLifecycleRequestSchema` (discriminated on `action`) + `UpdateInsightLifecycleResponseSchema` in `src/schemas/insights.ts`; discriminated-union branch coverage in `tests/methods.test.ts`.

- `client.events.manageStaffing({ ... })` — operator staffing-management surface for `app.venue_staffing`. Discriminated union: `op='insert'` adds a new open staffing row (auto-closing any prior open `(venue_id, role)` row), `op='close'` closes a specific staffing row by id, `op='close_all'` bulk-closes all open rows for a venue. HMAC + JWT auth. Wraps the `manage-venue-staffing` Edge Function. Backed by `ManageVenueStaffingRequestSchema` (discriminated on `op`) + `ManageVenueStaffingResponseSchema` in `src/schemas/events.ts`; happy-path + each-discriminated-branch coverage in `tests/methods.test.ts`.

- `client.events.managePhase({ ... })` — operator event-phase-management surface for `events.event_phases`. Discriminated union: `op='started'` opens a new phase (validates `phase_name` against the `events.phase_taxonomies` catalog for the event's sport; auto-closes any prior open phase for the event), `op='ended'` closes the current open phase, `op='get_taxonomies'` returns the allowed phase names + sort order for a given sport so the operator-console dropdown can populate. HMAC + JWT auth. Wraps the `manage-event-phases` Edge Function. Backed by `ManageEventPhasesRequestSchema` (discriminated on `op`) + `ManageEventPhasesResponseSchema` in `src/schemas/events.ts`; happy-path + each-discriminated-branch coverage in `tests/methods.test.ts`.

These four methods + their EFs are the operator console's write surface for the ML platform's insight + staffing + event-phase flows. The corresponding read paths (Retool widget queries via `public.get_*` SECURITY DEFINER functions) live on the server side and are not exposed via the SDK — operator reads go straight from Retool to PostgREST as the `authenticated` role.

### Added

- `client.location.createTracker(options)` — new stateful tracker module that polls `nearby-venues` on a configurable interval (default 30s), derives server-side stadium presence from the `current_stadium_id` row field (added in v0.2.1), and POSTs `location-update` when in a stadium so the server-side notification path sees a fresh location update for the user. Exposes `start()`, `stop()`, `forceTick()`, `isRunning()`. Consumers supply a platform-specific `getCurrentPosition()` and receive state via `onStateChange(state)` callbacks; errors route to an optional `onError(err)`.

  Extracted from the mobile-side `LocationContext.tsx` polling/eager-flip loop so multiple clients can consume the same in-stadium algorithm without duplicating it. The mobile-side refactor to consume the tracker lands in `mobile/` separately; the SDK side ships first because `mobile`'s CodeMagic build clones `sdk-ts/main`.

  Polling-only model (no `watchPosition` integration): the 30s `setInterval` runs the check independently of OS movement events, which fixes the stationary-iPhone-doesn't-tick edge case that required app-restart to see server-state transitions. The in-flight de-dupe collapses overlapping `setInterval` + `forceTick()` calls so the EF round-trip rate stays bounded.

### Re-exports

- `LocationTracker`, `LocationTrackerCoordinates`, `LocationTrackerOptions`, `LocationTrackerState` from `@lyntari/sdk`.

## v0.2.1 - Unreleased

### Schemas

- `NearbyVenuesResponseSchema` (the `client.location.nearbyVenues` response) gains an optional typed `current_stadium_id: UuidSchema.optional()` on each row. The server now projects the result of its existing `ST_Contains` polygon check against the caller's `(latitude, longitude)` onto every returned row. Three-state semantic: `[]` → not inside any stadium; non-empty array → every row carries the same `current_stadium_id`. Additive on the wire (old callers reading `Venue[]` continue to work unmodified) — the typed field is the only new addition.

  Plumbing for the mobile bug fix where a fresh signup ahead of `TESTING_SEED`'d stadium geofences left `LocationContext` stuck in `inStadium=false` (the client-side `locationService.stadiumGeofences` cache was loaded once per session at startup and never refetched). The mobile in-stadium gate now reads `result[0]?.current_stadium_id ?? null` instead of consulting a stale local polygon list. The `client.reads.stadiumGeofences()` SDK method is retained and unchanged — it still backs the debug-page consumer in `mobile/src/pages/debug/EdgeFunctionTest.tsx`.

## v0.2.0 - 2026-05-14

Initial release.

### Auth

- `createLyntariClient` factory with two modes: **caller-managed** (`client.setAccessToken` / `getAccessToken`) and **managed-lifecycle** (opt in via `auth: { storage, onEvent? }`).
- Managed-lifecycle owns cold-start restore, persistence, pre-expiry auto-refresh scheduling, and a discriminated `AuthEvent` surface (`tokenRefreshed` / `authExpired` / `authError` / `cleared`) classifying refresh failures via the server's `terminal_for_auth` flag.
- Pluggable `TokenStorage` interface plus two built-in adapters: `InMemoryStorage` (Map-backed) and `CapacitorPreferencesStorage` (dependency-injected; the SDK has no direct dep on `@capacitor/preferences`).
- Auth methods: `login`, `signup`, `refresh`, `logout`, `resetPassword`, `deleteAccount`.
- Signup + password-reset enforce password rules: minimum 8 characters and rejection of a top-25 common-password blocklist (case-insensitive). Login does not apply the rules so existing accounts can still authenticate to rotate.

### Push notifications

- `PushSubscriptions` module (`client.pushSubscriptions`) wires the OneSignal subscription save lifecycle end-to-end. Mounted only in managed-lifecycle mode.
- `client.pushSubscriptions.initialize({appId, getPlatform, onesignal?, onForegroundNotification?, onNotificationOpened?})` — one-call OneSignal setup: namespace resolution, plugin init, foreground + opened event listeners, and the subscription save lifecycle.
- Lower-level `client.pushSubscriptions.start(...)` for hosts that manage OneSignal init separately.
- OneSignal is referenced structurally via `OneSignalLike` — zero direct dependency on `onesignal-cordova-plugin` or `@capacitor/core`.

### iBeacon

- `parseIBeaconData(scanResult)` decodes Apple's iBeacon manufacturer-data byte layout from raw BLE scan callbacks. Returns `{uuid, major, minor, rssi, proximity, accuracy}` or `null` on missing/short/wrong-prefix frames.
- `cleanupStaleBeacons(map, staleMs)` — generic in-place eviction helper over `Map<string, { lastSeen: number }>`.
- Both helpers are platform-agnostic and have no Capacitor/BLE-plugin dependency.

### API surface

- Typed method wrappers grouped by domain: `auth` (6), `visits` (4), `location` (4), `notifications` (8), `reads` (8) — 30 methods total covering every client-callable endpoint.
- Tightened response schemas with typed row exports: `WaitboardRow`, `CategoryRow`, `VisitHistoryRow`, `NotificationHistoryRow`.

### Transport

- Web Crypto HMAC-SHA256 signer with byte-for-byte parity against the server's canonical signing.
- `postWithHMAC` primitive with three single-shot retry behaviors: `bad_signature` (clock-skew self-heal), `visit_race_conflict` (with `retry_safe: true`), and `expired_jwt` (when the Auth lifecycle is wired).
- `getWithApiKey` for header-API-key GET endpoints; `postWithApiKey` for body-API-key POST endpoints.
- Typed error hierarchy (`LyntariApiError` and subclasses) mirroring the server's error envelope. `LyntariApiError.userMessage` carries the unwrapped server message for UI surfaces; `LyntariApiError.message` keeps the wrapped `[code] msg (request_id: id)` debug format.

### Schemas + OpenAPI

- Zod schemas for every client-callable endpoint exported under `@lyntari/sdk/types`, consumed by the SDK methods and by the OpenAPI generator.
- OpenAPI 3.1 spec generated from the same schemas and shipped at the root of the package (`openapi.yaml`).
