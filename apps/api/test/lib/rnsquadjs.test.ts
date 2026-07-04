import { describe, expect, it, vi } from 'vitest';
import type { FsOps, RnsquadjsContext, SidecarLaunchContext } from '../../src/lib/rnsquadjs.js';
import {
  buildSidecarEnv,
  relaunchSidecar,
  renderRnsquadjsConfig,
  sidecarConfigPath,
  sidecarContainerName,
  sidecarSocketPath,
  writeSidecarConfig,
} from '../../src/lib/rnsquadjs.js';

const SERVER_ID = 'aaaaaaaa-1111-7abc-8def-0123456789ab';

function makeApp(opts: {
  creds?: { serverId: string; rconPort: number } | null;
  rconCfgContent?: string;
}): RnsquadjsContext {
  return {
    db: {
      query: {
        serverCredentials: {
          findFirst: vi.fn(async () => opts.creds ?? null),
        },
      },
    },
    bridge: {
      fileRead: vi.fn(async () => ({
        content: opts.rconCfgContent ?? 'Password=s3cret\n',
      })),
    },
    log: { warn: vi.fn() },
  } as unknown as RnsquadjsContext;
}

function makeFsOps(): FsOps {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    chown: vi.fn().mockResolvedValue(undefined),
  } as unknown as FsOps;
}

function makeLaunchApp(opts: {
  sismember?: number;
  containerRm?: ReturnType<typeof vi.fn>;
  containerRunRnsquadjs?: ReturnType<typeof vi.fn>;
}): SidecarLaunchContext {
  return {
    db: {
      query: {
        serverCredentials: {
          findFirst: vi.fn(async () => ({ serverId: SERVER_ID, rconPort: 21114 })),
        },
      },
    },
    bridge: {
      fileRead: vi.fn(async () => ({ content: 'Password=s3cret\n' })),
      containerRm: opts.containerRm ?? vi.fn().mockResolvedValue({ status: 'ok' }),
      containerRunRnsquadjs:
        opts.containerRunRnsquadjs ??
        vi.fn().mockResolvedValue({ container_id: 'rnsquadjs-new', status: 'started' }),
    },
    redis: { sismember: vi.fn(async () => opts.sismember ?? 0) },
    log: { warn: vi.fn() },
  } as unknown as SidecarLaunchContext;
}

describe('sidecarConfigPath', () => {
  it('returns the per-server config.json path under the sidecar root', () => {
    expect(sidecarConfigPath(SERVER_ID)).toBe(
      `/run/squad-panel/rnsquadjs/${SERVER_ID}/config.json`,
    );
  });
});

describe('sidecarSocketPath', () => {
  it('returns the per-server rcon.sock path under the sidecar root', () => {
    expect(sidecarSocketPath(SERVER_ID)).toBe(
      `/run/squad-panel/rnsquadjs/${SERVER_ID}/sock/rcon.sock`,
    );
  });
});

describe('sidecarContainerName', () => {
  it('returns the rnsquadjs- prefixed container name', () => {
    expect(sidecarContainerName(SERVER_ID)).toBe(`rnsquadjs-${SERVER_ID}`);
  });
});

describe('buildSidecarEnv', () => {
  it('returns exactly the bridge-allowed env keys with defaults', () => {
    const env = buildSidecarEnv(SERVER_ID, 'shadow', undefined);
    expect(env).toEqual({
      SERVER_ID,
      LOG_FILE: '/squad/Logs/SquadGame.log',
      PANEL_BRIDGE_MODE: 'shadow',
      PANEL_BRIDGE_SOCKET: '/run/panelBridge/rcon.sock',
      REDIS_URL: 'redis://127.0.0.1:6379',
    });
  });

  it('has no extra keys (bridge allowlist would reject them)', () => {
    const env = buildSidecarEnv(SERVER_ID, 'shadow', undefined);
    expect(Object.keys(env).sort()).toEqual([
      'LOG_FILE',
      'PANEL_BRIDGE_MODE',
      'PANEL_BRIDGE_SOCKET',
      'REDIS_URL',
      'SERVER_ID',
    ]);
  });

  it('passes custom mode and redis url through', () => {
    const env = buildSidecarEnv(SERVER_ID, 'production', 'redis://127.0.0.1:6380/2');
    expect(env.PANEL_BRIDGE_MODE).toBe('production');
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:6380/2');
  });
});

describe('renderRnsquadjsConfig', () => {
  it('returns the upstream JSON shape with correct values', async () => {
    const app = makeApp({ creds: { serverId: SERVER_ID, rconPort: 21114 } });
    const config = await renderRnsquadjsConfig(app, SERVER_ID);

    const entry = config[SERVER_ID];
    expect(entry).toBeDefined();
    expect(entry?.id).toBe(SERVER_ID);
    expect(entry?.host).toBe('127.0.0.1');
    expect(entry?.port).toBe(21114);
    expect(entry?.password).toBe('s3cret');
    expect(entry?.logFilePath).toBe('/squad/Logs/SquadGame.log');
    expect(entry?.adminsFilePath).toBe('/squad/SquadGame/ServerConfig/Admins.cfg');
    expect(entry?.mapsName).toBe('vanilla.json');
    expect(entry?.mapsRegExp).toBe('');
    expect(entry?.plugins).toEqual([{ name: 'panelBridge', enabled: true, options: {} }]);
  });

  it('plugins is an array (absent-from-array = disabled upstream contract)', async () => {
    const app = makeApp({ creds: { serverId: SERVER_ID, rconPort: 21114 } });
    const config = await renderRnsquadjsConfig(app, SERVER_ID);
    expect(Array.isArray(config[SERVER_ID]?.plugins)).toBe(true);
  });

  it('throws when the credentials row is missing', async () => {
    const app = makeApp({ creds: null });
    await expect(renderRnsquadjsConfig(app, SERVER_ID)).rejects.toThrow(/credentials/i);
  });

  it('parses password from a multi-line Rcon.cfg with surrounding settings', async () => {
    const multiLine = '[Rcon]\nPort=21114\nPassword=my-p4ss\nEnabled=True\n';
    const app = makeApp({
      creds: { serverId: SERVER_ID, rconPort: 21114 },
      rconCfgContent: multiLine,
    });
    const config = await renderRnsquadjsConfig(app, SERVER_ID);
    expect(config[SERVER_ID]?.password).toBe('my-p4ss');
  });
});

describe('writeSidecarConfig', () => {
  it('calls fs ops in the correct sequence: mkdir → writeFile → chown → rename', async () => {
    const app = makeApp({ creds: { serverId: SERVER_ID, rconPort: 21114 } });
    const ops = makeFsOps();
    const sequence: string[] = [];
    (ops.mkdir as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sequence.push('mkdir');
    });
    (ops.writeFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sequence.push('writeFile');
    });
    (ops.chown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sequence.push('chown');
    });
    (ops.rename as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sequence.push('rename');
    });

    await writeSidecarConfig(app, SERVER_ID, ops);
    expect(sequence).toEqual(['mkdir', 'writeFile', 'chown', 'rename']);
  });

  it('calls mkdir with recursive:true and mode 0o755', async () => {
    const app = makeApp({ creds: { serverId: SERVER_ID, rconPort: 21114 } });
    const ops = makeFsOps();
    await writeSidecarConfig(app, SERVER_ID, ops);

    expect(ops.mkdir).toHaveBeenCalledWith(`/run/squad-panel/rnsquadjs/${SERVER_ID}`, {
      recursive: true,
      mode: 0o755,
    });
  });

  it('writes to tmp path with mode 0o600 and renames to the final path', async () => {
    const app = makeApp({ creds: { serverId: SERVER_ID, rconPort: 21114 } });
    const ops = makeFsOps();
    await writeSidecarConfig(app, SERVER_ID, ops);

    const finalPath = `/run/squad-panel/rnsquadjs/${SERVER_ID}/config.json`;
    const tmpPath = `${finalPath}.tmp`;
    expect(ops.writeFile).toHaveBeenCalledWith(tmpPath, expect.any(String), { mode: 0o600 });
    expect(ops.rename).toHaveBeenCalledWith(tmpPath, finalPath);
  });

  it('chowns the tmp file to uid 1001 gid 1001 before rename', async () => {
    const app = makeApp({ creds: { serverId: SERVER_ID, rconPort: 21114 } });
    const ops = makeFsOps();
    await writeSidecarConfig(app, SERVER_ID, ops);

    const tmpPath = `/run/squad-panel/rnsquadjs/${SERVER_ID}/config.json.tmp`;
    expect(ops.chown).toHaveBeenCalledWith(tmpPath, 1001, 1001);
  });

  it('written JSON parses back to the rendered config', async () => {
    const app = makeApp({
      creds: { serverId: SERVER_ID, rconPort: 21114 },
      rconCfgContent: 'Password=s3cret\n',
    });
    let writtenJson = '';
    const ops = makeFsOps();
    (ops.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
      async (_path: string, data: string) => {
        writtenJson = data;
      },
    );

    await writeSidecarConfig(app, SERVER_ID, ops);

    const parsed = JSON.parse(writtenJson) as Record<string, unknown>;
    const entry = parsed[SERVER_ID] as Record<string, unknown> | undefined;
    expect(entry).toBeDefined();
    expect(entry?.port).toBe(21114);
    expect(entry?.password).toBe('s3cret');
  });

  it('tolerates EPERM on chown and still renames', async () => {
    const app = makeApp({ creds: { serverId: SERVER_ID, rconPort: 21114 } });
    const ops = makeFsOps();
    const epermError = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    (ops.chown as ReturnType<typeof vi.fn>).mockRejectedValue(epermError);

    await writeSidecarConfig(app, SERVER_ID, ops);

    expect(ops.rename).toHaveBeenCalled();
    expect((app.log.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it('propagates non-EPERM chown errors and skips rename', async () => {
    const app = makeApp({ creds: { serverId: SERVER_ID, rconPort: 21114 } });
    const ops = makeFsOps();
    const eaccessError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    (ops.chown as ReturnType<typeof vi.fn>).mockRejectedValue(eaccessError);

    await expect(writeSidecarConfig(app, SERVER_ID, ops)).rejects.toThrow('Permission denied');
    expect(ops.rename).not.toHaveBeenCalled();
  });
});

describe('relaunchSidecar', () => {
  it('launches in shadow mode when the server is not in the cutover set', async () => {
    const app = makeLaunchApp({ sismember: 0 });
    const result = await relaunchSidecar(app, SERVER_ID, makeFsOps());

    expect(result).toEqual({ containerId: 'rnsquadjs-new', mode: 'shadow' });
    const runArg = (app.bridge.containerRunRnsquadjs as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { server_id: string; env: Record<string, string> };
    expect(runArg.server_id).toBe(SERVER_ID);
    expect(runArg.env.PANEL_BRIDGE_MODE).toBe('shadow');
  });

  it('launches in production mode when the server is in the cutover set', async () => {
    const app = makeLaunchApp({ sismember: 1 });
    const result = await relaunchSidecar(app, SERVER_ID, makeFsOps());

    expect(result.mode).toBe('production');
    const runArg = (app.bridge.containerRunRnsquadjs as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { env: Record<string, string> };
    expect(runArg.env.PANEL_BRIDGE_MODE).toBe('production');
  });

  it('removes the existing sidecar before running the new one (recreate)', async () => {
    const containerRm = vi.fn().mockResolvedValue({ status: 'ok' });
    const containerRunRnsquadjs = vi
      .fn()
      .mockResolvedValue({ container_id: 'rnsquadjs-new', status: 'started' });
    const app = makeLaunchApp({ containerRm, containerRunRnsquadjs });

    await relaunchSidecar(app, SERVER_ID, makeFsOps());

    expect(containerRm).toHaveBeenCalledWith({ name: `rnsquadjs-${SERVER_ID}` });
    const rmOrder = containerRm.mock.invocationCallOrder[0]!;
    const runOrder = containerRunRnsquadjs.mock.invocationCallOrder[0]!;
    expect(rmOrder).toBeLessThan(runOrder);
  });

  it('swallows a containerRm failure (old sidecar may not exist) and still runs', async () => {
    const containerRm = vi.fn().mockRejectedValue(new Error('No such container'));
    const containerRunRnsquadjs = vi
      .fn()
      .mockResolvedValue({ container_id: 'rnsquadjs-new', status: 'started' });
    const app = makeLaunchApp({ containerRm, containerRunRnsquadjs });

    const result = await relaunchSidecar(app, SERVER_ID, makeFsOps());
    expect(result.containerId).toBe('rnsquadjs-new');
    expect(containerRunRnsquadjs).toHaveBeenCalledTimes(1);
  });

  it('writes the sidecar config before launching', async () => {
    const app = makeLaunchApp({ sismember: 0 });
    const ops = makeFsOps();
    await relaunchSidecar(app, SERVER_ID, ops);
    expect(ops.rename).toHaveBeenCalledWith(
      `/run/squad-panel/rnsquadjs/${SERVER_ID}/config.json.tmp`,
      `/run/squad-panel/rnsquadjs/${SERVER_ID}/config.json`,
    );
  });
});
