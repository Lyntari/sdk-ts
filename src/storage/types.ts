/**
 * `TokenStorage` — the persistence contract used by the Auth module.
 *
 * Adapters implement three async primitives over a key-value namespace.
 * Two concrete implementations ship in `@lyntari/sdk`:
 *
 *  - `InMemoryStorage` — Map-backed; for tests and Node consumers.
 *  - `CapacitorPreferencesStorage` — wraps `@capacitor/preferences` for
 *    iOS/Android via dependency injection (the SDK has no direct dep on
 *    `@capacitor/preferences`).
 *
 * Future adapters (browser `localStorage`, AsyncStorage for React Native,
 * encrypted filesystem) live behind this same interface — the Auth module
 * never touches platform APIs directly.
 *
 * The five keys the Auth module reads/writes are stable contracts:
 * `authToken`, `refreshToken`, `authUser`, `user_id`, `token_expires_at`.
 * Adapters MUST round-trip values without transformation — Auth-module
 * tests assume a write+read returns the exact string written.
 */

export interface TokenStorage {
  /** Read a value by key. Returns `null` when the key is absent. */
  get(key: string): Promise<string | null>;
  /** Write a value at key, overwriting any prior value. */
  set(key: string, value: string): Promise<void>;
  /** Delete the value at key. No-op when the key is absent. */
  remove(key: string): Promise<void>;
}
