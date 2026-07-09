import { z } from 'zod';
import { EVENT_TYPES, type EventEnvelope } from './events.js';

/**
 * Capabilities a plugin may request in its manifest. Enforced by the
 * automation worker's dispatcher at delivery time (see
 * `apps/workers/automation/src/dispatch.ts`), not merely documented:
 *
 * - `events:read` — required for the plugin to be dispatched to at all. A
 *   plugin without this permission is indexed by the registry (so
 *   `PluginRegistry.list()` still reports it) but never receives an
 *   `onEvent` call — the dispatcher counts it as skipped and logs a warning.
 * - `events:payload` — required to receive the envelope's `payload` field.
 *   A plugin subscribed to a kind but lacking this permission still gets
 *   `onEvent` invoked, with `payload` replaced by `null` in the envelope it
 *   is handed.
 */
export const PLUGIN_PERMISSIONS = ['events:read', 'events:payload'] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Manifest a plugin declares to the registry: its identity, the event kinds
 * it wants to observe, and the capabilities it requests. Validated by
 * `PluginRegistry.register` before a plugin can receive any events.
 */
export const pluginManifest = z
  .object({
    id: z.string().regex(PLUGIN_ID_PATTERN, 'id must be a lowercase kebab-case slug, 2-64 chars'),
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(32),
    subscribedEventKinds: z.array(z.enum(EVENT_TYPES)).min(1),
    requestedPermissions: z.array(z.enum(PLUGIN_PERMISSIONS)),
  })
  .strict();
export type PluginManifest = z.infer<typeof pluginManifest>;

/**
 * Returns whether `manifest` requests the given permission. Used by the
 * dispatcher to gate both delivery (`events:read`) and payload visibility
 * (`events:payload`).
 */
export function hasPluginPermission(
  manifest: PluginManifest,
  permission: PluginPermission,
): boolean {
  return manifest.requestedPermissions.includes(permission);
}

/**
 * Contract every plugin handler must implement. The dispatcher invokes
 * `onEvent` once per matching event envelope, wrapped in a try/catch and a
 * per-invocation timeout — a handler must not be relied upon to run to
 * completion, and it must not assume any invocation order relative to other
 * plugins.
 */
export interface PluginHandler {
  onEvent(envelope: EventEnvelope): void | Promise<void>;
}
