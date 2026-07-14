export interface ClanGuardSettings {
  enabled: boolean;
  grace_period_seconds: number;
  updated_at: string | null;
}

export const GRACE_PERIOD_MIN_SECONDS = 0;
export const GRACE_PERIOD_MAX_SECONDS = 3600;

export interface GracePeriodValidation {
  ok: boolean;
  value: number;
  error: string | null;
}

/** Validates the grace-period input (a controlled text field mirrored to an integer 0..3600). */
export function validateGracePeriod(raw: string): GracePeriodValidation {
  const parsed = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { ok: false, value: Number.NaN, error: 'Введите целое число секунд.' };
  }
  if (parsed < GRACE_PERIOD_MIN_SECONDS || parsed > GRACE_PERIOD_MAX_SECONDS) {
    return {
      ok: false,
      value: parsed,
      error: `Значение должно быть от ${GRACE_PERIOD_MIN_SECONDS} до ${GRACE_PERIOD_MAX_SECONDS}.`,
    };
  }
  return { ok: true, value: parsed, error: null };
}

export function formatUpdatedAt(iso: string | null): string {
  if (!iso) return 'ещё не изменялось';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'ещё не изменялось';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
