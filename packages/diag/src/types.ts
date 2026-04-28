export type DiagSeverity = 'info' | 'warn' | 'error' | 'fatal';

export interface DiagEvent {
  component: string;
  kind: string;
  severity: DiagSeverity;
  serverId?: string;
  actorSteamId64?: string;
  requestId?: string;
  message: string;
  payload?: Record<string, unknown>;
}

export const DIAG_STREAM_KEY = 'diag:queue';
export const DIAG_STREAM_MAXLEN = 100_000;
