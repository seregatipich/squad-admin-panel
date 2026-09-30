'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { IconButton } from './Button';

/** Ширина окна: `sm` — 420px, `md` — 560px, `lg` — 860px (дизайн-система, §7). */
export type ModalSize = 'sm' | 'md' | 'lg';

/**
 * Классы перечислены целиком, а не собраны из кусков (`max-w-[${w}px]`): сканер
 * Tailwind 4 читает исходники как текст и не видит имён, склеенных в рантайме.
 */
const SIZE: Record<ModalSize, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[860px]',
};

/**
 * Крестик закрытия. Скрыт от скринридера: имя контролу даёт `aria-label`
 * кнопки, и второй источник имени только мешал бы.
 */
function CloseIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" className="size-3.5" fill="none">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export type ModalProps = {
  /** Окно открыто. Состояние живёт снаружи: примитив полностью управляемый. */
  open: boolean;
  /** Оператор попросил закрыть окно: Escape, крестик, клик по подложке. */
  onClose: () => void;
  title: string;
  description?: string;
  size?: ModalSize;
  /** Кнопки действия. Подтверждающая — последней в списке (§6). */
  footer?: ReactNode;
  children?: ReactNode;
  /** Доступное имя крестика закрытия. */
  closeLabel: string;
  /** См. JSDoc {@link Modal}: закрытие по Escape и клику по подложке. */
  dismissible?: boolean;
};

/**
 * Модальное окно поверх нативного `<dialog>`.
 *
 * Нативный элемент выбран не ради краткости кода: браузер сам даёт
 * фокус-ловушку, верхний слой (окно не может быть перекрыто ничьим `z-index`),
 * `::backdrop` и обработку Escape. Рукописная модалка из `<div>` повторяет это
 * приблизительно и почти всегда без ловушки фокуса — Tab уходит на страницу
 * под окном, и скринридер читает то, чего оператор не видит.
 *
 * Окно управляемое: `open` только приказывает браузеру открыть или закрыть
 * диалог, а закрытие всегда идёт через `onClose` и обновление состояния
 * снаружи. `onClose` вызывается **один раз на каждый жест** оператора (Escape,
 * крестик, клик по подложке), хотя браузер на Escape может прислать подряд
 * `cancel` и `close`. Владелец вправе проигнорировать вызов (например, пока
 * идёт операция): окно остаётся открытым, а следующий жест снова дойдёт до
 * `onClose`. Если браузер всё же закрыл диалог сам при `open = true`,
 * примитив открывает его снова.
 *
 * @param dismissible Разрешить закрытие «мягкими» жестами — Escape и кликом по
 *   подложке. Ставьте `false`, когда внутри есть несохранённые данные или идёт
 *   необратимая операция: случайный Escape над формой стирает работу оператора
 *   без единого вопроса. Крестик и кнопки подвала при этом остаются — выход
 *   из окна остаётся явным, а не исчезает.
 * @param footer Ряд кнопок под содержимым; подтверждающая кнопка идёт
 *   последней, потому что HIG ставит её справа.
 * @param closeLabel Подпись крестика: примитив не обращается к словарю
 *   переводов, весь человекочитаемый текст приходит пропсами.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  children,
  closeLabel,
  dismissible = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  /**
   * Последнее значение пропа `open`, видимое обработчикам нативных событий.
   * По нему `close`, пришедший после закрытия через проп, отличается от
   * закрытия, которое браузер сделал сам.
   */
  const openRef = useRef(open);

  /**
   * Этот `cancel` не удалось отменить, и браузер следом пришлёт `close` того же
   * Escape: он не должен уведомить владельца второй раз.
   */
  const escapeReportedRef = useRef(false);

  /**
   * Счётчик нативных закрытий при `open = true`. Его смена перезапускает
   * эффект синхронизации, и тот снова открывает окно, если владелец отклонил
   * закрытие (например, AlertDialog во время `busy`).
   */
  const [nativeCloseCount, setNativeCloseCount] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nativeCloseCount is a deliberate re-sync trigger, not read in the effect body
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    openRef.current = open;
    // `showModal()` на открытом диалоге и `close()` на закрытом бросают
    // InvalidStateError, поэтому состояние элемента проверяется до вызова.
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, nativeCloseCount]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // Окно управляемое: браузер его сам не закрывает, закрывает только проп.
    // Поэтому своего флага «уже уведомили» у примитива нет — каждый жест
    // оператора доходит до `onClose`, даже если прошлый владелец отклонил.
    const handleCancel = (event: Event) => {
      event.preventDefault();
      // Chrome не даёт отменить повторный Escape без активации пользователя.
      escapeReportedRef.current = !event.defaultPrevented;
      if (dismissible) onClose();
    };
    const handleNativeClose = () => {
      const escapeReported = escapeReportedRef.current;
      escapeReportedRef.current = false;
      if (!openRef.current) return;
      if (!escapeReported && dismissible) onClose();
      setNativeCloseCount((count) => count + 1);
    };

    // Клик по `::backdrop` приходит на сам `<dialog>`: отдельного узла у
    // подложки нет. Панель занимает элемент целиком (`p-0`), поэтому
    // `target === dialog` случается только за её пределами.
    // Выделение текста, начатое в панели и законченное над подложкой, тоже
    // порождает `click` на `<dialog>`, поэтому нажатие внутри панели
    // запоминается и такой `click` за закрытие не считается.
    let pressStartedInPanel = false;
    const handlePress = (event: Event) => {
      pressStartedInPanel = event.target !== dialog;
    };
    const handleSurfaceClick = (event: Event) => {
      const startedInPanel = pressStartedInPanel;
      pressStartedInPanel = false;
      if (!dismissible || event.target !== dialog || startedInPanel) return;
      onClose();
    };

    // События `cancel` и `close` не всплывают, поэтому все слушатели
    // висят на самом элементе, а не приходят пропсами React.
    dialog.addEventListener('cancel', handleCancel);
    dialog.addEventListener('close', handleNativeClose);
    dialog.addEventListener('mousedown', handlePress);
    dialog.addEventListener('click', handleSurfaceClick);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('close', handleNativeClose);
      dialog.removeEventListener('mousedown', handlePress);
      dialog.removeEventListener('click', handleSurfaceClick);
    };
  }, [dismissible, onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // `m-auto h-fit` возвращают окну центр. Браузер центрирует модальный
      // `<dialog>` штатными `inset: 0` + `margin: auto`, но сброс Tailwind
      // обнуляет поля у всех элементов, а при `inset: 0` и `height: auto`
      // абсолютно спозиционированный элемент растягивается на всю высоту и
      // прижимается к левому верхнему углу — окно появлялось в точке (0, 0).
      // `h-fit` снимает растяжение, после чего автоматические поля снова
      // делят свободное место поровну по обеим осям.
      // `open:flex`, а не `flex`: браузер прячет закрытый `<dialog>` правилом
      // `display: none`, и безусловный `display: flex` его перебивает — все
      // закрытые окна страницы становятся видимыми прямо в потоке, по одному
      // на каждую строку таблицы, которая их монтирует. Раскладка колонкой
      // нужна только открытому окну, поэтому она и включается вместе с ним.
      className={`m-auto h-fit max-h-[calc(100dvh-2rem)] w-full overflow-hidden open:flex open:flex-col ${SIZE[size]} rounded-card border border-line bg-surface p-0 text-ink backdrop:bg-black/50 backdrop:backdrop-blur-sm`}
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[13px] font-semibold text-ink">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="mt-1 text-xs text-ink-3">
              {description}
            </p>
          )}
        </div>
        <IconButton
          icon={<CloseIcon />}
          label={closeLabel}
          onClick={onClose}
          className="-mr-1 shrink-0"
        />
      </div>

      {/* Единственная область прокрутки окна. Раньше тело несло собственный
          `max-h-[70vh]`, а окно — свою высоту, и на высоком содержимом рядом
          оказывались две полосы прокрутки: сначала внешняя у диалога, потом
          внутренняя у тела. Теперь высоту ограничивает сам диалог, а тело
          забирает остаток колонки и прокручивается одно. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

      {footer && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
}
