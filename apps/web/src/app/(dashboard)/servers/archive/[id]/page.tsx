'use client';
import { use, useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  EmptyState,
  GroupedList,
  GroupedRow,
  InlineBanner,
  Modal,
  PageContainer,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';

interface ArchiveServer {
  id: string;
  display_name: string;
  slug: string;
  description: string | null;
  deleted_at: string;
  deleted_by_steam_id64: string | null;
  deletion_backup_marker_id: string | null;
  tags: string[] | null;
}

interface ArchiveSettings {
  install_path: string;
  game_port: number;
  query_port: number;
  beacon_port: number;
  rcon_port: number;
  max_players: number;
  tickrate: number;
  multihome: string | null;
}

interface BackupRow {
  id: string;
  filename: string;
  sha256_hex: string;
  message: string | null;
  created_at: string;
  author_steam_id64: string | null;
  author_label: string | null;
}

interface ArchiveDetail {
  server: ArchiveServer;
  settings: ArchiveSettings | null;
  backups: BackupRow[];
}

interface BackupContent {
  id: string;
  filename: string;
  content: string;
  sha256_hex: string;
  created_at: string;
  message: string | null;
}

export default function ArchiveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<ArchiveDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<BackupContent | null>(null);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);

  /**
   * Признак «этот ответ уже никому не нужен» приходит параметром, а не живёт
   * в замыкании эффекта: тот же запрос запускает и кнопка «Повторить», у
   * которой отменять нечего.
   */
  const loadArchive = useCallback(
    async (isStale: () => boolean = () => false) => {
      try {
        const r = await fetch(`/api/v1/servers/archive/${id}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as ArchiveDetail;
        if (!isStale()) {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (!isStale()) setErr((e as Error).message);
      }
    },
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    void loadArchive(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadArchive]);

  async function viewFile(filename: string) {
    setLoadingFile(filename);
    try {
      const r = await fetch(
        `/api/v1/servers/archive/${id}/configs/${encodeURIComponent(filename)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as BackupContent;
      setOpenFile(body);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingFile(null);
    }
  }

  const server = data?.server;
  const settings = data?.settings ?? null;
  const backups = data?.backups ?? [];

  return (
    <PageContainer width="wide">
      <PageHeader
        title={server ? server.display_name : 'Сервер из архива'}
        backHref="/servers/archive"
        backLabel="К архиву"
        status={<Badge>В архиве</Badge>}
        meta={
          server ? (
            <>
              <span className="font-mono">{server.id}</span>
              <span>
                Удалён {new Date(server.deleted_at).toLocaleString()}
                {server.deleted_by_steam_id64 ? ` · ${server.deleted_by_steam_id64}` : ''}
              </span>
            </>
          ) : undefined
        }
        actions={
          server ? (
            <ButtonLink href={`/servers/archive/${server.id}/restore`} variant="primary">
              Восстановить сервер
            </ButtonLink>
          ) : undefined
        }
      />

      {err && (
        <InlineBanner
          tone="crit"
          title="Не удалось получить запись архива"
          description={err}
          action={
            <Button
              onClick={() => {
                void loadArchive();
              }}
            >
              Повторить
            </Button>
          }
        />
      )}

      {!data ? (
        err ? null : (
          <Skeleton variant="card" count={2} label="Загружается запись архива" />
        )
      ) : (
        <>
          <GroupedList title="Параметры">
            <GroupedRow label="Идентификатор" control={<Value>{server?.slug}</Value>} />
            {settings ? (
              <>
                <GroupedRow label="Порт Game" control={<Value>{settings.game_port}</Value>} />
                <GroupedRow label="Порт Query" control={<Value>{settings.query_port}</Value>} />
                <GroupedRow label="Порт Beacon" control={<Value>{settings.beacon_port}</Value>} />
                <GroupedRow label="Порт RCON" control={<Value>{settings.rcon_port}</Value>} />
                <GroupedRow label="Макс. игроков" control={<Value>{settings.max_players}</Value>} />
                <GroupedRow label="Тикрейт" control={<Value>{settings.tickrate}</Value>} />
              </>
            ) : (
              <GroupedRow label="Настройки не сохранились" />
            )}
          </GroupedList>

          <Card padding="none" as="section">
            <CardHeader title="Бэкап конфигов" count={backups.length} />
            {backups.length === 0 ? (
              <EmptyState
                title="Бэкап пуст"
                description="Конфиги не сохранились перед удалением сервера."
              />
            ) : (
              <Table ariaLabel="Файлы конфигов из бэкапа">
                <TableHead>
                  <tr>
                    <Th>Файл</Th>
                    <Th>SHA-256</Th>
                    <Th>Сообщение</Th>
                    <Th>Сохранён</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {backups.map((b) => (
                    <TableRow key={b.id}>
                      <Td>
                        <Button
                          variant="plain"
                          size="sm"
                          className="font-mono"
                          loading={loadingFile === b.filename}
                          onClick={() => viewFile(b.filename)}
                        >
                          {b.filename}
                        </Button>
                      </Td>
                      <Td className="font-mono text-2xs text-ink-3">{b.sha256_hex.slice(0, 12)}</Td>
                      <Td className="text-xs text-ink-2">{b.message ?? '—'}</Td>
                      <Td className="text-xs text-ink-3">
                        {new Date(b.created_at).toLocaleString()}
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}

      <Modal
        open={openFile !== null}
        onClose={() => setOpenFile(null)}
        size="lg"
        title={openFile?.filename ?? ''}
        description={openFile ? `SHA-256: ${openFile.sha256_hex.slice(0, 12)}` : undefined}
        closeLabel="Закрыть просмотр файла"
        footer={<Button onClick={() => setOpenFile(null)}>Закрыть</Button>}
      >
        <pre className="whitespace-pre-wrap break-all font-mono text-xs">{openFile?.content}</pre>
      </Modal>
    </PageContainer>
  );
}

/** Правая часть строки параметров: значение набирается моноширинным. */
function Value({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs text-ink-2">{children}</span>;
}
