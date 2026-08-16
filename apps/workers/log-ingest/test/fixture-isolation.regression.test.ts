// regression: apps/workers/log-ingest/test/combat-store.test.ts, vote-store.test.ts,
// match-roster-store.test.ts, chat-store.test.ts and chat-commands.test.ts each insert rows
// into the shared `players` table under hardcoded eos_id/steam_id64 literals. Two files
// claiming the same literal collide on players_eos_id_unique_idx / players_steam_id64_unique_idx
// against a persistent (non-recreated) database — invisible in CI, which provisions a fresh
// database per run. See #228 (combat-store/vote-store/match-roster-store) and #257
// (chat-store/chat-commands, found during #228's research but out of that issue's scope).
// Mirrors apps/api/test/test-isolation.regression.test.ts's static-guard idea, scoped to the
// files that actually write `players` rows with these fixtures.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const GUARDED_FILES = [
  'combat-store.test.ts',
  'vote-store.test.ts',
  'match-roster-store.test.ts',
  'chat-store.test.ts',
  'chat-commands.test.ts',
];

const FIXTURE_CONST_RE = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:'([^']*)'|(\d+)n)\s*;/g;

function fixtureLiterals(file: string): Map<string, string> {
  const src = readFileSync(path.resolve(import.meta.dirname, file), 'utf8');
  const byName = new Map<string, string>();
  for (const match of src.matchAll(FIXTURE_CONST_RE)) {
    const [, name, stringValue, bigintValue] = match;
    if (!name || !/(^|_)(EOS|STEAM)(_|$)/.test(name)) continue;
    byName.set(name, stringValue ?? (bigintValue as string));
  }
  return byName;
}

describe('log-ingest player-fixture isolation (#228, #257)', () => {
  it('combat-store/vote-store/match-roster-store/chat-store/chat-commands never share an eos_id or steam_id64 literal', () => {
    const perFile = GUARDED_FILES.map((file) => [file, fixtureLiterals(file)] as const);

    for (const [file, literals] of perFile) {
      expect(literals.size, `${file} has no EOS/STEAM fixture constants to check`).toBeGreaterThan(
        0,
      );
    }

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
});
