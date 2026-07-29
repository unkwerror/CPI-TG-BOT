'use client';

import Image from 'next/image';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import {
  eventShortCodeFromTitle,
  eventSlugFromTitle,
  type ArtifactStatus,
  type EventFormat,
  type EventStatus,
  type ExportKind,
} from '@cpi/shared';
import { api } from '../lib/api';
import {
  NOVOSIBIRSK_LABEL,
  NOVOSIBIRSK_TIME_ZONE,
  addHoursToNovosibirskInput,
  formatNovosibirskDate,
  formatNovosibirskDateTime,
  fromNovosibirskInput,
  novosibirskInputAfter,
  toNovosibirskInput,
} from '../lib/dates';
import type { ArtifactItem, CurrentUser, EventItem, ExportJob } from '../lib/types';
import { UserIcon } from './icons';
import { useSession } from './session-provider';

type AdminTab =
  'dashboard' | 'events' | 'participants' | 'artifacts' | 'exports' | 'audit' | 'admins';

interface DashboardData {
  activeEvents: number;
  participants: number;
  submissions: number;
  artifacts: number;
  storageBytes: number;
  failedUploads: number;
  latestUploads: Array<ArtifactItem & { user: CurrentUser; event: EventItem }>;
}

function openDownloadUrl(url: string): void {
  try {
    const telegram = window.Telegram?.WebApp;
    if (telegram?.openLink) {
      telegram.openLink(url, { try_instant_view: false });
      return;
    }
  } catch {
    // Continue with a regular browser link when the Telegram client rejects it.
  }
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.append(link);
  link.click();
  link.remove();
}

export function AdminApp() {
  const { user, loading, error } = useSession();
  const [tab, setTab] = useState<AdminTab>('dashboard');
  const [eventId, setEventId] = useState('');

  if (loading) {
    return (
      <main className="center-state">
        <Spinner />
        <h1>Открываем панель</h1>
      </main>
    );
  }
  if (error || !user || !user.roles.some((role) => role === 'admin' || role === 'superadmin')) {
    return (
      <main className="center-state error-state">
        <h1>Доступ запрещён</h1>
        <p>{error ?? 'Для этого раздела нужна роль администратора.'}</p>
        <a className="ui-button primary-button" href="/">
          Вернуться в приложение
        </a>
      </main>
    );
  }

  const tabs: Array<{ key: AdminTab; label: string }> = [
    { key: 'dashboard', label: 'Обзор' },
    { key: 'events', label: 'Мероприятия' },
    { key: 'participants', label: 'Участники' },
    { key: 'artifacts', label: 'Файлы' },
    { key: 'exports', label: 'Экспорт' },
    { key: 'audit', label: 'Журнал' },
    ...(user.roles.includes('superadmin')
      ? ([{ key: 'admins', label: 'Администраторы' }] as const)
      : []),
  ];

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <Image
            className="admin-brand-cat"
            src="/cats/cat-2.svg"
            alt=""
            width={64}
            height={64}
            unoptimized
          />
          <div>
            <strong>Артефакты</strong>
            <span>Панель управления</span>
          </div>
        </div>
        <nav aria-label="Разделы администрирования">
          {tabs.map((item) => (
            <button
              key={item.key}
              className={tab === item.key ? 'active' : ''}
              type="button"
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="admin-user">
          <UserIcon />
          <div>
            <strong>{user.fullName}</strong>
            <a href="/">В приложение участника</a>
          </div>
        </div>
      </aside>
      <section className="admin-content">
        <AdminHeader
          title={tabs.find((item) => item.key === tab)?.label ?? 'Администрирование'}
          user={user}
        />
        {tab === 'dashboard' ? <Dashboard /> : null}
        {tab === 'events' ? (
          <EventManagement
            onChooseEvent={(id) => {
              setEventId(id);
              setTab('exports');
            }}
            onDeletedEvent={(id) => {
              setEventId((current) => (current === id ? '' : current));
            }}
          />
        ) : null}
        {tab === 'participants' ? (
          <Participants eventId={eventId} onEventChange={setEventId} />
        ) : null}
        {tab === 'artifacts' ? <Artifacts eventId={eventId} onEventChange={setEventId} /> : null}
        {tab === 'exports' ? <Exports eventId={eventId} onEventChange={setEventId} /> : null}
        {tab === 'audit' ? <Audit /> : null}
        {tab === 'admins' ? <Admins /> : null}
      </section>
    </main>
  );
}

function AdminHeader({ title, user }: { title: string; user: CurrentUser }) {
  return (
    <header className="admin-header">
      <div>
        <p className="eyebrow">Панель управления</p>
        <h1>{title}</h1>
      </div>
      <span>{user.roles.includes('superadmin') ? 'Суперадминистратор' : 'Администратор'}</span>
    </header>
  );
}

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<DashboardData>('/admin/dashboard')
      .then(setData)
      .catch((caught: Error) => setError(caught.message));
  }, []);
  if (error) return <div className="notice error">{error}</div>;
  if (!data)
    return (
      <div className="admin-loading">
        <Spinner />
      </div>
    );
  const cards = [
    ['Активных мероприятий', data.activeEvents],
    ['Участников', data.participants],
    ['Отправок', data.submissions],
    ['Файлов', data.artifacts],
    ['Объём хранилища', formatBytes(data.storageBytes)],
    ['Ошибок загрузки', data.failedUploads],
  ];
  return (
    <>
      <div className="stat-grid">
        {cards.map(([label, value]) => (
          <Card className="stat-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </Card>
        ))}
      </div>
      <Card className="admin-table-card">
        <h2>Последние загрузки</h2>
        <div className="admin-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Файл</th>
                <th>Автор</th>
                <th>Мероприятие</th>
                <th>Размер</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {data.latestUploads.map((item) => (
                <tr key={item.id}>
                  <td>{item.displayName}</td>
                  <td>{item.user.fullName}</td>
                  <td>{item.event.title}</td>
                  <td>{formatBytes(item.sizeBytes)}</td>
                  <td>
                    <Status value={item.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function EventSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [events, setEvents] = useState<EventItem[]>([]);
  useEffect(() => {
    void api<{ items: EventItem[] }>('/admin/events?limit=100').then((result) => {
      setEvents(result.items);
      if (!value && result.items[0]) onChange(result.items[0].id);
    });
  }, [onChange, value]);
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Мероприятие"
    >
      <option value="">Все мероприятия</option>
      {events.map((event) => (
        <option key={event.id} value={event.id}>
          {event.title}
        </option>
      ))}
    </select>
  );
}

interface EventFormState {
  title: string;
  slug: string;
  shortCode: string;
  description: string;
  organizer: string;
  startsAt: string;
  endsAt: string;
  venue: string;
  city: string;
  format: EventFormat;
  status: EventStatus;
  tags: string;
  acceptUploadsFrom: string;
  acceptUploadsUntil: string;
  maxFileSizeMb: number;
  directAccessEnabled: boolean;
}

const blankEvent = (): EventFormState => ({
  title: '',
  slug: 'event',
  shortCode: 'EVENT',
  description: '',
  organizer: 'ЦПИ',
  startsAt: novosibirskInputAfter(24),
  endsAt: novosibirskInputAfter(48),
  venue: '',
  city: 'Новосибирск',
  format: 'offline',
  status: 'draft',
  tags: '',
  acceptUploadsFrom: novosibirskInputAfter(0),
  acceptUploadsUntil: novosibirskInputAfter(48),
  maxFileSizeMb: 500,
  directAccessEnabled: true,
});

function eventToForm(event: EventItem): EventFormState {
  return {
    title: event.title,
    slug: event.slug,
    shortCode: event.shortCode,
    description: event.description ?? '',
    organizer: event.organizer,
    startsAt: toNovosibirskInput(event.startsAt),
    endsAt: toNovosibirskInput(event.endsAt),
    venue: event.venue ?? '',
    city: event.city ?? '',
    format: event.format,
    status: event.status,
    tags: event.tags.join(', '),
    acceptUploadsFrom: toNovosibirskInput(event.acceptUploadsFrom),
    acceptUploadsUntil: toNovosibirskInput(event.acceptUploadsUntil),
    maxFileSizeMb: Math.round(event.maxFileSizeBytes / 1024 ** 2),
    directAccessEnabled: event.directAccessEnabled,
  };
}

function generatedEventIdentifiers(
  title: string,
  existingEvents: EventItem[],
  excludedEventId?: string,
): { slug: string; shortCode: string } {
  const slugBase = eventSlugFromTitle(title);
  const codeBase = eventShortCodeFromTitle(title);
  const otherEvents = existingEvents.filter((event) => event.id !== excludedEventId);
  const usedSlugs = new Set(otherEvents.map((event) => event.slug));
  const usedCodes = new Set(otherEvents.map((event) => event.shortCode));
  let suffix = 1;
  let slug = slugBase;
  while (usedSlugs.has(slug)) {
    suffix += 1;
    const ending = `-${suffix}`;
    slug = `${slugBase.slice(0, 100 - ending.length)}${ending}`;
  }
  suffix = 1;
  let shortCode = codeBase;
  while (usedCodes.has(shortCode)) {
    suffix += 1;
    const ending = `_${suffix}`;
    shortCode = `${codeBase.slice(0, 24 - ending.length)}${ending}`;
  }
  return { slug, shortCode };
}

function EventManagement({
  onChooseEvent,
  onDeletedEvent,
}: {
  onChooseEvent: (id: string) => void;
  onDeletedEvent: (id: string) => void;
}) {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [editing, setEditing] = useState<EventItem | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<EventItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<EventFormState>(blankEvent);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api<{ items: EventItem[] }>('/admin/events?limit=100');
    setEvents(result.items);
  }, []);
  useEffect(() => void load(), [load]);

  const update = <K extends keyof EventFormState>(key: K, value: EventFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const updateTitle = (title: string) => {
    const identifiers = generatedEventIdentifiers(title, events, editing?.id);
    setForm((current) => ({ ...current, title, ...identifiers }));
  };

  const updateStartsAt = (startsAt: string) => {
    setForm((current) => ({
      ...current,
      startsAt,
      endsAt:
        !startsAt || (current.endsAt && current.endsAt > startsAt)
          ? current.endsAt
          : addHoursToNovosibirskInput(startsAt, 1),
    }));
  };

  const updateAcceptsFrom = (acceptUploadsFrom: string) => {
    setForm((current) => ({
      ...current,
      acceptUploadsFrom,
      acceptUploadsUntil:
        !acceptUploadsFrom ||
        (current.acceptUploadsUntil && current.acceptUploadsUntil > acceptUploadsFrom)
          ? current.acceptUploadsUntil
          : addHoursToNovosibirskInput(acceptUploadsFrom, 1),
    }));
  };

  const save = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setMessage(null);
    if (form.endsAt <= form.startsAt) {
      setMessage('Окончание мероприятия должно быть позже начала');
      return;
    }
    if (form.acceptUploadsUntil <= form.acceptUploadsFrom) {
      setMessage('Окончание приёма должно быть позже его начала');
      return;
    }
    try {
      const identifiers = generatedEventIdentifiers(form.title, events, editing?.id);
      const payload = {
        title: form.title,
        ...identifiers,
        description: form.description || null,
        organizer: form.organizer,
        startsAt: fromNovosibirskInput(form.startsAt),
        endsAt: fromNovosibirskInput(form.endsAt),
        timezone: NOVOSIBIRSK_TIME_ZONE,
        venue: form.venue || null,
        city: form.city || null,
        format: form.format,
        status: form.status,
        tags: form.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        coverUrl: null,
        acceptUploadsFrom: fromNovosibirskInput(form.acceptUploadsFrom),
        acceptUploadsUntil: fromNovosibirskInput(form.acceptUploadsUntil),
        maxFileSizeBytes: form.maxFileSizeMb * 1024 ** 2,
        allowedMimeTypes: [],
        blockedExtensions: ['exe', 'bat', 'cmd', 'msi'],
        directAccessEnabled: form.directAccessEnabled,
      };
      const saved = await api<EventItem>(
        editing ? `/admin/events/${editing.id}` : '/admin/events',
        {
          method: editing ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        },
      );
      setMessage('Мероприятие сохранено');
      setEditing(null);
      setShowForm(false);
      setForm(blankEvent());
      onChooseEvent(saved.id);
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось сохранить мероприятие');
    }
  };

  const remove = async () => {
    if (!deleteCandidate || deleting) return;
    setDeleting(true);
    setMessage(null);
    try {
      await api(`/admin/events/${deleteCandidate.id}`, { method: 'DELETE' });
      onDeletedEvent(deleteCandidate.id);
      setDeleteCandidate(null);
      setMessage('Мероприятие и все его файлы удалены');
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось удалить мероприятие');
    } finally {
      setDeleting(false);
    }
  };

  if (showForm) {
    return (
      <Card className="admin-form-card">
        <div className="admin-section-heading">
          <h2>{editing ? 'Редактировать мероприятие' : 'Новое мероприятие'}</h2>
          <button type="button" className="text-button" onClick={() => setShowForm(false)}>
            Отмена
          </button>
        </div>
        <form className="admin-form" onSubmit={save}>
          <Field label="Название">
            <input
              value={form.title}
              onChange={(event) => updateTitle(event.target.value)}
              required
            />
          </Field>
          <Field label="Организатор">
            <input
              value={form.organizer}
              onChange={(event) => update('organizer', event.target.value)}
              required
            />
          </Field>
          <div className="generated-identifiers admin-wide" aria-live="polite">
            <div>
              <span>Slug создаётся автоматически</span>
              <code>{form.slug}</code>
            </div>
            <div>
              <span>Короткий код создаётся автоматически</span>
              <code>{form.shortCode}</code>
            </div>
          </div>
          <div className="timezone-banner admin-wide">
            <strong>Все даты: {NOVOSIBIRSK_LABEL}</strong>
            <span>Выберите дату в календаре и время отдельно — пересчёт не требуется.</span>
          </div>
          <DateTimeField
            label="Начало мероприятия"
            value={form.startsAt}
            onChange={updateStartsAt}
          />
          <DateTimeField
            label="Окончание мероприятия"
            value={form.endsAt}
            minValue={form.startsAt}
            onChange={(value) => update('endsAt', value)}
          />
          <DateTimeField
            label="Начало приёма материалов"
            value={form.acceptUploadsFrom}
            onChange={updateAcceptsFrom}
          />
          <DateTimeField
            label="Окончание приёма материалов"
            value={form.acceptUploadsUntil}
            minValue={form.acceptUploadsFrom}
            onChange={(value) => update('acceptUploadsUntil', value)}
          />
          <Field label="Город">
            <input value={form.city} onChange={(event) => update('city', event.target.value)} />
          </Field>
          <Field label="Место">
            <input value={form.venue} onChange={(event) => update('venue', event.target.value)} />
          </Field>
          <Field label="Формат">
            <select
              value={form.format}
              onChange={(event) => update('format', event.target.value as EventFormat)}
            >
              <option value="offline">Очно</option>
              <option value="online">Онлайн</option>
              <option value="hybrid">Гибрид</option>
            </select>
          </Field>
          <Field label="Статус">
            <select
              value={form.status}
              onChange={(event) => update('status', event.target.value as EventStatus)}
            >
              <option value="draft">Черновик</option>
              <option value="published">Опубликовано</option>
              <option value="running">Идёт</option>
              <option value="finished">Завершено</option>
              <option value="archived">Архив</option>
            </select>
          </Field>
          <Field label="Лимит файла, МБ">
            <input
              type="number"
              min={1}
              max={10_240}
              value={form.maxFileSizeMb}
              onChange={(event) => update('maxFileSizeMb', Number(event.target.value))}
            />
          </Field>
          <Field label="Теги через запятую">
            <input value={form.tags} onChange={(event) => update('tags', event.target.value)} />
          </Field>
          <Field label="Описание" wide>
            <textarea
              rows={5}
              value={form.description}
              onChange={(event) => update('description', event.target.value)}
            />
          </Field>
          <label className="checkbox-field admin-wide">
            <input
              type="checkbox"
              checked={form.directAccessEnabled}
              onChange={(event) => update('directAccessEnabled', event.target.checked)}
            />
            <span>Доступно по прямой ссылке и QR-коду</span>
          </label>
          {message ? (
            <div
              className={`notice ${message.includes('сохранено') ? 'success' : 'error'} admin-wide`}
            >
              {message}
            </div>
          ) : null}
          <Button className="primary-button admin-wide" type="submit">
            Сохранить
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <>
      <div className="admin-toolbar">
        <p>{events.length} мероприятий</p>
        <Button
          className="primary-button compact-button"
          type="button"
          onClick={() => {
            setEditing(null);
            setDeleteCandidate(null);
            setForm(blankEvent());
            setShowForm(true);
          }}
        >
          Создать мероприятие
        </Button>
      </div>
      {message ? (
        <div className={`notice ${message.includes('удалены') ? 'success' : 'error'}`}>
          {message}
        </div>
      ) : null}
      {deleteCandidate ? (
        <Card className="event-delete-confirm">
          <div>
            <h2>Удалить «{deleteCandidate.title}»?</h2>
            <p>
              Мероприятие исчезнет из приложения. Все артефакты, незавершённые загрузки и готовые
              выгрузки будут безвозвратно удалены из хранилища.
            </p>
          </div>
          <div className="row-actions">
            <Button type="button" disabled={deleting} onClick={() => setDeleteCandidate(null)}>
              Отмена
            </Button>
            <Button
              className="danger-button"
              type="button"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? 'Удаляем файлы…' : 'Удалить мероприятие и файлы'}
            </Button>
          </div>
        </Card>
      ) : null}
      <div className="admin-card-grid">
        {events.map((event) => (
          <Card className="admin-event-card" key={event.id}>
            <div>
              <Status value={event.status} />
              <span className="event-code">{event.shortCode}</span>
            </div>
            <h2>{event.title}</h2>
            <p>
              {formatNovosibirskDateTime(event.startsAt)} · {event.city || event.format}
            </p>
            <div className="row-actions">
              <Button
                className="primary-button compact-button"
                type="button"
                onClick={() => onChooseEvent(event.id)}
              >
                Выгрузить
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setDeleteCandidate(null);
                  setEditing(event);
                  setForm(eventToForm(event));
                  setShowForm(true);
                }}
              >
                Изменить
              </Button>
              <Button
                className="danger-text-button"
                type="button"
                onClick={() => setDeleteCandidate(event)}
              >
                Удалить
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={wide ? 'admin-wide' : ''}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function DateTimeField({
  label,
  value,
  minValue,
  onChange,
}: {
  label: string;
  value: string;
  minValue?: string;
  onChange: (value: string) => void;
}) {
  const [date = '', time = ''] = value.split('T');
  const [minimumDate = '', minimumTime = ''] = (minValue ?? '').split('T');
  return (
    <fieldset className="datetime-field">
      <legend>{label}</legend>
      <div className="datetime-controls">
        <label>
          <span>Дата</span>
          <input
            type="date"
            value={date}
            min={minimumDate || undefined}
            onChange={(event) => {
              const nextDate = event.target.value;
              onChange(nextDate ? `${nextDate}T${time || '09:00'}` : '');
            }}
            required
          />
        </label>
        <label>
          <span>Время</span>
          <input
            type="time"
            value={time}
            min={date && date === minimumDate ? minimumTime || undefined : undefined}
            step={300}
            onChange={(event) => {
              const nextTime = event.target.value;
              onChange(date && nextTime ? `${date}T${nextTime}` : '');
            }}
            required
          />
        </label>
      </div>
      <small>{NOVOSIBIRSK_LABEL}</small>
    </fieldset>
  );
}

interface AdminParticipant extends CurrentUser {
  joinedAt: string | null;
  lastSubmissionAt: string | null;
  submissionCount: number;
  artifactCount: number;
  totalBytes: number;
}

function Participants({
  eventId,
  onEventChange,
}: {
  eventId: string;
  onEventChange: (id: string) => void;
}) {
  const [items, setItems] = useState<AdminParticipant[]>([]);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const parameters = new URLSearchParams({ limit: '100' });
    if (eventId) parameters.set('eventId', eventId);
    if (query) parameters.set('q', query);
    const timer = setTimeout(
      () =>
        void api<{ items: AdminParticipant[] }>(`/admin/users?${parameters}`).then((result) =>
          setItems(result.items),
        ),
      250,
    );
    return () => clearTimeout(timer);
  }, [eventId, query]);
  return (
    <Card className="admin-table-card">
      <div className="admin-toolbar">
        <EventSelect value={eventId} onChange={onEventChange} />
        <input
          className="admin-search"
          placeholder="Поиск участника"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <Table
        headings={['ФИО', 'Telegram', 'Организация', 'Отправок', 'Файлов', 'Объём', 'Активность']}
      >
        {items.map((item) => (
          <tr key={item.id}>
            <td>{item.fullName}</td>
            <td>
              @{item.telegramUsername || '—'}
              <small>{item.telegramUserId}</small>
            </td>
            <td>
              {item.organization || '—'}
              <small>{item.position}</small>
            </td>
            <td>{item.submissionCount}</td>
            <td>{item.artifactCount}</td>
            <td>{formatBytes(item.totalBytes)}</td>
            <td>{item.lastSubmissionAt ? formatNovosibirskDate(item.lastSubmissionAt) : '—'}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

interface AdminArtifact extends ArtifactItem {
  user: CurrentUser;
  event: EventItem;
}

function Artifacts({
  eventId,
  onEventChange,
}: {
  eventId: string;
  onEventChange: (id: string) => void;
}) {
  const [items, setItems] = useState<AdminArtifact[]>([]);
  const [status, setStatus] = useState('');
  const load = useCallback(async () => {
    const parameters = new URLSearchParams({ limit: '100' });
    if (eventId) parameters.set('eventId', eventId);
    if (status) parameters.set('status', status);
    const result = await api<{ items: AdminArtifact[] }>(`/admin/artifacts?${parameters}`);
    setItems(result.items);
  }, [eventId, status]);
  useEffect(() => void load(), [load]);
  const download = async (id: string) => {
    const result = await api<{ url: string }>(`/artifacts/${id}/download`);
    openDownloadUrl(result.url);
  };
  const changeStatus = async (id: string, next: ArtifactStatus) => {
    await api(`/admin/artifacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: next }),
    });
    await load();
  };
  return (
    <Card className="admin-table-card">
      <div className="admin-toolbar">
        <EventSelect value={eventId} onChange={onEventChange} />
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Все статусы</option>
          <option value="ready">Готово</option>
          <option value="verifying">Проверка</option>
          <option value="failed">Ошибка</option>
          <option value="quarantined">Карантин</option>
        </select>
      </div>
      <Table headings={['Файл', 'Автор', 'Мероприятие', 'Размер', 'Статус', 'SHA-256', 'Действия']}>
        {items.map((item) => (
          <tr key={item.id}>
            <td>
              {item.displayName}
              <small>{item.mimeType}</small>
            </td>
            <td>{item.user.fullName}</td>
            <td>{item.event.title}</td>
            <td>{formatBytes(item.sizeBytes)}</td>
            <td>
              <Status value={item.status} />
            </td>
            <td className="checksum">{item.checksumSha256 || '—'}</td>
            <td>
              <div className="row-actions">
                {item.status === 'ready' ? (
                  <button type="button" onClick={() => void download(item.id)}>
                    Скачать
                  </button>
                ) : null}
                {item.status === 'quarantined' || item.status === 'failed' ? (
                  <button type="button" onClick={() => void changeStatus(item.id, 'ready')}>
                    Одобрить
                  </button>
                ) : null}
                <button type="button" onClick={() => void changeStatus(item.id, 'deleted')}>
                  Удалить
                </button>
              </div>
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function Exports({
  eventId,
  onEventChange,
}: {
  eventId: string;
  onEventChange: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [manualDownloadUrl, setManualDownloadUrl] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await api<{ items: ExportJob[] }>(
      `/admin/exports${eventId ? `?eventId=${eventId}` : ''}`,
    );
    setJobs(result.items);
  }, [eventId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [load]);
  const create = async (kind: ExportKind) => {
    if (!eventId) return;
    setMessage('Формируем выгрузку — она появится в таблице ниже.');
    try {
      await api('/admin/exports', { method: 'POST', body: JSON.stringify({ eventId, kind }) });
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось создать выгрузку');
    }
  };
  const download = async (id: string) => {
    setMessage('Открываем файл во внешнем браузере…');
    setManualDownloadUrl(null);
    try {
      const result = await api<{ url: string }>(`/admin/exports/${id}/download`);
      setManualDownloadUrl(result.url);
      openDownloadUrl(result.url);
      setMessage('Файл открыт. Если окно не появилось, нажмите ссылку ниже.');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось скачать выгрузку');
    }
  };
  return (
    <>
      <Card className="export-create">
        <div>
          <h2>Новая выгрузка</h2>
          <p>Выберите мероприятие и нужный формат. Готовый файл появится ниже.</p>
        </div>
        <EventSelect value={eventId} onChange={onEventChange} />
        <div className="row-actions">
          <Button disabled={!eventId} onClick={() => void create('csv')}>
            Таблица CSV
          </Button>
          <Button disabled={!eventId} onClick={() => void create('xlsx')}>
            Таблица XLSX
          </Button>
          <Button
            className="primary-button compact-button"
            disabled={!eventId}
            onClick={() => void create('zip')}
          >
            Все файлы ZIP
          </Button>
        </div>
        {!eventId ? <p className="export-hint">Сначала выберите мероприятие.</p> : null}
        {message ? <p className="export-hint">{message}</p> : null}
        {manualDownloadUrl ? (
          <a
            className="export-download-link"
            href={manualDownloadUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть готовый файл
          </a>
        ) : null}
      </Card>
      <Card className="admin-table-card">
        <Table headings={['Формат', 'Создан', 'Статус', 'Прогресс', 'Размер', 'Действие']}>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>{job.kind.toUpperCase()}</td>
              <td>{formatNovosibirskDateTime(job.createdAt)}</td>
              <td>
                <Status value={job.status} />
              </td>
              <td>{job.progress}%</td>
              <td>{job.sizeBytes ? formatBytes(job.sizeBytes) : '—'}</td>
              <td>
                {job.status === 'ready' ? (
                  <button type="button" onClick={() => void download(job.id)}>
                    Скачать
                  </button>
                ) : (
                  job.errorMessage
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

interface AuditItem {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

function Audit() {
  const [items, setItems] = useState<AuditItem[]>([]);
  useEffect(
    () =>
      void api<{ items: AuditItem[] }>('/admin/audit?limit=100').then((result) =>
        setItems(result.items),
      ),
    [],
  );
  return (
    <Card className="admin-table-card">
      <Table headings={['Дата', 'Действие', 'Тип', 'Объект', 'Детали']}>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{formatNovosibirskDateTime(item.createdAt)}</td>
            <td>{item.action}</td>
            <td>{item.entityType}</td>
            <td>{item.entityId || '—'}</td>
            <td className="metadata-cell">{JSON.stringify(item.metadata)}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

interface AdminUser extends CurrentUser {
  status: 'active' | 'blocked';
}

function Admins() {
  const [admins, setAdmins] = useState<Array<AdminUser & { roles: string[] }>>([]);
  const [users, setUsers] = useState<AdminParticipant[]>([]);
  const load = useCallback(async () => {
    const [adminResult, userResult] = await Promise.all([
      api<{ items: Array<AdminUser & { roles: string[] }> }>('/admin/admins'),
      api<{ items: AdminParticipant[] }>('/admin/users?limit=100'),
    ]);
    setAdmins(adminResult.items);
    setUsers(userResult.items);
  }, []);
  useEffect(() => void load(), [load]);
  const assign = async (userId: string) => {
    await api(`/admin/users/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin', enabled: true }),
    });
    await load();
  };
  const block = async (userId: string, blocked: boolean) => {
    await api(`/admin/users/${userId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: blocked ? 'blocked' : 'active' }),
    });
    await load();
  };
  return (
    <div className="admin-two-column">
      <Card className="admin-table-card">
        <h2>Назначенные администраторы</h2>
        <Table headings={['Имя', 'Telegram ID', 'Роли', 'Статус']}>
          {admins.map((item) => (
            <tr key={item.id}>
              <td>{item.fullName}</td>
              <td>{item.telegramUserId}</td>
              <td>{item.roles.join(', ')}</td>
              <td>
                <button
                  type="button"
                  onClick={() => void block(item.id, item.status !== 'blocked')}
                >
                  {item.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}
                </button>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card className="admin-table-card">
        <h2>Назначить из участников</h2>
        <Table headings={['Имя', 'Telegram ID', 'Действие']}>
          {users
            .filter((candidate) => !admins.some((admin) => admin.id === candidate.id))
            .slice(0, 30)
            .map((item) => (
              <tr key={item.id}>
                <td>{item.fullName}</td>
                <td>{item.telegramUserId}</td>
                <td>
                  <button type="button" onClick={() => void assign(item.id)}>
                    Назначить
                  </button>
                </td>
              </tr>
            ))}
        </Table>
      </Card>
    </div>
  );
}

function Table({ headings, children }: { headings: string[]; children: ReactNode }) {
  return (
    <div className="admin-table-scroll">
      <table>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th key={heading}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Status({ value }: { value: string }) {
  const active = ['ready', 'running', 'published', 'active'].includes(value);
  return <span className={`status-pill ${active ? 'active' : ''}`}>{value}</span>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
}
