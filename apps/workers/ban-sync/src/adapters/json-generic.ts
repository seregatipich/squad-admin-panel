import type { ParsedBan, ParseResult } from './index.js';

export interface FieldPaths {
  steam_id64?: string;
  eos_id?: string;
  nickname?: string;
  reason?: string;
  admin_name?: string;
  issued_at?: string;
  expires_at?: string;
}

export interface JsonGenericConfig {
  list_path?: string;
  fields?: FieldPaths;
}

const DEFAULT_FIELDS: Required<FieldPaths> = {
  steam_id64: 'steam_id64',
  eos_id: 'eos_id',
  nickname: 'nickname',
  reason: 'reason',
  admin_name: 'admin_name',
  issued_at: 'issued_at',
  expires_at: 'expires_at',
};

/** Resolves a dot-path (e.g. `attributes.identifiers.steamID`) against a record; returns undefined if any segment is missing. */
export function resolvePath(record: unknown, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = record;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Converts unix seconds to a Date; returns null when the value is outside the range a Date can represent. */
export function unixSecondsToDate(seconds: number): Date | null {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  return null;
}

export function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return unixSecondsToDate(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

const FIELD_PATH_KEYS: readonly (keyof FieldPaths)[] = [
  'steam_id64',
  'eos_id',
  'nickname',
  'reason',
  'admin_name',
  'issued_at',
  'expires_at',
];

/**
 * Validates the `{ list_path?, fields? }` shape of a source's `parser_config`
 * (stored as untyped jsonb) so a malformed value fails the sync with a clear
 * message instead of a `path.split is not a function` TypeError.
 *
 * @throws Error naming `format` and the offending key when a value has the wrong type.
 */
export function readPathConfig(
  format: string,
  parserConfig: Record<string, unknown>,
): JsonGenericConfig {
  const { list_path: listPath, fields } = parserConfig;
  if (listPath !== undefined && typeof listPath !== 'string') {
    throw new Error(`${format}: parser_config.list_path must be a string`);
  }
  if (fields === undefined) return { list_path: listPath };
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`${format}: parser_config.fields must be an object of dot-paths`);
  }
  const validated: FieldPaths = {};
  for (const key of FIELD_PATH_KEYS) {
    const path = (fields as Record<string, unknown>)[key];
    if (path === undefined) continue;
    if (typeof path !== 'string') {
      throw new Error(`${format}: parser_config.fields.${key} must be a string`);
    }
    validated[key] = path;
  }
  return { list_path: listPath, fields: validated };
}

/** Resolves `list_path` against the parsed JSON root; defaults to the root itself when the array is already top-level. */
export function resolveListPath(root: unknown, listPath?: string): unknown[] {
  const list = listPath ? resolvePath(root, listPath) : root;
  return Array.isArray(list) ? list : [];
}

export function recordToParsedBan(record: unknown, fields: FieldPaths): ParsedBan | null {
  const merged = { ...DEFAULT_FIELDS, ...fields };
  const steamId64 = asString(resolvePath(record, merged.steam_id64));
  const eosId = asString(resolvePath(record, merged.eos_id));
  if (!steamId64 && !eosId) return null;

  return {
    steamId64,
    eosId,
    nickname: asString(resolvePath(record, merged.nickname)),
    reason: asString(resolvePath(record, merged.reason)),
    adminName: asString(resolvePath(record, merged.admin_name)),
    issuedAt: asDate(resolvePath(record, merged.issued_at)),
    expiresAt: asDate(resolvePath(record, merged.expires_at)),
    raw: record,
  };
}

/**
 * Parses a generic JSON ban export using a source-configured field mapping:
 * `{ list_path?: string, fields: { steam_id64?, eos_id?, ... } }`, each
 * field value being a dot-path into each list record. Records lacking both
 * a `steam_id64` and an `eos_id` are skipped (mirrors the DB's
 * `external_bans_identity_chk` constraint).
 */
export function parseJsonGeneric(
  text: string,
  parserConfig: Record<string, unknown> = {},
): ParseResult {
  const config = readPathConfig('json_generic', parserConfig);
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new Error(`json_generic: invalid JSON (${(err as Error).message})`);
  }

  const list = resolveListPath(root, config.list_path);
  const records: ParsedBan[] = [];
  let skipped = 0;
  for (const entry of list) {
    const parsed = recordToParsedBan(entry, config.fields ?? {});
    if (parsed) {
      records.push(parsed);
    } else {
      skipped++;
    }
  }
  return { records, skipped };
}
