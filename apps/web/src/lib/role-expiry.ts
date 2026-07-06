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

export function toDatetimeLocalValue(expiresAt: string | null | undefined): string {
  if (!expiresAt) return '';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
