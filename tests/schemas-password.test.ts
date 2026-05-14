/**
 * Password-rule tests for ConsumerSignupRequestSchema + ResetPasswordRequestSchema.
 *
 * Pins the two requirements:
 *  - Length: at least 8 characters.
 *  - Blocklist: a top-25 common-password Set is rejected (case-insensitive).
 *
 * Login (ConsumerLoginRequestSchema) intentionally does NOT apply these rules
 * — pre-existing accounts whose passwords happen to be on the blocklist still
 * need to be able to log in (and then rotate). One test below pins that.
 *
 * The rules live in the SDK as the canonical contract. This test is the
 * canonical assertion of what passes and what fails on signup/reset.
 */

import { describe, it, expect } from 'vitest';
import {
  COMMON_PASSWORDS,
  ConsumerLoginRequestSchema,
  ConsumerSignupRequestSchema,
  ResetPasswordRequestSchema,
} from '../src/schemas/auth.js';

const VALID_EMAIL = 'a@b.co';
const VALID_PASSWORD = 'SomethingUnique42';

describe('COMMON_PASSWORDS blocklist', () => {
  it('contains the obvious top hitters', () => {
    expect(COMMON_PASSWORDS.has('password')).toBe(true);
    expect(COMMON_PASSWORDS.has('12345678')).toBe(true);
    expect(COMMON_PASSWORDS.has('qwerty123')).toBe(true);
    expect(COMMON_PASSWORDS.has('iloveyou')).toBe(true);
  });

  it('is all-lowercase by convention', () => {
    for (const p of COMMON_PASSWORDS) {
      expect(p).toBe(p.toLowerCase());
    }
  });

  it('has 25 entries', () => {
    expect(COMMON_PASSWORDS.size).toBe(25);
  });
});

describe('ConsumerSignupRequestSchema — password rules', () => {
  it('accepts a long unique password', () => {
    expect(() =>
      ConsumerSignupRequestSchema.parse({
        email: VALID_EMAIL,
        password: VALID_PASSWORD,
      }),
    ).not.toThrow();
  });

  it('rejects passwords shorter than 8 characters', () => {
    const result = ConsumerSignupRequestSchema.safeParse({
      email: VALID_EMAIL,
      password: 'abc12',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['password']);
      expect(result.error.issues[0]?.message).toMatch(/at least 8 characters/);
    }
  });

  it('rejects a password that is in the common-password blocklist (exact case)', () => {
    const result = ConsumerSignupRequestSchema.safeParse({
      email: VALID_EMAIL,
      password: 'password1',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['password']);
      expect(result.error.issues[0]?.message).toMatch(/too common/);
    }
  });

  it('rejects a blocklisted password case-insensitively', () => {
    // The list is all-lowercase, comparison lowercases the candidate.
    const result = ConsumerSignupRequestSchema.safeParse({
      email: VALID_EMAIL,
      password: 'Password1', // capital P
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/too common/);
    }
  });

  it('accepts a long password that happens to start with a common stem', () => {
    // 'password' is blocklisted but 'password-correct-horse-battery' is not
    // (it's not in the Set; we don't do substring matching by design).
    expect(() =>
      ConsumerSignupRequestSchema.parse({
        email: VALID_EMAIL,
        password: 'password-correct-horse-battery',
      }),
    ).not.toThrow();
  });
});

describe('ResetPasswordRequestSchema — same rules apply', () => {
  it('accepts a long unique new_password', () => {
    expect(() =>
      ResetPasswordRequestSchema.parse({
        email: VALID_EMAIL,
        new_password: VALID_PASSWORD,
      }),
    ).not.toThrow();
  });

  it('rejects a blocklisted new_password', () => {
    const result = ResetPasswordRequestSchema.safeParse({
      email: VALID_EMAIL,
      new_password: 'qwerty123',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['new_password']);
      expect(result.error.issues[0]?.message).toMatch(/too common/);
    }
  });
});

describe('ConsumerLoginRequestSchema — password rules NOT applied', () => {
  // Critical: existing accounts may have weak passwords. Login MUST still
  // accept them so the user can log in and rotate. The rules are only on
  // signup + reset (i.e., where the password is being created/changed).
  it('accepts a blocklisted password on login', () => {
    expect(() =>
      ConsumerLoginRequestSchema.parse({
        email: VALID_EMAIL,
        password: 'password1', // blocklisted on signup; allowed on login
      }),
    ).not.toThrow();
  });

  it('accepts a short password on login', () => {
    expect(() =>
      ConsumerLoginRequestSchema.parse({
        email: VALID_EMAIL,
        password: 'abc',
      }),
    ).not.toThrow();
  });
});
