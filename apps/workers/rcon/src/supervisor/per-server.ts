import { type ChatInput, handleChat } from '@squad/chat-ingest';
import { RCON_CHAT_STREAM_MAXLEN, type RconChatEntry, rconChatStream } from '@squad/shared-types';
import { parseRconChatLine } from '../chat.js';
import { RconClient } from '../client.js';
import { parseSquadCreatedBroadcast } from '../squad-broadcast.js';
import { ServerPoller } from './server-poller.js';
import type { SupervisorOptions, Target } from './types.js';

/**
 * The connection lifecycle of one server: dials RCON, hands the live
 * connection to {@link ServerPoller}, and redials with backoff when it drops
 * until `stop()` is called.
 */
export class PerServerSupervisor extends ServerPoller {
  private backoffMs: number;
  /** The in-flight `connectLoop()` call; `stop()` awaits it so a replacement supervisor never races its teardown. */
  private connectLoopPromise?: Promise<void>;
  /**
   * Resolved once, by `stop()`, and raced against both the connected-session
   * wait and the reconnect backoff sleep so `stop()` interrupts either at once
   * instead of leaving the loop pending for up to `maxBackoffMs` (#982).
   */
  private readonly stopSignal: Promise<void>;
  private resolveStopSignal!: () => void;
  /** Serialises chat ingestion for this server; see {@link ingestBroadcast}. */
  private chatQueue: Promise<void> = Promise.resolve();

  constructor(target: Target, opts: SupervisorOptions) {
    super(target, opts);
    this.backoffMs = opts.initialBackoffMs ?? 1000;
    this.stopSignal = new Promise((resolve) => {
      this.resolveStopSignal = resolve;
    });
  }

  async start(): Promise<void> {
    await this.seeding.loadPriorSeedingState();
    await this.squadHistory.loadPriorCrowns();
    this.connectLoopPromise = this.connectLoop().catch((err) =>
      this.opts.log.error(
        { err: (err as Error).message, serverId: this.target.serverId },
        'supervisor failed',
      ),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Wakes connectLoop at once, whether it holds a live session or sleeps in
    // backoff, and waits for its own teardown (closing sessions, writing the
    // 'disconnected' status). Otherwise a caller that reconciles by starting a
    // fresh supervisor for the same server could see this one's late
    // 'disconnected' write overwrite the new 'connected' one (#982).
    this.resolveStopSignal();
    await this.connectLoopPromise?.catch(() => undefined);
    // No-ops on the ordinary path (the loop's finally already did this); the
    // net for stop() before start() ever ran the loop.
    this.clearTimers();
    await this.adminQueue.stop();
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    // The connect loop's own teardown normally closes the sessions, but a poll
    // still in flight when stop() was called can reopen them right after it.
    // Closing again here — after `stopped` has blocked further reconciles —
    // makes sure a server removed from the targets does not leave sessions
    // open forever with nothing left to poll them shut.
    await this.closeOpenSessions();
  }

  /**
   * Handle one unsolicited RCON packet.
   *
   * A squad-creation notice is queued for the next roster refresh, which dates
   * the new squad by it (see {@link SquadHistory.trackSquads}). Squad delivers in-game chat
   * only this way (it is not in SquadGame.log), so this is the sole live-chat
   * producer for a running server. Other broadcasts (admin camera, kicks)
   * parse to null and are ignored.
   *
   * Chat ingestion is queued rather than fired off per packet: each message
   * costs several identity queries plus an insert, and a chat flood would
   * otherwise open them all at once and let the archive rows land out of
   * order. The queue is per server and never awaited by the caller, so a slow
   * database cannot stall the socket's read loop or the poll timers.
   */
  private ingestBroadcast(body: string): void {
    const receivedAt = new Date().toISOString();
    const squadCreated = parseSquadCreatedBroadcast(body, receivedAt);
    if (squadCreated) {
      this.squadHistory.queueBroadcast(squadCreated);
      return;
    }
    const chat = parseRconChatLine(body, receivedAt);
    if (!chat) return;
    this.chatQueue = this.chatQueue
      .then(() => this.publishChatFeed(chat))
      .then(() =>
        handleChat(
          this.opts.db,
          this.opts.redis,
          {
            serverId: this.target.serverId,
            chat,
            source: 'rcon',
            onArchiveError: (err) =>
              this.opts.log.warn(
                { err: err.message, serverId: this.target.serverId },
                'rcon chat archive insert failed',
              ),
            onPublishError: (err) =>
              this.opts.log.warn(
                { err: err.message, serverId: this.target.serverId },
                'rcon chat live publish failed',
              ),
            onFlagError: (err) =>
              this.opts.log.warn(
                { err: err.message, serverId: this.target.serverId },
                'rcon chat flag detection failed',
              ),
            playerIds: this.opts.playerIds,
          },
          this.opts.chatFlagDetector ?? null,
        ),
      )
      .then(
        () => undefined,
        (err: Error) =>
          this.opts.log.warn(
            { err: err.message, serverId: this.target.serverId },
            'rcon chat ingest failed',
          ),
      );
  }

  /**
   * Hands one chat line to worker-log-ingest, which owns everything that reacts
   * to chat: `!stats` / `!rules` / `!report` answers, `chat_keyword`
   * automations and report records (#2). Squad never writes chat to the log, so
   * without this feed none of them can fire. Best-effort and independent of the
   * archive insert: a failure here costs the reactions to one line, never its
   * archive row, and the reverse.
   */
  private async publishChatFeed(chat: ChatInput): Promise<void> {
    const entry: RconChatEntry = {
      v: 1,
      ts: chat.ts,
      channel: chat.channel,
      eos_id: chat.eosId,
      steam_id64: chat.steamId64,
      player_name: chat.playerName,
      message: chat.message,
    };
    try {
      await this.opts.redis.xadd(
        rconChatStream(this.target.serverId),
        'MAXLEN',
        '~',
        String(RCON_CHAT_STREAM_MAXLEN),
        '*',
        'entry',
        JSON.stringify(entry),
      );
    } catch (err) {
      this.opts.log.warn(
        { err: (err as Error).message, serverId: this.target.serverId },
        'rcon chat feed publish failed',
      );
    }
  }

  /** Sleeps `ms`, or returns once `stop()` fires; the timer never outlives the call. */
  private async sleepOrStop(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
        this.stopSignal,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      let lastDisconnectReason: string | undefined;
      try {
        await this.publisher.writeStatus('connecting', { backoffMs: this.backoffMs });
        const disconnected = new Promise<void>((resolve) => {
          this.onDisconnect = resolve;
        });
        this.client = new RconClient({
          host: this.target.host,
          port: this.target.port,
          password: this.target.password,
          refuseRestrictedAddresses: this.target.refuseRestrictedAddresses,
          privateHostAllowlist: this.target.privateHostAllowlist,
          log: this.opts.log.child({ serverId: this.target.serverId }),
          onDisconnect: (reason) => {
            this.opts.log.warn(
              { serverId: this.target.serverId, reason },
              'rcon client disconnected',
            );
            lastDisconnectReason = reason;
            this.onDisconnect?.();
          },
          onBroadcast: (body) => this.ingestBroadcast(body),
        });
        await this.client.connect();
        this.opts.log.info(
          {
            serverId: this.target.serverId,
            host: this.target.host,
            port: this.target.port,
          },
          'connect: rcon authenticated',
        );
        this.backoffMs = this.opts.initialBackoffMs ?? 1000;
        this.lastKitAccrualAt = null;
        // Squads may have changed while the connection was down: the first
        // refresh on this connection is a baseline, never a burst of events.
        this.squadHistory.resetBaseline();
        await this.events.emitEvent('rcon.connected', {});
        await this.events.emitDiag({
          kind: 'rcon.connected',
          severity: 'info',
          message: `rcon connected ${this.target.host}:${this.target.port}`,
          payload: { host: this.target.host, port: this.target.port },
        });
        await this.publisher.writeStatus('connected');
        await this.adminQueue.start();
        this.schedulePoll();
        this.scheduleRosterRefresh();
        this.scheduleInfoRefresh();
        // Fill the roster and server info right away instead of leaving the
        // panel empty until the first timer tick.
        this.requestRefresh(['roster', 'info']);
        // The stop signal replaces a per-connection 1s polling interval that
        // was never cleared on an ordinary disconnect and leaked one timer per
        // reconnect (#983).
        await Promise.race([disconnected, this.stopSignal]);
      } catch (err) {
        const msg = (err as Error).message;
        this.opts.log.warn(
          {
            err: msg,
            serverId: this.target.serverId,
            backoffMs: this.backoffMs,
          },
          'rcon connect failed',
        );
        this.opts.log.warn(
          {
            serverId: this.target.serverId,
            backoffMs: this.backoffMs,
          },
          `reconnect in ${this.backoffMs}ms`,
        );
        if (msg === 'rcon auth rejected' || msg === 'rcon auth timeout') {
          await this.events.emitDiag({
            kind: 'rcon.auth_failed',
            severity: 'error',
            message: 'rcon auth failed',
            payload: { host: this.target.host, port: this.target.port, err: msg },
          });
        }
        lastDisconnectReason = msg;
      } finally {
        this.clearTimers();
        await this.adminQueue.stop();
        await this.client?.close().catch(() => undefined);
        this.client = undefined;
        await this.closeOpenSessions();
        await this.events.emitEvent('rcon.disconnected', {});
        await this.events.emitDiag({
          kind: 'rcon.disconnected',
          severity: 'warn',
          message: `rcon disconnected: ${lastDisconnectReason ?? 'unknown'}`,
          payload: {
            host: this.target.host,
            port: this.target.port,
            reason: lastDisconnectReason ?? 'unknown',
          },
        });
      }
      if (!this.stopped) {
        // Stay in 'connecting' (not 'disconnected') during backoff so the
        // panel UI shows the amber dot continuously instead of flashing red
        // between retries. Retry attempts are expected transient.
        await this.publisher.writeStatus('connecting', {
          backoffMs: this.backoffMs,
          reason: 'reconnect-backoff',
        });
        await this.events.emitDiag({
          kind: 'rcon.reconnect_attempt',
          severity: 'warn',
          message: `reconnect in ${this.backoffMs}ms`,
          payload: {
            host: this.target.host,
            port: this.target.port,
            backoffMs: this.backoffMs,
          },
        });
        await this.sleepOrStop(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 60_000);
      } else {
        await this.publisher.writeStatus('disconnected', { reason: 'supervisor-stopped' });
      }
    }
  }
}
