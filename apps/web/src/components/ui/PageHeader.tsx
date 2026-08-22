import Link from 'next/link';
import type { ReactNode } from 'react';

export type Breadcrumb = {
  label: string;
  /** Без `href` крошка остаётся текстом — так помечают недостижимый уровень. */
  href?: string;
};

/**
 * Стрелка «назад» бессмысленна без доступного имени, а придумать его примитив не
 * может — текст живёт в словаре страницы. Поэтому `backLabel` обязателен ровно
 * тогда, когда задан `backHref`, и это проверяет компилятор, а не ревью.
 */
type BackLink =
  | { backHref: string; backLabel: string }
  | { backHref?: undefined; backLabel?: undefined };

export type PageHeaderProps = BackLink & {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  /**
   * Доступное имя ориентира с крошками; страница передаёт переведённую строку.
   * Без него landmark остаётся безымянным, но разметка не ломается.
   */
  breadcrumbsLabel?: string;
  /** Индикатор живости или бейдж состояния — справа от заголовка. */
  status?: ReactNode;
  /** Действия страницы — правый край ряда с заголовком. */
  actions?: ReactNode;
  /** Мелкие метаданные под заголовком: идентификатор, аптайм и подобное. */
  meta?: ReactNode;
};

/**
 * Шапка страницы: крошки, заголовок, состояние, действия и метаданные.
 *
 * Заголовок здесь — ровно один `<h1>` на страницу: вложенные блоки заводят свои
 * `<h2>`/`<h3>`, иначе экранный диктор теряет единственную опору, по которой
 * оператор понимает, где он оказался. Второй `PageHeader` на странице — дефект.
 *
 * Тексты (включая `backLabel` и `breadcrumbsLabel`) приходят пропсами: примитив
 * не знает про словарь переводов.
 */
export function PageHeader({
  title,
  subtitle,
  backHref,
  backLabel,
  breadcrumbs,
  breadcrumbsLabel,
  status,
  actions,
  meta,
}: PageHeaderProps) {
  return (
    <header className="space-y-2">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label={breadcrumbsLabel}>
          <ol className="flex flex-wrap items-center gap-1 text-xs text-ink-3">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <li key={crumb.href ?? crumb.label} className="flex items-center gap-1">
                  {index > 0 && (
                    <span aria-hidden className="text-ink-4">
                      /
                    </span>
                  )}
                  {crumb.href ? (
                    <Link
                      href={crumb.href}
                      aria-current={isLast ? 'page' : undefined}
                      className="text-ink-3 no-underline transition-colors hover:text-ink"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            {backHref && (
              <Link
                href={backHref}
                aria-label={backLabel}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-ctl text-ink-2 no-underline transition-colors hover:bg-raised hover:text-ink"
              >
                <span aria-hidden>←</span>
              </Link>
            )}
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
            {status}
          </div>
          {subtitle && <p className="text-xs text-ink-3">{subtitle}</p>}
          {meta && (
            <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-3">{meta}</div>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
