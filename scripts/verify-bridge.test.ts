import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  type CommandResult,
  REPOSITORY_ROOT,
  run,
  runAsync,
  temporaryRoot,
} from './test-helpers/ops.ts';

describe('verify-bridge framed Unix-socket smoke test', () => {
  type BridgeReply = Record<string, unknown> | 'close';
  type BridgeResponder = (request: Record<string, unknown>) => BridgeReply;

  /** Replies like the real bridge: the allowlist probes are refused, the rest succeed. */
  const faithfulBridge: BridgeResponder = (request) => {
    const refusals: Record<string, string> = {
      file_read: 'forbidden: path "/etc/shadow" outside allowed roots',
      file_atomic_write:
        'forbidden: path "/opt/squad-servers/verify-bridge.tmp" outside allowed roots',
      container_run: 'forbidden: image "alpine:latest" not in allowlist',
    };
    const refusal = refusals[String(request.method)];
    if (refusal) {
      return { id: request.id, ok: false, error: { code: 'forbidden', message: refusal } };
    }
    return { id: request.id, ok: true, result: { method: request.method } };
  };

  async function bridgeServer(
    socketPath: string,
    respond: BridgeResponder = faithfulBridge,
  ): Promise<{ server: net.Server; requests: Array<Record<string, unknown>> }> {
    const requests: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const size = buffer.readUInt32BE(0);
        if (buffer.length < size + 4) return;
        const request = JSON.parse(buffer.subarray(4, size + 4).toString('utf8')) as Record<
          string,
          unknown
        >;
        requests.push(request);
        const reply = respond(request);
        if (reply === 'close') {
          socket.end();
          return;
        }
        const payload = Buffer.from(JSON.stringify(reply));
        const frame = Buffer.alloc(payload.length + 4);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);
        socket.end(frame);
      });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    return { server, requests };
  }

  async function runAgainst(
    prefix: string,
    respond?: BridgeResponder,
  ): Promise<{ result: CommandResult; requests: Array<Record<string, unknown>> }> {
    const socketPath = path.join(temporaryRoot(prefix), 'bridge.sock');
    const fixture = await bridgeServer(socketPath, respond);
    try {
      const result = await runAsync(
        '/bin/bash',
        [path.join(REPOSITORY_ROOT, 'scripts/verify-bridge.sh')],
        { env: { BRIDGE_SOCKET: socketPath } },
      );
      return { result, requests: fixture.requests };
    } finally {
      fixture.server.close();
      await once(fixture.server, 'close');
    }
  }

  it('fails before Python when the configured socket does not exist', () => {
    const missing = path.join(temporaryRoot('missing-bridge-socket'), 'bridge.sock');
    const result = run('/bin/bash', [path.join(REPOSITORY_ROOT, 'scripts/verify-bridge.sh')], {
      env: { BRIDGE_SOCKET: missing },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /socket .* not found/);
  });

  it('sends all eight exact method and parameter frames through a temporary socket', async () => {
    const { result, requests } = await runAgainst('verify-bridge');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[verify-bridge\].*done/);
    assert.deepEqual(
      requests.map((request) => request.method),
      [
        'ping',
        'host_info',
        'host_metrics',
        'list_panel_dirs',
        'file_read',
        'file_atomic_write',
        'container_inspect',
        'container_run',
      ],
    );
    assert.equal(requests[3]?.params, null);
    assert.deepEqual(requests[4]?.params, { path: '/etc/shadow' });
    assert.deepEqual(requests[5]?.params, {
      path: '/opt/squad-servers/verify-bridge.tmp',
      content: 'verify-bridge ok\n',
      mode: 420,
    });
    // A valid server_id makes the image allowlist, not the UUID check, the
    // rule that refuses this probe.
    assert.deepEqual(requests[7]?.params, {
      server_id: '00000000-0000-0000-0000-000000000000',
      image: 'alpine:latest',
    });
  });

  it('propagates a missing response and sends no calls after the failed boundary', async () => {
    const { result, requests } = await runAgainst('verify-bridge-failure', (request) =>
      request.method === 'host_metrics' ? 'close' : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\(no response\)/);
    assert.deepEqual(
      requests.map((request) => request.method),
      ['ping', 'host_info', 'host_metrics'],
    );
  });

  it('fails without printing the body when a must-be-forbidden probe succeeds', async () => {
    const { result, requests } = await runAgainst('verify-bridge-open-allowlist', (request) =>
      request.method === 'file_read'
        ? { id: request.id, ok: true, result: { content: 'root:SECRET-SHADOW-HASH:19000' } }
        : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /file_read.*expected a forbidden refusal/);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET-SHADOW-HASH/);
    assert.doesNotMatch(result.stdout, /done/);
    assert.equal(requests.at(-1)?.method, 'file_read');
  });

  it('fails when a probe is refused for a reason other than the allowlist', async () => {
    const { result } = await runAgainst('verify-bridge-wrong-code', (request) =>
      request.method === 'file_atomic_write'
        ? { id: request.id, ok: false, error: { code: 'runtime_error', message: 'disk full' } }
        : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /file_atomic_write.*expected a forbidden refusal.*runtime_error/);
  });

  it('fails when container_run is refused by a rule other than the image allowlist', async () => {
    const { result } = await runAgainst('verify-bridge-wrong-rule', (request) =>
      request.method === 'container_run'
        ? {
            id: request.id,
            ok: false,
            error: { code: 'forbidden', message: 'forbidden: uuid "" is not a UUID' },
          }
        : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /container_run.*not in allowlist/);
  });

  it('fails when a probe that must succeed returns an error', async () => {
    const { result, requests } = await runAgainst('verify-bridge-ping-error', (request) =>
      request.method === 'ping'
        ? { id: request.id, ok: false, error: { code: 'internal', message: 'boom' } }
        : faithfulBridge(request),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ping.*expected ok.*internal/);
    assert.deepEqual(
      requests.map((request) => request.method),
      ['ping'],
    );
  });
});
