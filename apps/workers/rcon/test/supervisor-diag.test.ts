import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Diag, DiagEvent } from '@squad/diag';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodePacket,
  RconPacketStream,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_RESPONSE_VALUE,
} from '../src/protocol.js';
import { RconSupervisor, type Target } from '../src/supervisor.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function makeRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    publish: vi.fn().mockResolvedValue(0),
    xadd: vi.fn().mockResolvedValue('0-0'),
  } as never;
}

function makeDb() {
  return {} as never;
}

function makeDiag(): Diag & { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn().mockResolvedValue(undefined) };
}

const targetA: Target = {
  serverId: 'srv-aaa',
  host: '127.0.0.1',
  port: 29100,
  password: 'pw',
};

const targetB: Target = {
  serverId: 'srv-bbb',
  host: '127.0.0.1',
  port: 29101,
  password: 'pw',
};

function fakeRconServer(opts: { acceptAuth: boolean }): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      const stream = new RconPacketStream();
      sock.on('data', (chunk) => {
        const packets = stream.push(chunk);
        for (const p of packets) {
          if (p.type === SERVERDATA_AUTH) {
            const replyId = opts.acceptAuth ? p.id : -1;
            sock.write(encodePacket({ id: p.id, type: SERVERDATA_RESPONSE_VALUE, body: '' }));
            sock.write(encodePacket({ id: replyId, type: SERVERDATA_AUTH_RESPONSE, body: '' }));
          }
        }
      });
      sock.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

describe('RconSupervisor diag emits', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits rcon.targets.changed on net delta with added/removed/total payload', async () => {
    const diag = makeDiag();
    const supervisor = new RconSupervisor({
      db: makeDb(),
      redis: makeRedis(),
      log: makeLogger(),
      diag,
    });

    await supervisor.reconcile([targetA]);
    expect(diag.emit).toHaveBeenCalledTimes(1);
    const firstCall = diag.emit.mock.calls[0]?.[0] as DiagEvent;
    expect(firstCall.kind).toBe('rcon.targets.changed');
    expect(firstCall.component).toBe('worker-rcon');
    expect(firstCall.severity).toBe('info');
    expect(firstCall.payload).toMatchObject({
      added: ['srv-aaa'],
      removed: [],
      total: 1,
    });

    await supervisor.reconcile([targetA, targetB]);
    expect(diag.emit).toHaveBeenCalledTimes(2);
    const secondCall = diag.emit.mock.calls[1]?.[0] as DiagEvent;
    expect(secondCall.payload).toMatchObject({
      added: ['srv-bbb'],
      removed: [],
      total: 2,
    });

    await supervisor.reconcile([targetB]);
    expect(diag.emit).toHaveBeenCalledTimes(3);
    const thirdCall = diag.emit.mock.calls[2]?.[0] as DiagEvent;
    expect(thirdCall.payload).toMatchObject({
      added: [],
      removed: ['srv-aaa'],
      total: 1,
    });

    await supervisor.stop();
  });

  it('does not emit rcon.targets.changed when the polling set is unchanged', async () => {
    const diag = makeDiag();
    const supervisor = new RconSupervisor({
      db: makeDb(),
      redis: makeRedis(),
      log: makeLogger(),
      diag,
    });

    await supervisor.reconcile([targetA]);
    expect(diag.emit).toHaveBeenCalledTimes(1);

    await supervisor.reconcile([targetA]);
    await supervisor.reconcile([targetA]);
    expect(diag.emit).toHaveBeenCalledTimes(1);

    await supervisor.stop();
  });

  it('omits diag emits entirely when no diag is provided', async () => {
    const supervisor = new RconSupervisor({
      db: makeDb(),
      redis: makeRedis(),
      log: makeLogger(),
    });
    await supervisor.reconcile([targetA]);
    await supervisor.reconcile([]);
    await supervisor.stop();
  });
});

describe('RconSupervisor connect lifecycle diag emits', () => {
  it('emits rcon.connected with serverId when AUTH succeeds', async () => {
    const { server, port } = await fakeRconServer({ acceptAuth: true });
    const diag = makeDiag();
    const supervisor = new RconSupervisor({
      db: makeDb(),
      redis: makeRedis(),
      log: makeLogger(),
      diag,
      pollIntervalMs: 60_000,
    });
    const liveTarget: Target = {
      serverId: 'srv-live',
      host: '127.0.0.1',
      port,
      password: 'pw',
    };

    await supervisor.reconcile([liveTarget]);

    const deadline = Date.now() + 5_000;
    let connectedEvent: DiagEvent | undefined;
    while (Date.now() < deadline && !connectedEvent) {
      await sleep(20);
      connectedEvent = diag.emit.mock.calls
        .map((c) => c[0] as DiagEvent)
        .find((e) => e.kind === 'rcon.connected');
    }

    expect(connectedEvent).toBeDefined();
    expect(connectedEvent?.component).toBe('worker-rcon');
    expect(connectedEvent?.severity).toBe('info');
    expect(connectedEvent?.serverId).toBe('srv-live');
    expect(connectedEvent?.payload).toMatchObject({ host: '127.0.0.1', port });

    await supervisor.stop();
    await new Promise<void>((r) => server.close(() => r()));
  }, 10_000);

  it('emits rcon.auth_failed with error severity when AUTH is rejected', async () => {
    const { server, port } = await fakeRconServer({ acceptAuth: false });
    const diag = makeDiag();
    const supervisor = new RconSupervisor({
      db: makeDb(),
      redis: makeRedis(),
      log: makeLogger(),
      diag,
      initialBackoffMs: 60_000,
      maxBackoffMs: 60_000,
      pollIntervalMs: 60_000,
    });
    const liveTarget: Target = {
      serverId: 'srv-bad-auth',
      host: '127.0.0.1',
      port,
      password: 'wrong',
    };

    await supervisor.reconcile([liveTarget]);

    const deadline = Date.now() + 5_000;
    let authFailedEvent: DiagEvent | undefined;
    while (Date.now() < deadline && !authFailedEvent) {
      await sleep(20);
      authFailedEvent = diag.emit.mock.calls
        .map((c) => c[0] as DiagEvent)
        .find((e) => e.kind === 'rcon.auth_failed');
    }

    expect(authFailedEvent).toBeDefined();
    expect(authFailedEvent?.component).toBe('worker-rcon');
    expect(authFailedEvent?.severity).toBe('error');
    expect(authFailedEvent?.serverId).toBe('srv-bad-auth');
    expect(authFailedEvent?.payload).toMatchObject({ host: '127.0.0.1', port });

    await supervisor.stop();
    await new Promise<void>((r) => server.close(() => r()));
  }, 10_000);
});
