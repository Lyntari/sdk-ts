/**
 * Events operator-flow EF schemas — 2 endpoints (shipped 2026-05-20, cluster #14):
 *   - `manage-venue-staffing` (POST, HMAC + JWT) — operator manages venue staffing
 *   - `manage-event-phases` (POST, HMAC + JWT) — operator manages event phase lifecycle
 *
 * Both are multi-action operator-facing EFs. The body shape is a Zod
 * `discriminatedUnion('action', [...])` so the SDK caller selects the action
 * by literal field and the corresponding required args are type-narrowed.
 *
 * **Vendoring status (cluster #14 deferral):** same as cluster #13 — deployed
 * EFs use INLINE schemas mirroring these shapes. The schema-vendoring drift
 * gate is deferred until the next sdk-ts release cycle.
 */

import { z } from 'zod';
import { UuidSchema } from './_common.js';

// === manage-venue-staffing ================================================

/**
 * Manage-venue-staffing request. Three actions, discriminated by `action`:
 *
 * - `insert` — open a new staffing row for `(venue_id, role)`, auto-closing
 *   any prior open row for the same pair. `staff_count >= 0`. `queue_id`
 *   and `metadata` optional.
 * - `close` — close a single staffing row by `staffing_id`. Server raises
 *   `rpc_validation_failed` (400) if already closed or not found.
 * - `close_all` — bulk-close ALL currently-open staffing rows for `venue_id`
 *   across roles. Returns `closed_count`.
 *
 * `p_set_by_user_id` is JWT-derived on the server (caller doesn't supply).
 */
export const ManageVenueStaffingRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('insert'),
    venue_id: UuidSchema,
    role: z.string().min(1),
    staff_count: z.number().int().min(0),
    queue_id: UuidSchema.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  z.object({
    action: z.literal('close'),
    staffing_id: UuidSchema,
  }),
  z.object({
    action: z.literal('close_all'),
    venue_id: UuidSchema,
  }),
]);

/**
 * Manage-venue-staffing response — discriminated by `action`:
 * - `insert` returns `{ok, action, staffing_id}` (uuid of the new row).
 * - `close` returns `{ok, action}`.
 * - `close_all` returns `{ok, action, closed_count}` (number of rows closed).
 */
export const ManageVenueStaffingResponseSchema = z.discriminatedUnion('action', [
  z.object({ ok: z.literal(true), action: z.literal('insert'), staffing_id: UuidSchema }),
  z.object({ ok: z.literal(true), action: z.literal('close') }),
  z.object({ ok: z.literal(true), action: z.literal('close_all'), closed_count: z.number().int().min(0) }),
]);

export type ManageVenueStaffingRequest = z.infer<typeof ManageVenueStaffingRequestSchema>;
export type ManageVenueStaffingResponse = z.infer<typeof ManageVenueStaffingResponseSchema>;

// === manage-event-phases ==================================================

/**
 * Manage-event-phases request. Three actions:
 *
 * - `started` — insert a new event_phases row. `phase_name` hard-validated
 *   against `events.phase_taxonomies WHERE sport = event.event_type`;
 *   server raises `rpc_validation_failed` (400) on mismatch. Auto-closes
 *   any prior open phase for the event (single-current-phase invariant).
 * - `ended` — close the most recent open `(event_id, phase_name)` row.
 *   Server raises if no open row.
 * - `get_taxonomies` — read-only: returns the catalog of phases for a sport
 *   (e.g., NFL = pre_game, Q1, Q2, halftime, Q3, Q4, OT, post). Used by
 *   Retool to populate the phase-picker dropdown.
 */
export const ManageEventPhasesRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('started'),
    event_id: UuidSchema,
    phase_name: z.string().min(1),
  }),
  z.object({
    action: z.literal('ended'),
    event_id: UuidSchema,
    phase_name: z.string().min(1),
  }),
  z.object({
    action: z.literal('get_taxonomies'),
    sport: z.string().min(1),
  }),
]);

/**
 * Manage-event-phases response — discriminated by `action`:
 * - `started` returns `{ok, action, phase_row_id}` (uuid of the new row).
 * - `ended` returns `{ok, action}`.
 * - `get_taxonomies` returns `{ok, action, phases: PhaseTaxonomyRow[]}`.
 */
export const ManageEventPhasesResponseSchema = z.discriminatedUnion('action', [
  z.object({ ok: z.literal(true), action: z.literal('started'), phase_row_id: UuidSchema }),
  z.object({ ok: z.literal(true), action: z.literal('ended') }),
  z.object({
    ok: z.literal(true),
    action: z.literal('get_taxonomies'),
    phases: z.array(z.record(z.string(), z.unknown())),
  }),
]);

export type ManageEventPhasesRequest = z.infer<typeof ManageEventPhasesRequestSchema>;
export type ManageEventPhasesResponse = z.infer<typeof ManageEventPhasesResponseSchema>;
