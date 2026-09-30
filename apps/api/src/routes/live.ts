import { playerApiTokens } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { loadUserPermissions, narrowToTokenScopes, type PermissionContext } from '../lib/rbac.js';
import { ServerRingBuffer } from '../lib/server-ring-buffer.js';
import { resolveSession } from '../lib/sessions.js';
import { sendUnlessStalled, serialiseOnce, WS_MAX_BUFFERED_BYTES } from '../lib/ws-send.js';
import { SESSION_COOKIE } from '../plugins/auth.js';
import { LIVE_EVENT_AUDIENCE, type LiveEvent } from '../plugins/live-bus.js';

const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;
/** Matches the `loadUserPermissions` cache TTL, so a re-check never reads older data than a request would. */
const DEFAULT_REVALIDATE_INTERVAL_MS = 30_000;
/** #1340: caps the ws send buffer before frames are silently dropped for a slow client. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const CHAT_BUFFER_PER_SERVER = 100;
const COMBAT_BUFFER_PER_SERVER = 100;
/**
 * Client frames tolerated per {@link PING_INTERVAL_MS}. A well-behaved client
 * sends one pong per ping; anything far above that is a flood and the socket
 * is closed with {@link WS_CLOSE_POLICY_VIOLATION} rather than parsed.
 */
export const MAX_CLIENT_FRAMES_PER_INTERVAL = 20;
/** RFC 6455 close code for a client that breaks the frame-rate policy. */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

/** Most event types one subscribe/unsubscribe frame may name. */
const MAX_SUBSCRIPTION_EVENTS = 64;
/** Longest event type name accepted in a subscription frame. */
const MAX_EVENT_TYPE_LENGTH = 64;

/**
 * How each modelled live event type reaches a socket. `broadcast` types go to
 * every connection (subject to the per-event access filters below); `opt_in`
 * types only to a socket that sent `{ type: 'subscribe', events: [...] }` for
 * them — the high-volume streams (chat, combat, roster snapshots) and types no
 * page consumes by default. Every union member must be listed, so a new event
 * type forces a choice here. Types the union does not model (worker-published
 * `banname.matched`, `bansync.*`, …) are always opt-in.
 */
const EVENT_DELIVERY: Record<LiveEvent['type'], 'broadcast' | 'opt_in'> = {
  'alert.triggered': 'broadcast',
  'appeal.created': 'broadcast',
  'appeal.updated': 'broadcast',
  'bridge.connection': 'broadcast',
  'chat.message': 'opt_in',
  'combat.event': 'opt_in',
  'combat.vehicle': 'opt_in',
  'externalban.matched': 'opt_in',
  'issue.comment.created': 'broadcast',
  'issue.created': 'broadcast',
  'issue.updated': 'broadcast',
  'mark.changed': 'broadcast',
  'mark_type.changed': 'broadcast',
  'media.uploaded': 'broadcast',
  'note.created': 'broadcast',
  'rcon.roster': 'opt_in',
  'rcon.status': 'broadcast',
  'report.created': 'broadcast',
  'report.updated': 'broadcast',
  'server.deleted': 'broadcast',
  'server.events.appended': 'broadcast',
  'server.map.changed': 'broadcast',
  'server.restored': 'broadcast',
  'server.seeding': 'broadcast',
  'server.status': 'broadcast',
  'session.revoked': 'broadcast',
  'vote.ended': 'broadcast',
};

function isBroadcast(type: string): boolean {
  return (
    (EVENT_DELIVERY as Record<string, 'broadcast' | 'opt_in' | undefined>)[type] === 'broadcast'
  );
}

/**
 * The event types named by a client subscription frame, or `null` when the
 * frame is malformed (it is then ignored).
 */
function subscriptionEvents(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SUBSCRIPTION_EVENTS) return null;
  const events: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_EVENT_TYPE_LENGTH) {
      return null;
    }
    events.push(item);
  }
  return events;
}

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
  /**
   * Bytes a socket may have queued before it counts as stalled and is
   * dropped. Defaults to {@link WS_MAX_BUFFERED_BYTES}; tests pass a small
   * limit.
   */
  maxBufferedBytes?: number;
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
 *   filters are refreshed from the fresh permissions — narrowed to the token's
 *   scopes for an API-token connection, exactly as the HTTP auth hook does.
 *
 * Delivery is per socket (#69): `broadcast` types in {@link EVENT_DELIVERY}
 * reach every connection, `opt_in` types (and unmodelled worker types) only a
 * socket that subscribed with `{ type: 'subscribe', events: [...] }` (undone
 * by `{ type: 'unsubscribe', events: [...] }`; each is acknowledged with a
 * `subscribed` / `unsubscribed` frame). Subscribing to `chat.message` or
 * `combat.event` replays the buffered tail of every server — the combat tail
 * only with `combatView` — so a page gets what it missed without every other
 * connection paying for it.
 */
const liveRoutes: FastifyPluginAsync<LiveRoutesOptions> = async (app, opts) => {
  const revalidateIntervalMs = opts.revalidateIntervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS;
  const maxBufferedBytes = opts.maxBufferedBytes ?? WS_MAX_BUFFERED_BYTES;

  const chatBuffer = new ServerRingBuffer('chat.message', CHAT_BUFFER_PER_SERVER);
  const stopChatBuffer = app.liveBus.subscribe((event) => chatBuffer.push(event));
  app.addHook('onClose', async () => stopChatBuffer());

  const combatBuffer = new ServerRingBuffer('combat.event', COMBAT_BUFFER_PER_SERVER);
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
      let clientFramesThisInterval = 0;
      const connectionPlayerId = req.user?.playerId ?? null;
      const connectionSessionId = req.session?.id ?? null;
      const connectionSessionToken = req.session ? req.cookies[SESSION_COOKIE] : undefined;
      const connectionApiTokenId = req.apiTokenId ?? null;
      let canViewCombat = req.user?.permissions.combatView ?? false;
      let canAssignRoles = req.user?.permissions.canAssignRoles ?? false;
      const subscribedEvents = new Set<string>();

      app.diag
        .emit({
          component: 'api',
          kind: 'ws.connected',
          severity: 'info',
          message: `ws ${req.url} connected`,
          payload: { url: req.url },
        })
        .catch(() => undefined);

      // Every bus event reaches every socket, so it is encoded once for all
      // of them; a socket that stops reading is dropped instead of buffering
      // the stream in memory (#1297).
      const safeSend = (payload: object): void => {
        if (closed) return;
        // #1340: a slow client that still answers pings otherwise lets the
        // fanned-out event stream pile up in the ws library's send buffer
        // without limit.
        if ((socket.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) return;
        try {
          if (!sendUnlessStalled(socket, serialiseOnce(payload), maxBufferedBytes)) {
            closed = true;
            req.log.warn('live-bus: dropped a client that stopped reading');
          }
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
        clientFramesThisInterval = 0;
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
        const rolePermissions = await loadUserPermissions(app.db, connectionPlayerId);
        // An API token never carries more than its scopes delegate: narrow the
        // role flags (combatView, canAssignRoles, …) the same way the HTTP auth
        // hook did at upgrade, or the first re-check would widen them.
        const permissions =
          scopes === null ? rolePermissions : narrowToTokenScopes(rolePermissions, scopes);
        if (
          (selfServiceScope && !permissions.panelAccess) ||
          !permissions.permissions.has('server:view')
        ) {
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

      const stopForwarding = app.liveBus.subscribe((event) => {
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
        // Every `combat.*` frame carries combat data (log-ingest also publishes
        // `combat.vehicle`), so the gate also matches the prefix, not only the
        // types the audience table lists.
        if (
          (LIVE_EVENT_AUDIENCE[event.type] === 'combat' ||
            (event.type as string).startsWith('combat.')) &&
          !canViewCombat
        ) {
          return;
        }
        if (!isBroadcast(event.type) && !subscribedEvents.has(event.type)) return;
        safeSend(event);
      });

      const subscribeEvents = (events: string[]): void => {
        for (const type of events) {
          if (subscribedEvents.has(type)) continue;
          subscribedEvents.add(type);
          if (type === 'chat.message') {
            for (const buffered of chatBuffer.tail()) safeSend(buffered);
          } else if (type === 'combat.event' && canViewCombat) {
            for (const buffered of combatBuffer.tail()) safeSend(buffered);
          }
        }
        safeSend({ type: 'subscribed', events: [...subscribedEvents] });
      };

      const unsubscribeEvents = (events: string[]): void => {
        for (const type of events) subscribedEvents.delete(type);
        safeSend({ type: 'unsubscribed', events: [...subscribedEvents] });
      };

      // Frame size is capped by the websocket plugin's `maxPayload`; the rate
      // is capped here so a flood of small frames cannot pin the event loop.
      socket.on('message', (raw) => {
        clientFramesThisInterval += 1;
        if (clientFramesThisInterval > MAX_CLIENT_FRAMES_PER_INTERVAL) {
          closeSocket(WS_CLOSE_POLICY_VIOLATION, 'too many frames');
          return;
        }
        let msg: { type?: unknown; events?: unknown };
        try {
          msg = JSON.parse(raw.toString()) as { type?: unknown; events?: unknown };
        } catch {
          return; // ignore malformed client frames
        }
        if (msg === null || typeof msg !== 'object') return;
        if (msg.type === 'pong') {
          lastPongAt = Date.now();
          return;
        }
        if (msg.type !== 'subscribe' && msg.type !== 'unsubscribe') return;
        const events = subscriptionEvents(msg.events);
        if (!events) return;
        if (msg.type === 'subscribe') subscribeEvents(events);
        else unsubscribeEvents(events);
      });

      socket.on('close', (code, reason) => {
        closed = true;
        clearInterval(pinger);
        clearInterval(revalidator);
        stopForwarding();
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
