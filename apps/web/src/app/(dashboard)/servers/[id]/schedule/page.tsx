'use client';

import { isValidCron5 } from '@squad/shared-types';
import { use, useCallback, useEffect, useMemo, useState } from 'react';

type TaskType = 'restart' | 'set_next_layer' | 'change_layer' | 'broadcast';
type ScheduleMode = 'one_off' | 'cron';
type RunStatus = 'executed' | 'skipped_depot_update' | 'failed';

interface ScheduledTask {
  id: string;
  server_id: string;
  name: string;
  task_type: TaskType;
  params: { layer?: string; message?: string };
  scheduled_at: string | null;
  recurrence: string | null;
  enabled: boolean;
  last_executed_at: string | null;
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

  const scheduleValid =
    scheduleMode === 'one_off'
      ? scheduledAt !== ''
      : recurrence.trim() !== '' && isValidCron5(recurrence);
  const paramsValid =
    taskType === 'restart' ? true : isLayerType(taskType) ? layer !== '' : message.trim() !== '';
  const canSubmit = canEditAny && name.trim() !== '' && paramsValid && scheduleValid && !saving;

  async function submit() {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), task_type: taskType };
      if (isLayerType(taskType)) body.params = { layer };
      else if (taskType === 'broadcast') body.params = { message: message.trim() };
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
                {task.params.message ? ` · «${task.params.message}»` : ''}
              </div>
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
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Текст оповещения"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
              />
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
