import { parseBattlemetrics } from './battlemetrics-json.js';
import { parseCsv } from './csv.js';
import { parseJsonGeneric } from './json-generic.js';
import { parseSquadBansCfg } from './squad-bans-cfg.js';

export interface ParsedBan {
  steamId64: string | null;
  eosId: string | null;
  nickname: string | null;
  reason: string | null;
  adminName: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  raw: unknown;
}

export interface ParseResult {
  records: ParsedBan[];
  skipped: number;
}

export type BanSourceFormat = 'squad_bans_cfg' | 'battlemetrics_json' | 'json_generic' | 'csv';

/** Dispatches to the adapter matching `format`; throws for an unknown/unsupported format. */
export function parseBanList(
  format: string,
  text: string,
  parserConfig: Record<string, unknown> = {},
): ParseResult {
  switch (format) {
    case 'squad_bans_cfg':
      return parseSquadBansCfg(text);
    case 'battlemetrics_json':
      return parseBattlemetrics(text, parserConfig);
    case 'json_generic':
      return parseJsonGeneric(text, parserConfig);
    case 'csv':
      return parseCsv(text, parserConfig);
    default:
      throw new Error(`unsupported ban source format: ${format}`);
  }
}
