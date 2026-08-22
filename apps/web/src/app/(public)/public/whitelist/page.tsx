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

const STEAM_ID64_RE = /^\d{17}$/;

type PortalState = 'loading' | 'open' | 'closed' | 'error';

/**
 * Public, no-session whitelist/VIP application portal (WL-3, #67). Reads the
 * open/closed master switch from `/api/v1/public/whitelist/settings` and, when
 * open, lets any visitor submit one pending application per SteamID64 via
 * `POST /api/v1/public/whitelist/applications`. No login, no PII beyond the
 * submitted SteamID64 and contact string.
 */
export default function PublicWhitelistPage() {
  const [state, setState] = useState<PortalState>('loading');
  const [steamId64, setSteamId64] = useState('');
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
      const data = (await res.json()) as { enabled: boolean };
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
    if (!STEAM_ID64_RE.test(steamId64.trim())) {
      setError('Укажите корректный SteamID64 (17 цифр).');
      return;
    }
    if (!body.trim()) {
      setError('Опишите заявку.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/whitelist/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          steam_id64: steamId64.trim(),
          body: body.trim(),
          contact: contact.trim() || undefined,
        }),
      });
      if (res.status === 201) {
        setSubmitted(true);
        setSteamId64('');
        setBody('');
        setContact('');
        return;
      }
      if (res.status === 404) {
        setState('closed');
        return;
      }
      if (res.status === 409) {
        setError('Заявка с этим SteamID64 уже на рассмотрении.');
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

      {state === 'open' && !submitted ? (
        <Card padding="none">
          <CardBody>
            <form onSubmit={submit} className="space-y-4">
              {error ? <InlineBanner tone="crit" title={error} /> : null}

              <FieldRow label="SteamID64" required>
                <TextInput
                  inputMode="numeric"
                  value={steamId64}
                  onChange={(e) => setSteamId64(e.target.value)}
                  placeholder="76561198000000000"
                  className="font-mono"
                />
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
