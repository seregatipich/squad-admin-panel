import { serverCredentials, servers } from '@squad/db/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const EMAIL = 'owner@test.local';
const PASSWORD = 'correct-horse-battery-staple';
const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';
const RCON_PORT = 21114;
const RCON_PASSWORD = 'top-secret';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { email: EMAIL, password: PASSWORD },
    bridge: makeFakeBridge(),
  });
  await h.db.insert(servers).values({
    id: SERVER_ID,
    orgId: h.seed.orgId!,
    displayName: 'fixture',
    slug: 'fixture',
    status: 'running',
    runtime: 'container',
  });
  await h.db.insert(serverCredentials).values({
    serverId: SERVER_ID,
    rconPort: RCON_PORT,
    rconPasswordEncrypted: Buffer.from('ignored-by-this-endpoint'),
  });
  h.bridge.files.set(
    `/var/lib/squad-panel/configs/${SERVER_ID}/ServerConfig/Rcon.cfg`,
    Buffer.from(`Password=${RCON_PASSWORD}\nPort=${RCON_PORT}\nIP=0.0.0.0\n`, 'utf-8'),
  );
});

afterEach(async () => {
  await h.cleanup();
});

describe('GET /internal/rnsquadjs/config/:id', () => {
  it('rejects non-loopback callers with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/internal/rnsquadjs/config/${SERVER_ID}`,
      remoteAddress: '10.0.0.5',
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns the rendered RNSquadJS config from loopback', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/internal/rnsquadjs/config/${SERVER_ID}`,
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    const body =
      res.json<
        Record<
          string,
          {
            host: string;
            port: number;
            password: string;
            logFilePath: string;
            plugins: Record<string, { enabled: boolean }>;
          }
        >
      >();
    expect(body).toMatchObject({
      [SERVER_ID]: {
        host: '127.0.0.1',
        port: RCON_PORT,
        password: RCON_PASSWORD,
        logFilePath: '/squad/Logs/SquadGame.log',
        plugins: { panelBridge: { enabled: true } },
      },
    });
    expect(body[SERVER_ID]!.plugins.autoUpdateMods!.enabled).toBe(false);
    expect(body[SERVER_ID]!.plugins.chatCommands!.enabled).toBe(false);
    expect(body[SERVER_ID]!.plugins.voteMap!.enabled).toBe(false);
    expect(body[SERVER_ID]!.plugins.warnings!.enabled).toBe(false);
    expect(body[SERVER_ID]!.plugins.broadcasts!.enabled).toBe(false);
    expect(body[SERVER_ID]!.plugins.autoKick!.enabled).toBe(false);
    expect(body[SERVER_ID]!.plugins.squadLeader!.enabled).toBe(false);
  });

  it('404 on unknown server', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/internal/rnsquadjs/config/019dbaa5-0000-7000-8000-000000000000',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(404);
  });
});
