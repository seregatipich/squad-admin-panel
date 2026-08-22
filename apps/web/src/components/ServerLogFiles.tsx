'use client';

import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DateTime,
  EmptyState,
  InlineBanner,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';

interface LogFile {
  name: string;
  size: number;
  mtime: string;
  is_live: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`;
}

/**
 * Lists the on-disk `SquadGame*.log` files for a server (name, size, mtime,
 * a "live" badge on the active `SquadGame.log`) and offers a streaming download
 * of each one. Renders nothing when the current user lacks
 * `server:download_logs` — callers pass that as `canDownload` (from
 * `GET /api/v1/me`'s `permissions`).
 *
 * Скачивание — это обычная ссылка на маршрут API с атрибутом `download`, а не
 * кнопка и не `ButtonLink`: переход должен уйти в браузер, а не в
 * клиентскую навигацию Next.
 */
export function ServerLogFiles({
  serverId,
  canDownload,
}: {
  serverId: string;
  canDownload: boolean;
}) {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Счётчик повторов: «Повторить» перезапускает тот же эффект загрузки. */
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` не читается телом эффекта — он и есть кнопка «Повторить»: смена счётчика перезапускает загрузку
  useEffect(() => {
    if (!canDownload) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetch(`/api/v1/servers/${serverId}/logs/files`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { files: LogFile[] };
        if (!cancelled) {
          setFiles(body.files);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, canDownload, attempt]);

  if (!canDownload) return null;

  return (
    <Card as="section" padding="none">
      <CardHeader title="Логи" />
      {error ? (
        <div className="p-4">
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить список файлов"
            description={error}
            action={
              <Button onClick={() => setAttempt((n) => n + 1)} loading={loading}>
                Повторить
              </Button>
            }
          />
        </div>
      ) : loading ? (
        <div className="p-4">
          <SkeletonTable rows={3} cols={4} label="Загрузка списка файлов" />
        </div>
      ) : files.length === 0 ? (
        <EmptyState
          title="Нет файлов"
          description="Сервер ещё не записал ни одного файла журнала."
        />
      ) : (
        <Table>
          <TableHead>
            <tr>
              <Th>Файл</Th>
              <Th align="right">Размер</Th>
              <Th>Изменён</Th>
              <Th align="right">
                <span className="sr-only">Скачивание</span>
              </Th>
            </tr>
          </TableHead>
          <TableBody>
            {files.map((f) => (
              <TableRow key={f.name}>
                <Td className="font-mono text-xs">
                  {f.name}
                  {f.is_live ? (
                    <span className="ml-2 align-middle">
                      <Badge tone="good" size="sm">
                        пишется
                      </Badge>
                    </span>
                  ) : null}
                </Td>
                <Td numeric className="text-ink-2">
                  {formatSize(f.size)}
                </Td>
                <Td className="whitespace-nowrap text-ink-2">
                  <DateTime value={f.mtime} locale="ru-RU" />
                </Td>
                <Td align="right">
                  <a
                    href={`/api/v1/servers/${serverId}/logs/files/${encodeURIComponent(f.name)}/download`}
                    download
                    className="text-accent transition-colors duration-150 hover:brightness-110"
                  >
                    Скачать
                  </a>
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
