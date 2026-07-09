'use client';

import { use } from 'react';
import { safeMatchBackHref } from '../helpers';
import { MatchCard } from './MatchCard';

export default function MatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { id } = use(params);
  const { from } = use(searchParams);
  return <MatchCard matchId={id} backHref={safeMatchBackHref(from)} />;
}
