/**
 * Fleet-drift gate (cluster #89, SDK-001).
 *
 * Asserts a bijection between the SDK-exposed slugs in the deployed-fleet
 * manifest and `efRegistry`. This catches the class of drift the `openapi-drift`
 * gate structurally cannot: an EF deployed to the fleet but absent from the SDK
 * schemas (and the reverse).
 */

import { describe, it, expect } from 'vitest';
import { efRegistry } from '../src/schemas/index.js';
import { DEPLOYED_FLEET } from '../src/build/deployed-fleet.js';

describe('deployed-fleet drift gate', () => {
  it('SDK-exposed deployed EFs ⇔ efRegistry (bijection)', () => {
    const fleetSdk = new Set(DEPLOYED_FLEET.filter((f) => f.sdk).map((f) => f.slug));
    const registry = new Set(efRegistry.map((e) => e.slug));
    const deployedButUnregistered = [...fleetSdk].filter((s) => !registry.has(s)).sort();
    const registeredButNotDeployed = [...registry].filter((s) => !fleetSdk.has(s)).sort();
    expect(deployedButUnregistered).toEqual([]);
    expect(registeredButNotDeployed).toEqual([]);
  });

  it('has no duplicate slugs', () => {
    const slugs = DEPLOYED_FLEET.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every non-SDK EF documents an exemption reason', () => {
    for (const f of DEPLOYED_FLEET.filter((f) => !f.sdk)) {
      expect(f.exemptReason).toBeTruthy();
    }
  });
});
