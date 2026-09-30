import { describe, expect, it } from 'vitest';

import { moderationActionLabel, moderationActionTone } from './moderation-actions';

describe('moderationActionLabel', () => {
  it('translates the panel-issued action types', () => {
    expect(moderationActionLabel('warn')).toBe('Предупреждение');
    expect(moderationActionLabel('kick')).toBe('Кик');
    expect(moderationActionLabel('ban')).toBe('Бан');
    expect(moderationActionLabel('unban')).toBe('Разбан');
  });

  it('translates the worker-issued action types', () => {
    expect(moderationActionLabel('name_kick')).toBe('Кик за ник');
    expect(moderationActionLabel('external_ban_kick')).toBe('Кик по внешнему бану');
    expect(moderationActionLabel('external_ban.local_ban')).toBe('Локальный бан по внешнему');
    expect(moderationActionLabel('clan_tag_protection')).toBe('Защита клан-тега');
  });

  it('falls back to the raw action type for an unknown value', () => {
    expect(moderationActionLabel('teleport_abuse')).toBe('teleport_abuse');
  });
});

describe('moderationActionTone', () => {
  it('gives bans the critical tone and kicks the warning tone', () => {
    expect(moderationActionTone('ban')).toBe('crit');
    expect(moderationActionTone('external_ban.local_ban')).toBe('crit');
    expect(moderationActionTone('kick')).toBe('warn');
    expect(moderationActionTone('unban')).toBe('good');
    expect(moderationActionTone('clan_tag_protection')).toBe('accent');
  });

  it('falls back to the neutral tone for an unknown action type', () => {
    expect(moderationActionTone('teleport_abuse')).toBe('neutral');
  });
});
