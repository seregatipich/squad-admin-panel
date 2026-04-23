import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { decryptString, deserialize } from '../lib/crypto.js';

const paramsSchema = z.object({ id: z.string().uuid() });

const SQUAD_APP_ID = '403240';
const PREREQ_PACKAGES = ['ca-certificates', 'curl', 'tar'];

interface ProgressLine {
  ts: string;
  step: string;
  stream?: 'stdout' | 'stderr';
  message: string;
}

type Sink = (line: ProgressLine) => void;

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

  const installPath = settings.installPath;
  const unit = `squad-server-${serverId}.service`;
  const unitPath = `/etc/systemd/system/${unit}`;

  await app.db
    .update(servers)
    .set({ status: 'installing', updatedAt: new Date() })
    .where(eq(servers.id, serverId));

  emit('prereqs', `apt_install ${PREREQ_PACKAGES.join(', ')}`);
  const apt = await app.bridge.aptInstall({ packages: PREREQ_PACKAGES });
  emit('prereqs', apt.output, 'stdout');

  emit('steamcmd', `downloading Squad depot ${SQUAD_APP_ID} to ${installPath}`);
  await app.bridge.steamcmdRun(
    {
      args: [
        '+@sSteamCmdForcePlatformType',
        'linux',
        `+force_install_dir ${installPath}/`,
        '+login',
        'anonymous',
        '+app_update',
        SQUAD_APP_ID,
        'validate',
        '+quit',
      ],
    },
    (frame) => {
      const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
      emit('steamcmd', text, frame.stream === 'stderr' ? 'stderr' : 'stdout');
    },
  );

  emit('systemd-unit', `writing ${unitPath}`);
  const envLines: string[] = [];
  if (settings.cpuAffinity) envLines.push(`CPUAffinity=${settings.cpuAffinity}`);
  if (settings.cpuWeight != null) envLines.push(`CPUWeight=${settings.cpuWeight}`);
  if (settings.memoryHighMb != null) envLines.push(`MemoryHigh=${settings.memoryHighMb}M`);
  if (settings.memoryMaxMb != null) envLines.push(`MemoryMax=${settings.memoryMaxMb}M`);
  if (settings.ioWeight != null) envLines.push(`IOWeight=${settings.ioWeight}`);
  if (settings.niceness != null) envLines.push(`Nice=${settings.niceness}`);

  const launchArgs =
    settings.launchArgsOverride ??
    [
      `Port=${settings.gamePort}`,
      `QueryPort=${settings.queryPort}`,
      `BeaconPort=${settings.beaconPort}`,
      `RCONPort=${settings.rconPort}`,
      `FIXEDMAXPLAYERS=${settings.maxPlayers}`,
      `MULTIHOME=${settings.multihome}`,
      'RANDOM=ALWAYS',
      '-log',
      settings.extraArgs,
    ]
      .filter(Boolean)
      .join(' ');

  const unitContent = `[Unit]
Description=Squad dedicated server (${srv.displayName})
Documentation=https://github.com/breaking-squad/squad-admin-panel
After=network.target

[Service]
Type=simple
User=squad
Group=squad
WorkingDirectory=${installPath}
ExecStart=${installPath}/SquadGameServer.sh ${launchArgs}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=60
StandardOutput=journal
StandardError=journal
${envLines.join('\n')}

NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
`;
  await app.bridge.systemctlWriteUnit({ path: unitPath, content: unitContent });
  emit('systemd-unit', 'written');

  await app.bridge.systemctlDaemonReload();
  emit('systemd-unit', 'daemon-reload');

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

  emit('bootstrap-boot', `starting ${unit} to let Squad generate configs`);
  await app.bridge.systemctlAction({ unit, action: 'start' });

  const logPath = `${installPath}/SquadGame/Saved/Logs/SquadGame.log`;
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const { content } = await app.bridge.fileRead({ path: logPath });
      if (
        /LogInit: Engine is initialized|Server is ready for connections|LogNet: Server.+ready/.test(
          content,
        )
      ) {
        ready = true;
        break;
      }
    } catch {
      // log not yet created
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  emit(
    'bootstrap-boot',
    ready
      ? 'initial boot reached ready'
      : 'timed out waiting for ready (continuing; configs may already exist)',
  );

  emit('bootstrap-stop', `stopping ${unit}`);
  try {
    await app.bridge.systemctlAction({ unit, action: 'stop' });
  } catch (err) {
    emit('bootstrap-stop', `stop returned: ${(err as Error).message}`, 'stderr');
  }

  const cfgDir = `${installPath}/SquadGame/ServerConfig`;
  const serverCfgPath = `${cfgDir}/Server.cfg`;
  const rconCfgPath = `${cfgDir}/Rcon.cfg`;

  emit('configure', `reading ${rconCfgPath}`);
  let rconCfg = '';
  try {
    rconCfg = (await app.bridge.fileRead({ path: rconCfgPath })).content;
  } catch (err) {
    emit(
      'configure',
      `Rcon.cfg not found, generating minimal: ${(err as Error).message}`,
      'stderr',
    );
  }
  const rconPassword = decryptString(
    app.encryptionKey,
    deserialize(Buffer.from(creds.rconPasswordEncrypted as unknown as Buffer)),
  );
  const rconContent = rewriteRconCfg(rconCfg, {
    port: settings.rconPort,
    password: rconPassword,
  });
  await app.bridge.fileAtomicWrite({ path: rconCfgPath, content: rconContent });
  emit('configure', 'Rcon.cfg written with panel-generated password');

  emit('configure', `reading ${serverCfgPath}`);
  let serverCfg = '';
  try {
    serverCfg = (await app.bridge.fileRead({ path: serverCfgPath })).content;
  } catch {
    serverCfg = '';
  }
  const serverContent = rewriteServerCfg(serverCfg, srv.displayName);
  await app.bridge.fileAtomicWrite({ path: serverCfgPath, content: serverContent });
  emit('configure', 'Server.cfg written');

  await app.db
    .update(servers)
    .set({ status: 'ready', updatedAt: new Date() })
    .where(eq(servers.id, serverId));
  emit('done', 'install complete; status=ready');
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

  // WebSocket live stream (TZ §17.6). Sends the full historical buffer on
  // connect, then each new ProgressLine as it arrives, then a terminal
  // {done:true} frame once the install reaches "done" or "error".
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
