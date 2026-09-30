// Variable weights, self-hosted: the panel must render identically offline and
// on a LAN-only host, so no Google Fonts round-trip. `--font-sans` prefers the
// system UI face and falls back to Inter where there isn't one (Linux, Windows).
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../styles/globals.css';
import type { Metadata } from 'next';
import { LocaleProvider } from '@/i18n/LocaleProvider';

/**
 * Every page renders per request. The Content-Security-Policy allows inline
 * scripts only with the request's nonce (`src/lib/csp.ts`), and Next.js can
 * stamp that nonce on its hydration scripts only while rendering the request;
 * a page prerendered at build time would ship them without one and never
 * hydrate.
 */
export const dynamic = 'force-dynamic';

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
