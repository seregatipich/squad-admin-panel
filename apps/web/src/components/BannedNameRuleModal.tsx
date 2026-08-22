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
import {
  Button,
  Card,
  Checkbox,
  FieldRow,
  InlineBanner,
  Modal,
  Select,
  TextInput,
} from '@/components/ui';

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
 *
 * Окно построено на примитиве `Modal`, то есть на нативном `<dialog>`: отсюда
 * ловушка фокуса, верхний слой и Escape, которых у рукописной подложки не было.
 * Escape разрешён (`dismissible` по умолчанию), потому что форма короткая и
 * восстанавливается двумя кликами из той же точки входа.
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

  const formId = useId();
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

  async function save() {
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

  const patternError =
    trimmedPattern !== '' && !patternValidation.ok ? patternValidation.error : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title={editingId ? 'Изменить правило' : 'Новое правило'}
      closeLabel="Закрыть окно"
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            Отмена
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={submitting}
            disabled={!trimmedPattern || !patternValidation.ok}
          >
            {editingId ? 'Сохранить' : 'Добавить'}
          </Button>
        </>
      }
    >
      {/* Подтверждающая кнопка живёт в подвале окна и связана с формой атрибутом
          `form`: и клик по ней, и Enter в любом поле идут одним путём. */}
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        <FieldRow label="Паттерн" htmlFor={patternInputId} error={patternError}>
          <TextInput
            id={patternInputId}
            value={form.pattern}
            maxLength={BANNED_NAME_PATTERN_MAX}
            invalid={patternError !== undefined}
            onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
            placeholder="напр. AdolfHitler или ^\\[ISIS\\]"
            className="font-mono"
          />
        </FieldRow>

        <div className="grid grid-cols-2 gap-3">
          <FieldRow label="Тип матчинга" htmlFor={matchTypeId}>
            <Select
              id={matchTypeId}
              value={form.match_type}
              onChange={(e) =>
                setForm((f) => ({ ...f, match_type: e.target.value as BannedNameMatchType }))
              }
            >
              {BANNED_NAME_MATCH_TYPES.map((t) => (
                <option key={t} value={t}>
                  {MATCH_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </FieldRow>
          <FieldRow label="Действие" htmlFor={actionId}>
            <Select
              id={actionId}
              value={form.action}
              onChange={(e) =>
                setForm((f) => ({ ...f, action: e.target.value as BannedNameAction }))
              }
            >
              {BANNED_NAME_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABELS[a]}
                </option>
              ))}
            </Select>
          </FieldRow>
        </div>

        <FieldRow label="Причина" htmlFor={reasonId} hint="Необязательно.">
          <TextInput
            id={reasonId}
            value={form.reason}
            maxLength={512}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          />
        </FieldRow>

        <Checkbox
          label="Активно"
          checked={form.is_active}
          onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
        />

        <Card padding="sm" className="space-y-2">
          <FieldRow label="Проверить ник против правила" htmlFor={testInputId}>
            <TextInput
              id={testInputId}
              value={testNick}
              onChange={(e) => setTestNick(e.target.value)}
              placeholder="Введите тестовый ник"
            />
          </FieldRow>
          {previewMatches === null ? (
            <p className="text-xs text-ink-3">
              Введите паттерн и тестовый ник, чтобы увидеть результат.
            </p>
          ) : previewMatches ? (
            <p className="text-xs text-crit">Совпадение — ник будет заблокирован.</p>
          ) : (
            <p className="text-xs text-good">Нет совпадения — ник пройдёт.</p>
          )}
        </Card>

        {error ? (
          <InlineBanner tone="crit" title="Не удалось сохранить правило" description={error} />
        ) : null}
      </form>
    </Modal>
  );
}

/**
 * Self-contained «Забанить ник» button used by surfaces that only need to
 * *create* a rule from a nickname (live roster, chat viewers) — hidden
 * without the `ban` squad permission, opens {@link BannedNameRuleModal}
 * prefilled with `pattern: nick, match_type: 'exact'` and closes it on save.
 *
 * `className` остаётся полной заменой оформления, а не добавкой к нему: кнопка
 * встраивается в чужие строки — живой ростер, ленту чата — и там её вид задаёт
 * вмещающая строка. Своего оформления у кнопки поэтому ровно одно, штатное:
 * `Button size="sm"` из дизайн-системы.
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

  const label = `Забанить ник «${nick}»`;
  const trigger = className ? (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => setOpen(true)}
      className={className}
    >
      Забанить ник
    </button>
  ) : (
    <Button size="sm" title={label} aria-label={label} onClick={() => setOpen(true)}>
      Забанить ник
    </Button>
  );

  return (
    <>
      {trigger}
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
