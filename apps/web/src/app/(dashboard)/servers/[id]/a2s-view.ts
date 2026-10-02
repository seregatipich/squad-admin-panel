import type { StatusState } from '@/components/ui';
import { formatDateTimeRu } from '@/lib/format';

/** The `a2s_status` of `GET /api/v1/servers/:id`: what worker-rcon cached for the query port. */
export interface A2sStatus {
  /** What the server reported; `null` when the query got no answer. */
  visible: boolean | null;
  server_name?: string;
  latency_ms?: number;
  reason?: string;
  queried_at?: string;
  last_success_at?: string | null;
}

export interface A2sView {
  state: StatusState;
  label: string;
  /** Second line of the row, e.g. when the query port last answered. */
  detail: string | null;
}

/**
 * How the query-port row shows the A2S check (#127).
 *
 * No answer from the query port is "запрос не отвечает" with the time of the
 * last answer, in the warning tone and never critical: the game process may
 * simply not service that UDP socket while RCON is connected and players play,
 * so it must not read as an offline or hidden server. Only an answer that says
 * the server is not visible is shown as hidden. A `visible: false` entry whose
 * reason is `timeout` was written by a worker that predates this and is treated
 * as no answer.
 *
 * @param status - the cached check, `null` when there is none yet
 * @returns the dot state, label and detail, or `null` when there is nothing to show
 */
export function a2sView(status: A2sStatus | null | undefined): A2sView | null {
  if (!status) return null;
  const unanswered =
    status.visible === null || (status.visible === false && status.reason === 'timeout');
  if (unanswered) {
    return {
      state: 'warn',
      label: 'запрос не отвечает',
      detail: status.last_success_at
        ? `последний ответ: ${formatDateTimeRu(status.last_success_at)}`
        : 'ответов не было',
    };
  }
  if (status.visible === false) {
    return { state: 'warn', label: 'скрыт в списке серверов', detail: null };
  }
  return { state: 'good', label: 'отвечает', detail: null };
}
