import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportBundle } from '../src/lib/log-export.js';

// The per-container log tail waits on a real 1.5 s deadline because a follow
// stream never ends on its own; fake timers let the deadline fire instantly.
// Date stays real so the header timestamp and the 24h metrics window do too.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function makeFakeApp(
  overrides: {
    xrangeByStream?: Record<string, Array<Array<[string, string[]]>>>;
    auditRows?: Array<Record<string, unknown>>;
    containerLogsText?: string;
    bridgeClientError?: Error;
  } = {},
) {
  const callsByStream = new Map<string, number>();

  return {
    redis: {
      xrange: vi.fn(async (stream: string) => {
        const streamResults = overrides.xrangeByStream?.[stream];
        if (!streamResults) return [];
        const idx = callsByStream.get(stream) ?? 0;
        callsByStream.set(stream, idx + 1);
        return streamResults[idx] ?? [];
      }),
    },
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(overrides.auditRows ?? []),
            }),
          }),
        }),
      }),
    },
    makeBridgeClient: vi.fn(() => {
      if (overrides.bridgeClientError) throw overrides.bridgeClientError;
      // Like the real bridge, a follow stream stays open until its client closes.
      let endFollow: () => void = () => undefined;
      const followEnded = new Promise<void>((resolve) => {
        endFollow = resolve;
      });
      return {
        containerLogsFollow: vi.fn(
          async (_opts: unknown, cb: (frame: { stream: string; data: string }) => void) => {
            if (overrides.containerLogsText) {
              cb({ stream: 'stdout', data: overrides.containerLogsText });
            }
            await followEnded;
          },
        ),
        close: vi.fn(async () => {
          endFollow();
        }),
      };
    }),
  };
}

// Drains the bundle while advancing the fake clock through every tail deadline
// the export schedules; all other awaits in the export are microtasks.
async function collectGenerator(gen: AsyncGenerator<string>): Promise<string> {
  const parts: string[] = [];
  const drained = (async () => {
    for await (const chunk of gen) {
      parts.push(chunk);
    }
  })();
  await vi.runAllTimersAsync();
  await drained;
  return parts.join('');
}

describe('exportBundle', () => {
  it('emits header section with timestamp', async () => {
    const app = makeFakeApp();
    const output = await collectGenerator(exportBundle(app as never, []));
    expect(output).toContain('===== EXPORT panel-logs');
    expect(output).toContain('===== BRIDGE =====');
  });

  it('emits sections for each server (RCON + LOG-INGEST + SQUAD GAME LOGS)', async () => {
    const servers = [
      { id: 'srv-1', display_name: 'Server Alpha' },
      { id: 'srv-2', display_name: 'Server Beta' },
    ];
    const app = makeFakeApp();
    const output = await collectGenerator(exportBundle(app as never, servers));
    expect(output).toContain('RCON server "Server Alpha" (srv-1)');
    expect(output).toContain('RCON server "Server Beta" (srv-2)');
    expect(output).toContain('LOG-INGEST server "Server Alpha" (srv-1)');
    expect(output).toContain('LOG-INGEST server "Server Beta" (srv-2)');
    expect(output).toContain('SQUAD GAME LOGS server "Server Alpha" (srv-1)');
    expect(output).toContain('SQUAD GAME LOGS server "Server Beta" (srv-2)');
  });

  it('emits WORKERS, DEPOT / INSTALL, and API sections', async () => {
    const app = makeFakeApp();
    const output = await collectGenerator(exportBundle(app as never, []));
    expect(output).toContain('===== WORKERS =====');
    expect(output).toContain('===== DEPOT / INSTALL =====');
    expect(output).toContain('===== API =====');
  });

  it('emits HOST METRICS 24h CSV header', async () => {
    const app = makeFakeApp();
    const output = await collectGenerator(exportBundle(app as never, []));
    expect(output).toContain('===== HOST METRICS 24h (CSV) =====');
    expect(output).toContain('ts_iso,cpu_pct,ram_used,disk_used,rx_bps,tx_bps,la1,la5,la15');
  });

  it('formats log entries from redis xrange with correct ISO timestamps', async () => {
    const ts = '1714838400000';
    const app = makeFakeApp({
      xrangeByStream: {
        'panel:logs': [[[`${ts}-0`, ['s', 'B', 'l', 'I', 'm', 'bridge connected']]], []],
      },
    });
    const output = await collectGenerator(exportBundle(app as never, []));
    expect(output).toContain('2024-05-04');
    expect(output).toContain('INF');
    expect(output).toContain('[bridge]');
    expect(output).toContain('bridge connected');
  });

  it('includes audit log rows in the AUDIT section', async () => {
    const auditRows = [
      {
        id: 1n,
        createdAt: new Date('2026-05-04T10:00:00Z'),
        actorKind: 'user',
        actionType: 'server.create',
        targetType: 'server',
        targetId: 'srv-1',
        statusCode: 201,
      },
    ];
    const app = makeFakeApp({ auditRows });
    const output = await collectGenerator(exportBundle(app as never, []));
    expect(output).toContain('===== AUDIT (last 24h) =====');
    expect(output).toContain('user server.create server/srv-1 201');
  });

  it('tails a game server container until the deadline, then closes its bridge client', async () => {
    const servers = [{ id: 'srv-1', display_name: 'Server Alpha' }];
    const app = makeFakeApp({ containerLogsText: 'LogSquad: match started\n' });

    const output = await collectGenerator(exportBundle(app as never, servers));

    const section = output.indexOf('SQUAD GAME LOGS server "Server Alpha" (srv-1)');
    expect(section).toBeGreaterThanOrEqual(0);
    expect(output.indexOf('LogSquad: match started\n')).toBeGreaterThan(section);
    const client = app.makeBridgeClient.mock.results[0]?.value;
    expect(client.containerLogsFollow).toHaveBeenCalledWith(
      { name: 'squad-srv-1', tail: 5000 },
      expect.any(Function),
    );
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('handles bridge client creation error gracefully', async () => {
    const servers = [{ id: 'srv-err', display_name: 'Broken' }];
    const app = makeFakeApp({ bridgeClientError: new Error('socket unavailable') });
    const output = await collectGenerator(exportBundle(app as never, servers));
    expect(output).toContain('[squad-srv-err: socket unavailable]');
  });

  it('formats host metrics CSV rows from packed arrays', async () => {
    const ts = String(Date.now() - 1000);
    const packed = JSON.stringify([5000, 1073741824, 53687091200, 1000, 2000, 150, 120, 110]);
    const app = makeFakeApp({
      xrangeByStream: {
        'host:metrics': [[[`${ts}-0`, ['v', packed]]]],
      },
    });
    const output = await collectGenerator(exportBundle(app as never, []));
    expect(output).toContain('50.00');
    expect(output).toContain('1073741824');
  });
});
