'use client';

import Image from 'next/image';
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@cpi/ui';
import { api } from '../lib/api';
import type { EventItem } from '../lib/types';
import { CatAssistant, type CatMood } from './cat-assistant';
import { ArrowIcon, SearchIcon } from './icons';

function dateLabel(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(value));
}

function statusLabel(event: EventItem): string {
  if (event.acceptsUploads) return 'Принимает материалы';
  if (event.status === 'finished') return 'Завершено';
  if (event.status === 'published') return 'Скоро';
  return 'Приём закрыт';
}

export function EventsView({
  onSelect,
  initialEvent,
}: {
  onSelect: (event: EventItem) => void;
  initialEvent?: EventItem | null;
}) {
  const [events, setEvents] = useState<EventItem[]>(initialEvent ? [initialEvent] : []);
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('');
  const [format, setFormat] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const parameters = new URLSearchParams({ limit: '50' });
      if (query) parameters.set('q', query);
      if (city) parameters.set('city', city);
      if (format) parameters.set('format', format);
      if (status) parameters.set('status', status);
      setLoading(true);
      void api<{ items: EventItem[] }>(`/events?${parameters}`)
        .then((result) => {
          setEvents(result.items);
          setError(null);
        })
        .catch((caught: Error) => setError(caught.message))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, city, format, status]);

  const cities = useMemo(
    () => [...new Set(events.map((event) => event.city).filter(Boolean) as string[])].sort(),
    [events],
  );
  const assistant: { mood: CatMood; message: string } = loading
    ? {
        mood: 'search',
        message: query ? `Ищу «${query}» и проверяю фильтры…` : 'Собираю актуальные мероприятия…',
      }
    : events.length === 0
      ? {
          mood: 'sleep',
          message: 'Ничего не нашёл. Попробуйте убрать фильтр или ввести короткий код события.',
        }
      : query
        ? {
            mood: 'success',
            message: `Нашёл ${events.length}. Выберите карточку — внутри можно сразу добавить материалы.`,
          }
        : {
            mood: 'talk',
            message: 'Я помогу найти событие и доведу загрузку до конца. Начните с карточки ниже.',
          };

  return (
    <section className="screen" aria-labelledby="events-title">
      <header className="screen-header events-hero">
        <div className="events-hero__title">
          <p className="eyebrow">Сбор артефактов</p>
          <h1 id="events-title">Ваши материалы — на месте</h1>
          <p>Найдите мероприятие и передайте файлы, ссылку или заметку.</p>
        </div>
        <CatAssistant mood={assistant.mood} message={assistant.message} live />
      </header>

      <label className="search-field">
        <SearchIcon />
        <span className="sr-only">Поиск мероприятия</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Название, код, организатор"
          enterKeyHint="search"
        />
      </label>

      <div className="filter-row" aria-label="Фильтры мероприятий">
        <select value={city} onChange={(event) => setCity(event.target.value)} aria-label="Город">
          <option value="">Все города</option>
          {cities.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          value={format}
          onChange={(event) => setFormat(event.target.value)}
          aria-label="Формат"
        >
          <option value="">Любой формат</option>
          <option value="offline">Очно</option>
          <option value="online">Онлайн</option>
          <option value="hybrid">Гибрид</option>
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Статус"
        >
          <option value="">Любой статус</option>
          <option value="running">Идёт сейчас</option>
          <option value="published">Предстоящее</option>
          <option value="finished">Завершено</option>
        </select>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {loading ? (
        <div className="event-list" aria-label="Загрузка мероприятий">
          {[1, 2, 3].map((item) => (
            <div className="skeleton event-skeleton" key={item} />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="empty-state cat-empty-state">
          <Image src="/cats/cat-5.svg" alt="" width={180} height={180} unoptimized />
          <h2>Ничего не найдено</h2>
          <p>Проверьте название или сбросьте фильтры.</p>
        </div>
      ) : (
        <div className="event-list">
          {events.map((event) => (
            <button
              key={event.id}
              className="card-button"
              type="button"
              onClick={() => onSelect(event)}
            >
              <Card className="event-card">
                <div className="event-card-top">
                  <span className={`status-pill ${event.acceptsUploads ? 'active' : ''}`}>
                    {statusLabel(event)}
                  </span>
                  <span className="event-code">{event.shortCode}</span>
                </div>
                <h2>{event.title}</h2>
                <p className="event-meta">
                  {dateLabel(event.startsAt, event.timezone)}
                  {event.city ? ` · ${event.city}` : ''}
                </p>
                <p className="event-description">{event.description ?? event.organizer}</p>
                <div className="event-footer">
                  <span>{event.organizer}</span>
                  <ArrowIcon />
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
