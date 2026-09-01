'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, InlineBanner, PageContainer, PageHeader } from '@/components/ui';
import { useTranslator } from '@/i18n/LocaleProvider';

const LOGIN_LINK_CLASS =
  'inline-flex min-h-11 w-full items-center justify-center rounded-ctl bg-accent px-3 text-xs font-medium text-bg no-underline transition-colors duration-150 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const started = useRef(false);
  const t = useTranslator();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const nextError = params.get('error');
    setError(nextError);
    setSteamId(params.get('steam_id64'));
    setReady(true);
    if (nextError) return;

    let active = true;
    void fetch('/api/v1/me', { credentials: 'include' })
      .then((response) => {
        if (active) window.location.href = response.ok ? '/dashboard' : '/api/v1/auth/bss/login';
      })
      .catch(() => {
        if (active) window.location.href = '/api/v1/auth/bss/login';
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="min-h-screen bg-bg px-6 py-16 text-ink">
      <PageContainer width="form">
        <PageHeader title={t('login.heading')} />

        {/* Не удалось проверить вход — состояние обратимое: можно повторить.
            Отказ в доступе обратимым не является и объявляется критическим. */}
        {(error === 'auth_failed' || error === 'sso_failed' || error === 'sso_unavailable') && (
          <InlineBanner tone="warn" title={t('login.error.ssoFailed')} />
        )}
        {error === 'not_authorized' && (
          <InlineBanner
            tone="crit"
            title={t('login.error.notAuthorized', { steamId: steamId ?? '—' })}
          />
        )}

        <Card>
          {ready && error ? (
            <a href="/api/v1/auth/bss/login" className={LOGIN_LINK_CLASS}>
              {t('login.retry')}
            </a>
          ) : (
            <output className="block py-2 text-center text-sm text-ink-3">
              {t('login.redirecting')}
            </output>
          )}
        </Card>
      </PageContainer>
    </main>
  );
}
