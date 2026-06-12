import type { EventEmitter } from 'node:events';
import { startPanelBridge } from './index';

interface UpstreamRconEmitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface UpstreamState {
  listener: EventEmitter;
  execute: (command: string) => Promise<string>;
  logger?: { log: (...text: string[]) => void };
  id?: unknown;
  rcon?: { rconEmitter?: UpstreamRconEmitter };
}

const resolveServerId = (state: UpstreamState): string => {
  if (typeof state.id === 'string' && state.id.length > 0) return state.id;
  if (typeof state.id === 'number' && Number.isFinite(state.id)) return String(state.id);
  const fromEnv = process.env.SERVER_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  throw new Error(
    '[panelBridge] cannot resolve serverId: state.id is empty and SERVER_ID is unset',
  );
};

export const panelBridge = (state: UpstreamState, _options: Record<string, unknown>): void => {
  const log = (message: string): void => {
    if (state.logger && typeof state.logger.log === 'function') {
      state.logger.log(message);
      return;
    }
    console.log(message);
  };

  const serverId = resolveServerId(state);

  const rconExec = (method: string, args: unknown[]): Promise<string> =>
    state.execute([method, ...args.map((arg) => String(arg))].join(' '));

  // Status wiring (rnsquadjs:status, non-load-bearing per D4): the only reliable
  // RCON connection signal is the squad-rcon instance at state.rcon.rconEmitter,
  // which emits raw 'connected'/'close' lifecycle events. These are NOT forwarded
  // onto state.listener, so we subscribe to the rcon emitter directly. Plugins
  // initialize only after initServer awaits rcon.init(), so the connection is
  // already established when this runs — we seed an initial 'connected'.
  const onStatus = (
    onChange: (status: 'connected' | 'disconnected') => void,
  ): (() => void) | undefined => {
    const emitter = state.rcon?.rconEmitter;
    if (!emitter || typeof emitter.on !== 'function' || typeof emitter.off !== 'function') {
      return undefined;
    }
    const handleConnected = (): void => onChange('connected');
    const handleClose = (): void => onChange('disconnected');
    emitter.on('connected', handleConnected);
    emitter.on('close', handleClose);
    onChange('connected');
    return () => {
      emitter.off('connected', handleConnected);
      emitter.off('close', handleClose);
    };
  };

  void startPanelBridge({
    serverId,
    emitter: state.listener,
    rconExec,
    onStatus,
  }).catch((error: unknown) => {
    log(`[panelBridge] failed to start: ${String(error)}`);
  });
};
