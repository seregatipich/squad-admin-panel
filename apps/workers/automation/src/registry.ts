import {
  type EventType,
  type PluginHandler,
  type PluginManifest,
  pluginManifest,
} from '@squad/shared-types';

/** A validated plugin manifest paired with its handler implementation. */
export interface PluginRegistration {
  manifest: PluginManifest;
  handler: PluginHandler;
}

/**
 * In-process index of registered plugins, keyed by event kind for O(1)
 * dispatch lookup. Manifests are validated against the shared
 * `pluginManifest` zod schema at registration time so a malformed plugin
 * fails fast at startup instead of silently never receiving events.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, PluginRegistration>();
  private readonly subscriptions = new Map<EventType, PluginRegistration[]>();

  /**
   * Validates `registration.manifest` and indexes it by every event kind it
   * subscribes to.
   *
   * @throws {import('zod').ZodError} if the manifest fails schema validation.
   * @throws {Error} if a plugin with the same `id` is already registered.
   */
  register(registration: { manifest: unknown; handler: PluginHandler }): PluginManifest {
    const manifest = pluginManifest.parse(registration.manifest);
    if (this.plugins.has(manifest.id)) {
      throw new Error(`plugin "${manifest.id}" is already registered`);
    }

    const entry: PluginRegistration = { manifest, handler: registration.handler };
    this.plugins.set(manifest.id, entry);
    for (const kind of manifest.subscribedEventKinds) {
      const subscribers = this.subscriptions.get(kind) ?? [];
      subscribers.push(entry);
      this.subscriptions.set(kind, subscribers);
    }
    return manifest;
  }

  /** Returns every plugin subscribed to `kind`, in registration order. */
  getSubscribers(kind: EventType): PluginRegistration[] {
    return this.subscriptions.get(kind) ?? [];
  }

  /** Returns every registered plugin's manifest. */
  list(): PluginManifest[] {
    return [...this.plugins.values()].map((entry) => entry.manifest);
  }

  /** Returns whether a plugin with the given id is registered. */
  has(id: string): boolean {
    return this.plugins.has(id);
  }
}
