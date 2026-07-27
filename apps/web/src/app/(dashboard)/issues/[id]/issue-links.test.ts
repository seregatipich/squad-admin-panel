import { describe, expect, it } from 'vitest';

import {
  canRemoveLink,
  entityTypeLabel,
  type IssueLinkView,
  linkErrorMessage,
  sortLinks,
} from './issue-links';

function link(overrides: Partial<IssueLinkView> = {}): IssueLinkView {
  return {
    id: 'link-1',
    issue_id: 'issue-1',
    entity_type: 'player',
    entity_id: 'player-1',
    label: 'Vasya',
    ref: '/players/player-1',
    exists: true,
    created_by: 'author-1',
    created_at: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('entityTypeLabel', () => {
  it('translates every known entity type into Russian', () => {
    expect(entityTypeLabel('player')).toBe('Игрок');
    expect(entityTypeLabel('server')).toBe('Сервер');
    expect(entityTypeLabel('moderation_action')).toBe('Действие модерации');
    expect(entityTypeLabel('media_file')).toBe('Медиафайл');
  });

  it('falls back to the raw type for anything unknown', () => {
    expect(entityTypeLabel('clan')).toBe('clan');
  });
});

describe('canRemoveLink', () => {
  it('is false without a signed-in viewer', () => {
    expect(canRemoveLink(link(), null)).toBe(false);
  });

  it('is true for the link author', () => {
    expect(canRemoveLink(link(), { player_id: 'author-1', can_manage_issues: false })).toBe(true);
  });

  it('is false for a stranger without can_manage_issues', () => {
    expect(canRemoveLink(link(), { player_id: 'someone-else', can_manage_issues: false })).toBe(
      false,
    );
  });

  it('is true for a manager on someone else’s link', () => {
    expect(canRemoveLink(link(), { player_id: 'someone-else', can_manage_issues: true })).toBe(
      true,
    );
  });

  it('is false for a stranger when the link has no author', () => {
    expect(
      canRemoveLink(link({ created_by: null }), {
        player_id: 'someone-else',
        can_manage_issues: false,
      }),
    ).toBe(false);
  });
});

describe('linkErrorMessage', () => {
  it('explains a duplicate link', () => {
    expect(linkErrorMessage(409, 'link_exists')).toBe('Такая связь уже существует.');
  });

  it('explains an unknown entity', () => {
    expect(linkErrorMessage(422, 'unknown_entity')).toBe('Объект не найден.');
  });

  it('explains a permission failure', () => {
    expect(linkErrorMessage(403, 'forbidden')).toBe('Недостаточно прав: нужно can_manage_issues.');
  });

  it('explains a missing issue or link', () => {
    expect(linkErrorMessage(404, 'link_not_found')).toBe('Тикет или связь не найдены.');
  });

  it('falls back to the raw error code', () => {
    expect(linkErrorMessage(500, 'boom')).toBe('Не удалось выполнить действие: boom');
  });

  it('falls back to the status when the body carries no error code', () => {
    expect(linkErrorMessage(500, undefined)).toBe('Не удалось выполнить действие: 500');
  });
});

describe('sortLinks', () => {
  it('groups links by entity type in a stable order and sorts by label inside a group', () => {
    const sorted = sortLinks([
      link({ id: 'm', entity_type: 'media_file', label: 'clip' }),
      link({ id: 's2', entity_type: 'server', label: 'Bravo' }),
      link({ id: 'p', entity_type: 'player', label: 'Vasya' }),
      link({ id: 's1', entity_type: 'server', label: 'Alpha' }),
      link({ id: 'a', entity_type: 'moderation_action', label: 'ban · 2026-03-04' }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['p', 's1', 's2', 'a', 'm']);
  });

  it('does not mutate the input array', () => {
    const input = [
      link({ id: 'b', entity_type: 'server', label: 'B' }),
      link({ id: 'a', entity_type: 'player', label: 'A' }),
    ];
    sortLinks(input);
    expect(input.map((item) => item.id)).toEqual(['b', 'a']);
  });
});
