'use client';

import { Suspense, use } from 'react';
import { CombatLog } from '../../../combat-log/CombatLog';

export default function ServerCombatLogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <CombatLog lockedServerId={id} />
    </Suspense>
  );
}
