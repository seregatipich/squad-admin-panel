// Variable weights, self-hosted: the panel must render identically offline and
// on a LAN-only host, so no Google Fonts round-trip. `--font-sans` prefers the
// system UI face and falls back to Inter where there isn't one (Linux, Windows).
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../styles/globals.css';
import type { Metadata } from 'next';
import { LocaleProvider } from '@/i18n/LocaleProvider';

export function generateMetadata(): Metadata {
  return {
    title: 'Squad Admin Panel',
    description: 'Опенсорсная self-hosted админ-панель для выделенных серверов Squad',
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
