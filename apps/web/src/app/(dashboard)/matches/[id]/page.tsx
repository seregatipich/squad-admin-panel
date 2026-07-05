'use client';

import { use } from 'react';
import { MatchCard } from './MatchCard';

export default function MatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <MatchCard matchId={id} />;
}
