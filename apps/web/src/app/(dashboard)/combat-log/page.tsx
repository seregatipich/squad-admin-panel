'use client';

import { Suspense } from 'react';
import { CombatLog } from './CombatLog';

export default function CombatLogPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <CombatLog />
    </Suspense>
  );
}
