import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #19 regression: the alert engine existed but nothing in the worker called
 * it, so every configured rule stayed silent. `src/index.ts` cannot be booted
 * in a test (it needs the bridge socket and a live tail), so this pins the
 * wiring at source level the way `route-registration-parity.test.ts` pins API
 * route registration. `alerts-store.test.ts` proves what the call does.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(path.resolve(here, '../src/index.ts'), 'utf-8');

function onLineBody(): string {
  const start = indexSource.indexOf('const onLine = (line: string) => {');
  expect(start, 'onLine handler not found in src/index.ts').toBeGreaterThan(-1);
  const end = indexSource.indexOf("if (wanted.source.kind === 'ssh')", start);
  return indexSource.slice(start, end);
}

describe('log-ingest alert wiring (#19)', () => {
  it('imports the alert runtime and builds one rule cache for the worker', () => {
    expect(indexSource).toMatch(
      /import \{[^}]*\bAlertRuleCache\b[^}]*\bhandleAlertEvent\b[^}]*\} from '\.\/alerts\/store\.js'/,
    );
    expect(indexSource).toMatch(/new AlertRuleCache\(db/);
  });

  it('evaluates alert rules for every parsed event', () => {
    expect(onLineBody()).toMatch(/handleAlertEvent\(db, redis, alertRuleCache, e/);
  });

  it('evaluates a connect before the identity handler records the new IP', () => {
    const body = onLineBody();
    const alertCall = body.indexOf('handleAlertEvent(');
    const identityCall = body.indexOf('handlePlayerConnected(db, e, geoLookup)');
    expect(alertCall).toBeGreaterThan(-1);
    expect(identityCall).toBeGreaterThan(alertCall);
  });
});
