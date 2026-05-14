/**
 * `InMemoryStorage` — Map-backed `TokenStorage` adapter.
 *
 * Intended for tests, Node consumers, and CI runs where no native key-value
 * store is available. Values do not survive process restart.
 */

import type { TokenStorage } from './types.js';

export class InMemoryStorage implements TokenStorage {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}
