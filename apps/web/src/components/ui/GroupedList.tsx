'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card } from './Card';

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Строка списка: 44px минимальной высоты, подпись слева, контрол справа.
 * Класс перечислен целиком — сканер Tailwind 4 не видит имён, склеенных в рантайме.
 */
const ROW = 'flex min-h-11 items-center justify-between gap-4 px-4 py-2.5 text-left';

/**
 * Сгруппированный список настроек — прямой аналог inset grouped таблиц Apple.
 *
 * Заголовок группы стоит **над** карточкой, а пояснение — **под** ней, и это
 * не украшение: строка внутри карточки принадлежит одной настройке, поэтому
 * всё, что относится к группе целиком, обязано жить снаружи. Так экран
 * настроек читается как список разделов, а не как россыпь разнородных форм
 * (дизайн-система, §11).
 *
 * Расстояния между группами задаёт страница (`space-y-6`), а не список.
 *
 * @param title Служебный ярлык группы; набирается заглавными, как надзаголовок (§1).
 * @param footnote Пояснение ко всей группе — последствия, ограничения, ссылка на документацию.
 * @param headingLevel Ранг заголовка, чтобы группа под заголовком раздела не ломала порядок.
 */
export function GroupedList({
  title,
  footnote,
  headingLevel = 2,
  className,
  children,
}: {
  title?: string;
  footnote?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
  children?: ReactNode;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';

  return (
    <section className={cx('space-y-2', className)}>
      {title && (
        <Heading className="px-1 text-2xs uppercase tracking-[0.06em] text-ink-3">{title}</Heading>
      )}
      <Card padding="none" className="divide-y divide-line">
        {children}
      </Card>
      {footnote && <p className="px-1 text-xs text-ink-3">{footnote}</p>}
    </section>
  );
}

/** Шеврон «здесь есть куда перейти». Скрыт от скринридера: смысл несёт сама ссылка. */
function ChevronRight() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="none"
      className="size-3.5 shrink-0 text-ink-4"
    >
      <path
        d="m6 3 5 5-5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Строка сгруппированного списка. Ровно одна из трёх ролей, и союз типов не
 * даёт задать `href` и `onClick` вместе: переход — это навигация с настоящим
 * `<a>`, действие — это `<button>`, и строка не может быть тем и другим сразу.
 */
export type GroupedRowProps = {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  /** Строка ведёт к необратимому разрушающему действию — подпись критическим цветом. */
  danger?: boolean;
  className?: string;
} & (
  | { href: string; onClick?: never }
  | { href?: never; onClick: () => void }
  | { href?: never; onClick?: never }
);

/**
 * Строка настройки.
 *
 * Без `href` и `onClick` строка ничего не делает сама — она лишь показывает
 * подпись и держит справа контрол (`Switch`, `Select`, значение).
 * С `href` вся строка становится ссылкой с шевроном, с `onClick` — кнопкой во
 * всю ширину: цель нажатия — строка целиком, а не подпись внутри неё.
 *
 * @param label Название настройки.
 * @param description Пояснение под подписью — что именно изменится.
 * @param control Элемент управления справа.
 * @param danger Подпись критическим цветом; смысл всё равно несёт текст, а не цвет (§5).
 */
export function GroupedRow({
  label,
  description,
  control,
  danger = false,
  href,
  onClick,
  className,
}: GroupedRowProps) {
  const body = (
    <>
      <span className="flex min-w-0 flex-col gap-1">
        <span className={cx('text-[13px]', danger ? 'text-crit' : 'text-ink')}>{label}</span>
        {description && <span className="text-xs text-ink-3">{description}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {control}
        {href !== undefined && <ChevronRight />}
      </span>
    </>
  );

  if (href !== undefined) {
    return (
      <Link
        href={href}
        className={cx(
          ROW,
          'no-underline transition-colors duration-150 hover:bg-raised/40',
          className,
        )}
      >
        {body}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cx(ROW, 'w-full transition-colors duration-150 hover:bg-raised/40', className)}
      >
        {body}
      </button>
    );
  }

  return <div className={cx(ROW, className)}>{body}</div>;
}
