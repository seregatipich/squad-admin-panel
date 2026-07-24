'use client';
import { useState } from 'react';
import { useTranslator } from '@/i18n/LocaleProvider';

export function LogoutButton() {
  const [pending, setPending] = useState(false);
  const t = useTranslator();
  return (
    <button
      type="button"
      disabled={pending}
      className="mt-1 text-red-400 hover:text-red-300 disabled:opacity-50"
      onClick={async () => {
        setPending(true);
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
      }}
    >
      {t('nav.logout')}
    </button>
  );
}
