'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  FieldRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
  Textarea,
  TextInput,
} from '@/components/ui';

type PortalState = 'loading' | 'open' | 'closed' | 'error';

/**
 * Ссылка входа — обычный `<a>`: `/api/v1/auth/steam/login` начинает
 * OpenID-обмен и требует полной навигации документа.
 */
const STEAM_LINK_CLASS =
  'inline-flex h-8 items-center justify-center rounded-ctl bg-accent px-3 text-xs font-medium text-bg no-underline transition-colors duration-150 hover:brightness-110';

/**
 * Public whitelist/VIP application portal (WL-3, #67). Reads the open/closed
 * master switch from `/api/v1/public/whitelist/settings` and, when open, lets a
 * player signed in through Steam submit one pending application for their own
 * SteamID64 via `POST /api/v1/public/whitelist/applications`. The SteamID64 is
 * taken from the Steam session (`/api/v1/me`), never typed in, so nobody can
 * apply — or block an application — in someone else's name (#375).
 */
export default function PublicWhitelistPage() {
  const [state, setState] = useState<PortalState>('loading');
  /** The signed-in player's SteamID64; `null` when there is no Steam session. */
  const [steamId64, setSteamId64] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const refresh = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch('/api/v1/public/whitelist/settings', { cache: 'no-store' });
      if (!res.ok) {
        setState('error');
        return;
      }
      const data = (await res.json()) as { enabled?: unknown } | null;
      if (typeof data?.enabled !== 'boolean') {
        setState('error');
        return;
      }
      if (data.enabled) {
        const meRes = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
        const me = meRes.ok ? ((await meRes.json()) as { steam_id64: string | null }) : null;
        setSteamId64(me?.steam_id64 ?? null);
      }
      setState(data.enabled ? 'open' : 'closed');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!body.trim()) {
      setError('Опишите заявку.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/whitelist/applications', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body: body.trim(),
          contact: contact.trim() || undefined,
        }),
      });
      if (res.status === 201) {
        setSubmitted(true);
        setBody('');
        setContact('');
        return;
      }
      if (res.status === 404) {
        setState('closed');
        return;
      }
      if (res.status === 401) {
        setSteamId64(null);
        setError('Сессия истекла — войдите через Steam ещё раз.');
        return;
      }
      if (res.status === 409) {
        setError(
          'Заявка с этим SteamID64 уже на рассмотрении. Если вы её не подавали, войдите через Steam и отправьте заявку снова.',
        );
        return;
      }
      if (res.status === 403) {
        setError('SteamID64 не совпадает с аккаунтом Steam, под которым вы вошли.');
        return;
      }
      if (res.status === 429) {
        setError('Слишком много заявок с этого адреса. Попробуйте позже.');
        return;
      }
      if (res.status === 400) {
        setError('Проверьте правильность заполнения полей.');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError(`Не удалось отправить заявку: ${data.error ?? res.status}`);
    } catch (err) {
      setError(`Ошибка сети: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageContainer width="reading">
      <PageHeader
        title="Заявка на whitelist / VIP"
        subtitle="Оставьте заявку на добавление в whitelist. Заявку рассмотрят администраторы."
      />

      {state === 'loading' ? <Skeleton variant="card" label="Проверяем, открыт ли приём" /> : null}

      {state === 'error' ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить портал заявок."
          description="Попробуйте позже."
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {state === 'closed' ? (
        <Card padding="none">
          <EmptyState
            title="Приём заявок сейчас закрыт."
            description="Администрация закрыла набор. Загляните позже — форма появится здесь сама."
          />
        </Card>
      ) : null}

      {state === 'open' && submitted ? (
        <InlineBanner
          tone="good"
          title="Заявка отправлена."
          description="Спасибо! Мы свяжемся с вами после рассмотрения."
        />
      ) : null}

      {state === 'open' && !submitted && steamId64 === null ? (
        <Card padding="none">
          <CardBody>
            <div className="space-y-3">
              {error ? <InlineBanner tone="crit" title={error} /> : null}
              <p className="text-sm">
                Заявку можно подать только от своего Steam-аккаунта: войдите через Steam, чтобы
                подтвердить SteamID64. После входа вернитесь на эту страницу.
              </p>
              <a href="/api/v1/auth/steam/login" className={STEAM_LINK_CLASS}>
                Войти через Steam
              </a>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {state === 'open' && !submitted && steamId64 !== null ? (
        <Card padding="none">
          <CardBody>
            <form onSubmit={submit} className="space-y-4">
              {error ? <InlineBanner tone="crit" title={error} /> : null}

              <FieldRow label="SteamID64 (из входа через Steam)">
                <TextInput value={steamId64} readOnly className="font-mono" />
              </FieldRow>

              <FieldRow label="Сообщение" required>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  maxLength={2000}
                  placeholder="Расскажите о себе: сколько играете, за что хотите whitelist…"
                />
              </FieldRow>

              <FieldRow label="Контакт (необязательно)">
                <TextInput
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  maxLength={128}
                  placeholder="Discord, Steam-профиль…"
                />
              </FieldRow>

              <p className="text-xs text-ink-3">
                После входа через Steam заявка будет подтверждённой: подать её от вашего имени никто
                не сможет. Войдя, вернитесь на эту страницу.{' '}
                {/* A plain <a>: the login is a full-page redirect to Steam, not a client route. */}
                <a href="/api/v1/auth/steam/login" className="text-accent-ink underline">
                  Войти через Steam
                </a>
              </p>

              <Button type="submit" variant="primary" loading={submitting}>
                Отправить заявку
              </Button>
            </form>
          </CardBody>
        </Card>
      ) : null}
    </PageContainer>
  );
}
