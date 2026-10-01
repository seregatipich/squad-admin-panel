import { type LogSourceView, logSourceView } from '@squad/shared-types';
import { useEffect, useState } from 'react';
import {
  AlertDialog,
  Badge,
  type BadgeTone,
  Button,
  FieldRow,
  GroupedList,
  GroupedRow,
  InlineBanner,
  Switch,
  Textarea,
  TextInput,
} from '@/components/ui';
import { apiResult, describeHttpError } from '@/lib/api';
import { describeSettingsError, fetchValidated } from './helpers';
import { useSavedFlag } from './useSavedFlag';

interface LogSourceDraft {
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  log_path: string;
  enabled: boolean;
}

const LOG_SOURCE_DEFAULTS: LogSourceDraft = {
  ssh_host: '',
  ssh_port: 22,
  ssh_user: 'squad',
  log_path: '/opt/squad1/SquadGame/Saved/Logs/SquadGame.log',
  enabled: true,
};

/** Состояние SSH-хвоста словами; тон дублирует подпись (§5). */
const LOG_SOURCE_STATE: Record<string, { tone: BadgeTone; label: string }> = {
  connected: { tone: 'good', label: 'читается' },
  connecting: { tone: 'warn', label: 'подключение' },
  error: { tone: 'crit', label: 'ошибка' },
};

/**
 * Источник логов внешнего сервера: SSH-хвост SquadGame.log на игровом хосте.
 * Есть только у внешнего сервера; для контейнерного API отвечает 409, поэтому
 * страница монтирует секцию только для `runtime === 'external'`.
 */
export function LogSourceSection({ serverId }: { serverId: string }) {
  const [logSource, setLogSource] = useState<LogSourceView | null>(null);
  const [logSourceDraft, setLogSourceDraft] = useState<LogSourceDraft>(LOG_SOURCE_DEFAULTS);
  const [logSourceDirty, setLogSourceDirty] = useState(false);
  const [logSourceBusy, setLogSourceBusy] = useState(false);
  const [logSourceErr, setLogSourceErr] = useState<string | null>(null);
  const [logSourceLoadFailed, setLogSourceLoadFailed] = useState(false);
  const [logSourceSaved, flashLogSourceSaved, clearLogSourceSaved] = useSavedFlag();
  const [logSourceConfirm, setLogSourceConfirm] = useState<'regenerate' | 'remove' | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchValidated(
          `/api/v1/servers/${serverId}/log-source`,
          logSourceView,
          'источник логов',
        );
        if (cancelled) return;
        setLogSource(data);
        if (data.configured) {
          setLogSourceDraft({
            ssh_host: data.ssh_host ?? '',
            ssh_port: data.ssh_port ?? 22,
            ssh_user: data.ssh_user ?? 'squad',
            log_path: data.log_path ?? LOG_SOURCE_DEFAULTS.log_path,
            enabled: data.enabled ?? true,
          });
        }
      } catch (e) {
        if (cancelled) return;
        // Пустая форма без блокировки перезаписала бы уже настроенный источник значениями по умолчанию.
        setLogSourceLoadFailed(true);
        setLogSourceErr(`Не удалось загрузить источник логов: ${describeHttpError(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  async function saveLogSource(regenerateKey = false) {
    setLogSourceBusy(true);
    setLogSourceErr(null);
    try {
      setLogSource(
        await fetchValidated(
          `/api/v1/servers/${serverId}/log-source`,
          logSourceView,
          'источник логов',
          {
            method: 'PUT',
            json: { ...logSourceDraft, regenerate_key: regenerateKey },
          },
        ),
      );
      setLogSourceDirty(false);
      flashLogSourceSaved();
    } catch (e) {
      setLogSourceErr(describeSettingsError(e));
    } finally {
      setLogSourceBusy(false);
    }
  }

  async function removeLogSource() {
    setLogSourceBusy(true);
    setLogSourceErr(null);
    try {
      const res = await apiResult<unknown>(`/api/v1/servers/${serverId}/log-source`, {
        method: 'DELETE',
        discardBody: true,
      });
      if (!res.ok && res.error.status !== 404) throw new Error(`HTTP ${res.error.status}`);
      setLogSource({ configured: false, status: null });
      setLogSourceDraft(LOG_SOURCE_DEFAULTS);
      setLogSourceDirty(false);
    } catch (e) {
      setLogSourceErr(describeHttpError(e));
    } finally {
      setLogSourceBusy(false);
    }
  }

  function setLogSourceField<K extends keyof LogSourceDraft>(key: K, value: LogSourceDraft[K]) {
    setLogSourceDraft((prev) => ({ ...prev, [key]: value }));
    setLogSourceDirty(true);
    clearLogSourceSaved();
  }

  return (
    <div className="space-y-3">
      {logSourceErr ? <InlineBanner tone="crit" title={logSourceErr} /> : null}
      {logSourceSaved ? <InlineBanner tone="good" title="Источник логов сохранён" /> : null}
      <GroupedList
        title="Источник логов (SSH)"
        footnote="worker-log-ingest подключается к игровому хосту по SSH и читает SquadGame.log командой tail -F — так же, как бот соперника читает консоль в screen. Бой, ранения, коннекты и матчи появятся после того, как публичный ключ панели добавят в ~/.ssh/authorized_keys пользователя на хосте."
      >
        {logSource?.configured ? (
          <GroupedRow
            label="Состояние"
            description={
              logSource.status?.error
                ? logSource.status.error
                : logSource.status?.last_line_at
                  ? `Последняя строка: ${new Date(logSource.status.last_line_at).toLocaleString('ru-RU')}`
                  : 'worker-log-ingest ещё не отчитался'
            }
            control={
              <Badge tone={LOG_SOURCE_STATE[logSource.status?.state ?? '']?.tone ?? 'neutral'}>
                {LOG_SOURCE_STATE[logSource.status?.state ?? '']?.label ?? 'нет данных'}
              </Badge>
            }
          />
        ) : null}
        <GroupedRow
          label="Хост SSH"
          description="Имя хоста или IP игрового сервера"
          control={
            <div className="w-56">
              <TextInput
                aria-label="Хост SSH"
                value={logSourceDraft.ssh_host}
                onChange={(e) => setLogSourceField('ssh_host', e.target.value.trim())}
                autoComplete="off"
              />
            </div>
          }
        />
        <GroupedRow
          label="Порт SSH"
          control={
            <div className="w-28">
              <TextInput
                type="number"
                aria-label="Порт SSH"
                value={logSourceDraft.ssh_port}
                onChange={(e) => setLogSourceField('ssh_port', Number(e.target.value))}
                min={1}
                max={65535}
              />
            </div>
          }
        />
        <GroupedRow
          label="Пользователь SSH"
          control={
            <div className="w-56">
              <TextInput
                aria-label="Пользователь SSH"
                value={logSourceDraft.ssh_user}
                onChange={(e) => setLogSourceField('ssh_user', e.target.value.trim())}
                autoComplete="off"
              />
            </div>
          }
        />
        <div className="px-4 py-3">
          <FieldRow
            label="Путь к SquadGame.log"
            hint="Абсолютный путь на игровом хосте; допустимы латиница, цифры, точка, дефис, подчёркивание."
          >
            <TextInput
              value={logSourceDraft.log_path}
              onChange={(e) => setLogSourceField('log_path', e.target.value.trim())}
              placeholder="/opt/squad1/SquadGame/Saved/Logs/SquadGame.log"
            />
          </FieldRow>
        </div>
        <GroupedRow
          label="Читать логи"
          description="Выключите, чтобы остановить хвост, не удаляя настройки"
          control={
            <Switch
              checked={logSourceDraft.enabled}
              onChange={(next) => setLogSourceField('enabled', next)}
              label="Читать логи"
            />
          }
        />
        {logSource?.configured && logSource.public_key ? (
          <div className="px-4 py-3">
            <FieldRow
              label="Публичный ключ панели"
              hint={`Добавьте эту строку в ~/.ssh/authorized_keys пользователя ${logSourceDraft.ssh_user || 'squad'} на игровом хосте. Ключ №${logSource.key_version ?? 1}${logSource.host_key_fingerprint ? `, отпечаток хоста ${logSource.host_key_fingerprint}` : ''}.`}
            >
              <Textarea
                value={logSource.public_key}
                readOnly
                rows={3}
                aria-label="Публичный ключ панели"
              />
            </FieldRow>
          </div>
        ) : null}
      </GroupedList>
      <AlertDialog
        open={logSourceConfirm !== null}
        onClose={() => setLogSourceConfirm(null)}
        title={logSourceConfirm === 'remove' ? 'Удалить источник логов' : 'Перевыпустить ключ'}
        body={
          logSourceConfirm === 'remove'
            ? 'Настройки SSH-источника и ключ панели будут удалены, сбор логов остановится.'
            : 'Прежний ключ перестанет работать: доступ по уже добавленной строке в authorized_keys пропадёт, пока новый ключ не будет добавлен на хост.'
        }
        confirmLabel={
          logSourceConfirm === 'remove' ? 'Удалить источник' : 'Перевыпустить и сбросить доступ'
        }
        cancelLabel="Отмена"
        tone="destructive"
        busy={logSourceBusy}
        onConfirm={async () => {
          const action = logSourceConfirm;
          if (action === 'remove') await removeLogSource();
          else await saveLogSource(true);
          setLogSourceConfirm(null);
        }}
      />
      <div className="flex justify-end gap-2">
        {logSource?.configured ? (
          <>
            <Button disabled={logSourceBusy} onClick={() => setLogSourceConfirm('remove')}>
              Удалить источник
            </Button>
            <Button disabled={logSourceBusy} onClick={() => setLogSourceConfirm('regenerate')}>
              Перевыпустить ключ
            </Button>
          </>
        ) : null}
        <Button
          variant="primary"
          disabled={logSourceLoadFailed || (!logSourceDirty && !!logSource?.configured)}
          loading={logSourceBusy}
          onClick={() => saveLogSource(false)}
        >
          {logSource?.configured ? 'Сохранить источник' : 'Создать источник и ключ'}
        </Button>
      </div>
    </div>
  );
}
