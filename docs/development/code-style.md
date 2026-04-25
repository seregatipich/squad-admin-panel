# Code style

Formatting, naming, and structural conventions enforced by the project toolchain. Most rules are automatically verified by Biome and TypeScript; this document explains the intent behind each rule so contributors can apply them to cases the tools cannot catch.

## Formatter (Biome)

Config: `biome.json` at the repo root.

| Setting | Value |
|---|---|
| Indent | 2 spaces |
| Line width | 100 characters |
| Line endings | LF |
| Quote style (JS/TS) | Single quotes |
| Semicolons | Always |
| Trailing commas | All (function args, objects, arrays) |
| Arrow parens | Always |
| JSON trailing commas | None |
| CSS quotes | Double |

Run formatter + linter together:

```bash
pnpm exec biome check --write .
# aliased as:
pnpm lint:fix
```

Biome is a pre-commit blocker. Do not commit files with Biome errors.

Excluded paths: `node_modules/`, `dist/`, `.next/`, `.turbo/`, `coverage/`, `packages/db/drizzle/` (generated SQL), `packages/db/src/drizzle-client.ts` (generated), `apps/web/src/styles/`.

## Linter rules (Biome)

All `recommended` rules are enabled, plus:

| Rule | Severity | Effect |
|---|---|---|
| `correctness/noUnusedImports` | error | Unused imports are removed immediately. |
| `correctness/noUnusedVariables` | error | Dead variables must be removed, not commented out. |
| `style/useConst` | error | `let` is only valid when the binding is reassigned. |
| `style/useTemplate` | error | String concatenation with `+` is replaced by template literals. |
| `style/useImportType` | error | Type-only imports use `import type`. |
| `suspicious/noExplicitAny` | error | `any` is forbidden. Use `unknown` + type guard, or a specific type. |
| `style/noNonNullAssertion` | warn | `!` postfix operator is a warning. Prefer a null check or type assertion with a comment. |
| `correctness/useExhaustiveDependencies` | warn | React hook dependency arrays must be exhaustive. |

## TypeScript

The strict compiler config is defined in `tsconfig.base.json`. Key rules beyond `strict: true`:

- `noUncheckedIndexedAccess`: `arr[i]` returns `T | undefined`. Always check before use.
- `noUnusedLocals` / `noUnusedParameters`: unused identifiers are compile errors.
- `verbatimModuleSyntax`: write `import type { Foo }` when Foo is only used as a type.

Type errors are blockers — treat them the same as failing tests.

## Go (bridge only)

- `gofmt -s` formatting is enforced by the pre-commit hook.
- `go vet ./...` must pass before committing.
- All exported functions, types, and constants have doc comments.
- Error wrapping uses `fmt.Errorf("context: %w", err)`.
- CGO is disabled (`CGO_ENABLED=0`). The binary must be statically linked.

## Naming

### TypeScript / JavaScript

| Construct | Convention | Example |
|---|---|---|
| Variables, functions | camelCase | `loadUserPermissions`, `sessionId` |
| Classes, interfaces, types | PascalCase | `BridgeClient`, `EventEnvelope` |
| Constants | camelCase or SCREAMING_SNAKE for module-level singletons | `PANEL_LOGS_STREAM`, `permissionKeys` |
| React components | PascalCase | `RoleColorDot`, `MetricHistoryModal` |
| Files (TS/TSX) | kebab-case | `server-configs.ts`, `RoleEditor.tsx` |
| Boolean flags | Yes/no question: `is*`, `has*`, `should*`, `can*` | `isSystemRole`, `hasAccess`, `shouldRetry` |
| Iterators | Singular of collection | `for (const server of servers)` |

Avoid generic names: `data`, `item`, `value`, `temp`, `res`, `obj`, `result`. Name the domain concept.

### Go

Follow standard Go naming. Acronyms are all-caps: `RCON`, `RPC`, `URL`, `ID`, `API`.

## Comments

Do not add comments unless the code genuinely cannot carry the context.

Prohibited:
- Inline `// explains what the next line does`
- Block comments restating function signatures
- `// TODO` without a ticket reference
- `// FIXME` without an active fix in progress
- Commented-out code

Use descriptive names to eliminate the need for comments. If a function's behavior is surprising, rename it or extract a helper with a name that makes the behavior obvious.

Exception: complex algorithmic code (Myers diff walk in `apps/api/src/lib/blame.ts`, Valve RCON framing in `apps/workers/rcon/src/protocol.ts`) may have a brief reference to the algorithm name.

## Control flow

Prefer guard clauses over nested if/else:

```typescript
// preferred
if (!req.session) return reply.code(401).send({ error: 'Unauthorized' });
if (!hasPermission) return reply.code(403).send({ error: 'Forbidden' });
// ... main logic
```

```typescript
// avoid
if (req.session) {
  if (hasPermission) {
    // ... main logic
  } else {
    return reply.code(403).send({ error: 'Forbidden' });
  }
} else {
  return reply.code(401).send({ error: 'Unauthorized' });
}
```

## Imports

Order within a file:

1. Node standard library (`node:fs`, `node:path`, `node:crypto`).
2. Third-party packages (`fastify`, `zod`, `drizzle-orm`).
3. Workspace packages (`@squad/db`, `@squad/shared-config`).
4. Local relative imports (`../lib/blame.js`, `./schema.js`).

Biome enforces `noUnusedImports` — remove unused imports immediately. The `useImportType` rule enforces `import type` for type-only imports.

## File organisation

- One clear responsibility per file. If a file grows beyond a single clear purpose, split it.
- Test files live next to the code they test (unit) or in `apps/api/test/` (integration/e2e).
- Route files are named after the resource: `servers.ts`, `server-configs.ts`, `players.ts`.
- Plugin files are named after what they decorate: `bridge.ts`, `auth.ts`, `status-reconciler.ts`.

## Error messages

Error messages must be precise and technical:

- Bad: `"Something went wrong"`
- Good: `"Database transaction failed: constraint violation on players.role_id"`

HTTP error responses use `{ error: string }`. WebSocket protocol errors use the `ProtocolError` type from `packages/shared-types`.

## Dead code

Remove dead code immediately. Do not leave:
- Commented-out function bodies.
- Unused exports that are not consumed anywhere.
- Feature flags that are always true/false.
- Fallback paths for cases that cannot occur given the current schema.

## YAGNI

Do not add features, options, helpers, or abstractions that are not required by the current task. Three similar lines of code is better than a premature abstraction. Design for the current requirement, not a hypothetical future extension.

## See also

- [`biome.json`](../../biome.json) — authoritative formatter + linter config.
- [`tsconfig.base.json`](../../tsconfig.base.json) — TypeScript strict flags.
- [`lefthook.yml`](../../lefthook.yml) — pre-commit hook definitions.
- [`docs/development/conventions.md`](./conventions.md) — structural and workflow conventions.
