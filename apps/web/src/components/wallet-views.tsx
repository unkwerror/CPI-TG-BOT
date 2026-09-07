'use client';
import Image from 'next/image';
import QRCode from 'qrcode';
import {
  AnimatePresence,
  m,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useSpring,
} from 'motion/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { api } from '../lib/api';
import { formatNovosibirskDate, formatNovosibirskDateTime } from '../lib/dates';
import { resolveIdempotencyAttempt, type IdempotencyAttempt } from '../lib/idempotent-action';
import { getMessengerAdapter, normalizeExternalUrl } from '../lib/messenger-adapter';
import { richContentToText } from '../lib/rich-content';
import type { CurrentUser, EventItem } from '../lib/types';
import type {
  PaginatedWalletResponse,
  WalletFeedItem,
  WalletHistoryResponse,
  WalletOrder,
  WalletProduct,
  WalletQrSession,
  WalletResolvedQr,
  WalletTransaction,
  WalletIntent,
} from '../lib/wallet-types';
import {
  ArrowIcon,
  BellIcon,
  FilesIcon,
  GiftIcon,
  ProjectIcon,
  QrIcon,
  ScanIcon,
  SettingsIcon,
  StoreIcon,
  TransferIcon,
} from './icons';
import { StartupStudioLogo } from './startup-studio-logo';
import { LeaderIdCard } from './leader-id-card';
import { CoworkingRail } from './coworking';
import { isCatalystTee, CatalystTeeGallery, CatalystTeeOptions } from './catalyst-merch';
import { formatWalletAmount, useWalletProgram } from './wallet-program-context';
import { RichHtml } from './rich-html';
import { EntityActionDock, EntityBackButton } from './entity-action-dock';
export type WalletDestination =
  'home' | 'events' | 'projects' | 'store' | 'history' | 'mine' | 'profile';
export type WalletQrMode = 'menu' | 'show' | 'scan';
export function StoreNavigationButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const { summary, loading } = useWalletProgram();
  if (loading || !summary?.program.storeEnabled) return null;
  return (
    <m.button
      whileTap={{ scale: 0.92 }}
      type="button"
      className={active ? 'active' : ''}
      onClick={onClick}
    >
      <StoreIcon />
      <span>Магазин</span>
    </m.button>
  );
}
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
function safeWalletNumber(value: string): number | null {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const integer = BigInt(value);
  if (integer > MAX_SAFE_BIGINT || integer < -MAX_SAFE_BIGINT) return null;
  return Number(integer);
}
function AnimatedBalance({ value }: { value: string }) {
  const reducedMotion = useReducedMotion();
  const initial = safeWalletNumber(value);
  const source = useMotionValue(initial ?? 0);
  const spring = useSpring(source, { stiffness: 175, damping: 26, mass: 0.75 });
  const [display, setDisplay] = useState(value);
  const animating = useRef(initial !== null && !reducedMotion);
  useMotionValueEvent(spring, 'change', (latest) => {
    if (animating.current) setDisplay(Math.round(latest).toString());
  });
  useEffect(() => {
    const target = safeWalletNumber(value);
    animating.current = target !== null && !reducedMotion;
    if (!animating.current || target === null) {
      setDisplay(value);
      return;
    }
    source.set(target);
  }, [reducedMotion, source, value]);
  return (
    <span className="wallet-animated-balance" aria-label={formatWalletAmount(value)}>
      <span aria-hidden="true">{formatWalletAmount(display)}</span>
    </span>
  );
}
function initials(name: string | null): string {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'Я'
  );
}
function transactionLabel(kind: WalletTransaction['kind']): string {
  const labels: Record<WalletTransaction['kind'], string> = {
    welcome_grant: 'Стартовое начисление',
    p2p_transfer: 'Перевод участнику',
    staff_credit: 'Начисление сотрудником',
    staff_debit: 'Списание сотрудником',
    artifact_reward: 'Награда за артефакт',
    leader_id_subscription_reward: 'Награда за подключение Leader-ID',
    store_purchase: 'Покупка',
    admin_adjustment: 'Корректировка',
    season_opening: 'Открытие сезона',
    reversal: 'Обратная операция',
  };
  return labels[kind];
}
function isDebit(delta: string): boolean {
  return delta.trim().startsWith('-');
}
function absoluteDecimal(delta: string): string {
  return delta.trim().replace(/^[+-]/, '') || '0';
}
function closeMessengerScanner(): void {
  getMessengerAdapter()?.closeQrScanner();
}
function signedAmount(item: WalletTransaction, withUnit: (value: string) => string): string {
  const outgoing = isDebit(item.delta);
  const sign = outgoing ? '−' : '+';
  return `${sign}${withUnit(absoluteDecimal(item.delta))}`;
}
type RewardAwareEvent = EventItem & {
  rewardPolicy?: {
    active: boolean;
    amount: string;
    trigger: 'artifact_ready';
  } | null;
};
export function WalletHome({
  user,
  onNavigate,
  onOpenQr,
  onOpenEvent,
  onOpenInternalLink,
}: {
  user: CurrentUser;
  onNavigate: (destination: WalletDestination) => void;
  onOpenQr: (mode: WalletQrMode) => void;
  onOpenEvent: (event: EventItem) => void;
  onOpenInternalLink: (href: string) => boolean;
}) {
  const { summary, loading: walletLoading, error: walletError, withUnit } = useWalletProgram();
  const messenger = useMemo(
    () => getMessengerAdapter(user.messengerProvider),
    [user.messengerProvider],
  );
  const [events, setEvents] = useState<RewardAwareEvent[]>([]);
  const [feed, setFeed] = useState<WalletFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPost, setSelectedPost] = useState<WalletFeedItem | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [eventsResult, feedResult] = await Promise.allSettled([
        api<{
          items: RewardAwareEvent[];
        }>('/events?limit=6'),
        api<PaginatedWalletResponse<WalletFeedItem>>('/feed?limit=8'),
      ]);
      if (cancelled) return;
      if (eventsResult.status === 'fulfilled') setEvents(eventsResult.value.items);
      if (feedResult.status === 'fulfilled') setFeed(feedResult.value.items);
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);
  const eventFeed = useMemo<WalletFeedItem[]>(
    () =>
      events.slice(0, 3).map((event) => ({
        id: `event-${event.id}`,
        kind: 'event',
        title: event.title,
        summary: event.acceptsUploads
          ? 'Можно приложить артефакт. Награда действует только при опубликованном правиле события.'
          : `Начало ${formatNovosibirskDate(event.startsAt)}.`,
        publishedAt: event.startsAt,
        actionLabel: 'Открыть',
        eventId: event.id,
      })),
    [events],
  );
  const visibleFeed = feed.length ? feed : eventFeed;
  const earningEvents = events.filter(
    (event) => event.rewardPolicy?.active && event.acceptsUploads,
  );
  const openLeaderIdAuthorization = useCallback(
    (url: string) => {
      const normalized = normalizeExternalUrl(url);
      if (!normalized) return;
      if (messenger) messenger.openLink(normalized);
      else window.location.assign(normalized);
    },
    [messenger],
  );
  const openFeedItem = async (item: WalletFeedItem) => {
    if (item.eventId || item.kind === 'event') {
      const matchingEvent = events.find(
        (candidate) =>
          candidate.id === item.eventId ||
          item.actionUrl === `/events/${candidate.slug}` ||
          item.actionUrl === `/events/${candidate.id}`,
      );
      if (matchingEvent) return onOpenEvent(matchingEvent);
      const key = item.eventId ?? item.actionUrl?.replace(/^\/events\//, '');
      if (key) {
        try {
          return onOpenEvent(await api<EventItem>(`/events/${encodeURIComponent(key)}`));
        } catch {
          return onNavigate('events');
        }
      }
    }
    if (item.productId) {
      onOpenInternalLink(`/store/products/${encodeURIComponent(item.productId)}`);
      return;
    }
    if (item.actionUrl && onOpenInternalLink(item.actionUrl)) return;
    if (!item.actionUrl) return;
    const normalized = normalizeExternalUrl(item.actionUrl);
    if (!normalized) return;
    if (messenger) messenger.openLink(normalized);
    else window.open(normalized, '_blank', 'noopener,noreferrer');
  };
  const openFeedCard = (item: WalletFeedItem) => {
    if (item.source === 'post' || item.cardHtml) {
      setSelectedPost(item);
      return;
    }
    void openFeedItem(item);
  };
  return (
    <section className="wallet-screen wallet-home" aria-labelledby="wallet-home-title">
      <header className="wallet-topbar">
        <StartupStudioLogo compact priority />
        <div className="wallet-topbar-actions">
          <button
            type="button"
            aria-label="Перейти к новостям"
            className="wallet-icon-button"
            onClick={() =>
              document.getElementById('feed-title')?.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
              })
            }
          >
            <BellIcon />
            <i aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Открыть профиль"
            className="wallet-avatar"
            onClick={() => onNavigate('profile')}
          >
            {initials(user.fullName)}
          </button>
        </div>
      </header>

      <Card className="wallet-balance-card">
        <div className="wallet-balance-copy">
          <span id="wallet-home-title">{summary?.program.walletTitle ?? 'Мои баллы'}</span>
          <m.strong
            initial={{ opacity: 0, y: 7, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
          >
            {walletLoading ? (
              <i className="wallet-balance-skeleton" />
            ) : summary ? (
              <AnimatedBalance value={summary.account.balance} />
            ) : (
              '—'
            )}
          </m.strong>
          <small>
            {walletError
              ? 'Кошелёк пока недоступен'
              : (summary?.season?.title ?? 'Доступно сейчас')}
          </small>
        </div>
        <div className="wallet-balance-cat" data-motion-slot="wallet-hero" aria-hidden="true">
          <span className="wallet-balance-orbit" />
          <Image src="/cats/cat-3-lime.svg" alt="" width={250} height={250} unoptimized />
        </div>
      </Card>

      <div className="wallet-actions" aria-label="Быстрые действия">
        <m.button whileTap={{ scale: 0.94 }} type="button" onClick={() => onOpenQr('show')}>
          <span>
            <QrIcon />
          </span>
          Получить
        </m.button>
        {summary?.program.p2pEnabled !== false ? (
          <m.button whileTap={{ scale: 0.94 }} type="button" onClick={() => onOpenQr('scan')}>
            <span>
              <TransferIcon />
            </span>
            Перевести
          </m.button>
        ) : null}
        <m.button whileTap={{ scale: 0.94 }} type="button" onClick={() => onNavigate('mine')}>
          <span>
            <FilesIcon />
          </span>
          Артефакты
        </m.button>
        <m.button whileTap={{ scale: 0.94 }} type="button" onClick={() => onNavigate('projects')}>
          <span>
            <ProjectIcon />
          </span>
          Проекты
        </m.button>
      </div>

      <div id="leader-id-catalyst" className="wallet-leader-id-anchor" tabIndex={-1}>
        <LeaderIdCard hideWhenLinked openAuthorization={openLeaderIdAuthorization} />
      </div>

      <CoworkingRail />
      <section className="wallet-section" aria-labelledby="earn-title">
        <div className="wallet-section-heading">
          <div>
            <p className="wallet-kicker">Возможности</p>
            <h2 id="earn-title">Заработать баллы</h2>
          </div>
          <button type="button" onClick={() => onNavigate('events')}>
            Все <ArrowIcon />
          </button>
        </div>
        {loading ? (
          <div className="wallet-event-rail" aria-label="Загрузка мероприятий">
            {[1, 2].map((item) => (
              <div className="wallet-skeleton" key={item} />
            ))}
          </div>
        ) : earningEvents.length ? (
          <m.div
            className="wallet-event-rail"
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.065 } } }}
          >
            {earningEvents.slice(0, 4).map((event, index) => (
              <m.button
                type="button"
                className={`wallet-earn-card wallet-earn-card--${(index % 3) + 1}`}
                key={event.id}
                onClick={() => onOpenEvent(event)}
                variants={{
                  hidden: { opacity: 0, y: 16, scale: 0.98 },
                  show: { opacity: 1, y: 0, scale: 1 },
                }}
                whileTap={{ scale: 0.975 }}
              >
                <span className="wallet-earn-reward">
                  <GiftIcon /> +{withUnit(event.rewardPolicy?.amount ?? '0')}
                </span>
                <strong>{event.title}</strong>
                <small>{formatNovosibirskDate(event.startsAt)}</small>
                <ArrowIcon />
              </m.button>
            ))}
          </m.div>
        ) : (
          <button
            className="wallet-empty-inline"
            type="button"
            onClick={() => onNavigate('events')}
          >
            <GiftIcon />
            <span>
              <strong>Скоро здесь появятся награды</strong>
              <small>Откройте список мероприятий</small>
            </span>
            <ArrowIcon />
          </button>
        )}
      </section>

      <section className="wallet-section" aria-labelledby="feed-title">
        <div className="wallet-section-heading">
          <div>
            <p className="wallet-kicker">Стартап-студия НГУ</p>
            <h2 id="feed-title">Что нового</h2>
          </div>
        </div>
        {visibleFeed.length ? (
          <m.div
            className="wallet-feed"
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.05 } } }}
          >
            {visibleFeed.map((item, index) => {
              const motion = {
                hidden: { opacity: 0, y: 14 },
                show: { opacity: 1, y: 0 },
              };
              if (item.cardHtml) {
                return (
                  <m.div
                    className="wallet-feed-card wallet-custom-card"
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Открыть «${item.title}»`}
                    layout
                    onClick={() => openFeedCard(item)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openFeedCard(item);
                      }
                    }}
                    whileTap={{ scale: 0.985 }}
                    variants={motion}
                  >
                    <RichHtml
                      html={item.cardHtml}
                      onAction={() => openFeedCard(item)}
                      onLink={onOpenInternalLink}
                    />
                  </m.div>
                );
              }
              return (
                <m.button
                  type="button"
                  className="wallet-feed-card"
                  key={item.id}
                  layout
                  onClick={() => openFeedCard(item)}
                  whileTap={{ scale: 0.985 }}
                  variants={motion}
                >
                  <div
                    className={`wallet-feed-mark wallet-feed-mark--${(index % 3) + 1}`}
                    aria-hidden="true"
                  >
                    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span>✦</span>}
                  </div>
                  <div>
                    <span>
                      {item.kind === 'event'
                        ? 'Мероприятие'
                        : item.kind === 'product'
                          ? 'Магазин'
                          : item.kind === 'system'
                            ? 'Мои операции'
                            : 'Новости'}
                    </span>
                    <h3>{item.title}</h3>
                    <p>{item.summary ?? richContentToText(item.body, item.bodyFormat)}</p>
                    {item.actionLabel ? (
                      <span className="wallet-feed-action">
                        {item.actionLabel} <ArrowIcon />
                      </span>
                    ) : null}
                  </div>
                </m.button>
              );
            })}
          </m.div>
        ) : (
          <div className="wallet-empty-card">
            <Image src="/cats/cat-6-pink.svg" alt="" width={140} height={140} unoptimized />
            <div>
              <strong>Лента готовится</strong>
              <p>Кот уже собирает новости, товары и новые способы заработать.</p>
            </div>
          </div>
        )}
      </section>

      <button className="wallet-profile-link" type="button" onClick={() => onNavigate('profile')}>
        <SettingsIcon /> Настройки профиля <ArrowIcon />
      </button>
      <AnimatePresence>
        {selectedPost ? (
          <m.div
            className={`wallet-dialog-backdrop wallet-content-backdrop${''}`}
            role="presentation"
            onMouseDown={() => setSelectedPost(null)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <m.article
              className={`wallet-dialog wallet-content-sheet${''}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="feed-detail-title"
              onMouseDown={(event) => event.stopPropagation()}
              initial={{ opacity: 0, y: 44 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 44 }}
            >
              {<span className="wallet-dialog-handle" />}
              <button
                type="button"
                className="wallet-dialog-close"
                aria-label="Закрыть публикацию"
                onClick={() => setSelectedPost(null)}
              >
                ×
              </button>
              {null}
              <div className={undefined}>
                {null}
                <p className="wallet-kicker">
                  {selectedPost.kind === 'event'
                    ? 'Мероприятие'
                    : selectedPost.kind === 'product'
                      ? 'Магазин'
                      : 'Новости'}
                </p>
                <h2 id="feed-detail-title">{selectedPost.title}</h2>
                <small className="wallet-content-date">
                  {formatNovosibirskDateTime(selectedPost.publishedAt)}
                </small>
                {selectedPost.bodyFormat === 'html' ? (
                  <RichHtml
                    className="wallet-rich-content"
                    html={selectedPost.body ?? ''}
                    onAction={() => {
                      const item = selectedPost;
                      setSelectedPost(null);
                      void openFeedItem(item);
                    }}
                    onLink={onOpenInternalLink}
                  />
                ) : (
                  <p className="wallet-rich-content wallet-rich-content--text">
                    {selectedPost.body || selectedPost.summary}
                  </p>
                )}
                {selectedPost.eventId || selectedPost.productId || selectedPost.actionUrl ? (
                  <Button
                    type="button"
                    className="wallet-primary-button"
                    onClick={() => {
                      const item = selectedPost;
                      setSelectedPost(null);
                      void openFeedItem(item);
                    }}
                  >
                    {selectedPost.actionLabel ||
                      (selectedPost.eventId
                        ? 'Открыть мероприятие'
                        : selectedPost.productId
                          ? 'Открыть товар'
                          : 'Подробнее')}
                  </Button>
                ) : null}
              </div>
            </m.article>
            <EntityBackButton
              className="entity-back-button--content"
              label="К ленте"
              onClick={() => setSelectedPost(null)}
            />
            {selectedPost.eventId || selectedPost.productId || selectedPost.actionUrl ? (
              <EntityActionDock
                className="entity-action-dock--content"
                label={
                  selectedPost.kind === 'event'
                    ? 'Мероприятие'
                    : selectedPost.kind === 'product'
                      ? 'Товар'
                      : 'Публикация'
                }
                detail={selectedPost.title}
              >
                <Button
                  type="button"
                  className="entity-action-dock__primary"
                  onClick={() => {
                    const item = selectedPost;
                    setSelectedPost(null);
                    void openFeedItem(item);
                  }}
                >
                  {selectedPost.actionLabel ||
                    (selectedPost.eventId
                      ? 'Открыть мероприятие'
                      : selectedPost.productId
                        ? 'Открыть товар'
                        : 'Подробнее')}
                  <ArrowIcon />
                </Button>
              </EntityActionDock>
            ) : null}
          </m.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
export function StoreView({
  initialProductKey = null,
  onInitialProductHandled,
  onOpenInternalLink,
}: {
  initialProductKey?: string | null;
  onInitialProductHandled?: () => void;
  onOpenInternalLink?: (href: string) => boolean;
} = {}) {
  const { withUnit, summary, loading: programLoading } = useWalletProgram();
  const [products, setProducts] = useState<WalletProduct[]>([]);
  const [orders, setOrders] = useState<WalletOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('Все');
  const [selected, setSelected] = useState<WalletProduct | null>(null);
  const [selectedMediaIndex, setSelectedMediaIndex] = useState(0);
  const [teeColor, setTeeColor] = useState<'dark' | 'light'>('dark');
  const [teeSize, setTeeSize] = useState('M');
  const [message, setMessage] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [pickupQr, setPickupQr] = useState<{
    id: string;
    token: string;
    orderId: string;
    expiresAt: string;
    productTitle: string;
  } | null>(null);
  const [pickupQrImage, setPickupQrImage] = useState<string | null>(null);
  const [pickupNow, setPickupNow] = useState(Date.now());
  const storeMutationRef = useRef<string | null>(null);
  const checkoutAttemptRef = useRef<IdempotencyAttempt | null>(null);
  const pickupAttemptRef = useRef<IdempotencyAttempt | null>(null);
  const pickupQrAttemptRef = useRef<IdempotencyAttempt | null>(null);
  useEffect(() => {
    if (programLoading) return;
    if (!summary?.program.storeEnabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void Promise.allSettled([
      api<PaginatedWalletResponse<WalletProduct>>('/store/products?limit=50'),
      api<PaginatedWalletResponse<WalletOrder>>('/store/orders?limit=50'),
    ]).then(([productsResult, ordersResult]) => {
      if (cancelled) return;
      if (productsResult.status === 'fulfilled') {
        setProducts(
          productsResult.value.items.filter(
            (item) => item.status === 'published' && item.kind !== 'digital',
          ),
        );
      } else {
        setError('Каталог ещё наполняется');
      }
      if (ordersResult.status === 'fulfilled') setOrders(ordersResult.value.items);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [programLoading, summary?.program.storeEnabled]);
  useEffect(() => {
    if (!pickupQr) return;
    const timer = window.setInterval(() => setPickupNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pickupQr]);
  const categories = useMemo(
    () => [
      'Все',
      ...new Set(products.map((product) => product.category?.title).filter(Boolean) as string[]),
    ],
    [products],
  );
  const visible =
    category === 'Все' ? products : products.filter((item) => item.category?.title === category);
  const selectedImages = useMemo(() => {
    if (!selected) return [];
    const images: Array<{
      url: string;
      altText: string;
    }> = [];
    const seen = new Set<string>();
    for (const image of [
      selected.coverUrl || selected.imageUrl
        ? {
            url: selected.coverUrl ?? selected.imageUrl ?? '',
            altText: selected.title,
          }
        : null,
      ...(selected.media ?? []).map((item) => ({
        url: item.url,
        altText: item.altText || selected.title,
      })),
    ]) {
      if (!image?.url || seen.has(image.url)) continue;
      seen.add(image.url);
      images.push(image);
    }
    return images;
  }, [selected]);
  const openProduct = (product: WalletProduct) => {
    if (storeMutationRef.current) return;
    checkoutAttemptRef.current = null;
    setSelected(product);
    setSelectedMediaIndex(0);
    setTeeColor('dark');
    setTeeSize('M');
  };
  useEffect(() => {
    if (!initialProductKey || loading) return;
    const product = products.find(
      (item) => item.id === initialProductKey || item.slug === initialProductKey,
    );
    if (product) {
      checkoutAttemptRef.current = null;
      setSelected(product);
      setSelectedMediaIndex(0);
      setTeeColor('dark');
      setTeeSize('M');
    } else {
      setMessage('Товар по этой ссылке не найден');
    }
    onInitialProductHandled?.();
  }, [initialProductKey, loading, onInitialProductHandled, products]);
  const beginStoreMutation = (mutation: string): boolean => {
    if (storeMutationRef.current) return false;
    storeMutationRef.current = mutation;
    setOrdering(true);
    return true;
  };
  const finishStoreMutation = (mutation: string): void => {
    if (storeMutationRef.current !== mutation) return;
    storeMutationRef.current = null;
    setOrdering(false);
  };
  const closeSelectedProduct = (): void => {
    if (storeMutationRef.current) return;
    checkoutAttemptRef.current = null;
    setSelected(null);
  };
  const placeOrder = async () => {
    if (!selected) return;
    const comment = isCatalystTee(selected)
      ? 'Футболка Catalyst\nЦвет: ' +
        (teeColor === 'dark' ? 'Тёмный' : 'Светлый') +
        '\nРазмер: ' +
        teeSize
      : null;
    const body = JSON.stringify({
      items: [{ productId: selected.id, quantity: 1 }],
      ...(comment ? { comment } : {}),
    });
    const mutation = `checkout:${body}`;
    if (!beginStoreMutation(mutation)) return;
    const attempt = resolveIdempotencyAttempt(checkoutAttemptRef.current, body);
    checkoutAttemptRef.current = attempt;
    setMessage(null);
    try {
      const order = await api<WalletOrder>('/store/checkout', {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body,
      });
      checkoutAttemptRef.current = null;
      setOrders((items) => [order, ...items.filter((item) => item.id !== order.id)]);
      setMessage(
        order.status === 'paid'
          ? 'Оплата прошла. Оставьте заявку на выдачу ниже.'
          : 'Заказ создан, заявка на выдачу принята.',
      );
      setTeeColor('dark');
      setTeeSize('M');
      setSelected(null);
      getMessengerAdapter()?.notify('success');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось создать заказ');
    } finally {
      finishStoreMutation(mutation);
    }
  };
  const requestPickup = async (order: WalletOrder) => {
    const body = JSON.stringify({});
    const mutation = `pickup:${order.id}`;
    if (!beginStoreMutation(mutation)) return;
    const attempt = resolveIdempotencyAttempt(pickupAttemptRef.current, mutation);
    pickupAttemptRef.current = attempt;
    setMessage(null);
    try {
      const updated = await api<WalletOrder>(
        `/store/orders/${encodeURIComponent(order.id)}/pickup-request`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': attempt.key },
          body,
        },
      );
      pickupAttemptRef.current = null;
      setOrders((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setMessage('Заявка на выдачу отправлена');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось оставить заявку');
    } finally {
      finishStoreMutation(mutation);
    }
  };
  const showPickupQr = async (order: WalletOrder) => {
    const body = JSON.stringify({});
    const mutation = `pickup-qr:${order.id}`;
    if (!beginStoreMutation(mutation)) return;
    const attempt = resolveIdempotencyAttempt(pickupQrAttemptRef.current, mutation);
    pickupQrAttemptRef.current = attempt;
    setMessage(null);
    try {
      const session = await api<{
        id: string;
        token: string;
        orderId: string;
        expiresAt: string;
      }>(`/store/orders/${encodeURIComponent(order.id)}/qr`, {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body,
      });
      const image = await QRCode.toDataURL(session.token, {
        width: 460,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#080808', light: '#ffffff' },
      });
      setPickupNow(Date.now());
      setPickupQr({ ...session, productTitle: order.productTitle });
      setPickupQrImage(image);
      pickupQrAttemptRef.current = null;
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось создать QR для выдачи');
    } finally {
      finishStoreMutation(mutation);
    }
  };
  const pickupSecondsLeft = pickupQr
    ? Math.max(0, Math.ceil((new Date(pickupQr.expiresAt).getTime() - pickupNow) / 1000))
    : 0;
  return (
    <section className="wallet-screen" aria-labelledby="store-title">
      <header className="wallet-page-header">
        <p className="wallet-kicker">Обменять баллы</p>
        <h1 id="store-title">Магазин</h1>
        <p>Мерч, встречи и полезные возможности от Стартап-студии НГУ.</p>
      </header>
      {!programLoading && !summary?.program.storeEnabled ? (
        <div className="wallet-empty-store" role="status">
          <Image src="/cats/cat-5-pink.svg" alt="" width={230} height={230} unoptimized />
          <h2>Магазин пока закрыт</h2>
          <p>Как только обмен баллов станет доступен, каталог появится здесь автоматически.</p>
        </div>
      ) : null}
      {programLoading || summary?.program.storeEnabled ? (
        <>
          {categories.length > 1 ? (
            <div className="wallet-chip-row" aria-label="Категории товаров">
              {categories.map((item) => (
                <button
                  type="button"
                  className={item === category ? 'active' : ''}
                  key={item}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          ) : null}
          {message ? <div className="wallet-notice">{message}</div> : null}
          {loading ? (
            <div className="wallet-product-grid">
              <div className="wallet-skeleton" />
              <div className="wallet-skeleton" />
            </div>
          ) : visible.length ? (
            <m.div className="wallet-product-grid" layout>
              {visible.map((product, index) => {
                if (product.cardHtml && !isCatalystTee(product)) {
                  return (
                    <m.div
                      className="wallet-product-card wallet-custom-card"
                      key={product.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Открыть товар «${product.title}»`}
                      layout
                      onClick={() => openProduct(product)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openProduct(product);
                        }
                      }}
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.97 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <RichHtml
                        html={product.cardHtml}
                        onAction={() => openProduct(product)}
                        {...(onOpenInternalLink ? { onLink: onOpenInternalLink } : {})}
                      />
                    </m.div>
                  );
                }
                return (
                  <m.button
                    type="button"
                    className={
                      'wallet-product-card' +
                      (isCatalystTee(product) ? ' catalyst-product-card' : '')
                    }
                    key={product.id}
                    aria-label={`Открыть товар «${product.title}»`}
                    onClick={() => openProduct(product)}
                    layout
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                  >
                    <div
                      className={`wallet-product-image wallet-product-image--${(index % 3) + 1}`}
                    >
                      {isCatalystTee(product) ? (
                        <>
                          <span className="catalyst-drop-label">CATALYST / MERCH</span>
                          <img
                            src="/merch/tee-dark-front.webp"
                            alt="Футболка Catalyst с маскотом"
                          />
                          <span className="catalyst-card-sticker">
                            СОЗДАВАЙ.
                            <br />
                            НОСИ.
                          </span>
                        </>
                      ) : product.coverUrl || product.imageUrl || product.media?.[0]?.url ? (
                        <img
                          src={
                            product.coverUrl ?? product.imageUrl ?? product.media?.[0]?.url ?? ''
                          }
                          alt={product.media?.[0]?.altText ?? ''}
                        />
                      ) : (
                        <StoreIcon />
                      )}
                      {product.stockMode === 'limited' && (product.available ?? 0) === 0 ? (
                        <span>Нет в наличии</span>
                      ) : null}
                    </div>
                    <small>{product.category?.title ?? 'Каталог'}</small>
                    <h2>{product.title}</h2>
                    <p>{richContentToText(product.description, product.descriptionFormat)}</p>
                    <span
                      className="wallet-product-price"
                      data-disabled={
                        product.stockMode === 'limited' && (product.available ?? 0) === 0
                          ? 'true'
                          : undefined
                      }
                    >
                      {withUnit(product.price)}
                    </span>
                  </m.button>
                );
              })}
            </m.div>
          ) : (
            <div className="wallet-empty-store">
              <Image src="/cats/cat-5-pink.svg" alt="" width={230} height={230} unoptimized />
              <h2>{error ?? 'Полки пока пусты'}</h2>
              <p>
                Администратор сможет добавить товар, цену, остаток и правила выдачи в конструкторе.
              </p>
            </div>
          )}
          <section className="wallet-section wallet-orders" aria-labelledby="orders-title">
            <div className="wallet-section-heading">
              <div>
                <p className="wallet-kicker">После оплаты</p>
                <h2 id="orders-title">Мои заявки</h2>
              </div>
            </div>
            {orders.length ? (
              <m.div className="wallet-order-list" layout>
                {orders.map((order) => (
                  <m.article
                    key={order.id}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <div>
                      <strong>{order.productTitle}</strong>
                      <small>
                        {withUnit(order.amount)} · {formatNovosibirskDate(order.createdAt)}
                      </small>
                      {order.comment ? (
                        <small className="wallet-order-comment">{order.comment}</small>
                      ) : null}
                    </div>
                    <span>
                      {order.status === 'paid'
                        ? 'Оплачено'
                        : order.status === 'pickup_requested'
                          ? 'Заявка принята'
                          : order.status === 'ready_for_pickup'
                            ? 'Можно забрать'
                            : 'Выдано'}
                    </span>
                    {order.status === 'paid' ? (
                      <Button
                        type="button"
                        disabled={ordering}
                        onClick={() => requestPickup(order)}
                      >
                        Оставить заявку на выдачу
                      </Button>
                    ) : null}
                    {order.status === 'pickup_requested' || order.status === 'ready_for_pickup' ? (
                      <Button
                        type="button"
                        className="wallet-order-qr-button"
                        disabled={ordering}
                        onClick={() => void showPickupQr(order)}
                      >
                        <QrIcon /> Показать QR для выдачи
                      </Button>
                    ) : null}
                  </m.article>
                ))}
              </m.div>
            ) : (
              <div className="wallet-empty-inline wallet-empty-inline--static">
                <StoreIcon />
                <span>
                  <strong>Заявок пока нет</strong>
                  <small>Оплаченные товары появятся здесь</small>
                </span>
              </div>
            )}
          </section>
          <AnimatePresence>
            {selected ? (
              <m.div
                className={`wallet-dialog-backdrop${''}`}
                role="presentation"
                onMouseDown={closeSelectedProduct}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <m.section
                  className={`wallet-dialog wallet-product-sheet${''}`}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="order-title"
                  onMouseDown={(event) => event.stopPropagation()}
                  initial={{ opacity: 0, y: 36 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 36 }}
                >
                  {<span className="wallet-dialog-handle" />}
                  <button
                    type="button"
                    className="wallet-dialog-close"
                    aria-label="Закрыть товар"
                    disabled={ordering}
                    onClick={closeSelectedProduct}
                  >
                    ×
                  </button>
                  {
                    <div
                      className={
                        'wallet-product-gallery' +
                        (isCatalystTee(selected) ? ' catalyst-native-gallery' : '')
                      }
                    >
                      {isCatalystTee(selected) ? <CatalystTeeGallery color={teeColor} /> : null}
                      <div className="wallet-product-gallery__main">
                        {selectedImages[selectedMediaIndex] ? (
                          <img
                            src={selectedImages[selectedMediaIndex].url}
                            alt={selectedImages[selectedMediaIndex].altText}
                          />
                        ) : (
                          <StoreIcon />
                        )}
                      </div>
                      {selectedImages.length > 1 ? (
                        <div
                          className="wallet-product-gallery__thumbs"
                          aria-label="Фотографии товара"
                        >
                          {selectedImages.map((image, index) => (
                            <button
                              type="button"
                              className={index === selectedMediaIndex ? 'active' : ''}
                              aria-label={`Показать фото ${index + 1}`}
                              onClick={() => setSelectedMediaIndex(index)}
                              key={`${image.url}:${index}`}
                            >
                              <img src={image.url} alt="" />
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  }
                  <div className={'wallet-product-standard-details'}>
                    <p className="wallet-kicker">{selected.category?.title ?? 'Каталог'}</p>
                    <h2 id="order-title">{selected.title}</h2>
                    {isCatalystTee(selected) ? (
                      <CatalystTeeOptions
                        color={teeColor}
                        size={teeSize}
                        onColorChange={setTeeColor}
                        onSizeChange={setTeeSize}
                        disabled={ordering}
                      />
                    ) : null}
                    {selected.descriptionFormat === 'html' ? (
                      <RichHtml
                        className="wallet-rich-content"
                        html={selected.description ?? ''}
                        onAction={() => void placeOrder()}
                        {...(onOpenInternalLink ? { onLink: onOpenInternalLink } : {})}
                      />
                    ) : selected.description ? (
                      <p className="wallet-rich-content wallet-rich-content--text">
                        {selected.description}
                      </p>
                    ) : null}
                    {selected.pickupInstructions ? (
                      <div className="wallet-product-pickup">
                        <strong>Как получить</strong>
                        <p>{selected.pickupInstructions}</p>
                      </div>
                    ) : null}
                    {message ? (
                      <p className="wallet-notice" role="alert">
                        {message}
                      </p>
                    ) : null}
                    <div className="wallet-product-checkout-summary">
                      <span>Стоимость</span>
                      <strong>{withUnit(selected.price)}</strong>
                    </div>
                    <Button
                      type="button"
                      className="wallet-primary-button"
                      disabled={
                        ordering ||
                        (selected.stockMode === 'limited' && (selected.available ?? 0) === 0)
                      }
                      onClick={() => void placeOrder()}
                    >
                      {ordering ? 'Создаём заказ…' : 'Обменять баллы'}
                    </Button>
                    <Button
                      type="button"
                      className="wallet-secondary-button"
                      disabled={ordering}
                      onClick={closeSelectedProduct}
                    >
                      Отмена
                    </Button>
                  </div>
                </m.section>
                <EntityBackButton
                  className="entity-back-button--product"
                  label="В магазин"
                  onClick={closeSelectedProduct}
                />
                <EntityActionDock
                  className="entity-action-dock--product"
                  label={withUnit(selected.price)}
                  detail={selected.title}
                >
                  <Button
                    type="button"
                    className="entity-action-dock__primary"
                    disabled={
                      ordering ||
                      (selected.stockMode === 'limited' && (selected.available ?? 0) === 0)
                    }
                    onClick={() => void placeOrder()}
                  >
                    {ordering ? 'Создаём заказ…' : 'Обменять баллы'}
                  </Button>
                </EntityActionDock>
              </m.div>
            ) : null}
          </AnimatePresence>
          <AnimatePresence>
            {pickupQr ? (
              <m.div
                className="wallet-dialog-backdrop wallet-pickup-backdrop"
                role="presentation"
                onMouseDown={() => setPickupQr(null)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <m.section
                  className="wallet-dialog wallet-pickup-sheet"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="pickup-qr-title"
                  onMouseDown={(event) => event.stopPropagation()}
                  initial={{ opacity: 0, y: 44 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 44 }}
                >
                  <span className="wallet-dialog-handle" />
                  <button
                    type="button"
                    className="wallet-dialog-close"
                    aria-label="Закрыть"
                    onClick={() => setPickupQr(null)}
                  >
                    ×
                  </button>
                  <p className="wallet-kicker">Выдача без ручного поиска</p>
                  <h2 id="pickup-qr-title">Покажите QR сотруднику</h2>
                  <p>{pickupQr.productTitle}</p>
                  {pickupQrImage && pickupSecondsLeft > 0 ? (
                    <img src={pickupQrImage} alt="Временный QR для выдачи заказа" />
                  ) : null}
                  {pickupSecondsLeft > 0 ? (
                    <p className="wallet-qr-timer">Действует ещё {pickupSecondsLeft} сек.</p>
                  ) : (
                    <Button
                      type="button"
                      className="wallet-primary-button"
                      onClick={() => {
                        const order = orders.find((item) => item.id === pickupQr.orderId);
                        if (order) void showPickupQr(order);
                      }}
                    >
                      Обновить QR
                    </Button>
                  )}
                  <p className="wallet-security-note">
                    Сотрудник сканирует код один раз. После успешной выдачи повторно использовать
                    его нельзя.
                  </p>
                </m.section>
              </m.div>
            ) : null}
          </AnimatePresence>
        </>
      ) : null}
    </section>
  );
}
export function HistoryView() {
  const { withUnit } = useWalletProgram();
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'income' | 'expense'>('all');
  useEffect(() => {
    void api<WalletHistoryResponse>('/wallet/history?limit=100')
      .then((result) => setItems(result.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);
  const visible = items.filter((item) => {
    const outgoing = isDebit(item.delta);
    return filter === 'all' || (filter === 'expense' ? outgoing : !outgoing);
  });
  return (
    <section className="wallet-screen" aria-labelledby="history-title">
      <header className="wallet-page-header">
        <p className="wallet-kicker">Прозрачный журнал</p>
        <h1 id="history-title">История</h1>
        <p>Все начисления, переводы, покупки и административные корректировки.</p>
      </header>
      <div className="wallet-segmented" aria-label="Фильтр истории">
        {(
          [
            ['all', 'Все'],
            ['income', 'Начисления'],
            ['expense', 'Списания'],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            className={filter === key ? 'active' : ''}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="wallet-history">
          <div className="wallet-skeleton wallet-skeleton--row" />
          <div className="wallet-skeleton wallet-skeleton--row" />
        </div>
      ) : visible.length ? (
        <m.div className="wallet-history" layout>
          {visible.map((item) => {
            const outgoing = isDebit(item.delta);
            return (
              <m.article
                className="wallet-history-row"
                key={item.entryId}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -12 }}
              >
                <span className={outgoing ? 'expense' : 'income'}>
                  {item.counterpart?.avatarUrl ? (
                    <img src={item.counterpart.avatarUrl} alt="" />
                  ) : outgoing ? (
                    '↗'
                  ) : (
                    '↙'
                  )}
                </span>
                <div>
                  <strong>{item.reason || transactionLabel(item.kind)}</strong>
                  <small>
                    {formatNovosibirskDateTime(item.createdAt)}
                    {item.counterpart?.displayName ? ` · ${item.counterpart.displayName}` : ''}
                    {item.counterpart?.username ? ` · @${item.counterpart.username}` : ''}
                    {item.actor?.displayName && item.actor.id !== item.counterpart?.id
                      ? ` · сотрудник ${item.actor.displayName}`
                      : ''}
                  </small>
                </div>
                <b className={outgoing ? 'expense' : 'income'}>{signedAmount(item, withUnit)}</b>
              </m.article>
            );
          })}
        </m.div>
      ) : (
        <div className="wallet-empty-card wallet-empty-card--history">
          <Image src="/cats/cat-1-pink.svg" alt="" width={150} height={150} unoptimized />
          <div>
            <strong>История начнётся с первой операции</strong>
            <p>Начисления и списания появятся здесь после подключения кошелька.</p>
          </div>
        </div>
      )}
    </section>
  );
}
export function WalletQrSheet({
  initialMode = 'menu',
  onClose,
}: {
  initialMode?: WalletQrMode;
  onClose: () => void;
}) {
  const { withUnit, refresh, applyDelta, summary } = useWalletProgram();
  const [mode, setMode] = useState<WalletQrMode>(initialMode);
  const [qrSession, setQrSession] = useState<WalletQrSession | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [scannedPayload, setScannedPayload] = useState('');
  const [resolvedQr, setResolvedQr] = useState<WalletResolvedQr | null>(null);
  const [intentKind, setIntentKind] = useState<WalletIntent['kind']>('p2p_transfer');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [eventId, setEventId] = useState('');
  const [events, setEvents] = useState<EventItem[]>([]);
  const [preview, setPreview] = useState<{
    amount: string;
    kind: WalletIntent['kind'];
    counterparty: WalletResolvedQr['owner'];
    reason: string | null;
    eventId: string | null;
  } | null>(null);
  const [ownerPendingIntent, setOwnerPendingIntent] = useState<WalletIntent | null>(null);
  const [ownerDecisionBusy, setOwnerDecisionBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [successTitle, setSuccessTitle] = useState('Операция подтверждена');
  const [browserScanner, setBrowserScanner] = useState(false);
  const [now, setNow] = useState(Date.now());
  const qrSessionRef = useRef<WalletQrSession | null>(null);
  const cancelledQrIds = useRef(new Set<string>());
  const claimedQrIds = useRef(new Set<string>());
  const scannerVideoRef = useRef<HTMLVideoElement | null>(null);
  const browserScannerControls = useRef<{
    stop: () => void;
  } | null>(null);
  const mountedRef = useRef(true);
  const sheetMutationRef = useRef<string | null>(null);
  const closeInFlightRef = useRef(false);
  const qrCreateAttemptRef = useRef<IdempotencyAttempt | null>(null);
  const intentCreateAttemptRef = useRef<IdempotencyAttempt | null>(null);
  const intentConfirmAttemptRef = useRef<IdempotencyAttempt | null>(null);
  const ownerDecisionAttemptRef = useRef<IdempotencyAttempt | null>(null);
  const beginSheetMutation = (mutation: string): boolean => {
    if (sheetMutationRef.current || closeInFlightRef.current) return false;
    sheetMutationRef.current = mutation;
    return true;
  };
  const finishSheetMutation = (mutation: string): void => {
    if (sheetMutationRef.current === mutation) sheetMutationRef.current = null;
  };
  const cancelQr = (session: WalletQrSession | null) => {
    if (!session || claimedQrIds.current.has(session.id) || cancelledQrIds.current.has(session.id))
      return;
    cancelledQrIds.current.add(session.id);
    void api(`/wallet/qr/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    }).catch(() => undefined);
  };
  const closeSheet = async () => {
    if (sheetMutationRef.current || closeInFlightRef.current) return;
    closeInFlightRef.current = true;
    setClosing(true);
    let closed = false;
    try {
      if (
        mode === 'show' &&
        qrSessionRef.current &&
        !claimedQrIds.current.has(qrSessionRef.current.id) &&
        !success
      ) {
        try {
          const result = await api<{
            items: WalletIntent[];
          }>('/wallet/intents/pending');
          const pending = result.items.find(
            (item) => item.kind === 'staff_debit' && item.status === 'awaiting_owner_confirmation',
          );
          if (pending) {
            claimedQrIds.current.add(qrSessionRef.current.id);
            setOwnerPendingIntent(pending);
            return;
          }
        } catch {
          // Keep close available offline; the server also guards consumed QR sessions.
        }
      }
      cancelQr(qrSessionRef.current);
      closeMessengerScanner();
      browserScannerControls.current?.stop();
      onClose();
      closed = true;
    } finally {
      closeInFlightRef.current = false;
      if (!closed) setClosing(false);
    }
  };
  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      closeMessengerScanner();
      browserScannerControls.current?.stop();
      cancelQr(qrSessionRef.current);
    };
    // QR cancellation intentionally uses the latest session through a ref.
  }, []);
  const secondsLeft = qrSession
    ? Math.max(0, Math.ceil((new Date(qrSession.expiresAt).getTime() - now) / 1000))
    : 0;
  const createQr = async () => {
    const body = JSON.stringify({});
    const mutation = 'create-wallet-qr';
    if (!beginSheetMutation(mutation)) return;
    cancelQr(qrSessionRef.current);
    const attempt = resolveIdempotencyAttempt(qrCreateAttemptRef.current, body);
    qrCreateAttemptRef.current = attempt;
    setLoading(true);
    setError(null);
    try {
      const session = await api<WalletQrSession>('/wallet/qr', {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body,
      });
      if (!mountedRef.current) {
        cancelQr(session);
        return;
      }
      const dataUrl = await QRCode.toDataURL(session.token, {
        width: 460,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#080808', light: '#ffffff' },
      });
      setQrSession(session);
      qrSessionRef.current = session;
      setQrImage(dataUrl);
      qrCreateAttemptRef.current = null;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось создать временный QR');
    } finally {
      setLoading(false);
      finishSheetMutation(mutation);
    }
  };
  useEffect(() => {
    if (mode === 'show' && !qrSession && !loading && !error) void createQr();
    // createQr intentionally runs only when the user opens this mode.
  }, [mode]);
  useEffect(() => {
    if (mode !== 'show') return;
    let disposed = false;
    const poll = async () => {
      try {
        const result = await api<{
          items: WalletIntent[];
        }>('/wallet/intents/pending');
        if (disposed) return;
        const pending =
          result.items.find(
            (item) => item.kind === 'staff_debit' && item.status === 'awaiting_owner_confirmation',
          ) ?? null;
        setOwnerPendingIntent(pending);
        if (pending && qrSessionRef.current) {
          // Once a QR has produced a debit intent it is owned by that intent. Deleting the
          // session on sheet close would make the owner's confirmation impossible.
          claimedQrIds.current.add(qrSessionRef.current.id);
        }
        await refresh({ silent: true });
      } catch {
        // The QR itself stays usable while gradual wallet rollout endpoints are unavailable.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [mode, refresh]);
  const startScanner = async () => {
    setError(null);
    const messenger = getMessengerAdapter();
    if (!messenger || !messenger.supportsQrScanner()) {
      setBrowserScanner(true);
      return;
    }
    try {
      const data = await messenger.scanQr({
        prompt: 'Наведите камеру на временный QR участника',
        fileSelect: true,
      });
      if (!data) {
        setError('Сканирование отменено. Можно повторить или включить камеру устройства.');
        return;
      }
      setScannedPayload(data);
    } catch {
      setError('Сканер мессенджера недоступен. Можно включить камеру устройства.');
    }
  };
  const stopBrowserScanner = () => {
    browserScannerControls.current?.stop();
    browserScannerControls.current = null;
    setBrowserScanner(false);
  };
  useEffect(() => {
    if (!browserScanner || !scannerVideoRef.current) return;
    let disposed = false;
    void import('@zxing/browser')
      .then(async ({ BrowserQRCodeReader }) => {
        const reader = new BrowserQRCodeReader(undefined, {
          delayBetweenScanAttempts: 180,
        });
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          scannerVideoRef.current!,
          (result, caught, scanner) => {
            if (disposed) return;
            if (result) {
              setScannedPayload(result.getText());
              scanner.stop();
              setBrowserScanner(false);
            } else if (caught && caught.name !== 'NotFoundException') {
              setError('Не удалось распознать QR. Можно вставить код вручную.');
            }
          },
        );
        if (disposed) controls.stop();
        else browserScannerControls.current = controls;
      })
      .catch(() => {
        setBrowserScanner(false);
        setError('Камера недоступна. Разрешите доступ или вставьте код вручную.');
      });
    return () => {
      disposed = true;
      browserScannerControls.current?.stop();
      browserScannerControls.current = null;
    };
  }, [browserScanner]);
  useEffect(() => {
    if (mode === 'scan') void startScanner();
    // Scanner must open only after an explicit mode choice.
  }, [mode]);
  const requestPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!scannedPayload.trim()) return setError('Отсканируйте QR или введите код вручную');
    const mutation = resolvedQr ? 'prepare-wallet-intent' : 'resolve-wallet-qr';
    if (!beginSheetMutation(mutation)) return;
    setLoading(true);
    setError(null);
    try {
      if (!resolvedQr) {
        const resolved = await api<WalletResolvedQr>('/wallet/qr/resolve', {
          method: 'POST',
          body: JSON.stringify({ token: scannedPayload.trim() }),
        });
        if (resolved.capabilities.length === 0)
          throw new Error('Для этого QR нет доступных операций');
        setResolvedQr(resolved);
        setIntentKind(
          resolved.capabilities.includes('p2p_transfer')
            ? 'p2p_transfer'
            : (resolved.capabilities[0] ?? 'p2p_transfer'),
        );
        if (resolved.capabilities.some((capability) => capability.startsWith('staff_'))) {
          void api<{
            items: EventItem[];
          }>('/events?limit=100')
            .then((result) => setEvents(result.items))
            .catch(() => setEvents([]));
        }
        return;
      }
      if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n)
        throw new Error('Введите целое количество баллов');
      if (!resolvedQr.capabilities.includes(intentKind)) throw new Error('Эта операция недоступна');
      if (intentKind !== 'p2p_transfer' && reason.trim().length < 3)
        throw new Error('Для операции сотрудника нужна причина');
      if (intentKind === 'staff_debit') {
        const body = JSON.stringify({
          token: scannedPayload.trim(),
          kind: intentKind,
          amount,
          reason: reason.trim() || undefined,
          eventId: eventId || undefined,
        });
        const attempt = resolveIdempotencyAttempt(intentCreateAttemptRef.current, body);
        intentCreateAttemptRef.current = attempt;
        await api<WalletIntent>('/wallet/intents', {
          method: 'POST',
          headers: { 'Idempotency-Key': attempt.key },
          body,
        });
        intentCreateAttemptRef.current = null;
        setSuccessTitle('Запрос на списание отправлен владельцу');
        setSuccess(true);
      } else {
        setPreview({
          amount,
          kind: intentKind,
          counterparty: resolvedQr.owner,
          reason: reason.trim() || null,
          eventId: eventId || null,
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось проверить перевод');
    } finally {
      setLoading(false);
      finishSheetMutation(mutation);
    }
  };
  const confirmTransfer = async () => {
    if (!preview || !resolvedQr) return;
    const body = JSON.stringify({
      token: scannedPayload.trim(),
      kind: preview.kind,
      amount: preview.amount,
      reason: preview.reason ?? undefined,
      eventId: preview.eventId ?? undefined,
    });
    const mutation = `confirm-wallet-intent:${body}`;
    if (!beginSheetMutation(mutation)) return;
    const createAttempt = resolveIdempotencyAttempt(intentCreateAttemptRef.current, body);
    intentCreateAttemptRef.current = createAttempt;
    setLoading(true);
    setError(null);
    try {
      const created = await api<WalletIntent>('/wallet/intents', {
        method: 'POST',
        headers: { 'Idempotency-Key': createAttempt.key },
        body,
      });
      const confirmationFingerprint = `confirm:${created.id}`;
      const confirmAttempt = resolveIdempotencyAttempt(
        intentConfirmAttemptRef.current,
        confirmationFingerprint,
      );
      intentConfirmAttemptRef.current = confirmAttempt;
      await api(`/wallet/intents/${encodeURIComponent(created.id)}/confirm`, {
        method: 'POST',
        headers: { 'Idempotency-Key': confirmAttempt.key },
        body: JSON.stringify({}),
      });
      intentCreateAttemptRef.current = null;
      intentConfirmAttemptRef.current = null;
      if (preview.kind === 'p2p_transfer') applyDelta(`-${preview.amount}`);
      void refresh({ silent: true });
      setSuccessTitle(
        preview.kind === 'p2p_transfer' ? 'Баллы переведены' : 'Начисление подтверждено',
      );
      setSuccess(true);
      getMessengerAdapter()?.notify('success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось выполнить перевод');
    } finally {
      setLoading(false);
      finishSheetMutation(mutation);
    }
  };
  const decideOwnerDebit = async (decision: 'confirm' | 'reject') => {
    if (!ownerPendingIntent) return;
    const intent = ownerPendingIntent;
    const mutation = `owner-decision:${intent.id}:${decision}`;
    if (!beginSheetMutation(mutation)) return;
    const attempt = resolveIdempotencyAttempt(ownerDecisionAttemptRef.current, mutation);
    ownerDecisionAttemptRef.current = attempt;
    setOwnerDecisionBusy(true);
    setError(null);
    try {
      await api(`/wallet/intents/${encodeURIComponent(intent.id)}/${decision}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body: JSON.stringify({}),
      });
      ownerDecisionAttemptRef.current = null;
      if (decision === 'confirm') {
        applyDelta(`-${intent.amount}`);
        void refresh({ silent: true });
      }
      setOwnerPendingIntent(null);
      setSuccessTitle(decision === 'confirm' ? 'Списание подтверждено' : 'Списание отклонено');
      setSuccess(true);
      getMessengerAdapter()?.notify(decision === 'confirm' ? 'success' : 'warning');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось обработать запрос');
    } finally {
      setOwnerDecisionBusy(false);
      finishSheetMutation(mutation);
    }
  };
  const sheetRequestBusy = loading || ownerDecisionBusy || closing;
  return (
    <m.div
      className="wallet-dialog-backdrop wallet-qr-backdrop"
      role="presentation"
      onMouseDown={() => void closeSheet()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <m.section
        className="wallet-dialog wallet-qr-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-title"
        onMouseDown={(event) => event.stopPropagation()}
        initial={{ opacity: 0, y: 42, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 42, scale: 0.985 }}
        transition={{ type: 'spring', stiffness: 430, damping: 38 }}
      >
        <span className="wallet-dialog-handle" />
        <button
          type="button"
          className="wallet-dialog-close"
          aria-label="Закрыть"
          disabled={sheetRequestBusy}
          onClick={() => void closeSheet()}
        >
          ×
        </button>
        {ownerPendingIntent ? (
          <m.div
            className="wallet-owner-confirm"
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
          >
            <p className="wallet-kicker">Требуется подтверждение</p>
            <h2 id="qr-title">Списать {withUnit(ownerPendingIntent.amount)}?</h2>
            <div className="wallet-owner-confirm-person">
              <span>
                {ownerPendingIntent.initiator?.avatarUrl ? (
                  <img src={ownerPendingIntent.initiator.avatarUrl} alt="" />
                ) : (
                  (ownerPendingIntent.initiator?.displayName ?? 'С').slice(0, 1).toUpperCase()
                )}
              </span>
              <div>
                <small>Запрос от сотрудника</small>
                <strong>
                  {ownerPendingIntent.initiator?.displayName ??
                    ownerPendingIntent.counterparty?.displayName ??
                    'Сотрудник'}
                </strong>
                {ownerPendingIntent.initiator?.username ? (
                  <small>@{ownerPendingIntent.initiator.username}</small>
                ) : null}
              </div>
            </div>
            {ownerPendingIntent.reason ? (
              <div className="wallet-owner-confirm-reason">
                <span>Основание</span>
                <strong>{ownerPendingIntent.reason}</strong>
              </div>
            ) : null}
            <p className="wallet-security-note">
              Проверьте сумму и сотрудника. Без вашего действия баллы не спишутся.
            </p>
            {error ? <div className="wallet-notice wallet-notice--error">{error}</div> : null}
            <div className="wallet-owner-confirm-actions">
              <Button
                type="button"
                className="wallet-secondary-button"
                disabled={ownerDecisionBusy}
                onClick={() => void decideOwnerDebit('reject')}
              >
                Отклонить
              </Button>
              <Button
                type="button"
                className="wallet-primary-button"
                disabled={ownerDecisionBusy}
                onClick={() => void decideOwnerDebit('confirm')}
              >
                {ownerDecisionBusy ? 'Обрабатываем…' : 'Подтвердить списание'}
              </Button>
            </div>
          </m.div>
        ) : success ? (
          <div className="wallet-qr-success">
            <Image src="/cats/cat-3-lime.svg" alt="" width={230} height={230} unoptimized />
            <p className="wallet-kicker">Готово</p>
            <h2 id="qr-title">{successTitle}</h2>
            <p>
              {intentKind === 'staff_debit'
                ? 'Списание произойдёт только после подтверждения владельцем кошелька.'
                : 'Операция уже добавлена в историю.'}
            </p>
            <Button
              type="button"
              className="wallet-primary-button"
              onClick={() => void closeSheet()}
            >
              Закрыть
            </Button>
          </div>
        ) : preview ? (
          <div className="wallet-transfer-confirm">
            <p className="wallet-kicker">Проверьте перевод</p>
            <h2 id="qr-title">{withUnit(preview.amount)}</h2>
            <p>
              Получатель: <strong>{preview.counterparty?.displayName ?? 'Участник'}</strong>
            </p>
            <div>
              <span>Сумма</span>
              <strong>{withUnit(preview.amount)}</strong>
              <span>Комиссия</span>
              <strong>0</strong>
            </div>
            {error ? <div className="wallet-notice wallet-notice--error">{error}</div> : null}
            <Button
              type="button"
              className="wallet-primary-button"
              disabled={loading}
              onClick={confirmTransfer}
            >
              {loading ? 'Переводим…' : 'Подтвердить перевод'}
            </Button>
            <Button
              type="button"
              className="wallet-secondary-button"
              disabled={loading}
              onClick={() => setPreview(null)}
            >
              Изменить сумму
            </Button>
          </div>
        ) : mode === 'menu' ? (
          <>
            <p className="wallet-kicker">Временный QR</p>
            <h2 id="qr-title">Как провести операцию?</h2>
            <p>Как в СБП: QR определяет получателя, а сумму вводит тот, кто сканирует.</p>
            <div className="wallet-qr-choices">
              {summary?.program.p2pEnabled !== false ? (
                <button type="button" onClick={() => setMode('scan')}>
                  <ScanIcon />
                  <span>
                    <strong>Сканировать QR</strong>
                    <small>Перевести другому участнику</small>
                  </span>
                  <ArrowIcon />
                </button>
              ) : null}
              <button type="button" onClick={() => setMode('show')}>
                <QrIcon />
                <span>
                  <strong>Показать мой QR</strong>
                  <small>Получить баллы от участника или сотрудника</small>
                </span>
                <ArrowIcon />
              </button>
            </div>
            <p className="wallet-security-note">
              QR одноразовый, не содержит ID в мессенджере и быстро истекает.
            </p>
          </>
        ) : mode === 'show' ? (
          <div className="wallet-show-qr">
            <p className="wallet-kicker">Получить баллы</p>
            <h2 id="qr-title">Покажите этот QR</h2>
            {loading ? (
              <div className="wallet-qr-loading">
                <Spinner />
                <span>Создаём защищённый код…</span>
              </div>
            ) : null}
            {qrImage && secondsLeft > 0 ? (
              <img src={qrImage} alt="Временный QR для получения баллов" />
            ) : null}
            {qrSession && secondsLeft > 0 ? (
              <p className="wallet-qr-timer">
                <i
                  style={
                    {
                      '--qr-progress': `${Math.min(100, secondsLeft / 1.2)}%`,
                    } as CSSProperties
                  }
                />
                Действует ещё {secondsLeft} сек.
              </p>
            ) : null}
            {qrSession && secondsLeft === 0 ? (
              <Button
                type="button"
                className="wallet-primary-button"
                disabled={loading}
                onClick={createQr}
              >
                Обновить QR
              </Button>
            ) : null}
            {error ? (
              <>
                <div className="wallet-notice wallet-notice--error">{error}</div>
                <Button
                  type="button"
                  className="wallet-secondary-button"
                  disabled={loading}
                  onClick={createQr}
                >
                  Повторить
                </Button>
              </>
            ) : null}
            <p className="wallet-security-note">
              Сумму вводит сканирующий. Перед подтверждением вы увидите операцию в истории.
            </p>
          </div>
        ) : (
          <div className="wallet-scan-flow">
            <p className="wallet-kicker">Перевести баллы</p>
            <h2 id="qr-title">Сканируйте QR получателя</h2>
            <div
              className={`wallet-scanner-frame${scannedPayload ? ' complete' : ''}${browserScanner ? ' camera' : ''}`}
            >
              {browserScanner ? (
                <video
                  ref={scannerVideoRef}
                  muted
                  playsInline
                  aria-label="Камера для сканирования QR"
                />
              ) : (
                <ScanIcon />
              )}
              <span>
                {scannedPayload
                  ? 'QR распознан'
                  : browserScanner
                    ? 'Наведите камеру на QR'
                    : 'Сканер мессенджера или камера устройства'}
              </span>
            </div>
            <Button
              type="button"
              className="wallet-secondary-button"
              disabled={loading}
              onClick={() => {
                if (browserScanner) stopBrowserScanner();
                else if (error) {
                  setError(null);
                  setBrowserScanner(true);
                } else void startScanner();
              }}
            >
              {browserScanner
                ? 'Остановить камеру'
                : error
                  ? 'Использовать камеру устройства'
                  : 'Открыть сканер'}
            </Button>
            <form onSubmit={requestPreview} className="wallet-transfer-form">
              <label>
                <span>Код из QR</span>
                <input
                  value={scannedPayload}
                  disabled={Boolean(resolvedQr)}
                  onChange={(event) => {
                    setScannedPayload(event.target.value);
                    setResolvedQr(null);
                  }}
                  placeholder="Вставьте код, если камера недоступна"
                  autoComplete="off"
                />
              </label>
              {resolvedQr ? (
                <div className="wallet-resolved-person">
                  <span>
                    {resolvedQr.owner.avatarUrl ? (
                      <img src={resolvedQr.owner.avatarUrl} alt="" />
                    ) : (
                      resolvedQr.owner.displayName.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <div>
                    <small>
                      Владелец QR
                      {resolvedQr.owner.username ? ` · @${resolvedQr.owner.username}` : ''}
                    </small>
                    <strong>{resolvedQr.owner.displayName}</strong>
                  </div>
                </div>
              ) : null}
              {resolvedQr ? (
                <label>
                  <span>Операция</span>
                  <select
                    value={intentKind}
                    onChange={(event) => setIntentKind(event.target.value as WalletIntent['kind'])}
                  >
                    {resolvedQr.capabilities.map((capability) => (
                      <option key={capability} value={capability}>
                        {capability === 'p2p_transfer'
                          ? 'Перевести участнику'
                          : capability === 'staff_credit'
                            ? 'Начислить как сотрудник'
                            : 'Списать как сотрудник'}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {resolvedQr ? (
                <label>
                  <span>Количество</span>
                  <input
                    value={amount}
                    onChange={(event) => setAmount(event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                    placeholder="0"
                  />
                </label>
              ) : null}
              {resolvedQr && intentKind !== 'p2p_transfer' ? (
                <label>
                  <span>Причина *</span>
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={3}
                    placeholder="За что начисляем или списываем"
                  />
                </label>
              ) : null}
              {resolvedQr && intentKind !== 'p2p_transfer' ? (
                <label>
                  <span>Мероприятие, если применимо</span>
                  <select value={eventId} onChange={(event) => setEventId(event.target.value)}>
                    <option value="">Без мероприятия</option>
                    {events.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {error ? <div className="wallet-notice wallet-notice--error">{error}</div> : null}
              <Button type="submit" className="wallet-primary-button" disabled={loading}>
                {loading ? 'Проверяем…' : resolvedQr ? 'Продолжить' : 'Проверить QR'}
              </Button>
            </form>
          </div>
        )}
      </m.section>
    </m.div>
  );
}
export function PendingWalletIntentBanner() {
  const { withUnit, refresh, applyDelta } = useWalletProgram();
  const [intent, setIntent] = useState<WalletIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decisionInFlightRef = useRef(false);
  const decisionAttemptRef = useRef<IdempotencyAttempt | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await api<{
          items: WalletIntent[];
        }>('/wallet/intents/pending');
        if (!cancelled) setIntent(result.items.find((item) => item.kind === 'staff_debit') ?? null);
      } catch {
        // Wallet endpoints may be unavailable during the gradual rollout.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  if (!intent) return null;
  const decide = async (decision: 'confirm' | 'reject') => {
    if (decisionInFlightRef.current) return;
    const currentIntent = intent;
    const fingerprint = `${currentIntent.id}:${decision}`;
    const attempt = resolveIdempotencyAttempt(decisionAttemptRef.current, fingerprint);
    decisionAttemptRef.current = attempt;
    decisionInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await api(`/wallet/intents/${encodeURIComponent(currentIntent.id)}/${decision}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body: JSON.stringify({}),
      });
      decisionAttemptRef.current = null;
      setIntent(null);
      if (decision === 'confirm') {
        applyDelta(`-${currentIntent.amount}`);
        void refresh({ silent: true });
      }
      getMessengerAdapter()?.notify(decision === 'confirm' ? 'success' : 'warning');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось обработать запрос');
    } finally {
      decisionInFlightRef.current = false;
      setBusy(false);
    }
  };
  return (
    <aside className="wallet-intent-banner" aria-live="polite">
      <div>
        <span>Запрос на списание</span>
        <strong>{withUnit(intent.amount)}</strong>
        <p>
          {intent.initiator?.displayName ?? intent.counterparty?.displayName ?? 'Сотрудник'}
          {intent.initiator?.username ? ` · @${intent.initiator.username}` : ''}
          {intent.reason ? ` · ${intent.reason}` : ''}
        </p>
      </div>
      {error ? <small>{error}</small> : null}
      <div className="wallet-intent-actions">
        <button type="button" disabled={busy} onClick={() => decide('reject')}>
          Отклонить
        </button>
        <button type="button" disabled={busy} onClick={() => decide('confirm')}>
          Подтвердить
        </button>
      </div>
    </aside>
  );
}
