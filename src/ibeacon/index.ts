/**
 * iBeacon scan-result parsing helpers.
 *
 * Any client integrating BLE iBeacon detection needs to decode Apple's
 * manufacturer-data byte layout from raw BLE scan callbacks. The byte format
 * is fixed by Apple's iBeacon spec and has nothing platform-specific:
 * company ID `0x004C` (Apple), beacon type `0x02`, length `0x15`, then UUID
 * (16) + major (2 BE) + minor (2 BE) + tx_power (1). This module is the
 * canonical decoder.
 *
 * `cleanupStaleBeacons` is a tiny eviction helper for the typical pattern of
 * tracking last-seen timestamps per beacon key in a Map and dropping entries
 * older than a threshold. Separated for unit testability (the device-side
 * scan callback drives a `Date.now()`-anchored loop; tests inject `now`).
 *
 * What's NOT in this module: BLE scan setup, permission flows, the
 * scan-callback wiring — those are platform-specific (Capacitor BLE plugin
 * on Capacitor; CoreBluetooth on native iOS; Web Bluetooth in browsers).
 * Each client wires its own BLE source and feeds the raw scan results
 * through `parseIBeaconData`.
 */

/**
 * Shape of a raw BLE scan result containing iBeacon manufacturer data.
 *
 * `manufacturerData` is a map keyed by manufacturer ID (string-form decimal,
 * e.g. `'76'` for Apple = `0x004C`). The value is a `DataView`-like with a
 * `buffer` field — matching `@capacitor-community/bluetooth-le`'s scan-result
 * shape. The function tolerates either DataView or already-`Uint8Array`
 * (some Web Bluetooth flavors).
 */
export interface IBeaconScanResult {
  manufacturerData?: Record<string, { buffer: ArrayBuffer } | Uint8Array | undefined>;
  rssi: number;
}

/**
 * Parsed iBeacon record. The proximity band is computed locally; per the
 * `beacon-detection` server contract, the server re-derives the
 * authoritative band from `accuracy` against per-stadium thresholds. The
 * local band is for UI display only.
 */
export interface IBeaconParsed {
  uuid: string;
  major: number;
  minor: number;
  rssi: number;
  proximity: 'immediate' | 'near' | 'far' | 'unknown';
  accuracy: number;
}

/**
 * Apple manufacturer ID in the canonical decimal string form used as the
 * `manufacturerData` map key by `@capacitor-community/bluetooth-le` and
 * mirror libraries. `0x004C` decimal = `76`.
 */
const APPLE_MANUFACTURER_ID = '76';
const APPLE_IBEACON_TYPE = 0x02;
const APPLE_IBEACON_LENGTH = 0x15;
const APPLE_IBEACON_FRAME_SIZE = 23; // 2 type/len + 16 uuid + 2 major + 2 minor + 1 tx_power

/**
 * Decode an Apple iBeacon advertisement from a raw BLE scan result. Returns
 * `null` when the result has no Apple manufacturer data, the frame doesn't
 * carry the iBeacon type/length prefix, or the byte length is short of the
 * 23-byte iBeacon frame.
 *
 * The returned `uuid` is lowercase 32-char hex with no dashes. The returned
 * `accuracy` is the Apple distance-estimate formula derived from `rssi` and
 * the beacon's calibrated `tx_power` byte (the 23rd byte of the frame).
 *
 * Failures are silent — invalid frames return `null` rather than throw, so
 * the caller can use the result in a tight scan-callback loop without
 * try/catch overhead.
 */
export function parseIBeaconData(result: IBeaconScanResult): IBeaconParsed | null {
  const manufacturerDataMap = result.manufacturerData;
  if (!manufacturerDataMap) return null;

  const appleData = manufacturerDataMap[APPLE_MANUFACTURER_ID];
  if (!appleData) return null;

  // Accept either DataView-like (with `.buffer`) or already-Uint8Array.
  const bytes =
    appleData instanceof Uint8Array
      ? appleData
      : appleData.buffer
        ? new Uint8Array(appleData.buffer)
        : null;
  if (!bytes || bytes.length < APPLE_IBEACON_FRAME_SIZE) return null;

  if (bytes[0] !== APPLE_IBEACON_TYPE || bytes[1] !== APPLE_IBEACON_LENGTH) {
    return null;
  }

  const uuid = Array.from(bytes.slice(2, 18))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // `noUncheckedIndexedAccess` makes raw `bytes[n]` `number | undefined`. Length
  // is already gated above (`bytes.length < APPLE_IBEACON_FRAME_SIZE`), so the
  // 23-byte payload is guaranteed — `!` asserts that.
  const major = (bytes[18]! << 8) | bytes[19]!;
  const minor = (bytes[20]! << 8) | bytes[21]!;
  const txPower = bytes[22]!; // iBeacon spec is signed int8, but the unsigned
                              // read goes untested in practice today — no live
                              // beacons deploy yet. Don't widen here without
                              // observable verification.
  const rssi = result.rssi;

  const accuracy = calculateAccuracy(txPower, rssi);
  const proximity = calculateProximity(accuracy);

  return { uuid, major, minor, rssi, proximity, accuracy };
}

/**
 * Apple iBeacon distance-estimate formula. Returns meters from beacon
 * derived from raw `rssi` (signed dBm) and the beacon's calibrated `txPower`
 * (signed dBm at 1m). Returns `-1` for `rssi === 0` (no signal). The formula
 * is the canonical Apple-published heuristic; it's noisy at distance and
 * useful only as an ordinal indicator below ~3m.
 *
 * Kept platform-agnostic and dependency-free — pure math.
 */
function calculateAccuracy(txPower: number, rssi: number): number {
  if (rssi === 0) return -1;
  const ratio = rssi / txPower;
  if (ratio < 1.0) {
    return Math.pow(ratio, 10);
  } else {
    return 0.89976 * Math.pow(ratio, 7.7095) + 0.111;
  }
}

/**
 * Apple iBeacon textual proximity band derived from `accuracy` (meters).
 * Thresholds match the Apple-published bands: `< 0.5m` immediate, `< 3m`
 * near, otherwise far. `-1` (no-signal) → unknown.
 *
 * Not authoritative — the server re-derives the band from `accuracy`
 * against per-stadium thresholds. Use this only for local-UI display.
 */
function calculateProximity(accuracy: number): IBeaconParsed['proximity'] {
  if (accuracy < 0) return 'unknown';
  if (accuracy < 0.5) return 'immediate';
  if (accuracy < 3.0) return 'near';
  return 'far';
}

/**
 * Evict entries from a `Map` keyed-by-last-seen-timestamp when they're older
 * than `staleMs`. Mutates the map in place. Generic over the entry payload
 * — pass any record with a `lastSeen: number` field. `now` is injectable
 * for testability; defaults to `Date.now()`.
 *
 * Typical usage: the BLE scan callback updates `lastSeen` on each detection
 * of a known beacon key. A periodic timer (or every-N-scans interval) calls
 * `cleanupStaleBeacons` to drop beacons no longer in range.
 */
export function cleanupStaleBeacons<T extends { lastSeen: number }>(
  beacons: Map<string, T>,
  staleMs: number,
  now: number = Date.now(),
): void {
  for (const [key, value] of beacons.entries()) {
    if (now - value.lastSeen > staleMs) {
      beacons.delete(key);
    }
  }
}
