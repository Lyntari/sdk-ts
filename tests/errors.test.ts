/**
 * Error-envelope unwrapping tests.
 *
 * `LyntariApiError` exposes two strings derived from the server envelope:
 *
 *   - `.message` (inherited from `Error`): `[code] <human message> (request_id: <id>)` —
 *     intended for debug logs, console.error, and stack traces. Carries the full
 *     context engineers need to grep server-side.
 *
 *   - `.userMessage`: just `envelope.message`, no wrapper. Intended for UI
 *     callsites that surface error copy to end users. SDK consumers should
 *     read this instead of `.message` whenever the audience is the user.
 *
 * The split exists because UI callsites were observed leaking the raw
 * `.message` format (`[login_failed] Invalid credentials (request_id: req_…)`)
 * into end-user surfaces. Tests below pin the contract so a future
 * refactor doesn't accidentally collapse the two fields.
 */

import { describe, it, expect } from 'vitest';
import { LyntariApiError, envelopeToError, type ErrorEnvelope } from '../src/transport/errors.js';

const SAMPLE_ENVELOPE: ErrorEnvelope = {
  code: 'login_failed',
  message: 'Invalid credentials',
  request_id: 'req_00000000-0000-4000-8000-000000000001',
};

describe('LyntariApiError', () => {
  it('userMessage carries the unwrapped envelope.message — for UI consumers', () => {
    const err = new LyntariApiError(401, SAMPLE_ENVELOPE);
    expect(err.userMessage).toBe('Invalid credentials');
    // Critically: no brackets, no code prefix, no request_id suffix.
    expect(err.userMessage).not.toContain('[login_failed]');
    expect(err.userMessage).not.toContain('request_id');
    expect(err.userMessage).not.toContain('req_');
  });

  it('message keeps the wrapped `[code] msg (request_id: id)` format — for debug logs', () => {
    const err = new LyntariApiError(401, SAMPLE_ENVELOPE);
    expect(err.message).toBe(
      '[login_failed] Invalid credentials (request_id: req_00000000-0000-4000-8000-000000000001)',
    );
  });

  it('userMessage is preserved on subclassed errors (via envelopeToError dispatch)', () => {
    // expired_jwt dispatches to ExpiredJwtError; userMessage still equals envelope.message.
    const err = envelopeToError(401, {
      code: 'expired_jwt',
      message: 'JWT exp claim is in the past',
      request_id: 'req_x',
    });
    expect(err.userMessage).toBe('JWT exp claim is in the past');
    expect(err.message).toContain('[expired_jwt]');
  });

  it('userMessage equals envelope.message verbatim for signup_rejected', () => {
    // Representative envelope shape: the `.userMessage` is what the UI
    // should surface; the `.message` is what was leaking before the
    // standardization fix.
    const envelope: ErrorEnvelope = {
      code: 'signup_rejected',
      message: 'We already have an account with this address. Please try again.',
      request_id: 'req_00000000-0000-4000-8000-000000000002',
    };
    const err = new LyntariApiError(400, envelope);
    expect(err.userMessage).toBe('We already have an account with this address. Please try again.');
    expect(err.message).toBe(
      '[signup_rejected] We already have an account with this address. Please try again. (request_id: req_00000000-0000-4000-8000-000000000002)',
    );
  });
});
