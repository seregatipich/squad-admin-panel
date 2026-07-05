'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';

interface ClanMember {
  player_id: string;
  canonical_name: string;
  member_role: string;
  has_priority: boolean;
}

interface ClanDetail {
  id: string;
  name: string;
  tags: string[];
  description: string | null;
  members: ClanMember[];
}

interface OnlineMember {
  player_id: string;
  name: string;
  team: string | null;
  squad: string | null;
  session_started_at: string;
}

interface OnlineServer {
  server_id: string;
  server_name: string;
  server_slug: string;
  members: OnlineMember[];
}

interface OnlineResponse {
  clan_id: string;
  servers: OnlineServer[];
}

const ONLINE_POLL_MS = 8000;
const ROLE_LABELS: Record<string, string> = {
  leader: 'Глава',
  deputy: 'Зам',
  member: 'Участник',
};

function formatSessionDuration(startedAt: string, nowMs: number): string {
  const startedMs = new Date(startedAt).getTime();
  if (Number.isNaN(startedMs)) return '—';
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function ClanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: clanId } = use(params);
  const [clan, setClan] = useState<ClanDetail | null>(null);
  const [online, setOnline] = useState<OnlineResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadClan = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/clans/${clanId}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 404) {
        setErr('Клан не найден.');
        return;
      }
      if (!res.ok) throw new Error(`Не удалось загрузить клан (${res.status})`);
      setClan((await res.json()) as ClanDetail);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [clanId]);

  const loadOnline = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/clans/${clanId}/online`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) return;
      setOnline((await res.json()) as OnlineResponse);
      setLastUpdate(new Date());
    } catch {
      /* keep the previous snapshot on transient failures */
    }
  }, [clanId]);

  useEffect(() => {
    void loadClan();
  }, [loadClan]);

  useEffect(() => {
    void loadOnline();
    const poll = setInterval(() => void loadOnline(), ONLINE_POLL_MS);
    return () => clearInterval(poll);
  }, [loadOnline]);

  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const onlineCount = online?.servers.reduce((sum, group) => sum + group.members.length, 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/clans" className="text-sm text-sky-400 hover:text-sky-300">
            ← Кланы
          </Link>
          <h1 className="text-2xl font-semibold">{clan?.name ?? 'Клан'}</h1>
          <div className="flex flex-wrap gap-1">
            {clan?.tags.map((tag) => (
              <span
                key={tag}
                className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-300"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{err}</div>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Онлайн</h2>
          <div className="text-xs text-neutral-500">участников онлайн: {onlineCount}</div>
        </div>

        {online && online.servers.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500 text-sm">
            Ни один участник клана сейчас не в игре.
          </div>
        ) : null}

        <div className="space-y-4">
          {online?.servers.map((group) => (
            <div key={group.server_id} className="rounded border border-neutral-800">
              <div className="flex items-center justify-between border-b border-neutral-900 bg-neutral-950 px-3 py-2">
                <span className="font-medium">{group.server_name}</span>
                <span className="text-xs text-neutral-500">{group.members.length} онлайн</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-widest text-neutral-500">
                    <tr>
                      <th className="text-left p-2">Участник</th>
                      <th className="text-left p-2">Команда</th>
                      <th className="text-left p-2">Отряд</th>
                      <th className="text-left p-2">В сессии</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.members.map((member) => (
                      <tr key={member.player_id} className="border-t border-neutral-900">
                        <td className="p-2">
                          <Link
                            href={`/players/${member.player_id}`}
                            className="text-sky-400 hover:text-sky-300"
                          >
                            {member.name}
                          </Link>
                        </td>
                        <td className="p-2 text-neutral-400">{member.team ?? '—'}</td>
                        <td className="p-2 text-neutral-400">{member.squad ?? '—'}</td>
                        <td className="p-2 font-mono tabular-nums text-emerald-400">
                          {formatSessionDuration(member.session_started_at, nowMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Ростер</h2>
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-2">Участник</th>
                <th className="text-left p-2">Роль</th>
                <th className="text-left p-2">Приоритет</th>
              </tr>
            </thead>
            <tbody>
              {clan?.members.map((member) => (
                <tr key={member.player_id} className="border-t border-neutral-900">
                  <td className="p-2">
                    <Link
                      href={`/players/${member.player_id}`}
                      className="text-sky-400 hover:text-sky-300"
                    >
                      {member.canonical_name}
                    </Link>
                  </td>
                  <td className="p-2 text-neutral-400">
                    {ROLE_LABELS[member.member_role] ?? member.member_role}
                  </td>
                  <td className="p-2 text-neutral-400">{member.has_priority ? 'да' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
