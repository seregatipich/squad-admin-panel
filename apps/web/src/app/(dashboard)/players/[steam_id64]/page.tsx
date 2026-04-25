'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';

interface Player {
  steam_id64: string;
  canonical_name: string;
  eos_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  total_time_played_seconds: number;
}

interface NameHistory {
  name: string;
  name_normalized: string;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

interface IpHistory {
  ip: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface PlayerResponse {
  player: Player;
  names: NameHistory[];
  ips: IpHistory[];
  ips_visible: boolean;
}

interface RoleAssignment {
  role_id: string;
  name: string;
  clearance_level: number;
  assigned_at: string;
  assigned_by: string | null;
}

interface Role {
  id: string;
  name: string;
  description: string | null;
  clearance_level: number;
  is_system_role: boolean;
}

interface Me {
  steam_id64: string;
  permissions: string[];
}

export default function PlayerDetail({ params }: { params: Promise<{ steam_id64: string }> }) {
  const { steam_id64 } = use(params);
  const [data, setData] = useState<PlayerResponse | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/v1/players/${steam_id64}`, { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr((e as Error).message));
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setMe(j as Me | null))
      .catch(() => {});
  }, [steam_id64]);

  if (err) {
    return (
      <div>
        <Link href="/players" className="text-sky-400 text-xs">
          ← игроки
        </Link>
        <div className="mt-3 rounded border border-red-900 bg-red-950 p-3 text-sm">
          Ошибка: {err}
        </div>
      </div>
    );
  }
  if (!data) return <div className="text-neutral-500">Загрузка…</div>;

  const { player, names, ips, ips_visible } = data;
  const canManageRoles = me?.permissions.includes('user:manage_roles') ?? false;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/players" className="text-sky-400 hover:text-sky-300 text-xs font-mono">
          ← игроки
        </Link>
        <h1 className="text-2xl font-semibold">{player.canonical_name}</h1>
      </div>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Профиль</h2>
        <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-sm">
          <dt className="text-neutral-500">SteamID64</dt>
          <dd className="font-mono">
            <a
              href={`https://steamcommunity.com/profiles/${player.steam_id64}`}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              {player.steam_id64}
            </a>
          </dd>
          <dt className="text-neutral-500">EOS ID</dt>
          <dd className="font-mono">{player.eos_id ?? '—'}</dd>
          <dt className="text-neutral-500">First seen</dt>
          <dd>{new Date(player.first_seen_at).toLocaleString()}</dd>
          <dt className="text-neutral-500">Last seen</dt>
          <dd>{new Date(player.last_seen_at).toLocaleString()}</dd>
          <dt className="text-neutral-500">Total playtime</dt>
          <dd className="font-mono">{fmtDuration(player.total_time_played_seconds)}</dd>
        </dl>
      </section>

      {canManageRoles ? <PanelAccessSection steamId64={steam_id64} /> : null}

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          История ников ({names.length})
        </h2>
        {names.length === 0 ? (
          <div className="text-neutral-500 text-sm">только основной ник</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-widest text-neutral-500">
              <tr>
                <th className="text-left p-1">Ник</th>
                <th className="text-left p-1">Виделся N раз</th>
                <th className="text-left p-1">Первый раз</th>
                <th className="text-left p-1">Последний раз</th>
              </tr>
            </thead>
            <tbody>
              {names.map((n) => (
                <tr key={n.name_normalized} className="border-t border-neutral-900">
                  <td className="p-1 font-medium">{n.name}</td>
                  <td className="p-1 font-mono">{n.observation_count}</td>
                  <td className="p-1 text-neutral-500">
                    {new Date(n.first_seen_at).toLocaleString()}
                  </td>
                  <td className="p-1 text-neutral-500">
                    {new Date(n.last_seen_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {ips_visible ? (
        <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">
            История IP ({ips.length})
          </h2>
          {ips.length === 0 ? (
            <div className="text-neutral-500 text-sm">пока пусто</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-widest text-neutral-500">
                <tr>
                  <th className="text-left p-1">IP</th>
                  <th className="text-left p-1">Первый раз</th>
                  <th className="text-left p-1">Последний раз</th>
                </tr>
              </thead>
              <tbody>
                {ips.map((ip) => (
                  <tr key={ip.ip} className="border-t border-neutral-900">
                    <td className="p-1 font-mono">{ip.ip}</td>
                    <td className="p-1 text-neutral-500">
                      {new Date(ip.first_seen_at).toLocaleString()}
                    </td>
                    <td className="p-1 text-neutral-500">
                      {new Date(ip.last_seen_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : (
        <section className="rounded border border-neutral-800 bg-neutral-950 p-4 text-xs text-neutral-500">
          У вас нет разрешения <code className="text-neutral-300">player:view_ips</code> — IP скрыт.
        </section>
      )}
    </div>
  );
}

function PanelAccessSection({ steamId64 }: { steamId64: string }) {
  const [assignments, setAssignments] = useState<RoleAssignment[] | null>(null);
  const [allRoles, setAllRoles] = useState<Role[] | null>(null);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function reload() {
    const [aRes, rRes] = await Promise.all([
      fetch(`/api/v1/players/${steamId64}/roles`, { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (aRes.ok) setAssignments((await aRes.json()) as RoleAssignment[]);
    if (rRes.ok) setAllRoles((await rRes.json()) as Role[]);
  }

  useEffect(() => {
    void reload();
  }, []);

  async function assign() {
    if (!picked) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/players/${steamId64}/roles`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: picked }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPicked('');
      await reload();
      setMsg({ kind: 'ok', text: 'Роль назначена.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(roleId: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/players/${steamId64}/roles/${roleId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (r.status === 409) {
        const body = await r.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error === 'cannot_remove_last_owner'
            ? 'Нельзя убрать роль у последнего Owner — иначе панель потеряет администратора.'
            : `HTTP ${r.status}`,
        );
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await reload();
      setMsg({ kind: 'ok', text: 'Роль удалена.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!assignments || !allRoles) {
    return (
      <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Доступ к панели</h2>
        <div className="text-sm text-neutral-500">Загрузка…</div>
      </section>
    );
  }

  const assignedIds = new Set(assignments.map((a) => a.role_id));
  const availableRoles = allRoles.filter((r) => !assignedIds.has(r.id));

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Доступ к панели</h2>

      {msg ? (
        <div
          className={`rounded border p-2 text-xs ${
            msg.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm text-neutral-400">Текущие роли</h3>
        {assignments.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Игрок не имеет роли в панели. При попытке войти он попадёт на /no-access.
          </p>
        ) : (
          <ul className="space-y-1">
            {assignments.map((a) => (
              <li
                key={a.role_id}
                className="flex items-center justify-between rounded bg-neutral-900 px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium">{a.name}</span>
                  <span className="ml-2 text-xs text-neutral-500">
                    clearance {a.clearance_level} · с {new Date(a.assigned_at).toLocaleDateString()}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => revoke(a.role_id)}
                  disabled={busy}
                  className="rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                >
                  Удалить
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-neutral-900 pt-3">
        <h3 className="mb-2 text-sm text-neutral-400">Назначить роль</h3>
        <div className="flex gap-2">
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          >
            <option value="">— выберите роль —</option>
            {availableRoles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} (clearance {r.clearance_level})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={assign}
            disabled={!picked || busy}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Назначить
          </button>
        </div>
      </div>
    </section>
  );
}

function fmtDuration(seconds: number): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
