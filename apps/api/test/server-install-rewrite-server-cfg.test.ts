import { describe, expect, it } from 'vitest';
import { rewriteServerCfg } from '../src/routes/server-install.js';

/**
 * #293: rewriteServerCfg interpolates displayName unescaped into
 * `ServerName="${displayName}"`. The zod schema now rejects quotes/CR/LF at
 * the API boundary (see packages/shared-types/test/api.test.ts), but this is
 * the last line of defense before the value becomes a raw Server.cfg
 * directive, so it must sanitize independently of upstream validation.
 */
describe('rewriteServerCfg', () => {
  it('strips a double quote that would close the ServerName value early', () => {
    const out = rewriteServerCfg('ServerName="Old"\n', 'Box"');
    expect(out).toBe('ServerName="Box"\n');
  });

  it('strips newlines that would inject an extra Server.cfg directive', () => {
    const out = rewriteServerCfg('ServerName="Old"\n', 'Box\nMaxPlayers=1');
    expect(out).not.toContain('\nMaxPlayers=1');
    expect(out).toBe('ServerName="BoxMaxPlayers=1"\n');
  });

  it('leaves an ordinary display name untouched', () => {
    const out = rewriteServerCfg('ServerName="Old"\n', 'My Squad Server');
    expect(out).toBe('ServerName="My Squad Server"\n');
  });
});
