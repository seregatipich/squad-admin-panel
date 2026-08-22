'use client';

import { type ReactNode, useCallback, useEffect, useId, useRef } from 'react';
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
 * снаружи. `onClose` гарантированно вызывается **не больше одного раза за одно
 * открытие**, хотя браузер на Escape шлёт подряд два события (`cancel`, затем
 * `close`).
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
   * Открыто ли окно с точки зрения самого примитива. Флаг гасит повторные
   * уведомления: Escape поднимает `cancel` и `close`, а закрытие через проп
   * поднимает `close` уже после того, как снаружи всё закрыли.
   */
  const notifiedRef = useRef(open);

  const notifyClose = useCallback(() => {
    if (!notifiedRef.current) return;
    notifiedRef.current = false;
    onClose();
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    notifiedRef.current = open;
    // `showModal()` на открытом диалоге и `close()` на закрытом бросают
    // InvalidStateError, поэтому состояние элемента проверяется до вызова.
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleCancel = (event: Event) => {
      if (!dismissible) {
        event.preventDefault();
        return;
      }
      notifyClose();
    };
    const handleNativeClose = () => notifyClose();

    // Клик по `::backdrop` приходит на сам `<dialog>`: отдельного узла у
    // подложки нет. Панель занимает элемент целиком (`p-0`), поэтому
    // `target === dialog` случается только за её пределами.
    const handleSurfaceClick = (event: Event) => {
      if (!dismissible || event.target !== dialog) return;
      notifyClose();
    };

    // События `cancel` и `close` не всплывают, поэтому все три слушателя
    // висят на самом элементе, а не приходят пропсами React.
    dialog.addEventListener('cancel', handleCancel);
    dialog.addEventListener('close', handleNativeClose);
    dialog.addEventListener('click', handleSurfaceClick);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('close', handleNativeClose);
      dialog.removeEventListener('click', handleSurfaceClick);
    };
  }, [dismissible, notifyClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={`w-full ${SIZE[size]} rounded-card border border-line bg-surface p-0 text-ink backdrop:bg-black/50 backdrop:backdrop-blur-sm`}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
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
          onClick={notifyClose}
          className="-mr-1 shrink-0"
        />
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-4 py-4">{children}</div>

      {footer && (
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
}
