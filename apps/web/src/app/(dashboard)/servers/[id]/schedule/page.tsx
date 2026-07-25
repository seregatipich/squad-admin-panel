'use client';

import { isValidCron5, minCron5IntervalMinutes } from '@squad/shared-types';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { TemplatePicker } from '@/components/TemplatePicker';
import type { MessageTemplate } from '@/lib/messageTemplates';

type TaskType = 'restart' | 'set_next_layer' | 'change_layer' | 'broadcast';
type ScheduleMode = 'one_off' | 'cron';
type RunStatus = 'executed' | 'skipped_depot_update' | 'failed';

/** MSG-4 (#187): minimum minutes between recurring broadcast fires (anti-spam floor). */
const MIN_BROADCAST_INTERVAL_MINUTES = 5;
/** MSG-4 (#187): a broadcast rotation carries at most this many messages. */
const MAX_ROTATION_MESSAGES = 10;

interface ScheduledTask {
  id: string;
  server_id: string;
  name: string;
  task_type: TaskType;
  params: { layer?: string; message?: string; messages?: string[]; template_ids?: string[] };
  scheduled_at: string | null;
  recurrence: string | null;
  enabled: boolean;
  rotation_index?: number;
  last_executed_at: string | null;
}

interface ServerRow {
  id: string;
  display_name: string;
}

interface TaskRun {
  id: string;
  task_id: string;
  task_name: string;
  task_type: TaskType;
  executed_at: string;
  status: RunStatus;
  detail: Record<string, unknown>;
}

interface Capabilities {
  restart: boolean;
  set_next_layer: boolean;
  change_layer: boolean;
  broadcast: boolean;
}

interface LayerRow {
  id?: string;
  name: string;
}

const TASK_TYPE_LABELS: Record<TaskType, string> = {
  restart: 'Рестарт',
  set_next_layer: 'Слой (следующий)',
  change_layer: 'Слой (сейчас)',
  broadcast: 'Оповещение',
};

const STATUS_LABELS: Record<RunStatus, string> = {
  executed: 'Выполнено',
  skipped_depot_update: 'Пропущено (обновление)',
  failed: 'Ошибка',
};

const ALL_TASK_TYPES: TaskType[] = ['restart', 'set_next_layer', 'change_layer', 'broadcast'];

const EMPTY_CAPS: Capabilities = {
  restart: false,
  set_next_layer: false,
  change_layer: false,
  broadcast: false,
};

function isLayerType(taskType: TaskType): boolean {
  return taskType === 'set_next_layer' || taskType === 'change_layer';
}

/**
 * AUTO-2 (#73): manages the general `scheduled_tasks` for a server — restart,
 * layer change (`set_next_layer`/`change_layer`) and broadcast actions run on a
 * one-off instant or a recurring 5-field cron — plus a read-only execution
 * history. Backed by `/api/v1/servers/:id/scheduled-tasks`; execution happens
 * out-of-band in `@squad/worker-scheduler`. Actions the caller lacks permission
 * for (per the API's `capabilities`) are hidden.
 */
export default function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [caps, setCaps] = useState<Capabilities>(EMPTY_CAPS);
  const [pool, setPool] = useState<LayerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('restart');
  const [layer, setLayer] = useState('');
  const [message, setMessage] = useState('');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('one_off');
  const [scheduledAt, setScheduledAt] = useState('');
  const [recurrence, setRecurrence] = useState('');

  // MSG-4 (#187): broadcast rotation + fan-out targets.
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [serverList, setServerList] = useState<ServerRow[]>([]);
  const [rotation, setRotation] = useState<string[]>([]);
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [tasksRes, historyRes, layersRes] = await Promise.all([
        fetch(`/api/v1/servers/${id}/scheduled-tasks`, {
          credentials: 'include',
          cache: 'no-store',
        }),
        fetch(`/api/v1/servers/${id}/scheduled-tasks/history`, {
          credentials: 'include',
          cache: 'no-store',
        }),
        fetch('/api/v1/layers', { credentials: 'include', cache: 'no-store' }),
      ]);
      if (!tasksRes.ok) throw new Error(`HTTP ${tasksRes.status}`);
      if (!historyRes.ok) throw new Error(`HTTP ${historyRes.status}`);
      if (!layersRes.ok) throw new Error(`HTTP ${layersRes.status}`);
      const tasksBody = (await tasksRes.json()) as {
        tasks: ScheduledTask[];
        capabilities: Capabilities;
      };
      const historyBody = (await historyRes.json()) as { runs: TaskRun[] };
      const layersBody = (await layersRes.json()) as { rows: LayerRow[] };
      setTasks(tasksBody.tasks);
      setCaps(tasksBody.capabilities);
      setRuns(historyBody.runs);
      setPool(layersBody.rows);

      // Broadcast extras (templates + servers) are best-effort: a failure here
      // only disables the template picker / server multi-select, never the page.
      try {
        const [templatesRes, serversRes] = await Promise.all([
          fetch('/api/v1/message-templates', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' }),
        ]);
        if (templatesRes.ok) setTemplates((await templatesRes.json()) as MessageTemplate[]);
        if (serversRes.ok) {
          const serversBody = (await serversRes.json()) as { items: ServerRow[] };
          setServerList(serversBody.items ?? []);
        }
      } catch {
        // ignore — broadcast extras stay empty
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const allowedTypes = useMemo(() => ALL_TASK_TYPES.filter((t) => caps[t]), [caps]);
  const canEditAny = allowedTypes.length > 0;

  // Keep the selected task type valid as capabilities load in.
  useEffect(() => {
    if (allowedTypes.length > 0 && !allowedTypes.includes(taskType)) {
      setTaskType(allowedTypes[0] as TaskType);
    }
  }, [allowedTypes, taskType]);

  function canManage(type: TaskType): boolean {
    return caps[type];
  }

  const currentServerName = useMemo(
    () => serverList.find((s) => s.id === id)?.display_name ?? '',
    [serverList, id],
  );
  const otherServers = useMemo(() => serverList.filter((s) => s.id !== id), [serverList, id]);
  const allServersSelected =
    otherServers.length > 0 && selectedServerIds.length === otherServers.length;

  // The rotation drives the broadcast; any un-added free text becomes a
  // trailing message so nothing the operator typed is lost on submit.
  const effectiveMessages = useMemo(() => {
    const list = [...rotation];
    if (taskType === 'broadcast' && message.trim() !== '') list.push(message.trim());
    return list;
  }, [rotation, message, taskType]);

  function addToRotation(text: string) {
    const trimmed = text.trim();
    if (trimmed === '') return;
    setRotation((prev) => (prev.length >= MAX_ROTATION_MESSAGES ? prev : [...prev, trimmed]));
  }
  function addCustomMessage() {
    if (message.trim() === '') return;
    addToRotation(message);
    setMessage('');
  }
  function removeFromRotation(index: number) {
    setRotation((prev) => prev.filter((_, i) => i !== index));
  }
  function toggleServer(sid: string) {
    setSelectedServerIds((prev) =>
      prev.includes(sid) ? prev.filter((x) => x !== sid) : [...prev, sid],
    );
  }
  function toggleAllServers(checked: boolean) {
    setSelectedServerIds(checked ? otherServers.map((s) => s.id) : []);
  }

  const broadcastIntervalTooShort =
    taskType === 'broadcast' &&
    scheduleMode === 'cron' &&
    recurrence.trim() !== '' &&
    isValidCron5(recurrence) &&
    minCron5IntervalMinutes(recurrence) < MIN_BROADCAST_INTERVAL_MINUTES;

  const scheduleValid =
    scheduleMode === 'one_off'
      ? scheduledAt !== ''
      : recurrence.trim() !== '' && isValidCron5(recurrence);
  const paramsValid =
    taskType === 'restart'
      ? true
      : isLayerType(taskType)
        ? layer !== ''
        : effectiveMessages.length >= 1;
  const canSubmit =
    canEditAny &&
    name.trim() !== '' &&
    paramsValid &&
    scheduleValid &&
    !broadcastIntervalTooShort &&
    !saving;

  async function submit() {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), task_type: taskType };
      if (isLayerType(taskType)) body.params = { layer };
      else if (taskType === 'broadcast') {
        body.params = { messages: effectiveMessages };
        if (selectedServerIds.length > 0) body.server_ids = selectedServerIds;
      }
      if (scheduleMode === 'one_off') body.scheduled_at = new Date(scheduledAt).toISOString();
      else body.recurrence = recurrence.trim();

      const res = await fetch(`/api/v1/servers/${id}/scheduled-tasks`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setName('');
      setLayer('');
      setMessage('');
      setScheduledAt('');
      setRecurrence('');
      setRotation([]);
      setSelectedServerIds([]);
      setMsg('Задача создана');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(task: ScheduledTask) {
    setErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/scheduled-tasks/${task.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !task.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function remove(task: ScheduledTask) {
    setErr(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/scheduled-tasks/${task.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (loading) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="max-w-4xl space-y-4 pb-20">
      <header>
        <h1 className="text-xl font-semibold">Планировщик</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Задачи по расписанию: рестарт, смена слоя, оповещение. Разовые или по 5-полевому cron
          (UTC). Во время обновления депота выполнение откладывается.
        </p>
      </header>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded border border-emerald-900 bg-emerald-950 px-3 py-2 text-sm text-emerald-200">
          {msg}
        </div>
      ) : null}

      {!canEditAny ? (
        <div className="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-400">
          Только просмотр — нужны привилегии на рестарт (server:restart), смену слоя (changemap) или
          оповещение (chat).
        </div>
      ) : null}

      <ul className="space-y-2" data-testid="scheduled-tasks-list">
        {tasks.length === 0 ? (
          <li className="rounded border border-neutral-800 bg-neutral-950 px-3 py-6 text-center text-sm text-neutral-500">
            Задач нет.
          </li>
        ) : null}
        {tasks.map((task) => (
          <li
            key={task.id}
            className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 px-3 py-2"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{task.name}</span>
                <span className="rounded bg-neutral-800 px-1.5 py-[1px] text-[10px] uppercase tracking-widest text-neutral-300">
                  {TASK_TYPE_LABELS[task.task_type]}
                </span>
                {!task.enabled ? (
                  <span className="rounded bg-amber-800 px-1.5 py-[1px] text-[10px] uppercase tracking-widest text-amber-100">
                    Выключена
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 font-mono text-xs text-neutral-500">
                {task.recurrence
                  ? `cron: ${task.recurrence}`
                  : `разово: ${task.scheduled_at ?? '—'}`}
                {task.params.layer ? ` · ${task.params.layer}` : ''}
                {task.params.messages && task.params.messages.length > 0
                  ? ` · ротация ${task.params.messages.length} (индекс ${task.rotation_index ?? 0})`
                  : task.params.message
                    ? ` · «${task.params.message}»`
                    : ''}
              </div>
              {task.params.messages && task.params.messages.length > 0 ? (
                <ol className="mt-1 space-y-0.5 text-[11px] text-neutral-500">
                  {task.params.messages.map((entry, index) => (
                    <li
                      key={`${task.id}-${index}`}
                      className={index === (task.rotation_index ?? 0) ? 'text-emerald-300' : ''}
                    >
                      {index + 1}. {entry}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
            {canManage(task.task_type) ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggle(task)}
                  aria-label={task.enabled ? 'выключить' : 'включить'}
                  className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                >
                  {task.enabled ? 'выключить' : 'включить'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(task)}
                  aria-label="удалить"
                  className="rounded px-2 py-1 text-xs text-red-400 hover:bg-neutral-800"
                >
                  удалить
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {canEditAny ? (
        <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <h2 className="text-sm font-semibold">Новая задача</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Название задачи"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
            />
            <select
              aria-label="Тип задачи"
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as TaskType)}
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
            >
              {allowedTypes.map((t) => (
                <option key={t} value={t}>
                  {TASK_TYPE_LABELS[t]}
                </option>
              ))}
            </select>

            {isLayerType(taskType) ? (
              <select
                aria-label="Слой"
                value={layer}
                onChange={(e) => setLayer(e.target.value)}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
              >
                <option value="">— выбрать слой —</option>
                {pool.map((l) => (
                  <option key={l.id ?? l.name} value={l.name}>
                    {l.name}
                  </option>
                ))}
              </select>
            ) : null}
            {taskType === 'broadcast' ? (
              <div className="space-y-3 sm:col-span-2" data-testid="broadcast-editor">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Текст оповещения"
                    className="flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={addCustomMessage}
                    disabled={message.trim() === '' || rotation.length >= MAX_ROTATION_MESSAGES}
                    aria-label="добавить в ротацию"
                    className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
                  >
                    Добавить
                  </button>
                </div>

                <div className="space-y-1">
                  <p className="text-xs text-neutral-500">
                    Шаблоны (подстановка {'{server}'} → «{currentServerName || '—'}»):
                  </p>
                  <TemplatePicker
                    templates={templates}
                    context={{ server: currentServerName }}
                    onSelect={addToRotation}
                  />
                </div>

                <div className="space-y-1">
                  <p className="text-xs text-neutral-500">
                    Ротация ({rotation.length}/{MAX_ROTATION_MESSAGES}) — по кругу за каждый запуск:
                  </p>
                  <ol
                    className="space-y-1 text-xs text-neutral-300"
                    data-testid="broadcast-rotation"
                  >
                    {rotation.length === 0 ? (
                      <li className="text-neutral-600">
                        Пусто — выберите шаблон или добавьте текст.
                      </li>
                    ) : null}
                    {rotation.map((entry, index) => (
                      <li
                        key={`${index}-${entry}`}
                        className="flex items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1"
                      >
                        <span className="truncate">
                          {index + 1}. {entry}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFromRotation(index)}
                          aria-label={`убрать из ротации ${index + 1}`}
                          className="text-red-400 hover:text-red-300"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>

                {otherServers.length > 0 ? (
                  <fieldset className="space-y-1">
                    <legend className="text-xs text-neutral-500">Серверы получатели</legend>
                    <label className="flex items-center gap-2 text-xs text-neutral-300">
                      <input
                        type="checkbox"
                        aria-label="Все серверы"
                        checked={allServersSelected}
                        onChange={(e) => toggleAllServers(e.target.checked)}
                      />
                      Все серверы
                    </label>
                    {otherServers.map((s) => (
                      <label
                        key={s.id}
                        className="flex items-center gap-2 text-xs text-neutral-300"
                      >
                        <input
                          type="checkbox"
                          aria-label={s.display_name}
                          checked={selectedServerIds.includes(s.id)}
                          onChange={() => toggleServer(s.id)}
                        />
                        {s.display_name}
                      </label>
                    ))}
                  </fieldset>
                ) : null}
              </div>
            ) : null}

            <select
              aria-label="Тип расписания"
              value={scheduleMode}
              onChange={(e) => setScheduleMode(e.target.value as ScheduleMode)}
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
            >
              <option value="one_off">Разово</option>
              <option value="cron">По расписанию (cron)</option>
            </select>

            {scheduleMode === 'one_off' ? (
              <input
                type="datetime-local"
                aria-label="Дата и время"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
              />
            ) : (
              <input
                type="text"
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value)}
                placeholder="* * * * *"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-sm"
              />
            )}
          </div>
          {scheduleMode === 'cron' && recurrence.trim() !== '' && !isValidCron5(recurrence) ? (
            <p className="text-xs text-red-400">Неверное cron-выражение (5 полей, UTC).</p>
          ) : null}
          {broadcastIntervalTooShort ? (
            <p className="text-xs text-red-400" data-testid="broadcast-interval-hint">
              Слишком часто: минимальный интервал оповещения — {MIN_BROADCAST_INTERVAL_MINUTES} мин.
            </p>
          ) : null}
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Создать задачу
          </button>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">История выполнений</h2>
        <ul className="space-y-1" data-testid="scheduled-tasks-history">
          {runs.length === 0 ? (
            <li className="rounded border border-neutral-800 bg-neutral-950 px-3 py-4 text-center text-sm text-neutral-500">
              Выполнений пока нет.
            </li>
          ) : null}
          {runs.map((run) => (
            <li
              key={run.id}
              className="flex items-center justify-between gap-3 rounded border border-neutral-900 bg-neutral-950 px-3 py-1.5 text-xs"
            >
              <span className="text-neutral-400">{new Date(run.executed_at).toISOString()}</span>
              <span className="font-medium">{run.task_name}</span>
              <span
                className={
                  run.status === 'executed'
                    ? 'text-emerald-300'
                    : run.status === 'failed'
                      ? 'text-red-400'
                      : 'text-amber-300'
                }
              >
                {STATUS_LABELS[run.status]}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
