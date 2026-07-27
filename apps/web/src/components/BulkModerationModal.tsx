'use client';
import { useEffect, useId, useState } from 'react';

/** Mirrors the zod body schema on POST /api/v1/moderation-actions/bulk. */
const REASON_MAX = 300;

export interface BulkModerationTarget {
  playerId: string;
  name: string;
}

type BulkActionType = 'warn' | 'kick' | 'ban';

interface BulkResultRow {
  player_id: string;
  status: 'applied' | 'failed';
  moderation_action_id?: string;
  error?: string;
  detail?: string;
}

interface BulkResponse {
  bulk_group: string;
  requested: number;
  applied: number;
  failed: number;
  results: BulkResultRow[];
}

const ACTION_LABEL: Record<BulkActionType, string> = {
  warn: 'Предупреждение',
  kick: 'Кик',
  ban: 'Бан',
};

const BAN_LENGTHS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1d', label: '1 день' },
  { value: '3d', label: '3 дня' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: '0', label: 'Навсегда' },
];

/** Human-readable per-target failure reasons returned in `results[].error`. */
const ERROR_LABEL: Record<string, string> = {
  player_not_found: 'Игрок не найден',
  target_identity_missing: 'Нет SteamID64 и EOS ID',
  target_offline: 'Игрок не в сети',
  rcon_failed: 'RCON не подтвердил команду',
  bulk_deadline_exceeded: 'Превышен лимит времени операции',
};

/**
 * Bulk warn/kick/ban over a set of players picked from the live roster
 * (MOD-4, #61). `targets` is null while the modal is closed.
 *
 * Enforcement sits behind two deliberate steps: a form, then a confirmation
 * screen listing every target. A ban additionally demands the operator type
 * the target count back — the client half of the server's `confirm_bulk`
 * requirement, and the guard against an accidental mass ban. Because the
 * operation is not transactional, the outcome is shown as a modal result
 * screen with the per-target failure reasons rather than a toast.
 *
 * @param permissions - The caller's `mod:*` catalog keys (from
 *   `GET /api/v1/me`). Action types and ban durations the caller cannot use
 *   are not offered at all; the API enforces the same gate independently.
 */
export function BulkModerationModal({
  serverId,
  targets,
  permissions,
  onOpenChange,
  onApplied,
}: {
  serverId: string;
  targets: BulkModerationTarget[] | null;
  permissions: readonly string[];
  onOpenChange: (open: boolean) => void;
  /** Called once a request came back applied, so the caller can refresh. */
  onApplied?: () => void;
}) {
  const canWarn = permissions.includes('mod:warn');
  const canKick = permissions.includes('mod:kick');
  const canBanTemp = permissions.includes('mod:ban_temp');
  const canBanPerm = permissions.includes('mod:ban_perm');
  const actionTypes: BulkActionType[] = [
    ...(canWarn ? (['warn'] as const) : []),
    ...(canKick ? (['kick'] as const) : []),
    ...(canBanTemp || canBanPerm ? (['ban'] as const) : []),
  ];
  const banLengths = BAN_LENGTHS.filter((entry) => (entry.value === '0' ? canBanPerm : canBanTemp));

  const [step, setStep] = useState<'form' | 'confirm' | 'result'>('form');
  const [actionType, setActionType] = useState<BulkActionType>(actionTypes[0] ?? 'kick');
  const [reason, setReason] = useState('');
  const [banLength, setBanLength] = useState(banLengths[0]?.value ?? '0');
  const [challenge, setChallenge] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResponse | null>(null);
  /**
   * The batch as it was at submit time. The caller clears its selection from
   * `onApplied`, so `targets` is already empty when the result screen renders
   * — without this snapshot the failure list would show bare uuids.
   */
  const [batch, setBatch] = useState<BulkModerationTarget[]>([]);
  const titleId = useId();
  const actionId = useId();
  const reasonId = useId();
  const lengthId = useId();
  const challengeId = useId();

  // Keyed on open/closed, never on the `targets` array identity: the caller
  // rebuilds that array on every render (the live-roster table re-renders once
  // a second), and resetting on identity would wipe whatever is being typed.
  const open = targets !== null;
  useEffect(() => {
    if (!open) return;
    setStep('form');
    setReason('');
    setChallenge('');
    setError(null);
    setResult(null);
    setBatch([]);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!targets) return null;

  const trimmedReason = reason.trim();
  // On the result screen the live selection is already gone — report on the
  // batch that was actually submitted.
  const shown = step === 'result' ? batch : targets;
  const targetCount = shown.length;
  // A ban is the only irreversible-in-practice action, so it carries the
  // extra "type the number back" challenge on top of the confirmation step.
  const challengeSatisfied = actionType !== 'ban' || challenge.trim() === String(targetCount);
  const nameById = new Map(shown.map((target) => [target.playerId, target.name]));

  async function submit() {
    if (busy || !targets) return;
    const submitting = targets;
    setBusy(true);
    setError(null);
    setBatch(submitting);
    try {
      const res = await fetch('/api/v1/moderation-actions/bulk', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          server_id: serverId,
          action_type: actionType,
          player_ids: submitting.map((target) => target.playerId),
          reason: trimmedReason,
          ban_length: banLength,
          confirm_bulk: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setResult((await res.json()) as BulkResponse);
      setStep('result');
      onApplied?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={() => onOpenChange(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onOpenChange(false);
      }}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded border border-neutral-800 bg-neutral-950 p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <h2 id={titleId} className="text-lg font-semibold text-neutral-100">
          Массовое действие
        </h2>
        <p className="mb-4 text-xs text-neutral-500">Выбрано игроков: {targetCount}</p>

        {actionTypes.length === 0 ? (
          <p className="text-xs text-red-400">Нет прав на массовые действия модерации.</p>
        ) : step === 'form' ? (
          <div className="space-y-3">
            <div>
              <label htmlFor={actionId} className="mb-1 block text-xs text-neutral-400">
                Действие
              </label>
              <select
                id={actionId}
                value={actionType}
                onChange={(e) => setActionType(e.target.value as BulkActionType)}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
              >
                {actionTypes.map((value) => (
                  <option key={value} value={value}>
                    {ACTION_LABEL[value]}
                  </option>
                ))}
              </select>
            </div>

            {actionType === 'ban' ? (
              <div>
                <label htmlFor={lengthId} className="mb-1 block text-xs text-neutral-400">
                  Срок бана
                </label>
                <select
                  id={lengthId}
                  value={banLength}
                  onChange={(e) => setBanLength(e.target.value)}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
                >
                  {banLengths.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div>
              <label htmlFor={reasonId} className="mb-1 block text-xs text-neutral-400">
                Причина
              </label>
              <textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={REASON_MAX}
                rows={3}
                placeholder="Причина (обязательно)"
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={trimmedReason.length === 0}
                onClick={() => setStep('confirm')}
                className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Далее
              </button>
            </div>
          </div>
        ) : step === 'confirm' ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-amber-300">Подтвердите массовое действие</p>
            <p className="text-xs text-neutral-400">
              {ACTION_LABEL[actionType]}
              {actionType === 'ban'
                ? ` · ${banLengths.find((entry) => entry.value === banLength)?.label ?? banLength}`
                : ''}{' '}
              · {targetCount} игроков · «{trimmedReason}»
            </p>
            <ul className="max-h-40 overflow-y-auto rounded border border-neutral-800 bg-neutral-900 p-2 text-xs text-neutral-300">
              {targets.map((target) => (
                <li key={target.playerId}>{target.name}</li>
              ))}
            </ul>

            {actionType === 'ban' ? (
              <div>
                <label htmlFor={challengeId} className="mb-1 block text-xs text-neutral-400">
                  Введите количество целей
                </label>
                <input
                  id={challengeId}
                  value={challenge}
                  onChange={(e) => setChallenge(e.target.value)}
                  inputMode="numeric"
                  placeholder={String(targetCount)}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600"
                />
              </div>
            ) : null}

            {error ? <p className="text-xs text-red-400">{error}</p> : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStep('form')}
                className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700"
              >
                Назад
              </button>
              <button
                type="button"
                disabled={busy || !challengeSatisfied}
                onClick={() => void submit()}
                className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? 'Применение…' : 'Подтвердить'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-neutral-200">
              Применено: {result?.applied ?? 0} · Ошибок: {result?.failed ?? 0}
            </p>
            {result && result.failed > 0 ? (
              <ul className="max-h-48 overflow-y-auto rounded border border-neutral-800 bg-neutral-900 p-2 text-xs text-red-300">
                {result.results
                  .filter((row) => row.status === 'failed')
                  .map((row) => (
                    <li key={row.player_id}>
                      {nameById.get(row.player_id) ?? row.player_id} —{' '}
                      {ERROR_LABEL[row.error ?? ''] ?? row.error ?? 'неизвестная ошибка'}
                      {row.detail ? ` (${row.detail})` : ''}
                    </li>
                  ))}
              </ul>
            ) : null}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
              >
                Закрыть
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
