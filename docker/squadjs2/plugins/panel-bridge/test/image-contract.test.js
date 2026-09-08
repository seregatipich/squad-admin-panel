import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoFile = (relative) =>
  readFileSync(fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url)), 'utf8');

const dockerfile = repoFile('docker/squadjs2.Dockerfile');
const entrypoint = repoFile('docker/squadjs2/entrypoint.sh');
const manifest = JSON.parse(repoFile('docker/squadjs2/plugins/panel-bridge/package.json'));
const pinDoc = repoFile('ai_docs/squadjs2-pin-2026-08-24.md');

describe('squadjs2 sidecar image contract', () => {
  it('pins the base image by digest, never by tag', () => {
    expect(dockerfile).toMatch(/^FROM ghcr\.io\/breaking-squad\/squadjs@\$\{SQUADJS2_DIGEST\}$/m);
    expect(dockerfile).toMatch(/^ARG SQUADJS2_DIGEST=sha256:[0-9a-f]{64}$/m);
  });

  it('uses the digest recorded in the pin document', () => {
    const fromDockerfile = dockerfile.match(/^ARG SQUADJS2_DIGEST=(sha256:[0-9a-f]{64})$/m)?.[1];
    expect(pinDoc).toContain(fromDockerfile);
  });

  it('installs the plugin dependencies at the versions the package declares', () => {
    const installed = dockerfile.match(/npm install [^\n]*?ioredis@([0-9.]+) uuid@([0-9.]+)/);
    expect(installed?.[1]).toBe(manifest.dependencies.ioredis);
    expect(installed?.[2]).toBe(manifest.dependencies.uuid);
  });

  it('keeps the plugin dependencies out of the verified /app/node_modules tree', () => {
    expect(dockerfile).toContain('/app/squad-server/plugins/node_modules');
    expect(dockerfile).not.toMatch(/^RUN[^\n]*yarn add/m);
    expect(dockerfile).not.toMatch(/COPY[^\n]*\/app\/node_modules/);
  });

  it('never copies the local base-plugin test double over upstream plugins', () => {
    // SquadJS2 imports ./base-plugin.js from squad-server/plugins/; a wildcard
    // COPY of src/*.js would replace it with this package's stub.
    expect(dockerfile).not.toMatch(/COPY[^\n]*src\/\*\.js/);
    expect(dockerfile).toContain(
      'docker/squadjs2/plugins/panel-bridge/src/panel-bridge.js /app/squad-server/plugins/panel-bridge.js',
    );
    expect(dockerfile).not.toMatch(/base-plugin\.js \/app/);
  });

  it('runs as the uid the bridge grants the sidecar', () => {
    expect(dockerfile).toMatch(/^USER 1001:1001$/m);
  });

  it('replaces the upstream entrypoint with the panel one', () => {
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]');
    expect(entrypoint).not.toContain('envsubst');
  });
});

describe('squadjs2 sidecar entrypoint contract', () => {
  it('refuses to start without SERVER_ID', () => {
    expect(entrypoint).toMatch(/SERVER_ID is required/);
  });

  it('refuses to start without a rendered config', () => {
    expect(entrypoint).toContain('/app/panel-config.json');
    expect(entrypoint).toMatch(/-s "\$CONFIG_PATH"/);
  });

  it('waits for the log file instead of crash-looping', () => {
    expect(entrypoint).toMatch(/LOG_FILE:-\/squad\/Logs\/SquadGame\.log/);
    expect(entrypoint).toMatch(/LOG_WAIT_SECONDS:-60/);
  });

  it('execs SquadJS2 with the panel config path as argv[2]', () => {
    expect(entrypoint).toContain('exec dumb-init node index.js "$CONFIG_PATH"');
  });
});
