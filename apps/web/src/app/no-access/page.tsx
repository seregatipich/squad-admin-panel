'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function NoAccessContent() {
  const params = useSearchParams();
  const sid = params.get('steam_id64');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-4 text-center text-neutral-100">
      <h1 className="mb-4 text-2xl font-semibold">Доступ запрещён</h1>
      {sid ? (
        <p className="mb-2">
          Steam ID <code className="font-mono text-amber-400">{sid}</code> не имеет роли в этой
          панели.
        </p>
      ) : (
        <p className="mb-2">Ваш Steam-аккаунт не имеет роли в этой панели.</p>
      )}
      <p className="mb-6 max-w-md text-sm text-neutral-400">
        Обратитесь к администратору, чтобы вам назначили роль. После назначения войдите снова через
        Steam.
      </p>
      <Link href="/login" className="text-sky-400 hover:text-sky-300">
        Вернуться на страницу входа
      </Link>
      <p className="mt-12 text-xs text-neutral-600">
        Если вы Owner свежеустановленной панели, проверьте журнал
        <code className="ml-1 font-mono">/var/lib/squad-panel/.first-owner-claimed</code>.
      </p>
    </main>
  );
}

export default function NoAccessPage() {
  return (
    <Suspense fallback={null}>
      <NoAccessContent />
    </Suspense>
  );
}
