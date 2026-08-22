'use client';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  EmptyState,
  FieldRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
} from '@/components/ui';
import {
  CHAT_FLAG_LOCALES,
  CHAT_FLAG_PATTERN_TYPES,
  type ChatFlagLocale,
  type ChatFlagPatternType,
  type ChatFlagRule,
  countEnabled,
  LOCALE_LABELS,
  PATTERN_TYPE_LABELS,
  type ReindexSummary,
  summarizeReindex,
} from '@/lib/chatFlags';

interface Me {
  permissions: string[];
}

interface DraftForm {
  pattern: string;
  patternType: ChatFlagPatternType;
  locale: ChatFlagLocale;
  enabled: boolean;
}

const EMPTY_DRAFT: DraftForm = {
  pattern: '',
  patternType: 'word',
  locale: 'all',
  enabled: true,
};

export default function ChatFlagsPage() {
  const [rules, setRules] = useState<ChatFlagRule[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [reindexDays, setReindexDays] = useState(7);
  const [pendingDelete, setPendingDelete] = useState<ChatFlagRule | null>(null);

  const patternId = useId();
  const canEdit = useMemo(() => me?.permissions.includes('role:edit') ?? false, [me]);

  async function loadRules() {
    const res = await fetch('/api/v1/settings/chat-flag-rules', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setRules((await res.json()).items as ChatFlagRule[]);
  }

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [meRes, rulesRes] = await Promise.all([
        fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/v1/settings/chat-flag-rules', { credentials: 'include', cache: 'no-store' }),
      ]);
      if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
      if (!rulesRes.ok) throw new Error(`HTTP ${rulesRes.status}`);
      setMe((await meRes.json()) as Me);
      setRules((await rulesRes.json()).items as ChatFlagRule[]);
      setMsg(null);
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  function resetDraft() {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  }

  function startEdit(rule: ChatFlagRule) {
    setEditingId(rule.id);
    setDraft({
      pattern: rule.pattern,
      patternType: rule.pattern_type,
      locale: rule.locale,
      enabled: rule.enabled,
    });
    setMsg(null);
  }

  async function submitDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.pattern.trim()) {
      setMsg({ kind: 'err', text: 'Укажите паттерн правила.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    const payload = {
      pattern: draft.pattern.trim(),
      pattern_type: draft.patternType,
      locale: draft.locale,
      enabled: draft.enabled,
    };
    try {
      const res = await fetch(
        editingId
          ? `/api/v1/settings/chat-flag-rules/${editingId}`
          : '/api/v1/settings/chat-flag-rules',
        {
          method: editingId ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status === 422) {
          throw new Error(`Недопустимый паттерн: ${body.detail ?? 'ошибка валидации'}`);
        }
        if (res.status === 409) {
          throw new Error('Такое правило уже существует.');
        }
        throw new Error(`HTTP ${res.status}: ${body.error ?? 'ошибка'}`);
      }
      await loadRules();
      resetDraft();
      setMsg({ kind: 'ok', text: editingId ? 'Правило обновлено.' : 'Правило создано.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(rule: ChatFlagRule) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/settings/chat-flag-rules/${rule.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadRules();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(rule: ChatFlagRule) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/settings/chat-flag-rules/${rule.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (editingId === rule.id) resetDraft();
      setPendingDelete(null);
      await loadRules();
      setMsg({ kind: 'ok', text: 'Правило удалено.' });
    } catch (e) {
      setPendingDelete(null);
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function runReindex() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/settings/chat-flag-rules/reindex', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: reindexDays }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const summary = (await res.json()) as ReindexSummary;
      setMsg({ kind: 'ok', text: summarizeReindex(summary) });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Флаги чата"
        subtitle="Настраиваемые правила для серверной пометки токсичных сообщений. Новые сообщения проверяются воркером при записи; переиндексация пере-помечает историю после изменения правил."
        meta={loading ? undefined : `Включено ${countEnabled(rules)} из ${rules.length}`}
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
            <Button size="sm" onClick={() => void loadAll()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {canEdit && !loading ? (
        <Card padding="none">
          <CardHeader title={editingId ? 'Редактировать правило' : 'Новое правило'} />
          <form onSubmit={submitDraft}>
            <CardBody className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <FieldRow label="Паттерн" htmlFor={patternId} className="sm:col-span-2">
                  <TextInput
                    id={patternId}
                    type="text"
                    value={draft.pattern}
                    onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))}
                    maxLength={200}
                    placeholder={draft.patternType === 'regex' ? 'сволоч[ьи]' : 'мудак'}
                  />
                </FieldRow>
                <FieldRow label="Тип" htmlFor={`${patternId}-type`}>
                  <Select
                    id={`${patternId}-type`}
                    value={draft.patternType}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        patternType: e.target.value as ChatFlagPatternType,
                      }))
                    }
                  >
                    {CHAT_FLAG_PATTERN_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {PATTERN_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </Select>
                </FieldRow>
                <FieldRow label="Язык" htmlFor={`${patternId}-loc`}>
                  <Select
                    id={`${patternId}-loc`}
                    value={draft.locale}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, locale: e.target.value as ChatFlagLocale }))
                    }
                  >
                    {CHAT_FLAG_LOCALES.map((locale) => (
                      <option key={locale} value={locale}>
                        {LOCALE_LABELS[locale]}
                      </option>
                    ))}
                  </Select>
                </FieldRow>
              </div>
              <Checkbox
                label="Включено"
                checked={draft.enabled}
                onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              />
            </CardBody>
            <CardFooter>
              {editingId ? (
                <Button type="button" onClick={resetDraft}>
                  Отмена
                </Button>
              ) : null}
              <Button type="submit" variant="primary" loading={busy}>
                {editingId ? 'Сохранить' : 'Создать'}
              </Button>
            </CardFooter>
          </form>
        </Card>
      ) : null}

      <Card padding="none">
        <CardHeader title="Правила" count={loading ? undefined : rules.length} />
        {loading ? (
          <div className="p-3">
            <SkeletonTable rows={6} cols={canEdit ? 6 : 5} label="Загрузка правил" />
          </div>
        ) : rules.length === 0 ? (
          <EmptyState
            title="Правил пока нет"
            description="Заведите первое правило — воркер начнёт помечать новые сообщения сразу после сохранения."
          />
        ) : (
          <Table ariaLabel="Правила пометки чата">
            <TableHead>
              <tr>
                <Th>Паттерн</Th>
                <Th>Тип</Th>
                <Th>Язык</Th>
                <Th>Статус</Th>
                <Th>Кто добавил</Th>
                {canEdit ? (
                  <Th align="right">
                    <span className="sr-only">Действия</span>
                  </Th>
                ) : null}
              </tr>
            </TableHead>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <Td className="break-all font-mono text-xs">{rule.pattern}</Td>
                  <Td className="text-ink-2">{PATTERN_TYPE_LABELS[rule.pattern_type]}</Td>
                  <Td className="text-ink-2">{LOCALE_LABELS[rule.locale]}</Td>
                  <Td>
                    {rule.enabled ? (
                      <Badge tone="good">включено</Badge>
                    ) : (
                      <Badge tone="neutral">отключено</Badge>
                    )}
                  </Td>
                  <Td className="text-ink-3">{rule.author_name ?? 'Система'}</Td>
                  {canEdit ? (
                    <Td align="right" className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        <Button size="sm" disabled={busy} onClick={() => void toggleEnabled(rule)}>
                          {rule.enabled ? 'Выключить' : 'Включить'}
                        </Button>
                        <Button size="sm" disabled={busy} onClick={() => startEdit(rule)}>
                          Изменить
                        </Button>
                        <Button size="sm" disabled={busy} onClick={() => setPendingDelete(rule)}>
                          Удалить
                        </Button>
                      </span>
                    </Td>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {canEdit && !loading ? (
        <Card padding="none">
          <CardHeader
            title="Переиндексация"
            description="Пере-помечает уже сохранённые сообщения за выбранный период по текущим правилам. Операция идемпотентна — повторный запуск не меняет уже согласованные строки."
          />
          <CardBody>
            <div className="flex flex-wrap items-end gap-3">
              <FieldRow label="Дней назад" htmlFor={`${patternId}-days`} className="w-28">
                <TextInput
                  id={`${patternId}-days`}
                  type="number"
                  min={1}
                  max={365}
                  value={reindexDays}
                  onChange={(e) =>
                    setReindexDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))
                  }
                />
              </FieldRow>
              <Button loading={busy} onClick={() => void runReindex()}>
                Переиндексировать
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Удалить правило"
        body={
          <>
            Правило «{pendingDelete?.pattern}» перестанет помечать новые сообщения. Уже
            проставленные пометки останутся до следующей переиндексации.
          </>
        }
        confirmLabel="Удалить правило"
        cancelLabel="Отмена"
        tone="destructive"
        busy={busy && pendingDelete !== null}
        onConfirm={() => {
          if (pendingDelete) void deleteRule(pendingDelete);
        }}
      />
    </PageContainer>
  );
}
