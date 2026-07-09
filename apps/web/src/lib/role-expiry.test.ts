import { describe, expect, it } from 'vitest';
import { buildRoleAssignPayload, formatRoleExpiryLabel, formatVipExpiry } from './role-expiry';

describe('role expiry helpers', () => {
  it('builds role assignment payload with optional expiry and trimmed comment', () => {
    expect(buildRoleAssignPayload('role-1', '2026-08-01T12:30', '  VIP по заявке  ')).toEqual({
      role_id: 'role-1',
      expires_at: new Date('2026-08-01T12:30').toISOString(),
      comment: 'VIP по заявке',
    });
  });

  it('omits blank expiry/comment values', () => {
    expect(buildRoleAssignPayload('role-1', '', '   ')).toEqual({
      role_id: 'role-1',
      expires_at: null,
      comment: null,
    });
  });

  it('formats a missing role expiry for compact table cells', () => {
    expect(formatRoleExpiryLabel(null)).toBe('Без срока');
  });

  it('formats a permanent VIP grant as infinity', () => {
    expect(formatVipExpiry(null)).toBe('∞ бессрочно');
    expect(formatVipExpiry(undefined)).toBe('∞ бессрочно');
  });

  it('formats a future VIP grant as a relative countdown in days', () => {
    const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatVipExpiry(inThreeDays)).toBe('через 3 дн.');
  });

  it('formats a VIP grant expiring within a day as a relative countdown in hours', () => {
    const inFiveHours = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    expect(formatVipExpiry(inFiveHours)).toBe('через 5 ч.');
  });

  it('reports an already-passed expiry as expired', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatVipExpiry(yesterday)).toBe('Истекла');
  });

  it('reports an invalid timestamp distinctly', () => {
    expect(formatVipExpiry('not-a-date')).toBe('Некорректный срок');
  });
});
