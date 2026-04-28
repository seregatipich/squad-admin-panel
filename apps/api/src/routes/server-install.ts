import { createHash } from 'node:crypto';
import { configVersions, serverCredentials, serverSettings, servers } from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import {
  ALLOWED_CONFIG_FILES,
  DEPOT_VOLUME_NAME,
  PANEL_CONFIGS_ROOT,
  PANEL_SAVED_ROOT,
  SERVER_IMAGE,
} from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
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
): Promise<{ seededCount: number }> {
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
      authorSteamId64: null,
      authorLabel: 'system',
      authorIp: null,
      message: `initial install — SteamCMD depot ${file === 'Rcon.cfg' || file === 'Server.cfg' ? '+ panel rewrite' : 'default'}`,
    });
  }
  sink({
    ts: new Date().toISOString(),
    step: 'configs',
    message: `seeded ${ALLOWED_CONFIG_FILES.length} files + initial version baseline (saved/ auto-created by docker on container_run)`,
  });
  return { seededCount: ALLOWED_CONFIG_FILES.length };
}

interface InstallEmitContext {
  diag: Diag;
  actorSteamId64: string | undefined;
}

async function runInstall(
  app: FastifyInstance,
  serverId: string,
  sink: Sink,
  emitCtx: InstallEmitContext,
): Promise<void> {
  const emit = (step: string, message: string, stream?: 'stdout' | 'stderr') =>
    sink({ ts: new Date().toISOString(), step, message, stream });

  const srv = await app.db.query.servers.findFirst({
    where: and(eq(servers.id, serverId), isNull(servers.deletedAt)),
  });
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
  const seedT0 = Date.now();
  const { seededCount } = await seedConfigs(
    app,
    serverId,
    srv.displayName,
    settings.rconPort,
    rconPassword,
    sink,
  );
  await emitCtx.diag.emit({
    component: 'api',
    kind: 'server.install.depot_seed',
    severity: 'info',
    serverId,
    actorSteamId64: emitCtx.actorSteamId64,
    message: `seeded ${seededCount} cfg files`,
    payload: { seededCount, durationMs: Date.now() - seedT0 },
  });

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
    const ufwT0 = Date.now();
    try {
      const r = await app.bridge.ufwRule({
        action: 'add',
        proto,
        port: port as number,
        comment: `${comment}-${serverId.slice(0, 8)}`,
      });
      emit('ufw', `${proto}/${port} ${r.status}`, 'stdout');
      await emitCtx.diag.emit({
        component: 'api',
        kind: 'server.install.ufw_rule',
        severity: 'info',
        serverId,
        actorSteamId64: emitCtx.actorSteamId64,
        message: `${proto}/${port} ${r.status}`,
        payload: { proto, port, status: r.status, durationMs: Date.now() - ufwT0 },
      });
    } catch (err) {
      const errorMessage = (err as Error).message;
      emit('ufw', `${proto}/${port} skipped: ${errorMessage}`, 'stderr');
      await emitCtx.diag.emit({
        component: 'api',
        kind: 'server.install.ufw_rule',
        severity: 'error',
        serverId,
        actorSteamId64: emitCtx.actorSteamId64,
        message: `${proto}/${port} failed: ${errorMessage}`,
        payload: { proto, port, errorMessage, durationMs: Date.now() - ufwT0 },
      });
    }
  }

  emit('container', `docker run --network host --name squad-${serverId} ${SERVER_IMAGE}`);
  const containerT0 = Date.now();
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
  await emitCtx.diag.emit({
    component: 'api',
    kind: 'server.install.container_run',
    severity: 'info',
    serverId,
    actorSteamId64: emitCtx.actorSteamId64,
    message: `container started ${res.container_id}`,
    payload: {
      container_id: res.container_id,
      image: SERVER_IMAGE,
      durationMs: Date.now() - containerT0,
    },
  });

  await app.db
    .update(servers)
    .set({
      status: 'running',
      containerId: res.container_id,
      updatedAt: new Date(),
    })
    .where(eq(servers.id, serverId));
  await emitCtx.diag.emit({
    component: 'api',
    kind: 'server.install.verify',
    severity: 'info',
    serverId,
    actorSteamId64: emitCtx.actorSteamId64,
    message: 'server row marked running',
    payload: { container_id: res.container_id },
  });
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
      const srv = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, id), isNull(servers.deletedAt)),
      });
      if (!srv) {
        reply.code(404);
        return { error: 'not_found' };
      }
      if (srv.status === 'installing') {
        reply.code(409);
        return { error: 'install_in_progress' };
      }
      const actor = req.user
        ? { kind: 'steam' as const, steamId64: req.user.steamId64, tokenId: null }
        : { kind: 'system' as const, label: 'http-anonymous' };
      const actorIp = req.ip ?? null;
      const actorSteamId64 = req.user?.steamId64?.toString();
      const requestId = req.requestId;
      const installDiag: Diag = {
        emit: (ev) => app.diag.emit({ ...ev, requestId: ev.requestId ?? requestId }),
      };
      await installDiag.emit({
        component: 'api',
        kind: 'server.install.requested',
        severity: 'info',
        serverId: id,
        actorSteamId64,
        message: 'install requested',
        payload: { display_name: srv.displayName, kind: 'install' },
      });
      (async () => {
        const startedAt = Date.now();
        try {
          await runInstall(
            app,
            id,
            (line) => {
              app.log.info({ server_id: id, ...line }, 'install progress');
              app.installProgress.publish(id, line);
            },
            { diag: installDiag, actorSteamId64 },
          );
          await writeAuditEntry(app.db, {
            actor,
            actorIp,
            actionType: 'server.install.completed',
            targetType: 'server',
            targetId: id,
            context: { durationMs: Date.now() - startedAt },
            statusCode: 200,
            durationMs: Date.now() - startedAt,
          });
          await installDiag.emit({
            component: 'api',
            kind: 'server.install.done',
            severity: 'info',
            serverId: id,
            actorSteamId64,
            message: 'install complete',
            payload: { totalDurationMs: Date.now() - startedAt },
          });
        } catch (err) {
          const errorMessage = (err as Error).message;
          app.log.error({ err, server_id: id }, 'install failed');
          app.installProgress.publish(id, {
            ts: new Date().toISOString(),
            step: 'error',
            message: errorMessage,
            stream: 'stderr',
          });
          await app.db
            .update(servers)
            .set({ status: 'failed', updatedAt: new Date() })
            .where(eq(servers.id, id));
          await writeAuditEntry(app.db, {
            actor,
            actorIp,
            actionType: 'server.install.failed',
            targetType: 'server',
            targetId: id,
            context: { error: errorMessage, durationMs: Date.now() - startedAt },
            statusCode: 500,
            durationMs: Date.now() - startedAt,
          });
          await installDiag.emit({
            component: 'api',
            kind: 'server.install.failed',
            severity: 'error',
            serverId: id,
            actorSteamId64,
            message: `install failed: ${errorMessage}`,
            payload: {
              stage: 'runInstall',
              errorMessage,
              totalDurationMs: Date.now() - startedAt,
            },
          });
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
