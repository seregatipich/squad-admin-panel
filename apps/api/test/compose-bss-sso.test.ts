import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(__dirname, '../../..');
const COMPOSE_FILES = ['docker-compose.yml', 'compose.tk104.yml'] as const;

function serviceBlock(yaml: string, service: string): string {
  const start = yaml.indexOf(`\n  ${service}:\n`);
  if (start < 0) throw new Error(`service ${service} not found`);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe.each(COMPOSE_FILES)('%s — BSS SSO environment contract', (file) => {
  const yaml = readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8');
  const api = serviceBlock(yaml, 'api');
  const web = serviceBlock(yaml, 'web');

  it('passes the complete current/next provider contract only to API', () => {
    for (const name of [
      'BSS_SITE_URL',
      'BSS_SSO_CLIENT_ID',
      'BSS_SSO_CLIENT_SECRET',
      'BSS_SSO_CLIENT_SECRET_NEXT',
    ]) {
      expect(api).toContain(`${name}:`);
    }
    expect(web).not.toContain('BSS_SSO_CLIENT_SECRET');
  });

  it('passes only the public site origin to the web interface', () => {
    expect(web).toContain('BSS_SITE_URL:');
    expect(web).not.toContain('BSS_SSO_CLIENT_ID:');
  });

  it('passes the private VIP lifecycle contract only to API', () => {
    for (const name of ['VIP_LIFECYCLE_WEBHOOK_SECRET', 'VIP_LIFECYCLE_REQUIRE_REVISION']) {
      expect(api).toContain(`${name}:`);
      expect(web).not.toContain(`${name}:`);
      expect(yaml.match(new RegExp(`^\\s+${name}:`, 'gmu'))).toHaveLength(1);
    }
  });

  it('passes the exact release marker only to API health', () => {
    expect(api).toContain('APP_VERSION:');
    expect(web).not.toContain('APP_VERSION:');
    expect(yaml.match(/^\s+APP_VERSION:/gmu)).toHaveLength(1);
  });
});
