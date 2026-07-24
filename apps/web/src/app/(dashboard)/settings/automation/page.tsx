'use client';

import { useCallback, useEffect, useState } from 'react';

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

const STATUS_BADGE: Record<string, string> = {
  executed: 'border-emerald-800 bg-emerald-950/50 text-emerald-300',
  matched: 'border-sky-800 bg-sky-950/50 text-sky-300',
  no_match: 'border-neutral-700 bg-neutral-900 text-neutral-400',
  skipped: 'border-amber-800 bg-amber-950/50 text-amber-300',
  failed: 'border-red-800 bg-red-950/50 text-red-300',
};

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
  const [form, setForm] = useState<Form>({ ...EMPTY_FORM });
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [rulesRes, runsRes, meRes] = await Promise.all([
      fetch('/api/v1/automation-rules', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/automation-runs', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (rulesRes.ok) setRules((await rulesRes.json()) as AutomationRule[]);
    if (runsRes.ok) setRuns((await runsRes.json()) as AutomationRun[]);
    if (meRes.ok) setMe((await meRes.json()) as Me);
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
    if (!confirm(`Удалить правило «${rule.name}» и всю его историю срабатываний?`)) return;
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
    }
  }

  if (!rules || !runs || !me) return <div className="text-neutral-500">Загрузка…</div>;

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Автоматизация</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Правила «если условие → действие»: ключевое слово в чате, число игроков, время суток или
          флаг игрока запускают RCON-команду, кик, предупреждение или уведомление админа. Кнопка
          «Тест» проверяет правило без выполнения действия; все срабатывания пишутся в историю и
          журнал аудита.
          {!canManage ? ' У вас нет прав на изменение правил — доступен только просмотр.' : ''}
        </p>
      </header>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded border border-sky-900 bg-sky-950 p-3 text-sm text-sky-200">
          {notice}
        </div>
      ) : null}

      {canManage ? (
        <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Добавить правило</h2>
          <form onSubmit={createRule} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Имя</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Кик за спам"
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Условие</span>
                <select
                  value={form.conditionType}
                  onChange={(e) => setForm((p) => ({ ...p, conditionType: e.target.value }))}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                >
                  {CONDITION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Действие</span>
                <select
                  value={form.actionType}
                  onChange={(e) => setForm((p) => ({ ...p, actionType: e.target.value }))}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                >
                  {ACTION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {form.conditionType === 'chat_keyword' ? (
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Ключевое слово</span>
                <input
                  type="text"
                  value={form.keyword}
                  onChange={(e) => setForm((p) => ({ ...p, keyword: e.target.value }))}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
            ) : null}

            {form.conditionType === 'player_count' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Оператор</span>
                  <select
                    value={form.operator}
                    onChange={(e) => setForm((p) => ({ ...p, operator: e.target.value }))}
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  >
                    {['gte', 'lte', 'gt', 'lt', 'eq'].map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Порог</span>
                  <input
                    type="number"
                    min={0}
                    value={form.threshold}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, threshold: Number(e.target.value) || 0 }))
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
            ) : null}

            {form.conditionType === 'time_of_day' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Начало (мин от 00:00)</span>
                  <input
                    type="number"
                    min={0}
                    max={1439}
                    value={form.startMinute}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, startMinute: Number(e.target.value) || 0 }))
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Конец (мин от 00:00)</span>
                  <input
                    type="number"
                    min={0}
                    max={1439}
                    value={form.endMinute}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, endMinute: Number(e.target.value) || 0 }))
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Таймзона</span>
                  <input
                    type="text"
                    value={form.timezone}
                    onChange={(e) => setForm((p) => ({ ...p, timezone: e.target.value }))}
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
            ) : null}

            {form.conditionType === 'player_flag' ? (
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Флаг</span>
                <input
                  type="text"
                  value={form.flag}
                  onChange={(e) => setForm((p) => ({ ...p, flag: e.target.value }))}
                  placeholder="steam_eos_conflict"
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
            ) : null}

            {form.actionType === 'rcon_command' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">Команда</span>
                  <select
                    value={form.command}
                    onChange={(e) => setForm((p) => ({ ...p, command: e.target.value }))}
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                  >
                    {[
                      'AdminBroadcast',
                      'AdminChangeLayer',
                      'AdminSetNextLayer',
                      'AdminEndMatch',
                      'AdminKick',
                      'AdminWarn',
                    ].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-neutral-400">
                    Аргументы (по одному в строке)
                  </span>
                  <textarea
                    value={form.commandArgs}
                    onChange={(e) => setForm((p) => ({ ...p, commandArgs: e.target.value }))}
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                    rows={2}
                  />
                </label>
              </div>
            ) : null}

            {form.actionType === 'kick' ? (
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Причина кика</span>
                <input
                  type="text"
                  value={form.reason}
                  onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
            ) : null}

            {form.actionType === 'warn' || form.actionType === 'notify_admin' ? (
              <label className="block text-xs">
                <span className="mb-1 block text-neutral-400">Сообщение</span>
                <input
                  type="text"
                  value={form.message}
                  onChange={(e) => setForm((p) => ({ ...p, message: e.target.value }))}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                />
              </label>
            ) : null}

            <button
              type="submit"
              disabled={creating}
              className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
            >
              {creating ? 'Создание…' : 'Добавить правило'}
            </button>
          </form>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Правила</h2>
        {rules.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-sm text-neutral-500">
            Правил пока нет.
          </div>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{rule.name}</h3>
                  <span className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] uppercase text-neutral-400">
                    {conditionLabel(rule.condition_type)}
                  </span>
                  <span className="text-neutral-600">→</span>
                  <span className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] uppercase text-neutral-400">
                    {actionLabel(rule.action_type)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {canManage ? (
                  <button
                    type="button"
                    disabled={busyId === rule.id}
                    onClick={() => dryRun(rule)}
                    className="rounded border border-sky-900 px-2 py-1 text-xs text-sky-300 hover:bg-sky-950 disabled:opacity-40"
                  >
                    Тест
                  </button>
                ) : null}
                <label
                  className={`flex items-center gap-2 text-xs ${
                    canManage ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                  }`}
                >
                  <span className="text-neutral-400">
                    {rule.enabled ? 'Включено' : 'Выключено'}
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`Включить правило ${rule.name}`}
                    checked={rule.enabled}
                    disabled={!canManage || busyId === rule.id}
                    onChange={() => toggleEnabled(rule)}
                    className="h-4 w-9 cursor-pointer appearance-none rounded-full bg-neutral-800 transition-all checked:bg-sky-600 disabled:cursor-not-allowed"
                    style={{
                      backgroundImage:
                        'radial-gradient(circle 7px at 8px center, white 100%, transparent 100%)',
                    }}
                  />
                </label>
                {canManage ? (
                  <button
                    type="button"
                    disabled={busyId === rule.id}
                    onClick={() => removeRule(rule)}
                    title="Удалить правило"
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-40"
                  >
                    ⌫
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">История срабатываний</h2>
        {runs.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-6 text-center text-sm text-neutral-500">
            Срабатываний пока нет.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Время</th>
                  <th className="px-3 py-2 font-medium">Правило</th>
                  <th className="px-3 py-2 font-medium">Статус</th>
                  <th className="px-3 py-2 font-medium">Тест</th>
                  <th className="px-3 py-2 font-medium">Совпадение</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t border-neutral-900">
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-300">
                      {formatDate(run.fired_at)}
                    </td>
                    <td className="px-3 py-2 text-neutral-200">{run.rule_name ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] uppercase ${
                          STATUS_BADGE[run.status] ?? STATUS_BADGE.no_match
                        }`}
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {run.dry_run ? (
                        <span className="text-sky-400">да</span>
                      ) : (
                        <span className="text-neutral-500">нет</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <code className="break-all font-mono text-[11px] text-neutral-500">
                        {JSON.stringify(run.matched)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
