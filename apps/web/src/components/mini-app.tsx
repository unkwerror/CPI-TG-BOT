'use client';
import Image from 'next/image';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { api } from '../lib/api';
import { parseInternalAppLink } from '../lib/app-link';
import { NOVOSIBIRSK_LABEL, formatNovosibirskDateTime } from '../lib/dates';
import { getMessengerAdapter } from '../lib/messenger-adapter';
import type { EventItem } from '../lib/types';
import { ArrowIcon, CalendarIcon, HistoryIcon, HomeIcon, QrIcon, UploadIcon } from './icons';
import { CatAssistant } from './cat-assistant';
import { EventSubmissions } from './event-submissions';
import { QuickQuestion } from './quick-question';
import { EventRequestPanel } from './event-request-panel';
import { EventsView } from './events-view';
import { EntityActionDock, EntityBackButton } from './entity-action-dock';
import { MineView } from './mine-view';
import { ProfileView } from './profile-view';
import { ProjectsView } from './projects-view';
import { useSession } from './session-provider';
import { SubmissionSheet } from './submission-sheet';
import {
  HistoryView,
  PendingWalletIntentBanner,
  StoreNavigationButton,
  StoreView,
  WalletHome,
  WalletQrSheet,
  type WalletDestination,
  type WalletQrMode,
} from './wallet-views';
import { WalletProgramProvider } from './wallet-program-context';
import { WalletMotionProvider } from './wallet-motion-provider';
import { RichHtml } from './rich-html';
type Tab = WalletDestination;
export function MiniApp() {
  const { user, loading, error, online } = useSession();
  const [tab, setTab] = useState<Tab>('home');
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  const [compose, setCompose] = useState(false);
  const [directEvent, setDirectEvent] = useState<EventItem | null>(null);
  const [submissionsRevision, setSubmissionsRevision] = useState(0);
  const [qrMode, setQrMode] = useState<WalletQrMode | null>(null);
  const [storeProductKey, setStoreProductKey] = useState<string | null>(null);
  const [focusLeaderId, setFocusLeaderId] = useState(false);
  useEffect(() => {
    const startParameter = getMessengerAdapter()?.getStartParameter();
    const requestedTab =
      new URLSearchParams(window.location.search).get('tab') ??
      (startParameter?.startsWith('tab_') ? startParameter.slice(4) : null);
    if (
      requestedTab === 'home' ||
      requestedTab === 'events' ||
      requestedTab === 'projects' ||
      requestedTab === 'mine' ||
      requestedTab === 'profile' ||
      requestedTab === 'store' ||
      requestedTab === 'history'
    ) {
      setTab(requestedTab);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    const parameters = new URLSearchParams(window.location.search);
    const queryEvent = parameters.get('event');
    const startParameter = getMessengerAdapter(user.messengerProvider)?.getStartParameter();
    const startEvent = startParameter?.startsWith('event_')
      ? startParameter.slice(6)
      : startParameter && !/^(?:tab|post|product)_/u.test(startParameter)
        ? startParameter
        : undefined;
    const key = queryEvent || startEvent;
    if (!key) return;
    void api<EventItem>(`/events/${encodeURIComponent(key)}`)
      .then((event) => {
        setDirectEvent(event);
        setSelectedEvent(event);
      })
      .catch(() => undefined);
  }, [user]);
  const openEvent = useCallback((event: EventItem) => {
    setSelectedEvent(event);
    try {
      const stored = window.localStorage.getItem('recent-events');
      const parsed: unknown = stored ? JSON.parse(stored) : [];
      const recent = Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : [];
      window.localStorage.setItem(
        'recent-events',
        JSON.stringify([event.id, ...recent.filter((id) => id !== event.id)].slice(0, 5)),
      );
    } catch {
      // Restricted WebViews may deny storage; opening an event must still work.
    }
  }, []);
  const openLeaderIdRegistration = useCallback(() => {
    setCompose(false);
    setSelectedEvent(null);
    setDirectEvent(null);
    setTab('profile');
    setFocusLeaderId(true);
  }, []);
  useEffect(() => {
    if (!focusLeaderId || tab !== 'profile' || selectedEvent) return;
    let frame = 0;
    let attempts = 0;
    const focusTarget = () => {
      const target = document.getElementById('leader-id-catalyst');
      if (!target && attempts < 60) {
        attempts += 1;
        frame = window.requestAnimationFrame(focusTarget);
        return;
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target?.focus({ preventScroll: true });
      setFocusLeaderId(false);
    };
    frame = window.requestAnimationFrame(focusTarget);
    return () => window.cancelAnimationFrame(frame);
  }, [focusLeaderId, selectedEvent, tab]);
  const openInternalLink = useCallback(
    (href: string): boolean => {
      const target = parseInternalAppLink(href, window.location.origin);
      if (!target) return false;
      if (target.destination === 'event') {
        setTab('events');
        void api<EventItem>(`/events/${encodeURIComponent(target.key)}`)
          .then(openEvent)
          .catch(() => setSelectedEvent(null));
        return true;
      }
      if (target.destination === 'product') {
        setStoreProductKey(target.key);
        setSelectedEvent(null);
        setTab('store');
        return true;
      }
      setSelectedEvent(null);
      setTab(target.destination);
      return true;
    },
    [openEvent],
  );
  useEffect(() => {
    const handleAppLink = (event: Event) => {
      const customEvent = event as CustomEvent<{
        href?: unknown;
      }>;
      if (typeof customEvent.detail?.href !== 'string') return;
      if (openInternalLink(customEvent.detail.href)) customEvent.preventDefault();
    };
    window.addEventListener('cpi:app-link', handleAppLink);
    return () => window.removeEventListener('cpi:app-link', handleAppLink);
  }, [openInternalLink]);
  if (loading) {
    return (
      <main
        className="center-state cat-center-state wallet-auth-state"
        aria-busy="true"
        aria-label="Авторизация"
      >
        <CatAssistant
          mood="talk"
          title="Кот подключается"
          message="Секунду — проверяю безопасный вход через мессенджер и готовлю мероприятия."
        />
        <Spinner label="Авторизация" />
      </main>
    );
  }
  if (error || !user) {
    return (
      <main className="center-state error-state cat-center-state wallet-auth-state" role="alert">
        <CatAssistant
          mood="sleep"
          title="Связь потерялась"
          message={error ?? 'Откройте приложение из Telegram или MAX — так я смогу вас узнать.'}
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
    <WalletMotionProvider>
      <WalletProgramProvider>
        <main className={`app-shell wallet-app${tab === 'profile' ? ' wallet-app--profile' : ''}`}>
          {!online ? (
            <div className="offline-banner">Нет сети. Загрузка продолжится после подключения.</div>
          ) : null}
          <PendingWalletIntentBanner />
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              className="wallet-view-motion"
              key={selectedEvent ? `event:${selectedEvent.id}` : tab}
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              {selectedEvent ? (
                <EventDetail
                  event={selectedEvent}
                  actionDockHidden={compose}
                  onBack={() => {
                    setSelectedEvent(null);
                    setDirectEvent(null);
                  }}
                  onAdd={() => setCompose(true)}
                  onParticipated={() =>
                    setSelectedEvent((current) =>
                      current ? { ...current, isParticipant: true } : current,
                    )
                  }
                  onOpenLeaderId={openLeaderIdRegistration}
                  submissionsRevision={submissionsRevision}
                  onOpenInternalLink={openInternalLink}
                />
              ) : tab === 'home' ? (
                <WalletHome
                  user={user}
                  onNavigate={setTab}
                  onOpenQr={setQrMode}
                  onOpenEvent={openEvent}
                  onOpenInternalLink={openInternalLink}
                />
              ) : tab === 'events' ? (
                <EventsView onSelect={openEvent} initialEvent={directEvent} />
              ) : tab === 'mine' ? (
                <MineView />
              ) : tab === 'projects' ? (
                <ProjectsView />
              ) : tab === 'store' ? (
                <StoreView
                  initialProductKey={storeProductKey}
                  onInitialProductHandled={() => setStoreProductKey(null)}
                  onOpenInternalLink={openInternalLink}
                />
              ) : tab === 'history' ? (
                <HistoryView />
              ) : (
                <ProfileView onBack={() => setTab('home')} />
              )}
            </m.div>
          </AnimatePresence>

          {user.roles.some((role) => role === 'admin' || role === 'superadmin') &&
          tab === 'profile' ? (
            <a href="/admin" className="admin-link">
              Открыть административную панель <ArrowIcon />
            </a>
          ) : null}

          {!selectedEvent ? (
            <nav className="bottom-nav" aria-label="Основная навигация">
              <m.button
                whileTap={{ scale: 0.92 }}
                type="button"
                className={tab === 'home' ? 'active' : ''}
                onClick={() => setTab('home')}
              >
                <HomeIcon />
                <span>Главная</span>
              </m.button>
              <m.button
                whileTap={{ scale: 0.92 }}
                type="button"
                className={tab === 'events' ? 'active' : ''}
                onClick={() => setTab('events')}
              >
                <CalendarIcon />
                <span>События</span>
              </m.button>
              <m.button
                whileTap={{ scale: 0.9, rotate: -4 }}
                type="button"
                className="bottom-nav-qr"
                aria-label="Открыть QR"
                onClick={() => setQrMode('menu')}
              >
                <span>
                  <QrIcon />
                </span>
                <small>QR</small>
              </m.button>
              <StoreNavigationButton active={tab === 'store'} onClick={() => setTab('store')} />
              <m.button
                whileTap={{ scale: 0.92 }}
                type="button"
                className={tab === 'history' ? 'active' : ''}
                onClick={() => setTab('history')}
              >
                <HistoryIcon />
                <span>История</span>
              </m.button>
            </nav>
          ) : null}

          <AnimatePresence>
            {qrMode ? <WalletQrSheet initialMode={qrMode} onClose={() => setQrMode(null)} /> : null}
          </AnimatePresence>

          <AnimatePresence>
            {selectedEvent && compose ? (
              <SubmissionSheet
                event={selectedEvent}
                onClose={() => setCompose(false)}
                onSuccess={() => {
                  setSubmissionsRevision((revision) => revision + 1);
                  setSelectedEvent((current) =>
                    current ? { ...current, isParticipant: true } : current,
                  );
                }}
              />
            ) : null}
          </AnimatePresence>
        </main>
      </WalletProgramProvider>
    </WalletMotionProvider>
  );
}
function EventDetail({
  event,
  actionDockHidden,
  onBack,
  onAdd,
  onParticipated,
  onOpenLeaderId,
  submissionsRevision,
  onOpenInternalLink,
}: {
  event: EventItem;
  actionDockHidden: boolean;
  onBack: () => void;
  onAdd: () => void;
  onParticipated: () => void;
  onOpenLeaderId: () => void;
  submissionsRevision: number;
  onOpenInternalLink: (href: string) => boolean;
}) {
  const [participating, setParticipating] = useState(false);
  const [materialsTab, setMaterialsTab] = useState<'artifacts' | 'question'>('artifacts');
  const [participationError, setParticipationError] = useState<string | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const previousRootOverscroll = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = 'none';
    return () => {
      root.style.overscrollBehaviorY = previousRootOverscroll;
    };
  }, []);
  async function participate() {
    if (participating || event.isParticipant) return;
    setParticipating(true);
    setParticipationError(null);
    try {
      await api<{
        joined: boolean;
        isParticipant: true;
      }>(`/events/${event.id}/participate`, {
        method: 'POST',
      });
      onParticipated();
      getMessengerAdapter()?.notify('success');
    } catch (caught) {
      setParticipationError(
        caught instanceof Error ? caught.message : 'Не удалось зарегистрировать участие',
      );
      getMessengerAdapter()?.notify('error');
    } finally {
      setParticipating(false);
    }
  }
  return (
    <section
      className={`screen event-detail wallet-event-detail${''}${event.leaderIdRegistrationActive && event.leaderIdEventId && event.leaderIdRegistrationOpen ? ' wallet-event-detail--leader-id-registration' : ''}`}
    >
      {!actionDockHidden ? (
        <>
          <EntityBackButton label="Мероприятия" onClick={onBack} />
          <EntityActionDock
            className="entity-action-dock--event"
            label="Мероприятие"
            detail={event.title}
          >
            <Button
              className="entity-action-dock__secondary"
              disabled={participating || event.isParticipant}
              onClick={() => void participate()}
              type="button"
            >
              {event.isParticipant
                ? 'Вы участвуете'
                : participating
                  ? 'Подтверждаем…'
                  : 'Участвовать'}
            </Button>
            <Button
              className="entity-action-dock__primary"
              type="button"
              onClick={onAdd}
              disabled={!event.acceptsUploads}
            >
              <UploadIcon />
              {event.acceptsUploads ? 'Отправить артефакт' : 'Приём закрыт'}
            </Button>
          </EntityActionDock>
        </>
      ) : null}
      {event.cardHtml ? (
        <div className="event-custom-design">
          <RichHtml html={event.cardHtml} onAction={onAdd} onLink={onOpenInternalLink} />
        </div>
      ) : event.coverUrl ? (
        <img src={event.coverUrl} alt="" className="event-cover" />
      ) : (
        <div className="event-cover placeholder">
          <span className="event-cover-cat">
            <Image src="/cats/cat-4-pink.svg" alt="" width={320} height={320} unoptimized />
          </span>
          <span>Материалы события</span>
        </div>
      )}
      <div className="event-detail-content">
        <div className="event-detail-heading">
          <div>
            <span className={`status-pill ${event.acceptsUploads ? 'active' : ''}`}>
              {event.acceptsUploads ? 'Принимает материалы' : 'Приём закрыт'}
            </span>
            <span className="event-code">{event.shortCode}</span>
          </div>
          <h1>{event.title}</h1>
          {event.descriptionFormat === 'html' && event.description ? (
            <RichHtml
              html={event.description}
              className="event-rich-description"
              onLink={onOpenInternalLink}
            />
          ) : (
            <p>{event.description}</p>
          )}
        </div>
        <Card className="event-participation-card">
          <div>
            <strong>{event.isParticipant ? 'Вы участвуете' : 'Хотите участвовать?'}</strong>
            <span>
              {event.isParticipant
                ? 'Вы добавлены в список участников Catalyst.'
                : 'Подтвердите внутреннее участие в Catalyst одной кнопкой. Если событие требует Leader-ID, официальная регистрация выполняется отдельным блоком ниже.'}
            </span>
          </div>
          <Button
            className="primary-button"
            disabled={participating || event.isParticipant}
            onClick={() => void participate()}
            type="button"
          >
            {event.isParticipant
              ? 'Участие подтверждено'
              : participating
                ? 'Подтверждаем…'
                : 'Участвовать'}
          </Button>
        </Card>
        {participationError ? <div className="notice error">{participationError}</div> : null}
        {event.leaderIdRegistrationActive && event.leaderIdEventId ? (
          <Card
            className={`event-registration-guide${event.leaderIdRegistrationOpen ? '' : ' event-registration-guide--closed'}`}
          >
            <span className="event-registration-guide__mark" aria-hidden="true">
              ID
            </span>
            <div className="event-registration-guide__copy">
              <span>Регистрация на мероприятие</span>
              <h2>Через Leader-ID</h2>
              <p>
                {event.leaderIdRegistrationOpen
                  ? 'В профиле подключите свой Leader-ID и нажмите «Подключиться к Catalyst». Мы отправим заявку на это и остальные активные мероприятия автоматически — открывать каждое отдельно не нужно.'
                  : 'Приём заявок через Leader-ID на это мероприятие сейчас закрыт. Когда регистрация откроется, действие появится здесь.'}
              </p>
              {event.leaderIdRegistrationOpen ? (
                <small>Если аккаунта ещё нет, там же есть ссылка и короткая инструкция.</small>
              ) : null}
            </div>
            {event.leaderIdRegistrationOpen ? (
              <Button
                className="event-registration-guide__button"
                type="button"
                onClick={onOpenLeaderId}
              >
                Перейти к регистрации
                <ArrowIcon />
              </Button>
            ) : null}
          </Card>
        ) : null}
        <div className="event-material-tabs" role="tablist" aria-label="Материалы мероприятия">
          <button
            type="button"
            role="tab"
            aria-selected={materialsTab === 'artifacts'}
            aria-controls="event-artifacts-panel"
            onClick={() => setMaterialsTab('artifacts')}
          >
            Артефакты
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={materialsTab === 'question'}
            aria-controls="event-question-panel"
            onClick={() => setMaterialsTab('question')}
          >
            Быстрый вопрос
          </button>
        </div>
        <div id="event-artifacts-panel" role="tabpanel" hidden={materialsTab !== 'artifacts'}>
          <EventSubmissions eventId={event.id} refreshRevision={submissionsRevision} />
        </div>
        {materialsTab === 'question' ? (
          <div id="event-question-panel" role="tabpanel">
            <QuickQuestion
              key={event.id}
              eventId={event.id}
              acceptsAnswers={event.acceptsUploads}
              onSubmitted={onParticipated}
            />
          </div>
        ) : null}
        {event.acceptsRequests ? <EventRequestPanel eventId={event.id} /> : null}
        <Card className="detail-grid">
          <div>
            <span>Начало</span>
            <strong>{formatNovosibirskDateTime(event.startsAt)}</strong>
          </div>
          <div>
            <span>Окончание</span>
            <strong>{formatNovosibirskDateTime(event.endsAt)}</strong>
          </div>
          <div>
            <span>Приём материалов с</span>
            <strong>{formatNovosibirskDateTime(event.acceptUploadsFrom)}</strong>
          </div>
          <div>
            <span>Приём материалов до</span>
            <strong>{formatNovosibirskDateTime(event.acceptUploadsUntil)}</strong>
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
          <div>
            <span>Часовой пояс</span>
            <strong>{NOVOSIBIRSK_LABEL}</strong>
          </div>
        </Card>
        <CatAssistant
          mood={event.acceptsUploads ? 'upload' : 'sleep'}
          compact
          message={
            event.acceptsUploads
              ? 'Можно отправить файл, ссылку или заметку. Черновик сохранится, если отвлечётесь.'
              : 'Приём уже завершён. Все ваши прежние отправки показаны выше.'
          }
        />
        {event.tags.length ? (
          <div className="tag-row">
            {event.tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        ) : null}
        <div className="event-action-inline">
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
      </div>
    </section>
  );
}
