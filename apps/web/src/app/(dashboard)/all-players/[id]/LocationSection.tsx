'use client';

import {
  Card,
  CardBody,
  CardHeader,
  DateTime,
  EmptyState,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { GeoAnomaliesSection } from './GeoAnomaliesSection';
import { flagEmoji } from './geo';
import type { CountryLocation, IpHistory } from './player-detail';

function locationLabel(ip: IpHistory): string {
  const parts = [ip.country_name ?? ip.country_code].filter(Boolean) as string[];
  const detail = [ip.region, ip.city].filter(Boolean) as string[];
  const head = parts.join('');
  const tail = detail.length > 0 ? ` − ${detail.join(' / ')}` : '';
  const tz = ip.timezone_offset ? ` (${ip.timezone_offset})` : '';
  return `${head}${tail}${tz}`;
}

/** Location card: current and earlier IPs with geo labels, or the country list when IPs are hidden. */
export function LocationSection({
  playerId,
  ips,
  locations,
  ipsVisible,
  geoConfigured,
}: {
  playerId: string;
  ips: IpHistory[];
  locations: CountryLocation[];
  ipsVisible: boolean;
  geoConfigured: boolean;
}) {
  const locale = useIntlLocale();
  if (!ipsVisible) {
    return (
      <Card as="section" padding="none">
        <CardHeader
          title="Локация"
          description="IP и точная локация доступны только пользователям с доступом к панели."
        />
        {locations.length === 0 ? (
          <EmptyState
            title="Нет данных о локации"
            description="Панель не определила ни одной страны для этого игрока."
          />
        ) : (
          <CardBody>
            <ul className="space-y-1 text-[13px]">
              {locations.map((loc) => (
                <li key={loc.country_code} className="flex items-center gap-2">
                  <span aria-hidden="true">{flagEmoji(loc.country_code)}</span>
                  <span>{loc.country_name ?? loc.country_code}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        )}
      </Card>
    );
  }

  const current = ips[0] ?? null;
  const others = ips.slice(1);

  return (
    <Card as="section" padding="none">
      <CardHeader title="Локация" count={ips.length > 0 ? ips.length : undefined} />

      <CardBody className="space-y-6">
        {current === null ? (
          <EmptyState
            title="Локаций пока нет"
            description="Панель не записала ни одного подключения этого игрока."
          />
        ) : (
          <div className="space-y-1">
            <p className="text-2xs uppercase tracking-[0.06em] text-ink-3">Текущая</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <span aria-hidden="true" className="text-lg leading-none">
                {flagEmoji(current.country_code)}
              </span>
              {current.country_code ? (
                <span className="font-medium">{locationLabel(current)}</span>
              ) : (
                <span className="text-warn">
                  гео недоступно
                  {geoConfigured ? '' : ': добавьте MaxMind ключ в настройках'}
                </span>
              )}
              <span className="font-mono text-ink-2">{current.ip}</span>
              <DateTime value={current.last_seen_at} locale={locale} className="text-ink-3" />
              <span className="font-mono tabular-nums text-ink-3">
                ×{current.observation_count}
              </span>
            </div>
          </div>
        )}

        {others.length > 0 ? (
          <div className="space-y-2">
            <p className="text-2xs uppercase tracking-[0.06em] text-ink-3">Другие локации</p>
            <Table ariaLabel="Другие локации игрока">
              <TableHead sticky={false}>
                <tr>
                  <Th>Локация</Th>
                  <Th>IP</Th>
                  <Th align="right">Заходов</Th>
                  <Th>Последний раз</Th>
                </tr>
              </TableHead>
              <TableBody>
                {others.map((ip) => (
                  <TableRow key={ip.ip}>
                    <Td>
                      <span aria-hidden="true" className="mr-1">
                        {flagEmoji(ip.country_code)}
                      </span>
                      {ip.country_code ? (
                        locationLabel(ip)
                      ) : (
                        <span className="text-warn">
                          гео недоступно
                          {geoConfigured ? '' : ': добавьте MaxMind ключ'}
                        </span>
                      )}
                    </Td>
                    <Td className="font-mono">{ip.ip}</Td>
                    <Td numeric>{ip.observation_count}</Td>
                    <Td className="text-xs text-ink-3">
                      <DateTime value={ip.last_seen_at} locale={locale} />
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        <GeoAnomaliesSection playerId={playerId} />
      </CardBody>
    </Card>
  );
}
