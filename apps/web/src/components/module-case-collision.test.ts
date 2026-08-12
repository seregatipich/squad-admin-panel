import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('web module names', () => {
  it('have unique extensionless names on case-insensitive filesystems', () => {
    const sourceRoot = path.resolve(import.meta.dirname, '..');
    const namesByFoldedStem = new Map<string, string[]>();

    for (const filename of readdirSync(sourceRoot, { encoding: 'utf8', recursive: true })) {
      if (!/\.tsx?$/.test(filename) || filename.endsWith('.d.ts')) continue;
      const stem = filename.replace(/\.tsx?$/, '');
      const foldedStem = stem.toLocaleLowerCase('en-US');
      const names = namesByFoldedStem.get(foldedStem) ?? [];
      names.push(filename);
      namesByFoldedStem.set(foldedStem, names);
    }

    const collisions = [...namesByFoldedStem.values()].filter((names) => names.length > 1);
    expect(collisions).toEqual([]);
  });
});
