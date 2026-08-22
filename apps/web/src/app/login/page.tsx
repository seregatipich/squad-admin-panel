'use client';

import { useEffect, useState } from 'react';
import { LocaleSwitch } from '@/components/LocaleSwitch';
import { Card, InlineBanner, PageContainer, PageHeader } from '@/components/ui';
import { useTranslator } from '@/i18n/LocaleProvider';

/**
 * Ссылка входа — обычный `<a>`, а не `ButtonLink`.
 *
 * `/api/v1/auth/steam/login` начинает OpenID-обмен и обязан получить полную
 * навигацию документа: `next/link` перехватил бы клик маршрутизатором и
 * предзагрузил бы адрес заранее. Поэтому классы кнопки здесь выписаны вручную —
 * это единственное место участка, где примитив не подходит по поведению.
 */
const STEAM_LINK_CLASS =
  'inline-flex h-8 w-full items-center justify-center rounded-ctl bg-accent px-3 text-xs font-medium text-bg no-underline transition-colors duration-150 hover:brightness-110';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const t = useTranslator();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setError(params.get('error'));
    setSteamId(params.get('steam_id64'));
    (async () => {
      const meRes = await fetch('/api/v1/me', { credentials: 'include' });
      if (meRes.ok) window.location.href = '/dashboard';
    })();
  }, []);

  return (
    <main className="min-h-screen bg-bg px-6 py-16 text-ink">
      <PageContainer width="form">
        <div className="flex justify-end">
          <LocaleSwitch />
        </div>

        <PageHeader title={t('login.heading')} />

        {/* Не удалось проверить вход — состояние обратимое: можно повторить.
            Отказ в доступе обратимым не является и объявляется критическим. */}
        {error === 'auth_failed' && (
          <InlineBanner tone="warn" title={t('login.error.authFailed')} />
        )}
        {error === 'not_authorized' && (
          <InlineBanner
            tone="crit"
            title={t('login.error.notAuthorized', { steamId: steamId ?? '—' })}
          />
        )}

        <Card>
          <a href="/api/v1/auth/steam/login" className={STEAM_LINK_CLASS}>
            {t('login.steamButton')}
          </a>
        </Card>
      </PageContainer>
    </main>
  );
}
