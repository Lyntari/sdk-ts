/**
 * Notification-flow SDK methods — 8 endpoints.
 *
 * Three idempotency-keyed mutations (`saveSubscription`,
 * `saveCategoryPreferences`, `updateNotificationPreferences`,
 * `notificationEvent`, `trigger`) and three read-only fetches
 * (`getSubscriptionId`, `getCategoryPreferences`, `getNotificationPreferences`).
 */

import type {
  GetCategoryPreferencesResponse,
  GetNotificationPreferencesResponse,
  GetSubscriptionIdResponse,
  NotificationEventRequest,
  NotificationEventResponse,
  NotificationTriggerRequest,
  NotificationTriggerResponse,
  SaveCategoryPreferencesRequest,
  SaveCategoryPreferencesResponse,
  SaveSubscriptionRequest,
  SaveSubscriptionResponse,
  UpdateNotificationPreferencesRequest,
  UpdateNotificationPreferencesResponse,
} from '../schemas/index.js';
import { postWithHMAC } from '../transport/post.js';
import type { ClientConfig, ClientState } from './_shared.js';
import { jwtCallOpts } from './_shared.js';

export interface NotificationsMethods {
  /**
   * `save-subscription` — register the OneSignal subscription id for the
   * authenticated user. Idempotent; repeat saves of the same id are
   * server-side no-ops. `push_token` may be `null` on platforms where it
   * isn't yet available.
   */
  saveSubscription(input: SaveSubscriptionRequest): Promise<SaveSubscriptionResponse>;

  /**
   * `get-subscription-id` — fetch the current OneSignal subscription id
   * for the authenticated user. Empty body. Returns `{subscription_id: string | null}`.
   */
  getSubscriptionId(): Promise<GetSubscriptionIdResponse>;

  /**
   * `save-category-preferences` — replace the user's category list
   * wholesale. Empty array clears all preferences. Idempotent.
   */
  saveCategoryPreferences(
    input: SaveCategoryPreferencesRequest,
  ): Promise<SaveCategoryPreferencesResponse>;

  /**
   * `get-category-preferences` — fetch the user's saved category list.
   * Empty body. Returns `{preferences: [...]}`.
   */
  getCategoryPreferences(): Promise<GetCategoryPreferencesResponse>;

  /**
   * `get-notification-preferences` — fetch the user's notification frequency
   * settings. Empty body.
   */
  getNotificationPreferences(): Promise<GetNotificationPreferencesResponse>;

  /**
   * `update-notification-preferences` — replace the user's notification
   * frequency settings. Server validates `frequency_limit_minutes ∈ [5, 240]`
   * and `min_wait_threshold_minutes ∈ [5, 60] | null`. Idempotent.
   */
  updateNotificationPreferences(
    input: UpdateNotificationPreferencesRequest,
  ): Promise<UpdateNotificationPreferencesResponse>;

  /**
   * `notification-trigger` — request a push notification be emitted to
   * the authenticated user for a given venue + trigger type. Server
   * checks user-category preferences and active subscription, then sends
   * to OneSignal if eligible. Returns `{sent: true|false, ...}`.
   *
   * SDK schema locks `trigger_type` to the four supported values
   * (`proximity`, `beacon`, `wait_time_drop`, `short_wait`); other values
   * return 400 `validation_failed`. Idempotent at the transport layer.
   */
  trigger(input: NotificationTriggerRequest): Promise<NotificationTriggerResponse>;

  /**
   * `notification-event` — record a delivery / click / dismiss event for
   * a previously-emitted notification. Idempotent at the transport layer.
   */
  notificationEvent(input: NotificationEventRequest): Promise<NotificationEventResponse>;
}

export function createNotificationsMethods(
  config: ClientConfig,
  state: ClientState,
): NotificationsMethods {
  return {
    saveSubscription: async (input) =>
      postWithHMAC<SaveSubscriptionResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'save-subscription',
        body: input,
        ...jwtCallOpts(state, 'save-subscription'),
        // idempotent: true
      }),

    getSubscriptionId: async () =>
      postWithHMAC<GetSubscriptionIdResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'get-subscription-id',
        body: {},
        ...jwtCallOpts(state, 'get-subscription-id'),
        idempotencyKey: null,
      }),

    saveCategoryPreferences: async (input) =>
      postWithHMAC<SaveCategoryPreferencesResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'save-category-preferences',
        body: input,
        ...jwtCallOpts(state, 'save-category-preferences'),
        // idempotent: true
      }),

    getCategoryPreferences: async () =>
      postWithHMAC<GetCategoryPreferencesResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'get-category-preferences',
        body: {},
        ...jwtCallOpts(state, 'get-category-preferences'),
        idempotencyKey: null,
      }),

    getNotificationPreferences: async () =>
      postWithHMAC<GetNotificationPreferencesResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'get-notification-preferences',
        body: {},
        ...jwtCallOpts(state, 'get-notification-preferences'),
        idempotencyKey: null,
      }),

    updateNotificationPreferences: async (input) =>
      postWithHMAC<UpdateNotificationPreferencesResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'update-notification-preferences',
        body: input,
        ...jwtCallOpts(state, 'update-notification-preferences'),
        // idempotent: true
      }),

    trigger: async (input) =>
      postWithHMAC<NotificationTriggerResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'notification-trigger',
        body: input as Record<string, unknown>,
        ...jwtCallOpts(state, 'notification-trigger'),
        // idempotent: true
      }),

    notificationEvent: async (input) =>
      postWithHMAC<NotificationEventResponse>({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        hmacSecret: config.hmacSecret,
        slug: 'notification-event',
        body: input,
        ...jwtCallOpts(state, 'notification-event'),
        // idempotent: true
      }),
  };
}
