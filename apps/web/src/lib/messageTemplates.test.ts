import { describe, expect, it } from 'vitest';
import { type MessageTemplate, pickableTemplates, substituteTokens } from './messageTemplates';

function makeTemplate(overrides: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'Title',
    body: overrides.body ?? 'body',
    category: overrides.category ?? 'warn',
    locale: overrides.locale ?? 'en',
    sort_order: overrides.sort_order ?? 0,
    is_enabled: overrides.is_enabled ?? true,
    created_by: overrides.created_by ?? null,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('substituteTokens (acceptance #1)', () => {
  it('substitutes {player} with the nickname in the preview', () => {
    expect(substituteTokens('{player}, release the vehicle.', { player: 'BravoSix' })).toBe(
      'BravoSix, release the vehicle.',
    );
  });

  it('substitutes every occurrence of {player} and {server}', () => {
    const out = substituteTokens('{player} on {server}: {player}, welcome to {server}.', {
      player: 'Nick',
      server: 'Squad #1',
    });
    expect(out).toBe('Nick on Squad #1: Nick, welcome to Squad #1.');
  });

  it('leaves a token literal when no value is supplied', () => {
    expect(substituteTokens('{player} on {server}', { player: 'Nick' })).toBe('Nick on {server}');
  });
});

describe('pickableTemplates (acceptance #3)', () => {
  it('omits disabled templates from the picker', () => {
    const enabled = makeTemplate({ title: 'Enabled', is_enabled: true });
    const disabled = makeTemplate({ title: 'Disabled', is_enabled: false });
    const result = pickableTemplates([enabled, disabled]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('Enabled');
  });

  it('orders pickable templates by sort_order then title', () => {
    const third = makeTemplate({ title: 'C', sort_order: 20 });
    const first = makeTemplate({ title: 'A', sort_order: 10 });
    const second = makeTemplate({ title: 'B', sort_order: 10 });
    const result = pickableTemplates([third, second, first]);
    expect(result.map((t) => t.title)).toEqual(['A', 'B', 'C']);
  });
});
