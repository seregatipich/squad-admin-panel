'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
} from '@/components/ui';

interface AppealStatusView {
  number: number;
  status: string;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

const STATUS_LABELS: Record<string, string> = {
  pending: 'На рассмотрении',
  in_review: 'В работе',
  approved: 'Одобрена',
  rejected: 'Отклонена',
};

/* Тон — это состояние заявки, а не украшение; смысл всё равно несёт подпись
   бейджа, поэтому неизвестный статус остаётся нейтральным, но читаемым (§5). */
const STATUS_TONES: Record<string, BadgeTone> = {
  pending: 'warn',
  in_review: 'accent',
  approved: 'good',
  rejected: 'neutral',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Служебный ярлык над значением — единственное место, где допустим капслок (§1). */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className="text-[13px] text-ink">{value}</dd>
    </div>
  );
}

/**
 * Applicant-facing status page for one ban appeal (MOD-5, #62), reached only
 * through the tracking token handed out at submission. The panel has no way
 * to notify a banned player — there is no mail channel and an in-game
 * `AdminWarn` cannot reach someone who is banned — so this pull page *is* the
 * decision channel.
 *
 * It renders exactly what `GET /api/v1/public/appeals/:token` returns: number,
 * status, timestamps and the moderator's public reply. An unknown token and
 * somebody else's token are indistinguishable here, as they are in the API.
 */
export default function AppealStatusPage() {
  const params = useParams();
  const rawToken = params?.token;
  const token = typeof rawToken === 'string' ? rawToken : null;

  const [state, setState] = useState<LoadState>('loading');
  const [appeal, setAppeal] = useState<AppealStatusView | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setState('missing');
      return;
    }
    try {
      const res = await fetch(`/api/v1/public/appeals/${encodeURIComponent(token)}`, {
        cache: 'no-store',
      });
      if (res.status === 404) {
        setState('missing');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      setAppeal((await res.json()) as AppealStatusView);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageContainer width="reading">
      <PageHeader
        title="Статус апелляции"
        subtitle="Эта страница доступна только по вашей ссылке. Решение появится здесь."
      />

      {state === 'loading' ? <Skeleton variant="card" label="Загружаем статус апелляции" /> : null}

      {state === 'missing' ? (
        <Card padding="none">
          <EmptyState
            title="Апелляция не найдена."
            description="Проверьте ссылку: она должна совпадать с той, что вы сохранили при отправке."
          />
        </Card>
      ) : null}

      {state === 'error' ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить статус апелляции."
          description="Попробуйте позже — заявка при этом никуда не делась."
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {state === 'ready' && appeal ? (
        <Card padding="none">
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[17px] font-semibold text-ink">{`#${appeal.number}`}</span>
              <Badge tone={STATUS_TONES[appeal.status] ?? 'neutral'}>
                {STATUS_LABELS[appeal.status] ?? appeal.status}
              </Badge>
            </div>

            <dl className="grid grid-cols-2 gap-3">
              <Fact label="Подана" value={formatDate(appeal.created_at)} />
              <Fact label="Решение" value={formatDate(appeal.decided_at)} />
            </dl>

            {appeal.decision_note ? (
              <div className="rounded-ctl border border-line bg-raised p-3">
                <div className="mb-1 text-2xs uppercase tracking-[0.06em] text-ink-3">
                  Ответ администрации
                </div>
                <p className="whitespace-pre-wrap text-[13px] text-ink">{appeal.decision_note}</p>
              </div>
            ) : (
              <p className="text-xs text-ink-3">
                Ответ администрации появится здесь после рассмотрения.
              </p>
            )}
          </CardBody>
        </Card>
      ) : null}
    </PageContainer>
  );
}
