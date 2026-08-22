'use client';

import {
  BANNED_NAME_MATCH_TYPES,
  type BannedNameAction,
  type BannedNameMatchType,
} from '@squad/shared-config/banned-names';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  type BannedNameRule,
  type BannedNameRuleFormState,
  BannedNameRuleModal,
} from '@/components/BannedNameRuleModal';
import { LiveIndicator } from '@/components/LiveIndicator';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Pagination,
  SearchField,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
  Toolbar,
  type ToolbarProps,
} from '@/components/ui';

interface ListResponse {
  items: BannedNameRule[];
  total: number;
  page: number;
  page_size: number;
  can_mutate: boolean;
}

const PAGE_SIZE = 50;

const MATCH_TYPE_LABELS: Record<BannedNameMatchType, string> = {
  exact: 'Точное',
  substring: 'Вхождение',
  regex: 'Regex',
};

const ACTION_LABELS: Record<BannedNameAction, string> = {
  kick: 'Кик',
  alert: 'Уведомление',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export default function BannedNamesPage() {
  const [rows, setRows] = useState<BannedNameRule[]>([]);
  const [total, setTotal] = useState(0);
  const [canMutate, setCanMutate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const [search, setSearch] = useState('');
  const [matchTypeFilter, setMatchTypeFilter] = useState<'' | BannedNameMatchType>('');
  const [activeFilter, setActiveFilter] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modalInitial, setModalInitial] = useState<Partial<BannedNameRuleFormState>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BannedNameRule | null>(null);

  const typeFilterId = useId();
  const activeFilterId = useId();

  const searchParams = useSearchParams();
  const highlightedRuleId = searchParams.get('rule');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (matchTypeFilter) params.set('match_type', matchTypeFilter);
    if (activeFilter) params.set('is_active', activeFilter);
    params.set('page', String(page));
    params.set('page_size', String(PAGE_SIZE));
    try {
      const res = await fetch(`/api/v1/banned-names?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ListResponse;
      setRows(body.items);
      setTotal(body.total);
      setCanMutate(body.can_mutate);
      setLastUpdate(new Date());
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [search, matchTypeFilter, activeFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtersApplied = search.trim() !== '' || matchTypeFilter !== '' || activeFilter !== '';

  function resetFilters() {
    setPage(1);
    setSearch('');
    setMatchTypeFilter('');
    setActiveFilter('');
  }

  // Слот сброса у `Toolbar` — это пара «обработчик + подпись» или ничего:
  // объект собирается заранее, чтобы union не разъехался при раскрытии в JSX.
  const resetProps: ToolbarProps = filtersApplied
    ? { onReset: resetFilters, resetLabel: 'Сбросить фильтр' }
    : {};

  const createButton = canMutate ? (
    <Button variant="primary" onClick={openCreate}>
      Добавить правило
    </Button>
  ) : null;

  function openCreate() {
    setEditingId(null);
    setModalInitial({});
    setMsg(null);
    setModalOpen(true);
  }

  function openEdit(rule: BannedNameRule) {
    setEditingId(rule.id);
    setModalInitial({
      pattern: rule.pattern,
      match_type: rule.match_type,
      action: rule.action,
      reason: rule.reason ?? '',
      is_active: rule.is_active,
    });
    setMsg(null);
    setModalOpen(true);
  }

  async function handleSaved() {
    setModalOpen(false);
    setMsg({ kind: 'ok', text: editingId ? 'Правило обновлено.' : 'Правило добавлено.' });
    await load();
  }

  async function remove(rule: BannedNameRule) {
    setDeletingId(rule.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/banned-names/${rule.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPendingDelete(null);
      setMsg({ kind: 'ok', text: 'Правило удалено.' });
      await load();
    } catch (e) {
      setPendingDelete(null);
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Забаненные ники"
        subtitle="Чёрный список ников: правила проверяются при подключении игрока. Тип матчинга — точное совпадение, вхождение подстроки или регулярное выражение (регистр игнорируется для точного совпадения и вхождения)."
        status={<LiveIndicator lastUpdate={lastUpdate} />}
      />

      {msg?.kind === 'ok' ? (
        <InlineBanner
          tone="good"
          title={msg.text}
          onDismiss={() => setMsg(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}
      {msg?.kind === 'err' ? (
        <InlineBanner
          tone="crit"
          title="Не удалось выполнить запрос"
          description={msg.text}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <Toolbar
        search={
          <SearchField
            value={search}
            onCommit={(next) => {
              setPage(1);
              setSearch(next);
            }}
            label="Поиск по паттерну"
            placeholder="напр. isis"
            clearLabel="Очистить поиск"
          />
        }
        filters={
          <>
            <label htmlFor={typeFilterId} className="text-xs text-ink-3">
              Тип
            </label>
            <Select
              id={typeFilterId}
              value={matchTypeFilter}
              onChange={(e) => {
                setPage(1);
                setMatchTypeFilter(e.target.value as '' | BannedNameMatchType);
              }}
            >
              <option value="">Все</option>
              {BANNED_NAME_MATCH_TYPES.map((t) => (
                <option key={t} value={t}>
                  {MATCH_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
            <label htmlFor={activeFilterId} className="text-xs text-ink-3">
              Статус
            </label>
            <Select
              id={activeFilterId}
              value={activeFilter}
              onChange={(e) => {
                setPage(1);
                setActiveFilter(e.target.value as '' | 'true' | 'false');
              }}
            >
              <option value="">Все</option>
              <option value="true">Активные</option>
              <option value="false">Отключённые</option>
            </Select>
          </>
        }
        {...resetProps}
        summary={`Всего: ${total}`}
        actions={createButton}
      />

      <Card padding="none">
        {loading ? (
          <div className="p-3">
            <SkeletonTable rows={6} cols={canMutate ? 6 : 5} label="Загрузка правил" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            variant={filtersApplied ? 'filtered' : 'initial'}
            title={filtersApplied ? 'Ничего не нашлось' : 'Правил пока нет'}
            description={
              filtersApplied
                ? 'Ни одно правило не подходит под запрос и выбранные фильтры.'
                : 'Чёрный список ников пуст: ни одно правило ещё не заведено.'
            }
            action={
              filtersApplied ? (
                <Button onClick={resetFilters}>Сбросить фильтр</Button>
              ) : (
                createButton
              )
            }
          />
        ) : (
          <Table ariaLabel="Правила чёрного списка ников">
            <TableHead>
              <tr>
                <Th>Паттерн</Th>
                <Th>Тип</Th>
                <Th>Действие</Th>
                <Th>Причина</Th>
                <Th>Автор</Th>
                <Th>Добавлен</Th>
                <Th align="right">Срабатываний</Th>
                <Th>Журнал</Th>
                <Th>Статус</Th>
                {canMutate ? <Th>Действия</Th> : null}
              </tr>
            </TableHead>
            <TableBody>
              {rows.map((rule) => {
                const highlighted = highlightedRuleId === rule.id;
                return (
                  <TableRow key={rule.id} selected={highlighted}>
                    <Td className="break-all font-mono text-xs">
                      {rule.pattern}
                      {/* Подсветка строки, на которую привела ссылка, дублируется
                          словами: цвет один смысла не несёт (§5). */}
                      {highlighted ? <span className="sr-only">Выбранное правило</span> : null}
                    </Td>
                    <Td className="text-ink-2">{MATCH_TYPE_LABELS[rule.match_type]}</Td>
                    <Td className="text-ink-2">{ACTION_LABELS[rule.action]}</Td>
                    <Td className="text-ink-2">{rule.reason ?? '—'}</Td>
                    <Td className="text-ink-2">{rule.author_name ?? '—'}</Td>
                    <Td className="whitespace-nowrap text-ink-3">{formatDate(rule.created_at)}</Td>
                    <Td numeric className="text-ink-2">
                      {rule.hit_count}
                    </Td>
                    <Td>
                      {rule.hit_count > 0 ? (
                        <Link
                          href={`/events?kinds=banname.matched&rule=${rule.id}`}
                          className="text-accent no-underline hover:brightness-110"
                        >
                          Срабатывания
                        </Link>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </Td>
                    <Td>
                      {rule.is_active ? (
                        <Badge tone="good">активно</Badge>
                      ) : (
                        <Badge tone="neutral">отключено</Badge>
                      )}
                    </Td>
                    {canMutate ? (
                      <Td align="right" className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          <Button size="sm" onClick={() => openEdit(rule)}>
                            Изменить
                          </Button>
                          <Button
                            size="sm"
                            disabled={deletingId === rule.id}
                            onClick={() => setPendingDelete(rule)}
                          >
                            Удалить
                          </Button>
                        </span>
                      </Td>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Пустая страница за пределами выдачи — не повод отнимать навигацию:
          иначе с page=2, опустевшей после удаления, некуда вернуться. */}
      {!loading && total > 0 ? (
        <div className="flex justify-end">
          <Pagination
            page={page}
            pageCount={totalPages}
            onChange={setPage}
            allowJump
            labels={{
              previous: 'Назад',
              next: 'Вперёд',
              page: (current, of) => `Стр. ${current} из ${of}`,
            }}
          />
        </div>
      ) : null}

      <BannedNameRuleModal
        open={modalOpen}
        editingId={editingId}
        initial={modalInitial}
        onClose={() => setModalOpen(false)}
        onSaved={() => void handleSaved()}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Удалить правило"
        body={
          <>
            Правило «{pendingDelete?.pattern}» перестанет проверяться при подключении игроков.
            Отменить удаление нельзя.
          </>
        }
        confirmLabel="Удалить правило"
        cancelLabel="Отмена"
        tone="destructive"
        busy={pendingDelete !== null && deletingId === pendingDelete.id}
        onConfirm={() => {
          if (pendingDelete) void remove(pendingDelete);
        }}
      />
    </PageContainer>
  );
}
