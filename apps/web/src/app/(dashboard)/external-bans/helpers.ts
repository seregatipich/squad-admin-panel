export {
  type BanStatusLike,
  banStatusBadge,
  formatDate,
  trustLevelLabel,
} from '../all-players/[id]/external-bans';

export const DEFAULT_LIMIT = 25;

export interface ExternalBansFilters {
  q: string;
  permanentOnly: boolean;
  sourceId: string;
  limit: number;
  offset: number;
}

interface ParamsLike {
  get(key: string): string | null;
}

/** Parses `/external-bans` search params into filter state, defaulting limit/offset/q. */
export function parseFilters(params: ParamsLike): ExternalBansFilters {
  const q = params.get('q') ?? '';
  const permanentOnly = params.get('permanent_only') === 'true';
  const sourceId = params.get('source_id') ?? '';
  const limitRaw = Number.parseInt(params.get('limit') ?? String(DEFAULT_LIMIT), 10);
  const offsetRaw = Number.parseInt(params.get('offset') ?? '0', 10);
  return {
    q,
    permanentOnly,
    sourceId,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
    offset: Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0,
  };
}

/** Builds the URL query string for the browser's own address bar (omits defaults). */
export function buildQueryString(filters: ExternalBansFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.permanentOnly) params.set('permanent_only', 'true');
  if (filters.sourceId) params.set('source_id', filters.sourceId);
  if (filters.offset > 0) params.set('offset', String(filters.offset));
  if (filters.limit !== DEFAULT_LIMIT) params.set('limit', String(filters.limit));
  return params.toString();
}

/** Builds the query string sent to `GET /api/v1/external-bans`. */
export function buildApiQuery(filters: ExternalBansFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.permanentOnly) params.set('permanent_only', 'true');
  if (filters.sourceId) params.set('source_id', filters.sourceId);
  params.set('limit', String(filters.limit));
  params.set('offset', String(filters.offset));
  return params.toString();
}

export interface IdentityRowLike {
  player_id: string | null;
  panel_nickname: string | null;
  bans: Array<{ nickname: string | null }>;
}

/** Row label: panel nickname > latest external nickname > "нет ника" badge. */
export function identityLabel(row: IdentityRowLike): string {
  if (row.panel_nickname) return row.panel_nickname;
  const externalNick = row.bans.find((ban) => ban.nickname)?.nickname;
  if (externalNick) return externalNick;
  return 'нет ника';
}
