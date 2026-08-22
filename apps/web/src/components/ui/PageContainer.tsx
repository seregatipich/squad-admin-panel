import type { ReactNode } from 'react';

/**
 * Допустимые ширины содержимого страницы (раздел 3 дизайн-системы).
 *
 * Классы перечислены целиком, а не собираются из фрагментов: сканер исходников
 * Tailwind 4 видит только литеральные строки.
 */
const WIDTH_CLASS = {
  full: 'max-w-[1600px]',
  wide: 'mx-auto max-w-6xl',
  reading: 'mx-auto max-w-3xl',
  form: 'mx-auto max-w-xl',
} as const;

export type PageWidth = keyof typeof WIDTH_CLASS;

/**
 * Каркас содержимого страницы: ширина и вертикальный ритм между крупными блоками.
 *
 * Это единственный разрешённый способ задавать ширину страницы. Пять разных
 * `max-w` на одно приложение читаются как пять разных приложений, поэтому
 * страница не имеет права ставить собственные `max-w-*` — она выбирает один из
 * четырёх вариантов `width`. Собственных `py-*`/`pb-*` контейнер тоже не даёт и
 * не принимает: вертикальные поля страницы задаёт `<main>` в layout, и страница
 * их не дублирует.
 *
 * Вариант `full` не центрируется здесь — на этой ширине центрирование уже
 * выполняет layout, и второй `mx-auto` только маскировал бы промах в разметке.
 *
 * @param width Ширина содержимого; по умолчанию `full` (таблицы, дашборды).
 * @param className Дополнительные классы блока — не для ширины и не для полей.
 * @param children Крупные блоки страницы, разделённые `space-y-6`.
 */
export function PageContainer({
  width = 'full',
  className,
  children,
}: {
  width?: PageWidth;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`w-full space-y-6 ${WIDTH_CLASS[width]}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}
