import type { ParsedBan, ParseResult } from './index.js';
import { type FieldPaths, resolveListPath, resolvePath } from './json-generic.js';

export interface BattlemetricsConfig {
  list_path?: string;
  fields?: FieldPaths;
}

// Defaults for the BattleMetrics ban-export shape: an array of
// `{ attributes: { identifiers, reason, note, timestamp, expires } }`
// records. `steam_id64`/`eos_id` are looked up by scanning the
// `identifiers` array for the matching `type`, since BattleMetrics nests
// them there rather than exposing flat fields — the dot-path config can
// still override every field, including `steam_id64`/`eos_id`, to point at
// a flat field on a customized export.
const DEFAULT_LIST_PATH = 'data';
const DEFAULT_FIELDS: FieldPaths = {
  nickname: 'attributes.identifiers.name',
  reason: 'attributes.reason',
  admin_name: 'attributes.note',
  issued_at: 'attributes.timestamp',
  expires_at: 'attributes.expires',
};

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  return null;
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return new Date(value * 1000);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function findIdentifier(record: unknown, type: string): string | null {
  const identifiers = (record as { attributes?: { identifiers?: unknown } })?.attributes
    ?.identifiers;
  if (!Array.isArray(identifiers)) return null;
  for (const identifier of identifiers) {
    if (
      identifier &&
      typeof identifier === 'object' &&
      (identifier as Record<string, unknown>).type === type
    ) {
      const value = (identifier as Record<string, unknown>).identifier;
      if (typeof value === 'string') return value;
    }
  }
  return null;
}

function extractOne(record: unknown, fields: FieldPaths): ParsedBan | null {
  const steamId64 = fields.steam_id64
    ? asString(resolvePath(record, fields.steam_id64))
    : findIdentifier(record, 'steamID');
  const eosId = fields.eos_id
    ? asString(resolvePath(record, fields.eos_id))
    : findIdentifier(record, 'eosID');
  if (!steamId64 && !eosId) return null;

  return {
    steamId64,
    eosId,
    nickname: asString(resolvePath(record, fields.nickname ?? DEFAULT_FIELDS.nickname ?? '')),
    reason: asString(resolvePath(record, fields.reason ?? DEFAULT_FIELDS.reason ?? '')),
    adminName: asString(resolvePath(record, fields.admin_name ?? DEFAULT_FIELDS.admin_name ?? '')),
    issuedAt: asDate(resolvePath(record, fields.issued_at ?? DEFAULT_FIELDS.issued_at ?? '')),
    expiresAt: asDate(resolvePath(record, fields.expires_at ?? DEFAULT_FIELDS.expires_at ?? '')),
    raw: record,
  };
}

/**
 * Parses a BattleMetrics ban-export JSON payload with sensible defaults for
 * its `data[].attributes` shape (null `expires` = permanent ban), all
 * overridable via the same `parserConfig.fields` dot-path mapping used by
 * `json_generic`.
 */
export function parseBattlemetrics(
  text: string,
  parserConfig: Record<string, unknown> = {},
): ParseResult {
  const config = parserConfig as BattlemetricsConfig;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new Error(`battlemetrics_json: invalid JSON (${(err as Error).message})`);
  }

  const list = resolveListPath(root, config.list_path ?? DEFAULT_LIST_PATH);
  const fields = config.fields ?? {};
  const records: ParsedBan[] = [];
  let skipped = 0;
  for (const entry of list) {
    const parsed = extractOne(entry, fields);
    if (parsed) {
      records.push(parsed);
    } else {
      skipped++;
    }
  }
  return { records, skipped };
}
