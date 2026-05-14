/**
 * Auth lifecycle barrel.
 *
 * Re-exports the `AuthLifecycle` class + public types. Consumers import
 * from `@lyntari/sdk` directly via the top-level re-export.
 */

export { AuthLifecycle } from './lifecycle.js';
export type {
  AuthEvent,
  AuthEventListener,
  AuthState,
  RefreshOutcome,
} from './types.js';
