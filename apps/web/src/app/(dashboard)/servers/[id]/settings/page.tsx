'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { TagInput } from '@/components/TagInput';

interface Settings {
  server_id: string;
  game_port: number;
  query_port: number;
  beacon_port: number;
  rcon_port: number;
  max_players: number;
  tickrate: number;
  multihome: string | null;
  extra_args: string;
  cpu_affinity: string | null;
  cpu_weight: number | null;
  niceness: number | null;
  memory_high_mb: number | null;
  memory_max_mb: number | null;
  io_weight: number | null;
}

interface ServerInfo {
  status: string;
  display_name: string;
  tags: string[];
}

export default function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [licenseId, setLicenseId] = useState('');
  const [licenseKey, setLicenseKey] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/servers/${id}`, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setServerInfo({
        status: data.server.status,
        display_name: data.server.display_name,
        tags: data.server.tags ?? [],
      });
      setTags(data.server.tags ?? []);
      setSettings(data.settings);
      setDraft({});
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isRunning = serverInfo && !['stopped', 'ready', 'pending'].includes(serverInfo.status);

  function setField<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function saveSettings() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/settings`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as Settings;
      setSettings(updated);
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveLicense() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/servers/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ license_id: licenseId, license_key: licenseKey }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${r.status}`);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function detachLicense() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/servers/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ license_id: null, license_key: null }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${r.status}`);
      }
      setLicenseId('');
      setLicenseKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return <div className="p-6 text-neutral-500">Загрузка...</div>;
  }

  const val = <K extends keyof Settings>(key: K) =>
    draft[key] !== undefined ? draft[key] : settings[key];

  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="mx-auto max-w-2xl py-6">
      <h1 className="mb-6 text-xl font-semibold text-neutral-100">
        Настройки — {serverInfo?.display_name}
      </h1>

      {err && (
        <div className="mb-4 rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}
      {saved && (
        <div className="mb-4 rounded border border-emerald-900 bg-emerald-950 px-3 py-2 text-sm text-emerald-300">
          Сохранено
        </div>
      )}

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
          Теги
        </h2>
        <TagInput
          tags={tags}
          onChange={async (newTags) => {
            setTags(newTags);
            try {
              await fetch(`/api/v1/servers/${id}`, {
                method: 'PATCH',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tags: newTags }),
              });
            } catch {
              /* best effort */
            }
          }}
        />
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
          Сеть
        </h2>
        {isRunning && (
          <p className="mb-2 text-xs text-amber-400">Остановите сервер для изменения портов</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ['game_port', 'Game Port'],
              ['query_port', 'Query Port'],
              ['beacon_port', 'Beacon Port'],
              ['rcon_port', 'RCON Port'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs text-neutral-500">{label}</span>
              <input
                type="number"
                value={val(key) as number}
                onChange={(e) => setField(key, Number(e.target.value))}
                disabled={!!isRunning}
                min={1024}
                max={65535}
                className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm disabled:opacity-50"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
          Игра
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-neutral-500">Max Players</span>
            <input
              type="number"
              value={val('max_players') as number}
              onChange={(e) => setField('max_players', Number(e.target.value))}
              min={1}
              max={100}
              className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-neutral-500">Tickrate</span>
            <input
              type="number"
              value={val('tickrate') as number}
              onChange={(e) => setField('tickrate', Number(e.target.value))}
              min={10}
              max={60}
              className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
          Ресурсы
        </h2>
        <p className="mb-2 text-xs text-neutral-500">Применяется при следующем запуске</p>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ['memory_high_mb', 'Memory High (MB)', 2048],
              ['memory_max_mb', 'Memory Max (MB)', 2048],
              ['cpu_weight', 'CPU Weight', 1],
              ['io_weight', 'IO Weight', 10],
              ['niceness', 'Nice', -20],
            ] as const
          ).map(([key, label, min]) => (
            <label key={key} className="block">
              <span className="text-xs text-neutral-500">{label}</span>
              <input
                type="number"
                value={(val(key) as number | null) ?? ''}
                onChange={(e) =>
                  setField(key, e.target.value === '' ? null : Number(e.target.value))
                }
                min={min}
                placeholder="Нет лимита"
                className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
              />
            </label>
          ))}
          <label className="block">
            <span className="text-xs text-neutral-500">CPU Affinity</span>
            <input
              value={(val('cpu_affinity') as string | null) ?? ''}
              onChange={(e) =>
                setField('cpu_affinity', e.target.value === '' ? null : e.target.value)
              }
              placeholder="Нет ограничения"
              className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-neutral-400">
          Лицензия
        </h2>
        <p className="mb-2 text-xs text-neutral-500">Требуется перезапуск сервера</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-neutral-500">License ID</span>
            <input
              value={licenseId}
              onChange={(e) => setLicenseId(e.target.value)}
              placeholder="Не указан"
              className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-neutral-500">License Key</span>
            <input
              type="password"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              placeholder="Не указан"
              className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={!licenseId || !licenseKey || busy}
            onClick={saveLicense}
            className="rounded bg-sky-700 px-3 py-1.5 text-xs text-white hover:bg-sky-600 disabled:opacity-40"
          >
            Привязать
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={detachLicense}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:border-red-700 hover:text-red-300"
          >
            Отвязать
          </button>
        </div>
      </section>

      <button
        type="button"
        disabled={!dirty || busy}
        onClick={saveSettings}
        className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Сохранение...' : 'Сохранить'}
      </button>
    </div>
  );
}
