'use client';
import { useState } from 'react';
import { useTranslator } from '@/i18n/LocaleProvider';

/**
 * Завершает сессию и уводит на страницу входа.
 *
 * Переход выполняется в `finally`: даже если запрос не дошёл, оставлять
 * оператора в панели с протухшей сессией хуже, чем показать ему вход.
 */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'include',
    });
  } finally {
    window.location.href = '/login';
  }
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
