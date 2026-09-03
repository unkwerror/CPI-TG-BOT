import { expect, test } from '@playwright/test';
import {
  assertInteractiveAuditClean,
  attachInteractiveAudit,
  auditInteractiveElements,
} from './support/clickability-audit';
import { installCatalystApiMock } from './support/catalyst-api-mock';
import {
  getMessengerBridgeCalls,
  installMessengerMock,
  messengerProviders,
} from './support/messenger-mock';
import type { EventItem } from '../../apps/web/src/lib/types';

const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (browserExecutable) {
  test.use({
    launchOptions: {
      executablePath: browserExecutable,
      args: ['--disable-crash-reporter', '--disable-crashpad'],
    },
  });
}

const leaderIdEvent: EventItem = {
  id: '00000000-0000-4000-8000-000000000606',
  title: 'Catalyst: технологическое предпринимательство',
  slug: 'leader-id-606466',
  shortCode: 'LID-606466',
  description: 'Официальное мероприятие программы Catalyst в Leader-ID.',
  descriptionFormat: 'text',
  cardHtml: null,
  cardPackageId: null,
  organizer: 'Стартап-студия НГУ',
  startsAt: '2026-09-10T03:00:00.000Z',
  endsAt: '2026-09-10T10:00:00.000Z',
  timezone: 'Asia/Novosibirsk',
  venue: 'НГУ',
  city: 'Новосибирск',
  format: 'hybrid',
  status: 'published',
  tags: ['Catalyst', 'Leader-ID'],
  coverUrl: null,
  acceptUploadsFrom: '2026-08-01T00:00:00.000Z',
  acceptUploadsUntil: '2026-12-01T00:00:00.000Z',
  maxFileSizeBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg'],
  blockedExtensions: ['exe'],
  directAccessEnabled: true,
  managedByCrm: false,
  originatedFromCrm: false,
  acceptsUploads: true,
  acceptsRequests: false,
  leaderIdEventId: 606_466,
  leaderIdRegistrationActive: true,
  leaderIdRequiredForSubscription: true,
  leaderIdRegistrationOpen: true,
  leaderIdSortOrder: 10,
  leaderIdRequiresQuestionnaire: false,
};

for (const provider of messengerProviders) {
  test(`${provider}: Projects opens from the wallet and submits one CRM join application`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await installMessengerMock(page, provider);
    const api = await installCatalystApiMock(page, provider);
    await page.goto('/');

    const projectsButton = page.getByRole('button', { name: 'Проекты' }).first();
    await expect(projectsButton).toBeVisible();
    const projectsButtonBox = await projectsButton.boundingBox();
    expect(projectsButtonBox).not.toBeNull();
    expect(projectsButtonBox!.width).toBeGreaterThanOrEqual(44);
    expect(projectsButtonBox!.height).toBeGreaterThanOrEqual(44);
    await projectsButton.click();

    const screen = page.locator('.projects-screen');
    await expect(screen.getByRole('heading', { name: 'Мои проекты' })).toBeVisible();
    await expect(screen.getByText('Умный кампус', { exact: true })).toBeVisible();
    await expect(screen.getByText('Ваша роль:')).toBeVisible();
    await expect(screen.getByText('UX-дизайнер', { exact: true }).first()).toBeVisible();

    const catalogCard = screen.locator('.project-card').filter({ hasText: 'Энергия кампуса' });
    await catalogCard.getByRole('button', { name: 'Вступить в проект' }).click();
    const joinDialog = page.getByRole('dialog', { name: 'Вступить в проект' });
    await expect(joinDialog).toBeVisible();
    await joinDialog.getByLabel('Желаемая роль *').fill('Аналитик');
    await joinDialog.getByLabel('Сообщение руководителю').fill('Готов помочь с пилотом');
    await joinDialog.getByRole('button', { name: 'Отправить заявку' }).click();

    await expect(catalogCard.getByRole('button', { name: 'Заявка отправлена' })).toBeVisible();
    expect(api.state.projectJoinCalls).toBe(1);
    const joinCalls = api.state.calls.filter(
      (call) => call.method === 'POST' && call.path === '/projects/applications',
    );
    expect(joinCalls).toHaveLength(1);
    expect(joinCalls[0]?.body).toMatchObject({
      type: 'JOIN',
      projectId: '00000000-0000-4000-8000-000000000033',
      requestedRole: 'Аналитик',
      message: 'Готов помочь с пилотом',
    });

    const audit = await auditInteractiveElements(screen);
    await attachInteractiveAudit(testInfo, `${provider}-projects.json`, audit);
    assertInteractiveAuditClean(audit);
    expect(pageErrors).toEqual([]);
  });

  test(`${provider}: event explains one-click Leader-ID registration and opens the shared flow`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await installMessengerMock(page, provider, { startParameter: 'tab_events' });
    const api = await installCatalystApiMock(page, provider, { events: [leaderIdEvent] });
    await page.goto('/?tab=events');

    const eventButton = page.getByRole('button', {
      name: /Catalyst: технологическое предпринимательство/u,
    });
    await expect(eventButton).toBeVisible();
    await expect(eventButton.getByText('Регистрация через Leader-ID')).toBeVisible();
    await eventButton.click();

    await expect(
      page.getByRole('heading', { name: 'Catalyst: технологическое предпринимательство' }),
    ).toBeVisible();
    expect(api.state.eventParticipantIds.size).toBe(0);
    expect(api.state.eventParticipateCalls).toBe(0);

    const participationCard = page.locator('.event-participation-card');
    const participateButton = participationCard.getByRole('button', { name: 'Участвовать' });
    await expect(participateButton).toBeVisible();
    await participateButton.dblclick();
    await expect(participationCard.getByText('Вы участвуете', { exact: true })).toBeVisible();
    await expect(
      participationCard.getByRole('button', { name: 'Участие подтверждено' }),
    ).toBeDisabled();
    await expect(
      page.locator('.entity-action-dock').getByRole('button', { name: 'Вы участвуете' }),
    ).toBeDisabled();
    expect(api.state.eventParticipateCalls).toBe(1);
    expect(api.state.eventParticipantIds).toEqual(new Set([leaderIdEvent.id]));
    const participationCalls = api.state.calls.filter(
      (call) => call.method === 'POST' && call.path === `/events/${leaderIdEvent.id}/participate`,
    );
    expect(participationCalls).toHaveLength(1);
    await testInfo.attach(`${provider}-event-participation-confirmed.png`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });

    const registrationGuide = page.locator('.event-registration-guide');
    await expect(registrationGuide.getByText('Регистрация на мероприятие')).toBeVisible();
    await expect(registrationGuide.getByRole('heading', { name: 'Через Leader-ID' })).toBeVisible();
    await expect(registrationGuide.getByText(/открывать каждое отдельно не нужно/u)).toBeVisible();
    await testInfo.attach(`${provider}-event-registration-guide.png`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    const registrationButton = registrationGuide.getByRole('button', {
      name: 'Перейти к регистрации',
    });
    const beforeScrollY = await page.evaluate(() => window.scrollY);
    await page.mouse.move(195, 520);
    await page.mouse.wheel(0, 620);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScrollY);
    await registrationButton.evaluate((button) =>
      button.scrollIntoView({ behavior: 'auto', block: 'center' }),
    );
    await expect(registrationButton).toBeVisible();

    const [buttonBox, inlineActionBox, dockBox] = await Promise.all([
      registrationButton.boundingBox(),
      page.locator('.event-action-inline').boundingBox(),
      page.locator('.entity-action-dock--event').boundingBox(),
    ]);
    expect(buttonBox).not.toBeNull();
    expect(inlineActionBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    expect(buttonBox!.width).toBeGreaterThanOrEqual(44);
    expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
    for (const actionBox of [inlineActionBox!, dockBox!]) {
      const overlaps =
        buttonBox!.x < actionBox.x + actionBox.width &&
        buttonBox!.x + buttonBox!.width > actionBox.x &&
        buttonBox!.y < actionBox.y + actionBox.height &&
        buttonBox!.y + buttonBox!.height > actionBox.y;
      expect(overlaps).toBe(false);
    }
    await registrationButton.click({ trial: true });
    await registrationButton.click();

    const leaderIdAnchor = page.locator('#leader-id-catalyst');
    await expect(leaderIdAnchor).toBeFocused();
    await expect(page.getByRole('region', { name: 'Leader-ID + Catalyst' })).toBeVisible();
    expect(
      api.state.calls.filter(
        (call) => call.method === 'POST' && call.path === '/catalyst/leader-id/subscribe',
      ),
    ).toHaveLength(0);

    const audit = await auditInteractiveElements(
      page.getByRole('region', {
        name: 'Leader-ID + Catalyst',
      }),
    );
    await attachInteractiveAudit(testInfo, `${provider}-event-registration-target.json`, audit);
    assertInteractiveAuditClean(audit);
    expect(pageErrors).toEqual([]);
  });

  test(`${provider}: Leader-ID validation, network recovery, questionnaire, and persisted reward`, async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await installMessengerMock(page, provider);
    const api = await installCatalystApiMock(page, provider, {
      leaderId: '123456',
      rewardPoints: '375',
      bindResponseLossOnce: true,
      subscribePartialOnce: true,
    });

    await page.goto('/');

    await expect
      .poll(
        () =>
          api.state.calls.filter(
            (call) => call.method === 'POST' && call.path === `/auth/${provider}`,
          ).length,
      )
      .toBe(1);
    const authCall = api.state.calls.find(
      (call) => call.method === 'POST' && call.path === `/auth/${provider}`,
    );
    expect(authCall?.body).toEqual({ initData: `${provider}-signed-e2e-init-data` });
    expect(
      api.state.calls.some(
        (call) => call.path === `/auth/${provider === 'telegram' ? 'max' : 'telegram'}`,
      ),
    ).toBe(false);
    const initializeMethod =
      provider === 'telegram' ? 'Telegram.WebApp.ready' : 'WebApp.getViewportSize';
    await expect
      .poll(
        async () =>
          (await getMessengerBridgeCalls(page)).filter((call) => call.method === initializeMethod)
            .length,
      )
      .toBe(1);

    await expect(page.getByText('Мои баллы', { exact: true }).first()).toBeVisible();
    const card = page.getByRole('region', { name: 'Leader-ID + Catalyst' });
    await expect(card).toBeVisible();
    await expect(page.getByText('После подключения доступна награда: +375')).toBeVisible();

    const initialAudit = await auditInteractiveElements(card);
    await attachInteractiveAudit(testInfo, `${provider}-leader-id-initial.json`, initialAudit);
    assertInteractiveAuditClean(initialAudit);

    const nativeOpenMethod =
      provider === 'telegram' ? 'Telegram.WebApp.openLink' : 'WebApp.openLink';
    await card.getByRole('button', { name: 'Зарегистрироваться в Leader-ID' }).click();
    await expect
      .poll(
        async () =>
          (await getMessengerBridgeCalls(page)).filter(
            (call) =>
              call.method === nativeOpenMethod &&
              call.args[0] === 'https://leader-id.ru/registration',
          ).length,
      )
      .toBe(1);

    const leaderIdInput = card.getByLabel('Leader-ID');
    const confirmButton = card.getByRole('button', { name: 'Подтвердить' });

    await confirmButton.click();
    await expect(card.getByRole('alert')).toHaveText('Введите Leader-ID.');
    await expect(leaderIdInput).toHaveAttribute('aria-invalid', 'true');
    expect(api.state.bindCalls).toBe(0);

    await leaderIdInput.fill('12x345');
    await confirmButton.click();
    await expect(card.getByRole('alert')).toHaveText(
      'Проверьте Leader-ID: нужны только цифры без пробелов и ссылок.',
    );
    expect(api.state.bindCalls).toBe(0);

    await leaderIdInput.fill('654321');
    await confirmButton.click();
    await expect(card.getByRole('alert')).toHaveText(
      'Такой Leader-ID не найден. Проверьте номер и попробуйте снова.',
    );
    expect(api.state.bindCalls).toBe(1);

    await leaderIdInput.fill(api.state.leaderId);
    await confirmButton.click();
    await expect(card.getByRole('alert')).toHaveText(
      'Не удалось связаться с сервером. Проверьте интернет и повторите попытку.',
    );
    expect(api.state.bindCalls).toBe(2);

    await confirmButton.click();

    await expect
      .poll(
        async () =>
          (await getMessengerBridgeCalls(page)).filter(
            (call) =>
              call.method === nativeOpenMethod &&
              typeof call.args[0] === 'string' &&
              call.args[0].startsWith('https://leader-id.ru/apps/authorize'),
          ).length,
      )
      .toBe(1);
    expect(api.state.bindCalls).toBe(3);
    const bindCalls = api.state.calls.filter(
      (call) => call.method === 'POST' && call.path === '/catalyst/leader-id/bind',
    );
    expect(bindCalls).toHaveLength(3);
    expect(bindCalls[0]?.body).toEqual({ leaderId: '654321' });
    expect(bindCalls[1]?.idempotencyKey).toBeTruthy();
    expect(bindCalls[2]?.idempotencyKey).toBe(bindCalls[1]?.idempotencyKey);

    const bridgeCalls = await getMessengerBridgeCalls(page);
    expect(bridgeCalls.some((call) => call.method === 'browser.open')).toBe(false);
    expect(
      bridgeCalls.find(
        (call) =>
          call.method === nativeOpenMethod &&
          typeof call.args[0] === 'string' &&
          call.args[0].startsWith('https://leader-id.ru/apps/authorize'),
      )?.args[0],
    ).toMatch(/^https:\/\/leader-id\.ru\/apps\/authorize/u);

    api.completeLeaderIdOAuth();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(card.getByText('Leader-ID подключён')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Подключиться и получить +375' })).toBeVisible();

    const beforeSubscribeAudit = await auditInteractiveElements(card);
    await attachInteractiveAudit(
      testInfo,
      `${provider}-leader-id-before-subscribe.json`,
      beforeSubscribeAudit,
    );
    assertInteractiveAuditClean(beforeSubscribeAudit);

    await card.getByRole('button', { name: 'Подключиться и получить +375' }).click();
    await expect(card.getByText('Catalyst подключён частично', { exact: true })).toBeVisible();
    await expect(card.getByText('+375 начислено')).toHaveCount(0);
    expect(api.state.subscribeCalls).toBe(1);

    await card.getByText('Результаты по мероприятиям', { exact: true }).click();
    await expect(card.getByText('Нужна анкета Leader-ID', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Заполнить анкету в Leader-ID' }).click();
    await expect
      .poll(
        async () =>
          (await getMessengerBridgeCalls(page)).filter(
            (call) =>
              call.method === nativeOpenMethod &&
              call.args[0] === 'https://leader-id.ru/events/900002',
          ).length,
      )
      .toBe(1);
    const questionnaireLinkCall = (await getMessengerBridgeCalls(page)).find(
      (call) =>
        call.method === nativeOpenMethod && call.args[0] === 'https://leader-id.ru/events/900002',
    );
    expect(questionnaireLinkCall).toBeTruthy();

    await card.getByRole('button', { name: 'Повторить для оставшихся' }).click();
    await expect(card.getByText('Catalyst подключён', { exact: true })).toBeVisible();
    await expect(card.getByText('+375 начислено')).toBeVisible();
    expect(api.state.subscribeCalls).toBe(2);
    const subscribeCalls = api.state.calls.filter(
      (call) => call.method === 'POST' && call.path === '/catalyst/leader-id/subscribe',
    );
    expect(subscribeCalls).toHaveLength(2);
    expect(subscribeCalls.every((call) => Boolean(call.idempotencyKey))).toBe(true);

    await page.reload();
    const reloadedCard = page.getByRole('region', { name: 'Leader-ID + Catalyst' });
    await expect(reloadedCard.getByText('Catalyst подключён', { exact: true })).toBeVisible();
    await expect(reloadedCard.getByText('+375 начислено')).toBeVisible();
    await expect(reloadedCard.getByRole('button', { name: /Подключиться.*получить/u })).toHaveCount(
      0,
    );
    expect(api.state.subscribeCalls).toBe(2);
    expect(api.state.statusCalls).toBeGreaterThanOrEqual(3);
    expect(pageErrors).toEqual([]);
  });

  test(`${provider}: narrow-mobile ZIP product CTA crosses the validated package bridge once`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await installMessengerMock(page, provider, { startParameter: 'tab_store' });
    const api = await installCatalystApiMock(page, provider, { checkoutResponseLossOnce: true });
    await page.goto('/?tab=store');

    await expect(page.getByRole('heading', { name: 'Магазин' })).toBeVisible();
    await page.getByRole('button', { name: 'Открыть товар «ZIP E2E худи»' }).click();

    const dialog = page.getByRole('dialog', { name: 'ZIP E2E худи' });
    await expect(dialog).toBeVisible();
    const frame = dialog.frameLocator(`iframe[title="Оформление товара: ZIP E2E худи"]`);
    const packageCta = frame.getByRole('button', { name: 'Выбрать размер L' });
    await expect(packageCta).toBeVisible();
    await expect(frame.locator('html')).toHaveAttribute('data-cpi-e2e-bridge', 'ready');
    await expect
      .poll(
        async () =>
          (await frame.locator('html').getAttribute('data-cpi-e2e-render')) ===
          String(api.state.packageRenderCalls),
      )
      .toBe(true);

    const ctaBox = await packageCta.boundingBox();
    expect(ctaBox).not.toBeNull();
    expect(ctaBox!.width).toBeGreaterThanOrEqual(44);
    expect(ctaBox!.height).toBeGreaterThanOrEqual(44);
    await packageCta.click({ trial: true });
    await packageCta.click();

    await expect
      .poll(
        async () =>
          (await getMessengerBridgeCalls(page)).filter(
            (call) =>
              call.method === 'window.message' &&
              (call.args[0] as { type?: unknown } | undefined)?.type === 'cpi-card-action',
          ).length,
      )
      .toBe(2);

    await expect.poll(() => api.state.checkoutCalls).toBe(1);
    await expect(page.getByText('Failed to fetch')).toBeVisible();

    // A single ZIP click emits the action twice, yet only one request starts.
    // Retrying after an ambiguous response loss must reuse the same key.
    await packageCta.click();

    await expect(page.getByText('Оплата прошла. Оставьте заявку на выдачу ниже.')).toBeVisible();
    await expect(
      page.getByText(/Параметры из ZIP-карточки:\s*Размер: L\s*Цвет: тёмный/u).first(),
    ).toBeVisible();
    expect(api.state.checkoutCalls).toBe(2);
    expect(api.state.packageRenderCalls).toBeGreaterThanOrEqual(1);

    const checkouts = api.state.calls.filter(
      (call) => call.method === 'POST' && call.path === '/store/checkout',
    );
    const checkout = checkouts[1];
    expect(checkout?.idempotencyKey).toBeTruthy();
    expect(checkouts[0]?.idempotencyKey).toBe(checkout?.idempotencyKey);
    expect(checkout?.body).toMatchObject({
      items: [{ productId: '00000000-0000-4000-8000-000000000020', quantity: 1 }],
    });
    expect((checkout?.body as { comment?: string } | undefined)?.comment).toContain('Размер: L');
    expect((checkout?.body as { comment?: string } | undefined)?.comment).toContain('Цвет: тёмный');

    const audit = await auditInteractiveElements(page);
    await attachInteractiveAudit(testInfo, `${provider}-zip-after-checkout.json`, audit);
    expect(pageErrors).toEqual([]);
  });
}
