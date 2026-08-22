'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  FieldRow,
  GroupedRow,
  IconButton,
  InlineBanner,
  PageHeader,
  Select,
  Skeleton,
  SkeletonTable,
  Switch,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Textarea,
  TextInput,
  Th,
  TrashIcon,
} from '@/components/ui';

interface AutomationRule {
  id: string;
  server_id: string | null;
  name: string;
  condition_type: string;
  condition: Record<string, unknown>;
  action_type: string;
  action: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface AutomationRun {
  id: string;
  rule_id: string;
  rule_name: string | null;
  condition_type: string | null;
  action_type: string | null;
  fired_at: string;
  matched: Record<string, unknown>;
  action_result: Record<string, unknown> | null;
  dry_run: boolean;
  status: string;
}

interface Me {
  permissions: string[];
}

const CONDITION_OPTIONS = [
  { value: 'chat_keyword', label: 'Ключевое слово в чате' },
  { value: 'player_count', label: 'Число игроков' },
  { value: 'time_of_day', label: 'Время суток' },
  { value: 'player_flag', label: 'Флаг игрока' },
] as const;

const ACTION_OPTIONS = [
  { value: 'rcon_command', label: 'RCON-команда' },
  { value: 'kick', label: 'Кик' },
  { value: 'warn', label: 'Предупреждение' },
  { value: 'notify_admin', label: 'Уведомить админа' },
] as const;

/** Операторы сравнения хранятся кодом, а оператору показываются знаком и словом. */
const OPERATOR_OPTIONS = [
  { value: 'gte', label: '≥ не меньше' },
  { value: 'lte', label: '≤ не больше' },
  { value: 'gt', label: '> больше' },
  { value: 'lt', label: '< меньше' },
  { value: 'eq', label: '= равно' },
] as const;

const RCON_COMMANDS = [
  'AdminBroadcast',
  'AdminChangeLayer',
  'AdminSetNextLayer',
  'AdminEndMatch',
  'AdminKick',
  'AdminWarn',
] as const;

/** Исход запуска: тон подложки и русская подпись, которая его дублирует (§5). */
const RUN_STATUS: Record<
  string,
  { tone: 'good' | 'accent' | 'neutral' | 'warn' | 'crit'; label: string }
> = {
  executed: { tone: 'good', label: 'Выполнено' },
  matched: { tone: 'accent', label: 'Условие совпало' },
  no_match: { tone: 'neutral', label: 'Не совпало' },
  skipped: { tone: 'warn', label: 'Пропущено' },
  failed: { tone: 'crit', label: 'Ошибка' },
};

function runStatus(status: string) {
  return RUN_STATUS[status] ?? { tone: 'neutral' as const, label: status };
}

function conditionLabel(type: string): string {
  return CONDITION_OPTIONS.find((o) => o.value === type)?.label ?? type;
}
function actionLabel(type: string): string {
  return ACTION_OPTIONS.find((o) => o.value === type)?.label ?? type;
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU');
}

const EMPTY_FORM = {
  name: '',
  conditionType: 'chat_keyword',
  keyword: '',
  operator: 'gte',
  threshold: 60,
  startMinute: 0,
  endMinute: 300,
  timezone: 'UTC',
  flag: '',
  actionType: 'warn',
  command: 'AdminBroadcast',
  commandArgs: '',
  reason: '',
  message: '',
};

type Form = typeof EMPTY_FORM;

function buildCondition(form: Form): Record<string, unknown> {
  switch (form.conditionType) {
    case 'chat_keyword':
      return { keyword: form.keyword.trim() };
    case 'player_count':
      return { operator: form.operator, threshold: form.threshold };
    case 'time_of_day':
      return { startMinute: form.startMinute, endMinute: form.endMinute, timezone: form.timezone };
    case 'player_flag':
      return { flag: form.flag.trim() };
    default:
      return {};
  }
}

function buildAction(form: Form): Record<string, unknown> {
  switch (form.actionType) {
    case 'rcon_command':
      return {
        command: form.command,
        args: form.commandArgs
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean),
      };
    case 'kick':
      return { reason: form.reason };
    case 'warn':
      return { message: form.message.trim() };
    case 'notify_admin':
      return { message: form.message.trim() };
    default:
      return {};
  }
}

/** A representative sample for the dry-run, derived from the rule's condition. */
function sampleFor(rule: AutomationRule): Record<string, unknown> {
  const condition = rule.condition;
  switch (rule.condition_type) {
    case 'chat_keyword':
      return {
        chat_message: String(condition.keyword ?? ''),
        player: { steam_id64: '76561190000000001', name: 'DryRunPlayer' },
      };
    case 'player_count':
      return { player_count: Number(condition.threshold ?? 0) };
    case 'time_of_day':
      return { now: new Date().toISOString() };
    case 'player_flag':
      return {
        player_flags: [String(condition.flag ?? '')],
        player: { steam_id64: '76561190000000001', name: 'DryRunPlayer' },
      };
    default:
      return {};
  }
}

export default function AutomationPage() {
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<Form>({ ...EMPTY_FORM });
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AutomationRule | null>(null);

  const refresh = useCallback(async () => {
    const [rulesRes, runsRes, meRes] = await Promise.all([
      fetch('/api/v1/automation-rules', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/automation-runs', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (rulesRes.ok) setRules((await rulesRes.json()) as AutomationRule[]);
    if (runsRes.ok) setRuns((await runsRes.json()) as AutomationRun[]);
    if (meRes.ok) setMe((await meRes.json()) as Me);
    setLoadFailed(!rulesRes.ok || !runsRes.ok || !meRes.ok);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canManage = me?.permissions.includes('role:edit') ?? false;

  async function createRule(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError('Укажите имя правила.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/automation-rules', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          condition_type: form.conditionType,
          condition: buildCondition(form),
          action_type: form.actionType,
          action: buildAction(form),
          enabled: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(String(body.error ?? res.status));
      }
      setForm({ ...EMPTY_FORM });
      await refresh();
    } catch (err) {
      setError(`Не удалось создать правило: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(rule: AutomationRule) {
    if (!canManage) return;
    setBusyId(rule.id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/automation-rules/${rule.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(`Не удалось изменить статус: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function dryRun(rule: AutomationRule) {
    if (!canManage) return;
    setBusyId(rule.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/automation-rules/${rule.id}/dry-run`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sample: sampleFor(rule) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const outcome = (await res.json()) as { matched: boolean };
      setNotice(
        outcome.matched
          ? `Тест правила «${rule.name}»: условие сработало (действие НЕ выполнено).`
          : `Тест правила «${rule.name}»: условие не сработало.`,
      );
      await refresh();
    } catch (err) {
      setError(`Не удалось протестировать: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function removeRule(rule: AutomationRule) {
    if (!canManage) return;
    setBusyId(rule.id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/automation-rules/${rule.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(`Не удалось удалить: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
      setPendingDelete(null);
    }
  }

  const loading = !rules || !runs || !me;

  return (
    <>
      <PageHeader
        title="Автоматизация"
        subtitle="Правила «если условие → действие»: ключевое слово в чате, число игроков, время суток или флаг игрока запускают RCON-команду, кик, предупреждение или уведомление админа. Кнопка «Тест» проверяет правило без выполнения действия; все срабатывания пишутся в историю и журнал аудита."
      />

      {!loading && !canManage ? (
        <InlineBanner
          tone="info"
          title="Только просмотр"
          description="У вас нет прав на изменение правил автоматизации."
        />
      ) : null}

      {loadFailed ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить автоматизацию"
          description="Часть данных не пришла — список правил или история могут быть неполными."
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {error ? <InlineBanner tone="crit" title={error} /> : null}
      {notice ? <InlineBanner tone="info" title={notice} /> : null}

      {loading ? (
        <>
          <Card>
            <Skeleton variant="row" count={3} label="Загрузка правил автоматизации" />
          </Card>
          <Card padding="sm">
            <SkeletonTable rows={4} cols={5} />
          </Card>
        </>
      ) : (
        <>
          {canManage ? (
            <Card padding="none" as="section">
              <CardHeader title="Добавить правило" />
              <form onSubmit={createRule}>
                <CardBody className="space-y-4">
                  <FieldRow label="Имя">
                    <TextInput
                      value={form.name}
                      onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Кик за спам"
                    />
                  </FieldRow>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <FieldRow label="Условие">
                      <Select
                        value={form.conditionType}
                        onChange={(e) => setForm((p) => ({ ...p, conditionType: e.target.value }))}
                      >
                        {CONDITION_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </FieldRow>
                    <FieldRow label="Действие">
                      <Select
                        value={form.actionType}
                        onChange={(e) => setForm((p) => ({ ...p, actionType: e.target.value }))}
                      >
                        {ACTION_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </FieldRow>
                  </div>

                  {form.conditionType === 'chat_keyword' ? (
                    <FieldRow label="Ключевое слово">
                      <TextInput
                        value={form.keyword}
                        onChange={(e) => setForm((p) => ({ ...p, keyword: e.target.value }))}
                      />
                    </FieldRow>
                  ) : null}

                  {form.conditionType === 'player_count' ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <FieldRow label="Оператор">
                        <Select
                          value={form.operator}
                          onChange={(e) => setForm((p) => ({ ...p, operator: e.target.value }))}
                        >
                          {OPERATOR_OPTIONS.map((op) => (
                            <option key={op.value} value={op.value}>
                              {op.label}
                            </option>
                          ))}
                        </Select>
                      </FieldRow>
                      <FieldRow label="Порог">
                        <TextInput
                          type="number"
                          min={0}
                          value={form.threshold}
                          onChange={(e) =>
                            setForm((p) => ({ ...p, threshold: Number(e.target.value) || 0 }))
                          }
                        />
                      </FieldRow>
                    </div>
                  ) : null}

                  {form.conditionType === 'time_of_day' ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                      <FieldRow label="Начало, мин от 00:00">
                        <TextInput
                          type="number"
                          min={0}
                          max={1439}
                          value={form.startMinute}
                          onChange={(e) =>
                            setForm((p) => ({ ...p, startMinute: Number(e.target.value) || 0 }))
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Конец, мин от 00:00">
                        <TextInput
                          type="number"
                          min={0}
                          max={1439}
                          value={form.endMinute}
                          onChange={(e) =>
                            setForm((p) => ({ ...p, endMinute: Number(e.target.value) || 0 }))
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Часовой пояс">
                        <TextInput
                          value={form.timezone}
                          onChange={(e) => setForm((p) => ({ ...p, timezone: e.target.value }))}
                        />
                      </FieldRow>
                    </div>
                  ) : null}

                  {form.conditionType === 'player_flag' ? (
                    <FieldRow label="Флаг">
                      <TextInput
                        value={form.flag}
                        onChange={(e) => setForm((p) => ({ ...p, flag: e.target.value }))}
                        placeholder="steam_eos_conflict"
                      />
                    </FieldRow>
                  ) : null}

                  {form.actionType === 'rcon_command' ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <FieldRow label="Команда">
                        <Select
                          value={form.command}
                          onChange={(e) => setForm((p) => ({ ...p, command: e.target.value }))}
                        >
                          {RCON_COMMANDS.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </Select>
                      </FieldRow>
                      <FieldRow label="Аргументы" hint="По одному в строке.">
                        <Textarea
                          value={form.commandArgs}
                          onChange={(e) => setForm((p) => ({ ...p, commandArgs: e.target.value }))}
                          rows={2}
                        />
                      </FieldRow>
                    </div>
                  ) : null}

                  {form.actionType === 'kick' ? (
                    <FieldRow label="Причина кика">
                      <TextInput
                        value={form.reason}
                        onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}
                      />
                    </FieldRow>
                  ) : null}

                  {form.actionType === 'warn' || form.actionType === 'notify_admin' ? (
                    <FieldRow label="Сообщение">
                      <TextInput
                        value={form.message}
                        onChange={(e) => setForm((p) => ({ ...p, message: e.target.value }))}
                      />
                    </FieldRow>
                  ) : null}
                </CardBody>
                <CardFooter>
                  <Button type="submit" variant="primary" loading={creating}>
                    Добавить правило
                  </Button>
                </CardFooter>
              </form>
            </Card>
          ) : null}

          <Card padding="none" as="section">
            <CardHeader title="Правила" count={rules.length > 0 ? rules.length : undefined} />
            {rules.length === 0 ? (
              <EmptyState
                title="Правил пока нет"
                description={
                  canManage
                    ? 'Добавьте первое правило формой выше — до этого автоматика ничего не делает.'
                    : 'Правила добавляет администратор с правом изменения ролей.'
                }
              />
            ) : (
              <div className="divide-y divide-line">
                {rules.map((rule) => (
                  <GroupedRow
                    key={rule.id}
                    label={
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{rule.name}</span>
                        <Badge size="sm">{conditionLabel(rule.condition_type)}</Badge>
                        <span aria-hidden="true" className="text-ink-4">
                          →
                        </span>
                        <Badge size="sm">{actionLabel(rule.action_type)}</Badge>
                      </span>
                    }
                    control={
                      <>
                        {canManage ? (
                          <Button
                            size="sm"
                            disabled={busyId === rule.id}
                            onClick={() => void dryRun(rule)}
                          >
                            Тест
                          </Button>
                        ) : null}
                        <span className="text-xs text-ink-3">
                          {rule.enabled ? 'Включено' : 'Выключено'}
                        </span>
                        <Switch
                          label={`Включить правило ${rule.name}`}
                          checked={rule.enabled}
                          disabled={!canManage || busyId === rule.id}
                          onChange={() => void toggleEnabled(rule)}
                        />
                        {canManage ? (
                          <IconButton
                            icon={<TrashIcon />}
                            label={`Удалить правило ${rule.name}`}
                            tone="destructive"
                            disabled={busyId === rule.id}
                            onClick={() => setPendingDelete(rule)}
                          />
                        ) : null}
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </Card>

          <Card padding="none" as="section">
            <CardHeader
              title="История срабатываний"
              count={runs.length > 0 ? runs.length : undefined}
            />
            {runs.length === 0 ? (
              <EmptyState
                title="Срабатываний пока нет"
                description="Здесь появятся запуски правил — и настоящие, и проверочные."
              />
            ) : (
              <Table ariaLabel="История срабатываний правил автоматизации">
                <TableHead>
                  <tr>
                    <Th>Время</Th>
                    <Th>Правило</Th>
                    <Th>Статус</Th>
                    <Th>Тест</Th>
                    <Th>Совпадение</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {runs.map((run) => {
                    const status = runStatus(run.status);
                    return (
                      <TableRow key={run.id}>
                        <Td className="whitespace-nowrap text-xs text-ink-2">
                          {formatDate(run.fired_at)}
                        </Td>
                        <Td>{run.rule_name ?? '—'}</Td>
                        <Td>
                          <Badge tone={status.tone} size="sm">
                            {status.label}
                          </Badge>
                        </Td>
                        <Td>
                          <Badge tone={run.dry_run ? 'accent' : 'neutral'} size="sm">
                            {run.dry_run ? 'да' : 'нет'}
                          </Badge>
                        </Td>
                        <Td>
                          <code className="break-all font-mono text-2xs text-ink-3">
                            {JSON.stringify(run.matched)}
                          </code>
                        </Td>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Удалить правило"
        body={
          pendingDelete
            ? `Правило «${pendingDelete.name}» и вся его история срабатываний будут удалены без возможности восстановления.`
            : ''
        }
        confirmLabel="Удалить правило"
        cancelLabel="Отмена"
        tone="destructive"
        busy={pendingDelete !== null && busyId === pendingDelete.id}
        onConfirm={() => {
          if (pendingDelete) void removeRule(pendingDelete);
        }}
      />
    </>
  );
}
