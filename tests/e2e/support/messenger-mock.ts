import type { Page } from '@playwright/test';

export const messengerProviders = ['telegram', 'max'] as const;

export type MessengerProvider = (typeof messengerProviders)[number];

export interface MessengerBridgeCall {
  method: string;
  args: unknown[];
  timestamp: number;
}

export interface MessengerMockOptions {
  initData?: string;
  startParameter?: string;
}

const BRIDGE_CALLS_KEY = '__CATALYST_E2E_BRIDGE_CALLS__';

/**
 * Installs development-free Telegram/MAX browser contracts before application code runs.
 * Official SDK scripts are replaced with empty responses so they cannot overwrite the mock.
 */
export async function installMessengerMock(
  page: Page,
  provider: MessengerProvider,
  options: MessengerMockOptions = {},
): Promise<void> {
  await page.route('https://telegram.org/js/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.route('https://st.max.ru/js/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );

  const callsKey = JSON.stringify(BRIDGE_CALLS_KEY);
  const initData = JSON.stringify(options.initData ?? `${provider}-signed-e2e-init-data`);
  const platform = JSON.stringify(provider);
  const startParameter = JSON.stringify(options.startParameter ?? 'tab_home');
  // Use source text rather than a serialized TypeScript callback. Some test
  // transpilers inject an out-of-scope `__name` helper into nested functions.
  await page.addInitScript({
    content: `(() => {
      const callsKey = ${callsKey};
      const initData = ${initData};
      const platform = ${platform};
      const startParameter = ${startParameter};
      const calls = [];
      function record(method) {
        calls.push({
          method,
          args: Array.prototype.slice.call(arguments, 1),
          timestamp: Date.now(),
        });
      }
      Object.defineProperty(window, callsKey, { configurable: true, value: calls });
      Object.defineProperty(window, 'open', {
        configurable: true,
        value: function (url, target, features) {
          record('browser.open', String(url || ''), target, features);
          return window;
        },
      });
      window.addEventListener('message', function (event) {
        const payload = event.data;
        if (payload && payload.type && String(payload.type).startsWith('cpi-card-')) {
          record('window.message', payload);
        }
      });
      const hapticFeedback = {
        notificationOccurred: function (type) {
          record(platform + '.HapticFeedback.notificationOccurred', type);
        },
      };
      if (platform === 'telegram') {
        delete window.WebApp;
        window.Telegram = {
          WebApp: {
            initData,
            initDataUnsafe: { start_param: startParameter },
            colorScheme: 'dark',
            ready: function () { record('Telegram.WebApp.ready'); },
            expand: function () { record('Telegram.WebApp.expand'); },
            close: function () { record('Telegram.WebApp.close'); },
            setHeaderColor: function (color) { record('Telegram.WebApp.setHeaderColor', color); },
            setBackgroundColor: function (color) { record('Telegram.WebApp.setBackgroundColor', color); },
            setBottomBarColor: function (color) { record('Telegram.WebApp.setBottomBarColor', color); },
            openLink: function (url) { record('Telegram.WebApp.openLink', url); },
            openTelegramLink: function (url) { record('Telegram.WebApp.openTelegramLink', url); },
            requestContact: function (callback) {
              record('Telegram.WebApp.requestContact');
              if (typeof callback === 'function') callback(true);
            },
            showScanQrPopup: function (parameters, callback) {
              record('Telegram.WebApp.showScanQrPopup', parameters);
              if (typeof callback === 'function') callback('e2e-qr');
            },
            closeScanQrPopup: function () { record('Telegram.WebApp.closeScanQrPopup'); },
            isVerticalSwipesEnabled: true,
            disableVerticalSwipes: function () { record('Telegram.WebApp.disableVerticalSwipes'); },
            enableVerticalSwipes: function () { record('Telegram.WebApp.enableVerticalSwipes'); },
            enableClosingConfirmation: function () { record('Telegram.WebApp.enableClosingConfirmation'); },
            disableClosingConfirmation: function () { record('Telegram.WebApp.disableClosingConfirmation'); },
            HapticFeedback: hapticFeedback,
          },
        };
        return;
      }
      delete window.Telegram;
      window.WebApp = {
        initData,
        initDataUnsafe: { start_param: startParameter },
        platform: 'android',
        version: '1.0',
        deviceName: 'Playwright MAX mock',
        getViewportSize: async function () {
          record('WebApp.getViewportSize');
          return { height: String(window.innerHeight), width: String(window.innerWidth) };
        },
        openLink: function (url) { record('WebApp.openLink', url); },
        openMaxLink: function (url) { record('WebApp.openMaxLink', url); },
        downloadFile: function (url, fileName) { record('WebApp.downloadFile', url, fileName); },
        enableClosingConfirmation: function () { record('WebApp.enableClosingConfirmation'); },
        disableClosingConfirmation: function () { record('WebApp.disableClosingConfirmation'); },
        requestContact: async function () {
          record('WebApp.requestContact');
          return { phone: '+70000000000', authDate: '2026-08-28T00:00:00Z', hash: 'e2e' };
        },
        openCodeReader: async function (fileSelect) {
          record('WebApp.openCodeReader', fileSelect);
          return 'e2e-qr';
        },
        BackButton: {
          isVisible: false,
          show: function () { record('WebApp.BackButton.show'); },
          hide: function () { record('WebApp.BackButton.hide'); },
          onClick: function () { record('WebApp.BackButton.onClick'); },
          offClick: function () { record('WebApp.BackButton.offClick'); },
        },
        HapticFeedback: hapticFeedback,
      };
    })();`,
  });
}

export async function getMessengerBridgeCalls(page: Page): Promise<MessengerBridgeCall[]> {
  return page.evaluate(
    (callsKey) =>
      ((window as unknown as Record<string, unknown>)[callsKey] as
        MessengerBridgeCall[] | undefined) ?? [],
    BRIDGE_CALLS_KEY,
  );
}
