'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { api } from '../lib/api';
import { formatNovosibirskDateTime } from '../lib/dates';

type RequestStatus = 'new' | 'in_progress' | 'closed';

interface RequestUser {
  id: string;
  fullName: string | null;
  telegramUsername: string | null;
  telegramFirstName: string | null;
  telegramLastName: string | null;
}

interface AdminUser {
  id: string;
  fullName: string | null;
  telegramUsername: string | null;
  roles: string[];
}

interface EventRequestItem {
  id: string;
  text: string;
  status: RequestStatus;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  event: { id: string; title: string };
  user: RequestUser;
  crm: {
    artifactId: string | null;
    artifactVersionId: string | null;
    taskId: string | null;
    syncedAt: string | null;
    pendingReviewAt: string | null;
    error: string | null;
  } | null;
}

const statusLabels: Record<RequestStatus, string> = {
  new: 'Новое',
  in_progress: 'В работе',
  closed: 'Закрыто',
};

function userName(user: RequestUser | AdminUser): string {
  if (user.fullName?.trim()) return user.fullName.trim();
  if ('telegramFirstName' in user) {
    const telegramName = [user.telegramFirstName, user.telegramLastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (telegramName) return telegramName;
  }
  return user.telegramUsername ? `@${user.telegramUsername}` : 'Пользователь Telegram';
}

function crmState(item: EventRequestItem): {
  tone: string;
  label: string;
  detail: string;
} {
  if (item.crm?.syncedAt && item.crm.artifactId && item.crm.taskId) {
    return {
      tone: 'success',
      label: 'Передано в CRM',
      detail: 'Задача и текстовый артефакт созданы',
    };
  }
  if (item.crm?.pendingReviewAt) {
    return {
      tone: 'warning',
      label: 'Нужна привязка участника',
      detail: 'Обращение ожидает разбора дубля в CRM',
    };
  }
  if (item.crm?.error) {
    return {
      tone: 'error',
      label: 'Ошибка синхронизации',
      detail: item.crm.error,
    };
  }
  return {
    tone: 'pending',
    label: 'В очереди',
    detail: 'Задача и артефакт создаются',
  };
}

export function AdminEventRequests() {
  const [items, setItems] = useState<EventRequestItem[]>([]);
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [status, setStatus] = useState<RequestStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const parameters = new URLSearchParams({ limit: '200' });
      if (status !== 'all') parameters.set('status', status);
      const [requests, users] = await Promise.all([
        api<{ items: EventRequestItem[] }>(`/admin/event-requests?${parameters}`),
        api<{ items: AdminUser[] }>('/admin/users?limit=200'),
      ]);
      setItems(requests.items);
      setAdmins(
        users.items
          .filter((user) => user.roles.some((role) => role === 'admin' || role === 'superadmin'))
          .sort((left, right) => userName(left).localeCompare(userName(right), 'ru')),
      );
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось загрузить обращения');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => void load(), [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru');
    if (!needle) return items;
    return items.filter((item) =>
      [userName(item.user), item.user.telegramUsername, item.event.title, item.text]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase('ru').includes(needle)),
    );
  }, [items, query]);

  const update = async (
    item: EventRequestItem,
    values: { status?: RequestStatus; assignedTo?: string | null },
  ) => {
    setWorkingId(item.id);
    setMessage(null);
    try {
      await api(`/admin/event-requests/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: values.status ?? item.status,
          ...(values.assignedTo === undefined ? {} : { assignedTo: values.assignedTo }),
        }),
      });
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось обновить обращение');
    } finally {
      setWorkingId(null);
    }
  };

  const retryCrm = async (item: EventRequestItem) => {
    setWorkingId(item.id);
    setMessage(null);
    try {
      await api(`/admin/event-requests/${encodeURIComponent(item.id)}/retry-crm`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setMessage('Синхронизация обращения поставлена в очередь');
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось повторить синхронизацию');
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <section className="admin-request-board">
      <Card className="admin-request-toolbar">
        <div>
          <p className="eyebrow">Вопросы участников</p>
          <h2>Обращения по мероприятиям</h2>
          <p>Каждое обращение одновременно создаёт задачу и текстовый артефакт участника.</p>
        </div>
        <div className="admin-request-filters">
          <label>
            <span>Статус</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="all">Все</option>
              <option value="new">Новые</option>
              <option value="in_progress">В работе</option>
              <option value="closed">Закрытые</option>
            </select>
          </label>
          <label>
            <span>Поиск</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Участник, событие или текст"
            />
          </label>
        </div>
      </Card>

      {message ? (
        <div className="notice" aria-live="polite">
          {message}
        </div>
      ) : null}
      {loading ? (
        <div className="admin-loading">
          <Spinner />
        </div>
      ) : visible.length ? (
        <div className="admin-request-list">
          {visible.map((item) => {
            const sync = crmState(item);
            const working = workingId === item.id;
            return (
              <Card className="admin-request-card" key={item.id}>
                <div className="admin-request-card__head">
                  <div>
                    <span>{item.event.title}</span>
                    <h3>{userName(item.user)}</h3>
                    <small>
                      {item.user.telegramUsername ? `@${item.user.telegramUsername} · ` : ''}
                      {formatNovosibirskDateTime(item.createdAt)}
                    </small>
                  </div>
                  <span className={`admin-request-sync admin-request-sync--${sync.tone}`}>
                    <strong>{sync.label}</strong>
                    <small>{sync.detail}</small>
                  </span>
                </div>
                <p className="admin-request-text">{item.text}</p>
                <div className="admin-request-controls">
                  <label>
                    <span>Статус</span>
                    <select
                      value={item.status}
                      disabled={working}
                      onChange={(event) =>
                        void update(item, {
                          status: event.target.value as RequestStatus,
                        })
                      }
                    >
                      {Object.entries(statusLabels).map(([value, label]) => (
                        <option value={value} key={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Ответственный в боте</span>
                    <select
                      value={item.assignedTo ?? ''}
                      disabled={working}
                      onChange={(event) =>
                        void update(item, {
                          assignedTo: event.target.value || null,
                        })
                      }
                    >
                      <option value="">Не назначен</option>
                      {admins.map((admin) => (
                        <option value={admin.id} key={admin.id}>
                          {userName(admin)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!item.crm?.syncedAt ? (
                    <Button
                      type="button"
                      className="secondary-button compact-button"
                      disabled={working}
                      onClick={() => void retryCrm(item)}
                    >
                      {working ? 'Отправляем…' : 'Повторить синхронизацию'}
                    </Button>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="admin-empty-state">
          <h2>Обращений нет</h2>
          <p>Новые вопросы участников появятся здесь сразу после отправки.</p>
        </Card>
      )}
    </section>
  );
}
