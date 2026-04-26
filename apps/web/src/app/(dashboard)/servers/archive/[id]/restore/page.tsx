'use client';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { LogConsole } from '@/components/LogConsole';

interface ArchiveDetail {
  server: {
    id: string;
    display_name: string;
    slug: string;
  };
}

interface RestoreResponse {
  id: string;
  archive_id: string;
  slug: string;
  display_name: string;
  status: string;
}

interface RestoreConfigsResponse {
  ok: boolean;
  files_restored: number;
  files_skipped: number;
  files_missing: number;
  errors: Array<{ filename: string; error: string }>;
}

interface InstallProgressLine {
  ts: string;
  step: string;
  stream?: 'stdout' | 'stderr';
  message: string;
}

type WizardStage =
  | 'form'
  | 'creating'
  | 'installing'
  | 'restoring-configs'
  | 'configs-restored'
  | 'starting'
  | 'done'
  | 'error';

export default function RestoreWizardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [archive, setArchive] = useState<ArchiveDetail | null>(null);
  const [stage, setStage] = useState<WizardStage>('form');
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [newServerId, setNewServerId] = useState<string | null>(null);
  const [lines, setLines] = useState<InstallProgressLine[]>([]);
  const [restoreSummary, setRestoreSummary] = useState<RestoreConfigsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/v1/servers/archive/${id}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as ArchiveDetail;
        if (cancelled) return;
        setArchive(j);
        setSlug(`${j.server.slug}-restored`);
        setDisplayName(`${j.server.display_name} (restored)`);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStage('creating');

    const restoreRes = await fetch(`/api/v1/servers/archive/${id}/restore`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, display_name: displayName }),
    });
    if (restoreRes.status === 409) {
      setError('Этот slug уже занят активным сервером');
      setStage('form');
      return;
    }
    if (!restoreRes.ok) {
      setError(`Не удалось создать сервер из архива (HTTP ${restoreRes.status})`);
      setStage('error');
      return;
    }
    const restoreBody = (await restoreRes.json()) as RestoreResponse;
    setNewServerId(restoreBody.id);

    setStage('installing');
    const installRes = await fetch(`/api/v1/servers/${restoreBody.id}/install`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!installRes.ok) {
      setError(`Не удалось запустить установку (HTTP ${installRes.status})`);
      setStage('error');
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${window.location.host}/api/v1/servers/${restoreBody.id}/install/ws`,
    );
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data) as Partial<InstallProgressLine> & {
          done?: boolean;
          final?: string;
          error?: string;
        };
        if (frame.error) {
          setError(String(frame.error));
          setStage('error');
          ws.close();
          return;
        }
        if (frame.done) {
          ws.close();
          if (frame.final === 'done') {
            void overlayConfigs(restoreBody.id);
          } else {
            setError('Установка завершилась с ошибкой');
            setStage('error');
          }
          return;
        }
        if (frame.step && frame.message && frame.ts) {
          setLines((prev) => [...prev, frame as InstallProgressLine]);
        }
      } catch {
        // ignore
      }
    };
    ws.onerror = () => {
      setError('Потеряно соединение с API во время установки');
      setStage('error');
    };
  }

  async function overlayConfigs(targetId: string) {
    setStage('restoring-configs');
    const r = await fetch(`/api/v1/servers/${targetId}/restore-configs`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from_archive_id: id }),
    });
    if (!r.ok) {
      setError(`Не удалось наложить бэкап конфигов (HTTP ${r.status})`);
      setStage('error');
      return;
    }
    const body = (await r.json()) as RestoreConfigsResponse;
    setRestoreSummary(body);
    setStage('configs-restored');
  }

  async function startServer() {
    if (!newServerId) return;
    setStage('starting');
    const r = await fetch(`/api/v1/servers/${newServerId}/start`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      setError(`Не удалось запустить сервер (HTTP ${r.status})`);
      setStage('error');
      return;
    }
    setStage('done');
    router.push(`/servers/${newServerId}`);
  }

  if (!archive && !error) return <div className="text-neutral-500">Загрузка…</div>;
  if (!archive)
    return (
      <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">Ошибка: {error}</div>
    );

  if (stage === 'form') {
    return (
      <form onSubmit={submit} className="space-y-4 max-w-xl">
        <h1 className="text-2xl font-semibold">Восстановление сервера из архива</h1>
        <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-400">
          Источник: <span className="font-mono">{archive.server.display_name}</span> ·{' '}
          <span className="font-mono">{archive.server.slug}</span>
        </div>
        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{error}</div>
        ) : null}
        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-widest text-neutral-400">
            Slug нового сервера
          </span>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            pattern="^[a-z0-9-]+$"
            required
            className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-widest text-neutral-400">
            Отображаемое имя
          </span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500"
        >
          Создать новый сервер из бэкапа
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-2xl font-semibold">
        {stage === 'creating'
          ? 'Создаём сервер…'
          : stage === 'installing'
            ? 'Установка…'
            : stage === 'restoring-configs'
              ? 'Накладываем бэкап конфигов…'
              : stage === 'configs-restored'
                ? 'Конфиги восстановлены'
                : stage === 'starting'
                  ? 'Запуск сервера…'
                  : stage === 'done'
                    ? 'Готово'
                    : 'Ошибка восстановления'}
      </h1>
      {newServerId ? (
        <div className="text-xs text-neutral-500 font-mono">new server id: {newServerId}</div>
      ) : null}
      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{error}</div>
      ) : null}
      <LogConsole
        lines={lines}
        height="20rem"
        live={stage === 'installing'}
        showStep
        emptyText="Ожидание первого сообщения…"
      />
      {restoreSummary ? (
        <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm space-y-1">
          <div>
            Восстановлено файлов: <span className="font-mono">{restoreSummary.files_restored}</span>
          </div>
          <div>
            Пропущено (например, Rcon.cfg):{' '}
            <span className="font-mono">{restoreSummary.files_skipped}</span>
          </div>
          {restoreSummary.files_missing ? (
            <div>
              Не найдено в бэкапе: <span className="font-mono">{restoreSummary.files_missing}</span>
            </div>
          ) : null}
          {restoreSummary.errors.length ? (
            <ul className="text-xs text-red-300">
              {restoreSummary.errors.map((er) => (
                <li key={er.filename}>
                  {er.filename}: {er.error}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {stage === 'configs-restored' && newServerId ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={startServer}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500"
          >
            Запустить сервер
          </button>
          <button
            type="button"
            onClick={() => router.push(`/servers/${newServerId}`)}
            className="rounded border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800"
          >
            Открыть сервер
          </button>
        </div>
      ) : null}
    </div>
  );
}
