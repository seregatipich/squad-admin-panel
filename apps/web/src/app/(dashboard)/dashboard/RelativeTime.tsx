'use client';
import { useEffect, useState } from 'react';
import { DateTime, type RelativeLabels } from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';

const RELATIVE_LABELS: RelativeLabels = {
  justNow: 'только что',
  secondsAgo: (n) => `${n} с назад`,
  minutesAgo: (n) => `${n} мин назад`,
  hoursAgo: (n) => `${n} ч назад`,
  daysAgo: (n) => `${n} д назад`,
};

/** Относительное время, которое пересчитывается раз в пять секунд. */
export function RelativeTime({ ts }: { ts: string }) {
  const locale = useIntlLocale();
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <DateTime
      value={ts}
      locale={locale}
      mode="relative"
      now={now}
      relativeLabels={RELATIVE_LABELS}
      fallback="—"
    />
  );
}
