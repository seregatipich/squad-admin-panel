export interface RoleAssignPayload {
  role_id: string;
  expires_at: string | null;
  comment: string | null;
}

const roleExpiryDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function roleExpiryDateToIso(dateValue: string): string {
  if (!roleExpiryDatePattern.test(dateValue)) throw new Error('invalid_role_expiry_date');
  const expiry = new Date(`${dateValue}T23:59:59.999Z`);
  if (Number.isNaN(expiry.getTime()) || expiry.toISOString().slice(0, 10) !== dateValue) {
    throw new Error('invalid_role_expiry_date');
  }
  return expiry.toISOString();
}

export function buildRoleAssignPayload(
  roleId: string,
  expiryDate: string,
  comment: string,
): RoleAssignPayload {
  const trimmedComment = comment.trim();
  return {
    role_id: roleId,
    expires_at: expiryDate ? roleExpiryDateToIso(expiryDate) : null,
    comment: trimmedComment || null,
  };
}

export function toRoleExpiryDateValue(expiresAt: string | null | undefined): string {
  if (!expiresAt) return '';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function formatRoleExpiryDate(dateValue: string): string {
  if (!dateValue) return '';
  try {
    roleExpiryDateToIso(dateValue);
  } catch {
    return '';
  }
  const [year, month, day] = dateValue.split('-');
  return `${day}/${month}/${year}`;
}

export function formatRoleExpiryLabel(expiresAt: string | null | undefined): string {
  if (!expiresAt) return 'Без срока';
  const dateValue = toRoleExpiryDateValue(expiresAt);
  const formatted = formatRoleExpiryDate(dateValue);
  if (!formatted) return 'Некорректный срок';
  return `До ${formatted} включительно`;
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

/** Server-side default for `vip_expiry_windows_days` (migration 0092, VIPSUB-4 #170). */
export const DEFAULT_VIP_EXPIRY_WINDOWS_DAYS = [7, 3, 1];

/**
 * True when a time-limited grant is inside the largest configured reminder
 * window: `0 < expiresAt - now <= max(windows)` days. Drives the «истекает»
 * badges on `/vips` and the player card (VIPSUB-4, #170). Permanent grants
 * (`null`), invalid timestamps, already-expired grants, and an empty windows
 * list are all "not soon".
 */
export function isRoleExpirySoon(
  expiresAt: string | null | undefined,
  windows: number[],
  now: Date = new Date(),
): boolean {
  if (!expiresAt || windows.length === 0) return false;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return false;
  const msLeft = date.getTime() - now.getTime();
  if (msLeft <= 0) return false;
  return msLeft <= Math.max(...windows) * 24 * 60 * 60 * 1000;
}
