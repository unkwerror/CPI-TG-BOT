import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { MessengerSdk } from '../components/messenger-sdk';
import './globals.css';
import './studio.css';
import './merch.css';

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
      <body>
        <MessengerSdk />
        {children}
      </body>
    </html>
  );
}
