import { cookies } from 'next/headers';
import { apiFetch } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/dal';

interface BridgeStatus {
  connected: boolean;
  version?: string | null;
  hostname?: string | null;
  round_trip_ms?: number;
  error?: string;
}

interface HostInfo {
  hostname: string;
  os_name: string;
  os_version: string;
  kernel: string;
  cpu_model: string;
  cpu_cores: number;
  ram_total_bytes: number;
}

interface ServerList {
  items: Array<{ id: string; display_name: string; slug: string; status: string }>;
  total: number;
}

export default async function DashboardPage() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value ?? '';
  const cookie = `${SESSION_COOKIE}=${token}`;

  const [bridge, host, servers] = await Promise.allSettled([
    apiFetch<BridgeStatus>('/api/v1/host/bridge-status', { cookie }),
    apiFetch<HostInfo>('/api/v1/host/info', { cookie }),
    apiFetch<ServerList>('/api/v1/servers', { cookie }),
  ]);

  const bridgeData =
    bridge.status === 'fulfilled'
      ? bridge.value
      : { connected: false, error: (bridge.reason as Error).message };
  const hostData = host.status === 'fulfilled' ? host.value : null;
  const serverData = servers.status === 'fulfilled' ? servers.value : { items: [], total: 0 };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Дашборд</h1>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Bridge">
          {bridgeData.connected ? (
            <div className="space-y-1 text-sm">
              <div className="text-emerald-400">✅ connected</div>
              <div className="text-neutral-400">
                version: <code>{bridgeData.version ?? '—'}</code>
              </div>
              <div className="text-neutral-400">RTT: {bridgeData.round_trip_ms ?? '—'} ms</div>
            </div>
          ) : (
            <div className="text-red-400 text-sm">❌ disconnected: {bridgeData.error ?? '—'}</div>
          )}
        </Card>

        <Card title="Хост">
          {hostData ? (
            <dl className="space-y-1 text-sm">
              <div>
                <dt className="text-neutral-500">ОС</dt>
                <dd>
                  {hostData.os_name} {hostData.os_version}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">Kernel</dt>
                <dd className="font-mono text-xs">{hostData.kernel}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">CPU</dt>
                <dd>
                  {hostData.cpu_model} × {hostData.cpu_cores}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">RAM</dt>
                <dd>{(hostData.ram_total_bytes / 1024 ** 3).toFixed(1)} GiB</dd>
              </div>
            </dl>
          ) : (
            <div className="text-neutral-500 text-sm">данных нет</div>
          )}
        </Card>

        <Card title="Серверы">
          <div className="text-3xl font-semibold">{serverData.total}</div>
          <div className="text-sm text-neutral-500">
            {serverData.items.filter((s) => s.status === 'running').length} работают
          </div>
        </Card>
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-2">
      <div className="text-xs uppercase tracking-widest text-neutral-500">{title}</div>
      {children}
    </div>
  );
}
