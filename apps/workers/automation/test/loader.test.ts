import type { PluginHandler } from '@squad/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_PLUGINS, loadPlugins } from '../src/loader.js';
import { PluginRegistry } from '../src/registry.js';

function noopHandler(): PluginHandler {
  return { onEvent: vi.fn() };
}

describe('loadPlugins', () => {
  it('registers every given plugin into the registry', () => {
    const registry = new PluginRegistry();
    loadPlugins(registry, [
      {
        manifest: {
          id: 'loader-test-plugin',
          name: 'Loader Test Plugin',
          version: '1.0.0',
          subscribedEventKinds: ['player.connected'],
          requestedPermissions: ['events:read'],
        },
        handler: noopHandler(),
      },
    ]);

    expect(registry.has('loader-test-plugin')).toBe(true);
  });

  it('BUILTIN_PLUGINS is empty for this pass (no first-party plugin yet)', () => {
    expect(BUILTIN_PLUGINS).toEqual([]);
  });

  it('throws (and registers nothing further) when a plugin manifest is invalid', () => {
    const registry = new PluginRegistry();
    expect(() =>
      loadPlugins(registry, [
        {
          manifest: {
            id: 'ok-plugin',
            name: 'Ok Plugin',
            version: '1.0.0',
            subscribedEventKinds: ['player.connected'],
            requestedPermissions: ['events:read'],
          },
          handler: noopHandler(),
        },
        {
          manifest: {
            id: 'Bad Id',
            name: 'Bad Plugin',
            version: '1.0.0',
            subscribedEventKinds: ['player.connected'],
            requestedPermissions: ['events:read'],
          },
          handler: noopHandler(),
        },
      ]),
    ).toThrow();
    expect(registry.has('ok-plugin')).toBe(true);
    expect(registry.has('Bad Id')).toBe(false);
  });
});
