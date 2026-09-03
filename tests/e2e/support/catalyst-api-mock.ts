import type { Page, Route } from '@playwright/test';
import type { EventItem } from '../../../apps/web/src/lib/types';
import type { MessengerProvider } from './messenger-mock';

export interface MockApiCall {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | null;
}

export interface CatalystApiMockState {
  readonly provider: MessengerProvider;
  readonly calls: MockApiCall[];
  readonly leaderId: string;
  readonly rewardPoints: string;
  linked: boolean;
  subscribed: boolean;
  subscriptionPartial: boolean;
  bindCalls: number;
  bindResponseLossesRemaining: number;
  subscribeCalls: number;
  subscribePartialResponsesRemaining: number;
  statusCalls: number;
  checkoutCalls: number;
  checkoutResponseLossesRemaining: number;
  packageRenderCalls: number;
  eventParticipateCalls: number;
  readonly eventParticipantIds: Set<string>;
  projectJoinCalls: number;
  projectApplicationSubmitted: boolean;
  readonly packageId: string;
}

export interface CatalystApiMockController {
  state: CatalystApiMockState;
  completeLeaderIdOAuth(): void;
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function leaderIdResults() {
  return [
    {
      catalystEventId: 'catalyst-e2e-one',
      leaderIdEventId: 900_001,
      title: 'Catalyst E2E — открытие',
      requiredForSubscription: true,
      status: 'REGISTERED',
      retryable: false,
    },
    {
      catalystEventId: 'catalyst-e2e-two',
      leaderIdEventId: 900_002,
      title: 'Catalyst E2E — практика',
      requiredForSubscription: true,
      status: 'ALREADY_REGISTERED',
      retryable: false,
    },
  ];
}

function leaderIdPartialResults() {
  return [
    {
      catalystEventId: 'catalyst-e2e-one',
      leaderIdEventId: 900_001,
      title: 'Catalyst E2E — открытие',
      requiredForSubscription: true,
      status: 'REGISTERED',
      retryable: false,
    },
    {
      catalystEventId: 'catalyst-e2e-two',
      leaderIdEventId: 900_002,
      title: 'Catalyst E2E — практика',
      requiredForSubscription: true,
      status: 'QUESTIONNAIRE_REQUIRED',
      retryable: true,
    },
  ];
}

function leaderIdStatus(state: CatalystApiMockState) {
  const completed = state.linked && state.subscribed;
  const partial = state.linked && state.subscriptionPartial && !completed;
  return {
    linked: state.linked,
    ...(state.linked ? { leaderIdUserId: Number(state.leaderId) } : {}),
    totalEvents: 2,
    confirmedEvents: completed ? 2 : partial ? 1 : 0,
    submittedEvents: completed ? 2 : partial ? 1 : 0,
    failedEvents: partial ? 1 : 0,
    subscriptionComplete: completed,
    partial,
    results: completed ? leaderIdResults() : partial ? leaderIdPartialResults() : [],
    reward: {
      configured: true,
      points: state.rewardPoints,
      awarded: completed,
    },
  };
}

function currentUser(provider: MessengerProvider) {
  return {
    id: `00000000-0000-4000-8000-0000000000${provider === 'telegram' ? '01' : '02'}`,
    telegramUserId: provider === 'telegram' ? '700001' : null,
    messengerProvider: provider,
    messengerUserId: provider === 'telegram' ? '700001' : '800001',
    telegramUsername: provider === 'telegram' ? 'catalyst_e2e' : null,
    fullName: 'Тестовый Пользователь Catalyst',
    organization: 'НГУ',
    position: 'Участник',
    phone: '+70000000000',
    crmPersonId: '00000000-0000-4000-8000-000000000032',
    consentAt: '2026-08-28T00:00:00.000Z',
    roles: ['participant'],
    profileComplete: true,
  };
}

function authResponse(provider: MessengerProvider) {
  const user = currentUser(provider);
  return {
    user: {
      id: user.id,
      telegramUserId: user.telegramUserId,
      messengerProvider: user.messengerProvider,
      messengerUserId: user.messengerUserId,
      fullName: user.fullName,
      roles: user.roles,
      profileComplete: user.profileComplete,
    },
    csrfToken: `csrf-${provider}-e2e`,
    sessionToken: `session-${provider}-e2e`,
  };
}

function walletSummary() {
  return {
    program: {
      id: '00000000-0000-4000-8000-000000000010',
      code: 'CATALYST',
      walletTitle: 'Мои баллы',
      unitOne: 'балл',
      unitFew: 'балла',
      unitMany: 'баллов',
      symbol: null,
      iconUrl: null,
      p2pEnabled: true,
      storeEnabled: true,
      maxTransactionAmount: '100000',
    },
    season: { id: '00000000-0000-4000-8000-000000000011', code: 'E2E', title: 'Catalyst' },
    account: { id: '00000000-0000-4000-8000-000000000012', balance: '1000', status: 'active' },
  };
}

function projectContext(state: CatalystApiMockState) {
  const mine = {
    id: '00000000-0000-4000-8000-000000000030',
    name: 'Умный кампус',
    description: 'Цифровые сервисы для студентов НГУ.',
    status: 'ACTIVE',
    visibleInBot: true,
    leadPersonId: '00000000-0000-4000-8000-000000000031',
    leadPersonName: 'Анна Руководитель',
    membershipRole: 'UX-дизайнер',
    isLead: false,
    memberCount: 2,
    members: [
      {
        personId: '00000000-0000-4000-8000-000000000031',
        name: 'Анна Руководитель',
        role: 'Владелец проекта',
        isLead: true,
      },
      {
        personId: '00000000-0000-4000-8000-000000000032',
        name: 'Тестовый Пользователь Catalyst',
        role: 'UX-дизайнер',
        isLead: false,
      },
    ],
    pendingJoinApplicationId: null,
  } as const;
  const catalog = {
    id: '00000000-0000-4000-8000-000000000033',
    name: 'Энергия кампуса',
    description: 'Команда ищет аналитика для пилота.',
    status: 'IDEA',
    visibleInBot: true,
    leadPersonId: '00000000-0000-4000-8000-000000000034',
    leadPersonName: 'Илья Инициатор',
    membershipRole: null,
    isLead: false,
    memberCount: 1,
    members: [
      {
        personId: '00000000-0000-4000-8000-000000000034',
        name: 'Илья Инициатор',
        role: 'Инициатор',
        isLead: true,
      },
    ],
    pendingJoinApplicationId: state.projectApplicationSubmitted
      ? '00000000-0000-4000-8000-000000000035'
      : null,
  } as const;
  return {
    schemaVersion: 1,
    personId: '00000000-0000-4000-8000-000000000032',
    catalog: [catalog],
    mine: [mine],
    applications: state.projectApplicationSubmitted
      ? [
          {
            id: '00000000-0000-4000-8000-000000000035',
            type: 'JOIN',
            status: 'PENDING',
            applicantPersonId: '00000000-0000-4000-8000-000000000032',
            applicantName: 'Тестовый Пользователь Catalyst',
            projectId: catalog.id,
            projectName: catalog.name,
            proposedName: null,
            proposedDescription: null,
            requestedRole: 'Аналитик',
            message: 'Готов помочь с пилотом',
            reviewComment: null,
            reviewedAt: null,
            reviewedByName: null,
            createdProjectId: null,
            createdProjectName: null,
            createdAt: '2026-08-28T00:00:00.000Z',
            updatedAt: '2026-08-28T00:00:00.000Z',
          },
        ]
      : [],
    incomingApplications: [],
  };
}

function packageProduct(state: CatalystApiMockState) {
  return {
    id: '00000000-0000-4000-8000-000000000020',
    slug: 'zip-e2e-hoodie',
    title: 'ZIP E2E худи',
    description: 'Товар с интерактивным ZIP-оформлением.',
    descriptionFormat: 'text',
    cardHtml: null,
    cardPackageId: state.packageId,
    category: {
      id: '00000000-0000-4000-8000-000000000021',
      slug: 'merch',
      title: 'Мерч',
    },
    kind: 'physical',
    price: '250',
    stockMode: 'unlimited',
    available: null,
    perUserLimit: 1,
    pickupInstructions: 'Покажите заявку координатору Catalyst.',
    coverUrl: null,
    imageUrl: null,
    media: [],
    status: 'published',
  };
}

function packageDocument(packageId: string, renderRevision: number) {
  const serializedPackageId = JSON.stringify(packageId).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      html,body{margin:0;min-height:100%;background:#15181b;color:#fff;font-family:Arial,sans-serif}
      main{padding:24px;display:grid;gap:18px}
      button{min-width:180px;min-height:52px;border:0;border-radius:16px;background:#c8ff37;color:#101214;font:700 16px Arial,sans-serif}
    </style>
  </head>
  <body>
    <main>
      <h1>ZIP E2E худи</h1>
      <button
        id="package-cta"
        type="button"
        onclick="parent.postMessage({type:'cpi-card-action',packageId:${serializedPackageId.replaceAll('"', '&quot;')},fields:{size:'L',color:'dark'}},'*');parent.postMessage({type:'cpi-card-action',packageId:${serializedPackageId.replaceAll('"', '&quot;')},fields:{size:'L',color:'dark'}},'*')"
      >Выбрать размер L</button>
    </main>
    <script>
      const packageId = ${serializedPackageId};
      document.documentElement.dataset.cpiE2eBridge = 'ready';
      document.documentElement.dataset.cpiE2eRender = ${JSON.stringify(String(renderRevision))};
      parent.postMessage({type:'cpi-card-height',packageId,height:document.documentElement.scrollHeight},'*');
    </script>
  </body>
</html>`;
}

async function requestBody(route: Route): Promise<unknown> {
  const raw = route.request().postData();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function installCatalystApiMock(
  page: Page,
  provider: MessengerProvider,
  options: {
    leaderId?: string;
    rewardPoints?: string;
    bindResponseLossOnce?: boolean;
    subscribePartialOnce?: boolean;
    checkoutResponseLossOnce?: boolean;
    events?: EventItem[];
  } = {},
): Promise<CatalystApiMockController> {
  const state: CatalystApiMockState = {
    provider,
    calls: [],
    leaderId: options.leaderId ?? '123456',
    rewardPoints: options.rewardPoints ?? '375',
    linked: false,
    subscribed: false,
    subscriptionPartial: false,
    bindCalls: 0,
    bindResponseLossesRemaining: options.bindResponseLossOnce ? 1 : 0,
    subscribeCalls: 0,
    subscribePartialResponsesRemaining: options.subscribePartialOnce ? 1 : 0,
    statusCalls: 0,
    checkoutCalls: 0,
    checkoutResponseLossesRemaining: options.checkoutResponseLossOnce ? 1 : 0,
    packageRenderCalls: 0,
    eventParticipateCalls: 0,
    eventParticipantIds: new Set(
      (options.events ?? []).filter((event) => event.isParticipant).map((event) => event.id),
    ),
    projectJoinCalls: 0,
    projectApplicationSubmitted: false,
    packageId: '00000000-0000-4000-8000-000000000099',
  };

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/u, '') + url.search;
    const method = request.method();
    const body = await requestBody(route);
    state.calls.push({
      method,
      path,
      body,
      idempotencyKey: request.headers()['idempotency-key'] ?? null,
    });

    if (method === 'POST' && path === `/auth/${provider}`) {
      return json(route, authResponse(provider));
    }
    if (path.startsWith('/auth/')) {
      return json(
        route,
        { error: { code: 'E2E_WRONG_AUTH_PROVIDER', message: 'Wrong mock auth provider' } },
        401,
      );
    }
    if (method === 'GET' && path === '/me') return json(route, currentUser(provider));
    if (method === 'GET' && path === '/wallet') return json(route, walletSummary());
    if (method === 'GET' && path === '/projects') return json(route, projectContext(state));
    if (method === 'POST' && path === '/projects/applications') {
      state.projectJoinCalls += 1;
      state.projectApplicationSubmitted = true;
      return json(
        route,
        {
          id: '00000000-0000-4000-8000-000000000035',
          status: 'PENDING',
        },
        201,
      );
    }
    if (method === 'GET' && path.startsWith('/events?')) {
      return json(route, {
        items: (options.events ?? []).map((event) => ({
          ...event,
          isParticipant: state.eventParticipantIds.has(event.id),
        })),
      });
    }
    if (method === 'GET' && /^\/events\/[^/?]+\/submissions(?:\?|$)/u.test(path)) {
      return json(route, { items: [] });
    }
    const participationMatch = path.match(/^\/events\/([^/?]+)\/participate$/u);
    if (method === 'POST' && participationMatch) {
      state.eventParticipateCalls += 1;
      const eventId = decodeURIComponent(participationMatch[1]!);
      const joined = !state.eventParticipantIds.has(eventId);
      state.eventParticipantIds.add(eventId);
      return json(route, { joined, isParticipant: true });
    }
    const eventMatch = path.match(/^\/events\/([^/?]+)$/u);
    if (method === 'GET' && eventMatch) {
      const eventKey = decodeURIComponent(eventMatch[1]!);
      const event = (options.events ?? []).find(
        (candidate) =>
          candidate.id === eventKey ||
          candidate.slug === eventKey.toLowerCase() ||
          candidate.shortCode === eventKey.toUpperCase(),
      );
      if (!event) {
        return json(
          route,
          { error: { code: 'EVENT_NOT_FOUND', message: 'E2E event not found' } },
          404,
        );
      }
      return json(route, {
        ...event,
        isParticipant: state.eventParticipantIds.has(event.id),
      });
    }
    if (method === 'GET' && path.startsWith('/feed?')) return json(route, { items: [] });
    if (method === 'GET' && path === '/store/products?limit=50') {
      return json(route, { items: [packageProduct(state)], nextCursor: null });
    }
    if (method === 'GET' && path === '/store/orders?limit=50') {
      return json(route, { items: [], nextCursor: null });
    }
    if (
      method === 'GET' &&
      path.startsWith(`/card-packages/${encodeURIComponent(state.packageId)}/render?`)
    ) {
      state.packageRenderCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: packageDocument(state.packageId, state.packageRenderCalls),
      });
    }
    if (method === 'POST' && path === '/store/checkout') {
      state.checkoutCalls += 1;
      if (state.checkoutResponseLossesRemaining > 0) {
        state.checkoutResponseLossesRemaining -= 1;
        return route.abort('failed');
      }
      return json(route, {
        id: '00000000-0000-4000-8000-000000000022',
        productId: '00000000-0000-4000-8000-000000000020',
        productTitle: 'ZIP E2E худи',
        amount: '250',
        totalPoints: '250',
        status: 'paid',
        createdAt: '2026-08-28T00:00:00.000Z',
        comment:
          body && typeof body === 'object' && 'comment' in body
            ? String((body as { comment: unknown }).comment)
            : null,
      });
    }
    if (method === 'GET' && path === '/wallet/intents/pending') {
      return json(route, { items: [] });
    }
    if (method === 'GET' && path === '/catalyst/leader-id/status') {
      state.statusCalls += 1;
      return json(route, leaderIdStatus(state));
    }
    if (method === 'POST' && path === '/catalyst/leader-id/bind') {
      state.bindCalls += 1;
      const submittedLeaderId =
        body && typeof body === 'object' && 'leaderId' in body
          ? String((body as { leaderId: unknown }).leaderId)
          : '';
      if (submittedLeaderId !== state.leaderId) {
        return json(
          route,
          { error: { code: 'LEADER_ID_NOT_FOUND', message: 'E2E Leader-ID not found' } },
          404,
        );
      }
      if (state.bindResponseLossesRemaining > 0) {
        state.bindResponseLossesRemaining -= 1;
        return route.abort('failed');
      }
      return json(route, {
        authorizationUrl:
          'https://leader-id.ru/apps/authorize?client_id=catalyst-e2e&state=e2e-state',
      });
    }
    if (method === 'POST' && path === '/catalyst/leader-id/subscribe') {
      state.subscribeCalls += 1;
      if (!state.linked) {
        return json(
          route,
          { error: { code: 'LEADER_ID_NOT_LINKED', message: 'E2E identity is not linked' } },
          409,
        );
      }
      if (state.subscribePartialResponsesRemaining > 0) {
        state.subscribePartialResponsesRemaining -= 1;
        state.subscriptionPartial = true;
        return json(route, {
          ...leaderIdStatus(state),
          linked: true,
          leaderIdUserId: Number(state.leaderId),
          reward: {
            configured: true,
            points: state.rewardPoints,
            awarded: false,
            replayed: false,
          },
        });
      }
      state.subscriptionPartial = false;
      state.subscribed = true;
      return json(route, {
        ...leaderIdStatus(state),
        linked: true,
        leaderIdUserId: Number(state.leaderId),
        reward: {
          configured: true,
          points: state.rewardPoints,
          awarded: true,
          replayed: false,
        },
      });
    }

    return json(
      route,
      { error: { code: 'E2E_UNMOCKED_API', message: `No E2E mock for ${method} ${path}` } },
      501,
    );
  });

  return {
    state,
    completeLeaderIdOAuth() {
      state.linked = true;
    },
  };
}
