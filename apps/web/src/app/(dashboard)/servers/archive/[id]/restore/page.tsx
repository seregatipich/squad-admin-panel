'use client';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { LogConsole } from '@/components/LogConsole';
import {
  Button,
  Card,
  FieldRow,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
  TextInput,
} from '@/components/ui';

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

/** Заголовок страницы для каждого шага мастера, кроме формы. */
const STAGE_TITLE: Record<Exclude<WizardStage, 'form'>, string> = {
  creating: 'Создаём сервер…',
  installing: 'Установка…',
  'restoring-configs': 'Накладываем бэкап конфигов…',
  'configs-restored': 'Конфиги восстановлены',
  starting: 'Запуск сервера…',
  done: 'Готово',
  error: 'Ошибка восстановления',
};

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
      setError('Этот идентификатор уже занят активным сервером');
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

  if (!archive) {
    return (
      <PageContainer width="form">
        <PageHeader
          title="Восстановление сервера из архива"
          backHref="/servers/archive"
          backLabel="К архиву"
        />
        {error ? (
          <InlineBanner tone="crit" title="Не удалось получить запись архива" description={error} />
        ) : (
          <Skeleton variant="card" label="Загружается запись архива" />
        )}
      </PageContainer>
    );
  }

  if (stage === 'form') {
    return (
      <PageContainer width="form">
        <PageHeader
          title="Восстановление сервера из архива"
          backHref="/servers/archive"
          backLabel="К архиву"
          subtitle={`Источник: ${archive.server.display_name} · ${archive.server.slug}`}
        />
        {error && <InlineBanner tone="crit" title="Восстановление не начато" description={error} />}
        <Card as="section">
          <form onSubmit={submit} className="space-y-4">
            <FieldRow label="Идентификатор нового сервера" required>
              <TextInput
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                pattern="^[a-z0-9-]+$"
                required
              />
            </FieldRow>
            <FieldRow label="Отображаемое имя" required>
              <TextInput
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </FieldRow>
            <div className="flex justify-end">
              <Button type="submit" variant="primary">
                Создать новый сервер из бэкапа
              </Button>
            </div>
          </form>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      <PageHeader
        title={STAGE_TITLE[stage]}
        backHref="/servers/archive"
        backLabel="К архиву"
        meta={
          newServerId ? (
            <span className="font-mono">ID нового сервера: {newServerId}</span>
          ) : undefined
        }
      />
      {error && <InlineBanner tone="crit" title="Ошибка восстановления" description={error} />}
      <LogConsole
        lines={lines}
        height="20rem"
        live={stage === 'installing'}
        showStep
        emptyText="Ожидание первого сообщения…"
      />
      {restoreSummary ? (
        <GroupedList title="Итог наложения конфигов">
          <GroupedRow
            label="Восстановлено файлов"
            control={<span className="tabular-nums text-xs">{restoreSummary.files_restored}</span>}
          />
          <GroupedRow
            label="Пропущено"
            description="Например, Rcon.cfg — он собирается заново."
            control={<span className="tabular-nums text-xs">{restoreSummary.files_skipped}</span>}
          />
          {restoreSummary.files_missing ? (
            <GroupedRow
              label="Не найдено в бэкапе"
              control={<span className="tabular-nums text-xs">{restoreSummary.files_missing}</span>}
            />
          ) : null}
        </GroupedList>
      ) : null}
      {restoreSummary && restoreSummary.errors.length > 0 ? (
        <InlineBanner
          tone="warn"
          title="Часть файлов не восстановилась"
          description={
            <ul>
              {restoreSummary.errors.map((er) => (
                <li key={er.filename}>
                  {er.filename}: {er.error}
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
      {stage === 'configs-restored' && newServerId ? (
        <div className="flex justify-end gap-2">
          <Button onClick={() => router.push(`/servers/${newServerId}`)}>Открыть сервер</Button>
          <Button variant="primary" onClick={startServer}>
            Запустить сервер
          </Button>
        </div>
      ) : null}
    </PageContainer>
  );
}
