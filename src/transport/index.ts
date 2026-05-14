/**
 * Transport layer barrel export.
 *
 * Public surface for typed-method wrappers and partners building
 * lower-level integrations.
 */

export {
  toBase64Url,
  computeBodyHash,
  canonicalizeQuery,
  signCanonical,
  signRequest,
  canonicalPathForSlug,
  type SignRequestInput,
  type SignRequestOutput,
} from './hmac.js';

export { postWithHMAC, type PostWithHmacOptions } from './post.js';
export { getWithApiKey, type GetWithApiKeyOptions } from './get.js';
export { postWithApiKey, type PostWithApiKeyOptions } from './postApiKey.js';

export {
  LyntariApiError,
  BadSignatureError,
  ExpiredJwtError,
  InvalidJwtError,
  IdempotencyKeyConflictError,
  ValidationError,
  ClockSkewError,
  RateLimitError,
  TransportError,
  envelopeToError,
  type ErrorEnvelope,
} from './errors.js';
