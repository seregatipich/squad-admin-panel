import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `toLocaleString()` and friends without an explicit locale format in the
 * *browser's* locale, not the panel's. A Russian panel then printed
 * `8/23/2026, 11:35:00 AM` next to `22.08.2026, 03:33` on the very same screen,
 * and the format changed with the viewer's machine and ICU version — so no
 * screenshot or test could pin it down.
 *
 * The panel formats through `<DateTime>` / `formatAbsolute` with the tag from
 * `useIntlLocale()`. This test fails the build if a bare call comes back.
 */
const BARE_LOCALE_CALL = /\.toLocale(?:String|DateString|TimeString)\(\s*\)/;

/* Comments explaining exactly this defect quote the bare call by design. */
const EXPLANATORY_LINE = /^\s*(?:\*|\/\/|\/\*)/;

describe('date formatting across the web app', () => {
  it('never falls back to the browser locale', () => {
    const sourceRoot = path.resolve(import.meta.dirname, '..');
    const offenders: string[] = [];

    for (const filename of readdirSync(sourceRoot, { encoding: 'utf8', recursive: true })) {
      if (!/\.tsx?$/.test(filename) || /\.(?:test|spec)\.tsx?$/.test(filename)) continue;

      const source = readFileSync(path.join(sourceRoot, filename), 'utf8');
      source.split('\n').forEach((line, index) => {
        if (!BARE_LOCALE_CALL.test(line) || EXPLANATORY_LINE.test(line)) return;
        offenders.push(`${filename}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
