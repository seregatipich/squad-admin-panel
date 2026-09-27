import { playerApiTokens } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { intersectScopes } from '../lib/api-tokens.js';
import { ChatRingBuffer } from '../lib/chat-ring-buffer.js';
import { CombatRingBuffer } from '../lib/combat-ring-buffer.js';
import { loadUserPermissions, type PermissionContext } from '../lib/rbac.js';
import { resolveSession } from '../lib/sessions.js';
import { SESSION_COOKIE } from '../plugins/auth.js';

const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;
/** Matches the `loadUserPermissions` cache TTL, so a re-check never reads older data than a request would. */
const DEFAULT_REVALIDATE_INTERVAL_MS = 30_000;
const CHAT_BUFFER_PER_SERVER = 100;
const COMBAT_BUFFER_PER_SERVER = 100;

/** Close code sent when the connection's session or API token is no longer valid. */
export const WS_CLOSE_SESSION_REVOKED = 4001;
/** Close code sent when the connection's player no longer holds `server:view`. */
export const WS_CLOSE_FORBIDDEN = 4003;

export interface LiveRoutesOptions {
  /**
   * How often each open socket re-checks its session / API token and the
   * player's permissions. Defaults to 30 s; tests pass a short interval.
   */
  revalidateIntervalMs?: number;
}

type Revalidation =
  | { ok: true; permissions: PermissionContext }
  | { ok: false; code: number; reason: string };

/**
 * `GET /api/v1/ws/live` — the single live-bus push channel.
 *
 * Authorization is checked on the HTTP upgrade by the global auth hook and
 * then kept current for the life of the socket (#12):
 * - a `session.revoked` event for this socket's own session is forwarded (so
 *   the browser runs its forced logout) and the server then closes the socket
 *   with {@link WS_CLOSE_SESSION_REVOKED}, whatever the client does;
 * - every `revalidateIntervalMs` the session (or API token) is re-resolved and
 *   the player's permissions reloaded. A vanished session/token closes with
 *   {@link WS_CLOSE_SESSION_REVOKED}, a lost `server:view` with
 *   {@link WS_CLOSE_FORBIDDEN}, and the `combatView` / `canAssignRoles`
 *   filters are refreshed from the fresh permissions.
 */
const liveRoutes: FastifyPluginAsync<LiveRoutesOptions> = async (app, opts) => {
  const revalidateIntervalMs = opts.revalidateIntervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS;

  const chatBuffer = new ChatRingBuffer(CHAT_BUFFER_PER_SERVER);
  const stopChatBuffer = app.liveBus.subscribe((event) => chatBuffer.push(event));
  app.addHook('onClose', async () => stopChatBuffer());

  const combatBuffer = new CombatRingBuffer(COMBAT_BUFFER_PER_SERVER);
  const stopCombatBuffer = app.liveBus.subscribe((event) => combatBuffer.push(event));
  app.addHook('onClose', async () => stopCombatBuffer());

  app.get(
    '/api/v1/ws/live',
    {
      websocket: true,
      config: { permissions: ['server:view'], audit: false },
    },
    (socket, req) => {
      let lastPongAt = Date.now();
      let closed = false;
      const connectionPlayerId = req.user?.playerId ?? null;
      const connectionSessionId = req.session?.id ?? null;
      const connectionSessionToken = req.session ? req.cookies[SESSION_COOKIE] : undefined;
      const connectionApiTokenId = req.apiTokenId ?? null;
      let canViewCombat = req.user?.permissions.combatView ?? false;
      let canAssignRoles = req.user?.permissions.canAssignRoles ?? false;

      app.diag
        .emit({
          component: 'api',
          kind: 'ws.connected',
          severity: 'info',
          message: `ws ${req.url} connected`,
          payload: { url: req.url },
        })
        .catch(() => undefined);

      const safeSend = (payload: unknown): void => {
        if (closed) return;
        try {
          socket.send(JSON.stringify(payload));
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'live-bus: send failed');
        }
      };

      const closeSocket = (code: number, reason: string): void => {
        if (closed) return;
        closed = true;
        try {
          socket.close(code, reason);
        } catch {
          /* noop */
        }
      };

      const pinger = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
          closeSocket(4000, 'pong timeout');
          return;
        }
        safeSend({ type: 'ping', ts: new Date().toISOString() });
      }, PING_INTERVAL_MS);

      /**
       * Mirrors the auth hook's decision for this connection's identity,
       * trusting nothing captured at upgrade time except the ids. The
       * self-service downgrade matters here: this route does not opt in to
       * `selfService`, so such a session must still hold `panel_access`.
       */
      const revalidate = async (): Promise<Revalidation> => {
        if (!connectionPlayerId) {
          return { ok: false, code: WS_CLOSE_SESSION_REVOKED, reason: 'session revoked' };
        }
        let scopes: string[] | null = null;
        let selfServiceScope = false;
        if (connectionSessionId && connectionSessionToken) {
          const session = await resolveSession(app.db, app.redis, connectionSessionToken);
          if (!session || session.id !== connectionSessionId) {
            return { ok: false, code: WS_CLOSE_SESSION_REVOKED, reason: 'session revoked' };
          }
          selfServiceScope = session.scope === 'self_service';
        } else if (connectionApiTokenId) {
          const tokenRows = await app.db
            .select({ scopes: playerApiTokens.scopes })
            .from(playerApiTokens)
            .where(
              and(eq(playerApiTokens.id, connectionApiTokenId), isNull(playerApiTokens.revokedAt)),
            )
            .limit(1);
          const token = tokenRows[0];
          if (!token) {
            return { ok: false, code: WS_CLOSE_SESSION_REVOKED, reason: 'session revoked' };
          }
          scopes = token.scopes;
        } else {
          return { ok: false, code: WS_CLOSE_SESSION_REVOKED, reason: 'session revoked' };
        }
        const permissions = await loadUserPermissions(app.db, connectionPlayerId);
        const effective =
          scopes === null
            ? permissions.permissions
            : intersectScopes(scopes, permissions.permissions);
        if ((selfServiceScope && !permissions.panelAccess) || !effective.has('server:view')) {
          return { ok: false, code: WS_CLOSE_FORBIDDEN, reason: 'forbidden' };
        }
        return { ok: true, permissions };
      };

      // One re-check at a time; a slow database must not stack them up. A
      // failed check (database or Redis unavailable) keeps the socket and
      // retries on the next tick: nothing has been granted since the last
      // successful check, and failing closed would disconnect every client
      // on a transient blip.
      let revalidating = false;
      const revalidator = setInterval(() => {
        if (closed || revalidating) return;
        revalidating = true;
        revalidate()
          .then((result) => {
            if (!result.ok) {
              closeSocket(result.code, result.reason);
              return;
            }
            canViewCombat = result.permissions.combatView;
            canAssignRoles = result.permissions.canAssignRoles;
          })
          .catch((err: unknown) => {
            req.log.warn({ err: (err as Error).message }, 'live-bus: revalidation failed');
          })
          .finally(() => {
            revalidating = false;
          });
      }, revalidateIntervalMs);

      const unsubscribe = app.liveBus.subscribe((event) => {
        if (event.type === 'session.revoked') {
          if (event.data.player_id !== connectionPlayerId) return;
          safeSend(event);
          if (connectionSessionId !== null && event.data.session_id === connectionSessionId) {
            closeSocket(WS_CLOSE_SESSION_REVOKED, 'session revoked');
          }
          return;
        }
        if (
          event.type === 'alert.triggered' &&
          (event.data.event_kind === 'seed.call_sent' ||
            event.data.event_kind === 'server.seeding_started') &&
          typeof event.data.player_id === 'string' &&
          event.data.player_id !== connectionPlayerId
        ) {
          return;
        }
        if (
          event.type === 'alert.triggered' &&
          (event.data.event_kind === 'role_expiring' ||
            // VIPSUB-5 (#171): a failed subscription renewal names the player,
            // so it goes to the same audience as an expiry reminder.
            event.data.event_kind === 'subscription_expired') &&
          !canAssignRoles
        ) {
          return;
        }
        // Delegated-upload notifications are private to the admin who minted
        // the link; nobody else learns that an anonymous upload happened.
        if (event.type === 'media.uploaded' && event.data.player_id !== connectionPlayerId) {
          return;
        }
        if (event.type === 'combat.event' && !canViewCombat) return;
        safeSend(event);
      });

      for (const buffered of chatBuffer.tail()) safeSend(buffered);
      if (canViewCombat) {
        for (const buffered of combatBuffer.tail()) safeSend(buffered);
      }

      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string };
          if (msg.type === 'pong') lastPongAt = Date.now();
        } catch {
          /* ignore malformed client frames */
        }
      });

      socket.on('close', (code, reason) => {
        closed = true;
        clearInterval(pinger);
        clearInterval(revalidator);
        unsubscribe();
        app.diag
          .emit({
            component: 'api',
            kind: 'ws.disconnected',
            severity: 'info',
            message: `ws ${req.url} closed code=${code}`,
            payload: {
              code,
              reason: reason?.toString().slice(0, 200) ?? '',
              url: req.url,
            },
          })
          .catch(() => undefined);
      });

      socket.on('error', (err) => {
        app.diag
          .emit({
            component: 'api',
            kind: 'ws.error',
            severity: 'warn',
            message: `ws error: ${err.message}`,
            payload: { errorMessage: err.message, url: req.url },
          })
          .catch(() => undefined);
      });
    },
  );
};

export default liveRoutes;
