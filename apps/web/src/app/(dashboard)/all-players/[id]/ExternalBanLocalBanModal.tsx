'use client';

import { useEffect, useId, useState } from 'react';
import {
  Button,
  FieldRow,
  InlineBanner,
  Modal,
  Select,
  Textarea,
  TextInput,
} from '@/components/ui';
import { apiFetch, apiResult, describeHttpError } from '@/lib/api';

interface ServerSummary {
  id: string;
  display_name: string;
}

/**
 * Russian messages for the local-ban route's stable error codes (#443): the
 * UI is Russian-only, and `body.error` values like `external_ban_inactive`
 * or Fastify's generic `Bad Request` are neither.
 */
const LOCAL_BAN_ERROR_MESSAGES_RU: Record<string, string> = {
  player_not_found: 'Игрок не найден.',
  external_ban_not_found: 'Внешний бан не найден или уже не относится к этому игроку.',
  external_ban_inactive: 'Внешний бан уже неактивен.',
  server_not_found: 'Выбранный сервер не найден.',
  target_identity_missing: 'У игрока нет SteamID или EOS ID для отправки команды.',
  action_failed: 'Сервер не выполнил команду AdminBan.',
};

/** Turns a `POST .../local-ban` error response into a Russian message. */
function describeLocalBanError(
  status: number,
  body: { error?: string; message?: string } | null,
): string {
  if (status === 400) return body?.message ?? 'Некорректные данные формы.';
  const code = body?.error;
  const message = code ? LOCAL_BAN_ERROR_MESSAGES_RU[code] : undefined;
  if (message) return message;
  return `Ошибка сервера (HTTP ${status}).`;
}

interface ServersResponse {
  items: ServerSummary[];
}

export interface ExternalBanLocalBanTarget {
  id: string;
  sourceName: string;
  reason: string | null;
}

interface ExternalBanLocalBanModalProps {
  playerId: string;
  target: ExternalBanLocalBanTarget | null;
  onClose: () => void;
  onBanned: (serverName: string) => void;
}

/**
 * CBAN-4 confirmation form for turning an active external-ban match into a
 * local Squad ban. It preloads the external source/reason, requires an
 * explicit server choice, and submits through the audited AdminBan API.
 *
 * Поля живут в настоящей `<form>` внутри окна, а подтверждающая кнопка стоит в
 * подвале и связана с ней атрибутом `form`: подвал диалога по HIG находится
 * вне прокручиваемого содержимого, но проверка `pattern` у срока бана должна
 * остаться браузерной, а не переехать в самодельную валидацию.
 */
export function ExternalBanLocalBanModal({
  playerId,
  target,
  onClose,
  onBanned,
}: ExternalBanLocalBanModalProps) {
  const formId = useId();
  const serverFieldId = useId();
  const reasonFieldId = useId();
  const lengthFieldId = useId();
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [serverId, setServerId] = useState('');
  const [reason, setReason] = useState('');
  const [banLength, setBanLength] = useState('0');
  const [loadingServers, setLoadingServers] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setReason(`${target.sourceName}: ${target.reason ?? 'внешний бан'}`.slice(0, 300));
    setBanLength('0');
    setServerId('');
    setServers([]);
    setError(null);
    setLoadingServers(true);

    apiFetch<ServersResponse>('/api/v1/servers')
      .then((body) => {
        if (cancelled) return;
        // No server is preselected (#442): AdminBan is destructive, and the
        // docstring's "requires an explicit server choice" only holds if the
        // operator has to pick one — the confirm button stays disabled via
        // `!serverId` until they do.
        setServers(body.items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(`Не удалось загрузить серверы: ${describeHttpError(cause)}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingServers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!target) return null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || !serverId) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiResult<void>(
        `/api/v1/players/${playerId}/external-bans/${target.id}/local-ban`,
        {
          method: 'POST',
          json: {
            server_id: serverId,
            reason: reason.trim(),
            ban_length: banLength.trim() || '0',
          },
          discardBody: true,
        },
      );
      if (!response.ok) {
        const body = response.error.jsonBody<{ error?: string; message?: string }>();
        throw new Error(describeLocalBanError(response.error.status, body));
      }
      const serverName = servers.find((server) => server.id === serverId)?.display_name ?? serverId;
      onBanned(serverName);
    } catch (cause) {
      setError(describeHttpError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Забанить локально"
      description={`Источник: ${target.sourceName}. Команда AdminBan будет отправлена на выбранный сервер.`}
      closeLabel="Закрыть"
      dismissible={!submitting}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Отмена
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="destructive"
            loading={submitting}
            disabled={loadingServers || !serverId || !reason.trim()}
          >
            Забанить
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        <FieldRow label="Сервер" htmlFor={serverFieldId} required>
          <Select
            id={serverFieldId}
            value={serverId}
            onChange={(event) => setServerId(event.target.value)}
            disabled={loadingServers || servers.length === 0 || submitting}
            required
          >
            {servers.length === 0 ? (
              <option value="">Серверы недоступны</option>
            ) : (
              <option value="" disabled>
                Выберите сервер
              </option>
            )}
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.display_name}
              </option>
            ))}
          </Select>
        </FieldRow>

        <FieldRow label="Причина" htmlFor={reasonFieldId} required>
          <Textarea
            id={reasonFieldId}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            maxLength={300}
            disabled={submitting}
            rows={3}
          />
        </FieldRow>

        <FieldRow label="Срок" htmlFor={lengthFieldId} hint="0 — навсегда, например 7d" required>
          <TextInput
            id={lengthFieldId}
            value={banLength}
            onChange={(event) => setBanLength(event.target.value)}
            required
            pattern="\d+[smhdwMy]?"
            disabled={submitting}
            className="font-mono"
          />
        </FieldRow>

        {error ? <InlineBanner tone="crit" title="Ошибка" description={error} /> : null}
      </form>
    </Modal>
  );
}
