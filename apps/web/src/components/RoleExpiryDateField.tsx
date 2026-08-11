'use client';

import { useRef } from 'react';
import { formatRoleExpiryDate } from '@/lib/role-expiry';

interface RoleExpiryDateFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

export function RoleExpiryDateField({ id, value, onChange }: RoleExpiryDateFieldProps) {
  const calendarRef = useRef<HTMLInputElement>(null);
  const helperId = `${id}-hint`;
  const formattedValue = formatRoleExpiryDate(value);

  function openCalendar() {
    const calendar = calendarRef.current;
    if (!calendar) return;
    if (typeof calendar.showPicker === 'function') {
      calendar.showPicker();
      return;
    }
    calendar.focus();
    calendar.click();
  }

  return (
    <div className="mt-1 space-y-1">
      <div className="flex items-stretch gap-2">
        <button
          id={id}
          type="button"
          onClick={openCalendar}
          aria-describedby={helperId}
          aria-label={
            formattedValue
              ? `Открыть календарь срока действия. Выбрано ${formattedValue}`
              : 'Открыть календарь срока действия'
          }
          className="flex min-h-10 min-w-0 flex-1 items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-left text-sm hover:border-neutral-600 focus-visible:border-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30"
        >
          <span className={formattedValue ? 'text-neutral-100' : 'text-neutral-500'}>
            {formattedValue || 'ДД/ММ/ГГГГ'}
          </span>
          <span className="shrink-0 text-xs text-sky-300">Календарь</span>
        </button>
        {value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Сделать роль бессрочной"
            className="rounded border border-neutral-800 px-3 text-xs text-neutral-300 hover:border-neutral-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30"
          >
            Сбросить
          </button>
        ) : null}
      </div>
      <input
        ref={calendarRef}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        tabIndex={-1}
        aria-hidden="true"
        data-testid="role-expiry-native-date"
        className="sr-only"
      />
      <p id={helperId} className="text-xs leading-5 text-neutral-500">
        Роль действует до конца выбранного дня по времени панели (UTC). Пустое поле — бессрочно.
      </p>
    </div>
  );
}
