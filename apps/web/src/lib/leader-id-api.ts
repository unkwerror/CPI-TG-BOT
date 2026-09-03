import { api, ApiClientError } from './api';

export const leaderIdEndpoints = {
  status: '/catalyst/leader-id/status',
  bind: '/catalyst/leader-id/bind',
  subscribe: '/catalyst/leader-id/subscribe',
} as const;

export const leaderIdRegistrationStatuses = [
  'REGISTERED',
  'ALREADY_REGISTERED',
  'PENDING_APPROVAL',
  'QUESTIONNAIRE_REQUIRED',
  'REGISTRATION_CLOSED',
  'EVENT_NOT_AVAILABLE',
  'FAILED',
] as const;

export type LeaderIdRegistrationStatus = (typeof leaderIdRegistrationStatuses)[number];

export interface LeaderIdEventResult {
  eventId: string;
  leaderIdEventId: number;
  title: string;
  status: LeaderIdRegistrationStatus;
  retryable: boolean;
}

export interface LeaderIdRewardState {
  /** Decimal string supplied by the backend; never a frontend business constant. */
  amount: string;
  /** Optional backend-formatted value, for example `250 баллов`. */
  displayAmount?: string | null;
  awarded: boolean;
  awardedAt?: string | null;
}

export type LeaderIdBindingState =
  | { status: 'not_linked'; leaderId?: null }
  | {
      status: 'authorization_required';
      leaderId: string;
      authorizationUrl: string;
    }
  | {
      status: 'linked';
      leaderId: string;
      linkedAt?: string | null;
    };

export interface LeaderIdSubscriptionState {
  status: 'not_started' | 'processing' | 'completed' | 'partial' | 'failed';
  total: number;
  satisfied: number;
  pending: number;
  failed: number;
  results?: LeaderIdEventResult[];
  updatedAt?: string | null;
}

export interface LeaderIdStatusResponse {
  binding: LeaderIdBindingState;
  subscription: LeaderIdSubscriptionState;
  reward: LeaderIdRewardState;
}

export interface LeaderIdClient {
  loadStatus: () => Promise<LeaderIdStatusResponse>;
  bind: (leaderId: string, idempotencyKey: string) => Promise<LeaderIdBindResponse>;
  subscribe: (idempotencyKey: string) => Promise<LeaderIdStatusResponse>;
}

export interface LeaderIdBindResponse {
  authorizationUrl: string;
}

export interface LeaderIdApiEventResult {
  catalystEventId: string;
  leaderIdEventId: number;
  title: string;
  requiredForSubscription: boolean;
  status: LeaderIdRegistrationStatus;
  retryable: boolean;
}

interface LeaderIdApiReward {
  configured: boolean;
  points: string;
  awarded: boolean;
}

export interface LeaderIdStatusApiResponse {
  linked: boolean;
  leaderIdUserId?: number;
  results: LeaderIdApiEventResult[];
  reward: LeaderIdApiReward;
  /** These summary fields make completion authoritative and reload-safe. */
  totalEvents?: number;
  confirmedEvents?: number;
  submittedEvents?: number;
  failedEvents?: number;
  subscriptionComplete?: boolean;
  partial?: boolean;
}

export interface LeaderIdSubscribeApiResponse {
  linked: true;
  leaderIdUserId: number;
  totalEvents: number;
  confirmedEvents: number;
  submittedEvents: number;
  failedEvents: number;
  subscriptionComplete: boolean;
  partial: boolean;
  results: LeaderIdApiEventResult[];
  reward: LeaderIdApiReward & { replayed: boolean };
}

export type LeaderIdInputError = 'empty' | 'invalid' | null;

export interface LeaderIdUiError {
  kind: 'invalid' | 'not_found' | 'network' | 'api';
  message: string;
  retryable: boolean;
}

const LEADER_ID_PATTERN = /^[1-9]\d*$/u;
const LEADER_ID_AUTH_HOST = 'leader-id.ru';
export const LEADER_ID_MAX_LENGTH = 16;

export function validateLeaderIdInput(value: string): LeaderIdInputError {
  const normalized = value.trim();
  if (!normalized) return 'empty';
  if (normalized.length > LEADER_ID_MAX_LENGTH || !LEADER_ID_PATTERN.test(normalized)) {
    return 'invalid';
  }
  return null;
}

export function classifyLeaderIdError(error: unknown): LeaderIdUiError {
  if (error instanceof ApiClientError) {
    if (error.code === 'LEADER_ID_NOT_FOUND' || error.code === 'LEADER_ID_USER_NOT_FOUND') {
      return {
        kind: 'not_found',
        message: 'Такой Leader-ID не найден. Проверьте номер и попробуйте снова.',
        retryable: false,
      };
    }
    if (
      error.code === 'LEADER_ID_INVALID' ||
      error.code === 'LEADER_ID_FORMAT_INVALID' ||
      error.code === 'VALIDATION_ERROR'
    ) {
      return {
        kind: 'invalid',
        message: 'Проверьте Leader-ID: нужны только цифры без пробелов и ссылок.',
        retryable: false,
      };
    }
    if (error.status === 0 || error.code === 'NETWORK_ERROR') {
      return {
        kind: 'network',
        message: 'Не удалось связаться с сервером. Проверьте интернет и повторите попытку.',
        retryable: true,
      };
    }
  }
  if (error instanceof TypeError) {
    return {
      kind: 'network',
      message: 'Не удалось связаться с сервером. Проверьте интернет и повторите попытку.',
      retryable: true,
    };
  }
  return {
    kind: 'api',
    message: 'Сейчас не получилось проверить Leader-ID. Попробуйте ещё раз.',
    retryable: true,
  };
}

export function safeAuthorizationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const isLeaderIdHost =
      url.hostname === LEADER_ID_AUTH_HOST || url.hostname.endsWith(`.${LEADER_ID_AUTH_HOST}`);
    return url.protocol === 'https:' && isLeaderIdHost ? url.toString() : null;
  } catch {
    return null;
  }
}

export function rewardDisplayAmount(reward: LeaderIdRewardState): string {
  if (reward.displayAmount?.trim()) return reward.displayAmount.trim();
  return reward.amount.trim();
}

const confirmedStatuses = new Set<LeaderIdRegistrationStatus>(['REGISTERED', 'ALREADY_REGISTERED']);

function nonNegativeCount(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : fallback;
}

export function normalizeLeaderIdStatus(
  payload: LeaderIdStatusApiResponse | LeaderIdSubscribeApiResponse,
): LeaderIdStatusResponse {
  const results: LeaderIdEventResult[] = payload.results.map((result) => ({
    eventId: result.catalystEventId,
    leaderIdEventId: result.leaderIdEventId,
    title: result.title,
    status: result.status,
    retryable: result.retryable,
  }));
  const derivedConfirmed = payload.results.filter((result) =>
    confirmedStatuses.has(result.status),
  ).length;
  const derivedPending = payload.results.filter(
    (result) => result.status === 'PENDING_APPROVAL',
  ).length;
  const derivedFailed = Math.max(0, results.length - derivedConfirmed - derivedPending);
  const total = nonNegativeCount(payload.totalEvents, results.length);
  const confirmed = nonNegativeCount(payload.confirmedEvents, derivedConfirmed);
  const submitted = nonNegativeCount(payload.submittedEvents, derivedConfirmed + derivedPending);
  const pending = Math.max(0, submitted - confirmed);
  const failed = nonNegativeCount(payload.failedEvents, derivedFailed);
  const satisfied = Math.min(total, submitted);
  const complete =
    payload.subscriptionComplete ??
    (payload.linked && total > 0 && satisfied >= total && failed === 0);
  const partial = payload.partial ?? (!complete && satisfied > 0);
  const subscriptionStatus: LeaderIdSubscriptionState['status'] = !payload.linked
    ? 'not_started'
    : complete
      ? 'completed'
      : partial
        ? 'partial'
        : results.length > 0 || failed > 0
          ? 'failed'
          : 'not_started';

  return {
    binding: payload.linked
      ? { status: 'linked', leaderId: String(payload.leaderIdUserId ?? '') }
      : { status: 'not_linked' },
    subscription: {
      status: subscriptionStatus,
      total,
      satisfied,
      pending,
      failed,
      results,
    },
    reward: {
      // A historical grant remains visible even if an administrator later disables or changes
      // the current offer. The backend returns the immutable granted amount in that case.
      amount: payload.reward.configured || payload.reward.awarded ? payload.reward.points : '',
      awarded: payload.reward.awarded,
    },
  };
}

export function leaderIdSubscriptionSummary(subscription: LeaderIdSubscriptionState): string {
  if (subscription.total === 0) return 'Подключение к Catalyst сохранено.';
  if (subscription.satisfied >= subscription.total) {
    return 'Готово — вы подключены ко всем мероприятиям Catalyst.';
  }
  if (subscription.satisfied > 0) {
    return `Подключение выполнено. На ${subscription.satisfied} из ${subscription.total} мероприятий регистрация подтверждена.`;
  }
  if (subscription.status === 'processing') {
    return 'Регистрация выполняется. Результат появится здесь автоматически.';
  }
  if (
    subscription.status === 'failed' &&
    subscription.results?.some((result) => result.status === 'FAILED' && !result.retryable)
  ) {
    return 'Leader-ID требует завершить регистрацию на странице мероприятия. После этого обновите статус.';
  }
  return 'Не все регистрации удалось подтвердить. Можно безопасно повторить попытку.';
}

export function leaderIdSubscriptionHeading(subscription: LeaderIdSubscriptionState): string {
  if (subscription.status === 'completed') return 'Catalyst подключён';
  if (subscription.status === 'partial') return 'Catalyst подключён частично';
  return 'Catalyst пока не подключён';
}

export function canRetryLeaderIdSubscription(subscription: LeaderIdSubscriptionState): boolean {
  if (subscription.status !== 'partial' && subscription.status !== 'failed') return false;
  return Boolean(
    subscription.results?.some(
      (result) => result.retryable || result.status === 'QUESTIONNAIRE_REQUIRED',
    ),
  );
}

export function leaderIdResultNeedsExternalAction(result: LeaderIdEventResult): boolean {
  return (
    result.status === 'QUESTIONNAIRE_REQUIRED' || (result.status === 'FAILED' && !result.retryable)
  );
}

export function createLeaderIdRequestKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `leader-id-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return `leader-id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const leaderIdClient: LeaderIdClient = {
  loadStatus: async () =>
    normalizeLeaderIdStatus(await api<LeaderIdStatusApiResponse>(leaderIdEndpoints.status)),
  bind: (leaderId, idempotencyKey) =>
    api<LeaderIdBindResponse>(leaderIdEndpoints.bind, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ leaderId }),
    }),
  subscribe: async (idempotencyKey) =>
    normalizeLeaderIdStatus(
      await api<LeaderIdSubscribeApiResponse>(leaderIdEndpoints.subscribe, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({}),
      }),
    ),
};
