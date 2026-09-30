'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  FieldRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Textarea,
  TextInput,
} from '@/components/ui';

const BODY_MIN = 20;
const BODY_MAX = 4000;
const CONTACT_MAX = 200;

/** Steam login that returns the player straight back to this page. */
const STEAM_LOGIN_HREF = '/api/v1/auth/steam/login?return_to=%2Fappeal';

/**
 * Ссылка входа — обычный `<a>`: OpenID-обмен требует полной навигации
 * документа, которую перехватил бы `next/link` (см. `app/login/page.tsx`).
 */
const STEAM_LINK_CLASS =
  'inline-flex h-8 items-center justify-center rounded-ctl bg-accent px-3 text-xs font-medium text-bg no-underline transition-colors duration-150 hover:brightness-110';

interface SubmittedAppeal {
  number: number;
  tracking_token: string;
}

/** The Steam account the visitor proved they own, from `GET /api/v1/me`. */
interface SteamIdentity {
  steamId64: string;
  name: string;
}

type IdentityState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | ({ kind: 'steam' } & SteamIdentity);

/**
 * Absolute tracking URL for an appeal. The applicant saves this text outside
 * the panel (Discord, notes), so it must carry the panel's origin — a bare
 * `/appeal/<token>` path is useless once copied away from the page.
 */
function trackingUrl(token: string): string {
  return `${window.location.origin}/appeal/${encodeURIComponent(token)}`;
}

/**
 * Ban-appeal portal (MOD-5, #62).
 *
 * Only the owner of the banned account may appeal (#40, finding #234): the
 * visitor first signs in through Steam — a banned player without a panel
 * role gets a self-service session — and the appeal is filed for that
 * login's SteamID64, which the page shows read-only. Before this the form
 * took any SteamID64 anonymously, so anyone could open an appeal in a
 * victim's name and block the victim's own.
 *
 * The tracking link shown after a successful submission is the applicant's
 * only handle on their appeal — the API returns the token exactly once — so
 * it is rendered prominently as an absolute, clickable URL and paired with an
 * explicit "save this link".
 */
export default function PublicAppealPage() {
  const [identity, setIdentity] = useState<IdentityState>({ kind: 'loading' });
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedAppeal | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
        const me = res.ok
          ? ((await res.json()) as { steam_id64?: string | null; canonical_name?: string })
          : null;
        if (cancelled) return;
        setIdentity(
          me?.steam_id64
            ? { kind: 'steam', steamId64: me.steam_id64, name: me.canonical_name ?? '' }
            : { kind: 'anonymous' },
        );
      } catch {
        if (!cancelled) setIdentity({ kind: 'anonymous' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (identity.kind !== 'steam') return;
    setError(null);
    if (body.trim().length < BODY_MIN) {
      setError(`Опишите ситуацию — не менее ${BODY_MIN} символов.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/appeals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          steam_id64: identity.steamId64,
          body: body.trim(),
          contact: contact.trim() || undefined,
        }),
      });
      if (res.status === 201) {
        const created = (await res.json().catch(() => null)) as Partial<SubmittedAppeal> | null;
        if (typeof created?.number !== 'number' || typeof created.tracking_token !== 'string') {
          setError('Не удалось отправить апелляцию: сервер вернул неожиданный ответ.');
          return;
        }
        setSubmitted({ number: created.number, tracking_token: created.tracking_token });
        return;
      }
      if (res.status === 401) {
        setIdentity({ kind: 'anonymous' });
        setError('Вход через Steam истёк. Войдите ещё раз.');
        return;
      }
      if (res.status === 403) {
        setError('Апелляцию можно подать только за тот аккаунт Steam, с которым вы вошли.');
        return;
      }
      if (res.status === 409) {
        setError('Ваша апелляция уже на рассмотрении.');
        return;
      }
      if (res.status === 429) {
        setError('Слишком много заявок. Попробуйте завтра.');
        return;
      }
      if (res.status === 400) {
        setError('Проверьте правильность заполнения полей.');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError(`Не удалось отправить апелляцию: ${data.error ?? res.status}`);
    } catch (err) {
      setError(`Ошибка сети: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageContainer width="reading">
      <PageHeader
        title="Апелляция на бан"
        subtitle="Если вы считаете, что бан выдан по ошибке, опишите ситуацию. Заявку рассмотрят администраторы вручную — автоматического снятия бана нет."
      />

      {submitted ? (
        <InlineBanner
          tone="good"
          title={`Апелляция №${submitted.number} отправлена.`}
          description={
            <>
              <p>Сохраните эту ссылку — по ней и только по ней вы узнаете решение:</p>
              <p className="mt-2 break-all rounded-ctl border border-line bg-raised px-2.5 py-2 font-mono text-xs text-ink">
                <a href={trackingUrl(submitted.tracking_token)} className="underline">
                  {trackingUrl(submitted.tracking_token)}
                </a>
              </p>
            </>
          }
        />
      ) : identity.kind === 'loading' ? null : identity.kind === 'anonymous' ? (
        <Card padding="none">
          <CardBody>
            <div className="space-y-4">
              {error ? <InlineBanner tone="crit" title={error} /> : null}
              <p className="text-sm text-ink">
                Подать апелляцию может только владелец забаненного аккаунта. Войдите через Steam —
                так мы убедимся, что апелляцию подаёте именно вы. Доступа к панели вход не даёт.
              </p>
              <a href={STEAM_LOGIN_HREF} className={STEAM_LINK_CLASS}>
                Войти через Steam
              </a>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card padding="none">
          <CardBody>
            <form onSubmit={submit} className="space-y-4">
              {error ? <InlineBanner tone="crit" title={error} /> : null}

              <FieldRow label="Аккаунт Steam" hint={identity.name || undefined}>
                <TextInput value={identity.steamId64} readOnly className="font-mono" />
              </FieldRow>

              <FieldRow label="Апелляция" required hint={`Минимум ${BODY_MIN} символов.`}>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={6}
                  maxLength={BODY_MAX}
                  placeholder="Опишите, почему бан стоит пересмотреть: что произошло, когда, что вы об этом думаете…"
                />
              </FieldRow>

              <FieldRow label="Контакт (необязательно)">
                <TextInput
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  maxLength={CONTACT_MAX}
                  placeholder="Discord, Steam-профиль…"
                />
              </FieldRow>

              <Button type="submit" variant="primary" loading={submitting}>
                Отправить апелляцию
              </Button>
            </form>
          </CardBody>
        </Card>
      )}
    </PageContainer>
  );
}
