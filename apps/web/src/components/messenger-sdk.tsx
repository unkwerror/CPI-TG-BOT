'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';
import { initializeMessengerSafely } from '../lib/messenger-adapter';
import { waitForMessengerLaunchData, type MessengerProvider } from '../lib/messenger-context';

const SDK_URLS: Record<MessengerProvider, string> = {
  telegram: 'https://telegram.org/js/telegram-web-app.js?63',
  max: 'https://st.max.ru/js/max-web-app.js',
};

/** Signed launch data comes from the URL/storage; an optional SDK must not gate login. */
export function MessengerSdk() {
  const [provider, setProvider] = useState<MessengerProvider | null>(null);
  useEffect(() => {
    let disposed = false;
    void waitForMessengerLaunchData().then((launch) => {
      if (!disposed && launch) setProvider(launch.provider);
    });
    return () => {
      disposed = true;
    };
  }, []);

  if (!provider) return null;
  return (
    <Script
      id={`messenger-sdk-${provider}`}
      src={SDK_URLS[provider]}
      strategy="afterInteractive"
      onReady={() => initializeMessengerSafely(provider)}
    />
  );
}
