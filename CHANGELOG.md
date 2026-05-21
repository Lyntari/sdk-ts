# Changelog

All notable changes to `@lyntari/sdk` are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v0.2.3 - Unreleased

### Changed

- Internal documentation cleanup per CLAUDE.md sdk-ts boundary directive — no behavior change, no wire contract change, no method signature change. Scrubs internal SQL identifiers, RPC names, RPC parameter names, internal config keys, SQLSTATE codes, and internal cluster-tracking markers from docstrings and public JSDoc. See [Lyntari/sdk-ts#5](https://github.com/Lyntari/sdk-ts/pull/5) for the cleanup audit + the resulting diff.

## v0.2.2 - Unreleased

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
