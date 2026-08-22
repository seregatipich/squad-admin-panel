'use client';

import { useState } from 'react';
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

const STEAM_ID64_RE = /^\d{17}$/;
const BODY_MIN = 20;
const BODY_MAX = 4000;
const CONTACT_MAX = 200;

interface SubmittedAppeal {
  number: number;
  tracking_token: string;
}

/**
 * Public, no-session ban-appeal portal (MOD-5, #62). A banned player cannot
 * hold a panel session, so this page submits straight to the anonymous
 * `POST /api/v1/public/appeals` with no auth of any kind.
 *
 * The tracking link shown after a successful submission is the applicant's
 * only handle on their appeal — the API returns the token exactly once — so
 * it is rendered prominently and paired with an explicit "save this link".
 */
export default function PublicAppealPage() {
  const [steamId64, setSteamId64] = useState('');
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedAppeal | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!STEAM_ID64_RE.test(steamId64.trim())) {
      setError('Укажите корректный SteamID64 (17 цифр).');
      return;
    }
    if (body.trim().length < BODY_MIN) {
      setError(`Опишите ситуацию — не менее ${BODY_MIN} символов.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/appeals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          steam_id64: steamId64.trim(),
          body: body.trim(),
          contact: contact.trim() || undefined,
        }),
      });
      if (res.status === 201) {
        setSubmitted((await res.json()) as SubmittedAppeal);
        return;
      }
      if (res.status === 409) {
        setError('Апелляция с этим SteamID64 уже на рассмотрении.');
        return;
      }
      if (res.status === 429) {
        setError('Слишком много заявок с этого адреса. Попробуйте завтра.');
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
                {`/appeal/${submitted.tracking_token}`}
              </p>
            </>
          }
        />
      ) : (
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
