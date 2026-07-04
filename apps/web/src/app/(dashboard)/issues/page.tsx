'use client';

import { Suspense } from 'react';
import { IssuesBrowser } from './IssuesBrowser';

export default function IssuesPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <IssuesBrowser />
    </Suspense>
  );
}
