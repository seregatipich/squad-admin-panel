'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
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
import { apiResult, describeHttpError } from '@/lib/api';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { useApiResource } from '@/lib/use-polled-resource';

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
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [forceStopOpen, setForceStopOpen] = useState(false);
  const [dangerMenuOpen, setDangerMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateRunning, setUpdateRunning] = useState(false);

  // `server.status` already pushes every status change live (below); this
  // poll is only a backstop, so it skips ticks while the tab is hidden instead
  // of hammering the bridge/docker daemon for a screen no one is watching
  // (#641). The hook also never lets a tick overlap a request still in flight:
  // the route is expensive (containerInspect + docker stats via the privileged
  // bridge) and must not pile up behind a slow response.
  const snapshot = useApiResource<{ server: ServerSnapshot }>(`/api/v1/servers/${serverId}`, {
    intervalMs: POLL_INTERVAL_MS,
    pauseWhenHidden: true,
  });
  const server = snapshot.data?.server ?? null;
  const pollErr = snapshot.errorMessage;
  const { refresh, setData: setSnapshot } = snapshot;

  const onLiveStatus = useCallback(
    (event: { data: { server_id: string; status: string } }) => {
      if (event.data.server_id !== serverId) return;
      setSnapshot((prev) =>
        prev ? { server: { ...prev.server, status: event.data.status } } : prev,
      );
    },
    [serverId, setSnapshot],
  );
  useLiveSubscription('server.status', onLiveStatus);

  if (!server) return null;

  const external = server.runtime === 'external';
  const canStart =
    server.status === 'stopped' || server.status === 'ready' || server.status === 'failed';
  const canStop = server.status === 'running' || server.status === 'starting';

  async function action(name: 'start' | 'stop' | 'restart' | 'delete') {
    setActing(name);
    try {
      const method = name === 'delete' ? 'DELETE' : 'POST';
      const r = await apiResult<unknown>(
        `/api/v1/servers/${serverId}${name === 'delete' ? '' : `/${name}`}`,
        { method, json: method === 'POST' ? {} : undefined, discardBody: true },
      );
      if (!r.ok) {
        setErr(`${name} failed: HTTP ${r.error.status} ${r.error.responseText}`);
      } else {
        setErr(null);
        if (name === 'delete') {
          // У внешнего сервера нет резервной копии конфигов — в архиве смотреть нечего.
          router.push(external ? '/servers' : `/servers/archive/${serverId}`);
          return;
        }
      }
      await refresh();
    } catch (e) {
      setErr(`${name} failed: ${describeHttpError(e)}`);
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
      const r = await apiResult<unknown>(`/api/v1/servers/${serverId}/update`, {
        method: 'POST',
        discardBody: true,
      });
      if (!r.ok) {
        const body = r.error.jsonBody<{ error?: string; server_ids?: string[] }>();
        // The depot is one volume shared by every server on the host, so the
        // API refuses while any other server is live (#20).
        if (body?.error === 'servers_running') {
          throw new Error(
            `Обновление меняет общий depot всех серверов хоста. Сначала остановите запущенные серверы: ${body.server_ids?.length ?? 0}.`,
          );
        }
        if (body?.error === 'depot_update_in_progress') {
          setUpdateRunning(true);
          setUpdateModalOpen(true);
          return;
        }
        throw new Error(`HTTP ${r.error.status}`);
      }
      setUpdateRunning(true);
      setUpdateModalOpen(true);
    } catch (e) {
      setErr(describeHttpError(e));
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="space-y-3">
      {(err ?? pollErr) ? <InlineBanner tone="crit" title={err ?? pollErr ?? ''} /> : null}
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
              {server.status === 'stopped' || server.status === 'ready' || updateRunning ? (
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
          const r = await apiResult<unknown>(`/api/v1/servers/${serverId}/force-stop`, {
            method: 'POST',
            discardBody: true,
          });
          // The dialog shows this message, so carry the API's error code.
          if (!r.ok) {
            const body = r.error.jsonBody<{ error?: string }>();
            throw new Error(body?.error ?? `HTTP ${r.error.status}`);
          }
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
