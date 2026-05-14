# `@lyntari/sdk` integration docs

End-to-end workflow guides for partner clients integrating against the
Lyntari backend. Pair these with [`openapi.yaml`](../openapi.yaml) (the
machine-readable API contract, shipped at the root of the package) and
the SDK's source-level JSDoc.

## Workflows

- **[push-integration.md](./push-integration.md)** — push notification subscription lifecycle, trigger-time data contract, server-composed copy, and the partner integration contract with OneSignal. Covers `save-subscription`, `get-subscription-id`, `notification-trigger`, `notification-event`, plus the wire-protocol contract clients must implement.
- **[ibeacon-integration.md](./ibeacon-integration.md)** — opt-in BLE iBeacon detection flow for venues that have deployed beacon hardware. Covers `beacon-config`, `beacon-detection`, and the matching `notification-trigger` call with `trigger_type='beacon'`. Skip this doc entirely if your client doesn't support BLE scanning.

## What's not here

- The general API reference — see [`openapi.yaml`](../openapi.yaml).
- Per-method usage examples — see source-level JSDoc on each method in `src/methods/`.
- Auth lifecycle wiring — see the package [`README.md`](../README.md) for the caller-managed and managed-lifecycle quickstarts.
