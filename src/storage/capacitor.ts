/**
 * `CapacitorPreferencesStorage` — `TokenStorage` adapter over `@capacitor/preferences`.
 *
 * The SDK does not import `@capacitor/preferences` directly. Consumers pass
 * the imported `Preferences` object (or any conforming implementation) to
 * the constructor:
 *
 * ```ts
 * import { Preferences } from '@capacitor/preferences';
 * import { CapacitorPreferencesStorage } from '@lyntari/sdk';
 *
 * const storage = new CapacitorPreferencesStorage(Preferences);
 * ```
 *
 * This keeps the SDK platform-neutral (zero direct dep on Capacitor) while
 * giving Capacitor callers a type-safe wrapper around the Preferences
 * contract. Node consumers never import this file (and therefore pay no
 * Capacitor cost via tree-shaking).
 */

import type { TokenStorage } from './types.js';

/**
 * Minimal contract the adapter requires from a Capacitor `Preferences`-like
 * object. Defining it locally avoids any compile-time dependency on
 * `@capacitor/preferences` types.
 */
export interface CapacitorPreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

export class CapacitorPreferencesStorage implements TokenStorage {
  constructor(private readonly prefs: CapacitorPreferencesLike) {}

  async get(key: string): Promise<string | null> {
    const result = await this.prefs.get({ key });
    return result.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.prefs.set({ key, value });
  }

  async remove(key: string): Promise<void> {
    await this.prefs.remove({ key });
  }
}
