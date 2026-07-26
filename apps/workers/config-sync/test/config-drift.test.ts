// CFG-2 (#64): generic per-file drift sweep for the non-managed config files.
// The sweep only ever publishes status to Redis — it never writes a file
// (detect, don't auto-correct — same convention as the Admins.cfg sweep).
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CONFIG_DRIFT_STATUS_KEY_PREFIX,
  CONFIG_DRIFT_STATUS_TTL_SECONDS,
  CONFIG_DRIFT_SWEEP_FILES,
  type ConfigDriftStatus,
  sweepServerConfigDrift,
} from '../src/config-drift.js';

const SERVER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function sha256hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function makeRedis() {
  const store = new Map<string, string>();
  const setCalls: unknown[][] = [];
  const redis = {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, val: string, ...rest: unknown[]) => {
      store.set(key, val);
      setCalls.push([key, val, ...rest]);
      return Promise.resolve('OK');
    }),
  } as never;
  return { redis, store, setCalls };
}

/** Fake DB whose `execute` returns the DISTINCT ON tip rows for the server. */
function makeDb(tips: Array<{ filename: string; id: string; sha: string | null }>) {
  return { execute: vi.fn().mockResolvedValue(tips) } as never;
}

/** Fake bridge serving per-file contents; `Error` simulates a read failure. */
function makeBridge(diskByName: Record<string, string | Error>) {
  const fileRead = vi.fn().mockImplementation(({ path }: { path: string }) => {
    const name = path.split('/').at(-1) ?? '';
    const entry = diskByName[name];
    if (entry === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));
    }
    if (entry instanceof Error) return Promise.reject(entry);
    return Promise.resolve({ content: entry });
  });
  return { fileRead, fileAtomicWrite: vi.fn() } as never;
}

describe('sweepServerConfigDrift (CFG-2 #64)', () => {
  it('publishes in_sync/drift/missing/unreachable per file', async () => {
    const inSyncContent = 'ServerName="A"\r\n';
    const panelMotd = 'panel text\r\n';
    const { redis, store, setCalls } = makeRedis();
    const db = makeDb([
      { filename: 'Server.cfg', id: 'v-server', sha: sha256hex(inSyncContent) },
      { filename: 'MOTD.cfg', id: 'v-motd', sha: sha256hex(panelMotd) },
      { filename: 'Bans.cfg', id: 'v-bans', sha: sha256hex('bans') },
      { filename: 'Rcon.cfg', id: 'v-rcon', sha: sha256hex('rcon') },
    ]);
    const bridge = makeBridge({
      'Server.cfg': inSyncContent,
      'MOTD.cfg': 'ssh edit\r\n',
      // Bans.cfg absent → ENOENT → missing
      'Rcon.cfg': new Error('bridge timeout'),
    });
    const log = makeLogger();

    const result = await sweepServerConfigDrift({ db, redis, bridge, log }, SERVER_ID);

    expect(result.files['Server.cfg']?.state).toBe('in_sync');
    expect(result.files['Server.cfg']?.disk_sha256).toBe(sha256hex(inSyncContent));
    expect(result.files['Server.cfg']?.tip_version_id).toBe('v-server');
    expect(result.files['MOTD.cfg']?.state).toBe('drift');
    expect(result.files['MOTD.cfg']?.disk_sha256).toBe(sha256hex('ssh edit\r\n'));
    expect(result.files['MOTD.cfg']?.version_sha256).toBe(sha256hex(panelMotd));
    expect(result.files['Bans.cfg']?.state).toBe('missing');
    expect(result.files['Bans.cfg']?.disk_sha256).toBeNull();
    expect(result.files['Rcon.cfg']?.state).toBe('unreachable');
    // never versioned → no baseline to compare against
    expect(result.files['VoteConfig.cfg']?.state).toBe('unknown');
    expect(result.files['VoteConfig.cfg']?.version_sha256).toBeNull();

    // published to Redis with the 24h TTL
    const raw = store.get(`${CONFIG_DRIFT_STATUS_KEY_PREFIX}${SERVER_ID}`);
    expect(raw).toBeDefined();
    const published = JSON.parse(raw ?? '{}') as ConfigDriftStatus;
    expect(typeof published.checked_at).toBe('string');
    expect(published.files['MOTD.cfg']?.state).toBe('drift');
    const setCall = setCalls.find((c) => c[0] === `${CONFIG_DRIFT_STATUS_KEY_PREFIX}${SERVER_ID}`);
    expect(setCall?.[2]).toBe('EX');
    expect(setCall?.[3]).toBe(CONFIG_DRIFT_STATUS_TTL_SECONDS);

    // detect, never auto-correct: the sweep must not write any file
    expect(
      (bridge as { fileAtomicWrite: ReturnType<typeof vi.fn> }).fileAtomicWrite,
    ).not.toHaveBeenCalled();
  });

  it('skips excluded files', async () => {
    const { redis } = makeRedis();
    const db = makeDb([]);
    const bridge = makeBridge({});
    const log = makeLogger();

    const result = await sweepServerConfigDrift({ db, redis, bridge, log }, SERVER_ID);

    // 19-file allowlist minus Admins.cfg, LayerRotation.cfg, License.cfg
    expect(CONFIG_DRIFT_SWEEP_FILES).toHaveLength(16);
    expect(Object.keys(result.files)).toHaveLength(16);
    expect(result.files['Admins.cfg']).toBeUndefined();
    expect(result.files['LayerRotation.cfg']).toBeUndefined();
    expect(result.files['License.cfg']).toBeUndefined();
    const readPaths = (bridge as { fileRead: ReturnType<typeof vi.fn> }).fileRead.mock.calls.map(
      (c) => (c[0] as { path: string }).path,
    );
    for (const excluded of ['Admins.cfg', 'LayerRotation.cfg', 'License.cfg']) {
      expect(readPaths.some((p) => p.endsWith(`/${excluded}`))).toBe(false);
    }
  });
});
