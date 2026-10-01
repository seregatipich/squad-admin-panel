import type { ChatFlagDetector, PlayerIdCache } from '@squad/chat-ingest';
import type { DatabaseClient } from '@squad/db';
import type { Diag } from '@squad/diag';
import type { HostCidr } from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

export interface Target {
  serverId: string;
  host: string;
  port: number;
  queryPort: number;
  tickrate?: number;
  seedLiveAt?: number;
  seedHysteresis?: number;
  password: string;
  /**
   * The host is operator-supplied (an external server), so the client must
   * refuse loopback/link-local addresses — see `RconClientOptions`.
   */
  refuseRestrictedAddresses?: boolean;
  /** Private LAN ranges an external host may be in; see `RconClientOptions`. */
  privateHostAllowlist?: readonly HostCidr[] | null;
}

export interface SupervisorOptions {
  db: DatabaseClient;
  redis: Redis;
  log: Logger;
  diag?: Diag;
  pollIntervalMs?: number;
  /**
   * Cadence of the light roster refresh (`ListPlayers` + `ListSquads` only).
   * Defaults to 2s: the panel's live roster is redrawn from the event this
   * refresh publishes, so it is what "the list is live" actually costs.
   * Joins and leaves arrive faster still, through {@link PerServerSupervisor.requestRefresh}.
   */
  rosterIntervalMs?: number;
  /**
   * Cadence of the server-info refresh (`ShowServerInfo` + `ShowNextMap`):
   * map, next layer, mode, queue and tickrate. Defaults to 5s. It touches
   * neither the database nor A2S — those stay on the full `pollIntervalMs` tick.
   */
  infoIntervalMs?: number;
  /** Coalescing window for refresh hints; defaults to 100ms. */
  hintDebounceMs?: number;
  /** Delay of the single repeat after a hinted roster refresh; defaults to 1.5s. */
  hintFollowUpMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Profanity/flag matcher applied to incoming chat (CHATLOG-5). Shared across
   * every supervisor so the rule cache is loaded once.
   */
  chatFlagDetector?: ChatFlagDetector | null;
  /**
   * Sender cache for chat identity lookups, shared across every supervisor.
   * Without one, every chat line runs the identity queries.
   */
  playerIds?: PlayerIdCache;
}
