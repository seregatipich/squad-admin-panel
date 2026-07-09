export interface RoleAssignPayload {
  role_id: string;
  expires_at: string | null;
  comment: string | null;
}

export function buildRoleAssignPayload(
  roleId: string,
  expiresAtLocal: string,
  comment: string,
): RoleAssignPayload {
  const trimmedComment = comment.trim();
  return {
    role_id: roleId,
    expires_at: expiresAtLocal ? new Date(expiresAtLocal).toISOString() : null,
    comment: trimmedComment || null,
  };
}

export function formatRoleExpiryLabel(expiresAt: string | null | undefined): string {
  if (!expiresAt) return 'Без срока';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return 'Некорректный срок';
  return `До ${date.toLocaleString()}`;
}

/**
 * Formats a role/VIP expiry for compact registry rows (the `/vips` page):
 * `∞` for a permanent grant (`null`), a relative "in Nd/Nh" countdown for an
 * active time-limited grant, and "expired" if the timestamp has already
 * passed (the role-expirer worker clears such rows on its next tick, but the
 * page may render a brief window before that happens).
 */
export function formatVipExpiry(expiresAt: string | null | undefined): string {
  if (!expiresAt) return '∞ бессрочно';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return 'Некорректный срок';
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'Истекла';
  const diffHours = Math.ceil(diffMs / (60 * 60 * 1000));
  if (diffHours < 24) return `через ${diffHours} ч.`;
  const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  return `через ${diffDays} дн.`;
}

export function toDatetimeLocalValue(expiresAt: string | null | undefined): string {
  if (!expiresAt) return '';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
