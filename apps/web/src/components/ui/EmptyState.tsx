import type { ReactNode } from 'react';

/** Причина, по которой на экране ничего нет. */
export type EmptyStateVariant = 'initial' | 'filtered';

/**
 * Пустое состояние экрана: заголовок, объяснение и ровно одно действие.
 *
 * Различие `initial` и `filtered` — не косметика, а разные ответы на вопрос
 * оператора «почему тут пусто». `initial` означает «сущностей ещё не
 * существует», и действие ведёт к их созданию. `filtered` означает «данные
 * есть, но текущий фильтр их скрыл», и действие — «Сбросить фильтры».
 * Если эти два случая свести в один текст, оператор при пустой выдаче начнёт
 * заводить дубликаты уже существующих записей, поэтому вариант обязателен и
 * его нельзя стирать «за ненадобностью». Значение выводится в `data-variant`,
 * чтобы состояние можно было отличить в тестах и снимках DOM.
 *
 * Текст приходит только пропсами: примитив не знает про словарь переводов.
 *
 * @param title Короткая формулировка, что именно отсутствует.
 * @param description Пояснение, почему пусто и что с этим делать.
 * @param action Кнопка или ссылка — для `filtered` это «Сбросить фильтры».
 * @param icon Декоративный значок; для скринридера он скрыт.
 * @param variant Причина пустоты, по умолчанию `initial`.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  variant = 'initial',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  variant?: EmptyStateVariant;
}) {
  return (
    <div data-variant={variant} className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      {icon && (
        <span aria-hidden="true" className="text-ink-4">
          {icon}
        </span>
      )}
      {/* Не заголовок уровня h*: блок появляется в произвольном месте страницы
          и врезался бы в её структуру заголовков. */}
      <p className="text-[13px] font-semibold">{title}</p>
      {description && <p className="max-w-sm text-xs text-ink-3">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
