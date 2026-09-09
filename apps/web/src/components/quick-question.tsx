'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { api, ApiClientError } from '../lib/api';
import { formatNovosibirskDateTime } from '../lib/dates';

interface QuickAnswer {
  answer: string;
  createdAt: string;
}

export function QuickQuestion({
  eventId,
  acceptsAnswers,
  onSubmitted,
}: {
  eventId: string;
  acceptsAnswers: boolean;
  onSubmitted?: () => void;
}) {
  const [answer, setAnswer] = useState<QuickAnswer | null>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const savingRef = useRef(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const result = await api<{ answer: QuickAnswer | null }>(
          `/events/${eventId}/quick-answer`,
          { ...(signal ? { signal } : {}) },
        );
        if (signal?.aborted) return;
        setAnswer(result.answer);
        setLoadFailed(false);
        setError(null);
      } catch (caught) {
        if (signal?.aborted) return;
        setLoadFailed(true);
        setError(caught instanceof Error ? caught.message : 'Не удалось загрузить ответ');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [eventId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (savingRef.current || answer || !text.trim()) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ answer: QuickAnswer }>(`/events/${eventId}/quick-answer`, {
        method: 'POST',
        body: JSON.stringify({ answer: text.trim() }),
      });
      setAnswer(result.answer);
      setText('');
      onSubmitted?.();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'QUICK_ANSWER_ALREADY_SUBMITTED') {
        await load();
      } else {
        setError(caught instanceof Error ? caught.message : 'Не удалось отправить ответ');
      }
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }

  return (
    <Card className="quick-question">
      <h3>Быстрый вопрос</h3>
      {loading ? (
        <Spinner label="Загружаем ответ" />
      ) : answer ? (
        <div role="status">
          <strong>Ответ отправлен</strong>
          <p className="quick-question__answer">{answer.answer}</p>
          <small>{formatNovosibirskDateTime(answer.createdAt)} · Изменение недоступно</small>
        </div>
      ) : loadFailed ? (
        <Button onClick={() => void load()}>Повторить загрузку</Button>
      ) : !acceptsAnswers ? (
        <p>Приём ответов сейчас закрыт.</p>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          <p id={`quick-hint-${eventId}`}>
            На каждое мероприятие можно ответить один раз. Проверьте текст перед отправкой —
            изменить его не получится.
          </p>
          <label>
            <span>Ваш ответ</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={5}
              maxLength={10_000}
              required
              disabled={saving}
              aria-describedby={`quick-hint-${eventId}`}
              placeholder="Введите ответ"
            />
          </label>
          <small>{text.length} / 10 000</small>
          <Button type="submit" className="primary-button" disabled={saving || !text.trim()}>
            {saving ? 'Отправляем…' : 'Отправить ответ'}
          </Button>
        </form>
      )}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
