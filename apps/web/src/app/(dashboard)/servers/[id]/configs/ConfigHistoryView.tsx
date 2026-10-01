'use client';
import {
  Button,
  CardHeader,
  DateTime,
  EmptyState,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import type { Version } from './config-model';
import { MonacoDiff } from './monaco';

export function HistoryView(props: {
  versions: Version[];
  loading: boolean;
  diffFrom: string | null;
  diffFromContent: string;
  currentContent: string;
  onOpenDiff: (vid: string) => void;
  onCloseDiff: () => void;
  onRestore: (vid: string) => void;
  restoring: string | null;
  /** `false` прячет «Восстановить»: API отвечает 400 на restore этого файла. */
  canRestore: boolean;
}) {
  const locale = useIntlLocale();
  if (props.diffFrom) {
    return (
      <div>
        <CardHeader
          title={`Сравнение: v${props.diffFrom.slice(0, 8)} → текущая`}
          actions={
            <Button size="sm" variant="ghost" onClick={props.onCloseDiff}>
              Закрыть сравнение
            </Button>
          }
        />
        <MonacoDiff
          height="65vh"
          language="ini"
          theme="vs-dark"
          original={props.diffFromContent}
          modified={props.currentContent}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            renderSideBySide: true,
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    );
  }

  if (props.loading && props.versions.length === 0) {
    return (
      <div className="p-4">
        <SkeletonTable rows={6} cols={5} label="Загружаем историю версий" />
      </div>
    );
  }

  if (props.versions.length === 0) {
    return (
      <EmptyState
        title="История пуста"
        description="Файл ещё ни разу не сохранялся через панель — первая версия появится после первого сохранения."
      />
    );
  }

  return (
    <Table dense maxHeight="68vh" ariaLabel="История версий файла">
      <TableHead>
        <TableRow>
          <Th>Когда</Th>
          <Th>Автор</Th>
          <Th>Сообщение</Th>
          <Th>SHA-256</Th>
          <Th align="right">Действия</Th>
        </TableRow>
      </TableHead>
      <TableBody>
        {props.versions.map((v) => (
          <TableRow key={v.id}>
            <Td className="whitespace-nowrap tabular-nums">
              <DateTime value={v.created_at} locale={locale} />
            </Td>
            <Td>{v.author_email ?? <span className="text-ink-3">—</span>}</Td>
            <Td>{v.message ?? <span className="text-ink-3">без сообщения</span>}</Td>
            <Td className="font-mono text-ink-3">{v.sha256?.slice(0, 12)}</Td>
            <Td align="right">
              <span className="flex items-center justify-end gap-1">
                <Button size="sm" variant="plain" onClick={() => props.onOpenDiff(v.id)}>
                  Сравнить
                </Button>
                {props.canRestore ? (
                  <Button
                    size="sm"
                    loading={props.restoring === v.id}
                    disabled={props.restoring !== null}
                    onClick={() => props.onRestore(v.id)}
                  >
                    Восстановить
                  </Button>
                ) : null}
              </span>
            </Td>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
