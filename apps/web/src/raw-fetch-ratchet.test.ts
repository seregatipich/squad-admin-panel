import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Ratchet against new raw `fetch(` calls in `@squad/web`.
 *
 * Pages talk to the API through `apiFetch`/`apiSend` (`src/lib/api.ts`) and the
 * `useApiResource`/`usePolledResource` hooks (`src/lib/use-polled-resource.ts`),
 * which own credentials, no-store caching, abort and error shape. A raw
 * `fetch(` re-implements all of that by hand, so the number of them per file
 * may only go down: `raw-fetch-baseline.tsv` records today's count per file
 * (`path<TAB>count`, sorted by path, one line per file so concurrent
 * migrations touch different lines).
 *
 * - A file that exceeds its baseline (or is new and has any raw fetch) fails.
 * - A file whose count dropped, or that no longer has any, also fails until
 *   the baseline is regenerated and committed, so every migration locks in its
 *   gain: `pnpm --filter @squad/web fetch-baseline:update`.
 */
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(WEB_ROOT, 'src');
const BASELINE_FILE = path.join(WEB_ROOT, 'raw-fetch-baseline.tsv');
const API_MODULE = 'src/lib/api.ts';
const UPDATE_COMMAND = 'pnpm --filter @squad/web fetch-baseline:update';
const RAW_FETCH = /(?<![\w$])fetch\(/g;

function isScannedSource(relativePath: string): boolean {
  if (!/\.(ts|tsx)$/.test(relativePath)) return false;
  if (/\.test\.(ts|tsx)$/.test(relativePath) || relativePath.endsWith('.d.ts')) return false;
  return relativePath !== API_MODULE;
}

function countRawFetches(source: string): number {
  let count = 0;
  for (const line of source.split('\n')) {
    const trimmed = line.trimStart();
    // Prose in comments ("fetch(…) resolves") is not a call.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    count += line.match(RAW_FETCH)?.length ?? 0;
  }
  return count;
}

function scanRawFetches(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relativePath = path
      .relative(WEB_ROOT, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    if (!isScannedSource(relativePath)) continue;
    const count = countRawFetches(readFileSync(path.join(WEB_ROOT, relativePath), 'utf8'));
    if (count > 0) counts.set(relativePath, count);
  }
  return counts;
}

function serializeBaseline(counts: Map<string, number>): string {
  const lines = [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, count]) => `${file}\t${count}`);
  return `${lines.join('\n')}\n`;
}

function parseBaseline(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue;
    const [file, count, ...rest] = line.split('\t');
    if (!file || !/^[1-9]\d*$/.test(count ?? '') || rest.length > 0) {
      throw new Error(`${BASELINE_FILE}:${index + 1}: expected "path<TAB>count", got "${line}"`);
    }
    counts.set(file, Number(count));
  }
  return counts;
}

function growth(actual: Map<string, number>, baseline: Map<string, number>): string[] {
  return [...actual]
    .filter(([file, count]) => count > (baseline.get(file) ?? 0))
    .map(([file, count]) => `${file}: ${count} raw fetch(), baseline ${baseline.get(file) ?? 0}`);
}

function shrinkage(actual: Map<string, number>, baseline: Map<string, number>): string[] {
  return [...baseline]
    .filter(([file, count]) => (actual.get(file) ?? 0) < count)
    .map(([file, count]) => `${file}: ${actual.get(file) ?? 0} raw fetch(), baseline ${count}`);
}

const actual = scanRawFetches();

if (process.env.UPDATE_FETCH_BASELINE === '1') {
  const previous = existsSync(BASELINE_FILE)
    ? parseBaseline(readFileSync(BASELINE_FILE, 'utf8'))
    : actual;
  const grown = growth(actual, previous);
  if (grown.length === 0) writeFileSync(BASELINE_FILE, serializeBaseline(actual));
}

describe('raw fetch ratchet', () => {
  const baseline = parseBaseline(readFileSync(BASELINE_FILE, 'utf8'));

  it('adds no raw fetch( outside src/lib/api.ts beyond the committed baseline', () => {
    expect(
      growth(actual, baseline),
      `New raw fetch( calls. Use apiFetch/apiSend from '@/lib/api' or useApiResource/usePolledResource ` +
        `from '@/lib/use-polled-resource' instead. Never raise the baseline.`,
    ).toEqual([]);
  });

  it('has a baseline that matches reality, so every migration lowers it', () => {
    expect(
      shrinkage(actual, baseline),
      `Raw fetch( calls were removed; commit the lower baseline: ${UPDATE_COMMAND}`,
    ).toEqual([]);
  });

  it('keeps the baseline file sorted, one path per line', () => {
    const text = readFileSync(BASELINE_FILE, 'utf8');
    expect(text, `Regenerate the baseline: ${UPDATE_COMMAND}`).toBe(serializeBaseline(baseline));
  });
});
