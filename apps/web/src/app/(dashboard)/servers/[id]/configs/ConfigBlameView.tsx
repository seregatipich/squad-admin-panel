'use client';
import {
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
import { useIntlLocale } from '@/i18n/LocaleProvider';
import type { BlameResponse } from './config-model';

export function BlameView({ blame }: { blame: BlameResponse | null }) {
  const locale = useIntlLocale();
  if (!blame) {
    return (
      <div className="p-4">
        <SkeletonTable rows={8} cols={5} label="Загружаем авторство строк" />
      </div>
    );
  }
  if (blame.lines.length === 0) {
    return (
      <EmptyState
        title="Авторства нет"
        description="У файла нет ни одной версии в панели, поэтому и приписать строки некому."
      />
    );
  }
  return (
    <>
      {blame.truncated ? (
        <InlineBanner
          tone="info"
          title="Показаны только последние версии файла"
          description="Строки из более ранних правок приписаны самой старой из показанных версий."
        />
      ) : null}
      <Table dense layout="fixed" maxHeight="68vh" ariaLabel="Авторство строк файла">
        <TableHead>
          <TableRow>
            <Th width="7rem">Версия</Th>
            <Th width="10rem">Автор</Th>
            <Th width="9rem">Когда</Th>
            <Th width="4rem" align="right">
              Строка
            </Th>
            <Th>Текст</Th>
          </TableRow>
        </TableHead>
        <TableBody>
          {blame.lines.map((l, i) => {
            const email = l.author_user_id ? (blame.authors[l.author_user_id] ?? '?') : '—';
            return (
              <TableRow key={`${l.version_id}-${i}`}>
                <Td truncate className="font-mono text-ink-3">
                  {l.version_id.slice(0, 8)}
                </Td>
                <Td truncate className="text-ink-2">
                  {email}
                </Td>
                <Td className="whitespace-nowrap tabular-nums text-ink-3">
                  <time dateTime={l.created_at} suppressHydrationWarning>
                    {new Date(l.created_at).toLocaleDateString(locale)}
                  </time>
                </Td>
                <Td numeric className="text-ink-3">
                  {i + 1}
                </Td>
                <Td className="whitespace-pre font-mono">{l.text || ' '}</Td>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
