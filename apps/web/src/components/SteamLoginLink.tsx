import type { ReactNode } from 'react';

const STEAM_LINK_CLASS =
  'inline-flex h-8 w-full items-center justify-center rounded-ctl bg-accent px-3 text-xs font-medium text-bg no-underline transition-colors duration-150 hover:brightness-110';

/**
 * Кнопка входа через Steam — обычный `<a>`, а не `ButtonLink`.
 *
 * `/api/v1/auth/steam/login` начинает OpenID-обмен и обязан получить полную
 * навигацию документа: `next/link` перехватил бы клик маршрутизатором и
 * предзагрузил бы адрес заранее. Поэтому классы кнопки выписаны вручную.
 * Используется на страницах входа и первичной настройки.
 */
export function SteamLoginLink({ children }: { children: ReactNode }) {
  return (
    <a href="/api/v1/auth/steam/login" className={STEAM_LINK_CLASS}>
      {children}
    </a>
  );
}
