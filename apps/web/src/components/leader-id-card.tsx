'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  canRetryLeaderIdSubscription,
  classifyLeaderIdError,
  createLeaderIdRequestKey,
  LEADER_ID_MAX_LENGTH,
  leaderIdClient,
  leaderIdResultNeedsExternalAction,
  leaderIdSubscriptionHeading,
  leaderIdSubscriptionSummary,
  rewardDisplayAmount,
  safeAuthorizationUrl,
  validateLeaderIdInput,
  type LeaderIdClient,
  type LeaderIdEventResult,
  type LeaderIdRegistrationStatus,
  type LeaderIdStatusResponse,
  type LeaderIdUiError,
} from '../lib/leader-id-api';
import { ApiClientError } from '../lib/api';
import styles from './leader-id-card.module.css';

export interface LeaderIdCardProps {
  className?: string;
  /** Allows a parent loader to include Leader-ID in an existing parallel request batch. */
  initialStatus?: LeaderIdStatusResponse;
  /** Defaults to the Catalyst backend client; useful for development and E2E adapters. */
  client?: LeaderIdClient;
  /** Pass the active messenger adapter's `openLink` here. */
  openAuthorization?: (url: string) => void | Promise<void>;
  onStatusChange?: (status: LeaderIdStatusResponse) => void;
}

type Operation = 'idle' | 'loading' | 'binding' | 'subscribing';
type Notice =
  { tone: 'info' | 'success'; message: string } | { tone: 'error'; error: LeaderIdUiError } | null;

const registrationLabels: Record<LeaderIdRegistrationStatus, string> = {
  REGISTERED: 'Регистрация подтверждена',
  ALREADY_REGISTERED: 'Уже зарегистрированы',
  PENDING_APPROVAL: 'Ожидает подтверждения организатора',
  QUESTIONNAIRE_REQUIRED: 'Нужна анкета Leader-ID',
  REGISTRATION_CLOSED: 'Регистрация закрыта',
  EVENT_NOT_AVAILABLE: 'Мероприятие недоступно',
  FAILED: 'Не удалось зарегистрировать',
};

const LEADER_ID_REGISTRATION_URL = 'https://leader-id.ru/registration';

function defaultOpenAuthorization(url: string): void {
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.assign(url);
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12.5 4.2 4.2L19 7" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}

function ResultDetails({
  items,
  onOpenEvent,
}: {
  items: LeaderIdEventResult[];
  onOpenEvent: (eventId: number) => void | Promise<void>;
}) {
  if (items.length === 0) return null;
  return (
    <details className={styles.details}>
      <summary>Результаты по мероприятиям</summary>
      <ul>
        {items.map((item) => (
          <li key={item.eventId}>
            <span>{item.title}</span>
            <strong data-status={item.status}>
              {registrationLabels[item.status] ?? 'Статус уточняется'}
            </strong>
            {leaderIdResultNeedsExternalAction(item) ? (
              <button
                type="button"
                className={styles.eventAction}
                onClick={() => void onOpenEvent(item.leaderIdEventId)}
              >
                {item.status === 'QUESTIONNAIRE_REQUIRED'
                  ? 'Заполнить анкету в Leader-ID'
                  : 'Завершить регистрацию в Leader-ID'}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function LeaderIdCard({
  className,
  initialStatus,
  client = leaderIdClient,
  openAuthorization = defaultOpenAuthorization,
  onStatusChange,
}: LeaderIdCardProps) {
  const cardId = useId();
  const titleId = `${cardId}-title`;
  const inputId = `${cardId}-input`;
  const helpId = `${cardId}-help`;
  const feedbackId = `${cardId}-feedback`;
  const [status, setStatus] = useState<LeaderIdStatusResponse | null>(() => initialStatus ?? null);
  const [operation, setOperation] = useState<Operation>(() => (initialStatus ? 'idle' : 'loading'));
  const [leaderId, setLeaderId] = useState(
    () =>
      (initialStatus?.binding.status === 'not_linked' ? '' : initialStatus?.binding.leaderId) ?? '',
  );
  const [notice, setNotice] = useState<Notice>(null);
  const [available, setAvailable] = useState(true);
  const statusRef = useRef<LeaderIdStatusResponse | null>(initialStatus ?? null);
  const loadInFlight = useRef(false);
  const bindInFlight = useRef(false);
  const subscribeInFlight = useRef(false);
  const bindRequestKey = useRef<string | null>(null);
  const subscribeRequestKey = useRef<string | null>(null);

  const applyStatus = useCallback(
    (next: LeaderIdStatusResponse) => {
      statusRef.current = next;
      setStatus(next);
      if (next.binding.status !== 'not_linked') setLeaderId(next.binding.leaderId);
      onStatusChange?.(next);
    },
    [onStatusChange],
  );

  const loadStatus = useCallback(
    async (silent = false) => {
      if (loadInFlight.current) return;
      loadInFlight.current = true;
      if (!silent) {
        setOperation('loading');
        setNotice(null);
      }
      try {
        applyStatus(await client.loadStatus());
        setAvailable(true);
        setNotice(null);
      } catch (error) {
        // Production keeps the integration disabled until valid partner OAuth credentials are
        // configured. Do not expose a dead feature card while its backend routes are absent.
        if (error instanceof ApiClientError && error.status === 404 && error.code === 'NOT_FOUND') {
          setAvailable(false);
          return;
        }
        if (!silent || !statusRef.current) {
          setNotice({ tone: 'error', error: classifyLeaderIdError(error) });
        }
      } finally {
        loadInFlight.current = false;
        setOperation('idle');
      }
    },
    [applyStatus, client],
  );

  useEffect(() => {
    if (!initialStatus) void loadStatus();
  }, [initialStatus, loadStatus]);

  useEffect(() => {
    if (status?.binding.status !== 'authorization_required') return;
    const refreshAfterAuthorization = () => {
      if (document.visibilityState === 'visible') void loadStatus(true);
    };
    window.addEventListener('focus', refreshAfterAuthorization);
    document.addEventListener('visibilitychange', refreshAfterAuthorization);
    return () => {
      window.removeEventListener('focus', refreshAfterAuthorization);
      document.removeEventListener('visibilitychange', refreshAfterAuthorization);
    };
  }, [loadStatus, status?.binding.status]);

  const submitBinding = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (bindInFlight.current) return;
    const inputError = validateLeaderIdInput(leaderId);
    if (inputError) {
      setNotice({
        tone: 'error',
        error: {
          kind: 'invalid',
          message:
            inputError === 'empty'
              ? 'Введите Leader-ID.'
              : 'Проверьте Leader-ID: нужны только цифры без пробелов и ссылок.',
          retryable: false,
        },
      });
      return;
    }

    bindInFlight.current = true;
    setOperation('binding');
    setNotice(null);
    bindRequestKey.current ??= createLeaderIdRequestKey();
    try {
      const binding = await client.bind(leaderId.trim(), bindRequestKey.current);
      const authorizationUrl = safeAuthorizationUrl(binding.authorizationUrl);
      if (!authorizationUrl) throw new Error('Unsafe authorization URL');
      const current = statusRef.current;
      const next: LeaderIdStatusResponse = {
        binding: {
          status: 'authorization_required',
          leaderId: leaderId.trim(),
          authorizationUrl,
        },
        subscription: current?.subscription ?? {
          status: 'not_started',
          total: 0,
          satisfied: 0,
          pending: 0,
          failed: 0,
        },
        reward: current?.reward ?? { amount: '', awarded: false },
      };
      applyStatus(next);
      bindRequestKey.current = null;
      await openAuthorization(authorizationUrl);
      setNotice({
        tone: 'info',
        message: 'Завершите вход в Leader-ID и вернитесь сюда — статус обновится автоматически.',
      });
    } catch (error) {
      const classified = classifyLeaderIdError(error);
      if (classified.kind !== 'network' && classified.kind !== 'api') {
        bindRequestKey.current = null;
      }
      setNotice({ tone: 'error', error: classified });
    } finally {
      bindInFlight.current = false;
      setOperation('idle');
    }
  };

  const subscribe = async () => {
    if (subscribeInFlight.current) return;
    subscribeInFlight.current = true;
    setOperation('subscribing');
    setNotice(null);
    subscribeRequestKey.current ??= createLeaderIdRequestKey();
    try {
      const next = await client.subscribe(subscribeRequestKey.current);
      applyStatus(next);
      subscribeRequestKey.current = null;
      setNotice({
        tone: next.subscription.status === 'completed' ? 'success' : 'info',
        message: leaderIdSubscriptionSummary(next.subscription),
      });
    } catch (error) {
      setNotice({ tone: 'error', error: classifyLeaderIdError(error) });
    } finally {
      subscribeInFlight.current = false;
      setOperation('idle');
    }
  };

  const reopenAuthorization = async () => {
    if (status?.binding.status !== 'authorization_required') return;
    const authorizationUrl = safeAuthorizationUrl(status.binding.authorizationUrl);
    if (!authorizationUrl) {
      setNotice({
        tone: 'error',
        error: {
          kind: 'api',
          message: 'Ссылка авторизации недоступна. Обновите статус и попробуйте снова.',
          retryable: true,
        },
      });
      return;
    }
    try {
      await openAuthorization(authorizationUrl);
      setNotice({
        tone: 'info',
        message: 'Завершите вход в Leader-ID и вернитесь сюда — статус обновится автоматически.',
      });
    } catch (error) {
      setNotice({ tone: 'error', error: classifyLeaderIdError(error) });
    }
  };

  const openLeaderIdEvent = async (eventId: number) => {
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return;
    const eventUrl = safeAuthorizationUrl(`https://leader-id.ru/events/${eventId}`);
    if (!eventUrl) return;
    await openAuthorization(eventUrl);
  };

  const openLeaderIdRegistration = async () => {
    const registrationUrl = safeAuthorizationUrl(LEADER_ID_REGISTRATION_URL);
    if (!registrationUrl) return;
    try {
      await openAuthorization(registrationUrl);
    } catch (error) {
      setNotice({ tone: 'error', error: classifyLeaderIdError(error) });
    }
  };

  const inputError =
    notice?.tone === 'error' &&
    (notice.error.kind === 'invalid' || notice.error.kind === 'not_found');
  const rewardAmount = status ? rewardDisplayAmount(status.reward) : '';
  const rewardOfferAmount = status?.reward.awarded ? '' : rewardAmount;
  const subscription = status?.subscription;
  const isComplete = subscription?.status === 'completed';
  const hasSubscriptionResult =
    subscription?.status === 'completed' ||
    subscription?.status === 'partial' ||
    subscription?.status === 'failed';
  const canRetrySubscription = subscription ? canRetryLeaderIdSubscription(subscription) : false;
  const needsExternalAction = Boolean(
    subscription?.results?.some(leaderIdResultNeedsExternalAction),
  );
  const rootClassName = [styles.card, className].filter(Boolean).join(' ');

  if (!available) return null;

  return (
    <section className={rootClassName} aria-labelledby={titleId} aria-busy={operation !== 'idle'}>
      <div className={styles.accent} aria-hidden="true" />
      <header className={styles.header}>
        <span className={styles.mark} aria-hidden="true">
          ID
        </span>
        <div>
          <h2 id={titleId}>Leader-ID + Catalyst</h2>
          <p>
            Leader-ID подтверждает участие в событиях программы. Подключите его, чтобы получать
            возможности и бонусы Catalyst без повторных регистраций.
          </p>
        </div>
      </header>

      {operation === 'loading' && !status ? (
        <div className={styles.loading} role="status">
          <Spinner /> Проверяем подключение…
        </div>
      ) : null}

      {!status && operation !== 'loading' ? (
        <div className={styles.loadError} role="alert">
          <p>
            {notice?.tone === 'error'
              ? notice.error.message
              : 'Не удалось загрузить состояние Leader-ID.'}
          </p>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void loadStatus()}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {status?.binding.status === 'not_linked' ? (
        <form className={styles.form} onSubmit={submitBinding} noValidate>
          <label htmlFor={inputId}>Leader-ID</label>
          <div className={styles.inputRow}>
            <input
              id={inputId}
              name="leaderId"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={LEADER_ID_MAX_LENGTH}
              value={leaderId}
              aria-invalid={inputError}
              aria-describedby={`${helpId} ${feedbackId}`}
              placeholder="Введите номер"
              disabled={operation === 'binding'}
              onChange={(event) => {
                setLeaderId(event.target.value);
                bindRequestKey.current = null;
                if (notice?.tone === 'error') setNotice(null);
              }}
            />
            <button type="submit" disabled={operation === 'binding'}>
              {operation === 'binding' ? <Spinner /> : null}
              {operation === 'binding' ? 'Проверяем…' : 'Подтвердить'}
            </button>
          </div>
          <p id={helpId} className={styles.help}>
            Номер проверит сервер Leader-ID — одних цифр недостаточно для подтверждения.
          </p>
          {rewardAmount ? (
            <p className={styles.rewardHint}>После подключения доступна награда: +{rewardAmount}</p>
          ) : null}
          <div className={styles.registrationHelp}>
            <div>
              <strong>Ещё нет Leader-ID?</strong>
              <ol>
                <li>Подтвердите телефон.</li>
                <li>Заполните профиль Leader-ID.</li>
                <li>Вернитесь в Catalyst и введите номер выше.</li>
              </ol>
              <small>Аккаунт создаётся один раз. На события Catalyst подадим заявки здесь.</small>
            </div>
            <button type="button" onClick={() => void openLeaderIdRegistration()}>
              Зарегистрироваться в Leader-ID
              <ArrowIcon />
            </button>
          </div>
        </form>
      ) : null}

      {status?.binding.status === 'authorization_required' ? (
        <div className={styles.authorization}>
          <div className={styles.statusIcon}>
            <ArrowIcon />
          </div>
          <div>
            <strong>Завершите вход в Leader-ID</strong>
            <p>Авторизация нужна один раз. Для мероприятий повторный вход не потребуется.</p>
          </div>
          <div className={styles.authorizationActions}>
            <button
              type="button"
              className={styles.primaryCompactButton}
              onClick={() => void reopenAuthorization()}
            >
              Открыть Leader-ID
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void loadStatus()}
            >
              Проверить подключение
            </button>
          </div>
        </div>
      ) : null}

      {status?.binding.status === 'linked' ? (
        <div className={styles.linked}>
          <span>
            <CheckIcon />
          </span>
          <div>
            <strong>Leader-ID подключён</strong>
            <small>{status.binding.leaderId}</small>
          </div>
        </div>
      ) : null}

      {status?.binding.status === 'linked' && subscription?.status === 'not_started' ? (
        <div className={styles.offer}>
          <div>
            <h3>
              Подключитесь к Catalyst
              {rewardOfferAmount ? ` и получите +${rewardOfferAmount}` : ''}
            </h3>
            <p>Одним нажатием зарегистрируем вас на доступные мероприятия программы в Leader-ID.</p>
          </div>
          <button
            type="button"
            disabled={operation === 'subscribing'}
            onClick={() => void subscribe()}
          >
            {operation === 'subscribing' ? <Spinner /> : null}
            {operation === 'subscribing'
              ? 'Подключаем…'
              : rewardOfferAmount
                ? `Подключиться и получить +${rewardOfferAmount}`
                : 'Подключиться к Catalyst'}
          </button>
        </div>
      ) : null}

      {status?.binding.status === 'linked' && subscription?.status === 'processing' ? (
        <div className={styles.processing} role="status">
          <Spinner />
          <div>
            <strong>Подключаем мероприятия</strong>
            <p>{leaderIdSubscriptionSummary(subscription)}</p>
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void loadStatus()}
          >
            Обновить статус
          </button>
        </div>
      ) : null}

      {status?.binding.status === 'linked' && subscription && hasSubscriptionResult ? (
        <div className={isComplete ? styles.success : styles.partial}>
          <div className={styles.resultHeading}>
            <span>{subscription.status === 'failed' ? <ArrowIcon /> : <CheckIcon />}</span>
            <div>
              <strong>{leaderIdSubscriptionHeading(subscription)}</strong>
              <p>{leaderIdSubscriptionSummary(subscription)}</p>
            </div>
          </div>
          {status.reward.awarded && rewardAmount ? (
            <p className={styles.awarded}>+{rewardAmount} начислено</p>
          ) : null}
          <ResultDetails items={subscription.results ?? []} onOpenEvent={openLeaderIdEvent} />
          {canRetrySubscription || needsExternalAction ? (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={operation === 'subscribing'}
              onClick={() => void subscribe()}
            >
              {operation === 'subscribing' ? <Spinner /> : null}
              {operation === 'subscribing'
                ? 'Проверяем…'
                : needsExternalAction && !canRetrySubscription
                  ? 'Проверить после Leader-ID'
                  : 'Повторить для оставшихся'}
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        id={feedbackId}
        className={notice ? `${styles.notice} ${styles[notice.tone]}` : styles.feedbackSlot}
        role={notice ? (notice.tone === 'error' ? 'alert' : 'status') : undefined}
        aria-live={notice ? (notice.tone === 'error' ? 'assertive' : 'polite') : undefined}
      >
        {notice?.tone === 'error' ? notice.error.message : notice?.message}
      </div>
    </section>
  );
}
