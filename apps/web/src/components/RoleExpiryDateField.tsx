'use client';

import { useRef } from 'react';
import { Button } from '@/components/ui';
import { formatRoleExpiryDate } from '@/lib/role-expiry';

interface RoleExpiryDateFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Поле срока действия роли: видимая дата в формате ДД/ММ/ГГГГ и системный
 * календарь за ней.
 *
 * Нативный `<input type="date">` остаётся единственным источником значения —
 * он и открывает календарь платформы, — но на экране он скрыт: его собственная
 * отрисовка отличается в каждом браузере, а порядок полей зависит от локали
 * системы, и оператор в одной и той же панели видел бы то ДД/ММ/ГГГГ, то
 * ММ/ДД/ГГГГ. Кнопка поверх него показывает одну и ту же запись всегда.
 *
 * @param id Идентификатор видимой кнопки; на него ссылается подпись поля.
 * @param value Выбранный день в формате `ГГГГ-ММ-ДД`; пустая строка — бессрочно.
 * @param onChange Новый день или пустая строка, когда срок сняли.
 */
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
    <div className="space-y-1">
      <div className="flex items-center gap-2">
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
          className="flex h-8 min-w-0 flex-1 items-center justify-between gap-3 rounded-ctl border border-line bg-raised px-2.5 text-left text-xs transition-colors duration-150 hover:bg-line-2"
        >
          <span className={formattedValue ? 'text-ink' : 'text-ink-3'}>
            {formattedValue || 'ДД/ММ/ГГГГ'}
          </span>
          <span className="shrink-0 text-2xs text-accent">Календарь</span>
        </button>
        {value ? (
          <Button size="sm" aria-label="Сделать роль бессрочной" onClick={() => onChange('')}>
            Сбросить
          </Button>
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
      <p id={helperId} className="text-xs text-ink-3">
        Роль действует до конца выбранного дня по времени панели (UTC). Пустое поле — бессрочно.
      </p>
    </div>
  );
}
