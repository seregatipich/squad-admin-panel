'use client';

import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { IconButton } from './Button';

/** Поле ввода 32px из §6 дизайн-системы; поля справа — под кнопку очистки. */
const FIELD = 'h-8 w-full rounded-ctl border border-line bg-raised px-2.5 text-xs';
const FIELD_WITH_CLEAR = 'h-8 w-full rounded-ctl border border-line bg-raised px-2.5 pr-8 text-xs';

export type SearchFieldProps = {
  /** Запрос, применённый к списку прямо сейчас. */
  value: string;
  onCommit: (value: string) => void;
  placeholder: string;
  /** Доступное имя поля; уходит в `aria-label`. */
  label: string;
  /** Пауза перед отправкой набранного, мс. */
  delay?: number;
  autoFocus?: boolean;
  /** Доступное имя кнопки очистки. */
  clearLabel: string;
};

/**
 * Поле поиска по списку с отложенной отправкой запроса.
 *
 * Поле держит собственное черновое состояние и сообщает наружу не каждую
 * букву, а результат паузы в наборе: запрос идёт в базу по нескольким
 * колонкам, и посимвольная отправка превращает набор ника в очередь заведомо
 * ненужных запросов, последний из которых ещё и может прийти не последним.
 * Пауза убирает и то, и другое.
 *
 * Из паузы есть три выхода, и все три немедленные, потому что в каждом
 * оператор уже сказал, чего хочет: Enter, кнопка очистки и Escape.
 *
 * Текст приходит только пропсами: примитив не знает про словарь переводов.
 *
 * @param value Применённый запрос. Изменение снаружи (например, сбросом
 *   фильтров) возвращается в поле; собственное эхо — нет, иначе ответ на
 *   «abc» затирал бы уже набранное «abcd».
 * @param onCommit Вызывается с новым запросом: по паузе, по Enter и сразу при
 *   очистке.
 * @param placeholder Подсказка внутри поля.
 * @param label Доступное имя поля.
 * @param delay Пауза перед отправкой, по умолчанию 250 мс.
 * @param autoFocus Ставить курсор в поле при появлении — только для экрана,
 *   ради которого оператор его и открыл (диалог поиска, палитра команд).
 * @param clearLabel Доступное имя кнопки очистки.
 */
export function SearchField({
  value,
  onCommit,
  placeholder,
  label,
  delay = 250,
  autoFocus = false,
  clearLabel,
}: SearchFieldProps) {
  const [draft, setDraft] = useState(value);
  const [seenValue, setSeenValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedRef = useRef(value);
  const onCommitRef = useRef(onCommit);

  // Отложенный вызов живёт дольше одного рендера, поэтому берёт обработчик из
  // ссылки: иначе он звал бы тот `onCommit`, который был на момент нажатия.
  useEffect(() => {
    onCommitRef.current = onCommit;
  });

  // Значение сменилось снаружи — показать его. Собственное эхо пропускаем:
  // ответ на предыдущий запрос приходит уже поверх набранного дальше.
  if (seenValue !== value) {
    setSeenValue(value);
    if (value !== committedRef.current) setDraft(value);
  }

  const cancel = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Размонтирование посреди паузы не должно ни отправлять запрос, ни оставлять
  // таймер: экран уже закрыт, а в тестах он утёк бы в следующий.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const commitNow = (next: string) => {
    cancel();
    committedRef.current = next;
    onCommit(next);
  };

  const handleChange = (next: string) => {
    setDraft(next);
    cancel();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      committedRef.current = next;
      onCommitRef.current(next);
    }, delay);
  };

  const clear = () => {
    setDraft('');
    commitNow('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitNow(draft);
      return;
    }
    // Escape в непустом поле означает «убрать запрос», а не «закрыть экран»:
    // событие дальше не идёт, иначе диалог со списком закрылся бы вместе с
    // очисткой. Пустое поле Escape не трогает — там он нужен экрану.
    if (event.key === 'Escape' && draft !== '') {
      event.preventDefault();
      event.stopPropagation();
      clear();
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="search"
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className={draft === '' ? FIELD : FIELD_WITH_CLEAR}
      />
      {draft !== '' && (
        <IconButton
          icon={<span aria-hidden="true">✕</span>}
          label={clearLabel}
          onClick={clear}
          className="absolute right-0.5 top-0.5"
        />
      )}
    </div>
  );
}
