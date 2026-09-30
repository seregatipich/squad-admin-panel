import { isArrayOf, isFiniteNumber, isNullableString, isRecord } from '@/lib/json-guards';
import type { MatchDetail, MatchListItem, MatchListResponse, ServerOption } from './helpers';

/** Shown when an API body does not have the shape the page renders from. */
export const MALFORMED_RESPONSE_MESSAGE = 'Сервер вернул некорректный ответ.';

function malformed(): never {
  throw new Error(MALFORMED_RESPONSE_MESSAGE);
}

function isMatchListItem(value: unknown): value is MatchListItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.server_id === 'string' &&
    typeof value.started_at === 'string' &&
    isNullableString(value.ended_at)
  );
}

function isTeamAggregate(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.players) && isFiniteNumber(value.play_seconds);
}

function isRosterEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.player_id === 'string' &&
    typeof value.nickname === 'string' &&
    isFiniteNumber(value.play_seconds)
  );
}

function isTimelineEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.id) &&
    typeof value.event_type === 'string' &&
    typeof value.occurred_at === 'string'
  );
}

/**
 * Validates a `GET /api/v1/matches` page before the list renders from it.
 *
 * @param body Decoded JSON body.
 * @returns The body, typed.
 * @throws Error with {@link MALFORMED_RESPONSE_MESSAGE} when the shape is wrong.
 */
export function parseMatchListResponse(body: unknown): MatchListResponse {
  if (
    !isRecord(body) ||
    !isArrayOf(body.items, isMatchListItem) ||
    !isNullableString(body.next_cursor)
  ) {
    return malformed();
  }
  return body as unknown as MatchListResponse;
}

/**
 * Validates `GET /api/v1/matches/:id`: the roster, both team aggregates and
 * the combat timeline are read without further checks by the card.
 *
 * @param body Decoded JSON body.
 * @returns The body, typed.
 * @throws Error with {@link MALFORMED_RESPONSE_MESSAGE} when the shape is wrong.
 */
export function parseMatchDetail(body: unknown): MatchDetail {
  if (
    !isMatchListItem(body) ||
    !isRecord(body) ||
    !isArrayOf(body.roster, isRosterEntry as (item: unknown) => item is unknown) ||
    !isRecord(body.teams) ||
    !isTeamAggregate(body.teams.team1) ||
    !isTeamAggregate(body.teams.team2) ||
    (body.combat_events !== null &&
      !isArrayOf(body.combat_events, isTimelineEvent as (item: unknown) => item is unknown))
  ) {
    return malformed();
  }
  return body as unknown as MatchDetail;
}

/**
 * Validates `GET /api/v1/matches/count`.
 *
 * @param body Decoded JSON body.
 * @returns The total number of matches.
 * @throws Error with {@link MALFORMED_RESPONSE_MESSAGE} when `total` is not a number.
 */
export function parseMatchCount(body: unknown): number {
  if (!isRecord(body) || !isFiniteNumber(body.total)) return malformed();
  return body.total;
}

/**
 * Validates `GET /api/v1/servers` and keeps the fields the server filter shows.
 *
 * @param body Decoded JSON body.
 * @returns Server options for the filter.
 * @throws Error with {@link MALFORMED_RESPONSE_MESSAGE} when the shape is wrong.
 */
export function parseServerOptions(body: unknown): ServerOption[] {
  if (!isRecord(body) || !Array.isArray(body.items)) return malformed();
  return body.items.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return malformed();
    return {
      id: entry.id,
      display_name: typeof entry.display_name === 'string' ? entry.display_name : null,
      slug: typeof entry.slug === 'string' ? entry.slug : null,
    };
  });
}
