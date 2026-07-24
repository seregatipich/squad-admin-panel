import '../styles/globals.css';
import type { Metadata } from 'next';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { getLocale, getTranslator } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
    title: t('app.title'),
    description: t('app.description'),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
