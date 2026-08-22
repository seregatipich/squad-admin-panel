'use client';

import { StatusDot } from '@/components/ui';

interface Props {
  a2sStatus: {
    visible: boolean;
    server_name?: string;
    latency_ms?: number;
    reason?: string;
  } | null;
  serverStatus: string;
}

/**
 * Виден ли сервер в браузере серверов Steam.
 *
 * Раньше состояние читалось только по цвету глифа и сокращению «!Steam»:
 * отрицание одним восклицательным знаком не различается ни при беглом
 * просмотре, ни при дальтонизме. Теперь состояние названо словами (§5), а
 * задержка и причина остаются во всплывающей подсказке.
 */
export function A2SIndicator({ a2sStatus, serverStatus }: Props) {
  if (!['running', 'starting'].includes(serverStatus)) return null;
  if (!a2sStatus) return null;

  const visible = a2sStatus.visible;

  return (
    <span
      title={
        visible
          ? `Виден в Steam Browser (${a2sStatus.latency_ms ?? '?'}ms)`
          : `Не виден в Steam Browser${a2sStatus.reason ? `: ${a2sStatus.reason}` : ''}`
      }
    >
      <StatusDot
        state={visible ? 'good' : 'crit'}
        label={visible ? 'Виден в Steam' : 'Не виден в Steam'}
      />
    </span>
  );
}
