import type { ParsedBan, ParseResult } from './index.js';

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
  if (/^\d+$/.test(str)) return new Date(Number(str) * 1000);
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
  const config = (parserConfig as CsvConfig).csv ?? {};
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
