import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const composePath = resolve(__dirname, '../../../docker-compose.yml');
// Match the runtime directory; both legacy single-file mounts
// (`/run/panel-host-bridge.sock`) and the current directory mount
// (`/run/panel-host-bridge`) start with this prefix.
const BRIDGE_PATH_PREFIX = '/run/panel-host-bridge';
// Detect legacy single-file mounts and call them out explicitly so a future
// regression to the broken pattern is rejected by the test.
const LEGACY_FILE_MOUNT =
  /^\s*-\s*\/run\/panel-host-bridge\.sock:\/run\/panel-host-bridge\.sock\b/m;

interface ServiceBlock {
  name: string;
  body: string;
}

function parseServices(yaml: string): ServiceBlock[] {
  const lines = yaml.split('\n');
  const services: ServiceBlock[] = [];
  let inServices = false;
  let current: ServiceBlock | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim().length > 0) break;
    const serviceMatch = /^ {2}([\w-]+):\s*$/.exec(line);
    if (serviceMatch) {
      if (current) {
        current.body = currentLines.join('\n');
        services.push(current);
      }
      current = { name: serviceMatch[1] ?? '', body: '' };
      currentLines = [];
      continue;
    }
    if (current) currentLines.push(line);
  }
  if (current) {
    current.body = currentLines.join('\n');
    services.push(current);
  }
  return services;
}

describe('docker-compose.yml — bridge socket permissions contract', () => {
  const compose = readFileSync(composePath, 'utf-8');
  const services = parseServices(compose);
  const bridgeUsers = services.filter((s) => s.body.includes(BRIDGE_PATH_PREFIX));

  it('finds at least one service that mounts the bridge runtime directory', () => {
    expect(bridgeUsers.length).toBeGreaterThan(0);
  });

  for (const svc of bridgeUsers) {
    it(`${svc.name}: declares panel GID via user: (not group_add:)`, () => {
      const userMatch = /^\s*user:\s*"0:\$\{PANEL_GID:-987\}"/m.exec(svc.body);
      const groupAddMatch = /^\s*group_add:\s*$/m.exec(svc.body);

      expect(
        userMatch,
        [
          `Service "${svc.name}" mounts ${BRIDGE_PATH_PREFIX} but does not set primary GID via user: directive.`,
          `The bridge SO_PEERCRED check inspects only the primary GID; group_add adds`,
          `to the supplementary list which is NOT checked. Fix:`,
          `  user: "0:\${PANEL_GID:-987}"`,
          `See docs/components/bridge/troubleshooting.md.`,
        ].join('\n'),
      ).not.toBeNull();

      expect(
        groupAddMatch,
        `Service "${svc.name}" mounts the bridge socket and uses group_add: — this fails SO_PEERCRED. Use user: "0:\${PANEL_GID:-987}" instead.`,
      ).toBeNull();
    });

    it(`${svc.name}: bind-mounts the bridge runtime DIRECTORY, not the socket file`, () => {
      const dirMount = /^\s*-\s*\/run\/panel-host-bridge:\/run\/panel-host-bridge\b/m.exec(
        svc.body,
      );
      const legacy = LEGACY_FILE_MOUNT.exec(svc.body);
      expect(
        dirMount,
        [
          `Service "${svc.name}" must mount the directory, not the socket file:`,
          `  - /run/panel-host-bridge:/run/panel-host-bridge`,
          `Bind-mounting the socket file directly freezes the container on the`,
          `original inode; every bridge restart rotates the inode and consumers`,
          `disconnect permanently until recreated.`,
        ].join('\n'),
      ).not.toBeNull();
      expect(
        legacy,
        `Service "${svc.name}" still uses the legacy single-file mount /run/panel-host-bridge.sock — replace it with the directory mount above.`,
      ).toBeNull();
    });
  }
});
