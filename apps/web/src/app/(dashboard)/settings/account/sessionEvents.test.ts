import { describe, expect, it } from 'vitest';
import { isCurrentSessionRevoked, type SessionRevokedEvent } from './sessionEvents';

function makeEvent(sessionId: string): SessionRevokedEvent {
  return {
    type: 'session.revoked',
    ts: '2026-07-04T00:00:00.000Z',
    data: { player_id: 'player-1', session_id: sessionId },
  };
}

describe('isCurrentSessionRevoked', () => {
  it('forces logout when the revoked session is this tab', () => {
    expect(isCurrentSessionRevoked(makeEvent('sid-current'), 'sid-current')).toBe(true);
  });

  it('leaves this tab alone when another session is revoked', () => {
    expect(isCurrentSessionRevoked(makeEvent('sid-other'), 'sid-current')).toBe(false);
  });

  it('does not force logout when the current session id is unknown', () => {
    expect(isCurrentSessionRevoked(makeEvent('sid-current'), null)).toBe(false);
  });
});
