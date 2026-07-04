export interface StreamEvent {
  type: string;
  ts: string;
  payload: unknown;
}

export interface DiffResult {
  parityPct: number;
  matched: number;
  missingInShadow: StreamEvent[];
  extraInShadow: StreamEvent[];
  missingTypes: string[];
}

const SKEW_MS = 5_000;

function key(e: StreamEvent): string {
  return `${e.type} ${JSON.stringify(e.payload)}`;
}

export function compareStreams(prod: StreamEvent[], shadow: StreamEvent[]): DiffResult {
  const pool = new Map<string, StreamEvent[]>();
  for (const e of shadow) {
    const k = key(e);
    const arr = pool.get(k) ?? [];
    arr.push(e);
    pool.set(k, arr);
  }
  const missingInShadow: StreamEvent[] = [];
  let matched = 0;
  for (const e of prod) {
    const candidates = pool.get(key(e)) ?? [];
    const i = candidates.findIndex((c) => Math.abs(Date.parse(c.ts) - Date.parse(e.ts)) <= SKEW_MS);
    if (i === -1) {
      missingInShadow.push(e);
    } else {
      candidates.splice(i, 1);
      matched += 1;
    }
  }
  const extraInShadow = [...pool.values()].flat();
  const parityPct = prod.length === 0 ? 100 : Math.round((matched / prod.length) * 10000) / 100;
  const missingTypes = [...new Set(missingInShadow.map((e) => e.type))];
  return { parityPct, matched, missingInShadow, extraInShadow, missingTypes };
}
