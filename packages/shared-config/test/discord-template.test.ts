import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISCORD_TEMPLATES,
  DISCORD_EMBED_LIMITS,
  DISCORD_EMPTY_FIELD_VALUE,
  DISCORD_TEMPLATE_EVENT_TYPES,
  type DiscordEmbedTemplate,
  defaultDiscordTemplate,
  escapeDiscordMarkdown,
  isDiscordEmbedTemplate,
  renderDiscordTemplate,
} from '../src/discord-template.js';

function embedLength(embed: DiscordEmbedTemplate): number {
  return (
    embed.title.length +
    embed.description.length +
    embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

const banTemplate: DiscordEmbedTemplate = {
  title: 'Player banned',
  url: '{player_url}',
  description: '{player_name} was banned on `{server_name}`.',
  color: 0xed4245,
  fields: [
    { name: 'Player', value: '{player_name}', inline: true },
    { name: 'Reason', value: '{reason}', inline: false },
    { name: 'Duration', value: '{duration}', inline: true },
  ],
};

const context = {
  player_name: 'JohnDoe',
  player_url: 'https://panel.example/players/018f-uuid',
  server_name: 'Main #1',
  reason: 'cheating',
  duration: 'permanent',
  steam_id64: '76561198000000000',
};

describe('escapeDiscordMarkdown', () => {
  it('escapes formatting and mention control characters', () => {
    expect(escapeDiscordMarkdown('**@everyone** _ping_ `code`')).toBe(
      '\\*\\*\\@everyone\\*\\* \\_ping\\_ \\`code\\`',
    );
  });

  it('leaves plain text untouched', () => {
    expect(escapeDiscordMarkdown('JohnDoe 123')).toBe('JohnDoe 123');
  });
});

describe('renderDiscordTemplate', () => {
  it('substitutes placeholders and escapes markdown in text fields', () => {
    const rendered = renderDiscordTemplate(banTemplate, context);
    expect(rendered.title).toBe('Player banned');
    expect(rendered.description).toBe('JohnDoe was banned on `Main \\#1`.');
    expect(rendered.fields[0]?.value).toBe('JohnDoe');
    expect(rendered.color).toBe(0xed4245);
  });

  it('substitutes the url field without markdown escaping', () => {
    const rendered = renderDiscordTemplate(banTemplate, context);
    expect(rendered.url).toBe('https://panel.example/players/018f-uuid');
  });

  it('renders a null url as null without substitution', () => {
    const rendered = renderDiscordTemplate({ ...banTemplate, url: null }, context);
    expect(rendered.url).toBeNull();
  });

  it('renders an empty-string url as null', () => {
    const rendered = renderDiscordTemplate({ ...banTemplate, url: '' }, context);
    expect(rendered.url).toBeNull();
  });

  it('neutralizes player-controlled markdown injection', () => {
    const rendered = renderDiscordTemplate(banTemplate, {
      ...context,
      player_name: '**@everyone** get pinged',
    });
    expect(rendered.description).toBe(
      '\\*\\*\\@everyone\\*\\* get pinged was banned on `Main \\#1`.',
    );
  });

  it('renders a missing placeholder as empty and reports it exactly once per token', () => {
    const onMissingPlaceholder = vi.fn();
    const rendered = renderDiscordTemplate(
      banTemplate,
      { player_name: 'Solo' },
      { onMissingPlaceholder },
    );
    expect(rendered.description).toBe('Solo was banned on ``.');
    expect(rendered.fields[1]?.value).toBe(DISCORD_EMPTY_FIELD_VALUE);
    expect(rendered.url).toBeNull();
    const reported = onMissingPlaceholder.mock.calls.map((c) => c[0]);
    expect(reported).toContain('server_name');
    expect(reported).toContain('reason');
    expect(reported).toContain('player_url');
    expect(reported).not.toContain('player_name');
  });

  it('never throws when the whole context is empty', () => {
    expect(() => renderDiscordTemplate(banTemplate, {})).not.toThrow();
    const rendered = renderDiscordTemplate(banTemplate, {});
    expect(rendered.title).toBe('Player banned');
    expect(rendered.url).toBeNull();
  });

  it('treats prototype property names as missing placeholders instead of throwing (#52 finding 1160)', () => {
    const onMissingPlaceholder = vi.fn();
    const template: DiscordEmbedTemplate = {
      title: 'x {constructor} {__proto__}',
      url: '{toString}',
      description: '{valueOf}{hasOwnProperty}',
      color: 0,
      fields: [{ name: '{isPrototypeOf}', value: '{propertyIsEnumerable}', inline: false }],
    };
    const rendered = renderDiscordTemplate(template, {}, { onMissingPlaceholder });
    expect(rendered.title).toBe('x  ');
    expect(rendered.url).toBeNull();
    expect(rendered.description).toBe('');
    expect(rendered.fields).toEqual([
      { name: DISCORD_EMPTY_FIELD_VALUE, value: DISCORD_EMPTY_FIELD_VALUE, inline: false },
    ]);
    expect(onMissingPlaceholder).toHaveBeenCalledWith('constructor');
    expect(onMissingPlaceholder).toHaveBeenCalledWith('toString');
  });

  it('fills a field left blank by a missing value so Discord accepts the embed (#52 finding 1161)', () => {
    // An EOS-only player has no steam_id64: the default "Steam ID" field would
    // otherwise be sent with an empty value and rejected with HTTP 400.
    const rendered = renderDiscordTemplate(
      {
        title: 'Player banned',
        url: null,
        description: '',
        color: 0,
        fields: [
          { name: 'Steam ID', value: '{steam_id64}', inline: true },
          { name: '{missing}', value: '   ', inline: true },
        ],
      },
      { player_name: 'Solo' },
    );
    expect(rendered.fields).toEqual([
      { name: 'Steam ID', value: DISCORD_EMPTY_FIELD_VALUE, inline: true },
      { name: DISCORD_EMPTY_FIELD_VALUE, value: DISCORD_EMPTY_FIELD_VALUE, inline: true },
    ]);
  });

  it('truncates every text part to Discord limits after escaping (#52 finding 1161)', () => {
    // Every '*' doubles to '\\*' when escaped, so a template that passed the API
    // length checks can still overflow once the value is substituted.
    const long = '*'.repeat(5000);
    const rendered = renderDiscordTemplate(
      {
        title: '{reason}',
        url: null,
        description: '{reason}',
        color: 0,
        fields: [{ name: '{reason}', value: '{reason}', inline: false }],
      },
      { reason: long },
    );
    expect(rendered.title).toHaveLength(DISCORD_EMBED_LIMITS.title);
    expect(rendered.title.endsWith('…')).toBe(true);
    expect(rendered.fields[0]?.name).toHaveLength(DISCORD_EMBED_LIMITS.fieldName);
    expect(rendered.fields[0]?.value).toHaveLength(DISCORD_EMBED_LIMITS.fieldValue);
    expect(rendered.description.length).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.description);
    expect(embedLength(rendered)).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.total);
  });

  it('keeps the whole embed within the 6000-character total (#52 finding 1161)', () => {
    const rendered = renderDiscordTemplate(
      {
        title: '{reason}',
        url: null,
        description: '{reason}',
        color: 0,
        fields: Array.from({ length: 25 }, (_, i) => ({
          name: `Field ${i} {reason}`,
          value: '{reason}',
          inline: false,
        })),
      },
      { reason: 'x'.repeat(2000) },
    );
    expect(embedLength(rendered)).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.total);
    expect(rendered.title).toHaveLength(DISCORD_EMBED_LIMITS.title);
    expect(rendered.fields.length).toBeGreaterThan(0);
    for (const field of rendered.fields) {
      expect(field.name.length).toBeGreaterThan(0);
      expect(field.value.length).toBeGreaterThan(0);
    }
  });

  it('matches the delivered-embed snapshot', () => {
    expect(renderDiscordTemplate(banTemplate, context)).toMatchInlineSnapshot(`
      {
        "color": 15548997,
        "description": "JohnDoe was banned on \`Main \\#1\`.",
        "fields": [
          {
            "inline": true,
            "name": "Player",
            "value": "JohnDoe",
          },
          {
            "inline": false,
            "name": "Reason",
            "value": "cheating",
          },
          {
            "inline": true,
            "name": "Duration",
            "value": "permanent",
          },
        ],
        "title": "Player banned",
        "url": "https://panel.example/players/018f-uuid",
      }
    `);
  });
});

describe('DEFAULT_DISCORD_TEMPLATES', () => {
  it('covers every Discord event type exactly once', () => {
    const eventTypes = DEFAULT_DISCORD_TEMPLATES.map((t) => t.eventType).sort();
    const expected = [...DISCORD_TEMPLATE_EVENT_TYPES].sort();
    expect(eventTypes).toEqual(expected);
  });

  it('is resolvable by event type', () => {
    expect(defaultDiscordTemplate('ban_issued')?.template.title).toBe('Player banned');
    expect(defaultDiscordTemplate('not_real')).toBeUndefined();
  });
});

describe('isDiscordEmbedTemplate (#1126)', () => {
  it('accepts every built-in default template', () => {
    for (const { template } of Object.values(DEFAULT_DISCORD_TEMPLATES)) {
      expect(isDiscordEmbedTemplate(template)).toBe(true);
    }
  });

  it('accepts a template whose url is absent or null', () => {
    const { url: _url, ...withoutUrl } = banTemplate;
    expect(isDiscordEmbedTemplate(withoutUrl)).toBe(true);
    expect(isDiscordEmbedTemplate({ ...banTemplate, url: null })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an empty object', {}],
    ['a non-string title', { ...banTemplate, title: 1 }],
    ['a non-string description', { ...banTemplate, description: null }],
    ['a non-numeric color', { ...banTemplate, color: '#fff' }],
    ['fields that are not an array', { ...banTemplate, fields: 'x' }],
    ['a malformed field', { ...banTemplate, fields: [{ name: 'a', value: 1, inline: true }] }],
    ['a non-string url', { ...banTemplate, url: 5 }],
    ['a null field', { ...banTemplate, fields: [null] }],
    ['a non-object field', { ...banTemplate, fields: ['name'] }],
  ])('rejects %s', (_label, value) => {
    expect(isDiscordEmbedTemplate(value)).toBe(false);
  });
});
