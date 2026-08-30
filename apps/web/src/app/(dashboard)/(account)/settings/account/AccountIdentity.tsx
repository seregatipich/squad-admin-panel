'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui';
import {
  type AccountNames,
  displayName,
  formatDay,
  formatPreviousNamesCount,
  previousNames,
} from './helpers';

/**
 * Ник оператора в шапке страницы «Аккаунт» и история его смен.
 *
 * История прячется за кнопкой, а не выкладывается рядом: у игрока, который
 * переименовывался годами, она набирает десятки строк и растянула бы шапку
 * вниз на весь экран — а нужна она изредка. Показывается модальное окно, а не
 * выпадающий список: `Menu` в дизайн-системе описывает команды, и роль
 * `menuitem` на строке, которую нельзя выбрать, врёт скринридеру.
 *
 * @param names Ответ `GET /api/v1/me/names`; `null`, пока он ещё не пришёл.
 */
export function AccountIdentity({ names }: { names: AccountNames | null }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  if (names === null) return null;

  const current = displayName(names);
  const previous = previousNames(names);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[13px] font-medium text-ink" title={current}>
        {current}
      </span>
      {previous.length > 0 && (
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="shrink-0 rounded-ctl border border-line px-2 py-0.5 text-2xs text-ink-3 transition-colors hover:bg-raised hover:text-ink"
        >
          {formatPreviousNamesCount(previous.length)}
        </button>
      )}
      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="История ников"
        description="Имена, под которыми вас видели на серверах."
        closeLabel="Закрыть"
        size="sm"
      >
        <ul className="divide-y divide-line">
          {previous.map((entry) => (
            <li
              key={entry.name}
              className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0"
            >
              <span className="min-w-0 truncate text-[13px] text-ink">{entry.name}</span>
              <span className="shrink-0 text-2xs tabular-nums text-ink-3">
                {formatDay(entry.first_seen_at)} — {formatDay(entry.last_seen_at)}
              </span>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
