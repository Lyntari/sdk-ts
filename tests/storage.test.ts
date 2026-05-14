/**
 * Storage adapter tests.
 *
 * `InMemoryStorage` gets full direct coverage. `CapacitorPreferencesStorage`
 * is exercised against a mock `CapacitorPreferencesLike` to verify the
 * round-trip contract without depending on `@capacitor/preferences`.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryStorage,
  CapacitorPreferencesStorage,
  type CapacitorPreferencesLike,
} from '../src/index.js';

describe('InMemoryStorage', () => {
  it('returns null for unknown keys', async () => {
    const s = new InMemoryStorage();
    expect(await s.get('missing')).toBeNull();
  });

  it('round-trips set+get', async () => {
    const s = new InMemoryStorage();
    await s.set('authToken', 'jwt-abc');
    expect(await s.get('authToken')).toBe('jwt-abc');
  });

  it('set overwrites prior value', async () => {
    const s = new InMemoryStorage();
    await s.set('k', 'v1');
    await s.set('k', 'v2');
    expect(await s.get('k')).toBe('v2');
  });

  it('remove makes get return null', async () => {
    const s = new InMemoryStorage();
    await s.set('k', 'v');
    await s.remove('k');
    expect(await s.get('k')).toBeNull();
  });

  it('remove on absent key is a no-op', async () => {
    const s = new InMemoryStorage();
    await expect(s.remove('missing')).resolves.toBeUndefined();
  });

  it('separates keys', async () => {
    const s = new InMemoryStorage();
    await s.set('a', '1');
    await s.set('b', '2');
    expect(await s.get('a')).toBe('1');
    expect(await s.get('b')).toBe('2');
  });
});

describe('CapacitorPreferencesStorage', () => {
  function mockPrefs(): CapacitorPreferencesLike & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      async get({ key }) {
        return { value: store.has(key) ? store.get(key)! : null };
      },
      async set({ key, value }) {
        store.set(key, value);
      },
      async remove({ key }) {
        store.delete(key);
      },
    };
  }

  it('delegates get to the underlying Preferences object', async () => {
    const prefs = mockPrefs();
    prefs.store.set('authToken', 'jwt-stored');
    const s = new CapacitorPreferencesStorage(prefs);
    expect(await s.get('authToken')).toBe('jwt-stored');
  });

  it('returns null when Preferences returns null', async () => {
    const prefs = mockPrefs();
    const s = new CapacitorPreferencesStorage(prefs);
    expect(await s.get('missing')).toBeNull();
  });

  it('delegates set to the underlying Preferences object', async () => {
    const prefs = mockPrefs();
    const s = new CapacitorPreferencesStorage(prefs);
    await s.set('refreshToken', 'r-1');
    expect(prefs.store.get('refreshToken')).toBe('r-1');
  });

  it('delegates remove to the underlying Preferences object', async () => {
    const prefs = mockPrefs();
    prefs.store.set('user_id', 'u-1');
    const s = new CapacitorPreferencesStorage(prefs);
    await s.remove('user_id');
    expect(prefs.store.has('user_id')).toBe(false);
  });

  it('round-trips the five stable Preferences keys', async () => {
    // Stable storage-key contract — see `src/storage/types.ts`.
    const prefs = mockPrefs();
    const s = new CapacitorPreferencesStorage(prefs);
    const writes: Array<[string, string]> = [
      ['authToken', 'jwt-1'],
      ['refreshToken', 'r-1'],
      ['authUser', '{"email":"a@b.c","user_id":"u-1"}'],
      ['user_id', 'u-1'],
      ['token_expires_at', String(Date.now() + 30 * 60 * 1000)],
    ];
    for (const [k, v] of writes) await s.set(k, v);
    for (const [k, v] of writes) expect(await s.get(k)).toBe(v);
  });
});
