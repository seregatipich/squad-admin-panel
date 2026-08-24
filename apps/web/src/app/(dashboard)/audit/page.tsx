'use client';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  DateTime,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  SearchField,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';

interface AuditEntry {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  actor_kind: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  status_code: number | null;
  duration_ms: number | null;
  context: Record<string, unknown>;
  row_hash?: string | null;
  prev_hash?: string | null;
}

interface VerifyChainResult {
  ok: boolean;
  checked: number;
  broken_at: string | null;
  reason: 'prev_hash' | 'row_hash' | null;
}

const POLL_MS = 6000;

export default function AuditPage() {
  const locale = useIntlLocale();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyChainResult | null>(null);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);

  async function verifyChain() {
    setVerifying(true);
    setVerifyErr(null);
    setVerifyResult(null);
    try {
      const r = await fetch('/api/v1/audit/verify-chain', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setVerifyResult((await r.json()) as VerifyChainResult);
    } catch (e) {
      setVerifyErr((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  // Вынесено из эффекта, чтобы «Повторить» на полосе ошибки звало ровно тот же
  // запрос, что и опрос по таймеру, а не его копию.
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/audit?page=1&page_size=200', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { items: AuditEntry[] };
      setItems(j.items);
      setErr(null);
      setLastUpdate(new Date());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (r) =>
        r.action_type.toLowerCase().includes(needle) ||
        (r.target_type ?? '').toLowerCase().includes(needle) ||
        (r.target_id ?? '').toLowerCase().includes(needle) ||
        (r.actor_user_id ?? '').toLowerCase().includes(needle),
    );
  }, [items, q]);

  return (
    <PageContainer>
      <PageHeader
        title="Журнал действий"
        subtitle="Последние 200 записей о действиях операторов и системы."
        status={<LiveIndicator lastUpdate={lastUpdate} />}
        meta={<span>Записей: {items.length}</span>}
        actions={
          <Button onClick={verifyChain} loading={verifying}>
            Проверить цепочку
          </Button>
        }
      />

      {err ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить журнал"
          description={err}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {verifyErr ? (
        <InlineBanner
          tone="crit"
          title={`Проверка цепочки не удалась: ${verifyErr}`}
          action={
            <Button size="sm" onClick={verifyChain} loading={verifying}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {verifyResult ? (
        verifyResult.ok ? (
          <InlineBanner
            tone="good"
            title={`Цепочка цела: проверено записей — ${verifyResult.checked}.`}
          />
        ) : (
          <InlineBanner
            tone="crit"
            title={`Обнаружен разрыв цепочки на записи #${verifyResult.broken_at} (${verifyResult.reason}).`}
            description={`Проверено до разрыва — ${verifyResult.checked}.`}
          />
        )
      ) : null}

      <Toolbar
        search={
          <SearchField
            value={q}
            onCommit={setQ}
            placeholder="Фильтр по действию, цели или актору…"
            label="Фильтр записей журнала"
            clearLabel="Очистить фильтр"
          />
        }
        summary={`Показано: ${rows.length} из ${items.length}`}
      />

      <Card padding="none">
        {!loaded ? (
          <div className="p-4">
            <SkeletonTable rows={8} cols={6} label="Журнал загружается" />
          </div>
        ) : rows.length === 0 ? (
          items.length ? (
            <EmptyState
              variant="filtered"
              title="Нет совпадений."
              description="Под этот фильтр не подходит ни одна запись журнала."
              action={
                <Button size="sm" onClick={() => setQ('')}>
                  Сбросить фильтр
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="Журнал пуст."
              description="Записи появляются сами, как только оператор или система что-то делает."
            />
          )
        ) : (
          <Table dense maxHeight="68vh" ariaLabel="Журнал действий">
            <TableHead>
              <TableRow>
                <Th>Время</Th>
                <Th>Кто</Th>
                <Th>Действие</Th>
                <Th>Цель</Th>
                <Th align="right">Код</Th>
                <Th align="right">Длительность, мс</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const open = expanded === r.id;
                const detailId = `audit-detail-${r.id}`;
                return (
                  <Fragment key={r.id}>
                    <TableRow interactive>
                      <Td className="whitespace-nowrap text-xs text-ink-3">
                        <DateTime value={r.created_at} locale={locale} />
                      </Td>
                      <Td className="font-mono text-xs">
                        {r.actor_kind === 'user'
                          ? (r.actor_user_id?.slice(0, 8) ?? '—')
                          : r.actor_kind}
                      </Td>
                      {/* Раскрытие подробностей — кнопка внутри ячейки, а не
                          `onClick` на строке: иначе до записи не добраться с
                          клавиатуры и скринридер не объявит её раскрытой. */}
                      <Td className="p-0!">
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : r.id)}
                          aria-expanded={open}
                          aria-controls={detailId}
                          className="flex h-7 w-full items-center px-3 text-left font-mono transition-colors hover:text-accent"
                        >
                          {r.action_type}
                        </button>
                      </Td>
                      <Td className="font-mono text-xs text-ink-2">
                        {r.target_type
                          ? `${r.target_type} ${r.target_id?.slice(0, 12) ?? ''}`
                          : '—'}
                      </Td>
                      <Td align="right">
                        <StatusCode code={r.status_code} />
                      </Td>
                      <Td numeric className="text-xs text-ink-3">
                        {r.duration_ms ?? '—'}
                      </Td>
                    </TableRow>
                    {open ? (
                      <tr id={detailId}>
                        <td colSpan={6} className="bg-raised/40 px-3 py-3">
                          <pre className="whitespace-pre-wrap break-all font-mono text-2xs text-ink-2">
                            {JSON.stringify(r.context, null, 2)}
                          </pre>
                          {r.row_hash ? (
                            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 break-all font-mono text-2xs text-ink-3">
                              <dt>row_hash:</dt>
                              <dd>{r.row_hash}</dd>
                              <dt>prev_hash:</dt>
                              <dd>{r.prev_hash ?? '—'}</dd>
                            </dl>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageContainer>
  );
}

/**
 * Класс кода ответа словами: тон пилюли только дублирует подпись.
 *
 * Раньше успех от отказа отличался единственно цветом цифр — оператор с
 * дейтеранопией видел четыре одинаково серых числа и не мог отличить
 * выполненное действие от отклонённого.
 */
function statusClass(code: number): { tone: BadgeTone; text: string } {
  if (code < 300) return { tone: 'good', text: 'успех' };
  if (code < 400) return { tone: 'accent', text: 'переход' };
  if (code < 500) return { tone: 'warn', text: 'отказ' };
  return { tone: 'crit', text: 'сбой' };
}

function StatusCode({ code }: { code: number | null }) {
  if (code == null) return <span className="text-ink-3">—</span>;
  const { tone, text } = statusClass(code);
  return (
    <Badge tone={tone} size="sm">
      {`${code} · ${text}`}
    </Badge>
  );
}
