import type { PluginHandler } from '@squad/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { PluginRegistry } from '../src/registry.js';

function manifest(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    subscribedEventKinds: ['player.connected'],
    requestedPermissions: ['events:read'],
    ...overrides,
  };
}

function noopHandler(): PluginHandler {
  return { onEvent: vi.fn() };
}

describe('PluginRegistry', () => {
  it('registers a valid plugin and indexes it by its subscribed kinds', () => {
    const registry = new PluginRegistry();
    const handler = noopHandler();
    registry.register({ manifest: manifest(), handler });

    expect(registry.has('test-plugin')).toBe(true);
    expect(registry.getSubscribers('player.connected')).toHaveLength(1);
    expect(registry.getSubscribers('player.connected')[0]?.handler).toBe(handler);
  });

  it('does not index the plugin under event kinds it did not subscribe to', () => {
    const registry = new PluginRegistry();
    registry.register({ manifest: manifest(), handler: noopHandler() });

    expect(registry.getSubscribers('player.disconnected')).toHaveLength(0);
  });

  it('indexes a plugin under every kind it subscribes to', () => {
    const registry = new PluginRegistry();
    registry.register({
      manifest: manifest({ subscribedEventKinds: ['player.connected', 'player.disconnected'] }),
      handler: noopHandler(),
    });

    expect(registry.getSubscribers('player.connected')).toHaveLength(1);
    expect(registry.getSubscribers('player.disconnected')).toHaveLength(1);
  });

  it('throws on an invalid manifest (fails fast at registration)', () => {
    const registry = new PluginRegistry();
    expect(() =>
      registry.register({
        manifest: manifest({ subscribedEventKinds: [] }),
        handler: noopHandler(),
      }),
    ).toThrow();
  });

  it('throws when registering a duplicate plugin id', () => {
    const registry = new PluginRegistry();
    registry.register({ manifest: manifest(), handler: noopHandler() });
    expect(() => registry.register({ manifest: manifest(), handler: noopHandler() })).toThrow(
      /already registered/,
    );
  });

  it('list() returns every registered plugin manifest', () => {
    const registry = new PluginRegistry();
    registry.register({ manifest: manifest({ id: 'plugin-a' }), handler: noopHandler() });
    registry.register({ manifest: manifest({ id: 'plugin-b' }), handler: noopHandler() });

    expect(
      registry
        .list()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['plugin-a', 'plugin-b']);
  });
});
