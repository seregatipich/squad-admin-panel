'use client';

import type { ReactNode } from 'react';

/** Состояние системы, о котором сообщает полоса. */
export type InlineBannerTone = 'info' | 'good' | 'warn' | 'crit';

const TONE_SURFACE: Record<InlineBannerTone, string> = {
  info: 'border-accent/40 bg-accent-dim',
  good: 'border-good/40 bg-good/10',
  warn: 'border-warn/40 bg-warn/10',
  crit: 'border-crit/40 bg-crit/10',
};

const TONE_MARK: Record<InlineBannerTone, string> = {
  info: 'text-accent',
  good: 'text-good',
  warn: 'text-warn',
  crit: 'text-crit',
};

/* «Никогда только цветом»: значок дублирует тон для тех, кто различает
   оттенки хуже монитора. */
const TONE_GLYPH: Record<InlineBannerTone, string> = {
  info: 'ⓘ',
  good: '✓',
  warn: '⚠',
  crit: '⊗',
};

/**
 * `info` и `good` объявляются вежливо, `warn` и `crit` — немедленно.
 *
 * `role="status"` ждёт паузы в речи: подтверждение («настройки сохранены») не
 * стоит того, чтобы перебивать оператора посреди строки. `role="alert"`
 * перебивает, и именно этого требуют предупреждение и ошибка: полоса с тоном
 * `crit` появляется, когда действие не выполнилось, и узнать об этом через
 * минуту — уже поздно.
 */
const TONE_ROLE: Record<InlineBannerTone, 'status' | 'alert'> = {
  info: 'status',
  good: 'status',
  warn: 'alert',
  crit: 'alert',
};

/**
 * Кнопка закрытия существует только в паре с подписью.
 *
 * Значок «✕» сам по себе не даёт кнопке осмысленного доступного имени, а
 * перевести его внутри примитива нельзя — словарь остаётся снаружи. Поэтому
 * пару навязывает тип: либо оба поля, либо ни одного.
 */
type DismissProps =
  | { onDismiss: () => void; dismissLabel: string }
  | { onDismiss?: undefined; dismissLabel?: undefined };

/**
 * Полоса-сообщение внутри страницы: статус, предупреждение или ошибка рядом с
 * тем содержимым, к которому она относится.
 *
 * Тон задаёт не только цвет рамки и приглушённый фон, но и роль в дереве
 * доступности — см. {@link TONE_ROLE}. Ошибка запроса показывается как
 * `tone="crit"` с действием «Повторить».
 *
 * @param tone Состояние системы.
 * @param title Главная строка сообщения.
 * @param description Подробности: что произошло и что делать.
 * @param action Кнопка действия, например «Повторить».
 * @param onDismiss Обработчик закрытия; передаётся вместе с `dismissLabel`.
 * @param dismissLabel Доступное имя кнопки закрытия.
 */
export function InlineBanner({
  tone,
  title,
  description,
  action,
  onDismiss,
  dismissLabel,
}: {
  tone: InlineBannerTone;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
} & DismissProps) {
  return (
    <div
      role={TONE_ROLE[tone]}
      className={`flex items-start gap-3 rounded-card border p-3 ${TONE_SURFACE[tone]}`}
    >
      <span aria-hidden="true" className={`text-[13px] leading-5 ${TONE_MARK[tone]}`}>
        {TONE_GLYPH[tone]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">{title}</p>
        {description && <div className="mt-1 text-xs text-ink-3">{description}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-ctl text-ink-3 transition-colors duration-150 hover:bg-raised hover:text-ink"
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </div>
  );
}
