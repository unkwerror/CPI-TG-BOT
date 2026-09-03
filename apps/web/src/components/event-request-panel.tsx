'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { api } from '../lib/api';
import { formatNovosibirskDateTime } from '../lib/dates';
import { getMessengerAdapter } from '../lib/messenger-adapter';

interface EventRequestItem {
  id: string;
  text: string;
  status: 'new' | 'in_progress' | 'closed';
  createdAt: string;
  updatedAt: string;
}

const statusLabels: Record<EventRequestItem['status'], string> = {
  new: 'Принято',
  in_progress: 'В работе',
  closed: 'Закрыто',
};

export function EventRequestPanel({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<EventRequestItem[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<{ items: EventRequestItem[] }>(`/events/${encodeURIComponent(eventId)}/requests/me`)
      .then((result) => {
        if (!cancelled) setItems(result.items);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : 'Не удалось загрузить обращения');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const openRequest = items.find((item) => item.status !== 'closed');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (value.length < 5) {
      setMessage('Опишите вопрос или сложность чуть подробнее');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const created = await api<EventRequestItem>(
        `/events/${encodeURIComponent(eventId)}/requests`,
        { method: 'POST', body: JSON.stringify({ text: value }) },
      );
      setItems((current) => [created, ...current]);
      setText('');
      setMessage('Обращение передано команде Стартап-студии НГУ');
      getMessengerAdapter()?.notify('success');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось отправить обращение');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="event-request-panel">
      <div className="event-request-heading">
        <div>
          <span>Помощь команды</span>
          <h2>Задать вопрос по мероприятию</h2>
        </div>
        {openRequest ? <b>{statusLabels[openRequest.status]}</b> : null}
      </div>
      {loading ? (
        <Spinner label="Загружаем обращения" />
      ) : openRequest ? (
        <div className="event-request-current">
          <p>{openRequest.text}</p>
          <small>Отправлено {formatNovosibirskDateTime(openRequest.createdAt)}</small>
        </div>
      ) : (
        <form onSubmit={submit}>
          <label>
            <span>Что не получается или что нужно уточнить?</span>
            <textarea
              value={text}
              onChange={(inputEvent) => setText(inputEvent.target.value)}
              rows={4}
              minLength={5}
              maxLength={10_000}
              placeholder="Например: нужна помощь с подачей заявки…"
              required
            />
          </label>
          <Button type="submit" className="secondary-button" disabled={saving}>
            {saving ? 'Отправляем…' : 'Оставить обращение'}
          </Button>
        </form>
      )}
      {message ? (
        <div className="notice info" role="status" aria-live="polite">
          {message}
        </div>
      ) : null}
    </Card>
  );
}
