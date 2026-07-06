import { describe, expect, it } from 'vitest';
import { buildRoleAssignPayload, formatRoleExpiryLabel } from './role-expiry';

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
});
