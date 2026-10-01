'use client';

import { useEffect, useState } from 'react';
import { SteamLoginLink } from '@/components/SteamLoginLink';
import { Card, InlineBanner, PageContainer, PageHeader } from '@/components/ui';
import { useTranslator } from '@/i18n/LocaleProvider';
import { apiSend } from '@/lib/api';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const t = useTranslator();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get('error');
    setError(errorCode);
    setSteamId(params.get('steam_id64'));
    // A failed logout leaves the session alive; bouncing to the dashboard would hide that.
    if (errorCode === 'logout_failed') return;
    (async () => {
      try {
        await apiSend('/api/v1/me');
        window.location.href = '/dashboard';
      } catch {
        // Сбой проверки сессии не мешает войти: страница входа остаётся доступной.
      }
    })();
  }, []);

  return (
    <main className="min-h-screen bg-bg px-6 py-16 text-ink">
      <PageContainer width="form">
        <PageHeader title={t('login.heading')} />

        {/* Не удалось проверить вход — состояние обратимое: можно повторить.
            Отказ в доступе обратимым не является и объявляется критическим. */}
        {error === 'auth_failed' && (
          <InlineBanner tone="warn" title={t('login.error.authFailed')} />
        )}
        {error === 'logout_failed' && (
          <InlineBanner tone="warn" title={t('login.error.logoutFailed')} />
        )}
        {error === 'not_authorized' && (
          <InlineBanner
            tone="crit"
            title={t('login.error.notAuthorized', { steamId: steamId ?? '—' })}
          />
        )}

        <Card>
          <SteamLoginLink>{t('login.steamButton')}</SteamLoginLink>
        </Card>
      </PageContainer>
    </main>
  );
}
