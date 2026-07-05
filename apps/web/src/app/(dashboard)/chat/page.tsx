'use client';

import { Suspense } from 'react';
import { ChatArchive } from './ChatArchive';

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="text-neutral-500">Загрузка…</div>}>
      <ChatArchive />
    </Suspense>
  );
}
