// regression: every test file here that inserts rows into the shared `players` table does so
// under hardcoded eos_id/steam_id64 literals. Two files claiming the same literal collide on
// players_eos_id_unique_idx / players_steam_id64_unique_idx against a persistent
// (non-recreated) database — invisible in CI, which provisions a fresh database per run.
// See #228 (combat-store/vote-store/match-roster-store) and #257 (chat-store/chat-commands).
//
// The guarded set is DERIVED, not hand-listed (#289): it is every `*.test.ts` in this directory
// whose source inserts into `players`. The previous hardcoded allowlist was extended reactively
// after each collision was found in production, so it covered 5 of the 12 files that actually
// write `players` rows — a new copy-paste among the other 7 would have gone undetected.
// Mirrors apps/api/test/test-isolation.regression.test.ts's static-guard idea.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST_DIR = import.meta.dirname;

/** Matches a top-level `const NAME = '...'` / `const NAME = 123n` fixture declaration. */
const FIXTURE_CONST_RE = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:'([^']*)'|(\d+)n)\s*;/g;
/** A file is in scope precisely when it writes rows into the shared `players` table. */
const PLAYERS_WRITE_RE = /\.insert\(\s*players\s*\)/;

function sourceOf(file: string): string {
  return readFileSync(path.resolve(TEST_DIR, file), 'utf8');
}

/** Every test file in this directory that inserts `players` rows, sorted for stable output. */
function playersWritingFiles(): string[] {
  return readdirSync(TEST_DIR)
    .filter((file) => file.endsWith('.test.ts') && file !== path.basename(import.meta.filename))
    .filter((file) => PLAYERS_WRITE_RE.test(sourceOf(file)))
    .sort();
}

function fixtureLiterals(file: string): Map<string, string> {
  const byName = new Map<string, string>();
  for (const match of sourceOf(file).matchAll(FIXTURE_CONST_RE)) {
    const [, name, stringValue, bigintValue] = match;
    if (!name || !/(^|_)(EOS|STEAM)(_|$)/.test(name)) continue;
    byName.set(name, stringValue ?? (bigintValue as string));
  }
  return byName;
}

describe('log-ingest player-fixture isolation (#228, #257, #289)', () => {
  it('no two test files writing `players` share an eos_id or steam_id64 literal', () => {
    // Files may legitimately carry no top-level EOS/STEAM consts (values inlined or generated);
    // they contribute nothing to compare and are simply skipped, rather than failing the guard.
    const perFile = playersWritingFiles()
      .map((file) => [file, fixtureLiterals(file)] as const)
      .filter(([, literals]) => literals.size > 0);

    const collisions: string[] = [];
    for (let i = 0; i < perFile.length; i++) {
      for (let j = i + 1; j < perFile.length; j++) {
        const [fileA, literalsA] = perFile[i];
        const [fileB, literalsB] = perFile[j];
        for (const [nameA, valueA] of literalsA) {
          for (const [nameB, valueB] of literalsB) {
            if (valueA === valueB) {
              collisions.push(`${fileA}:${nameA} === ${fileB}:${nameB} ('${valueA}')`);
            }
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('derives its guarded set from the files that actually write `players`', () => {
    const guarded = playersWritingFiles();

    // The files #228 and #257 were filed for must always be in scope — if the derivation
    // ever stops finding them, the guard has silently narrowed and the regression can return.
    for (const file of [
      'combat-store.test.ts',
      'vote-store.test.ts',
      'match-roster-store.test.ts',
      'chat-store.test.ts',
      'chat-commands.test.ts',
    ]) {
      expect(guarded, `${file} writes players rows and must stay guarded`).toContain(file);
    }

    // The gap #289 closed: the old hardcoded list stopped at those five.
    expect(
      guarded.length,
      'expected the derived set to cover more than the five hand-listed files',
    ).toBeGreaterThan(5);
  });
});
