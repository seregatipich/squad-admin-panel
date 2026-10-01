export interface Member {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  last_seen_at: string;
  role_comment: string | null;
}

export interface MembersResponse {
  role: { id: string; name: string; color: string };
  items: Member[];
  total: number;
  limit: number;
  offset: number;
}

export interface PlayerSearchItem {
  id: string;
  steam_id64: string | null;
  canonical_name: string;
  last_seen_at: string;
}

export interface RoleOption {
  id: string;
  name: string;
  color: string;
  is_system_role: boolean;
}

export const PAGE_SIZE = 100;

export const NETWORK_ERROR_TEXT = 'сетевая ошибка, проверьте соединение и повторите';

export const ACTION_ERROR_LABELS: Record<string, string> = {
  forbidden: 'недостаточно прав',
  role_not_found: 'роль не найдена',
  target_role_not_found: 'целевая роль не найдена',
  target_role_same_as_source: 'нельзя переместить в ту же роль',
  player_not_found: 'игрок не найден в базе',
  owner_assignment_forbidden: 'нельзя назначать или перемещать участников в роль Owner',
  cannot_change_own_role: 'нельзя менять собственную роль',
  role_exceeds_actor_permissions: 'роль шире ваших прав',
  target_outranks_actor: 'у участника права выше ваших',
  owner_role_immutable: 'роль Owner нельзя изменять',
  cannot_remove_last_owner: 'нельзя снять роль с последнего владельца',
  too_many_rows: 'слишком много строк в файле',
};

/**
 * Builds the banner text for a failed member action, translating the API
 * error codes the members routes return; unknown codes are shown verbatim.
 *
 * @param failure Russian description of the attempted action.
 * @param code Error code from the response body, if any.
 * @param status HTTP status used when the body carries no code.
 */
export function actionErrorText(failure: string, code: unknown, status: number): string {
  if (typeof code === 'string') return `${failure}: ${ACTION_ERROR_LABELS[code] ?? code}`;
  return `${failure}: ${status}`;
}
