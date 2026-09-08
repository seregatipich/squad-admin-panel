import { describe, expect, it, vi } from 'vitest';
import type { FsOps, Squadjs2Context, Squadjs2LaunchContext } from '../../src/lib/squadjs2.js';
import {
  buildSquadjs2Env,
  relaunchSquadjs2Sidecar,
  renderSquadjs2Config,
  squadjs2ConfigPath,
  squadjs2ContainerName,
  writeSquadjs2Config,
} from '../../src/lib/squadjs2.js';

const SERVER_ID = 'aaaaaaaa-1111-7abc-8def-0123456789ab';

function makeApp(
  opts: {
    creds?: { serverId: string; rconPort: number } | null;
    settings?: { serverId: string; queryPort: number } | null;
    rconCfgContent?: string;
  } = {},
): Squadjs2Context {
  return {
    db: {
      query: {
        serverCredentials: {
          findFirst: vi.fn(async () =>
            opts.creds === undefined ? { serverId: SERVER_ID, rconPort: 21114 } : opts.creds,
          ),
        },
        serverSettings: {
          findFirst: vi.fn(async () =>
            opts.settings === undefined ? { serverId: SERVER_ID, queryPort: 27165 } : opts.settings,
          ),
        },
      },
    },
    bridge: {
      fileRead: vi.fn(async () => ({ content: opts.rconCfgContent ?? 'Password=s3cret\n' })),
    },
    log: { warn: vi.fn() },
  } as unknown as Squadjs2Context;
}

function makeFsOps(): FsOps {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    chown: vi.fn().mockResolvedValue(undefined),
  } as unknown as FsOps;
}

function makeLaunchApp(
  opts: {
    sismember?: number;
    containerRm?: ReturnType<typeof vi.fn>;
    containerRunSquadjs2?: ReturnType<typeof vi.fn>;
  } = {},
): Squadjs2LaunchContext {
  return {
    ...(makeApp() as unknown as Record<string, unknown>),
    bridge: {
      fileRead: vi.fn(async () => ({ content: 'Password=s3cret\n' })),
      containerRm: opts.containerRm ?? vi.fn().mockResolvedValue({ status: 'ok' }),
      containerRunSquadjs2:
        opts.containerRunSquadjs2 ??
        vi.fn().mockResolvedValue({ container_id: 'cid-1', status: 'started' }),
    },
    redis: { sismember: vi.fn(async () => opts.sismember ?? 0) },
  } as unknown as Squadjs2LaunchContext;
}

describe('squadjs2 naming', () => {
  it('names the container and config path per engine', () => {
    expect(squadjs2ContainerName(SERVER_ID)).toBe(`squadjs2-${SERVER_ID}`);
    expect(squadjs2ConfigPath(SERVER_ID)).toBe(
      `/run/squad-panel/squadjs2/${SERVER_ID}/config.json`,
    );
  });
});

describe('buildSquadjs2Env', () => {
  it('passes exactly the two keys the bridge allowlists', () => {
    expect(buildSquadjs2Env(SERVER_ID)).toEqual({
      SERVER_ID,
      LOG_FILE: '/squad/Logs/SquadGame.log',
    });
  });

  it('never leaks the mode, redis url or socket path through env', () => {
    const env = buildSquadjs2Env(SERVER_ID) as Record<string, string>;
    for (const key of ['PANEL_BRIDGE_MODE', 'PANEL_BRIDGE_SOCKET', 'REDIS_URL']) {
      expect(env[key]).toBeUndefined();
    }
  });
});

describe('renderSquadjs2Config', () => {
  it('renders the SquadJS config the pinned image accepts', async () => {
    const config = await renderSquadjs2Config(makeApp(), SERVER_ID, 'shadow');

    expect(config.server).toEqual({
      id: 1,
      host: '127.0.0.1',
      queryPort: 27165,
      rconPort: 21114,
      rconPassword: 's3cret',
      logReaderMode: 'tail',
      logDir: '/squad/Logs',
      adminLists: [],
    });
    expect(config.connectors).toEqual({});
  });

  it('enables PanelBridge and nothing else', async () => {
    const config = await renderSquadjs2Config(makeApp(), SERVER_ID, 'production');

    expect(config.plugins).toEqual([
      {
        plugin: 'PanelBridge',
        enabled: true,
        mode: 'production',
        redisUrl: expect.stringMatching(/^redis:\/\//),
        serverId: SERVER_ID,
      },
    ]);
  });

  it('always carries logger.colors, which the SquadJS2 factory iterates on boot', async () => {
    const config = await renderSquadjs2Config(makeApp(), SERVER_ID, 'shadow');
    expect(config.logger.colors).toEqual({});
    expect(config.logger.verboseness).toEqual({ SquadServer: 1 });
  });

  it('reads the RCON password from Rcon.cfg, not the database', async () => {
    const app = makeApp({ rconCfgContent: '  Password  =  spaced-out  \nOther=1\n' });
    const config = await renderSquadjs2Config(app, SERVER_ID, 'shadow');
    expect(config.server.rconPassword).toBe('spaced-out');
  });

  it('fails loudly when the server has no credentials', async () => {
    await expect(
      renderSquadjs2Config(makeApp({ creds: null }), SERVER_ID, 'shadow'),
    ).rejects.toThrow(/no credentials/);
  });

  it('fails loudly when the server has no settings row (query port)', async () => {
    await expect(
      renderSquadjs2Config(makeApp({ settings: null }), SERVER_ID, 'shadow'),
    ).rejects.toThrow(/no settings/);
  });

  it('fails loudly when Rcon.cfg has no password', async () => {
    await expect(
      renderSquadjs2Config(makeApp({ rconCfgContent: 'NoPasswordHere=1\n' }), SERVER_ID, 'shadow'),
    ).rejects.toThrow(/cannot parse Password/);
  });
});

describe('writeSquadjs2Config', () => {
  it('writes 0600, chowns to the sidecar uid, then renames atomically', async () => {
    const fs = makeFsOps();
    await writeSquadjs2Config(makeApp(), SERVER_ID, 'shadow', fs);

    expect(fs.mkdir).toHaveBeenCalledWith(`/run/squad-panel/squadjs2/${SERVER_ID}`, {
      recursive: true,
      mode: 0o750,
    });
    const [tmpPath, json, opts] = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tmpPath).toBe(`${squadjs2ConfigPath(SERVER_ID)}.tmp`);
    expect(opts).toEqual({ mode: 0o600 });
    expect(JSON.parse(json).server.rconPassword).toBe('s3cret');
    expect(fs.chown).toHaveBeenCalledWith(tmpPath, 1001, 1001);
    expect(fs.rename).toHaveBeenCalledWith(tmpPath, squadjs2ConfigPath(SERVER_ID));
  });

  it('survives EPERM from chown in a non-root dev environment', async () => {
    const fs = makeFsOps();
    (fs.chown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('EPERM'), { code: 'EPERM' }),
    );
    const app = makeApp();

    await writeSquadjs2Config(app, SERVER_ID, 'shadow', fs);

    expect(fs.rename).toHaveBeenCalled();
    expect(app.log.warn).toHaveBeenCalled();
  });

  it('propagates any other chown failure instead of shipping a config nobody can read', async () => {
    const fs = makeFsOps();
    (fs.chown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('EIO'), { code: 'EIO' }),
    );

    await expect(writeSquadjs2Config(makeApp(), SERVER_ID, 'shadow', fs)).rejects.toThrow('EIO');
    expect(fs.rename).not.toHaveBeenCalled();
  });
});

describe('relaunchSquadjs2Sidecar', () => {
  it('launches in shadow mode for a server outside the cutover set', async () => {
    const app = makeLaunchApp({ sismember: 0 });
    const result = await relaunchSquadjs2Sidecar(app, SERVER_ID, makeFsOps());

    expect(result).toEqual({ containerId: 'cid-1', mode: 'shadow' });
    expect(app.bridge.containerRunSquadjs2).toHaveBeenCalledWith({
      server_id: SERVER_ID,
      env: { SERVER_ID, LOG_FILE: '/squad/Logs/SquadGame.log' },
    });
  });

  it('launches in production mode for a cutover server', async () => {
    const app = makeLaunchApp({ sismember: 1 });
    const fs = makeFsOps();

    const result = await relaunchSquadjs2Sidecar(app, SERVER_ID, fs);

    expect(result.mode).toBe('production');
    const [, json] = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(json).plugins[0].mode).toBe('production');
  });

  it('removes the previous container before launching, tolerating its absence', async () => {
    const containerRm = vi.fn().mockRejectedValue(new Error('no such container'));
    const app = makeLaunchApp({ containerRm });

    await expect(relaunchSquadjs2Sidecar(app, SERVER_ID, makeFsOps())).resolves.toMatchObject({
      containerId: 'cid-1',
    });
    expect(containerRm).toHaveBeenCalledWith({ name: `squadjs2-${SERVER_ID}` });
  });

  it('does not launch when the config cannot be rendered', async () => {
    const app = makeLaunchApp();
    (app.bridge.fileRead as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ content: 'x=1' });

    await expect(relaunchSquadjs2Sidecar(app, SERVER_ID, makeFsOps())).rejects.toThrow(
      /cannot parse Password/,
    );
    expect(app.bridge.containerRunSquadjs2).not.toHaveBeenCalled();
  });
});
