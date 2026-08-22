'use client';

import { useEffect, useId, useState } from 'react';
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

function TabButton({
  active,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`-mb-px whitespace-nowrap border-b-2 px-2 py-1.5 text-xs ${
        active
          ? 'border-sky-500 text-sky-300'
          : 'border-transparent text-neutral-500 hover:text-neutral-300'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * DOSSIER-6 (#193) «Досье» block on the player card.
 *
 * Issues exactly one `GET /api/v1/players/:playerId/dossier` per (server,
 * period) selection and renders all four tabs from that single payload —
 * switching tabs never refetches. The route is gated on `combat:view`, which
 * `GET /api/v1/me` does not report, so the block self-hides on 401/403 rather
 * than gating on a permission flag. The server selector drives the request and
 * appears only on the tabs whose aggregates carry a server dimension.
 *
 * @param playerId UUID of the player whose card is open.
 */
export function DossierSection({ playerId }: { playerId: string }) {
  const [data, setData] = useState<DossierResponse | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [serverId, setServerId] = useState<string>('all');
  const [monthsBack, setMonthsBack] = useState<number | null>(null);
  const [tab, setTab] = useState<DossierTab>('skill');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const serverSelectId = useId();

  useEffect(() => {
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

  useEffect(() => {
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
  }, []);

  if (hidden) return null;

  const lifetimeOnly = tab === 'weapons' || tab === 'vehicles';

  return (
    <section
      data-testid="dossier-section"
      className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Досье</h2>
        {lifetimeOnly ? (
          <span className="text-[11px] text-neutral-500">{LIFETIME_ONLY_NOTE}</span>
        ) : null}
        {!lifetimeOnly && servers.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-neutral-500" htmlFor={serverSelectId}>
              Сервер
            </label>
            <select
              id={serverSelectId}
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            >
              <option value="all">Все серверы</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.display_name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 overflow-x-auto border-b border-neutral-900">
        {TABS.map((entry) => (
          <TabButton
            key={entry.key}
            testId={`dossier-tab-${entry.key}`}
            active={tab === entry.key}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </TabButton>
        ))}
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : loading || data === null ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
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
    </section>
  );
}
