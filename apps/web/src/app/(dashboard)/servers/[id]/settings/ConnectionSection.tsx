import { type ExternalConnectionResponse, externalConnectionResponse } from '@squad/shared-types';
import { useState } from 'react';
import { Button, GroupedList, GroupedRow, InlineBanner, TextInput } from '@/components/ui';
import { describeSettingsError, fetchValidated } from './helpers';
import { useSavedFlag } from './useSavedFlag';

/** Черновик правок RCON-подключения внешнего сервера; пустой пароль = не менять. */
interface ConnectionDraft {
  rcon_host?: string;
  rcon_port?: number;
  rcon_password?: string;
  query_port?: number;
  game_port?: number;
}

interface ConnectionSectionProps {
  serverId: string;
  /** Сохранённый адрес RCON; `null` — подключение ещё не задано. */
  rconHost: string | null;
  rconPort: number;
  queryPort: number;
  gamePort: number;
  /** Вызывается с ответом API после успешного сохранения, чтобы страница обновила свои данные. */
  onSaved: (updated: ExternalConnectionResponse) => void;
}

/** RCON-подключение внешнего сервера со своим состоянием сохранения. */
export function ConnectionSection({
  serverId,
  rconHost,
  rconPort,
  queryPort,
  gamePort,
  onSaved,
}: ConnectionSectionProps) {
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft>({});
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionErr, setConnectionErr] = useState<string | null>(null);
  const [connectionSaved, flashConnectionSaved, clearConnectionSaved] = useSavedFlag();
  const connectionDirty = Object.keys(connectionDraft).length > 0;

  async function saveConnection() {
    setConnectionBusy(true);
    setConnectionErr(null);
    try {
      onSaved(
        await fetchValidated(
          `/api/v1/servers/${serverId}/external-connection`,
          externalConnectionResponse,
          'подключение',
          { method: 'PUT', json: connectionDraft },
        ),
      );
      setConnectionDraft({});
      flashConnectionSaved();
    } catch (e) {
      setConnectionErr(describeSettingsError(e));
    } finally {
      setConnectionBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {connectionErr ? <InlineBanner tone="crit" title={connectionErr} /> : null}
      {connectionSaved ? <InlineBanner tone="good" title="Подключение сохранено" /> : null}
      <GroupedList
        title="RCON-подключение"
        footnote="Внешний сервер: панель не управляет его процессом, а подключается по этим параметрам. worker-rcon переподключится в течение 15 секунд после сохранения."
      >
        <GroupedRow
          label="Адрес RCON"
          description="Имя хоста или IP"
          control={
            <div className="w-56">
              <TextInput
                aria-label="Адрес RCON"
                value={connectionDraft.rcon_host ?? rconHost ?? ''}
                onChange={(e) => {
                  setConnectionDraft((prev) => ({ ...prev, rcon_host: e.target.value.trim() }));
                  clearConnectionSaved();
                }}
                autoComplete="off"
              />
            </div>
          }
        />
        <GroupedRow
          label="Порт RCON"
          description="TCP"
          control={
            <div className="w-28">
              <TextInput
                type="number"
                aria-label="Порт RCON"
                value={connectionDraft.rcon_port ?? rconPort}
                onChange={(e) => {
                  setConnectionDraft((prev) => ({
                    ...prev,
                    rcon_port: Number(e.target.value),
                  }));
                  clearConnectionSaved();
                }}
                min={1}
                max={65535}
              />
            </div>
          }
        />
        <GroupedRow
          label="Пароль RCON"
          description="Пустое поле — оставить сохранённый"
          control={
            <div className="w-56">
              <TextInput
                type="password"
                aria-label="Пароль RCON"
                value={connectionDraft.rcon_password ?? ''}
                onChange={(e) => {
                  const next = e.target.value;
                  setConnectionDraft((prev) => {
                    const { rcon_password: _drop, ...rest } = prev;
                    return next === '' ? rest : { ...rest, rcon_password: next };
                  });
                  clearConnectionSaved();
                }}
                autoComplete="new-password"
                placeholder="••••••••  (сохранён)"
              />
            </div>
          }
        />
        <GroupedRow
          label="Порт запросов"
          description="UDP, A2S"
          control={
            <div className="w-28">
              <TextInput
                type="number"
                aria-label="Порт запросов"
                value={connectionDraft.query_port ?? queryPort}
                onChange={(e) => {
                  setConnectionDraft((prev) => ({
                    ...prev,
                    query_port: Number(e.target.value),
                  }));
                  clearConnectionSaved();
                }}
                min={1}
                max={65535}
              />
            </div>
          }
        />
        <GroupedRow
          label="Игровой порт"
          description="UDP"
          control={
            <div className="w-28">
              <TextInput
                type="number"
                aria-label="Игровой порт"
                value={connectionDraft.game_port ?? gamePort}
                onChange={(e) => {
                  setConnectionDraft((prev) => ({
                    ...prev,
                    game_port: Number(e.target.value),
                  }));
                  clearConnectionSaved();
                }}
                min={1}
                max={65535}
              />
            </div>
          }
        />
      </GroupedList>
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!connectionDirty}
          loading={connectionBusy}
          onClick={saveConnection}
        >
          Сохранить подключение
        </Button>
      </div>
    </div>
  );
}
