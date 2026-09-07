'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { feedActionValidationError } from '@cpi/shared';
import { adminBroadcastQueuedMessage, enqueueAdminBroadcast } from '../lib/admin-broadcast';
import { api, uploadWithHeadersAndProgress } from '../lib/api';
import { formatNovosibirskDateTime, fromNovosibirskInput, toNovosibirskInput } from '../lib/dates';
import { getMessengerAdapter } from '../lib/messenger-adapter';
import type { EventArtifactForm, EventItem } from '../lib/types';
import type { WalletOrder, WalletProduct, WalletTransactionKind } from '../lib/wallet-types';
import { GiftIcon, QrIcon, ScanIcon, StoreIcon, TransferIcon } from './icons';
import { formatWalletAmount } from './wallet-program-context';
import { AdminBroadcastDialog } from './admin-broadcast-dialog';
import { HtmlDesignPreview } from './rich-html';

export type WalletAdminSectionName =
  | 'wallet-dashboard'
  | 'wallets'
  | 'wallet-transactions'
  | 'wallet-funds'
  | 'reward-rules'
  | 'products'
  | 'orders'
  | 'feed'
  | 'wallet-settings';

interface AdminWalletDashboard {
  circulatingBalance: string;
  creditedToday: string;
  debitedToday: string;
  activeWallets: number;
  pendingIntents: number;
  paidOrders: number;
  ledgerReconciled: boolean;
  ledgerMismatchAccounts: number;
  ledgerMismatchSample: Array<{
    accountId: string;
    cachedBalance: string;
    ledgerBalance: string;
  }>;
}

interface AdminWalletAccount {
  id: string;
  userId: string;
  displayName: string;
  telegramUsername: string | null;
  balance: string;
  status: 'active' | 'frozen' | 'closed';
  updatedAt: string;
}

interface AdminLedgerRow {
  id: string;
  kind: WalletTransactionKind;
  amount: string;
  direction: 'credit' | 'debit';
  userName: string;
  actorName: string | null;
  reason: string | null;
  createdAt: string;
  entries: Array<{
    id: number;
    accountId: string;
    accountTitle: string;
    delta: string;
    balanceAfter: string;
  }>;
}

interface AdminFeedPost {
  id: string;
  kind: 'news' | 'event' | 'product' | 'system';
  audience: 'all' | 'participants' | 'admins';
  title: string;
  summary: string | null;
  body: string;
  bodyFormat: 'text' | 'html';
  cardHtml: string | null;
  cardPackageId: string | null;
  coverUrl: string | null;
  coverStoredInS3?: boolean;
  ctaLabel: string | null;
  ctaUrl: string | null;
  pinned: boolean;
  status: 'draft' | 'published' | 'archived';
  publishedAt: string | null;
}

function formatPoints(value: string | number): string {
  return formatWalletAmount(value);
}

const transactionKindLabels: Record<WalletTransactionKind, string> = {
  welcome_grant: 'Приветственное начисление',
  p2p_transfer: 'Перевод участнику',
  staff_credit: 'Начисление сотрудником',
  staff_debit: 'Списание сотрудником',
  artifact_reward: 'Награда за артефакт',
  leader_id_subscription_reward: 'Награда за подключение Leader-ID',
  store_purchase: 'Покупка',
  admin_adjustment: 'Административная корректировка',
  season_opening: 'Открытие сезона',
  reversal: 'Обратная операция',
};

const productKindLabels: Record<NonNullable<WalletProduct['kind']>, string> = {
  physical: 'Физический',
  digital: 'Цифровой',
};

const productStatusLabels: Record<WalletProduct['status'], string> = {
  draft: 'Черновик',
  published: 'Опубликован',
  paused: 'На паузе',
  archived: 'Архив',
};

const orderStatusLabels: Record<WalletOrder['status'], string> = {
  paid: 'Оплачен',
  pickup_requested: 'Заявка на выдачу',
  ready_for_pickup: 'Готов к выдаче',
  fulfilled: 'Выдан',
};

const feedStatusLabels: Record<AdminFeedPost['status'], string> = {
  draft: 'Черновик',
  published: 'Опубликовано',
  archived: 'Архив',
};

function unavailableMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Раздел ещё подключается к серверу';
}

function BuilderHeader({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="wallet-admin-intro">
      <div>
        <p className="eyebrow">{kicker}</p>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
      <span aria-hidden="true">✦</span>
    </div>
  );
}

function EmptyAdminState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="wallet-admin-empty">
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function AdminWalletSection({ section }: { section: WalletAdminSectionName }) {
  if (section === 'wallet-dashboard') return <WalletDashboard />;
  if (section === 'wallets') return <WalletAccounts />;
  if (section === 'wallet-transactions') return <WalletTransactions />;
  if (section === 'wallet-funds') return <FundAccessBuilder />;
  if (section === 'reward-rules') return <RewardRuleBuilder />;
  if (section === 'products') return <ProductBuilder />;
  if (section === 'orders') return <OrdersBoard />;
  if (section === 'feed') return <FeedBuilder />;
  return <WalletSettings />;
}

function WalletDashboard() {
  const [data, setData] = useState<AdminWalletDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<AdminWalletDashboard>('/admin/wallet/dashboard')
      .then(setData)
      .catch((caught) => setError(unavailableMessage(caught)));
  }, []);

  const values = data ?? {
    circulatingBalance: '0',
    creditedToday: '0',
    debitedToday: '0',
    activeWallets: 0,
    pendingIntents: 0,
    paidOrders: 0,
    ledgerReconciled: true,
    ledgerMismatchAccounts: 0,
    ledgerMismatchSample: [],
  };
  return (
    <>
      <BuilderHeader kicker="Экономика программы" title="Баллы под контролем">
        Единый обзор выпуска, оборота, QR-намерений и заказов. Все изменения проходят через
        неизменяемый журнал.
      </BuilderHeader>
      {error ? (
        <div className="wallet-admin-status">
          Данные появятся после применения wallet-миграции. Интерфейс уже готов к контракту API.
        </div>
      ) : null}
      <div
        className={`wallet-ledger-health${values.ledgerReconciled ? '' : ' wallet-ledger-health--error'}`}
        role={values.ledgerReconciled ? 'status' : 'alert'}
      >
        <strong>
          {values.ledgerReconciled ? 'Ledger сверён' : 'Обнаружено расхождение ledger'}
        </strong>
        <span>
          {values.ledgerReconciled
            ? 'Кэшированные балансы совпадают с суммой проводок.'
            : `${values.ledgerMismatchAccounts} счетов требуют проверки. ${values.ledgerMismatchSample
                .map(
                  (item) =>
                    `${item.accountId.slice(0, 8)}: ${item.cachedBalance} / ${item.ledgerBalance}`,
                )
                .join(' · ')}`}
        </span>
      </div>
      <div className="stat-grid wallet-stat-grid">
        {[
          ['Баллов в обращении', formatPoints(values.circulatingBalance), 'pink'],
          ['Начислено сегодня', `+${formatPoints(values.creditedToday)}`, 'lime'],
          ['Списано сегодня', `−${formatPoints(values.debitedToday)}`, 'neutral'],
          ['Активных кошельков', values.activeWallets, 'neutral'],
          ['Ожидают подтверждения', values.pendingIntents, 'pink'],
          ['Заказов к выдаче', values.paidOrders, 'lime'],
        ].map(([label, value, tone]) => (
          <Card className={`stat-card wallet-stat-card wallet-stat-card--${tone}`} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </Card>
        ))}
      </div>
      <div className="wallet-admin-grid">
        <Card className="admin-form-card wallet-admin-explainer">
          <TransferIcon />
          <h2>Двойная запись</h2>
          <p>
            Баланс не редактируется напрямую. Начисление, списание, перевод и reset создают
            отдельную аудируемую операцию.
          </p>
        </Card>
        <Card className="admin-form-card wallet-admin-explainer">
          <QrIcon />
          <h2>Временные QR</h2>
          <p>
            Код одноразовый, быстро истекает и только открывает intent. Денежное действие требует
            отдельного подтверждения.
          </p>
        </Card>
        <Card className="admin-form-card wallet-admin-explainer">
          <StoreIcon />
          <h2>Заказы и выдача</h2>
          <p>
            После оплаты участник оставляет заявку, сотрудник готовит товар и подтверждает
            фактическую выдачу.
          </p>
        </Card>
      </div>
    </>
  );
}

function WalletAccounts() {
  const [items, setItems] = useState<AdminWalletAccount[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AdminWalletAccount | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [operation, setOperation] = useState<'credit' | 'debit'>('credit');
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api<{ items: AdminWalletAccount[] }>('/admin/wallet/accounts?limit=200')
      .then((result) => setItems(result.items))
      .catch(() => setItems([]));
  }, []);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? items.filter((item) =>
          `${item.displayName} ${item.telegramUsername ?? ''}`.toLowerCase().includes(needle),
        )
      : items;
  }, [items, query]);

  const adjust = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected?.userId) return;
    const numeric = Number(amount);
    if (!Number.isSafeInteger(numeric) || numeric <= 0 || reason.trim().length < 3)
      return setMessage('Укажите целое количество и понятную причину');
    setSaving(true);
    setMessage(null);
    try {
      await api('/admin/wallet/adjustments', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          userId: selected.userId,
          amount: operation === 'debit' ? -numeric : numeric,
          reason: reason.trim(),
        }),
      });
      setMessage('Операция создана и записана в журнал');
      setAmount('');
      setReason('');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <BuilderHeader kicker="Кошельки" title="Баланс каждого участника">
        Поиск, просмотр статуса и безопасная корректировка с обязательной причиной.
      </BuilderHeader>
      <div className="admin-toolbar">
        <input
          className="admin-search"
          aria-label="Поиск кошелька"
          placeholder="Имя или @username"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span>{visible.length} кошельков</span>
      </div>
      <Card className="admin-table-card">
        <div className="admin-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Пользователь / счёт</th>
                <th>Баланс</th>
                <th>Статус</th>
                <th>Обновлён</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.displayName}</strong>
                    <small>
                      {item.telegramUsername ? `@${item.telegramUsername}` : item.userId}
                    </small>
                  </td>
                  <td>
                    <strong>{formatPoints(item.balance)}</strong>
                  </td>
                  <td>
                    <span className={`wallet-admin-pill ${item.status}`}>
                      {item.status === 'active'
                        ? 'Активен'
                        : item.status === 'frozen'
                          ? 'Заморожен'
                          : 'Закрыт'}
                    </span>
                  </td>
                  <td>{formatNovosibirskDateTime(item.updatedAt)}</td>
                  <td>
                    {item.userId ? (
                      <button type="button" onClick={() => setSelected(item)}>
                        Операция
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 ? (
          <EmptyAdminState title="Кошельков пока нет">
            Кошельки появятся после запуска программы.
          </EmptyAdminState>
        ) : null}
      </Card>
      {selected ? (
        <Card className="admin-form-card wallet-adjustment-card">
          <div className="admin-section-heading">
            <div>
              <p className="eyebrow">Экстренная корректировка</p>
              <h2>{selected.displayName}</h2>
            </div>
            <button type="button" className="text-button" onClick={() => setSelected(null)}>
              Закрыть
            </button>
          </div>
          <div className="notice error">
            Это административная операция без подтверждения владельца. Для обычного начисления или
            списания используйте доступ к фонду и временный QR.
          </div>
          <form className="admin-form" onSubmit={adjust}>
            <label>
              <span>Направление</span>
              <select
                value={operation}
                onChange={(event) => setOperation(event.target.value as typeof operation)}
              >
                <option value="credit">Экстренно увеличить</option>
                <option value="debit">Экстренно уменьшить</option>
              </select>
            </label>
            <label>
              <span>Количество баллов</span>
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                required
              />
            </label>
            <label className="admin-wide">
              <span>Причина *</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                minLength={5}
                maxLength={500}
                required
              />
            </label>
            {message ? <div className="notice info admin-wide">{message}</div> : null}
            <Button type="submit" className="danger-button compact-button" disabled={saving}>
              {saving ? 'Создаём…' : 'Создать корректировку'}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}

function WalletTransactions() {
  const [items, setItems] = useState<AdminLedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void api<{ items: AdminLedgerRow[] }>('/admin/wallet/transactions?limit=200')
      .then((result) => setItems(result.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);
  return (
    <>
      <BuilderHeader kicker="Ledger" title="Журнал операций">
        Начисления, списания, переводы и покупки без возможности тихого редактирования задним
        числом.
      </BuilderHeader>
      <Card className="admin-table-card">
        {loading ? (
          <div className="admin-loading">
            <Spinner />
          </div>
        ) : (
          <div className="admin-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Пользователь</th>
                  <th>Операция</th>
                  <th>Проводки</th>
                  <th>Причина</th>
                  <th>Автор</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{formatNovosibirskDateTime(item.createdAt)}</td>
                    <td>{item.userName}</td>
                    <td>
                      {transactionKindLabels[item.kind]}{' '}
                      <small
                        className={item.direction === 'debit' ? 'wallet-debit' : 'wallet-credit'}
                      >
                        {item.direction === 'debit' ? '−' : '+'}
                        {formatPoints(item.amount)}
                      </small>
                    </td>
                    <td>
                      {item.entries.map((entry) => (
                        <small
                          key={entry.id}
                          className={entry.delta.startsWith('-') ? 'wallet-debit' : 'wallet-credit'}
                        >
                          {entry.accountTitle}: {entry.delta.startsWith('-') ? '−' : '+'}
                          {formatPoints(entry.delta.replace(/^-/, ''))}
                        </small>
                      ))}
                    </td>
                    <td>{item.reason ?? '—'}</td>
                    <td>{item.actorName ?? 'Система'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && items.length === 0 ? (
          <EmptyAdminState title="Операций пока нет">
            Первой записью станет стартовое начисление нового сезона.
          </EmptyAdminState>
        ) : null}
      </Card>
    </>
  );
}

function FundAccessBuilder() {
  const [users, setUsers] = useState<
    Array<{
      id: string;
      fullName: string | null;
      telegramUsername: string | null;
    }>
  >([]);
  const [accessItems, setAccessItems] = useState<
    Array<{
      userId: string;
      canCredit: boolean;
      canDebit: boolean;
      canView: boolean;
    }>
  >([]);
  const [query, setQuery] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [credit, setCredit] = useState(false);
  const [debit, setDebit] = useState(false);
  const [view, setView] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void api<{
      items: Array<{
        userId: string;
        canCredit: boolean;
        canDebit: boolean;
        canView: boolean;
      }>;
    }>('/admin/wallet/fund-access')
      .then((result) => setAccessItems(result.items))
      .catch(() => setAccessItems([]));
  }, []);
  useEffect(() => {
    const parameters = new URLSearchParams({ limit: '100' });
    if (query) parameters.set('q', query);
    const timer = window.setTimeout(
      () =>
        void api<{
          items: Array<{
            id: string;
            fullName: string | null;
            telegramUsername: string | null;
          }>;
        }>(`/admin/users?${parameters}`)
          .then((result) => setUsers(result.items))
          .catch(() => setUsers([])),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!selectedUserId) return;
    const access = accessItems.find((item) => item.userId === selectedUserId);
    setCredit(access?.canCredit ?? false);
    setDebit(access?.canDebit ?? false);
    setView(access?.canView ?? false);
  }, [accessItems, selectedUserId]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    try {
      await api(`/admin/wallet/fund-access/${encodeURIComponent(selectedUserId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          canCredit: credit,
          canDebit: debit,
          canView: view,
        }),
      });
      setAccessItems((items) => [
        ...items.filter((item) => item.userId !== selectedUserId),
        {
          userId: selectedUserId,
          canCredit: credit,
          canDebit: debit,
          canView: view,
        },
      ]);
      setMessage('Права доступа сохранены');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    }
  };
  const revoke = async () => {
    if (!selectedUserId) return;
    setMessage(null);
    try {
      await api(`/admin/wallet/fund-access/${encodeURIComponent(selectedUserId)}`, {
        method: 'DELETE',
      });
      setAccessItems((items) => items.filter((item) => item.userId !== selectedUserId));
      setCredit(false);
      setDebit(false);
      setView(false);
      setMessage('Доступ отозван');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    }
  };
  return (
    <>
      <BuilderHeader kicker="Доступ к фонду" title="Назначить сотрудника">
        Выберите существующего пользователя и выдайте только необходимые права. Доступ действует в
        рамках программы и не создаёт отдельный QR или аккаунт.
      </BuilderHeader>
      <Card className="admin-form-card">
        <form className="admin-form" onSubmit={save}>
          <label className="admin-wide">
            <span>Поиск пользователя</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ФИО или @username"
            />
          </label>
          <label className="admin-wide">
            <span>Пользователь</span>
            <select
              value={selectedUserId}
              onChange={(event) => setSelectedUserId(event.target.value)}
              required
            >
              <option value="">Выберите пользователя</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.fullName || 'Профиль не заполнен'}
                  {user.telegramUsername ? ` · @${user.telegramUsername}` : ''}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="admin-wide wallet-permissions">
            <legend>Права</legend>
            <label>
              <input
                type="checkbox"
                checked={credit}
                onChange={(event) => setCredit(event.target.checked)}
              />{' '}
              Начислять после сканирования QR
            </label>
            <label>
              <input
                type="checkbox"
                checked={debit}
                onChange={(event) => setDebit(event.target.checked)}
              />{' '}
              Запрашивать списание с подтверждением владельца
            </label>
            <label>
              <input
                type="checkbox"
                checked={view}
                onChange={(event) => setView(event.target.checked)}
              />{' '}
              Смотреть фонд и операции
            </label>
          </fieldset>
          {message ? <div className="notice info admin-wide">{message}</div> : null}
          <div className="row-actions admin-wide">
            <Button
              type="submit"
              className="primary-button compact-button"
              disabled={!selectedUserId || (!credit && !debit && !view)}
            >
              Сохранить права
            </Button>
            <Button
              type="button"
              className="danger-text-button"
              disabled={!selectedUserId}
              onClick={revoke}
            >
              Отозвать все
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function RewardRuleBuilder() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [eventId, setEventId] = useState('');
  const [amount, setAmount] = useState('100');
  const [enabled, setEnabled] = useState(true);
  const [manual, setManual] = useState(false);
  const [validFrom, setValidFrom] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [reconcilePreview, setReconcilePreview] = useState<{
    eventId: string;
    eligibleUsers: number;
    eligibleSubmissions: number;
    alreadyRewarded: number;
    amountEach: string;
  } | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selectedEventIdRef = useRef('');
  const selectEvent = (nextEventId: string) => {
    selectedEventIdRef.current = nextEventId;
    setEventId(nextEventId);
    setReconcilePreview(null);
    setMessage(null);
  };
  useEffect(() => {
    void api<{ items: EventItem[] }>('/admin/events?limit=100')
      .then((result) => {
        setEvents(result.items);
        if (!selectedEventIdRef.current) selectEvent(result.items[0]?.id ?? '');
      })
      .catch(() => setEvents([]));
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    try {
      await api(`/admin/events/${encodeURIComponent(eventId)}/reward-policy`, {
        method: 'PUT',
        body: JSON.stringify({
          amount: Number(amount),
          enabled,
          requiresManualApproval: manual,
          validFrom: validFrom ? fromNovosibirskInput(validFrom) : null,
          validUntil: validUntil ? fromNovosibirskInput(validUntil) : null,
        }),
      });
      setMessage('Правило награды сохранено');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    }
  };
  const reconcile = async (execute: boolean) => {
    if (!eventId || reconciling) return;
    if (execute && reconcilePreview?.eventId !== eventId) {
      setReconcilePreview(null);
      setMessage('Сначала заново проверьте прошлые артефакты для выбранного мероприятия.');
      return;
    }
    const requestedEventId = eventId;
    setReconciling(true);
    setMessage(null);
    try {
      const result = await api<{
        eligibleUsers: number;
        eligibleSubmissions: number;
        alreadyRewarded: number;
        amountEach: string;
        granted?: number;
        skipped?: number;
      }>(`/admin/events/${encodeURIComponent(requestedEventId)}/rewards/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ execute }),
      });
      if (selectedEventIdRef.current !== requestedEventId) return;
      if (execute) {
        setReconcilePreview(null);
        setMessage(
          `Начисление завершено: ${result.granted ?? 0}; пропущено: ${result.skipped ?? 0}.`,
        );
      } else {
        setReconcilePreview({ ...result, eventId: requestedEventId });
        setMessage(
          `Предпросмотр: ${result.eligibleUsers} участников, ${result.eligibleSubmissions} готовых артефактов, по ${formatPoints(result.amountEach)}. Уже получили награду: ${result.alreadyRewarded}.`,
        );
      }
    } catch (caught) {
      if (selectedEventIdRef.current === requestedEventId) {
        setMessage(unavailableMessage(caught));
      }
    } finally {
      setReconciling(false);
    }
  };
  return (
    <>
      <BuilderHeader kicker="Мероприятия + артефакты" title="Конструктор наград">
        Начисление срабатывает по событию artifact_ready и не чаще одного раза на участника в рамках
        мероприятия.
      </BuilderHeader>
      <Card className="admin-form-card">
        <form className="admin-form" onSubmit={save}>
          <label>
            <span>Мероприятие</span>
            <select value={eventId} onChange={(event) => selectEvent(event.target.value)} required>
              <option value="">Выберите событие</option>
              {events.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Награда</span>
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              required
            />
          </label>
          <label>
            <span>Действует с</span>
            <input
              type="datetime-local"
              value={validFrom}
              onChange={(event) => setValidFrom(event.target.value)}
            />
          </label>
          <label>
            <span>Действует до</span>
            <input
              type="datetime-local"
              value={validUntil}
              onChange={(event) => setValidUntil(event.target.value)}
            />
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>Правило включено</span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={manual}
              onChange={(event) => setManual(event.target.checked)}
            />
            <span>Требовать ручное одобрение</span>
          </label>
          <div className="timezone-banner admin-wide">
            <strong>Только готовый физический файл</strong>
            <span>
              Награда возникает после статуса artifact_ready. Текст или ссылка без загруженного
              файла не подходят; повторы защищены idempotency.
            </span>
          </div>
          {message ? <div className="notice info admin-wide">{message}</div> : null}
          <div className="row-actions admin-wide">
            <Button type="submit" className="primary-button compact-button" disabled={!eventId}>
              <GiftIcon /> Сохранить правило
            </Button>
            <Button
              type="button"
              className="secondary-button compact-button"
              disabled={!eventId || reconciling}
              onClick={() => reconcile(false)}
            >
              Проверить прошлые артефакты
            </Button>
            {reconcilePreview?.eventId === eventId && reconcilePreview.eligibleUsers > 0 ? (
              <Button
                type="button"
                className="danger-button compact-button"
                disabled={reconciling}
                onClick={() => reconcile(true)}
              >
                Начислить {reconcilePreview.eligibleUsers} участникам
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
      <ArtifactFormBuilder key={eventId || 'no-event'} eventId={eventId} />
    </>
  );
}

type ArtifactFieldDraft = {
  id: string;
  code: string;
  label: string;
  description: string;
  kind:
    'checkbox' | 'text' | 'link' | 'file' | 'image' | 'document' | 'audio' | 'video' | 'archive';
  required: boolean;
  minItems: string;
  maxItems: string;
  minLength: string;
  maxLength: string;
  mimeTypes: string;
  extensions: string;
  maxFileSizeMb: string;
};

function blankArtifactField(index: number): ArtifactFieldDraft {
  return {
    id: crypto.randomUUID(),
    code: `field_${index + 1}`,
    label: 'Новое поле',
    description: '',
    kind: 'text',
    required: false,
    minItems: '0',
    maxItems: '1',
    minLength: '0',
    maxLength: '50000',
    mimeTypes: '',
    extensions: '',
    maxFileSizeMb: '50',
  };
}

function artifactFieldDrafts(form: EventArtifactForm): ArtifactFieldDraft[] {
  return form.fields.map((field) => ({
    id: field.id,
    code: field.code,
    label: field.label,
    description: field.description ?? '',
    kind: field.kind,
    required: field.required,
    minItems: String(field.minItems),
    maxItems: String(field.maxItems),
    minLength: String(field.config.minLength ?? 0),
    maxLength: String(field.config.maxLength ?? 50_000),
    mimeTypes: field.allowedMimeTypes.join(', '),
    extensions: field.allowedExtensions.join(', '),
    maxFileSizeMb: field.maxFileSizeBytes
      ? String(Math.ceil(field.maxFileSizeBytes / 1024 / 1024))
      : '50',
  }));
}

function ArtifactFormBuilder({ eventId }: { eventId: string }) {
  const [versions, setVersions] = useState<EventArtifactForm[]>([]);
  const [selectedFormId, setSelectedFormId] = useState<string | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [versionsLoadFailed, setVersionsLoadFailed] = useState(false);
  const [savingForm, setSavingForm] = useState(false);
  const [title, setTitle] = useState('Форма артефакта');
  const [instructions, setInstructions] = useState('Заполните поля и приложите материалы.');
  const [submitButtonLabel, setSubmitButtonLabel] = useState('Отправить артефакт');
  const [fields, setFields] = useState<ArtifactFieldDraft[]>([blankArtifactField(0)]);
  const [publish, setPublish] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const selectedVersion = versions.find((version) => version.id === selectedFormId) ?? null;
  const readOnly = Boolean(selectedVersion && selectedVersion.status !== 'draft');
  const editorDisabled =
    !eventId || loadingVersions || versionsLoadFailed || savingForm || readOnly;

  const resetEditor = () => {
    setVersions([]);
    setSelectedFormId(null);
    setTitle('Форма артефакта');
    setInstructions('Заполните поля и приложите материалы.');
    setSubmitButtonLabel('Отправить артефакт');
    setFields([blankArtifactField(0)]);
    setPublish(false);
  };

  const selectVersion = (form: EventArtifactForm) => {
    setSelectedFormId(form.id);
    setTitle(form.title);
    setInstructions(form.instructions ?? '');
    setSubmitButtonLabel(form.submitButtonLabel);
    setFields(artifactFieldDrafts(form));
    setPublish(false);
    setMessage(null);
  };

  const reloadVersions = async (preferredId?: string) => {
    const generation = ++loadGenerationRef.current;
    resetEditor();
    setMessage(null);
    setVersionsLoadFailed(false);
    if (!eventId) {
      return;
    }
    setLoadingVersions(true);
    try {
      const result = await api<{ items: EventArtifactForm[] }>(
        `/admin/events/${encodeURIComponent(eventId)}/forms`,
      );
      if (generation !== loadGenerationRef.current) return;
      setVersions(result.items);
      const preferred =
        result.items.find((item) => item.id === preferredId) ??
        result.items.find((item) => item.status === 'draft') ??
        result.items[0];
      if (preferred) selectVersion(preferred);
      else resetEditor();
    } catch (caught) {
      if (generation !== loadGenerationRef.current) return;
      resetEditor();
      setVersionsLoadFailed(true);
      setMessage(unavailableMessage(caught));
    } finally {
      if (generation === loadGenerationRef.current) setLoadingVersions(false);
    }
  };

  useEffect(() => {
    void reloadVersions();
  }, [eventId]);

  const startNewVersion = (copyCurrent: boolean) => {
    setSelectedFormId(null);
    if (!copyCurrent) {
      setTitle('Форма артефакта');
      setInstructions('Заполните поля и приложите материалы.');
      setSubmitButtonLabel('Отправить артефакт');
      setFields([blankArtifactField(0)]);
    } else {
      setFields((items) => items.map((item) => ({ ...item, id: crypto.randomUUID() })));
    }
    setPublish(false);
    setMessage(copyCurrent ? 'Создаётся новая версия на основе выбранной' : null);
  };
  const updateField = (id: string, patch: Partial<ArtifactFieldDraft>) =>
    setFields((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  const move = (index: number, offset: -1 | 1) =>
    setFields((items) => {
      const target = index + offset;
      if (target < 0 || target >= items.length) return items;
      const next = [...items];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  const save = async () => {
    if (savingForm || loadingVersions || versionsLoadFailed) return;
    if (!eventId) return setMessage('Сначала выберите мероприятие');
    if (readOnly) return setMessage('Опубликованная версия неизменяема. Создайте новую версию.');
    if (fields.some((field) => !/^[a-z][a-z0-9_]*$/.test(field.code)))
      return setMessage(
        'Код каждого поля должен начинаться с латинской буквы и содержать только a–z, 0–9, _.',
      );
    setMessage(null);
    setSavingForm(true);
    try {
      const target =
        selectedVersion?.status === 'draft'
          ? `/admin/events/${encodeURIComponent(eventId)}/forms/${encodeURIComponent(selectedVersion.id)}`
          : `/admin/events/${encodeURIComponent(eventId)}/forms`;
      const form = await api<EventArtifactForm>(target, {
        method: selectedVersion?.status === 'draft' ? 'PUT' : 'POST',
        body: JSON.stringify({
          title,
          instructions: instructions || null,
          submitButtonLabel,
          fields: fields.map((field, order) => ({
            code: field.code,
            label: field.label,
            description: field.description || null,
            kind: field.kind,
            required: field.required,
            minItems: Number(field.minItems || 0),
            maxItems: Number(field.maxItems || 1),
            allowedMimeTypes: field.mimeTypes
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
            allowedExtensions: field.extensions
              .split(',')
              .map((value) => value.trim().replace(/^\./, ''))
              .filter(Boolean),
            maxFileSizeBytes: ['file', 'image', 'document', 'audio', 'video', 'archive'].includes(
              field.kind,
            )
              ? Number(field.maxFileSizeMb || 0) * 1024 * 1024
              : null,
            sortOrder: order,
            config:
              field.kind === 'text' || field.kind === 'link'
                ? {
                    minLength: Number(field.minLength || 0),
                    maxLength: Number(field.maxLength || 50000),
                  }
                : {},
          })),
        }),
      });
      if (publish)
        await api(
          `/admin/events/${encodeURIComponent(eventId)}/forms/${encodeURIComponent(form.id)}/publish`,
          { method: 'POST', body: JSON.stringify({}) },
        );
      await reloadVersions(form.id);
      setMessage(
        publish
          ? `Версия ${form.version} опубликована`
          : `Черновик версии ${form.version} сохранён`,
      );
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    } finally {
      setSavingForm(false);
    }
  };
  return (
    <Card className="admin-form-card artifact-builder">
      <div className="admin-section-heading">
        <div>
          <p className="eyebrow">Форма артефакта</p>
          <h2>{selectedVersion ? `Версия ${selectedVersion.version}` : 'Новая версия'}</h2>
        </div>
        <Button
          type="button"
          className="secondary-button compact-button"
          disabled={editorDisabled}
          onClick={() => setFields((items) => [...items, blankArtifactField(items.length)])}
        >
          Добавить поле
        </Button>
      </div>
      <div className="artifact-version-toolbar">
        <div>
          {loadingVersions ? (
            <Spinner />
          ) : (
            versions.map((version) => (
              <button
                type="button"
                key={version.id}
                className={selectedFormId === version.id ? 'active' : ''}
                onClick={() => selectVersion(version)}
              >
                v{version.version} ·{' '}
                {version.status === 'published'
                  ? 'опубликована'
                  : version.status === 'draft'
                    ? 'черновик'
                    : 'архив'}
              </button>
            ))
          )}
        </div>
        <span>
          <button
            type="button"
            disabled={loadingVersions || savingForm || versionsLoadFailed || !eventId}
            onClick={() => startNewVersion(Boolean(selectedVersion))}
          >
            {selectedVersion ? 'Создать новую из этой' : 'Новая версия'}
          </button>
          {selectedVersion ? (
            <button
              type="button"
              disabled={loadingVersions || savingForm || versionsLoadFailed}
              onClick={() => startNewVersion(false)}
            >
              С чистого листа
            </button>
          ) : null}
        </span>
      </div>
      {readOnly ? (
        <div className="wallet-admin-status">
          Опубликованные и архивные версии доступны только для чтения. Для изменений создайте новую
          версию.
        </div>
      ) : null}
      {versionsLoadFailed ? (
        <Button
          type="button"
          className="secondary-button compact-button"
          disabled={loadingVersions}
          onClick={() => void reloadVersions()}
        >
          Повторить загрузку формы
        </Button>
      ) : null}
      <fieldset className="artifact-form-editor" disabled={editorDisabled}>
        <div className="admin-form">
          <label>
            <span>Название формы</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            <span>Текст кнопки</span>
            <input
              value={submitButtonLabel}
              onChange={(event) => setSubmitButtonLabel(event.target.value)}
            />
          </label>
          <label className="admin-wide">
            <span>Инструкция</span>
            <textarea
              rows={3}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
        </div>
        <div className="artifact-field-list">
          {fields.map((field, index) => (
            <fieldset key={field.id} className="artifact-field-card">
              <legend>Поле {index + 1}</legend>
              <div className="artifact-field-toolbar">
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0}>
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === fields.length - 1}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setFields((items) => items.filter((item) => item.id !== field.id))}
                  disabled={fields.length === 1}
                >
                  Удалить
                </button>
              </div>
              <label>
                <span>Подпись</span>
                <input
                  value={field.label}
                  onChange={(event) => updateField(field.id, { label: event.target.value })}
                />
              </label>
              <label>
                <span>Код</span>
                <input
                  value={field.code}
                  onChange={(event) =>
                    updateField(field.id, {
                      code: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''),
                    })
                  }
                />
              </label>
              <label className="admin-wide">
                <span>Подсказка</span>
                <input
                  value={field.description}
                  onChange={(event) => updateField(field.id, { description: event.target.value })}
                />
              </label>
              <label>
                <span>Тип</span>
                <select
                  value={field.kind}
                  onChange={(event) =>
                    updateField(field.id, {
                      kind: event.target.value as ArtifactFieldDraft['kind'],
                    })
                  }
                >
                  <option value="checkbox">Флажок</option>
                  <option value="text">Текст</option>
                  <option value="link">Ссылка</option>
                  <option value="file">Любой файл</option>
                  <option value="image">Изображение</option>
                  <option value="document">Документ</option>
                  <option value="audio">Аудио</option>
                  <option value="video">Видео</option>
                  <option value="archive">Архив</option>
                </select>
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(event) => updateField(field.id, { required: event.target.checked })}
                />
                <span>Обязательное</span>
              </label>
              {field.kind === 'text' || field.kind === 'link' ? (
                <>
                  <label>
                    <span>Минимум символов</span>
                    <input
                      value={field.minLength}
                      onChange={(event) =>
                        updateField(field.id, {
                          minLength: event.target.value.replace(/\D/g, ''),
                        })
                      }
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    <span>Максимум символов</span>
                    <input
                      value={field.maxLength}
                      onChange={(event) =>
                        updateField(field.id, {
                          maxLength: event.target.value.replace(/\D/g, ''),
                        })
                      }
                      inputMode="numeric"
                    />
                  </label>
                </>
              ) : null}
              {['file', 'image', 'document', 'audio', 'video', 'archive'].includes(field.kind) ? (
                <>
                  <label>
                    <span>Минимум файлов</span>
                    <input
                      value={field.minItems}
                      onChange={(event) =>
                        updateField(field.id, {
                          minItems: event.target.value.replace(/\D/g, ''),
                        })
                      }
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    <span>Максимум файлов</span>
                    <input
                      value={field.maxItems}
                      onChange={(event) =>
                        updateField(field.id, {
                          maxItems: event.target.value.replace(/\D/g, ''),
                        })
                      }
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    <span>MIME через запятую</span>
                    <input
                      value={field.mimeTypes}
                      onChange={(event) => updateField(field.id, { mimeTypes: event.target.value })}
                      placeholder="image/png, application/pdf"
                    />
                  </label>
                  <label>
                    <span>Расширения</span>
                    <input
                      value={field.extensions}
                      onChange={(event) =>
                        updateField(field.id, {
                          extensions: event.target.value,
                        })
                      }
                      placeholder="png, pdf"
                    />
                  </label>
                  <label>
                    <span>Макс. размер, МБ</span>
                    <input
                      value={field.maxFileSizeMb}
                      onChange={(event) =>
                        updateField(field.id, {
                          maxFileSizeMb: event.target.value.replace(/\D/g, ''),
                        })
                      }
                      inputMode="numeric"
                    />
                  </label>
                </>
              ) : null}
            </fieldset>
          ))}
        </div>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={publish}
            onChange={(event) => setPublish(event.target.checked)}
          />
          <span>Сразу опубликовать эту версию</span>
        </label>
      </fieldset>
      {message ? <div className="notice info">{message}</div> : null}
      <Button
        type="button"
        className="primary-button compact-button"
        disabled={editorDisabled}
        onClick={save}
      >
        {savingForm
          ? 'Сохраняем…'
          : publish
            ? 'Опубликовать версию'
            : selectedVersion
              ? 'Обновить черновик'
              : 'Сохранить черновик'}
      </Button>
    </Card>
  );
}

type AdminProductMedia = {
  id: string;
  productId: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  contentType?: string | null;
  sizeBytes?: number | null;
};
type AdminStoreProduct = WalletProduct & {
  sortOrder?: number;
  inventory?: { onHand: number; reserved: number } | null;
};
type AdminStoreCategory = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  sortOrder: number;
  active: boolean;
};
type MediaUploadStatus = 'queued' | 'uploading' | 'done' | 'error';
type MediaDraft = {
  id: string;
  file: File;
  previewUrl: string;
  altText: string;
  sortOrder: string;
  status: MediaUploadStatus;
  progress: number;
  error: string | null;
  mediaId: string | null;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
};
type ProductMediaUploadInit = {
  mediaId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSeconds: number;
};

const PRODUCT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

function normalizeProductImageType(type: string): MediaDraft['contentType'] | null {
  if (type === 'image/jpg' || type === 'image/jpeg') return 'image/jpeg';
  if (type === 'image/png' || type === 'image/webp') return type;
  return null;
}

function revokeMediaDrafts(drafts: MediaDraft[]): void {
  for (const draft of drafts) URL.revokeObjectURL(draft.previewUrl);
}

function productThumbnail(product: AdminStoreProduct): string | null {
  return product.media?.[0]?.url ?? product.coverUrl ?? product.imageUrl ?? null;
}

const mediaStatusLabels: Record<MediaUploadStatus, string> = {
  queued: 'Готово к загрузке',
  uploading: 'Загружаем',
  done: 'Загружено',
  error: 'Нужна повторная попытка',
};

function ProductMediaDropzone({
  drafts,
  onFiles,
  onChange,
  onRemove,
  onUpload,
  disabled = false,
  title = 'Изображения товара',
}: {
  drafts: MediaDraft[];
  onFiles: (files: File[]) => void;
  onChange: (id: string, patch: Partial<Pick<MediaDraft, 'altText' | 'sortOrder'>>) => void;
  onRemove: (id: string) => void;
  onUpload?: (draft: MediaDraft) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const receiveFiles = (files: FileList | File[]) => onFiles(Array.from(files));
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) receiveFiles(event.dataTransfer.files);
  };

  return (
    <fieldset className="admin-wide product-media-uploader" disabled={disabled}>
      <legend>{title}</legend>
      <label
        className={`product-media-dropzone${dragging ? ' is-dragging' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <span className="product-media-dropzone-icon" aria-hidden="true">
          ↥
        </span>
        <strong>Загрузить изображение</strong>
        <small>Перетащите сюда или выберите JPG, PNG, WebP · до 10 МБ</small>
        <input
          className="product-media-file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={(event) => {
            if (event.target.files) receiveFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </label>
      {drafts.length ? (
        <div className="product-media-upload-list" aria-live="polite">
          {drafts.map((draft, index) => (
            <article key={draft.id} data-status={draft.status}>
              <img src={draft.previewUrl} alt="" />
              <div className="product-media-upload-copy">
                <strong>{draft.file.name}</strong>
                <small>
                  {(draft.file.size / 1024 / 1024).toFixed(1)} МБ ·{' '}
                  {draft.status === 'uploading'
                    ? `${mediaStatusLabels[draft.status]} ${draft.progress}%`
                    : draft.error || mediaStatusLabels[draft.status]}
                </small>
                <progress
                  max={100}
                  value={draft.progress}
                  aria-label={`Загрузка ${draft.file.name}: ${draft.progress}%`}
                />
              </div>
              <label>
                <span>Alt-текст</span>
                <input
                  aria-label={`Alt изображения ${index + 1}`}
                  value={draft.altText}
                  disabled={draft.status === 'uploading' || draft.status === 'done'}
                  onChange={(event) => onChange(draft.id, { altText: event.target.value })}
                  placeholder="Что изображено"
                />
              </label>
              <label>
                <span>Порядок</span>
                <input
                  aria-label={`Порядок изображения ${index + 1}`}
                  value={draft.sortOrder}
                  disabled={draft.status === 'uploading' || draft.status === 'done'}
                  onChange={(event) =>
                    onChange(draft.id, {
                      sortOrder: event.target.value.replace(/\D/g, ''),
                    })
                  }
                  inputMode="numeric"
                />
              </label>
              <div className="product-media-upload-actions">
                {onUpload && (draft.status === 'queued' || draft.status === 'error') ? (
                  <button type="button" onClick={() => onUpload(draft)}>
                    {draft.status === 'error' ? 'Повторить' : 'Загрузить'}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={draft.status === 'uploading'}
                  onClick={() => onRemove(draft.id)}
                >
                  {draft.status === 'done' ? 'Скрыть' : 'Убрать'}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {!onUpload && drafts.some((draft) => draft.status === 'queued') ? (
        <p className="product-media-upload-hint">Файлы загрузятся после создания товара.</p>
      ) : null}
    </fieldset>
  );
}

function ProductBuilder() {
  const [products, setProducts] = useState<AdminStoreProduct[]>([]);
  const [categories, setCategories] = useState<AdminStoreCategory[]>([]);
  const [form, setForm] = useState({
    categoryId: '',
    slug: '',
    title: '',
    description: '',
    descriptionFormat: 'text' as 'text' | 'html',
    cardHtml: '',
    cardPackageId: null as string | null,
    kind: 'physical' as NonNullable<WalletProduct['kind']>,
    status: 'draft' as WalletProduct['status'],
    price: '100',
    stockMode: 'limited' as NonNullable<WalletProduct['stockMode']>,
    stock: '0',
    perUserLimit: '1',
    availableFrom: '',
    availableUntil: '',
    pickupInstructions: '',
    sortOrder: '0',
  });
  const [mediaDrafts, setMediaDrafts] = useState<MediaDraft[]>([]);
  const [galleryDrafts, setGalleryDrafts] = useState<MediaDraft[]>([]);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [inventoryDelta, setInventoryDelta] = useState('');
  const [inventoryReason, setInventoryReason] = useState('');
  const [categoryDraft, setCategoryDraft] = useState({ title: '', slug: '' });
  const [mediaProductId, setMediaProductId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [broadcastingProductId, setBroadcastingProductId] = useState<string | null>(null);
  const [broadcastProductCandidate, setBroadcastProductCandidate] =
    useState<AdminStoreProduct | null>(null);

  useEffect(() => {
    void Promise.all([
      api<{ items: AdminStoreProduct[] }>('/admin/store/products?limit=100'),
      api<{ items: AdminStoreCategory[] }>('/admin/store/categories'),
    ])
      .then(([productResult, categoryResult]) => {
        setProducts(productResult.items);
        setCategories(categoryResult.items);
      })
      .catch(() => {
        setProducts([]);
        setCategories([]);
      });
  }, []);

  const resetProductEditor = () => {
    setEditingProductId(null);
    setForm({
      categoryId: '',
      slug: '',
      title: '',
      description: '',
      descriptionFormat: 'text',
      cardHtml: '',
      cardPackageId: null,
      kind: 'physical',
      status: 'draft',
      price: '100',
      stockMode: 'limited',
      stock: '0',
      perUserLimit: '1',
      availableFrom: '',
      availableUntil: '',
      pickupInstructions: '',
      sortOrder: '0',
    });
    setMediaDrafts((items) => {
      revokeMediaDrafts(items);
      return [];
    });
    setInventoryDelta('');
    setInventoryReason('');
  };

  const editProduct = (product: AdminStoreProduct) => {
    setEditingProductId(product.id);
    setForm({
      categoryId: product.categoryId ?? product.category?.id ?? '',
      slug: product.slug ?? '',
      title: product.title,
      description: product.description ?? '',
      descriptionFormat: product.descriptionFormat ?? 'text',
      cardHtml: product.cardHtml ?? '',
      cardPackageId: product.cardPackageId ?? null,
      kind: product.kind ?? 'physical',
      status: product.kind === 'digital' ? 'draft' : product.status,
      price: product.price,
      stockMode: product.stockMode ?? 'limited',
      stock: String(product.stock ?? 0),
      perUserLimit: product.perUserLimit ? String(product.perUserLimit) : '',
      availableFrom: product.availableFrom ? toNovosibirskInput(product.availableFrom) : '',
      availableUntil: product.availableUntil ? toNovosibirskInput(product.availableUntil) : '',
      pickupInstructions: product.pickupInstructions ?? '',
      sortOrder: String(product.sortOrder ?? 0),
    });
    setMediaDrafts((items) => {
      revokeMediaDrafts(items);
      return [];
    });
    setInventoryDelta('');
    setInventoryReason('');
    setMessage(`Редактирование: ${product.title}`);
    document.querySelector('.wallet-product-editor')?.scrollIntoView({ behavior: 'smooth' });
  };

  const broadcastProduct = async (product: AdminStoreProduct) => {
    if (broadcastingProductId) return;
    setBroadcastingProductId(product.id);
    setMessage(null);
    try {
      const result = await enqueueAdminBroadcast('product', product.id);
      setMessage(adminBroadcastQueuedMessage(product.title, result));
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    } finally {
      setBroadcastingProductId(null);
      setBroadcastProductCandidate(null);
    }
  };

  const adjustInventory = async () => {
    if (!editingProductId || !/^-?\d+$/.test(inventoryDelta) || Number(inventoryDelta) === 0) {
      setMessage('Введите ненулевое изменение остатка');
      return;
    }
    if (inventoryReason.trim().length < 3) {
      setMessage('Укажите причину изменения остатка');
      return;
    }
    setMessage(null);
    try {
      const inventory = await api<{ onHand: number; reserved: number }>(
        `/admin/store/products/${encodeURIComponent(editingProductId)}/inventory`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            quantity: Number(inventoryDelta),
            reason: inventoryReason.trim(),
          }),
        },
      );
      const available = Math.max(0, inventory.onHand - inventory.reserved);
      setProducts((items) =>
        items.map((product) =>
          product.id === editingProductId ? { ...product, inventory, stock: available } : product,
        ),
      );
      setForm((value) => ({ ...value, stock: String(available) }));
      setInventoryDelta('');
      setInventoryReason('');
      setMessage(`Остаток обновлён: доступно ${available}`);
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    }
  };

  const createCategory = async () => {
    if (!categoryDraft.title || !categoryDraft.slug) return;
    setMessage(null);
    try {
      const created = await api<AdminStoreCategory>('/admin/store/categories', {
        method: 'POST',
        body: JSON.stringify({
          ...categoryDraft,
          description: null,
          sortOrder: categories.length,
          active: true,
        }),
      });
      setCategories((items) => [...items, created]);
      setForm((value) => ({ ...value, categoryId: created.id }));
      setCategoryDraft({ title: '', slug: '' });
      setMessage('Категория создана и выбрана');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    }
  };

  const collectImageDrafts = (files: File[], startOrder: number): MediaDraft[] => {
    const drafts: MediaDraft[] = [];
    for (const file of files) {
      const contentType = normalizeProductImageType(file.type);
      if (!contentType) {
        setMessage('Можно загрузить только JPG, PNG или WebP');
        continue;
      }
      if (file.size > PRODUCT_MEDIA_MAX_BYTES) {
        setMessage('Файл больше 10 МБ');
        continue;
      }
      drafts.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        altText: '',
        sortOrder: String(startOrder + drafts.length),
        status: 'queued',
        progress: 0,
        error: null,
        mediaId: null,
        contentType,
      });
    }
    return drafts;
  };

  const uploadDraft = async (
    productId: string,
    draft: MediaDraft,
    setDrafts: (updater: (items: MediaDraft[]) => MediaDraft[]) => void,
  ): Promise<AdminProductMedia | null> => {
    setDrafts((items) =>
      items.map((item) =>
        item.id === draft.id ? { ...item, status: 'uploading', progress: 0, error: null } : item,
      ),
    );
    let mediaId = draft.mediaId;
    try {
      if (mediaId) {
        await api(
          `/admin/store/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(mediaId)}`,
          { method: 'DELETE' },
        ).catch(() => undefined);
      }
      const init = await api<ProductMediaUploadInit>(
        `/admin/store/products/${encodeURIComponent(productId)}/media/uploads`,
        {
          method: 'POST',
          body: JSON.stringify({
            fileName: draft.file.name,
            contentType: draft.contentType,
            sizeBytes: draft.file.size,
            altText: draft.altText || null,
            sortOrder: Number(draft.sortOrder),
          }),
        },
      );
      mediaId = init.mediaId;
      setDrafts((items) =>
        items.map((item) => (item.id === draft.id ? { ...item, mediaId } : item)),
      );
      await uploadWithHeadersAndProgress(
        init.uploadUrl,
        draft.file,
        init.method,
        init.headers,
        (loaded, total) => {
          const progress = Math.round((loaded / Math.max(total, 1)) * 100);
          setDrafts((items) =>
            items.map((item) => (item.id === draft.id ? { ...item, progress } : item)),
          );
        },
      );
      const created = await api<AdminProductMedia>(
        `/admin/store/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(init.mediaId)}/complete`,
        { method: 'POST' },
      );
      URL.revokeObjectURL(draft.previewUrl);
      setDrafts((items) => items.filter((item) => item.id !== draft.id));
      setProducts((items) =>
        items.map((product) =>
          product.id === productId
            ? {
                ...product,
                media: [...(product.media ?? []), created].sort(
                  (a, b) => a.sortOrder - b.sortOrder,
                ),
              }
            : product,
        ),
      );
      return created;
    } catch (caught) {
      setDrafts((items) =>
        items.map((item) =>
          item.id === draft.id
            ? {
                ...item,
                status: 'error',
                error: unavailableMessage(caught),
                mediaId,
              }
            : item,
        ),
      );
      return null;
    }
  };

  const queueFormImages = (files: File[]) => {
    const drafts = collectImageDrafts(files, mediaDrafts.length);
    if (!drafts.length) return;
    setMediaDrafts((items) => [...items, ...drafts]);
    if (editingProductId) {
      for (const draft of drafts) void uploadDraft(editingProductId, draft, setMediaDrafts);
    }
  };

  const queueGalleryImages = (files: File[]) => {
    if (!mediaProductId) return;
    const product = products.find((item) => item.id === mediaProductId);
    const drafts = collectImageDrafts(files, (product?.media?.length ?? 0) + galleryDrafts.length);
    if (!drafts.length) return;
    setGalleryDrafts((items) => [...items, ...drafts]);
    for (const draft of drafts) void uploadDraft(mediaProductId, draft, setGalleryDrafts);
  };

  const removeDraft = (
    draftId: string,
    drafts: MediaDraft[],
    setDrafts: (updater: (items: MediaDraft[]) => MediaDraft[]) => void,
    productId: string | null,
  ) => {
    const draft = drafts.find((item) => item.id === draftId);
    if (!draft || draft.status === 'uploading') return;
    if (productId && draft.mediaId) {
      void api(
        `/admin/store/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(draft.mediaId)}`,
        { method: 'DELETE' },
      ).catch(() => undefined);
    }
    URL.revokeObjectURL(draft.previewUrl);
    setDrafts((items) => items.filter((item) => item.id !== draftId));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    try {
      const payload = {
        categoryId: form.categoryId || null,
        slug: form.slug,
        title: form.title,
        description: form.description || null,
        descriptionFormat: form.descriptionFormat,
        cardHtml: form.cardHtml || null,
        kind: form.kind,
        status: form.status,
        price: form.price,
        stockMode: form.stockMode,
        perUserLimit: form.perUserLimit ? Number(form.perUserLimit) : null,
        availableFrom: form.availableFrom ? fromNovosibirskInput(form.availableFrom) : null,
        availableUntil: form.availableUntil ? fromNovosibirskInput(form.availableUntil) : null,
        pickupInstructions: form.pickupInstructions || null,
        sortOrder: Number(form.sortOrder),
      };
      const product = await api<AdminStoreProduct>(
        editingProductId
          ? `/admin/store/products/${encodeURIComponent(editingProductId)}`
          : '/admin/store/products',
        {
          method: editingProductId ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        },
      );
      if (!editingProductId && form.stockMode === 'limited' && Number(form.stock) !== 0) {
        await api(`/admin/store/products/${encodeURIComponent(product.id)}/inventory`, {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            quantity: Number(form.stock),
            reason: 'Начальный остаток',
          }),
        });
      }
      const selectedCategory = categories.find((item) => item.id === form.categoryId) ?? null;
      const existing = products.find((item) => item.id === product.id);
      setProducts((items) =>
        editingProductId
          ? items.map((item) =>
              item.id === editingProductId
                ? {
                    ...item,
                    ...product,
                    category: selectedCategory,
                    ...(item.media === undefined ? {} : { media: item.media }),
                    ...(item.stock === undefined ? {} : { stock: item.stock }),
                    ...(item.inventory === undefined ? {} : { inventory: item.inventory }),
                  }
                : item,
            )
          : [
              {
                ...product,
                category: selectedCategory,
                media: existing?.media ?? [],
                stock: form.stockMode === 'limited' ? Number(form.stock) : null,
              },
              ...items,
            ],
      );
      const savedExisting = Boolean(editingProductId);
      const queued = mediaDrafts.filter(
        (draft) => draft.status === 'queued' || draft.status === 'error',
      );
      if (!savedExisting && queued.length) {
        const uploaded: AdminProductMedia[] = [];
        for (const draft of queued) {
          const created = await uploadDraft(product.id, draft, setMediaDrafts);
          if (created) uploaded.push(created);
        }
        if (uploaded.length !== queued.length) {
          setEditingProductId(product.id);
          setMessage('Товар создан, но часть изображений не загрузилась. Повторите загрузку.');
          return;
        }
      }
      resetProductEditor();
      setMessage(savedExisting ? 'Изменения товара сохранены' : 'Товар и изображения сохранены');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    }
  };

  const removeMedia = async (productId: string, mediaId: string) => {
    setMessage(null);
    try {
      await api(
        `/admin/store/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(mediaId)}`,
        { method: 'DELETE' },
      );
      setProducts((items) =>
        items.map((product) =>
          product.id === productId
            ? {
                ...product,
                media: (product.media ?? []).filter((media) => media.id !== mediaId),
              }
            : product,
        ),
      );
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    }
  };

  const moveMedia = async (product: AdminStoreProduct, index: number, offset: -1 | 1) => {
    const media = [...(product.media ?? [])];
    const target = index + offset;
    if (target < 0 || target >= media.length) return;
    [media[index], media[target]] = [media[target]!, media[index]!];
    const reordered = media.map((item, sortOrder) => ({ ...item, sortOrder }));
    setProducts((items) =>
      items.map((item) => (item.id === product.id ? { ...item, media: reordered } : item)),
    );
    try {
      await api(`/admin/store/products/${encodeURIComponent(product.id)}/media/reorder`, {
        method: 'PUT',
        body: JSON.stringify({
          items: reordered.map((item) => ({
            id: item.id,
            sortOrder: item.sortOrder,
          })),
        }),
      });
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    }
  };

  const selectedMediaProduct = products.find((product) => product.id === mediaProductId) ?? null;

  return (
    <>
      {broadcastProductCandidate ? (
        <AdminBroadcastDialog
          title={broadcastProductCandidate.title}
          busy={broadcastingProductId === broadcastProductCandidate.id}
          onCancel={() => setBroadcastProductCandidate(null)}
          onConfirm={() => void broadcastProduct(broadcastProductCandidate)}
        />
      ) : null}
      <BuilderHeader kicker="Магазин" title="Конструктор товара">
        Тип, цена, лимиты, период доступности, выдача, категории и загрузка изображений в галерею.
      </BuilderHeader>
      <div className="admin-two-column">
        <Card className="admin-form-card wallet-product-editor">
          <div className="admin-section-heading wallet-product-editor-heading">
            <h2>{editingProductId ? 'Редактирование товара' : 'Новый товар'}</h2>
            {editingProductId ? (
              <button type="button" onClick={resetProductEditor}>
                Новый товар
              </button>
            ) : null}
          </div>
          <form className="admin-form" onSubmit={save}>
            <label>
              <span>Название</span>
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                required
              />
            </label>
            <label>
              <span>Slug</span>
              <input
                value={form.slug}
                onChange={(event) =>
                  setForm({
                    ...form,
                    slug: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                  })
                }
                required
              />
            </label>
            <label className="admin-wide">
              <span>Категория</span>
              <select
                value={form.categoryId}
                onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
              >
                <option value="">Без категории</option>
                {categories
                  .filter((category) => category.active)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.title}
                    </option>
                  ))}
              </select>
            </label>
            <details className="admin-wide category-quick-create">
              <summary>Создать категорию</summary>
              <div>
                <input
                  aria-label="Название новой категории"
                  placeholder="Название"
                  value={categoryDraft.title}
                  onChange={(event) =>
                    setCategoryDraft((value) => ({
                      ...value,
                      title: event.target.value,
                    }))
                  }
                />
                <input
                  aria-label="Slug новой категории"
                  placeholder="slug"
                  value={categoryDraft.slug}
                  onChange={(event) =>
                    setCategoryDraft((value) => ({
                      ...value,
                      slug: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                    }))
                  }
                />
                <Button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={createCategory}
                >
                  Добавить
                </Button>
              </div>
            </details>
            <label>
              <span>Тип</span>
              <select
                value={form.kind}
                onChange={(event) =>
                  setForm({
                    ...form,
                    kind: event.target.value as typeof form.kind,
                  })
                }
              >
                <option value="physical">Физический</option>
                {editingProductId && form.kind === 'digital' ? (
                  <option value="digital">Цифровой (legacy, выдача не подключена)</option>
                ) : null}
              </select>
            </label>
            {editingProductId && form.kind === 'digital' ? (
              <div className="notice info admin-wide">
                Legacy digital-товар принудительно сохраняется черновиком и не показывается
                участникам. Для публикации переведите его в физический или дождитесь digital
                delivery.
              </div>
            ) : null}
            <label>
              <span>Цена</span>
              <input
                value={form.price}
                onChange={(event) =>
                  setForm({
                    ...form,
                    price: event.target.value.replace(/\D/g, ''),
                  })
                }
                inputMode="numeric"
                required
              />
            </label>
            <label>
              <span>Лимит на пользователя</span>
              <input
                value={form.perUserLimit}
                onChange={(event) =>
                  setForm({
                    ...form,
                    perUserLimit: event.target.value.replace(/\D/g, ''),
                  })
                }
                inputMode="numeric"
              />
            </label>
            <label>
              <span>Учёт остатка</span>
              <select
                value={form.stockMode}
                onChange={(event) =>
                  setForm({
                    ...form,
                    stockMode: event.target.value as typeof form.stockMode,
                  })
                }
              >
                <option value="limited">Ограниченный</option>
                <option value="unlimited">Без ограничения</option>
              </select>
            </label>
            {form.stockMode === 'limited' && !editingProductId ? (
              <label>
                <span>Начальный остаток</span>
                <input
                  value={form.stock}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      stock: event.target.value.replace(/\D/g, ''),
                    })
                  }
                  inputMode="numeric"
                />
              </label>
            ) : null}
            {form.stockMode === 'limited' && editingProductId ? (
              <fieldset className="admin-wide wallet-inventory-adjustment">
                <legend>Остаток · доступно {form.stock}</legend>
                <p>
                  Корректировка проводится отдельной журналируемой операцией. Используйте минус для
                  списания со склада.
                </p>
                <label>
                  <span>Изменение</span>
                  <input
                    value={inventoryDelta}
                    onChange={(event) =>
                      setInventoryDelta(event.target.value.replace(/[^\d-]/g, ''))
                    }
                    inputMode="numeric"
                    placeholder="+10 или -2"
                  />
                </label>
                <label>
                  <span>Причина</span>
                  <input
                    value={inventoryReason}
                    onChange={(event) => setInventoryReason(event.target.value)}
                    placeholder="Поставка, инвентаризация…"
                  />
                </label>
                <Button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() => void adjustInventory()}
                >
                  Изменить остаток
                </Button>
              </fieldset>
            ) : null}
            <label>
              <span>Доступен с</span>
              <input
                type="datetime-local"
                value={form.availableFrom}
                onChange={(event) => setForm({ ...form, availableFrom: event.target.value })}
              />
            </label>
            <label>
              <span>Доступен до</span>
              <input
                type="datetime-local"
                value={form.availableUntil}
                onChange={(event) => setForm({ ...form, availableUntil: event.target.value })}
              />
            </label>
            <label>
              <span>Формат описания</span>
              <select
                value={form.descriptionFormat}
                onChange={(event) =>
                  setForm({
                    ...form,
                    descriptionFormat: event.target.value as 'text' | 'html',
                  })
                }
              >
                <option value="text">Обычный текст</option>
                <option value="html">HTML+CSS</option>
              </select>
            </label>
            <label className="admin-wide">
              <span>Описание</span>
              <textarea
                rows={8}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                maxLength={50_000}
                className={form.descriptionFormat === 'html' ? 'rich-html-source' : ''}
                spellCheck={form.descriptionFormat !== 'html'}
              />
            </label>
            <label className="admin-wide">
              <span>HTML+CSS карточки в каталоге</span>
              <textarea
                rows={8}
                value={form.cardHtml}
                onChange={(event) => setForm({ ...form, cardHtml: event.target.value })}
                maxLength={100_000}
                className="rich-html-source"
                spellCheck={false}
                placeholder="Необязательно: компактная карточка товара"
              />
            </label>
            {form.cardHtml ? (
              <div className="admin-wide manual-card-preview">
                <strong>Предпросмотр ручной карточки</strong>
                <HtmlDesignPreview html={form.cardHtml} />
              </div>
            ) : null}

            <label className="admin-wide">
              <span>Инструкция по выдаче</span>
              <textarea
                rows={3}
                value={form.pickupInstructions}
                onChange={(event) => setForm({ ...form, pickupInstructions: event.target.value })}
              />
            </label>
            <ProductMediaDropzone
              title={editingProductId ? 'Добавить изображения' : 'Изображения товара'}
              drafts={mediaDrafts}
              onFiles={queueFormImages}
              onChange={(id, patch) =>
                setMediaDrafts((items) =>
                  items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
                )
              }
              onRemove={(id) => removeDraft(id, mediaDrafts, setMediaDrafts, editingProductId)}
              {...(editingProductId
                ? {
                    onUpload: (draft: MediaDraft) => {
                      void uploadDraft(editingProductId, draft, setMediaDrafts);
                    },
                  }
                : {})}
            />
            <label>
              <span>Статус</span>
              <select
                value={form.status}
                disabled={form.kind === 'digital'}
                onChange={(event) =>
                  setForm({
                    ...form,
                    status: event.target.value as WalletProduct['status'],
                  })
                }
              >
                <option value="draft">Черновик</option>
                <option value="published">Опубликован</option>
                <option value="paused">На паузе</option>
                <option value="archived">Архив</option>
              </select>
            </label>
            <label>
              <span>Порядок</span>
              <input
                value={form.sortOrder}
                onChange={(event) =>
                  setForm({
                    ...form,
                    sortOrder: event.target.value.replace(/\D/g, ''),
                  })
                }
                inputMode="numeric"
              />
            </label>
            {message ? <div className="notice info admin-wide">{message}</div> : null}
            <Button type="submit" className="primary-button compact-button">
              <StoreIcon /> {editingProductId ? 'Сохранить изменения' : 'Создать товар'}
            </Button>
            {editingProductId ? (
              <Button
                type="button"
                className="secondary-button compact-button"
                onClick={resetProductEditor}
              >
                Отмена
              </Button>
            ) : null}
          </form>
        </Card>
        <Card className="admin-table-card">
          <h2>Товары</h2>
          {products.length ? (
            <div className="wallet-product-admin-list">
              {products.map((product) => (
                <article key={product.id}>
                  <span>
                    {productThumbnail(product) ? (
                      <img src={productThumbnail(product) ?? ''} alt="" />
                    ) : (
                      <StoreIcon />
                    )}
                  </span>
                  <div>
                    <strong>{product.title}</strong>
                    <small>
                      {productKindLabels[product.kind ?? 'physical']} ·{' '}
                      {formatPoints(product.price)} ·{' '}
                      {product.stockMode === 'unlimited' ? '∞' : (product.stock ?? 0)} шт. ·{' '}
                      {product.media?.length ?? 0} фото
                    </small>
                  </div>
                  <i data-status={product.status}>{productStatusLabels[product.status]}</i>
                  <div className="wallet-product-admin-actions">
                    <button type="button" onClick={() => editProduct(product)}>
                      Изменить
                    </button>
                    {product.status === 'published' ? (
                      <button
                        type="button"
                        disabled={broadcastingProductId !== null}
                        onClick={() => setBroadcastProductCandidate(product)}
                      >
                        {broadcastingProductId === product.id
                          ? 'Ставим в очередь…'
                          : 'Отправить рассылку'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setGalleryDrafts((items) => {
                          revokeMediaDrafts(items);
                          return [];
                        });
                        setMediaProductId(product.id);
                      }}
                    >
                      Галерея
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyAdminState title="Каталог пуст">
              Создайте первый товар слева. Черновик не виден участникам.
            </EmptyAdminState>
          )}
          {selectedMediaProduct ? (
            <div className="existing-media-editor">
              <div className="admin-section-heading">
                <h3>Галерея: {selectedMediaProduct.title}</h3>
                <button
                  type="button"
                  onClick={() => {
                    setGalleryDrafts((items) => {
                      revokeMediaDrafts(items);
                      return [];
                    });
                    setMediaProductId(null);
                  }}
                >
                  Закрыть
                </button>
              </div>
              {(selectedMediaProduct.media ?? []).map((media, index) => (
                <article key={media.id}>
                  <img src={media.url} alt={media.altText ?? ''} />
                  <div>
                    <strong>{media.altText || 'Без описания'}</strong>
                    <small>Порядок {media.sortOrder}</small>
                  </div>
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => moveMedia(selectedMediaProduct, index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === (selectedMediaProduct.media?.length ?? 0) - 1}
                    onClick={() => moveMedia(selectedMediaProduct, index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeMedia(selectedMediaProduct.id, media.id)}
                  >
                    Удалить
                  </button>
                </article>
              ))}
              <ProductMediaDropzone
                title="Загрузить ещё"
                drafts={galleryDrafts}
                onFiles={queueGalleryImages}
                onChange={(id, patch) =>
                  setGalleryDrafts((items) =>
                    items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
                  )
                }
                onRemove={(id) =>
                  removeDraft(id, galleryDrafts, setGalleryDrafts, selectedMediaProduct.id)
                }
                onUpload={(draft) => {
                  void uploadDraft(selectedMediaProduct.id, draft, setGalleryDrafts);
                }}
              />
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}

function OrdersBoard() {
  type AdminOrder = {
    comment: string | null;
    id: string;
    status: WalletOrder['status'];
    totalPoints: string;
    createdAt: string;
    user: { id: string; displayName: string; username: string | null };
  };
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pickupToken, setPickupToken] = useState('');
  const [pickupCamera, setPickupCamera] = useState(false);
  const [resolvingPickup, setResolvingPickup] = useState(false);
  const pickupVideoRef = useRef<HTMLVideoElement | null>(null);
  const pickupScannerControls = useRef<{ stop: () => void } | null>(null);
  useEffect(() => {
    void api<{ items: AdminOrder[] }>('/admin/store/orders?limit=100')
      .then((result) => setOrders(result.items))
      .catch(() => setOrders([]));
  }, []);

  useEffect(() => {
    if (!pickupCamera || !pickupVideoRef.current) return;
    let disposed = false;
    void import('@zxing/browser')
      .then(async ({ BrowserQRCodeReader }) => {
        const reader = new BrowserQRCodeReader(undefined, {
          delayBetweenScanAttempts: 180,
        });
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          pickupVideoRef.current!,
          (result, caught, scanner) => {
            if (disposed) return;
            if (result) {
              const token = result.getText();
              setPickupToken(token);
              scanner.stop();
              setPickupCamera(false);
              void resolvePickup(token);
            } else if (caught && caught.name !== 'NotFoundException') {
              setMessage('Камера не распознала QR. Вставьте код вручную.');
            }
          },
        );
        if (disposed) controls.stop();
        else pickupScannerControls.current = controls;
      })
      .catch(() => {
        setPickupCamera(false);
        setMessage('Камера недоступна. Разрешите доступ или вставьте код вручную.');
      });
    return () => {
      disposed = true;
      pickupScannerControls.current?.stop();
      pickupScannerControls.current = null;
    };
  }, [pickupCamera]);

  const resolvePickup = async (token = pickupToken) => {
    if (!token.trim()) {
      setMessage('Отсканируйте QR участника или вставьте код');
      return;
    }
    setResolvingPickup(true);
    setMessage(null);
    try {
      const fulfilled = await api<AdminOrder>('/admin/store/orders/resolve-pickup', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ token: token.trim() }),
      });
      setOrders((items) =>
        items.map((item) =>
          item.id === fulfilled.id
            ? { ...item, ...fulfilled, user: fulfilled.user ?? item.user }
            : item,
        ),
      );
      setPickupToken('');
      setMessage(`Заказ ${fulfilled.id.slice(0, 8)} выдан и QR погашен`);
      getMessengerAdapter()?.notify('success');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    } finally {
      setResolvingPickup(false);
    }
  };

  const startPickupScanner = async () => {
    setMessage(null);
    const messenger = getMessengerAdapter();
    if (!messenger) {
      setPickupCamera(true);
      return;
    }
    try {
      const token = await messenger.scanQr({
        prompt: 'Сканируйте QR выдачи заказа',
        fileSelect: true,
      });
      if (!token) {
        setPickupCamera(true);
        return;
      }
      setPickupToken(token);
      await resolvePickup(token);
    } catch {
      setPickupCamera(true);
    }
  };
  const advance = async (order: AdminOrder, status: 'ready_for_pickup' | 'fulfilled') => {
    setMessage(null);
    try {
      const updated = await api<{
        id: string;
        status: AdminOrder['status'];
        totalPoints: string;
      }>(`/admin/store/orders/${encodeURIComponent(order.id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setOrders((items) =>
        items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      );
      setMessage(status === 'ready_for_pickup' ? 'Заказ отмечен готовым' : 'Выдача подтверждена');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    }
  };
  return (
    <>
      <BuilderHeader kicker="Выдача" title="Заказы">
        Последовательность: оплачено → заявка участника → готово → выдано.
      </BuilderHeader>
      <Card className="admin-form-card wallet-pickup-scanner">
        <div>
          <span className="wallet-admin-icon lime">
            <ScanIcon />
          </span>
          <div>
            <h3>Выдать по QR участника</h3>
            <p>
              Один скан атомарно переводит заявку в «готово» и «выдано», затем гасит временный код.
            </p>
          </div>
        </div>
        {pickupCamera ? (
          <div className="wallet-admin-camera">
            <video
              ref={pickupVideoRef}
              muted
              playsInline
              aria-label="Камера сканирования QR выдачи"
            />
            <span>Наведите камеру на QR участника</span>
          </div>
        ) : null}
        <div className="wallet-pickup-scanner-controls">
          <Button
            type="button"
            className="primary-button compact-button"
            disabled={resolvingPickup}
            onClick={() => void startPickupScanner()}
          >
            <QrIcon /> Сканировать QR
          </Button>
          <label>
            <span>Или код вручную</span>
            <input
              value={pickupToken}
              onChange={(event) => setPickupToken(event.target.value)}
              placeholder="Вставьте token из QR"
              autoComplete="off"
            />
          </label>
          <Button
            type="button"
            className="secondary-button compact-button"
            disabled={resolvingPickup || !pickupToken.trim()}
            onClick={() => void resolvePickup()}
          >
            {resolvingPickup ? 'Проверяем…' : 'Подтвердить выдачу'}
          </Button>
        </div>
      </Card>
      {message ? <div className="notice info">{message}</div> : null}
      <Card className="admin-table-card">
        <div className="admin-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Заказ</th>
                <th>Участник</th>
                <th>Сумма</th>
                <th>Статус</th>
                <th>Создан</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>
                    {order.id.slice(0, 8)}
                    {order.comment ? (
                      <small style={{ whiteSpace: 'pre-line' }}>{order.comment}</small>
                    ) : null}
                  </td>
                  <td>
                    {order.user.displayName}
                    <small>{order.user.username ? `@${order.user.username}` : order.user.id}</small>
                  </td>
                  <td>{formatPoints(order.totalPoints)}</td>
                  <td>
                    <span className="wallet-admin-pill" data-status={order.status}>
                      {orderStatusLabels[order.status]}
                    </span>
                  </td>
                  <td>{formatNovosibirskDateTime(order.createdAt)}</td>
                  <td>
                    {order.status === 'pickup_requested' ? (
                      <button type="button" onClick={() => advance(order, 'ready_for_pickup')}>
                        Готов к выдаче
                      </button>
                    ) : order.status === 'ready_for_pickup' ? (
                      <button type="button" onClick={() => advance(order, 'fulfilled')}>
                        Подтвердить выдачу
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {orders.length === 0 ? (
          <EmptyAdminState title="Заказов пока нет">
            Оплаченные товары появятся здесь после того, как участник оставит заявку на выдачу.
          </EmptyAdminState>
        ) : null}
      </Card>
    </>
  );
}

function FeedBuilder() {
  const [posts, setPosts] = useState<AdminFeedPost[]>([]);
  const [form, setForm] = useState({
    kind: 'news' as AdminFeedPost['kind'],
    audience: 'all' as AdminFeedPost['audience'],
    title: '',
    summary: '',
    body: '',
    bodyFormat: 'text' as 'text' | 'html',
    cardHtml: '',
    coverUrl: '',
    ctaLabel: '',
    ctaUrl: '',
    eventId: '',
    productId: '',
    pinned: false,
    publish: false,
    publishedAt: '',
  });
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [broadcastingPostId, setBroadcastingPostId] = useState<string | null>(null);
  const [broadcastPostCandidate, setBroadcastPostCandidate] = useState<AdminFeedPost | null>(null);
  useEffect(() => {
    void api<{ items: AdminFeedPost[] }>('/admin/feed?limit=100')
      .then((result) => setPosts(result.items))
      .catch(() => setPosts([]));
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setMessage(null);
    const actionError = feedActionValidationError({
      ctaUrl: form.ctaUrl,
      eventId: form.eventId,
      productId: form.productId,
    });
    if (actionError) {
      setMessage(actionError);
      return;
    }
    setSaving(true);
    try {
      const post = await api<AdminFeedPost>('/admin/feed', {
        method: 'POST',
        body: JSON.stringify({
          kind: form.kind,
          status: form.publish ? 'published' : 'draft',
          audience: form.audience,
          title: form.title,
          summary: form.summary || null,
          body: form.body,
          bodyFormat: form.bodyFormat,
          cardHtml: form.cardHtml || null,
          coverUrl: form.coverUrl || null,
          ctaLabel: form.ctaLabel || null,
          ctaUrl: form.ctaUrl || null,
          eventId: form.eventId || null,
          productId: form.productId || null,
          pinned: form.pinned,
          publishedAt: form.publishedAt ? fromNovosibirskInput(form.publishedAt) : null,
        }),
      });
      setPosts((items) => [post, ...items]);
      setForm((value) => ({
        ...value,
        title: '',
        summary: '',
        body: '',
        bodyFormat: 'text',
        cardHtml: '',
        coverUrl: '',
        ctaLabel: '',
        ctaUrl: '',
        eventId: '',
        productId: '',
      }));
      setMessage('Публикация сохранена');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const broadcastPost = async (post: AdminFeedPost) => {
    if (broadcastingPostId) return;
    setBroadcastingPostId(post.id);
    setMessage(null);
    try {
      const result = await enqueueAdminBroadcast('feed_post', post.id);
      setMessage(adminBroadcastQueuedMessage(post.title, result));
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    } finally {
      setBroadcastingPostId(null);
      setBroadcastPostCandidate(null);
    }
  };

  return (
    <>
      {broadcastPostCandidate ? (
        <AdminBroadcastDialog
          title={broadcastPostCandidate.title}
          busy={broadcastingPostId === broadcastPostCandidate.id}
          onCancel={() => setBroadcastPostCandidate(null)}
          onConfirm={() => void broadcastPost(broadcastPostCandidate)}
        />
      ) : null}
      <BuilderHeader kicker="Лента" title="Новости и обновления">
        Текст, обложка, CTA, расписание, аудитория и закрепление — в одной публикации.
      </BuilderHeader>
      <div className="admin-two-column">
        <Card className="admin-form-card">
          <form className="admin-form" onSubmit={save}>
            <label>
              <span>Тип</span>
              <select
                value={form.kind}
                onChange={(event) =>
                  setForm({
                    ...form,
                    kind: event.target.value as AdminFeedPost['kind'],
                  })
                }
              >
                <option value="news">Новость</option>
                <option value="event">Мероприятие</option>
                <option value="product">Товар</option>
                <option value="system">Системное</option>
              </select>
            </label>
            <label>
              <span>Аудитория</span>
              <select
                value={form.audience}
                onChange={(event) =>
                  setForm({
                    ...form,
                    audience: event.target.value as AdminFeedPost['audience'],
                  })
                }
              >
                <option value="all">Все</option>
                <option value="participants">Участники</option>
                <option value="admins">Администраторы</option>
              </select>
            </label>
            <label className="admin-wide">
              <span>Заголовок</span>
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                required
              />
            </label>
            <label className="admin-wide">
              <span>Анонс до 500 символов</span>
              <textarea
                rows={3}
                value={form.summary}
                onChange={(event) => setForm({ ...form, summary: event.target.value })}
                maxLength={500}
              />
            </label>
            <label>
              <span>Формат полного текста</span>
              <select
                value={form.bodyFormat}
                onChange={(event) =>
                  setForm({
                    ...form,
                    bodyFormat: event.target.value as 'text' | 'html',
                  })
                }
              >
                <option value="text">Обычный текст</option>
                <option value="html">HTML+CSS</option>
              </select>
            </label>
            <label className="admin-wide">
              <span>Полный текст *</span>
              <textarea
                rows={7}
                value={form.body}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
                maxLength={50000}
                className={form.bodyFormat === 'html' ? 'rich-html-source' : ''}
                spellCheck={form.bodyFormat !== 'html'}
                required
              />
            </label>
            <label className="admin-wide">
              <span>HTML+CSS карточки в ленте</span>
              <textarea
                rows={8}
                value={form.cardHtml}
                onChange={(event) => setForm({ ...form, cardHtml: event.target.value })}
                maxLength={100_000}
                className="rich-html-source"
                spellCheck={false}
                placeholder="Необязательно: компактная карточка публикации"
              />
            </label>
            {form.cardHtml ? (
              <div className="admin-wide manual-card-preview">
                <strong>Предпросмотр ручной карточки</strong>
                <HtmlDesignPreview html={form.cardHtml} />
              </div>
            ) : null}

            <label className="admin-wide">
              <span>Обложка в Beget S3</span>
              <input
                type="url"
                value={form.coverUrl}
                onChange={(event) => setForm({ ...form, coverUrl: event.target.value })}
              />
            </label>
            <label>
              <span>Текст CTA</span>
              <input
                value={form.ctaLabel}
                onChange={(event) => setForm({ ...form, ctaLabel: event.target.value })}
              />
            </label>
            <label>
              <span>Ссылка CTA</span>
              <input
                type="url"
                inputMode="url"
                placeholder="https://example.org/path"
                value={form.ctaUrl}
                onChange={(event) => setForm({ ...form, ctaUrl: event.target.value })}
              />
            </label>
            <label>
              <span>ID мероприятия</span>
              <input
                value={form.eventId}
                onChange={(event) => setForm({ ...form, eventId: event.target.value })}
              />
            </label>
            <label>
              <span>ID товара</span>
              <input
                value={form.productId}
                onChange={(event) => setForm({ ...form, productId: event.target.value })}
              />
            </label>
            <label>
              <span>Дата публикации</span>
              <input
                type="datetime-local"
                value={form.publishedAt}
                onChange={(event) => setForm({ ...form, publishedAt: event.target.value })}
              />
            </label>
            <fieldset className="wallet-permissions">
              <legend>Публикация</legend>
              <label>
                <input
                  type="checkbox"
                  checked={form.pinned}
                  onChange={(event) => setForm({ ...form, pinned: event.target.checked })}
                />{' '}
                Закрепить
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.publish}
                  onChange={(event) => setForm({ ...form, publish: event.target.checked })}
                />{' '}
                Опубликовать
              </label>
            </fieldset>
            {message ? <div className="notice info admin-wide">{message}</div> : null}
            <Button type="submit" className="primary-button compact-button" disabled={saving}>
              {saving ? 'Сохраняем…' : 'Сохранить публикацию'}
            </Button>
          </form>
        </Card>
        <Card className="admin-table-card">
          <h2>Последние публикации</h2>
          {posts.length ? (
            <div className="wallet-feed-admin-list">
              {posts.map((post) => (
                <article key={post.id}>
                  <span>
                    {feedStatusLabels[post.status]}
                    {post.pinned ? ' · закреплено' : ''}
                  </span>
                  <strong>{post.title}</strong>
                  <p>{post.summary ?? post.body.slice(0, 160)}</p>
                  <div className="feed-admin-main-actions">
                    {post.kind === 'news' &&
                    post.status === 'published' &&
                    post.audience === 'all' &&
                    !(post.publishedAt && Date.parse(post.publishedAt) > Date.now()) ? (
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        disabled={broadcastingPostId !== null}
                        onClick={() => setBroadcastPostCandidate(post)}
                      >
                        {broadcastingPostId === post.id
                          ? 'Ставим в очередь…'
                          : 'Отправить рассылку'}
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyAdminState title="Лента пуста">
              Создайте новость или опубликуйте мероприятие — оно появится в приложении
              автоматически.
            </EmptyAdminState>
          )}
        </Card>
      </div>
    </>
  );
}

function WalletSettings() {
  const [form, setForm] = useState({
    walletTitle: 'Мои баллы',
    unitOne: 'балл',
    unitFew: 'балла',
    unitMany: 'баллов',
    symbol: '',
    iconUrl: '',
    welcomeAmount: '100',
    leaderIdSubscriptionReward: '0',
    maxTransactionAmount: '1000000',
    qrTtlSeconds: '120',
    intentTtlSeconds: '120',
    p2pEnabled: true,
    storeEnabled: true,
  });
  const [resetReason, setResetReason] = useState('');
  const [resetPreview, setResetPreview] = useState<{
    id: string;
    affectedAccounts: number;
    previousTotal: string;
    confirmation: string;
  } | null>(null);
  const [resetPhrase, setResetPhrase] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const loadSettings = async () => {
    setSettingsStatus('loading');
    setSettingsError(null);
    try {
      const settings = await api<Partial<typeof form>>('/admin/wallet/settings');
      setForm((current) => ({
        ...current,
        ...settings,
        welcomeAmount: String(settings.welcomeAmount ?? current.welcomeAmount),
        leaderIdSubscriptionReward: String(
          settings.leaderIdSubscriptionReward ?? current.leaderIdSubscriptionReward,
        ),
        maxTransactionAmount: String(settings.maxTransactionAmount ?? current.maxTransactionAmount),
        qrTtlSeconds: String(settings.qrTtlSeconds ?? current.qrTtlSeconds),
        intentTtlSeconds: String(settings.intentTtlSeconds ?? current.intentTtlSeconds),
        symbol: String(settings.symbol ?? ''),
        iconUrl: String(settings.iconUrl ?? ''),
      }));
      setSettingsStatus('ready');
    } catch (caught) {
      setSettingsStatus('error');
      setSettingsError(unavailableMessage(caught));
    }
  };
  useEffect(() => {
    void loadSettings();
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (settingsStatus !== 'ready' || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await api('/admin/wallet/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          ...form,
          symbol: form.symbol || null,
          iconUrl: form.iconUrl || null,
          welcomeAmount: Number(form.welcomeAmount),
          leaderIdSubscriptionReward: Number(form.leaderIdSubscriptionReward),
          maxTransactionAmount: Number(form.maxTransactionAmount),
          qrTtlSeconds: Number(form.qrTtlSeconds),
          intentTtlSeconds: Number(form.intentTtlSeconds),
        }),
      });
      setMessage('Настройки сохранены');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    } finally {
      setSaving(false);
    }
  };
  const previewReset = async () => {
    if (resetReason.trim().length < 10)
      return setMessage('Причина должна содержать минимум 10 символов');
    setSaving(true);
    setMessage(null);
    try {
      const preview = await api<{
        id: string;
        affectedAccounts: number;
        previousTotal: string;
        confirmation: string;
      }>('/admin/wallet/resets/preview', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          targetOpeningAmount: 0,
          reason: resetReason.trim(),
        }),
      });
      setResetPreview(preview);
      setMessage('Предпросмотр готов. Проверьте число счетов и сумму.');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    if (!resetPreview || resetPhrase !== resetPreview.id) return;
    setSaving(true);
    setMessage(null);
    try {
      await api(`/admin/wallet/resets/${encodeURIComponent(resetPreview.id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ confirmation: resetPhrase }),
      });
      setMessage(
        'Старый сезон закрыт, новый сезон с нулевыми счетами создан. История и заказы сохранены.',
      );
      setResetPhrase('');
      setResetPreview(null);
      setResetReason('');
    } catch (caught) {
      setMessage(unavailableMessage(caught));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <BuilderHeader kicker="Программа лояльности" title="Название и правила">
        Тексты вынесены в настройки, поэтому «Мои баллы» можно заменить без переработки интерфейса.
      </BuilderHeader>
      <Card className="admin-form-card">
        <form className="admin-form" onSubmit={save} aria-busy={settingsStatus === 'loading'}>
          {settingsStatus === 'loading' ? (
            <div className="notice info admin-wide" role="status">
              Загружаем текущие настройки…
            </div>
          ) : null}
          {settingsStatus === 'error' ? (
            <div className="notice error admin-wide" role="alert">
              <p>{settingsError ?? 'Не удалось загрузить текущие настройки.'}</p>
              <Button
                type="button"
                className="secondary-button compact-button"
                onClick={loadSettings}
              >
                Повторить загрузку
              </Button>
            </div>
          ) : null}
          <label>
            <span>Заголовок кошелька</span>
            <input
              value={form.walletTitle}
              onChange={(event) => setForm({ ...form, walletTitle: event.target.value })}
              required
            />
          </label>
          <label>
            <span>Приветственное начисление</span>
            <input
              value={form.welcomeAmount}
              onChange={(event) =>
                setForm({
                  ...form,
                  welcomeAmount: event.target.value.replace(/\D/g, ''),
                })
              }
              inputMode="numeric"
              required
            />
          </label>
          <label>
            <span>Награда за Leader-ID</span>
            <input
              value={form.leaderIdSubscriptionReward}
              onChange={(event) =>
                setForm({
                  ...form,
                  leaderIdSubscriptionReward: event.target.value.replace(/\D/g, ''),
                })
              }
              inputMode="numeric"
              aria-describedby="leader-id-reward-help"
              required
            />
            <small id="leader-id-reward-help">0 отключает начисление</small>
          </label>
          <label>
            <span>1</span>
            <input
              value={form.unitOne}
              onChange={(event) => setForm({ ...form, unitOne: event.target.value })}
              required
            />
          </label>
          <label>
            <span>2–4</span>
            <input
              value={form.unitFew}
              onChange={(event) => setForm({ ...form, unitFew: event.target.value })}
              required
            />
          </label>
          <label>
            <span>5+</span>
            <input
              value={form.unitMany}
              onChange={(event) => setForm({ ...form, unitMany: event.target.value })}
              required
            />
          </label>
          <label>
            <span>Символ</span>
            <input
              value={form.symbol}
              onChange={(event) => setForm({ ...form, symbol: event.target.value })}
              maxLength={20}
            />
          </label>
          <label>
            <span>Максимум одной операции</span>
            <input
              value={form.maxTransactionAmount}
              onChange={(event) =>
                setForm({
                  ...form,
                  maxTransactionAmount: event.target.value.replace(/\D/g, ''),
                })
              }
              inputMode="numeric"
            />
          </label>
          <label>
            <span>QR живёт, секунд</span>
            <input
              value={form.qrTtlSeconds}
              onChange={(event) =>
                setForm({
                  ...form,
                  qrTtlSeconds: event.target.value.replace(/\D/g, ''),
                })
              }
              inputMode="numeric"
            />
          </label>
          <label>
            <span>Intent живёт, секунд</span>
            <input
              value={form.intentTtlSeconds}
              onChange={(event) =>
                setForm({
                  ...form,
                  intentTtlSeconds: event.target.value.replace(/\D/g, ''),
                })
              }
              inputMode="numeric"
            />
          </label>
          <label>
            <span>URL иконки</span>
            <input
              type="url"
              value={form.iconUrl}
              onChange={(event) => setForm({ ...form, iconUrl: event.target.value })}
            />
          </label>
          <fieldset className="wallet-permissions admin-wide">
            <legend>Функции</legend>
            <label>
              <input
                type="checkbox"
                checked={form.p2pEnabled}
                onChange={(event) => setForm({ ...form, p2pEnabled: event.target.checked })}
              />{' '}
              Переводы между участниками
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.storeEnabled}
                onChange={(event) => setForm({ ...form, storeEnabled: event.target.checked })}
              />{' '}
              Магазин
            </label>
          </fieldset>
          {message ? <div className="notice info admin-wide">{message}</div> : null}
          <Button
            type="submit"
            className="primary-button compact-button"
            disabled={saving || settingsStatus !== 'ready'}
          >
            {saving ? 'Сохраняем…' : 'Сохранить настройки'}
          </Button>
        </form>
      </Card>
      <Card className="admin-form-card wallet-danger-zone">
        <p className="eyebrow">Опасная зона</p>
        <h2>Открыть новый сезон с нулём</h2>
        <p>
          История старого сезона и заказы сохранятся. Старые счета будут закрыты, а новые счета
          существующих участников начнутся с 0. Новые пользователи позже всё ещё получат
          приветственное начисление.
        </p>
        <label>
          <span>Причина reset *</span>
          <textarea
            rows={3}
            value={resetReason}
            onChange={(event) => setResetReason(event.target.value)}
            minLength={10}
            maxLength={1000}
          />
        </label>
        {resetPreview ? (
          <div className="wallet-reset-preview">
            <strong>
              {resetPreview.affectedAccounts} счетов · {formatPoints(resetPreview.previousTotal)}{' '}
              сейчас
            </strong>
            <p>Для подтверждения введите ID задания:</p>
            <code>{resetPreview.id}</code>
            <input
              aria-label="ID задания reset"
              value={resetPhrase}
              onChange={(event) => setResetPhrase(event.target.value)}
            />
          </div>
        ) : (
          <Button
            type="button"
            className="secondary-button"
            disabled={saving}
            onClick={previewReset}
          >
            Сделать предпросмотр
          </Button>
        )}
        <Button
          type="button"
          className="danger-button"
          disabled={saving || !resetPreview || resetPhrase !== resetPreview.id}
          onClick={reset}
        >
          Подтвердить новый сезон
        </Button>
      </Card>
    </>
  );
}
