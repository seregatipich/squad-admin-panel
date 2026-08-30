'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  InlineBanner,
  SegmentedControl,
  Select,
  SkeletonTable,
} from '@/components/ui';
import { DossierKitsTab } from './DossierKitsTab';
import { DossierSkillTab } from './DossierSkillTab';
import { DossierVehiclesTab } from './DossierVehiclesTab';
import { DossierWeaponsTab } from './DossierWeaponsTab';
import {
  buildDossierQuery,
  type DossierResponse,
  type DossierTab,
  fillTrendMonths,
  LIFETIME_ONLY_NOTE,
} from './dossier';

interface ServerOption {
  id: string;
  display_name: string;
}

const TABS: readonly { key: DossierTab; label: string }[] = [
  { key: 'skill', label: 'Скилл' },
  { key: 'weapons', label: 'Оружие' },
  { key: 'vehicles', label: 'Техника' },
  { key: 'kits', label: 'Киты' },
];

/**
 * DOSSIER-6 (#193) «Досье» block, shared by the player card and the operator's
 * own «Аккаунт» page.
 *
 * Issues exactly one `GET /api/v1/players/:playerId/dossier` per (server,
 * period) selection and renders all four tabs from that single payload —
 * switching tabs never refetches. Somebody else's dossier is gated on
 * `combat:view`, which `GET /api/v1/me` does not report, so the block
 * self-hides on 401/403 rather than gating on a permission flag; on one's own
 * numbers the route lets the session through regardless, and that branch never
 * fires. The server selector drives the request and appears only on the tabs
 * whose aggregates carry a server dimension — and only where the consumer asks
 * for it at all (`serverFilter`).
 *
 * @param playerId UUID of the player whose numbers to show.
 * @param title Заголовок карточки; на своей странице это не «досье».
 * @param serverFilter Показывать ли выбор сервера. Своя игровая статистика
 *   считается по всем серверам сразу, и выбор там — лишний орган управления.
 */
export function DossierSection({
  playerId,
  title = 'Досье',
  serverFilter = true,
}: {
  playerId: string;
  title?: string;
  serverFilter?: boolean;
}) {
  const [data, setData] = useState<DossierResponse | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [serverId, setServerId] = useState<string>('all');
  const [monthsBack, setMonthsBack] = useState<number | null>(null);
  const [tab, setTab] = useState<DossierTab>('skill');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const serverSelectId = useId();

  /**
   * Загрузка досье. Возвращает отмену — та же функция служит и эффектом
   * монтирования, и обработчиком «Повторить», поэтому повторная попытка
   * повторяет ровно тот же запрос.
   */
  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = buildDossierQuery({ serverId, monthsBack, now: new Date() });
    fetch(`/api/v1/players/${playerId}/dossier${query}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((res) => {
        if (res.status === 401 || res.status === 403) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<DossierResponse>;
      })
      .then((body) => {
        if (cancelled) return;
        if (body === null) {
          setHidden(true);
          return;
        }
        setData(body);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId, serverId, monthsBack]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!serverFilter) return;
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { items?: ServerOption[] } | null) => {
        if (!cancelled) setServers(body?.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [serverFilter]);

  if (hidden) return null;

  const lifetimeOnly = tab === 'weapons' || tab === 'vehicles';

  return (
    <Card as="section" padding="none">
      <CardHeader
        title={title}
        actions={
          !serverFilter ? null : lifetimeOnly ? (
            <span className="text-xs text-ink-3">{LIFETIME_ONLY_NOTE}</span>
          ) : servers.length > 0 ? (
            <span className="flex items-center gap-2">
              <label className="text-xs text-ink-3" htmlFor={serverSelectId}>
                Сервер
              </label>
              <Select
                id={serverSelectId}
                size="sm"
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
              >
                <option value="all">Все серверы</option>
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.display_name}
                  </option>
                ))}
              </Select>
            </span>
          ) : null
        }
      />

      <CardBody className="space-y-4">
        <SegmentedControl
          ariaLabel="Раздел досье"
          value={tab}
          onChange={(next) => setTab(next as DossierTab)}
          items={TABS.map((entry) => ({ value: entry.key, label: entry.label }))}
        />

        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить досье"
            description={error}
            action={
              <Button size="sm" onClick={() => load()}>
                Повторить
              </Button>
            }
          />
        ) : loading || data === null ? (
          <SkeletonTable rows={5} cols={4} label="Загрузка досье" />
        ) : tab === 'skill' ? (
          <DossierSkillTab
            skill={data.skill}
            trend={fillTrendMonths(data.kd_trend, monthsBack, new Date())}
            monthsBack={monthsBack}
            onMonthsBackChange={setMonthsBack}
          />
        ) : tab === 'weapons' ? (
          <DossierWeaponsTab weapons={data.weapons} weaponsTotal={data.weapons_total} />
        ) : tab === 'vehicles' ? (
          <DossierVehiclesTab vehicles={data.vehicles} vehicleKills={data.vehicle_kills} />
        ) : (
          <DossierKitsTab kits={data.kits} />
        )}
      </CardBody>
    </Card>
  );
}
