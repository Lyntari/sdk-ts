/**
 * DSR (data-subject-request) schema — 1 endpoint (`dsr`).
 *
 * `dsr` (POST, HMAC + JWT) submits a data-subject request. Consumer-facing; the
 * subject is JWT-derived, so the caller supplies no user id and always acts on
 * their OWN data.
 *
 * `request_type` is the public data-subject-request verb:
 *   - `access` — request a copy of the data the service holds about you.
 *   - `deletion` — request erasure of your personal data. Some records may be
 *     retained where retention is legally required; those are severed from your
 *     identity rather than returned.
 *   - `portability` — request a machine-readable export of your data (queued).
 *
 * Returns the request record: an opaque `dsr_id` for follow-up, the accepted
 * `request_type`, and a verb-specific `result` payload.
 */

import { z } from 'zod';

export const DsrRequestTypeSchema = z.enum(['access', 'deletion', 'portability']);

export const SubmitDsrRequestSchema = z.object({
  request_type: DsrRequestTypeSchema,
});

export const SubmitDsrResponseSchema = z.object({
  dsr: z.object({
    /** Opaque identifier for the submitted request. */
    dsr_id: z.string(),
    /** The accepted request verb, echoed back. */
    request_type: z.string(),
    /** Verb-specific result payload (shape depends on `request_type`). */
    result: z.unknown(),
  }),
});

export type DsrRequestType = z.infer<typeof DsrRequestTypeSchema>;
export type SubmitDsrRequest = z.infer<typeof SubmitDsrRequestSchema>;
export type SubmitDsrResponse = z.infer<typeof SubmitDsrResponseSchema>;
