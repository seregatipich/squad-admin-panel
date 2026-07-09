import type { PluginRegistration, PluginRegistry } from './registry.js';

/**
 * Plugins compiled into the automation worker for this pass. Empty for now —
 * no first-party automation plugin (AUTO-1 triggers, AUTO-3 alerts, ...) has
 * landed yet. Follow-up: a filesystem/dynamic loader that discovers
 * third-party plugin packages at startup (e.g. under a configured plugins
 * directory) is intentionally out of scope here; this pass only supports
 * registering plugins that are compiled directly into this array.
 */
export const BUILTIN_PLUGINS: PluginRegistration[] = [];

/**
 * Registers every given plugin registration into `registry`, in order.
 * Throws if any manifest is invalid or duplicates an already-registered
 * plugin id — a loader failure is meant to fail worker startup loudly
 * rather than run with a partially-loaded plugin set.
 */
export function loadPlugins(registry: PluginRegistry, plugins: PluginRegistration[]): void {
  for (const plugin of plugins) {
    registry.register(plugin);
  }
}
