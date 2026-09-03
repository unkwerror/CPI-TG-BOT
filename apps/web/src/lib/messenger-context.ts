import { getMaxInitData } from './max-context';
import { getTelegramInitData } from './telegram-context';

export type MessengerProvider = 'telegram' | 'max';

export interface MessengerLaunchData {
  provider: MessengerProvider;
  initData: string;
}

export function getMessengerLaunchData(): MessengerLaunchData | null {
  const max = getMaxInitData();
  if (max) return { provider: 'max', initData: max };
  const telegram = getTelegramInitData();
  return telegram ? { provider: 'telegram', initData: telegram } : null;
}

export async function waitForMessengerLaunchData(
  timeoutMs = 3_000,
): Promise<MessengerLaunchData | null> {
  const immediate = getMessengerLaunchData();
  if (immediate) return immediate;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const launch = getMessengerLaunchData();
    if (launch) return launch;
  }
  return null;
}
