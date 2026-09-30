'use client';
import { useRouter } from 'next/navigation';
import { use, useEffect, useRef, useState } from 'react';
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

/** Шаг после создания сервера, который можно повторить из стадии ошибки. */
type RetryStep = 'install' | 'restore-configs' | 'restart';

/** Права, без которых мастер не дойдёт до конца: создание и установка, затем наложение конфигов. */
const REQUIRED_PERMISSIONS = ['server:install', 'config:edit'] as const;

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
/** Slug-limit of the server-create schema; the default `<slug>-restored` must fit it. */
const MAX_SLUG_LENGTH = 64;

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
  const [retryStep, setRetryStep] = useState<RetryStep | null>(null);
  const [missingPermissions, setMissingPermissions] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // Closes a still-open install-progress socket on unmount (route change,
  // back navigation) so it does not keep running against an unmounted page.
  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

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
        setSlug(`${j.server.slug}-restored`.slice(0, MAX_SLUG_LENGTH));
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

  // Pre-check of the rights the wizard needs, so it is not started only to
  // fail halfway (config:edit is a separate right from server:install). A
  // failed /me read does not block the form: the API enforces rights anyway.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ permissions: string[] }>) : null))
      .then((me) => {
        if (cancelled || !me) return;
        setMissingPermissions(REQUIRED_PERMISSIONS.filter((key) => !me.permissions.includes(key)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await restoreFromArchive();
    } catch (err) {
      setError(`Сбой сети или ответа API: ${(err as Error).message}`);
      setStage('error');
    }
  }

  async function restoreFromArchive() {
    setError(null);
    setStage('creating');

    const restoreRes = await fetch(`/api/v1/servers/archive/${id}/restore`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, display_name: displayName }),
    });
    if (restoreRes.status === 409) {
      const body = (await restoreRes.json().catch(() => ({}))) as { error?: string };
      setError(
        body.error === 'slug_in_use'
          ? 'Этот идентификатор уже занят активным сервером'
          : body.error === 'external_server'
            ? 'Это внешний сервер: он подключается заново через «Подключить существующий», а не восстанавливается из архива.'
            : body.error === 'archive_settings_missing'
              ? 'В архиве нет настроек сервера — восстановление невозможно.'
              : `Не удалось создать сервер из архива (HTTP 409)`,
      );
      setStage('form');
      return;
    }
    if (restoreRes.status === 400) {
      setError('Сервер не создан: проверьте идентификатор и отображаемое имя');
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
    await installServer(restoreBody.id);
  }

  async function installServer(serverId: string) {
    setError(null);
    setRetryStep('install');
    setStage('installing');
    const installRes = await fetch(`/api/v1/servers/${serverId}/install`, {
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
      `${proto}://${window.location.host}/api/v1/servers/${serverId}/install/ws`,
    );
    wsRef.current = ws;
    let done = false;
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data) as Partial<InstallProgressLine> & {
          done?: boolean;
          final?: string;
          error?: string;
        };
        if (frame.error) {
          done = true;
          setError(String(frame.error));
          setStage('error');
          ws.close();
          return;
        }
        if (frame.done) {
          done = true;
          ws.close();
          if (frame.final === 'done') {
            void overlayConfigs(serverId);
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
    // A close without a prior `done`/`error` frame (dropped connection, or the
    // backend replaying only a terminal snapshot) must not leave the wizard
    // stuck on "Установка…" with no way forward (#660).
    ws.onclose = () => {
      if (done) return;
      setError('Соединение с установкой закрылось раньше отчёта о завершении');
      setStage('error');
    };
  }

  async function overlayConfigs(targetId: string) {
    setError(null);
    setRetryStep('restore-configs');
    setStage('restoring-configs');
    try {
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
    } catch (err) {
      setError(`Не удалось наложить бэкап конфигов: ${(err as Error).message}`);
      setStage('error');
    }
  }

  async function startServer() {
    if (!newServerId) return;
    setError(null);
    setRetryStep('restart');
    setStage('starting');
    // /restart, not /start: install() already starts the container, and
    // overlayConfigs() has since written the archived Server.cfg/Admins.cfg
    // over it — only a restart (stop + start) picks those up (#659).
    const r = await fetch(`/api/v1/servers/${newServerId}/restart`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      setError(`Не удалось перезапустить сервер (HTTP ${r.status})`);
      setStage('error');
      return;
    }
    setStage('done');
    router.push(`/servers/${newServerId}`);
  }

  function retryFailedStep() {
    if (!newServerId || !retryStep) return;
    if (retryStep === 'install') void installServer(newServerId);
    else if (retryStep === 'restore-configs') void overlayConfigs(newServerId);
    else void startServer();
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
        {missingPermissions.length > 0 && (
          <InlineBanner
            tone="warn"
            title="Недостаточно прав для восстановления"
            description={`Нужны права: ${REQUIRED_PERMISSIONS.join(', ')}. Не хватает: ${missingPermissions.join(', ')}.`}
          />
        )}
        <Card as="section">
          <form onSubmit={submit} className="space-y-4">
            <FieldRow label="Идентификатор нового сервера" required>
              <TextInput
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                pattern="^[a-z0-9][a-z0-9-]{0,63}$"
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
              <Button type="submit" variant="primary" disabled={missingPermissions.length > 0}>
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
      {stage === 'error' && newServerId ? (
        <div className="flex justify-end gap-2">
          <Button onClick={() => router.push(`/servers/${newServerId}`)}>Открыть сервер</Button>
          <Button variant="primary" onClick={retryFailedStep}>
            Повторить шаг
          </Button>
        </div>
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
