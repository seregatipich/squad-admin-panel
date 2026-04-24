import { createHash } from 'node:crypto';
import { configVersions, serverCredentials, serverSettings, servers } from '@squad/db/schema';
import {
  ALLOWED_CONFIG_FILES,
  DEPOT_VOLUME_NAME,
  PANEL_CONFIGS_ROOT,
  PANEL_SAVED_ROOT,
  SERVER_IMAGE,
} from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { decryptString, deserialize } from '../lib/crypto.js';

const paramsSchema = z.object({ id: z.string().uuid() });

// For bind-mounted squad-depot volumes, Docker does not populate the
// /var/lib/docker/volumes/${name}/_data stub directory, so reads through
// it return ENOENT. PANEL_DEPOT_HOST_PATH overrides the root with the
// actual bind-mount source (e.g. ${DATA_DIR}/depot). Same env var is
// respected by the Go bridge at apps/bridge/internal/fsx/fsx.go.
//
// Resolved on every call so tests can override via vi.stubEnv without a
// dynamic module reload; in production the env var is set once at boot by
// docker-compose / the systemd unit, so the extra lookup is free.
function depotHostRoot(): string {
  const v = process.env.PANEL_DEPOT_HOST_PATH;
  return v && v !== '' ? v : `/var/lib/docker/volumes/${DEPOT_VOLUME_NAME}/_data`;
}

function depotMarker(): string {
  return `${depotHostRoot()}/SquadGameServer.sh`;
}

function depotConfigDir(): string {
  return `${depotHostRoot()}/SquadGame/ServerConfig`;
}

interface ProgressLine {
  ts: string;
  step: string;
  stream?: 'stdout' | 'stderr';
  message: string;
}

type Sink = (line: ProgressLine) => void;

async function depotPopulated(app: FastifyInstance): Promise<boolean> {
  try {
    const { content } = await app.bridge.fileRead({ path: depotMarker() });
    return content.length > 0;
  } catch {
    return false;
  }
}

async function ensureDepot(app: FastifyInstance, sink: Sink): Promise<void> {
  if (await depotPopulated(app)) {
    sink({
      ts: new Date().toISOString(),
      step: 'depot',
      message: `depot volume ${DEPOT_VOLUME_NAME} already populated`,
    });
    return;
  }
  sink({
    ts: new Date().toISOString(),
    step: 'depot',
    message: `populating ${DEPOT_VOLUME_NAME} via depot-init container`,
  });
  await app.bridge.depotUpdate((frame) => {
    const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
    sink({
      ts: new Date().toISOString(),
      step: 'depot',
      message: text,
      stream: frame.stream === 'stderr' ? 'stderr' : 'stdout',
    });
  });
}

async function seedConfigs(
  app: FastifyInstance,
  serverId: string,
  displayName: string,
  rconPort: number,
  rconPassword: string,
  sink: Sink,
): Promise<void> {
  const destDir = `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig`;
  sink({ ts: new Date().toISOString(), step: 'configs', message: `seeding ${destDir}` });
  for (const file of ALLOWED_CONFIG_FILES) {
    let content = '';
    try {
      content = (await app.bridge.fileRead({ path: `${depotConfigDir()}/${file}` })).content;
    } catch (err) {
      sink({
        ts: new Date().toISOString(),
        step: 'configs',
        message: `default ${file} not in depot (${(err as Error).message}); creating empty`,
        stream: 'stderr',
      });
    }
    if (file === 'Rcon.cfg') {
      content = rewriteRconCfg(content, { port: rconPort, password: rconPassword });
    } else if (file === 'Server.cfg') {
      content = rewriteServerCfg(content, displayName);
    }
    await app.bridge.fileAtomicWrite({ path: `${destDir}/${file}`, content });
    // Create the initial config_versions row so History / Blame / Diff
    // are meaningful from day one. author_user_id=NULL means "system"
    // (installer, not a logged-in user). Next human PUT becomes v2.
    await app.db.insert(configVersions).values({
      serverId,
      filename: file,
      content,
      sha256: createHash('sha256').update(content).digest(),
      parentVersionId: null,
      authorUserId: null,
      authorIp: null,
      message: `initial install — SteamCMD depot ${file === 'Rcon.cfg' || file === 'Server.cfg' ? '+ panel rewrite' : 'default'}`,
    });
  }
  sink({
    ts: new Date().toISOString(),
    step: 'configs',
    message: `seeded ${ALLOWED_CONFIG_FILES.length} files + initial version baseline (saved/ auto-created by docker on container_run)`,
  });
}

async function runInstall(app: FastifyInstance, serverId: string, sink: Sink): Promise<void> {
  const emit = (step: string, message: string, stream?: 'stdout' | 'stderr') =>
    sink({ ts: new Date().toISOString(), step, message, stream });

  const srv = await app.db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!srv) throw new Error('server_not_found');
  const settings = await app.db.query.serverSettings.findFirst({
    where: eq(serverSettings.serverId, serverId),
  });
  if (!settings) throw new Error('server_settings_missing');
  const creds = await app.db.query.serverCredentials.findFirst({
    where: eq(serverCredentials.serverId, serverId),
  });
  if (!creds) throw new Error('server_credentials_missing');

  await app.db
    .update(servers)
    .set({ status: 'installing', updatedAt: new Date() })
    .where(eq(servers.id, serverId));

  await ensureDepot(app, sink);

  const rconPassword = decryptString(
    app.encryptionKey,
    deserialize(Buffer.from(creds.rconPasswordEncrypted as unknown as Buffer)),
  );
  await seedConfigs(app, serverId, srv.displayName, settings.rconPort, rconPassword, sink);

  emit(
    'ufw',
    `allow udp ${settings.gamePort}, udp ${settings.queryPort}, udp ${settings.beaconPort}, tcp ${settings.rconPort}`,
  );
  for (const [proto, port, comment] of [
    ['udp', settings.gamePort, 'squad-game'],
    ['udp', settings.queryPort, 'squad-query'],
    ['udp', settings.beaconPort, 'squad-beacon'],
    ['tcp', settings.rconPort, 'squad-rcon'],
  ] as const) {
    try {
      const r = await app.bridge.ufwRule({
        action: 'add',
        proto,
        port: port as number,
        comment: `${comment}-${serverId.slice(0, 8)}`,
      });
      emit('ufw', `${proto}/${port} ${r.status}`, 'stdout');
    } catch (err) {
      emit('ufw', `${proto}/${port} skipped: ${(err as Error).message}`, 'stderr');
    }
  }

  emit('container', `docker run --network host --name squad-${serverId} ${SERVER_IMAGE}`);
  const res = await app.bridge.containerRun({
    server_id: serverId,
    image: SERVER_IMAGE,
    game_port: settings.gamePort,
    query_port: settings.queryPort,
    beacon_port: settings.beaconPort,
    rcon_port: settings.rconPort,
    max_players: settings.maxPlayers,
    tickrate: settings.tickrate,
    multihome: settings.multihome,
    configs_host: `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig`,
    saved_host: `${PANEL_SAVED_ROOT}/${serverId}`,
    depot_volume: DEPOT_VOLUME_NAME,
  });
  emit('container', `started ${res.container_id}`);

  await app.bridge.fileAtomicWrite({
    path: `${PANEL_SAVED_ROOT}/${serverId}/SquadGame/Saved/Logs/.keep`,
    content: '',
  });
  emit(
    'rnsquadjs',
    `docker run --network host --name rnsquadjs-${serverId} squad-panel/rnsquadjs:latest`,
  );
  const sidecar = await app.bridge.containerRunRnsquadjs({
    server_id: serverId,
    env: {
      SERVER_ID: serverId,
      API_URL: process.env.RNSQUADJS_API_URL ?? 'http://api:3000',
      LOG_FILE: '/squad/Logs/SquadGame.log',
      PANEL_BRIDGE_MODE: 'production',
      PANEL_BRIDGE_SOCKET: '/run/panelBridge/rcon.sock',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://redis:6379',
    },
  });
  emit('rnsquadjs', `started ${sidecar.container_id}`);

  await app.db
    .update(servers)
    .set({
      status: 'running',
      containerId: res.container_id,
      updatedAt: new Date(),
    })
    .where(eq(servers.id, serverId));
  emit('done', 'install complete; container running');
}

export function rewriteRconCfg(existing: string, opts: { port: number; password: string }): string {
  const lines = existing.split(/\r?\n/);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw;
    const m = /^\s*(Port|Password|IP)\s*=/i.exec(line);
    if (m?.[1]) {
      const key = m[1].toLowerCase();
      seen.add(key);
      if (key === 'port') result.push(`Port=${opts.port}`);
      else if (key === 'password') result.push(`Password=${opts.password}`);
      else if (key === 'ip') result.push(`IP=0.0.0.0`);
    } else {
      result.push(line);
    }
  }
  if (!seen.has('port')) result.push(`Port=${opts.port}`);
  if (!seen.has('password')) result.push(`Password=${opts.password}`);
  if (!seen.has('ip')) result.push(`IP=0.0.0.0`);
  return result.join('\n').replace(/\n+$/, '\n');
}

export function rewriteServerCfg(existing: string, displayName: string): string {
  const lines = existing.split(/\r?\n/);
  const result: string[] = [];
  let seenName = false;
  for (const raw of lines) {
    const m = /^\s*ServerName\s*=/i.exec(raw);
    if (m) {
      seenName = true;
      result.push(`ServerName="${displayName}"`);
    } else {
      result.push(raw);
    }
  }
  if (!seenName) result.push(`ServerName="${displayName}"`);
  return result.join('\n').replace(/\n+$/, '\n');
}

const serverInstallRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.post(
    '/api/v1/servers/:id/install',
    {
      config: {
        permissions: ['server:install'],
        audit: { action: 'server.install.started', resource: 'server' },
      },
      schema: { params: paramsSchema },
    },
    async (req, reply) => {
      const { id } = req.params;
      const srv = await app.db.query.servers.findFirst({ where: eq(servers.id, id) });
      if (!srv) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (srv.status === 'installing') {
        reply.code(409);
        return { error: 'install_in_progress' };
      }
      (async () => {
        try {
          await runInstall(app, id, (line) => {
            app.log.info({ server_id: id, ...line }, 'install progress');
            app.installProgress.publish(id, line);
          });
        } catch (err) {
          app.log.error({ err, server_id: id }, 'install failed');
          app.installProgress.publish(id, {
            ts: new Date().toISOString(),
            step: 'error',
            message: (err as Error).message,
            stream: 'stderr',
          });
          await app.db
            .update(servers)
            .set({ status: 'failed', updatedAt: new Date() })
            .where(eq(servers.id, id));
        }
      })();
      return { status: 'installing', server_id: id };
    },
  );

  fast.get(
    '/api/v1/servers/:id/install/progress',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: paramsSchema },
    },
    async (req) => {
      return { lines: app.installProgress.snapshot(req.params.id) };
    },
  );

  app.get(
    '/api/v1/servers/:id/install/ws',
    {
      websocket: true,
      config: { permissions: ['server:view'], audit: false },
    },
    (socket, req) => {
      const params = (req.params ?? {}) as { id?: string };
      const id = params.id;
      if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
        socket.send(JSON.stringify({ error: 'invalid_id' }));
        socket.close();
        return;
      }
      for (const line of app.installProgress.snapshot(id)) {
        socket.send(JSON.stringify(line));
      }
      const unsubscribe = app.installProgress.subscribe(id, (line) => {
        try {
          socket.send(JSON.stringify(line));
          if (line.step === 'done' || line.step === 'error') {
            socket.send(JSON.stringify({ done: true, final: line.step }));
            socket.close();
          }
        } catch {
          // socket gone
        }
      });
      socket.on('close', () => unsubscribe());
    },
  );
};

export default serverInstallRoutes;
