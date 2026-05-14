/**
 * Storage barrel.
 *
 * Re-exports the `TokenStorage` interface and the two built-in adapters
 * (`InMemoryStorage`, `CapacitorPreferencesStorage`). Consumers can import
 * directly from `@lyntari/sdk` since the top-level `src/index.ts` re-exports
 * this module.
 */

export type { TokenStorage } from './types.js';
export { InMemoryStorage } from './memory.js';
export {
  CapacitorPreferencesStorage,
  type CapacitorPreferencesLike,
} from './capacitor.js';
