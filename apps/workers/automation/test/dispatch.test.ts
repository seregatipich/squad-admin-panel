import { setTimeout as sleep } from 'node:timers/promises';
import type { EventEnvelope } from '@squad/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { type DispatchDeps, dispatchEnvelope, parseStreamEnvelope } from '../src/dispatch.js';
import { PluginRegistry } from '../src/registry.js';

function makeEnvelope(overrides?: Partial<EventEnvelope>): EventEnvelope {
  return {
    event_id: '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c4',
    version: 1,
    type: 'player.connected',
    server_id: null,
    ts: new Date().toISOString(),
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: { name: 'TestPlayer' },
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() } as never;
}

function makeDeps(registry: PluginRegistry, pluginTimeoutMs?: number): DispatchDeps {
  return { redis: {} as never, registry, log: makeLogger(), pluginTimeoutMs };
}

describe('parseStreamEnvelope', () => {
  it('parses a valid envelope field pair', () => {
    const envelope = makeEnvelope();
    const parsed = parseStreamEnvelope(['envelope', JSON.stringify(envelope)]);
    expect(parsed).toEqual(envelope);
  });

  it('returns null when the envelope field is missing', () => {
    expect(parseStreamEnvelope(['other', 'value'])).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    expect(parseStreamEnvelope(['envelope', '{not json'])).toBeNull();
  });

  it('returns null when the JSON does not match the envelope schema', () => {
    expect(parseStreamEnvelope(['envelope', JSON.stringify({ foo: 'bar' })])).toBeNull();
  });
});

describe('dispatchEnvelope', () => {
  it('delivers the exact envelope to a subscribed plugin with full permissions', async () => {
    const registry = new PluginRegistry();
    const onEvent = vi.fn();
    registry.register({
      manifest: {
        id: 'full-perm-plugin',
        name: 'Full Perm Plugin',
        version: '1.0.0',
        subscribedEventKinds: ['player.connected'],
        requestedPermissions: ['events:read', 'events:payload'],
      },
      handler: { onEvent },
    });
    const envelope = makeEnvelope();

    const result = await dispatchEnvelope(makeDeps(registry), envelope);

    expect(onEvent).toHaveBeenCalledWith(envelope);
    expect(result).toEqual({ delivered: 1, deniedPermission: 0, failed: 0, timedOut: 0 });
  });

  it('does not dispatch to a plugin not subscribed to the event kind', async () => {
    const registry = new PluginRegistry();
    const onEvent = vi.fn();
    registry.register({
      manifest: {
        id: 'other-kind-plugin',
        name: 'Other Kind Plugin',
        version: '1.0.0',
        subscribedEventKinds: ['player.disconnected'],
        requestedPermissions: ['events:read'],
      },
      handler: { onEvent },
    });

    await dispatchEnvelope(makeDeps(registry), makeEnvelope({ type: 'player.connected' }));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does not invoke a plugin lacking events:read', async () => {
    const registry = new PluginRegistry();
    const onEvent = vi.fn();
    registry.register({
      manifest: {
        id: 'no-read-plugin',
        name: 'No Read Plugin',
        version: '1.0.0',
        subscribedEventKinds: ['player.connected'],
        requestedPermissions: [],
      },
      handler: { onEvent },
    });

    const result = await dispatchEnvelope(makeDeps(registry), makeEnvelope());

    expect(onEvent).not.toHaveBeenCalled();
    expect(result.deniedPermission).toBe(1);
  });

  it('redacts payload to null for a plugin lacking events:payload', async () => {
    const registry = new PluginRegistry();
    const received: EventEnvelope[] = [];
    registry.register({
      manifest: {
        id: 'no-payload-plugin',
        name: 'No Payload Plugin',
        version: '1.0.0',
        subscribedEventKinds: ['player.connected'],
        requestedPermissions: ['events:read'],
      },
      handler: {
        onEvent: (envelope) => {
          received.push(envelope);
        },
      },
    });
    const envelope = makeEnvelope();

    await dispatchEnvelope(makeDeps(registry), envelope);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ ...envelope, payload: null });
  });

  it('isolates a throwing plugin: it is logged and skipped, others still receive the event', async () => {
    const registry = new PluginRegistry();
    const goodHandler = vi.fn();
    registry.register({
      manifest: {
        id: 'throwing-plugin',
        name: 'Throwing Plugin',
        version: '1.0.0',
        subscribedEventKinds: ['player.connected'],
        requestedPermissions: ['events:read'],
      },
      handler: {
        onEvent: () => {
          throw new Error('boom');
        },
      },
    });
    registry.register({
      manifest: {
        id: 'good-plugin',
        name: 'Good Plugin',
        version: '1.0.0',
        subscribedEventKinds: ['player.connected'],
        requestedPermissions: ['events:read'],
      },
      handler: { onEvent: goodHandler },
    });

    const result = await dispatchEnvelope(makeDeps(registry), makeEnvelope());

    expect(goodHandler).toHaveBeenCalledOnce();
    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(1);
  });

  it('isolates a hanging plugin past the timeout: it is skipped, others still receive the event', async () => {
    const registry = new PluginRegistry();
    const goodHandler = vi.fn();
    registry.register({
      manifest: {
        id: 'hanging-plugin',
        name: 'Hanging Plugin',
        version: '1.0.0',
        subscribedEventKinds: ['player.connected'],
        requestedPermissions: ['events:read'],
      },
      handler: {
        onEvent: () => sleep(60_000),
      },
    });
    registry.register({
      manifest: {
        id: 'good-plugin-2',
        name: 'Good Plugin 2',
        version: '1.0.0',
        subscribedEventKinds: ['player.connected'],
        requestedPermissions: ['events:read'],
      },
      handler: { onEvent: goodHandler },
    });

    const result = await dispatchEnvelope(makeDeps(registry, 50), makeEnvelope());

    expect(goodHandler).toHaveBeenCalledOnce();
    expect(result.timedOut).toBe(1);
    expect(result.delivered).toBe(1);
  }, 10_000);

  it('an async-rejecting plugin is isolated the same as a throwing one', async () => {
    const registry = new PluginRegistry();
    registry.register({
      manifest: {
        id: 'rejecting-plugin',
        name: 'Rejecting Plugin',
        version: '1.0.0',
        subscribedEventKinds: ['player.connected'],
        requestedPermissions: ['events:read'],
      },
      handler: { onEvent: () => Promise.reject(new Error('async boom')) },
    });

    const result = await dispatchEnvelope(makeDeps(registry), makeEnvelope());
    expect(result.failed).toBe(1);
  });
});
