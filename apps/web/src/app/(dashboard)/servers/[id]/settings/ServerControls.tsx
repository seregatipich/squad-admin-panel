'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ForceStopDialog } from '@/components/ForceStopDialog';
import { UpdateProgressModal } from '@/components/UpdateProgressModal';
import {
  AlertDialog,
  Button,
  ChevronDownIcon,
  GroupedList,
  IconButton,
  InlineBanner,
  Menu,
} from '@/components/ui';
import { useLiveSubscription } from '@/lib/use-live-bus';

interface ServerSnapshot {
  display_name: string;
  status: string;
  /** `external` — размещён вне панели: жизненным циклом управляет его хост. */
  runtime?: string;
}

const POLL_INTERVAL_MS = 3000;

/**
 * Управление жизненным циклом сервера: старт, стоп (обычный и принудительный),
 * рестарт, обновление игры и удаление.
 *
 * Живёт в «Настройках», а не на обзоре: к кнопкам обращаются редко, а обзор
 * отдан тому, что меняется во время матча. Статус сервера нужен только для
 * того, чтобы включать и выключать кнопки, поэтому компонент сам опрашивает
 * `GET /api/v1/servers/:id` и слушает `server.status` — после старта кнопки
 * переключаются без перезагрузки страницы.
 *
 * @param serverId — uuid сервера.
 */
export function ServerControls({ serverId }: { serverId: string }) {
  const router = useRouter();
  const [server, setServer] = useState<ServerSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [forceStopOpen, setForceStopOpen] = useState(false);
  const [dangerMenuOpen, setDangerMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateRunning, setUpdateRunning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/servers/${serverId}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { server: ServerSnapshot };
      setServer({
        display_name: body.server.display_name,
        status: body.server.status,
        runtime: body.server.runtime,
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [serverId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const onLiveStatus = useCallback(
    (event: { data: { server_id: string; status: string } }) => {
      if (event.data.server_id !== serverId) return;
      setServer((prev) => (prev ? { ...prev, status: event.data.status } : prev));
    },
    [serverId],
  );
  useLiveSubscription('server.status', onLiveStatus);

  if (!server) return null;

  const external = server.runtime === 'external';
  const canStart = server.status !== 'running' && server.status !== 'starting';
  const canStop = server.status === 'running' || server.status === 'starting';

  async function action(name: 'start' | 'stop' | 'restart' | 'delete') {
    setActing(name);
    try {
      const method = name === 'delete' ? 'DELETE' : 'POST';
      const r = await fetch(`/api/v1/servers/${serverId}${name === 'delete' ? '' : `/${name}`}`, {
        method,
        credentials: 'include',
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify({}) : undefined,
      });
      if (!r.ok) {
        const text = await r.text();
        setErr(`${name} failed: HTTP ${r.status} ${text}`);
      } else {
        setErr(null);
        if (name === 'delete') {
          // У внешнего сервера нет резервной копии конфигов — в архиве смотреть нечего.
          router.push(external ? '/servers' : `/servers/archive/${serverId}`);
          return;
        }
      }
      await refresh();
    } finally {
      setActing(null);
    }
  }

  async function startUpdate() {
    if (updateRunning) {
      setUpdateModalOpen(true);
      return;
    }
    setActing('update');
    try {
      const r = await fetch(`/api/v1/servers/${serverId}/update`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setUpdateRunning(true);
      setUpdateModalOpen(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="space-y-3">
      {err ? <InlineBanner tone="crit" title={err} /> : null}
      <GroupedList
        title="Управление"
        footnote={
          external
            ? 'Внешний сервер: запуск и остановка выполняются на его хосте, панель управляет им по RCON.'
            : undefined
        }
      >
        {/* Опасное действие отодвинуто в правый край и не соседствует с
            «Рестартом»: промах мышью не должен стоить сервера. */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          {external ? null : (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => action('start')}
                disabled={!canStart || !!acting}
                loading={acting === 'start'}
              >
                Старт
              </Button>
              <div className="flex items-center gap-1">
                <Button
                  onClick={() => action('stop')}
                  disabled={!canStop || !!acting}
                  loading={acting === 'stop'}
                >
                  Стоп
                </Button>
                <IconButton
                  icon={<ChevronDownIcon />}
                  label="Принудительная остановка"
                  disabled={!canStop || !!acting}
                  onClick={() => setForceStopOpen(true)}
                />
              </div>
              <Button
                onClick={() => action('restart')}
                disabled={!canStop || !!acting}
                loading={acting === 'restart'}
              >
                Рестарт
              </Button>
              {server.status === 'stopped' || updateRunning ? (
                <Button onClick={() => void startUpdate()} disabled={acting !== null}>
                  {acting === 'update'
                    ? 'Запуск обновления...'
                    : updateRunning
                      ? 'Обновление... (открыть лог)'
                      : 'Обновить игру'}
                </Button>
              ) : null}
            </div>
          )}
          <div className="ml-auto">
            <Menu
              trigger={{ label: 'Опасная зона' }}
              open={dangerMenuOpen}
              onOpenChange={setDangerMenuOpen}
              align="end"
              items={[
                {
                  kind: 'action',
                  label: 'Удалить сервер',
                  hint: external ? 'Сервер будет убран из панели' : 'Файлы на диске будут стёрты',
                  tone: 'destructive',
                  disabled: !!acting,
                  onSelect: () => setDeleteOpen(true),
                },
              ]}
            />
          </div>
        </div>
      </GroupedList>

      <UpdateProgressModal
        open={updateModalOpen}
        onOpenChange={setUpdateModalOpen}
        wsUrl="/api/v1/depot/progress/ws"
        title="Обновление игры"
        onDone={() => {
          setUpdateRunning(false);
          void refresh();
        }}
      />

      <ForceStopDialog
        open={forceStopOpen}
        onOpenChange={setForceStopOpen}
        serverName={server.display_name}
        onConfirm={async () => {
          const r = await fetch(`/api/v1/servers/${serverId}/force-stop`, {
            method: 'POST',
            credentials: 'include',
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          void refresh();
        }}
      />

      {/* Удаление стирает файлы сервера с диска, поэтому здесь стоит ввод
          точного имени — необратимую операцию нельзя запустить не глядя. */}
      <AlertDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Удалить сервер"
        body={
          external
            ? 'Сервер будет убран из панели: опрос RCON остановится, история игроков останется. На хосте самого сервера ничего не изменится.'
            : 'Файлы сервера на диске будут стёрты. Резервная копия .cfg останется в архиве серверов.'
        }
        confirmLabel="Удалить сервер"
        cancelLabel="Отмена"
        tone="destructive"
        busy={acting === 'delete'}
        challenge={{
          expected: server.display_name,
          label: 'Введите имя сервера',
          hint: `Ожидается: ${server.display_name}`,
        }}
        onConfirm={async () => {
          await action('delete');
          setDeleteOpen(false);
        }}
      />
    </div>
  );
}
