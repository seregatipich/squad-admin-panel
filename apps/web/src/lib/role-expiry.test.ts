import { describe, expect, it } from 'vitest';
import {
  buildRoleAssignPayload,
  formatRoleExpiryLabel,
  formatVipExpiry,
  isRoleExpirySoon,
} from './role-expiry';

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

describe('isRoleExpirySoon', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const windows = [7, 3, 1];

  it('is true inside the largest window', () => {
    const inTwoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(isRoleExpirySoon(inTwoDays, windows, now)).toBe(true);
    const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(isRoleExpirySoon(inSevenDays, windows, now)).toBe(true);
  });

  it('is false outside the largest window', () => {
    const inTenDays = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(isRoleExpirySoon(inTenDays, windows, now)).toBe(false);
  });

  it('is false for a permanent grant', () => {
    expect(isRoleExpirySoon(null, windows, now)).toBe(false);
    expect(isRoleExpirySoon(undefined, windows, now)).toBe(false);
  });

  it('is false for an already-expired grant', () => {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(isRoleExpirySoon(yesterday, windows, now)).toBe(false);
  });

  it('is false for invalid input or empty windows', () => {
    expect(isRoleExpirySoon('not-a-date', windows, now)).toBe(false);
    const inTwoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(isRoleExpirySoon(inTwoDays, [], now)).toBe(false);
  });
});
