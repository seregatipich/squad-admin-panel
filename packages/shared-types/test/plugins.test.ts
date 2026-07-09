import { describe, expect, it } from 'vitest';
import { hasPluginPermission, PLUGIN_PERMISSIONS, pluginManifest } from '../src/plugins.js';

function baseManifest(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'sample-plugin',
    name: 'Sample Plugin',
    version: '1.0.0',
    subscribedEventKinds: ['player.connected'],
    requestedPermissions: ['events:read'],
    ...overrides,
  };
}

describe('plugin manifest schema', () => {
  it('accepts a well-formed manifest', () => {
    const result = pluginManifest.safeParse(baseManifest());
    expect(result.success).toBe(true);
  });

  it('rejects an id with uppercase or non-kebab characters', () => {
    expect(pluginManifest.safeParse(baseManifest({ id: 'Sample_Plugin' })).success).toBe(false);
  });

  it('rejects an empty subscribedEventKinds array', () => {
    expect(pluginManifest.safeParse(baseManifest({ subscribedEventKinds: [] })).success).toBe(
      false,
    );
  });

  it('rejects an unknown event kind', () => {
    expect(
      pluginManifest.safeParse(baseManifest({ subscribedEventKinds: ['not.a.real.kind'] })).success,
    ).toBe(false);
  });

  it('rejects an unknown permission', () => {
    expect(
      pluginManifest.safeParse(baseManifest({ requestedPermissions: ['rcon:execute'] })).success,
    ).toBe(false);
  });

  it('accepts an empty requestedPermissions array (opt-in only)', () => {
    expect(pluginManifest.safeParse(baseManifest({ requestedPermissions: [] })).success).toBe(true);
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(pluginManifest.safeParse(baseManifest({ extra: 'nope' })).success).toBe(false);
  });

  it('exposes exactly the documented permission set', () => {
    expect(PLUGIN_PERMISSIONS).toEqual(['events:read', 'events:payload']);
  });
});

describe('hasPluginPermission', () => {
  it('returns true when the permission is present', () => {
    const manifest = pluginManifest.parse(baseManifest({ requestedPermissions: ['events:read'] }));
    expect(hasPluginPermission(manifest, 'events:read')).toBe(true);
  });

  it('returns false when the permission is absent', () => {
    const manifest = pluginManifest.parse(baseManifest({ requestedPermissions: ['events:read'] }));
    expect(hasPluginPermission(manifest, 'events:payload')).toBe(false);
  });
});
