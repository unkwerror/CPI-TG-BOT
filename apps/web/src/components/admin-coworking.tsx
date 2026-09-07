'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatNovosibirskDateTime } from '../lib/dates';
import { bookingStatusLabels, type CoworkingBooking, type CoworkingStatus } from '../lib/coworking';

export function AdminCoworking() {
  const [items, setItems] = useState<CoworkingBooking[]>([]);
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ items: CoworkingBooking[]; hasMore: boolean }>(
        '/admin/coworking/bookings?limit=30&offset=' + offset + (status ? '&status=' + status : ''),
      );
      setItems(result.items);
      setHasMore(result.hasMore);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить заявки');
    } finally {
      setLoading(false);
    }
  }, [offset, status]);
  useEffect(() => {
    void load();
  }, [load]);

  async function review(item: CoworkingBooking, nextStatus: CoworkingStatus) {
    if (busy) return;
    setBusy(item.id);
    setError('');
    try {
      await api('/admin/coworking/bookings/' + item.id, {
        method: 'PATCH',
        body: JSON.stringify({
          status: nextStatus,
          adminNote: notes[item.id] ?? item.adminNote ?? '',
        }),
      });
      setNotes((current) => {
        const copy = { ...current };
        delete copy[item.id];
        return copy;
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось изменить заявку');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="admin-coworking">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Пространство студии</p>
          <h1>Коворкинг</h1>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void load()}
          disabled={loading || !!busy}
        >
          Обновить
        </button>
      </header>
      <p>
        Заявки на посещение. Все даты и время указаны по Новосибирску (UTC+7). Перед подтверждением
        согласуйте доступность пространства.
      </p>
      <div className="wallet-chip-row" aria-label="Статус бронирования">
        {[['', 'Все'], ...Object.entries(bookingStatusLabels)].map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={status === value ? 'active' : ''}
            onClick={() => {
              setStatus(value!);
              setOffset(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status">Загружаем заявки…</p>
      ) : items.length ? (
        <div className="admin-booking-grid">
          {items.map((item) => (
            <article className="admin-booking" key={item.id}>
              <span className={'booking-status booking-status--' + item.status}>
                {bookingStatusLabels[item.status]}
              </span>
              <h2>{item.user?.fullName || 'Участник'}</h2>
              <p>
                {[item.user?.username ? '@' + item.user.username : '', item.user?.phone]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <strong>{formatNovosibirskDateTime(item.startsAt)}</strong>
              <p>
                До {formatNovosibirskDateTime(item.endsAt)} · {item.attendees} чел.
              </p>
              <p className="admin-booking__purpose">{item.purpose}</p>
              <small>Заявка от {formatNovosibirskDateTime(item.createdAt)}</small>
              <label>
                Ответ участнику
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={notes[item.id] ?? item.adminNote ?? ''}
                  onChange={(event) =>
                    setNotes((current) => ({
                      ...current,
                      [item.id]: event.target.value,
                    }))
                  }
                  disabled={!!busy}
                />
              </label>
              <div className="admin-booking__actions">
                {item.status === 'pending' ? (
                  <>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!!busy}
                      onClick={() => void review(item, 'confirmed')}
                    >
                      Подтвердить
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!!busy}
                      onClick={() => void review(item, 'rejected')}
                    >
                      Отклонить
                    </button>
                  </>
                ) : null}
                {item.status === 'confirmed' ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!!busy}
                    onClick={() => void review(item, 'cancelled')}
                  >
                    Отменить бронь
                  </button>
                ) : null}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!busy || notes[item.id] === undefined}
                  onClick={() => void review(item, item.status)}
                >
                  Сохранить ответ
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="wallet-empty-inline wallet-empty-inline--static">
          Заявок с таким статусом пока нет
        </div>
      )}
      <div className="admin-booking__actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!offset || loading}
          onClick={() => setOffset((value) => Math.max(0, value - 30))}
        >
          Назад
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!hasMore || loading}
          onClick={() => setOffset((value) => value + 30)}
        >
          Далее
        </button>
      </div>
    </div>
  );
}
