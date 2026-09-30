/**
 * SRV-6 (#45): License.cfg is a `requires_restart` config — Squad reads it at
 * boot, so a saved license only takes effect once the container (re)starts
 * after the save. Mirrors the API's `restart_required` derivation so the badge
 * can be recomputed client-side from GET /servers/:id state.
 *
 * @param licenseUpdatedAt - ISO timestamp of the last stored-license change,
 *   or null when no license change is on record.
 * @param containerRunning - Whether the server container is currently running.
 * @param containerStartedAt - ISO timestamp the container last started, or
 *   null/absent when not running or unknown.
 * @returns true when the stored license has not yet been picked up by a
 *   (re)start — i.e. the operator must restart the server to apply it.
 */
export function licenseRestartRequired(
  licenseUpdatedAt: string | null,
  containerRunning: boolean,
  containerStartedAt: string | null,
): boolean {
  if (!licenseUpdatedAt) return false;
  if (!containerRunning || !containerStartedAt) return true;
  return new Date(containerStartedAt).getTime() < new Date(licenseUpdatedAt).getTime();
}

/**
 * STATS-4 (#71): shapes and labels behind the «Интеграция SquadJS» section.
 * Mirrors the payload of `GET /api/v1/servers/:id/rnsquadjs` field for field.
 */
export type SidecarMode = 'production' | 'shadow' | 'legacy';

export interface SidecarStatus {
  state: 'connected' | 'disconnected';
  last_change: string;
}

export interface SidecarIntegration {
  server_id: string;
  mode: SidecarMode;
  cutover: boolean;
  /** null means no sidecar status within its 300s TTL — not an error. */
  status: SidecarStatus | null;
}

/**
 * Names the sidecar serving the server.
 *
 * @param mode - Mode reported by the status route; in legacy mode no sidecar
 *   runs and the built-in log parser reads events.
 * @returns The badge text for the sidecar row.
 */
export function sidecarEngineLabel(mode: SidecarMode): string {
  return mode === 'legacy' ? 'Не запущен' : 'RNSquadJS';
}

/**
 * Names the effective event source for the server.
 *
 * @param mode - Mode reported by the status route.
 * @returns A short title plus a one-line explanation of what the mode means
 *   for the event pipeline.
 */
export function sidecarModeLabel(mode: SidecarMode): { title: string; hint: string } {
  if (mode === 'production') {
    return {
      title: 'Продакшен',
      hint: 'События сервера читает сайдкар SquadJS; штатный парсер логов для него отключён.',
    };
  }
  if (mode === 'shadow') {
    return {
      title: 'Теневой режим',
      hint: 'Сайдкар работает параллельно и пишет в теневой поток; боевые события идут из штатного парсера.',
    };
  }
  return {
    title: 'Штатный парсер',
    hint: 'Сайдкар не запущен: события читает встроенный парсер SquadGame.log.',
  };
}

/**
 * Renders the sidecar status as a pill.
 *
 * @param status - Status from the route, or null when none arrived within its
 *   300s TTL.
 * @returns Pill text and tone; a missing status is neutral, not an error.
 */
export function sidecarStatusPill(status: SidecarStatus | null): {
  text: string;
  tone: 'green' | 'amber' | 'neutral';
} {
  if (!status) return { text: 'Нет сигнала', tone: 'neutral' };
  return status.state === 'connected'
    ? { text: 'RCON подключён', tone: 'green' }
    : { text: 'RCON отключён', tone: 'amber' };
}

/** The part of a zod schema `readJson` needs, so the web app need not depend on zod itself. */
interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

/**
 * Builds the operator-facing message of a failed API response.
 *
 * @param res - Non-2xx response.
 * @returns The body's `message`, else its `error`, else `HTTP <status>`.
 */
export async function readErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return body.message ?? body.error ?? `HTTP ${res.status}`;
}

/**
 * Decodes a response body and checks it against a schema from `@squad/shared-types`.
 *
 * @param res - 2xx response whose body is JSON.
 * @param schema - Schema the body must satisfy.
 * @param what - Russian name of the payload for the error text.
 * @returns The parsed body.
 * @throws Error when the body is not JSON or does not match the schema, so a
 *   drifted API contract shows up as a readable error instead of a TypeError.
 */
export async function readJson<T>(
  res: Response,
  schema: ResponseSchema<T>,
  what: string,
): Promise<T> {
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new Error(`Неожиданный ответ сервера: ${what}`);
  return parsed.data;
}
