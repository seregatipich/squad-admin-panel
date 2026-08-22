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

type Step = 'form' | 'confirm' | 'result';

/** Подпись шага в шапке окна: оператор всегда видит, где он и сколько осталось. */
const STEP_LABEL: Record<Step, string> = {
  form: 'Шаг 1 из 3 · Параметры',
  confirm: 'Шаг 2 из 3 · Подтверждение',
  result: 'Шаг 3 из 3 · Результат',
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
 * Три экрана живут в одном окне, поэтому шаг назван в его шапке: без этого
 * оператор не понимает, форму он видит, вопрос или уже отчёт. Пока в форме есть
 * набранная причина или идёт запрос, окно не закрывается ни Escape, ни кликом
 * мимо панели — раньше промах мышью бесследно стирал причину и срок.
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

  const [step, setStep] = useState<Step>('form');
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
  // Мягкие жесты закрытия разрешены, только когда терять нечего: на форме без
  // причины и на экране результата, который ничего не хранит.
  const dismissible =
    !busy && (step === 'result' || (step === 'form' && trimmedReason.length === 0));

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

  const footer =
    actionTypes.length === 0 ? (
      <Button variant="secondary" onClick={() => onOpenChange(false)}>
        Закрыть окно
      </Button>
    ) : step === 'form' ? (
      <>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Отмена
        </Button>
        <Button
          variant="primary"
          disabled={trimmedReason.length === 0}
          onClick={() => setStep('confirm')}
        >
          Далее
        </Button>
      </>
    ) : step === 'confirm' ? (
      <>
        <Button variant="secondary" onClick={() => setStep('form')} disabled={busy}>
          Назад
        </Button>
        <Button
          // Критический цвет — только у бана: предупреждение и кик обратимы,
          // а бан на практике — нет (раздел 5 дизайн-системы).
          variant={actionType === 'ban' ? 'destructive' : 'primary'}
          disabled={!challengeSatisfied}
          loading={busy}
          onClick={() => void submit()}
        >
          Подтвердить
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={() => onOpenChange(false)}>
        Готово
      </Button>
    );

  return (
    <Modal
      open
      onClose={() => onOpenChange(false)}
      title="Массовое действие"
      description={`Выбрано игроков: ${targetCount}`}
      closeLabel="Закрыть"
      dismissible={dismissible}
      footer={footer}
    >
      {actionTypes.length === 0 ? (
        <InlineBanner
          tone="warn"
          title="Нет прав на массовые действия модерации."
          description="Обратитесь к администратору за ключами mod:warn, mod:kick или mod:ban_*."
        />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-3">{STEP_LABEL[step]}</p>

          {step === 'form' ? (
            <>
              <FieldRow label="Действие" htmlFor={actionId}>
                <Select
                  id={actionId}
                  value={actionType}
                  onChange={(e) => setActionType(e.target.value as BulkActionType)}
                >
                  {actionTypes.map((value) => (
                    <option key={value} value={value}>
                      {ACTION_LABEL[value]}
                    </option>
                  ))}
                </Select>
              </FieldRow>

              {actionType === 'ban' ? (
                <FieldRow label="Срок бана" htmlFor={lengthId}>
                  <Select
                    id={lengthId}
                    value={banLength}
                    onChange={(e) => setBanLength(e.target.value)}
                  >
                    {banLengths.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                </FieldRow>
              ) : null}

              <FieldRow label="Причина" htmlFor={reasonId}>
                <Textarea
                  id={reasonId}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={REASON_MAX}
                  rows={3}
                  placeholder="Причина (обязательно)"
                />
              </FieldRow>
            </>
          ) : step === 'confirm' ? (
            <>
              <p className="text-[13px] font-semibold text-ink">Подтвердите массовое действие</p>
              <p className="text-xs text-ink-3">
                {ACTION_LABEL[actionType]}
                {actionType === 'ban'
                  ? ` · ${banLengths.find((entry) => entry.value === banLength)?.label ?? banLength}`
                  : ''}{' '}
                · {targetCount} игроков · «{trimmedReason}»
              </p>
              <ul className="max-h-40 overflow-y-auto rounded-ctl border border-line bg-raised p-2 text-xs text-ink-2">
                {targets.map((target) => (
                  <li key={target.playerId}>{target.name}</li>
                ))}
              </ul>

              {actionType === 'ban' ? (
                <FieldRow
                  label="Введите количество целей"
                  htmlFor={challengeId}
                  hint="Барьер против случайного массового бана: число нужно набрать вручную."
                >
                  <TextInput
                    id={challengeId}
                    value={challenge}
                    onChange={(e) => setChallenge(e.target.value)}
                    inputMode="numeric"
                    placeholder={String(targetCount)}
                  />
                </FieldRow>
              ) : null}

              {error ? (
                <InlineBanner tone="crit" title="Не удалось применить" description={error} />
              ) : null}
            </>
          ) : (
            <>
              <p className="text-[13px] text-ink">
                Применено: {result?.applied ?? 0} · Ошибок: {result?.failed ?? 0}
              </p>
              {result && result.failed > 0 ? (
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-ctl border border-line bg-raised p-2 text-xs text-ink-2">
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
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
