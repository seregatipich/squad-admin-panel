import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISCORD_TEMPLATES,
  DISCORD_TEMPLATE_EVENT_TYPES,
  type DiscordEmbedTemplate,
  defaultDiscordTemplate,
  escapeDiscordMarkdown,
  renderDiscordTemplate,
} from '../src/discord-template.js';

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
    expect(rendered.fields[1]?.value).toBe('');
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
