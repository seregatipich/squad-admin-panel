import type { Locale } from '@/i18n/config';

/**
 * DOSSIER-6 (#193): types, formatters and sorters behind the player card's
 * «Досье» block.
 *
 * Every conditional the four tabs need lives here rather than in the `.tsx`
 * files, so the feature's behaviour is unit-covered and the components stay
 * declarative. The shapes mirror the consolidated payload of
 * `GET /api/v1/players/:playerId/dossier` field for field.
 */

/** Default `weaponsLimit` sent to the dossier route (its own default is 20). */
export const DOSSIER_WEAPONS_LIMIT = 20;

/** Shown on every damage cell the source cannot fill; never replaced by a zero. */
export const DAMAGE_UNAVAILABLE_HINT = 'Источник не содержит данных об уроне';

/** `title` of a vehicle row whose asset id is missing from `vehicle_catalog`. */
export const VEHICLE_UNCATALOGUED_HINT = 'Нет в каталоге техники';

/** Replaces the server selector on the tabs whose aggregates carry no server dimension. */
export const LIFETIME_ONLY_NOTE = 'Пожизненно, без разбивки по серверам';

/**
 * Body of the RNSquadJS sub-section. STATS-4 (#71) shipped
 * `GET /api/v1/servers/:id/rnsquadjs`, but that route is per-server sidecar
 * status; no per-player RNSquadJS aggregate exists, so this tab still has
 * nothing to read.
 */
export const RNSQUADJS_UNAVAILABLE = 'Данные RNSquadJS недоступны';

export interface DossierSkill {
  kills: number;
  deaths: number;
  kd: number;
  teamkills: number;
  revives: number;
  /** Permanently null in the API (player-dossier.ts:242); renders as «—». */
  damage_dealt: null;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winrate: number | null;
}

/** `month` is a postgres `date` in `mode: 'string'` — always `YYYY-MM-DD`, day 01. */
export interface DossierTrendPoint {
  month: string;
  kills: number;
  deaths: number;
}

export interface DossierWeapon {
  weapon: string;
  kills: number;
  teamkills: number;
  damage: number | null;
  shots_events: number;
  last_used_at: string | null;
}

export interface DossierVehicle {
  vehicle_asset_id: string;
  name_en: string | null;
  name_ru: string | null;
  vehicle_class: string | null;
  unlocalized: boolean;
  kills: number;
  damage: number | null;
}

export interface DossierVehicleKill {
  victim_vehicle_asset_id: string;
  name_en: string | null;
  name_ru: string | null;
  vehicle_class: string | null;
  unlocalized: boolean;
  weapon: string;
  destroyed_count: number;
}

export interface DossierKit {
  kit: string;
  seconds: number;
  last_played_at: string | null;
}

export interface DossierResponse {
  skill: DossierSkill;
  kd_trend: DossierTrendPoint[];
  weapons: DossierWeapon[];
  weapons_total: number;
  vehicles: DossierVehicle[];
  vehicle_kills: DossierVehicleKill[];
  kits: DossierKit[];
  period: string;
  server_id: string | null;
}

export type DossierTab = 'skill' | 'weapons' | 'vehicles' | 'kits';
export type WeaponSortKey = 'kills' | 'damage';

/** months = null means "all time" (no `from` bound). */
export interface DossierPeriodOption {
  months: number | null;
  label: string;
}

export const DOSSIER_PERIODS: readonly DossierPeriodOption[] = [
  { months: 3, label: '3 мес' },
  { months: 6, label: '6 мес' },
  { months: 12, label: '12 мес' },
  { months: null, label: 'Всё время' },
];

const MONTH_KEY = /^(\d{4})-(\d{2})-\d{2}$/;

/** Calendar month as a single ordinal, so windows are plain integer arithmetic. */
function toAbsMonth(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/** Inverse of {@link toAbsMonth}, rendered as the API's `YYYY-MM-01` month key. */
function fromAbsMonth(abs: number): string {
  const year = Math.floor(abs / 12);
  const month = abs - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/** null for anything that is not a `YYYY-MM-DD` key. */
function parseMonthAbs(month: string): number | null {
  const parsed = MONTH_KEY.exec(month);
  if (parsed === null) return null;
  return toAbsMonth(Number(parsed[1]), Number(parsed[2]));
}

/** `—` for null; otherwise the value rounded and grouped for ru-RU. */
export function formatDamage(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('ru-RU');
}

export function hasAnyDamage(rows: readonly { damage: number | null }[]): boolean {
  return rows.some((row) => row.damage !== null);
}

/** Always `Nч Nм`; `—` for a negative or non-finite input. */
export function formatKitTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 3600)}ч ${Math.floor((total % 3600) / 60)}м`;
}

/** `—` for null; otherwise a whole percent with a `%` suffix. */
export function formatWinrate(winrate: number | null): string {
  if (winrate === null || !Number.isFinite(winrate)) return '—';
  return `${Math.round(winrate * 100)}%`;
}

/** Matches `computeKdRatio` in packages/db/src/leaderboard/aggregate.ts:17-20. */
export function trendKd(kills: number, deaths: number): number {
  if (deaths === 0) return kills;
  return kills / deaths;
}

/** `MM.YYYY` from a `YYYY-MM-DD` month key. */
export function trendMonthLabel(month: string): string {
  const parsed = MONTH_KEY.exec(month);
  if (parsed === null) return month;
  return `${parsed[2]}.${parsed[1]}`;
}

/**
 * Zero-fills the months the API drops (matches_played > 0 filter).
 * monthsBack = N  -> exactly N consecutive months ending at now's UTC month.
 * monthsBack = null -> every month from the earliest to the latest present row;
 *                      [] when rows is empty.
 */
export function fillTrendMonths(
  rows: readonly DossierTrendPoint[],
  monthsBack: number | null,
  now: Date,
): DossierTrendPoint[] {
  const byMonth = new Map<number, DossierTrendPoint>();
  for (const row of rows) {
    const abs = parseMonthAbs(row.month);
    if (abs !== null) byMonth.set(abs, row);
  }

  let start: number;
  let end: number;
  if (monthsBack === null) {
    const present = [...byMonth.keys()];
    if (present.length === 0) return [];
    start = Math.min(...present);
    end = Math.max(...present);
  } else {
    end = toAbsMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
    start = end - (monthsBack - 1);
  }

  const filled: DossierTrendPoint[] = [];
  for (let abs = start; abs <= end; abs += 1) {
    const row = byMonth.get(abs);
    filled.push(row ?? { month: fromAbsMonth(abs), kills: 0, deaths: 0 });
  }
  return filled;
}

/** New array. 'kills' -> kills desc, shots_events desc tiebreak. 'damage' -> damage desc, nulls last. */
export function sortWeapons(rows: readonly DossierWeapon[], key: WeaponSortKey): DossierWeapon[] {
  const copy = [...rows];
  if (key === 'damage') {
    return copy.sort((a, b) => {
      if (a.damage === null && b.damage === null) return 0;
      if (a.damage === null) return 1;
      if (b.damage === null) return -1;
      return b.damage - a.damage;
    });
  }
  return copy.sort((a, b) => b.kills - a.kills || b.shots_events - a.shots_events);
}

/** New array, seconds desc. */
export function sortKits(rows: readonly DossierKit[]): DossierKit[] {
  return [...rows].sort((a, b) => b.seconds - a.seconds);
}

/** unlocalized -> the raw asset id. ru -> name_ru, falling back to name_en, then the asset id. en -> mirrored. */
export function vehicleDisplayName(
  row: {
    vehicle_asset_id: string;
    name_en: string | null;
    name_ru: string | null;
    unlocalized: boolean;
  },
  locale: Locale,
): string {
  if (row.unlocalized) return row.vehicle_asset_id;
  if (locale === 'ru') return row.name_ru ?? row.name_en ?? row.vehicle_asset_id;
  return row.name_en ?? row.name_ru ?? row.vehicle_asset_id;
}

/** unlocalized -> VEHICLE_UNCATALOGUED_HINT. Localised -> the raw asset id. */
export function vehicleTitle(row: { vehicle_asset_id: string; unlocalized: boolean }): string {
  if (row.unlocalized) return VEHICLE_UNCATALOGUED_HINT;
  return row.vehicle_asset_id;
}

/** `Показано ${shown} из ${total}`. */
export function weaponsCountLabel(shown: number, total: number): string {
  return `Показано ${shown} из ${total}`;
}

/**
 * `?serverId=all&weaponsLimit=20` plus `&from=YYYY-MM-DD` when monthsBack is a number.
 *
 * The `from` bound is the first day of the earliest month the window covers, so
 * the route's `kd_trend` returns exactly the months {@link fillTrendMonths}
 * renders for the same `monthsBack`.
 */
export function buildDossierQuery(args: {
  serverId: string;
  monthsBack: number | null;
  now: Date;
  weaponsLimit?: number;
}): string {
  const params = new URLSearchParams();
  params.set('serverId', args.serverId);
  params.set('weaponsLimit', String(args.weaponsLimit ?? DOSSIER_WEAPONS_LIMIT));
  if (args.monthsBack !== null) {
    const end = toAbsMonth(args.now.getUTCFullYear(), args.now.getUTCMonth() + 1);
    params.set('from', fromAbsMonth(end - (args.monthsBack - 1)));
  }
  return `?${params.toString()}`;
}
