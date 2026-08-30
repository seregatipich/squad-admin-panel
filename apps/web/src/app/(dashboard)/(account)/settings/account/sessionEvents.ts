import type { LiveEvent } from '@/lib/live-bus';

export type SessionRevokedEvent = Extract<LiveEvent, { type: 'session.revoked' }>;

export function isCurrentSessionRevoked(
  event: SessionRevokedEvent,
  currentSessionId: string | null,
): boolean {
  return currentSessionId !== null && event.data.session_id === currentSessionId;
}
