'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useTranslator } from '@/i18n/LocaleProvider';

function NoAccessContent() {
  const params = useSearchParams();
  const sid = params.get('steam_id64');
  const t = useTranslator();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 text-center text-neutral-100">
      <h1 className="mb-4 text-2xl font-semibold">{t('noAccess.heading')}</h1>
      {sid ? (
        <p className="mb-2">{t('noAccess.withId', { steamId: sid })}</p>
      ) : (
        <p className="mb-2">{t('noAccess.withoutId')}</p>
      )}
      <p className="mb-6 max-w-md text-sm text-neutral-400">{t('noAccess.instructions')}</p>
      <Link href="/login" className="text-sky-400 hover:text-sky-300">
        {t('noAccess.backToLogin')}
      </Link>
      <p className="mt-12 text-xs text-neutral-600">
        {t('noAccess.ownerHint')}
        <code className="ml-1 font-mono">/var/lib/squad-panel/.first-owner-claimed</code>.
      </p>
    </main>
  );
}

export default function NoAccessPage() {
  return (
    <Suspense fallback={null}>
      <NoAccessContent />
    </Suspense>
  );
}
