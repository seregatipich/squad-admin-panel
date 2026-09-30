/**
 * Editable Discord embed templates (DISCORD-3).
 *
 * Operators edit one template per Discord event type. The worker renders the
 * template for each delivered event and the panel UI renders the exact same
 * function for its live preview, so preview always matches the delivered embed.
 *
 * Placeholders use `{token}` syntax. Values substituted into markdown text
 * fields (title/description/field name+value) are Discord-markdown-escaped so
 * player-controlled data (names, reasons) cannot inject formatting or mentions.
 * The `url` field is treated as a structured URL, not markdown, so it is
 * substituted without escaping. An unknown/missing placeholder renders as an
 * empty string and invokes {@link RenderOptions.onMissingPlaceholder} (used for
 * a warn log) — a missing value never throws, so delivery is never dropped.
 * Only the context's own string properties are values: `{constructor}` or
 * `{__proto__}` are missing placeholders, never inherited object members.
 *
 * The rendered embed always satisfies Discord's embed limits
 * ({@link DISCORD_EMBED_LIMITS}, https://discord.com/developers/docs/resources/message#embed-object-embed-limits):
 * a field left blank by a missing value shows {@link DISCORD_EMPTY_FIELD_VALUE},
 * and text grown past a limit by substitution and escaping is truncated, so a
 * valid template never turns into an HTTP 400 at delivery time.
 */

/** The Discord event types that own an editable template. */
export const DISCORD_TEMPLATE_EVENT_TYPES = [
  'server_crashed',
  'ban_issued',
  'unban',
  'kick',
  'warn',
  'admin_login',
  'player_report',
  'match_ended',
  'map_changed',
  'marked_player_joined',
  'drift_detected',
  'server_monitoring',
  'seed_needed',
] as const;

export type DiscordTemplateEventType = (typeof DISCORD_TEMPLATE_EVENT_TYPES)[number];

/** Supported template locales. */
export const DISCORD_TEMPLATE_LOCALES = ['en', 'ru'] as const;
export type DiscordTemplateLocale = (typeof DISCORD_TEMPLATE_LOCALES)[number];

/** The placeholder tokens operators may reference in a template. */
export const DISCORD_TEMPLATE_PLACEHOLDERS = [
  'player_name',
  'player_id',
  'player_url',
  'steam_id64',
  'eos_id',
  'server_name',
  'reason',
  'duration',
  'actor_name',
  'map',
  'join_link',
] as const;

export type DiscordTemplatePlaceholder = (typeof DISCORD_TEMPLATE_PLACEHOLDERS)[number];

/** A single embed field. `name`/`value` may contain placeholders. */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

/**
 * The editable shape stored in `discord_message_templates.template` (jsonb).
 * Mirrors the subset of the Discord embed object operators can control.
 */
export interface DiscordEmbedTemplate {
  title: string;
  /** Optional link target for the embed title (rendered as a hyperlink). */
  url?: string | null;
  description: string;
  /** Decimal RGB color for the embed sidebar. */
  color: number;
  fields: DiscordEmbedField[];
}

/** Values substituted for placeholders. Missing keys render empty. */
export type DiscordTemplateContext = Partial<Record<string, string>>;

export interface RenderOptions {
  /** Invoked once per referenced placeholder that has no context value. */
  onMissingPlaceholder?: (placeholder: string) => void;
}

/** Discord's embed length limits, in characters. */
export const DISCORD_EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  /** Sum of title, description and every field name and value. */
  total: 6000,
} as const;

/** Shown in place of a field name or value that renders blank; Discord rejects empty ones. */
export const DISCORD_EMPTY_FIELD_VALUE = '—';

const TRUNCATION_MARK = '…';

const PLACEHOLDER_PATTERN = /\{([a-z0-9_]+)\}/gi;
const MARKDOWN_ESCAPE_PATTERN = /[\\*_~`|>[\]()@#-]/g;

/**
 * Backslash-escape the characters Discord treats as markdown or mention
 * control so substituted values render as literal text.
 */
export function escapeDiscordMarkdown(value: string): string {
  return value.replace(MARKDOWN_ESCAPE_PATTERN, (char) => `\\${char}`);
}

function substitute(
  input: string,
  context: DiscordTemplateContext,
  escapeMarkdown: boolean,
  onMissing?: (placeholder: string) => void,
): string {
  return input.replace(PLACEHOLDER_PATTERN, (_match, token: string) => {
    const raw = Object.hasOwn(context, token) ? context[token] : undefined;
    if (typeof raw !== 'string') {
      onMissing?.(token);
      return '';
    }
    return escapeMarkdown ? escapeDiscordMarkdown(raw) : raw;
  });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 0) return '';
  return `${value.slice(0, max - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
}

function fieldText(value: string, max: number): string {
  return value.trim() === '' ? DISCORD_EMPTY_FIELD_VALUE : truncate(value, max);
}

/**
 * Brings a rendered embed within {@link DISCORD_EMBED_LIMITS.total}: the
 * description is shortened first, then trailing fields are dropped, so the
 * title and the leading fields (the template's most important data) survive.
 */
function fitTotalLength(embed: DiscordEmbedTemplate): void {
  const fieldsLength = () =>
    embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  const overflow =
    embed.title.length + embed.description.length + fieldsLength() - DISCORD_EMBED_LIMITS.total;
  if (overflow <= 0) return;
  embed.description = truncate(embed.description, embed.description.length - overflow);
  while (
    embed.fields.length > 0 &&
    embed.title.length + embed.description.length + fieldsLength() > DISCORD_EMBED_LIMITS.total
  ) {
    embed.fields.pop();
  }
}

/**
 * Render an editable template into a concrete Discord embed by substituting
 * placeholders from `context`. Text fields are markdown-escaped; the `url`
 * field is substituted verbatim. Never throws on a missing placeholder, and
 * the result always fits Discord's embed limits (see the module description).
 *
 * @param template The stored or default template.
 * @param context Placeholder values; only own string properties are used.
 * @param options Optional missing-placeholder callback.
 * @returns The embed to deliver or preview.
 */
export function renderDiscordTemplate(
  template: DiscordEmbedTemplate,
  context: DiscordTemplateContext,
  options: RenderOptions = {},
): DiscordEmbedTemplate {
  const onMissing = options.onMissingPlaceholder;
  const rendered: DiscordEmbedTemplate = {
    title: truncate(
      substitute(template.title, context, true, onMissing),
      DISCORD_EMBED_LIMITS.title,
    ),
    description: truncate(
      substitute(template.description, context, true, onMissing),
      DISCORD_EMBED_LIMITS.description,
    ),
    color: template.color,
    fields: template.fields.map((field) => ({
      name: fieldText(
        substitute(field.name, context, true, onMissing),
        DISCORD_EMBED_LIMITS.fieldName,
      ),
      value: fieldText(
        substitute(field.value, context, true, onMissing),
        DISCORD_EMBED_LIMITS.fieldValue,
      ),
      inline: field.inline,
    })),
  };
  fitTotalLength(rendered);
  if (template.url != null && template.url !== '') {
    const url = substitute(template.url, context, false, onMissing);
    rendered.url = url === '' ? null : url;
  } else {
    rendered.url = null;
  }
  return rendered;
}

interface DefaultTemplate {
  eventType: DiscordTemplateEventType;
  locale: DiscordTemplateLocale;
  template: DiscordEmbedTemplate;
}

const COLOR_RED = 0xed4245;
const COLOR_ORANGE = 0xfaa61a;
const COLOR_GREEN = 0x57f287;
const COLOR_BLURPLE = 0x5865f2;
const COLOR_GREY = 0x99aab5;

// The clickable player-card link is carried by the embed's top-level `url`
// field (substituted without markdown escaping), so field values stay plain
// text and player-controlled names are always escaped.
const PLAYER_FIELDS: DiscordEmbedField[] = [
  { name: 'Player', value: '{player_name}', inline: true },
  { name: 'Steam ID', value: '{steam_id64}', inline: true },
];

/**
 * The default template for every event type. Single source of truth shared by
 * the seed migration (`0037_discord_message_templates.sql`) and the API
 * "reset to default" endpoint. The migration seed is asserted against this
 * constant in an integration test so the two can never drift.
 */
export const DEFAULT_DISCORD_TEMPLATES: readonly DefaultTemplate[] = [
  {
    eventType: 'server_crashed',
    locale: 'en',
    template: {
      title: 'Server crashed',
      url: null,
      description: '`{server_name}` has crashed and is restarting.',
      color: COLOR_RED,
      fields: [{ name: 'Server', value: '{server_name}', inline: true }],
    },
  },
  {
    eventType: 'ban_issued',
    locale: 'en',
    template: {
      title: 'Player banned',
      url: '{player_url}',
      description: '{player_name} was banned on `{server_name}`.',
      color: COLOR_RED,
      fields: [
        ...PLAYER_FIELDS,
        { name: 'Reason', value: '{reason}', inline: false },
        { name: 'Duration', value: '{duration}', inline: true },
        { name: 'Admin', value: '{actor_name}', inline: true },
      ],
    },
  },
  {
    eventType: 'unban',
    locale: 'en',
    template: {
      title: 'Player unbanned',
      url: '{player_url}',
      description: '{player_name} was unbanned on `{server_name}`.',
      color: COLOR_GREEN,
      fields: [...PLAYER_FIELDS, { name: 'Admin', value: '{actor_name}', inline: true }],
    },
  },
  {
    eventType: 'kick',
    locale: 'en',
    template: {
      title: 'Player kicked',
      url: '{player_url}',
      description: '{player_name} was kicked from `{server_name}`.',
      color: COLOR_ORANGE,
      fields: [
        ...PLAYER_FIELDS,
        { name: 'Reason', value: '{reason}', inline: false },
        { name: 'Admin', value: '{actor_name}', inline: true },
      ],
    },
  },
  {
    eventType: 'warn',
    locale: 'en',
    template: {
      title: 'Player warned',
      url: '{player_url}',
      description: '{player_name} was warned on `{server_name}`.',
      color: COLOR_ORANGE,
      fields: [
        ...PLAYER_FIELDS,
        { name: 'Reason', value: '{reason}', inline: false },
        { name: 'Admin', value: '{actor_name}', inline: true },
      ],
    },
  },
  {
    eventType: 'admin_login',
    locale: 'en',
    template: {
      title: 'Admin logged in',
      url: '{player_url}',
      description: '{actor_name} joined `{server_name}` as admin.',
      color: COLOR_BLURPLE,
      fields: [{ name: 'Admin', value: '{actor_name}', inline: true }],
    },
  },
  {
    eventType: 'player_report',
    locale: 'en',
    template: {
      title: 'Player reported',
      url: '{player_url}',
      description: '{player_name} was reported on `{server_name}`.',
      color: COLOR_ORANGE,
      fields: [
        ...PLAYER_FIELDS,
        { name: 'Reason', value: '{reason}', inline: false },
        { name: 'Reporter', value: '{actor_name}', inline: true },
      ],
    },
  },
  {
    eventType: 'match_ended',
    locale: 'en',
    template: {
      title: 'Match ended',
      url: null,
      description: 'A match ended on `{server_name}`.',
      color: COLOR_BLURPLE,
      fields: [{ name: 'Map', value: '{map}', inline: true }],
    },
  },
  {
    eventType: 'map_changed',
    locale: 'en',
    template: {
      title: 'Map changed',
      url: null,
      description: '`{server_name}` switched to {map}.',
      color: COLOR_BLURPLE,
      fields: [{ name: 'Map', value: '{map}', inline: true }],
    },
  },
  {
    eventType: 'marked_player_joined',
    locale: 'en',
    template: {
      title: 'Marked player joined',
      url: '{player_url}',
      description: '{player_name} joined `{server_name}`.',
      color: COLOR_ORANGE,
      fields: [...PLAYER_FIELDS, { name: 'Note', value: '{reason}', inline: false }],
    },
  },
  {
    eventType: 'drift_detected',
    locale: 'en',
    template: {
      title: 'Config drift detected',
      url: null,
      description: 'Configuration drift was detected on `{server_name}`.',
      color: COLOR_ORANGE,
      fields: [{ name: 'Server', value: '{server_name}', inline: true }],
    },
  },
  {
    eventType: 'server_monitoring',
    locale: 'en',
    template: {
      title: 'Server monitoring',
      url: null,
      description: 'Monitoring update for `{server_name}`.',
      color: COLOR_GREY,
      fields: [{ name: 'Server', value: '{server_name}', inline: true }],
    },
  },
  {
    eventType: 'seed_needed',
    locale: 'en',
    template: {
      title: 'Seeders needed',
      url: null,
      description: '`{server_name}` needs seeders. Join: {join_link}',
      color: COLOR_ORANGE,
      fields: [
        { name: 'Server', value: '{server_name}', inline: true },
        { name: 'Layer', value: '{map}', inline: true },
      ],
    },
  },
];

/** Look up the default template for an event type, or `undefined`. */
export function defaultDiscordTemplate(eventType: string): DefaultTemplate | undefined {
  return DEFAULT_DISCORD_TEMPLATES.find((entry) => entry.eventType === eventType);
}
