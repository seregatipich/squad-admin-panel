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

interface GlobalLogoutResponse {
  ok: true;
  remote_ok: boolean;
  site_url: string;
}

function safeLogoutDestination(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}

/** Отзывает все сессии обоих приложений и переходит к результату на сайте. */
export async function logoutEverywhere(): Promise<void> {
  let destination = '/login';
  try {
    const response = await fetch('/api/v1/auth/logout-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'include',
    });
    if (response.ok) {
      const result = (await response.json()) as Partial<GlobalLogoutResponse>;
      if (result.ok === true && typeof result.remote_ok === 'boolean') {
        destination = safeLogoutDestination(result.site_url) ?? destination;
      }
    }
  } finally {
    window.location.href = destination;
  }
}

function LogoutAction({ everywhere = false }: { everywhere?: boolean }) {
  const [pending, setPending] = useState(false);
  const t = useTranslator();
  return (
    <button
      type="button"
      disabled={pending}
      className="min-h-11 whitespace-nowrap px-2 text-ink-2 transition-colors hover:text-ink disabled:opacity-40"
      onClick={() => {
        setPending(true);
        void (everywhere ? logoutEverywhere() : logout());
      }}
    >
      {t(everywhere ? 'nav.logoutAll' : 'nav.logout')}
    </button>
  );
}

/**
 * Выход из панели.
 *
 * Не красный: по дизайн-системе (§5) критический цвет закреплён за
 * необратимым разрушением данных, а выход — обычное обратимое действие,
 * и красная подпись в меню только оттягивает на себя внимание.
 */
export function LogoutButton() {
  return <LogoutAction />;
}

export function GlobalLogoutButton() {
  return <LogoutAction everywhere />;
}
