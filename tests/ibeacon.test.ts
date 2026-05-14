import { describe, it, expect } from 'vitest';
import { parseIBeaconData, cleanupStaleBeacons } from '../src/ibeacon/index.js';

describe('parseIBeaconData', () => {
  // A canonical iBeacon frame:
  //   bytes[0..1]   = 02 15        (Apple iBeacon type/length)
  //   bytes[2..17]  = UUID (16 bytes)
  //   bytes[18..19] = major (big-endian)
  //   bytes[20..21] = minor (big-endian)
  //   bytes[22]     = tx_power
  //
  // UUID fda50693-a4e2-4fb1-afcf-c6eb07647825 in 16-byte form.
  const uuidHex = 'fda50693a4e24fb1afcfc6eb07647825';
  const uuidBytes = new Uint8Array(
    uuidHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
  );

  function buildIBeaconBuffer(
    major: number,
    minor: number,
    txPower: number,
    extraTail = new Uint8Array(0),
  ): ArrayBuffer {
    const bytes = new Uint8Array(23 + extraTail.length);
    bytes[0] = 0x02;
    bytes[1] = 0x15;
    bytes.set(uuidBytes, 2);
    bytes[18] = (major >> 8) & 0xff;
    bytes[19] = major & 0xff;
    bytes[20] = (minor >> 8) & 0xff;
    bytes[21] = minor & 0xff;
    bytes[22] = txPower & 0xff;
    bytes.set(extraTail, 23);
    return bytes.buffer;
  }

  it('parses a canonical Apple iBeacon advertisement', () => {
    const result = parseIBeaconData({
      manufacturerData: { '76': { buffer: buildIBeaconBuffer(1, 42, 197) } },
      rssi: -67,
    });
    expect(result).not.toBeNull();
    expect(result!.uuid).toBe('fda50693a4e24fb1afcfc6eb07647825');
    expect(result!.major).toBe(1);
    expect(result!.minor).toBe(42);
    expect(result!.rssi).toBe(-67);
    expect(result!.accuracy).toBeGreaterThan(0);
    expect(['immediate', 'near', 'far', 'unknown']).toContain(result!.proximity);
  });

  it('decodes major and minor as big-endian', () => {
    const r = parseIBeaconData({
      manufacturerData: { '76': { buffer: buildIBeaconBuffer(0x0102, 0x0304, 197) } },
      rssi: -50,
    });
    expect(r!.major).toBe(0x0102); // 258
    expect(r!.minor).toBe(0x0304); // 772
  });

  it('returns null when manufacturerData is missing', () => {
    expect(parseIBeaconData({ rssi: -67 } as any)).toBeNull();
  });

  it('returns null when Apple manufacturer id (76) is absent', () => {
    expect(
      parseIBeaconData({
        manufacturerData: { '6': { buffer: buildIBeaconBuffer(1, 42, 197) } },
        rssi: -67,
      }),
    ).toBeNull();
  });

  it('returns null on a frame shorter than 23 bytes', () => {
    const short = new ArrayBuffer(20);
    expect(
      parseIBeaconData({
        manufacturerData: { '76': { buffer: short } },
        rssi: -67,
      }),
    ).toBeNull();
  });

  it('returns null when the iBeacon type/length prefix is wrong', () => {
    const bytes = new Uint8Array(buildIBeaconBuffer(1, 42, 197));
    bytes[0] = 0x03; // not 0x02
    expect(
      parseIBeaconData({
        manufacturerData: { '76': { buffer: bytes.buffer } },
        rssi: -67,
      }),
    ).toBeNull();
  });

  it('returns -1 accuracy and `unknown` proximity when rssi is 0', () => {
    const r = parseIBeaconData({
      manufacturerData: { '76': { buffer: buildIBeaconBuffer(1, 1, 197) } },
      rssi: 0,
    });
    expect(r!.accuracy).toBe(-1);
    expect(r!.proximity).toBe('unknown');
  });

  it('classifies proximity correctly across band thresholds', () => {
    // accuracy < 0.5 → immediate; < 3 → near; >= 3 → far.
    // Apple's formula is monotone in |rssi/txPower|, so picking specific rssi
    // values lets us hit each band.
    const close = parseIBeaconData({
      manufacturerData: { '76': { buffer: buildIBeaconBuffer(1, 1, 200) } },
      rssi: -30,
    });
    expect(close!.proximity).toBe('immediate');

    const far = parseIBeaconData({
      manufacturerData: { '76': { buffer: buildIBeaconBuffer(1, 1, 1) } },
      rssi: -90,
    });
    expect(far!.proximity).toBe('far');
  });

  it('accepts Uint8Array as an alternate manufacturerData payload shape', () => {
    const bytes = new Uint8Array(buildIBeaconBuffer(1, 7, 197));
    const r = parseIBeaconData({
      manufacturerData: { '76': bytes },
      rssi: -67,
    });
    expect(r).not.toBeNull();
    expect(r!.minor).toBe(7);
  });
});

describe('cleanupStaleBeacons', () => {
  it('drops entries older than staleMs', () => {
    const now = 10_000;
    const map = new Map<string, { lastSeen: number }>([
      ['fresh', { lastSeen: now - 1_000 }],
      ['stale', { lastSeen: now - 30_000 }],
      ['boundary', { lastSeen: now - 10_001 }],
    ]);
    cleanupStaleBeacons(map, 10_000, now);
    expect(map.has('fresh')).toBe(true);
    expect(map.has('stale')).toBe(false);
    expect(map.has('boundary')).toBe(false);
  });

  it('keeps entries exactly at staleMs (strict greater-than)', () => {
    const now = 10_000;
    const map = new Map<string, { lastSeen: number }>([['edge', { lastSeen: now - 10_000 }]]);
    cleanupStaleBeacons(map, 10_000, now);
    expect(map.has('edge')).toBe(true);
  });

  it('mutates the map in place and returns void', () => {
    const map = new Map<string, { lastSeen: number; payload: string }>([
      ['a', { lastSeen: 0, payload: 'A' }],
    ]);
    const result = cleanupStaleBeacons(map, 1, 1_000);
    expect(result).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('defaults `now` to Date.now() when omitted', () => {
    const map = new Map<string, { lastSeen: number }>([
      ['recent', { lastSeen: Date.now() }],
    ]);
    cleanupStaleBeacons(map, 60_000);
    expect(map.has('recent')).toBe(true);
  });
});
