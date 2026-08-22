'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  Badge,
  Card,
  CardHeader,
  CloseIcon,
  EmptyState,
  FieldRow,
  IconButton,
  InlineBanner,
  Select,
} from '@/components/ui';
import { type PickedPlayer, PlayerSearchSelect } from '../PlayerSearchSelect';
import {
  canRemoveLink,
  entityTypeLabel,
  type IssueLinkEntityType,
  type IssueLinkView,
  type IssueLinkViewer,
  linkErrorMessage,
  sortLinks,
} from './issue-links';

interface ServerOption {
  id: string;
  display_name: string;
}

/**
 * «Связанные объекты» on the ticket card (ISSUE-3, #156). Links come from the
 * page's own `GET /api/v1/issues/:id` payload; every mutation calls
 * {@link onChanged} so the page refetches instead of this block keeping a
 * second copy of the list.
 *
 * The server picker is offered only when `GET /api/v1/servers` succeeds — that
 * route requires `server:view`, which a panel user working the tracker need not
 * have, so a 403 hides the option rather than breaking the block.
 */
export function IssueLinksBlock({
  issueId,
  links,
  viewer,
  onChanged,
}: {
  issueId: string;
  links: IssueLinkView[];
  viewer: IssueLinkViewer | null;
  onChanged: () => void;
}) {
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [entityType, setEntityType] = useState<IssueLinkEntityType>('player');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as { items: ServerOption[] }) : null))
      .then((body) => {
        if (!cancelled && body) setServers(body.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function mutate(request: () => Promise<Response>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await request();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(linkErrorMessage(res.status, body.error));
        return;
      }
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function attach(type: IssueLinkEntityType, entityId: string) {
    return mutate(() =>
      fetch(`/api/v1/issues/${issueId}/links`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entity_type: type, entity_id: entityId }),
      }),
    );
  }

  function detach(linkId: string) {
    return mutate(() =>
      fetch(`/api/v1/issues/${issueId}/links/${linkId}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
    );
  }

  const ordered = sortLinks(links);

  return (
    <Card as="section" padding="none">
      <CardHeader title="Связанные объекты" count={ordered.length} />

      {ordered.length === 0 ? (
        <EmptyState
          title="Связанных объектов нет"
          description="Свяжите тикет с игроком или сервером — связь появится в этом списке."
        />
      ) : (
        <ul className="divide-y divide-line">
          {ordered.map((link) => (
            <li key={link.id} className="flex min-h-9 items-center gap-2 px-4 py-1.5 text-[13px]">
              <Badge size="sm">{entityTypeLabel(link.entity_type)}</Badge>
              {link.ref ? (
                <Link href={link.ref} className="truncate text-accent no-underline hover:underline">
                  {link.label}
                </Link>
              ) : (
                <span className="truncate text-ink-3 line-through">{link.label}</span>
              )}
              {canRemoveLink(link, viewer) ? (
                <IconButton
                  className="ml-auto"
                  icon={<CloseIcon />}
                  label={`Удалить связь: ${link.label}`}
                  tone="destructive"
                  disabled={busy}
                  onClick={() => void detach(link.id)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-3 border-t border-line px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <FieldRow label="Тип объекта" className="w-44">
            <Select
              value={entityType}
              disabled={busy}
              onChange={(e) => {
                setEntityType(e.target.value as IssueLinkEntityType);
                setError(null);
              }}
            >
              <option value="player">{entityTypeLabel('player')}</option>
              {servers.length > 0 ? (
                <option value="server">{entityTypeLabel('server')}</option>
              ) : null}
            </Select>
          </FieldRow>

          {entityType === 'player' ? (
            <div className="w-64">
              <PlayerSearchSelect
                placeholder="Связать с игроком"
                disabled={busy}
                onSelect={(player: PickedPlayer) => void attach('player', player.id)}
              />
            </div>
          ) : (
            <FieldRow label="Сервер для связи" className="w-64">
              <Select
                defaultValue=""
                disabled={busy}
                onChange={(e) => {
                  if (e.target.value) void attach('server', e.target.value);
                }}
              >
                <option value="">Выберите сервер…</option>
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.display_name}
                  </option>
                ))}
              </Select>
            </FieldRow>
          )}
        </div>

        {error ? (
          <InlineBanner tone="crit" title="Не удалось изменить связи" description={error} />
        ) : null}
      </div>
    </Card>
  );
}
