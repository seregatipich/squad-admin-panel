import { type EventEnvelope, STREAM_NAME } from '@squad/shared-types';
import { v7 as uuidv7 } from 'uuid';
import type { SupervisorOptions, Target } from './types.js';

/** Emits one server's `worker-rcon` diagnostics and its lifecycle events on the server's stream. */
export class ServerEvents {
  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
  ) {}

  async emitDiag(args: {
    kind: string;
    severity: 'info' | 'warn' | 'error' | 'fatal';
    message: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.opts.diag) return;
    try {
      await this.opts.diag.emit({
        component: 'worker-rcon',
        kind: args.kind,
        severity: args.severity,
        serverId: this.target.serverId,
        message: args.message,
        payload: args.payload,
      });
    } catch {
      // diag is fire-and-forget; do not let telemetry derail the supervisor
    }
  }

  async emitEvent(type: EventEnvelope['type'], payload: Record<string, unknown>): Promise<void> {
    const envelope: EventEnvelope = {
      event_id: uuidv7(),
      version: 1,
      type,
      server_id: this.target.serverId,
      ts: new Date().toISOString(),
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload,
    };
    try {
      await this.opts.redis.xadd(
        STREAM_NAME.eventsServer(this.target.serverId),
        'MAXLEN',
        '~',
        '10000',
        '*',
        'envelope',
        JSON.stringify(envelope),
      );
    } catch (err) {
      this.opts.log.warn({ err: (err as Error).message, type }, 'event publish failed');
    }
  }
}
