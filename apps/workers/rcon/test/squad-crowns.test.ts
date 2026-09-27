import type { SquadLeaderChangeReason, SquadPlayerRef } from '@squad/shared-types';
import { describe, expect, it } from 'vitest';
import {
  applySquadEvent,
  type CrownBook,
  crownBookFromHash,
  crownOf,
} from '../src/squad-crowns.js';
import type { SquadEvent } from '../src/squad-tracker.js';

const ANNA: SquadPlayerRef = {
  eos_id: 'a'.repeat(32),
  steam_id64: '76561198000000001',
  name: 'Anna',
};
const IVAN: SquadPlayerRef = { eos_id: 'b'.repeat(32), steam_id64: null, name: 'Ivan' };
const BASE = {
  team_id: 1,
  team_name: 'United States Army',
  squad_id: 1,
  squad_name: 'Alpha',
  creator: ANNA,
};
const AT_0404 = '2026-09-27T21:04:00.000Z';
const AT_0410 = '2026-09-27T21:10:00.000Z';
const AT_0412 = '2026-09-27T21:12:00.000Z';
const AT_0415 = '2026-09-27T21:15:00.000Z';

const created = (at: string): SquadEvent => ({ type: 'squad.created', at, payload: BASE });
const changed = (
  from: SquadPlayerRef,
  to: SquadPlayerRef,
  reason: SquadLeaderChangeReason,
  at: string,
): SquadEvent => ({ type: 'squad.leader_changed', at, payload: { ...BASE, from, to, reason } });
const disbanded = (lastLeader: SquadPlayerRef | null, at: string): SquadEvent => ({
  type: 'squad.disbanded',
  at,
  payload: {
    ...BASE,
    last_leader: lastLeader,
    creator_was_leader: lastLeader?.eos_id === ANNA.eos_id,
  },
});

function fold(events: SquadEvent[]): CrownBook {
  const book: CrownBook = new Map();
  for (const event of events) applySquadEvent(book, event);
  return book;
}

function annasCrown(book: CrownBook) {
  const history = book.get(ANNA.eos_id);
  return history ? crownOf(history) : null;
}

describe('crown rule', () => {
  it('gives no crown to a creator who never gave up command', () => {
    const book = fold([created(AT_0404)]);
    expect(annasCrown(book)).toBeNull();
    expect(book.get(ANNA.eos_id)?.squads).toHaveLength(1);
  });

  it('turns grey after handing command to a squadmate', () => {
    expect(annasCrown(fold([created(AT_0404), changed(ANNA, IVAN, 'passed', AT_0410)]))).toEqual({
      color: 'grey',
      squads: [
        {
          squad_name: 'Alpha',
          team_id: 1,
          squad_id: 1,
          created_at: AT_0404,
          handoffs: [{ to_name: 'Ivan', reason: 'passed', at: AT_0410 }],
          disbanded_at: null,
          abandoned_at: null,
        },
      ],
    });
  });

  it.each(['left_squad', 'disconnected'] as const)(
    'turns red when the creator gives up command by %s',
    (reason) => {
      const crown = annasCrown(fold([created(AT_0404), changed(ANNA, IVAN, reason, AT_0412)]));
      expect(crown?.color).toBe('red');
      expect(crown?.squads[0]?.abandoned_at).toBe(AT_0412);
    },
  );

  it('turns red when the squad disbands under its creator', () => {
    const crown = annasCrown(fold([created(AT_0404), disbanded(ANNA, AT_0412)]));
    expect(crown).toMatchObject({
      color: 'red',
      squads: [{ disbanded_at: AT_0412, abandoned_at: AT_0412 }],
    });
  });

  it('keeps grey when the squad disbands under someone else, and dates the disband', () => {
    const crown = annasCrown(
      fold([created(AT_0404), changed(ANNA, IVAN, 'passed', AT_0410), disbanded(IVAN, AT_0412)]),
    );
    expect(crown).toMatchObject({
      color: 'grey',
      squads: [{ disbanded_at: AT_0412, abandoned_at: null }],
    });
  });

  it('lets red override grey', () => {
    const crown = annasCrown(
      fold([
        created(AT_0404),
        changed(ANNA, IVAN, 'passed', AT_0410),
        changed(IVAN, ANNA, 'passed', AT_0412),
        disbanded(ANNA, AT_0415),
      ]),
    );
    expect(crown?.color).toBe('red');
  });

  it('keeps grey when the creator gets command back', () => {
    const book = fold([created(AT_0404), changed(ANNA, IVAN, 'passed', AT_0410)]);
    expect(applySquadEvent(book, changed(IVAN, ANNA, 'passed', AT_0412))).toBeNull();
    expect(annasCrown(book)?.color).toBe('grey');
  });

  it('ignores a change of command that does not start at the creator', () => {
    const book: CrownBook = new Map();
    expect(applySquadEvent(book, changed(IVAN, ANNA, 'passed', AT_0410))).toBeNull();
    expect(book.size).toBe(0);
  });

  it('tells the caller which creator changed', () => {
    expect(applySquadEvent(new Map(), created(AT_0404))).toBe(ANNA.eos_id);
  });

  it('opens a record without a creation time for a squad created before tracking started', () => {
    const crown = annasCrown(fold([changed(ANNA, IVAN, 'passed', AT_0410)]));
    expect(crown?.squads[0]).toMatchObject({ squad_name: 'Alpha', created_at: null });
  });

  it('restores the book from the Redis hash and skips unreadable fields', () => {
    const stored = annasCrown(fold([created(AT_0404), changed(ANNA, IVAN, 'passed', AT_0410)]));
    const book = crownBookFromHash({
      [ANNA.eos_id]: JSON.stringify(stored),
      broken: '{',
      wrong: JSON.stringify({ color: 'gold', squads: [] }),
    });
    expect([...book.keys()]).toEqual([ANNA.eos_id]);
    expect(annasCrown(book)).toEqual(stored);
  });
});
