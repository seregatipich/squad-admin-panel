'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  BAN_LENGTHS,
  type BulkModerationTarget,
  TARGET_ERROR_LABEL,
} from '@/components/BulkModerationModal';
import { AlertDialog, FieldRow, Select, Textarea } from '@/components/ui';
import { ApiError, ApiResponseError, apiFetch } from '@/lib/api';

/** Действие модерации над одним игроком прямо из строки ростера. */
export type QuickAction = 'warn' | 'kick' | 'ban';

export interface QuickRequest {
  action: QuickAction;
  target: BulkModerationTarget;
}

const QUICK_TITLE: Record<QuickAction, string> = {
  warn: 'Предупредить игрока',
  kick: 'Кикнуть игрока',
  ban: 'Забанить игрока',
};

/** Подпись подтверждающей кнопки называет действие, а не отвечает «Да» (§5). */
const QUICK_CONFIRM: Record<QuickAction, string> = {
  warn: 'Предупредить',
  kick: 'Кик',
  ban: 'Забанить',
};

const QUICK_EXPLANATION: Record<QuickAction, string> = {
  warn: 'Игрок получит предупреждение в игре. Причина попадёт в его карточку.',
  kick: 'Игрок будет отключён от сервера и сможет вернуться сразу же.',
  ban: 'Игрок будет отключён и не сможет зайти до конца срока бана.',
};

interface BulkResponse {
  applied: number;
  failed: number;
  results: Array<{
    player_id: string;
    status: 'applied' | 'failed';
    error?: string;
    detail?: string;
  }>;
}

/** Какие быстрые действия доступны обладателю этих `mod:*` ключей. */
export function quickAbilities(permissions: readonly string[]) {
  return {
    warn: permissions.includes('mod:warn'),
    kick: permissions.includes('mod:kick'),
    ban: permissions.includes('mod:ban_temp') || permissions.includes('mod:ban_perm'),
  };
}

/** Русские подписи ошибок уровня запроса; всё остальное — общий текст с кодом HTTP. */
const REQUEST_ERROR_LABEL: Record<string, string> = {
  forbidden: 'Недостаточно прав для этого действия',
  server_not_found: 'Сервер не найден',
};

/**
 * Одиночное действие модерации из строки ростера (предупреждение, кик, бан).
 *
 * Ходит в тот же `POST /api/v1/moderation-actions/bulk`, что и массовое окно,
 * со списком из одной цели, — сознательно: этот путь охраняется ключами `mod:*`,
 * которые есть у страницы, тогда как одиночный `POST /api/v1/players/:id/moderation-actions`
 * требует squad-права `kick`/`ban`. Из-за этого в журнале аудита такое действие
 * записывается как `moderation.bulk_action` с `bulk_size=1`, а клиент шлёт
 * `confirm_bulk: true` как серверную половину подтверждения. Челленджа с количеством целей тут
 * нет — он охраняет массовый бан, где ошибка стоит десятков игроков; здесь
 * достаточно подтверждения и обязательной причины, которую всё равно требует
 * схема запроса.
 */
export function QuickModerationDialog({
  serverId,
  request,
  permissions,
  onClose,
  onApplied,
}: {
  serverId: string;
  /** `null`, пока окно закрыто. */
  request: QuickRequest | null;
  permissions: readonly string[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const [reason, setReason] = useState('');
  const [banLength, setBanLength] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const lengthId = useId();

  const canBanTemp = permissions.includes('mod:ban_temp');
  const canBanPerm = permissions.includes('mod:ban_perm');
  const banLengths = useMemo(
    () => BAN_LENGTHS.filter((entry) => (entry.permanent ? canBanPerm : canBanTemp)),
    [canBanPerm, canBanTemp],
  );

  const open = request !== null;
  // Причина и срок сбрасываются на каждое открытие: текст, набранный для
  // прошлого игрока, не должен уехать следующему.
  useEffect(() => {
    if (!open) return;
    setReason('');
    setBanLength(banLengths[0]?.value ?? '0');
    setError(null);
  }, [open, banLengths]);

  if (!request) return null;

  const { action, target } = request;

  async function submit() {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setError('Укажите причину — она попадёт в карточку игрока и в журнал действий.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let body: BulkResponse | null;
      try {
        body = await apiFetch<BulkResponse>('/api/v1/moderation-actions/bulk', {
          method: 'POST',
          json: {
            server_id: serverId,
            action_type: action,
            player_ids: [target.playerId],
            reason: trimmed,
            ban_length: action === 'ban' ? banLength : '0',
            confirm_bulk: true,
          },
        });
      } catch (requestError) {
        if (requestError instanceof ApiError) {
          const failed = requestError.jsonBody<{ error?: string }>() ?? {};
          throw new Error(
            REQUEST_ERROR_LABEL[failed.error ?? ''] ??
              `Не удалось применить (HTTP ${requestError.status})`,
          );
        }
        if (requestError instanceof ApiResponseError) body = null;
        else throw requestError;
      }
      // Запрос не транзакционный: 200 приходит и тогда, когда единственная
      // цель не была задета, — причина лежит в `results[0].error`.
      if (!Array.isArray(body?.results)) throw new Error('Некорректный ответ сервера');
      const failure = body.results.find((row) => row.status === 'failed');
      if (failure) {
        const label =
          TARGET_ERROR_LABEL[failure.error ?? ''] ?? failure.error ?? 'Не удалось применить';
        setError(failure.detail ? `${label} (${failure.detail})` : label);
        return;
      }
      onApplied();
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onClose={onClose}
      title={QUICK_TITLE[action]}
      confirmLabel={QUICK_CONFIRM[action]}
      cancelLabel="Отмена"
      tone={action === 'ban' ? 'destructive' : 'default'}
      busy={busy}
      onConfirm={submit}
      body={
        <div className="space-y-3">
          <p>
            {target.name} — {QUICK_EXPLANATION[action]}
          </p>
          <FieldRow label="Причина" htmlFor={reasonId} required error={error}>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
              rows={3}
              invalid={error !== null}
            />
          </FieldRow>
          {action === 'ban' ? (
            <FieldRow label="Срок бана" htmlFor={lengthId}>
              <Select
                id={lengthId}
                value={banLength}
                onChange={(event) => setBanLength(event.target.value)}
              >
                {banLengths.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </FieldRow>
          ) : null}
        </div>
      }
    />
  );
}
