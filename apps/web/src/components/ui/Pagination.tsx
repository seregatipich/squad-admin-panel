'use client';

import { type KeyboardEvent, useId, useState } from 'react';
import { Button } from './Button';

/** Порог, после которого ручной переход к странице экономит время. */
const JUMP_THRESHOLD = 10;

export type PaginationLabels = {
  previous: string;
  next: string;
  /** «Страница 3 из 128» — и подпись под нумерацией, и имя блока навигации. */
  page: (page: number, of: number) => string;
};

export type PaginationProps = {
  /** Текущая страница, нумерация с 1. */
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  labels: PaginationLabels;
  /** Разрешить ввод номера страницы, когда страниц больше {@link JUMP_THRESHOLD}. */
  allowJump?: boolean;
};

/**
 * Постраничная навигация по списку.
 *
 * Числового ряда страниц здесь нет намеренно. В панели список банов или
 * логов — это сотни страниц; ряд номеров либо превращается в полосу из
 * многоточий, где нужная цифра всё равно не видна, либо переносится на вторую
 * строку и сдвигает содержимое. Оператору из ряда нужны ровно два перехода —
 * соседняя страница и конкретный номер, — поэтому здесь есть шаг вперёд, шаг
 * назад и, на длинных списках, поле для номера.
 *
 * Текст приходит только пропсами: примитив не знает про словарь переводов.
 *
 * @param page Текущая страница, с 1.
 * @param pageCount Всего страниц. На границах соответствующий шаг блокируется.
 * @param onChange Запрошенная страница; всегда в пределах `1…pageCount`.
 * @param labels Подписи шагов и функция подписи текущей страницы.
 * @param allowJump Показывать поле ввода номера. Срабатывает только при
 *   `pageCount > 10`: на коротком списке поле — лишний элемент управления.
 */
export function Pagination({
  page,
  pageCount,
  onChange,
  labels,
  allowJump = false,
}: PaginationProps) {
  const statusId = useId();
  const [jumpDraft, setJumpDraft] = useState(String(page));
  const [seenPage, setSeenPage] = useState(page);

  // Страницу сменили шагом, ссылкой или сбросом фильтров — поле показывает то
  // же, что и подпись, а не номер, который оператор когда-то в него набрал.
  if (seenPage !== page) {
    setSeenPage(page);
    setJumpDraft(String(page));
  }

  const status = labels.page(page, pageCount);
  const showJump = allowJump && pageCount > JUMP_THRESHOLD;

  const commitJump = () => {
    const parsed = Number.parseInt(jumpDraft, 10);
    if (Number.isNaN(parsed)) {
      setJumpDraft(String(page));
      return;
    }
    // Номер за пределами списка — это опечатка в разряде, а не запрос
    // несуществующей страницы: ближайшая существующая ближе к намерению,
    // чем молчаливый отказ.
    const target = Math.min(Math.max(parsed, 1), Math.max(pageCount, 1));
    setJumpDraft(String(target));
    if (target !== page) onChange(target);
  };

  const handleJumpKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitJump();
    }
  };

  return (
    <nav aria-labelledby={statusId} className="flex items-center gap-2">
      <Button size="sm" onClick={() => onChange(page - 1)} disabled={page <= 1}>
        {labels.previous}
      </Button>

      {/* Фокус после шага остаётся на кнопке, поэтому смену страницы объявляет
          сама подпись — иначе для скринридера не происходит ничего. */}
      <span id={statusId} aria-live="polite" className="text-xs tabular-nums text-ink-3">
        {status}
      </span>

      {showJump && (
        <input
          type="number"
          min={1}
          max={pageCount}
          value={jumpDraft}
          aria-label={status}
          onChange={(event) => setJumpDraft(event.target.value)}
          onKeyDown={handleJumpKeyDown}
          onBlur={commitJump}
          className="h-7 w-14 rounded-ctl border border-line bg-raised px-2 text-xs tabular-nums"
        />
      )}

      <Button size="sm" onClick={() => onChange(page + 1)} disabled={page >= pageCount}>
        {labels.next}
      </Button>
    </nav>
  );
}
