import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Regression test: every package the api and workers images run declares each
 * package its source imports at run time under `dependencies`.
 *
 * docker/api.Dockerfile and docker/worker.Dockerfile ship a clean
 * `pnpm install --prod`, so a devDependency does not exist in the image.
 * apps/api imported `drizzle-orm` while declaring it only as a devDependency;
 * the old images never noticed because their in-place prune left every
 * devDependency installed, and the first genuinely production install made the
 * api exit with ERR_MODULE_NOT_FOUND.
 *
 * The source is authoritative because tsconfig.base.json sets
 * `verbatimModuleSyntax`: only `import type` / `export type` declarations are
 * erased, so every other import, re-export and `import()` reaches the emitted
 * JavaScript. apps/web is not scanned — Next.js bundles its server code.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const BUILTINS = new Set(builtinModules);

interface ImageRuntimePackage {
  dir: string;
  name: string;
  dependencies: Set<string>;
}

function imageRuntimePackages(): ImageRuntimePackage[] {
  const dirs = [
    'apps/api',
    ...readdirSync(join(REPO_ROOT, 'packages')).map((name) => `packages/${name}`),
    ...readdirSync(join(REPO_ROOT, 'apps/workers')).map((name) => `apps/workers/${name}`),
  ];
  return dirs
    .filter((dir) => existsSync(join(REPO_ROOT, dir, 'package.json')))
    .filter((dir) => existsSync(join(REPO_ROOT, dir, 'src')))
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf-8'));
      return {
        dir,
        name: manifest.name,
        dependencies: new Set([
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.optionalDependencies ?? {}),
        ]),
      };
    });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(ts|mts|js|mjs)$/.test(entry.name)) return [];
    if (/\.test\.[mc]?[jt]s$|\.d\.ts$/.test(entry.name)) return [];
    return [path];
  });
}

/** Module specifiers that survive compilation: everything but type-only imports. */
function runtimeSpecifiers(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** The installed package a bare specifier loads, or null for relative paths and builtins. */
function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:') || BUILTINS.has(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? null);
}

const packages = imageRuntimePackages();

const importsByPackage = new Map(
  packages.map((pkg) => {
    const imports = new Map<string, string>();
    for (const file of sourceFiles(join(REPO_ROOT, pkg.dir, 'src'))) {
      for (const specifier of runtimeSpecifiers(file, readFileSync(file, 'utf-8'))) {
        const name = packageNameOf(specifier);
        if (name && name !== pkg.name && !imports.has(name)) {
          imports.set(name, relative(REPO_ROOT, file));
        }
      }
    }
    return [pkg.name, imports] as const;
  }),
);

describe('runtimeSpecifiers', () => {
  it('keeps value imports, re-exports, side-effect imports and import()', () => {
    const text = [
      "import { a } from 'value-import';",
      "import { type T } from 'inline-type-import';",
      "import 'side-effect';",
      "export { b } from 'value-reexport';",
      "export * from './relative.js';",
      "const lazy = await import('dynamic-import');",
    ].join('\n');
    expect(runtimeSpecifiers('probe.ts', text)).toEqual([
      'value-import',
      // verbatimModuleSyntax emits `import {} from 'inline-type-import'`.
      'inline-type-import',
      'side-effect',
      'value-reexport',
      './relative.js',
      'dynamic-import',
    ]);
  });

  it('drops only what verbatimModuleSyntax erases, and comments', () => {
    const text = [
      "import type { T } from 'type-import';",
      "export type { U } from 'type-reexport';",
      "/** @throws {import('zod').ZodError} */",
      "type Lazy = import('import-type-node').Thing;",
    ].join('\n');
    expect(runtimeSpecifiers('probe.ts', text)).toEqual([]);
  });
});

describe('packageNameOf', () => {
  it('maps bare and scoped specifiers, including subpaths, to package names', () => {
    expect(packageNameOf('drizzle-orm')).toBe('drizzle-orm');
    expect(packageNameOf('drizzle-orm/postgres-js')).toBe('drizzle-orm');
    expect(packageNameOf('@squad/db/schema')).toBe('@squad/db');
  });

  it('ignores relative paths and Node builtins', () => {
    expect(packageNameOf('./local.js')).toBeNull();
    expect(packageNameOf('node:fs')).toBeNull();
    expect(packageNameOf('crypto')).toBeNull();
  });
});

describe('image runtime packages declare their runtime imports as dependencies', () => {
  it('scans the api, every workspace package and every worker', () => {
    const names = packages.map((pkg) => pkg.name);
    expect(names).toContain('@squad/api');
    expect(names).toContain('@squad/db');
    expect(names).toContain('@squad/worker-scheduler');
    // A scan that found nothing would pass vacuously.
    expect(importsByPackage.get('@squad/api')?.has('fastify')).toBe(true);
    expect(importsByPackage.get('@squad/api')?.has('drizzle-orm')).toBe(true);
  });

  it.each(packages.map((pkg) => [pkg.name, pkg] as const))('%s', (_name, pkg) => {
    const undeclared = [...(importsByPackage.get(pkg.name) ?? [])]
      .filter(([name]) => !pkg.dependencies.has(name))
      .map(([name, file]) => `${name} (imported by ${file})`);
    expect(
      undeclared,
      `${pkg.dir}/package.json must list these under "dependencies": the images install --prod, so a devDependency is missing at run time`,
    ).toEqual([]);
  });
});
