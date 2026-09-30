import type { ParsedBan, ParseResult } from './index.js';
import { unixSecondsToDate } from './json-generic.js';

export interface CsvColumns {
  steam_id64?: number | string;
  eos_id?: number | string;
  nickname?: number | string;
  reason?: number | string;
  admin_name?: number | string;
  issued_at?: number | string;
  expires_at?: number | string;
}

export interface CsvConfig {
  csv?: {
    delimiter?: string;
    has_header?: boolean;
    columns?: CsvColumns;
  };
}

/**
 * Validates the `csv` section of a source's untyped `parser_config`: the
 * delimiter must be exactly one character (anything else would turn every
 * row into a single field), `has_header` a boolean and each column a numeric
 * index or a header name.
 *
 * @throws Error naming the offending key when a value has the wrong type.
 */
function readCsvConfig(parserConfig: Record<string, unknown>): NonNullable<CsvConfig['csv']> {
  const csv = parserConfig.csv;
  if (csv === undefined) return {};
  if (csv === null || typeof csv !== 'object' || Array.isArray(csv)) {
    throw new Error('csv: parser_config.csv must be an object');
  }
  const { delimiter, has_header: hasHeader, columns } = csv as Record<string, unknown>;
  if (delimiter !== undefined && (typeof delimiter !== 'string' || delimiter.length !== 1)) {
    throw new Error('csv: parser_config.csv.delimiter must be a single character');
  }
  if (hasHeader !== undefined && typeof hasHeader !== 'boolean') {
    throw new Error('csv: parser_config.csv.has_header must be a boolean');
  }
  if (columns !== undefined) {
    if (columns === null || typeof columns !== 'object' || Array.isArray(columns)) {
      throw new Error('csv: parser_config.csv.columns must be an object');
    }
    for (const [key, column] of Object.entries(columns)) {
      if (typeof column !== 'number' && typeof column !== 'string') {
        throw new Error(`csv: parser_config.csv.columns.${key} must be a number or a string`);
      }
    }
  }
  return { delimiter, has_header: hasHeader, columns } as NonNullable<CsvConfig['csv']>;
}

/** Splits one CSV line into fields, honoring double-quoted fields with `""`-escaped quotes. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return inQuotes ? [] : fields;
}

function asString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asDate(value: string | undefined): Date | null {
  const str = asString(value);
  if (!str) return null;
  if (/^\d+$/.test(str)) return unixSecondsToDate(Number(str));
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function columnIndex(column: number | string | undefined, header: string[] | null): number | null {
  if (column === undefined) return null;
  if (typeof column === 'number') return column;
  if (!header) return null;
  const idx = header.indexOf(column);
  return idx >= 0 ? idx : null;
}

/**
 * Parses a CSV ban list using a source-configured `{ csv: { delimiter?,
 * has_header?, columns } }` mapping, where each column is either a numeric
 * index or (when `has_header` is true) a header name. Rows with neither a
 * resolvable `steam_id64` nor `eos_id`, or that fail to split (unterminated
 * quote), are skipped rather than aborting the whole sync.
 */
export function parseCsv(text: string, parserConfig: Record<string, unknown> = {}): ParseResult {
  const config = readCsvConfig(parserConfig);
  const delimiter = config.delimiter ?? ',';
  const hasHeader = config.has_header ?? true;
  const columns = config.columns ?? {};

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { records: [], skipped: 0 };

  let header: string[] | null = null;
  let dataLines = lines;
  if (hasHeader) {
    header = splitCsvLine(lines[0] ?? '', delimiter);
    dataLines = lines.slice(1);
  }

  const steamIdx = columnIndex(columns.steam_id64, header);
  const eosIdx = columnIndex(columns.eos_id, header);
  const nicknameIdx = columnIndex(columns.nickname, header);
  const reasonIdx = columnIndex(columns.reason, header);
  const adminIdx = columnIndex(columns.admin_name, header);
  const issuedIdx = columnIndex(columns.issued_at, header);
  const expiresIdx = columnIndex(columns.expires_at, header);

  const records: ParsedBan[] = [];
  let skipped = 0;

  for (const line of dataLines) {
    const fields = splitCsvLine(line, delimiter);
    if (fields.length === 0) {
      skipped++;
      continue;
    }
    const steamId64 = steamIdx !== null ? asString(fields[steamIdx]) : null;
    const eosId = eosIdx !== null ? asString(fields[eosIdx]) : null;
    if (!steamId64 && !eosId) {
      skipped++;
      continue;
    }
    records.push({
      steamId64,
      eosId,
      nickname: nicknameIdx !== null ? asString(fields[nicknameIdx]) : null,
      reason: reasonIdx !== null ? asString(fields[reasonIdx]) : null,
      adminName: adminIdx !== null ? asString(fields[adminIdx]) : null,
      issuedAt: issuedIdx !== null ? asDate(fields[issuedIdx]) : null,
      expiresAt: expiresIdx !== null ? asDate(fields[expiresIdx]) : null,
      raw: { fields },
    });
  }

  return { records, skipped };
}
