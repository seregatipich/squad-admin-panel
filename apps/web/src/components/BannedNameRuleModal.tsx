'use client';

import {
  BANNED_NAME_ACTIONS,
  BANNED_NAME_MATCH_TYPES,
  BANNED_NAME_PATTERN_MAX,
  type BannedNameAction,
  type BannedNameMatchType,
  matchBannedName,
  validateBannedNamePattern,
} from '@squad/shared-config/banned-names';
import { useEffect, useId, useMemo, useState } from 'react';

export interface BannedNameRule {
  id: string;
  pattern: string;
  match_type: BannedNameMatchType;
  reason: string | null;
  action: BannedNameAction;
  is_active: boolean;
  author_name: string | null;
  created_at: string;
  hit_count: number;
  last_hit_at: string | null;
}

export interface BannedNameRuleFormState {
  pattern: string;
  match_type: BannedNameMatchType;
  action: BannedNameAction;
  reason: string;
  is_active: boolean;
}

const DEFAULT_FORM: BannedNameRuleFormState = {
  pattern: '',
  match_type: 'exact',
  action: 'kick',
  reason: '',
  is_active: true,
};

const MATCH_TYPE_LABELS: Record<BannedNameMatchType, string> = {
  exact: 'Точное',
  substring: 'Вхождение',
  regex: 'Regex',
};

const ACTION_LABELS: Record<BannedNameAction, string> = {
  kick: 'Кик',
  alert: 'Уведомление',
};

export interface BannedNameRuleModalProps {
  /** Whether the modal is rendered. Nothing is rendered (not even a hidden node) when false. */
  open: boolean;
  /** Rule id being edited; `null`/omitted means "create a new rule". */
  editingId?: string | null;
  /** Prefills the form when the modal opens — e.g. `{ pattern: nick, match_type: 'exact' }`. */
  initial?: Partial<BannedNameRuleFormState>;
  onClose: () => void;
  /** Called with the created/updated rule right after a successful save. */
  onSaved: (rule: BannedNameRule) => void;
}

/**
 * Prefillable create/edit modal for a `banned_name_rules` row (BANNAME-1,
 * extracted for reuse by BANNAME-3's quick-add entry points: the player
 * card, live roster, and chat viewers all open this same modal pre-seeded
 * with a nickname so an admin can create a rule in two clicks while still
 * reviewing/adjusting match type, action and reason before saving.
 */
export function BannedNameRuleModal({
  open,
  editingId = null,
  initial,
  onClose,
  onSaved,
}: BannedNameRuleModalProps) {
  const [form, setForm] = useState<BannedNameRuleFormState>({ ...DEFAULT_FORM, ...initial });
  const [testNick, setTestNick] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patternInputId = useId();
  const testInputId = useId();
  const matchTypeId = useId();
  const actionId = useId();
  const reasonId = useId();

  // Re-seed the form only on the open transition: `initial`/`editingId` are
  // read once when the modal opens so the admin can freely edit fields
  // afterwards without them snapping back on every parent re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally omits `initial` — read once per open, see comment above
  useEffect(() => {
    if (!open) return;
    setForm({ ...DEFAULT_FORM, ...initial });
    setTestNick('');
    setError(null);
    setSubmitting(false);
  }, [open]);

  const trimmedPattern = form.pattern.trim();
  const patternValidation = useMemo(
    () => validateBannedNamePattern(trimmedPattern, form.match_type),
    [trimmedPattern, form.match_type],
  );
  const previewMatches = useMemo(() => {
    if (!trimmedPattern || testNick.length === 0) return null;
    return matchBannedName(trimmedPattern, form.match_type, testNick);
  }, [trimmedPattern, form.match_type, testNick]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmedPattern) {
      setError('Паттерн не может быть пустым.');
      return;
    }
    if (!patternValidation.ok) {
      setError(`Некорректный паттерн: ${patternValidation.error}`);
      return;
    }
    setSubmitting(true);
    setError(null);
    const payload = {
      pattern: trimmedPattern,
      match_type: form.match_type,
      action: form.action,
      reason: form.reason.trim() ? form.reason.trim() : null,
      is_active: form.is_active,
    };
    try {
      const res = await fetch(
        editingId ? `/api/v1/banned-names/${editingId}` : '/api/v1/banned-names',
        {
          method: editingId ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const detail = body.detail ?? body.error ?? `HTTP ${res.status}`;
        throw new Error(String(detail));
      }
      const rule = (await res.json()) as BannedNameRule;
      onSaved(rule);
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
      <div className="mt-16 w-full max-w-lg rounded border border-neutral-800 bg-neutral-950 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {editingId ? 'Изменить правило' : 'Новое правило'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            Закрыть
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor={patternInputId} className="mb-1 block text-xs text-neutral-500">
              Паттерн
            </label>
            <input
              id={patternInputId}
              type="text"
              value={form.pattern}
              maxLength={BANNED_NAME_PATTERN_MAX}
              onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
              placeholder="напр. AdolfHitler или ^\\[ISIS\\]"
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-sm focus:border-neutral-600 focus:outline-none"
            />
            {trimmedPattern && !patternValidation.ok ? (
              <p className="mt-1 text-xs text-red-400">{patternValidation.error}</p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={matchTypeId} className="mb-1 block text-xs text-neutral-500">
                Тип матчинга
              </label>
              <select
                id={matchTypeId}
                value={form.match_type}
                onChange={(e) =>
                  setForm((f) => ({ ...f, match_type: e.target.value as BannedNameMatchType }))
                }
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              >
                {BANNED_NAME_MATCH_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {MATCH_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={actionId} className="mb-1 block text-xs text-neutral-500">
                Действие
              </label>
              <select
                id={actionId}
                value={form.action}
                onChange={(e) =>
                  setForm((f) => ({ ...f, action: e.target.value as BannedNameAction }))
                }
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              >
                {BANNED_NAME_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABELS[a]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor={reasonId} className="mb-1 block text-xs text-neutral-500">
              Причина (необязательно)
            </label>
            <input
              id={reasonId}
              type="text"
              value={form.reason}
              maxLength={512}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
            />
            Активно
          </label>

          <div className="rounded border border-neutral-800 bg-neutral-900 p-3 space-y-2">
            <label htmlFor={testInputId} className="block text-xs text-neutral-500">
              Проверить ник против правила
            </label>
            <input
              id={testInputId}
              type="text"
              value={testNick}
              onChange={(e) => setTestNick(e.target.value)}
              placeholder="Введите тестовый ник"
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
            {previewMatches === null ? (
              <p className="text-xs text-neutral-500">
                Введите паттерн и тестовый ник, чтобы увидеть результат.
              </p>
            ) : previewMatches ? (
              <p className="text-xs text-red-300">Совпадение — ник будет заблокирован.</p>
            ) : (
              <p className="text-xs text-emerald-300">Нет совпадения — ник пройдёт.</p>
            )}
          </div>

          {error ? <p className="text-xs text-red-400">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:border-neutral-600"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={submitting || !trimmedPattern || !patternValidation.ok}
              className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
            >
              {submitting ? 'Сохранение…' : editingId ? 'Сохранить' : 'Добавить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Self-contained «Забанить ник» button used by surfaces that only need to
 * *create* a rule from a nickname (live roster, chat viewers) — hidden
 * without the `ban` squad permission, opens {@link BannedNameRuleModal}
 * prefilled with `pattern: nick, match_type: 'exact'` and closes it on save.
 */
export function BanNickButton({
  nick,
  canBan,
  className,
  onSaved,
}: {
  nick: string;
  canBan: boolean;
  className?: string;
  onSaved?: (rule: BannedNameRule) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!canBan) return null;

  return (
    <>
      <button
        type="button"
        title={`Забанить ник «${nick}»`}
        aria-label={`Забанить ник «${nick}»`}
        onClick={() => setOpen(true)}
        className={
          className ??
          'rounded border border-red-900 px-1.5 py-0.5 text-[10px] text-red-400 hover:border-red-700'
        }
      >
        Забанить ник
      </button>
      <BannedNameRuleModal
        open={open}
        initial={{ pattern: nick, match_type: 'exact' }}
        onClose={() => setOpen(false)}
        onSaved={(rule) => {
          setOpen(false);
          onSaved?.(rule);
        }}
      />
    </>
  );
}
