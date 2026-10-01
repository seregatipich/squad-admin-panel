import type { AlertDialogTone } from '@/components/ui';
import { ApiError } from '@/lib/api';

export const POLL_MS = 8000;

/**
 * A 404 (no such route) or 409 (`external_server`: no config tree at all)
 * answers the same way on every later poll, so polling stops instead of
 * re-bannering every POLL_MS forever (#609).
 */
export function isHardFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 409);
}

export interface Version {
  id: string;
  sha256: string;
  author_user_id: string | null;
  author_email: string | null;
  message: string | null;
  size: number;
  created_at: string;
}

export interface BlameLine {
  text: string;
  version_id: string;
  author_user_id: string | null;
  created_at: string;
}

export interface BlameResponse {
  lines: BlameLine[];
  authors: Record<string, string>;
  /** Older history was cut off; its lines are attributed to the oldest version shown. */
  truncated?: boolean;
}

/** Files whose drift/reset story is owned by dedicated machinery — no
 *  reset-to-depot-default button for them. */
export const RESET_EXCLUDED_FILES = ['License.cfg', 'Admins.cfg', 'LayerRotation.cfg'];

export type Tab = 'editor' | 'history' | 'blame';

export const TABS = [
  { value: 'editor', label: 'Редактор' },
  { value: 'history', label: 'История' },
  { value: 'blame', label: 'Blame' },
];

/**
 * Вопрос, на который оператор ещё не ответил.
 *
 * Раньше это был `window.confirm`, и вся ветка была синхронной. Диалог
 * подтверждения асинхронный, поэтому намерение приходится хранить: пока окно
 * открыто, страница помнит, что именно она собиралась сделать.
 */
export type Confirmation =
  | { kind: 'switch-file'; name: string }
  | { kind: 'restore'; versionId: string }
  | { kind: 'restart' }
  | { kind: 'drift'; name: string; action: 'accept' | 'revert' }
  | { kind: 'reset'; name: string };

/** Файл, который панель читает замаскированным и не принимает обратно: PUT и restore отвечают 400. */
export const PANEL_MANAGED_FILE = 'License.cfg';

/** Предупреждение для действий, которые перечитывают открытый файл поверх правок в редакторе. */
export const UNSAVED_EDITS_WARNING = ' Несохранённые правки в редакторе будут потеряны.';

/** Текст диалога подтверждения: что произойдёт и как называется само действие. */
export function confirmationText(c: Confirmation): {
  title: string;
  body: string;
  confirmLabel: string;
  tone: AlertDialogTone;
} {
  switch (c.kind) {
    case 'switch-file':
      return {
        title: 'Открыть другой файл?',
        body: 'В открытом файле есть несохранённые правки. Если открыть другой файл, они пропадут — на диске и в истории останется прежнее содержимое.',
        confirmLabel: 'Открыть без сохранения',
        tone: 'default',
      };
    case 'restore':
      return {
        title: 'Восстановить эту версию?',
        body: 'Содержимое версии станет новой версией файла. История сохранится целиком, ничего не удаляется.',
        confirmLabel: 'Восстановить как новую версию',
        tone: 'default',
      };
    case 'restart':
      return {
        title: 'Перезапустить сервер?',
        body: 'Игроки будут отключены на время рестарта.',
        confirmLabel: 'Перезапустить сервер',
        tone: 'default',
      };
    case 'drift':
      return c.action === 'accept'
        ? {
            title: `Принять правку ${c.name} с диска?`,
            body: 'Содержимое файла с диска станет новой версией в панели.',
            confirmLabel: 'Принять правку с диска',
            tone: 'default',
          }
        : {
            title: `Откатить ${c.name} к версии панели?`,
            body: 'Ручные изменения на диске будут перезаписаны. Панель их не сохраняла, восстановить будет нечем.',
            confirmLabel: 'Откатить к версии панели',
            tone: 'destructive',
          };
    case 'reset':
      return {
        title: `Сбросить ${c.name} к депо-дефолту?`,
        body: 'Текущее содержимое файла будет заменено шаблоном из поставки. Прежнее содержимое останется в истории версий.',
        confirmLabel: 'Сбросить к дефолту',
        tone: 'default',
      };
  }
}
