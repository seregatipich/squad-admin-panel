import { cookies } from 'next/headers';
import { apiFetch } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/dal';

interface Player {
  steam_id64: string;
  canonical_name: string;
  eos_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  total_time_played_seconds: number;
}

export default async function PlayersPage() {
  const jar = await cookies();
  const cookie = `${SESSION_COOKIE}=${jar.get(SESSION_COOKIE)?.value ?? ''}`;
  const data = await apiFetch<{ items: Player[]; total: number }>('/api/v1/players', { cookie });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Игроки</h1>
      {data.items.length === 0 ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-neutral-500">
          Ни один игрок ещё не подключался.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-widest text-neutral-500">
            <tr>
              <th className="text-left p-2">Ник</th>
              <th className="text-left p-2">SteamID64</th>
              <th className="text-left p-2">EOS ID</th>
              <th className="text-left p-2">Последний раз</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((p) => (
              <tr key={p.steam_id64} className="border-t border-neutral-900">
                <td className="p-2">{p.canonical_name}</td>
                <td className="p-2 font-mono text-xs">
                  <a
                    href={`https://steamcommunity.com/profiles/${p.steam_id64}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {p.steam_id64}
                  </a>
                </td>
                <td className="p-2 font-mono text-xs">{p.eos_id ?? '—'}</td>
                <td className="p-2 text-neutral-500">
                  {new Date(p.last_seen_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
