'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import {
  addHoursToNovosibirskInput,
  formatNovosibirskDateTime,
  fromNovosibirskInput,
  novosibirskInputAfter,
} from '../lib/dates';
import { resolveIdempotencyAttempt, type IdempotencyAttempt } from '../lib/idempotent-action';
import { bookingStatusLabels, type CoworkingBooking } from '../lib/coworking';

function StudioScene() {
  return (
    <svg className="studio-scene" viewBox="0 0 260 150" fill="none" aria-hidden="true">
      <path d="M34 108 138 145 245 89 140 54Z" fill="#e0d5f4" />
      <path d="M45 102V20L141 5v84Z" fill="#f5efdf" />
      <path d="m141 5 92 43v56l-92-15Z" fill="#d9cee9" />
      <path d="M61 40 122 30v39L61 79Z" fill="#b0be98" />
      <path d="m91 36 1 37M62 57l59-10" stroke="#f5efdf" strokeWidth="4" />
      <path d="m71 101 74-35 64 24-73 39Z" fill="#17191a" />
      <path d="M83 106v23m111-32v22m-59 9v18" stroke="#17191a" strokeWidth="6" />
      <path d="m118 85 21-10 21 8-23 11Z" fill="#c8f06d" />
      <path d="m119 85-2-21 21-10 2 22Z" fill="#9dafca" />
      <path d="m169 46 13 5v25l-13-5Z" fill="#eef2b5" />
      <path d="m37 87-11-3-2-17 17 4Z" fill="#f29bb7" />
      <path
        d="M32 70V48m0 13c-12-1-14-9-11-14 9 0 13 6 11 14Zm0-9c0-13 7-18 12-15 1 9-5 15-12 15Z"
        stroke="#4f7153"
        strokeWidth="3"
        fill="#4f7153"
      />
    </svg>
  );
}

export function CoworkingRail() {
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState('Работа над проектом');
  const [startsAt, setStartsAt] = useState(() => novosibirskInputAfter(24));
  const [duration, setDuration] = useState('2');
  const [attendees, setAttendees] = useState(1);
  const [bookings, setBookings] = useState<CoworkingBooking[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const attempt = useRef<IdempotencyAttempt | null>(null);
  const submitting = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBookings((await api<{ items: CoworkingBooking[] }>('/coworking/bookings/me')).items);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось загрузить заявки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    return () => {
      document.body.style.overflow = previous;
      window.clearInterval(timer);
    };
  }, [load, open]);

  function show(kind: 'work' | 'team') {
    setPurpose(kind === 'team' ? 'Встреча команды' : 'Работа над проектом');
    setAttendees(kind === 'team' ? 4 : 1);
    setNotice('');
    setSuccess(false);
    setOpen(true);
  }

  function close() {
    if (submitting.current) return;
    dialog.current?.close();
    setOpen(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setNotice('');
    try {
      const body = JSON.stringify({
        startsAt: fromNovosibirskInput(startsAt),
        endsAt: fromNovosibirskInput(addHoursToNovosibirskInput(startsAt, Number(duration))),
        attendees,
        purpose,
      });
      attempt.current = resolveIdempotencyAttempt(attempt.current, body);
      const booking = await api<CoworkingBooking>('/coworking/bookings', {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.current.key },
        body,
      });
      attempt.current = null;
      setBookings((items) => [booking, ...items.filter((item) => item.id !== booking.id)]);
      setSuccess(true);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Не удалось отправить заявку. Попробуйте ещё раз.',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setNotice('');
    try {
      const updated = await api<CoworkingBooking>('/coworking/bookings/' + id + '/cancel', {
        method: 'PATCH',
      });
      setBookings((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось отменить заявку');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="coworking-section" aria-labelledby="coworking-title">
      <div className="wallet-section-heading">
        <div>
          <p className="wallet-kicker">Место для ваших идей</p>
          <h2 id="coworking-title">Встретимся в студии</h2>
        </div>
        <button
          type="button"
          aria-label="Следующая карточка коворкинга"
          onClick={() => rail.current?.scrollBy({ left: 300, behavior: 'smooth' })}
        >
          ↗
        </button>
      </div>
      <div className="coworking-rail" ref={rail} aria-label="Коворкинг стартап-студии" tabIndex={0}>
        <button type="button" className="coworking-card" onClick={() => show('work')}>
          <span className="coworking-card__eyebrow">
            <i />
            СТАРТАП-СТУДИЯ НГУ
          </span>
          <strong>
            Твоя идея.
            <br />
            Наше пространство.
          </strong>
          <p>
            Приходи работать над проектом
            <br />в коворкинг студии.
          </p>
          <StudioScene />
          <span className="coworking-card__cta">
            Оставить заявку <b>↗</b>
          </span>
        </button>
        <button
          type="button"
          className="coworking-card coworking-card--team"
          onClick={() => show('team')}
        >
          <span className="coworking-card__eyebrow">
            <i />
            ВМЕСТЕ ПОЛУЧАЕТСЯ БОЛЬШЕ
          </span>
          <strong>
            Собери команду.
            <br />
            Запусти идею.
          </strong>
          <p>
            Укажи время и сколько вас будет.
            <br />
            Мы рассмотрим заявку.
          </p>
          <div className="coworking-team-art" aria-hidden="true">
            <span>✳</span>
            <span>↗</span>
            <span>✦</span>
          </div>
          <span className="coworking-card__cta">
            Запланировать встречу <b>↗</b>
          </span>
        </button>
      </div>
      {open ? (
        <dialog
          ref={dialog}
          className="studio-dialog"
          aria-labelledby="booking-title"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClick={(event) => {
            if (event.target === dialog.current) close();
          }}
        >
          <div className="studio-dialog__inner">
            <button
              type="button"
              className="studio-close"
              aria-label="Закрыть бронирование"
              onClick={close}
              disabled={busy}
            >
              ×
            </button>
            <p className="wallet-kicker">Коворкинг · Стартап-студия НГУ</p>
            <h2 id="booking-title">{success ? 'Заявка отправлена' : 'Место для твоего проекта'}</h2>
            {success ? (
              <div className="studio-booking-success" role="status">
                <span>✓</span>
                <p>
                  Администратор рассмотрит заявку. Подтверждение и комментарий появятся здесь, в
                  «Моих заявках».
                </p>
                <button
                  type="button"
                  className="wallet-secondary-button"
                  onClick={() => setSuccess(false)}
                >
                  Ещё одна заявка
                </button>
              </div>
            ) : (
              <form onSubmit={(event) => void submit(event)} className="studio-booking-form">
                <p>
                  Выбери удобное время. Бронирование действует после подтверждения администратором.
                </p>
                <fieldset disabled={busy}>
                  <label>
                    Дата и время
                    <input
                      type="datetime-local"
                      value={startsAt}
                      min={novosibirskInputAfter(0)}
                      max={novosibirskInputAfter(90 * 24)}
                      onChange={(event) => setStartsAt(event.target.value)}
                      required
                    />
                  </label>
                  <small>Время Новосибирска, UTC+7</small>
                  <div className="studio-form-row">
                    <label>
                      На сколько
                      <select
                        value={duration}
                        onChange={(event) => setDuration(event.target.value)}
                      >
                        <option value="0.5">30 минут</option>
                        <option value="1">1 час</option>
                        <option value="2">2 часа</option>
                        <option value="3">3 часа</option>
                        <option value="4">4 часа</option>
                        <option value="8">8 часов</option>
                      </select>
                    </label>
                    <label>
                      Участников
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={attendees}
                        onChange={(event) => setAttendees(Number(event.target.value))}
                        required
                      />
                    </label>
                  </div>
                  <label>
                    Чем планируете заниматься?
                    <textarea
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                      minLength={3}
                      maxLength={1000}
                      rows={3}
                      required
                    />
                  </label>
                  <button className="wallet-primary-button" type="submit">
                    {busy ? 'Отправляем…' : 'Отправить заявку ↗'}
                  </button>
                </fieldset>
              </form>
            )}
            {notice ? (
              <p className="notice error" role="alert">
                {notice}
              </p>
            ) : null}
            <section className="studio-my-bookings" aria-labelledby="my-bookings-title">
              <h3 id="my-bookings-title">Мои заявки</h3>
              {loading && !bookings.length ? (
                <p>Загружаем заявки…</p>
              ) : !bookings.length ? (
                <p>Здесь появятся ваши бронирования и ответы администратора.</p>
              ) : (
                bookings.map((booking) => (
                  <article key={booking.id}>
                    <span className={'booking-status booking-status--' + booking.status}>
                      {bookingStatusLabels[booking.status]}
                    </span>
                    <strong>{formatNovosibirskDateTime(booking.startsAt)}</strong>
                    <small>
                      До {formatNovosibirskDateTime(booking.endsAt)} · {booking.attendees} чел.
                    </small>
                    <p>{booking.purpose}</p>
                    {booking.adminNote ? (
                      <p className="booking-admin-note">Ответ студии: {booking.adminNote}</p>
                    ) : null}
                    {['pending', 'confirmed'].includes(booking.status) ? (
                      <button type="button" onClick={() => void cancel(booking.id)} disabled={busy}>
                        Отменить заявку
                      </button>
                    ) : null}
                  </article>
                ))
              )}
            </section>
          </div>
        </dialog>
      ) : null}
    </section>
  );
}
