import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import type { ReactNode } from 'react';
import './globals.css';
import './studio.css';

export const metadata: Metadata = {
  title: 'Мои баллы — Стартап-студия НГУ',
  description: 'Кошелёк Стартап-студии НГУ: баллы, мероприятия, артефакты и магазин',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#080808',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <Script src="https://telegram.org/js/telegram-web-app.js?63" strategy="beforeInteractive" />
        <Script src="https://st.max.ru/js/max-web-app.js" strategy="beforeInteractive" />
      </head>
      <body>{children}</body>
    </html>
  );
}
