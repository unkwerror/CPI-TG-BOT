'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { api } from '../lib/api';
import type { EventItem } from '../lib/types';
import { ArrowIcon, CalendarIcon, FilesIcon, UploadIcon, UserIcon } from './icons';
import { CatAssistant } from './cat-assistant';
import { EventsView } from './events-view';
import { MineView } from './mine-view';
import { ProfileView } from './profile-view';
import { useSession } from './session-provider';
import { SubmissionSheet } from './submission-sheet';

type Tab = 'events' | 'mine' | 'profile';

export function MiniApp() {
  const { user, loading, error, online } = useSession();
  const [tab, setTab] = useState<Tab>('events');
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  const [compose, setCompose] = useState(false);
  const [directEvent, setDirectEvent] = useState<EventItem | null>(null);

  useEffect(() => {
    const requestedTab = new URLSearchParams(window.location.search).get('tab');
    if (requestedTab === 'mine' || requestedTab === 'profile') setTab(requestedTab);
  }, []);

  useEffect(() => {
    if (!user) return;
    const parameters = new URLSearchParams(window.location.search);
    const queryEvent = parameters.get('event');
    const startParameter = window.Telegram?.WebApp.initDataUnsafe?.start_param;
    const startEvent = startParameter?.startsWith('event_')
      ? startParameter.slice(6)
      : startParameter;
    const key = queryEvent || startEvent;
    if (!key) return;
    void api<EventItem>(`/events/${encodeURIComponent(key)}`)
      .then((event) => {
        setDirectEvent(event);
        setSelectedEvent(event);
      })
      .catch(() => undefined);
  }, [user]);

  const openEvent = (event: EventItem) => {
    setSelectedEvent(event);
    const recent = JSON.parse(localStorage.getItem('recent-events') ?? '[]') as string[];
    localStorage.setItem(
      'recent-events',
      JSON.stringify([event.id, ...recent.filter((id) => id !== event.id)].slice(0, 5)),
    );
  };

  if (loading) {
    return (
      <main className="center-state cat-center-state">
        <CatAssistant
          mood="talk"
          title="Кот подключается"
          message="Секунду — проверяю безопасный вход через Telegram и готовлю мероприятия."
          live
        />
        <Spinner label="Авторизация" />
      </main>
    );
  }
  if (error || !user) {
    return (
      <main className="center-state error-state cat-center-state">
        <CatAssistant
          mood="sleep"
          title="Связь потерялась"
          message={error ?? 'Откройте приложение из Telegram-бота — так я смогу вас узнать.'}
        />
        <h1>Не удалось открыть приложение</h1>
        <Button type="button" className="primary-button" onClick={() => window.location.reload()}>
          Повторить
        </Button>
      </main>
    );
  }
  if (!user.profileComplete) {
    return (
      <main className="app-shell profile-required">
        {!online ? (
          <div className="offline-banner">Нет сети — изменения пока не сохранятся</div>
        ) : null}
        <ProfileView required />
      </main>
    );
  }

  return (
    <main className="app-shell">
      {!online ? (
        <div className="offline-banner">Нет сети. Загрузка продолжится после подключения.</div>
      ) : null}
      {selectedEvent ? (
        <EventDetail
          event={selectedEvent}
          onBack={() => {
            setSelectedEvent(null);
            setDirectEvent(null);
          }}
          onAdd={() => setCompose(true)}
        />
      ) : tab === 'events' ? (
        <EventsView onSelect={openEvent} initialEvent={directEvent} />
      ) : tab === 'mine' ? (
        <MineView />
      ) : (
        <ProfileView />
      )}

      {user.roles.some((role) => role === 'admin' || role === 'superadmin') && tab === 'profile' ? (
        <a href="/admin" className="admin-link">
          Открыть административную панель <ArrowIcon />
        </a>
      ) : null}

      {!selectedEvent ? (
        <nav className="bottom-nav" aria-label="Основная навигация">
          <button
            type="button"
            className={tab === 'events' ? 'active' : ''}
            onClick={() => setTab('events')}
          >
            <CalendarIcon />
            <span>Мероприятия</span>
          </button>
          <button
            type="button"
            className={tab === 'mine' ? 'active' : ''}
            onClick={() => setTab('mine')}
          >
            <FilesIcon />
            <span>Мои материалы</span>
          </button>
          <button
            type="button"
            className={tab === 'profile' ? 'active' : ''}
            onClick={() => setTab('profile')}
          >
            <UserIcon />
            <span>Профиль</span>
          </button>
        </nav>
      ) : null}

      {selectedEvent && compose ? (
        <SubmissionSheet
          event={selectedEvent}
          onClose={() => setCompose(false)}
          onSuccess={() => undefined}
        />
      ) : null}
    </main>
  );
}

function EventDetail({
  event,
  onBack,
  onAdd,
}: {
  event: EventItem;
  onBack: () => void;
  onAdd: () => void;
}) {
  const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: event.timezone,
  });
  return (
    <section className="screen event-detail">
      <button className="text-button back-button" type="button" onClick={onBack}>
        ← Мероприятия
      </button>
      {event.coverUrl ? (
        <img src={event.coverUrl} alt="" className="event-cover" />
      ) : (
        <div className="event-cover placeholder">
          <span className="event-cover-cat">
            <Image src="/cats/cat-4.svg" alt="" width={320} height={320} unoptimized />
          </span>
          <span>Материалы события</span>
        </div>
      )}
      <div className="event-detail-heading">
        <div>
          <span className={`status-pill ${event.acceptsUploads ? 'active' : ''}`}>
            {event.acceptsUploads ? 'Принимает материалы' : 'Приём закрыт'}
          </span>
          <span className="event-code">{event.shortCode}</span>
        </div>
        <h1>{event.title}</h1>
        <p>{event.description}</p>
      </div>
      <Card className="detail-grid">
        <div>
          <span>Начало</span>
          <strong>{dateFormatter.format(new Date(event.startsAt))}</strong>
        </div>
        <div>
          <span>Место</span>
          <strong>{[event.venue, event.city].filter(Boolean).join(', ') || 'Онлайн'}</strong>
        </div>
        <div>
          <span>Организатор</span>
          <strong>{event.organizer}</strong>
        </div>
        <div>
          <span>Лимит файла</span>
          <strong>{Math.round(event.maxFileSizeBytes / 1024 ** 2)} МБ</strong>
        </div>
      </Card>
      <CatAssistant
        mood={event.acceptsUploads ? 'upload' : 'sleep'}
        compact
        message={
          event.acceptsUploads
            ? 'Можно отправить файл, ссылку или заметку. Черновик сохранится, если отвлечётесь.'
            : 'Приём уже завершён. Ваши прежние отправки остаются в разделе «Мои материалы».'
        }
      />
      {event.tags.length ? (
        <div className="tag-row">
          {event.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      ) : null}
      <div className="sticky-action">
        <Button
          className="primary-button"
          type="button"
          onClick={onAdd}
          disabled={!event.acceptsUploads}
        >
          <UploadIcon />
          {event.acceptsUploads ? 'Добавить артефакт' : 'Приём материалов закрыт'}
        </Button>
      </div>
    </section>
  );
}
