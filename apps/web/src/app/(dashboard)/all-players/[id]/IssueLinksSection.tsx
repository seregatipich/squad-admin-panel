'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  InlineBanner,
} from '@/components/ui';

interface LinkedIssue {
  id: string;
  number: number;
  title: string;
  state: 'open' | 'in_progress' | 'closed';
  created_at: string;
}

interface LinkedIssuesResponse {
  open_count: number;
  items: LinkedIssue[];
}

const STATE_LABELS: Record<LinkedIssue['state'], string> = {
  open: 'Открыт',
  in_progress: 'В работе',
  closed: 'Закрыт',
};

/** Состояние тикета — состояние системы, поэтому тон, а не произвольный оттенок (§5). */
const STATE_TONE: Record<LinkedIssue['state'], BadgeTone> = {
  open: 'good',
  in_progress: 'warn',
  closed: 'neutral',
};

/**
 * «Связанные тикеты» on the player card (ISSUE-3, #156) — the reverse of the
 * ticket card's link block. `GET /api/v1/players/:playerId/issues` is
 * `panel_access`-gated, so the section self-hides on 401/403 rather than
 * consulting a capability flag; it also hides when the player has no unclosed
 * linked ticket, keeping the card free of empty boxes.
 */
export function IssueLinksSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<LinkedIssuesResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setHidden(false);
    setError(null);
    fetch(`/api/v1/players/${playerId}/issues`, { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as LinkedIssuesResponse;
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  useEffect(() => load(), [load]);

  if (hidden) return null;

  if (error) {
    return (
      <Card padding="none" as="section">
        <CardHeader title="Связанные тикеты" />
        <CardBody>
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить связанные тикеты"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        </CardBody>
      </Card>
    );
  }

  if (!data || data.items.length === 0) return null;

  return (
    <Card padding="none" as="section">
      <CardHeader title="Связанные тикеты" count={data.open_count} />
      <CardBody>
        <ul className="divide-y divide-line rounded-ctl border border-line">
          {data.items.map((issue) => (
            <li key={issue.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
              <span className="font-mono text-xs text-ink-3">#{issue.number}</span>
              <Link href={`/issues/${issue.id}`} className="text-accent">
                {issue.title}
              </Link>
              <span className="ml-auto">
                <Badge size="sm" tone={STATE_TONE[issue.state]}>
                  {STATE_LABELS[issue.state]}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
