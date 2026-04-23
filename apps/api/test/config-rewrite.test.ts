import { describe, expect, it } from 'vitest';
import { rewriteRconCfg, rewriteServerCfg } from '../src/routes/server-install.js';

describe('rewriteRconCfg', () => {
  it('replaces Port and Password when already present', () => {
    const input = `IP=\nPort=21114\nPassword=old\n# comment\n`;
    const out = rewriteRconCfg(input, { port: 21115, password: 'newpass' });
    expect(out).toMatch(/^Port=21115$/m);
    expect(out).toMatch(/^Password=newpass$/m);
    expect(out).toMatch(/^IP=0\.0\.0\.0$/m);
    expect(out).toMatch(/# comment/);
  });

  it('appends missing keys', () => {
    const out = rewriteRconCfg('', { port: 21114, password: 'p1' });
    expect(out).toMatch(/^Port=21114$/m);
    expect(out).toMatch(/^Password=p1$/m);
    expect(out).toMatch(/^IP=0\.0\.0\.0$/m);
  });

  it('keeps other lines verbatim', () => {
    const input = `# squad rcon defaults\n# Port=21114\nAllowedIPs=\n`;
    const out = rewriteRconCfg(input, { port: 21114, password: 'xyz' });
    expect(out).toMatch(/# squad rcon defaults/);
    expect(out).toMatch(/AllowedIPs=/);
  });
});

describe('rewriteServerCfg', () => {
  it('overwrites existing ServerName line', () => {
    const input = `ServerName="default"\nMapRotation=AAS\n`;
    const out = rewriteServerCfg(input, 'My Panel Server');
    expect(out).toMatch(/^ServerName="My Panel Server"$/m);
    expect(out).toMatch(/MapRotation=AAS/);
  });

  it('appends when ServerName missing', () => {
    const out = rewriteServerCfg('', 'New');
    expect(out.trim()).toBe(`ServerName="New"`);
  });
});
