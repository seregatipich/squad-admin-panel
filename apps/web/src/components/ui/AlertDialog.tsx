'use client';

import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

/** Цена ошибки: `destructive` — необратимое разрушение данных (§5). */
export type AlertDialogTone = 'default' | 'destructive';

/** Подтверждение вводом: оператор повторяет строку, которую нельзя набрать случайно. */
export type AlertDialogChallenge = {
  /** Строка, которую нужно повторить символ в символ — обычно имя объекта. */
  expected: string;
  /** Подпись поля ввода. */
  label: string;
  /** Пояснение под полем — например, сама ожидаемая строка. */
  hint?: string;
};

export type AlertDialogProps = {
  open: boolean;
  /** Оператор отказался: «Отмена», крестик, Escape, клик по подложке. */
  onClose: () => void;
  title: string;
  /** Что именно произойдёт и что будет потеряно. */
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone: AlertDialogTone;
  onConfirm: () => void | Promise<void>;
  /** Действие выполняется: окно заперто до ответа сервера. */
  busy?: boolean;
  challenge?: AlertDialogChallenge;
};

/**
 * Диалог подтверждения поверх {@link Modal}.
 *
 * Отличие от `Modal` не в оформлении, а в назначении. `Modal` — это слой с
 * произвольным содержимым: форма, просмотр, что угодно, и выйти из него можно
 * сколькими угодно способами. Алерт задаёт **один вопрос** и имеет ровно
 * **два выхода** — подтвердить или отказаться; поэтому подвал здесь не
 * настраивается, а `body` — это только текст вопроса. Всё, что предлагает
 * оператору третий путь, в алерт не помещается и должно быть обычным окном.
 *
 * @param tone `destructive` красит подтверждающую кнопку критическим цветом.
 *   Смысл всё равно несёт подпись, а не цвет (§5), поэтому `confirmLabel`
 *   называет действие («Удалить сервер»), а не отвечает «Да».
 * @param busy Пока действие идёт, окно нельзя закрыть **ничем** — ни Escape,
 *   ни подложкой, ни крестиком: запрос уже ушёл на сервер, и закрытое окно
 *   лишь скрыло бы от оператора его результат.
 * @param challenge Требовать ввод точной строки перед подтверждением.
 *   Сравнение посимвольное, без обрезки пробелов: смысл барьера в том, чтобы
 *   необратимое действие нельзя было запустить не глядя.
 * @param onConfirm Может вернуть промис; ожидание отображается через `busy`,
 *   которым владеет вызывающая сторона — она же обрабатывает ошибки.
 */
export function AlertDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone,
  onConfirm,
  busy = false,
  challenge,
}: AlertDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const hintId = useId();

  // Каждое открытие начинается с пустого поля: строка, набранная для прошлой
  // операции, иначе разблокировала бы подтверждение следующей.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const confirmable = challenge === undefined || typed === challenge.expected;

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const handleConfirm = () => {
    if (busy || !confirmable) return;
    void onConfirm();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      size="sm"
      closeLabel={cancelLabel}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'destructive' ? 'destructive' : 'primary'}
            onClick={handleConfirm}
            disabled={!confirmable}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="text-[13px] text-ink-2">{body}</div>
        {challenge && (
          <div className="space-y-1">
            <label htmlFor={inputId} className="block text-xs text-ink-2">
              {challenge.label}
            </label>
            <input
              id={inputId}
              type="text"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={challenge.hint ? hintId : undefined}
              className="h-8 w-full rounded-ctl border border-line bg-raised px-2.5 text-[13px] text-ink"
            />
            {challenge.hint && (
              <p id={hintId} className="text-xs text-ink-3">
                {challenge.hint}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
