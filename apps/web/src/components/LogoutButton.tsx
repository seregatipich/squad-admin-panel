'use client';
import { useState } from 'react';
import { useTranslator } from '@/i18n/LocaleProvider';
import { apiResult } from '@/lib/api';

/**
 * Завершает сессию и уводит на страницу входа.
 *
 * Переход выполняется всегда: даже если запрос не дошёл, оставлять оператора
 * в панели с протухшей сессией хуже, чем показать ему вход. Если сервер ответил
 * ошибкой, сессия осталась живой, поэтому вход открывается с `?error=logout_failed`
 * и не перенаправляет обратно в панель.
 */
export async function logout(): Promise<void> {
  let destination = '/login';
  try {
    const response = await apiResult<unknown>('/api/v1/auth/logout', {
      method: 'POST',
      json: {},
      discardBody: true,
    });
    if (!response.ok) destination = '/login?error=logout_failed';
  } catch {
    // Сеть недоступна: страница входа сама проверит, жива ли сессия.
  }
  window.location.href = destination;
}

/**
 * Выход из панели.
 *
 * Не красный: по дизайн-системе (§5) критический цвет закреплён за
 * необратимым разрушением данных, а выход — обычное обратимое действие,
 * и красная подпись в меню только оттягивает на себя внимание.
 */
export function LogoutButton() {
  const [pending, setPending] = useState(false);
  const t = useTranslator();
  return (
    <button
      type="button"
      disabled={pending}
      className="whitespace-nowrap text-ink-2 transition-colors hover:text-ink disabled:opacity-40"
      onClick={() => {
        setPending(true);
        void logout();
      }}
    >
      {t('nav.logout')}
    </button>
  );
}
