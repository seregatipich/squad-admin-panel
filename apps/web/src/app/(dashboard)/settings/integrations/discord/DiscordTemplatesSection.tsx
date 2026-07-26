'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { eventLabel } from './discord-events';

const PREVIEW_DEBOUNCE_MS = 300;

const LOCALES = ['en', 'ru'] as const;

type TemplateLocale = (typeof LOCALES)[number];

/**
 * Sample values for every token of `DISCORD_TEMPLATE_PLACEHOLDERS`, sent with
 * each preview request. Because the context is complete, a non-empty
 * `missing_placeholders` in the response means the operator typed a token the
 * renderer does not know — which is exactly what the warning reports.
 */
const PREVIEW_CONTEXT: Record<string, string> = {
  player_name: 'Тестовый Игрок',
  player_id: '00000000-0000-0000-0000-000000000000',
  player_url: '/players/00000000-0000-0000-0000-000000000000',
  steam_id64: '76561198000000000',
  eos_id: '00000000000000000000000000000000',
  server_name: 'Тестовый сервер',
  reason: 'Тестовая причина',
  duration: 'постоянно',
  actor_name: 'Администратор',
  map: 'Narva_RAAS_v1',
  join_link: 'steam://connect/127.0.0.1:7787',
};

interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

interface EmbedTemplate {
  title: string;
  url: string | null;
  description: string;
  color: number;
  fields: EmbedField[];
}

interface TemplateRow {
  event_type: string;
  locale: TemplateLocale;
  template: EmbedTemplate;
  is_default: boolean;
  updated_at: string;
}

interface PreviewResponse {
  event_type: string;
  embed: EmbedTemplate;
  missing_placeholders: string[];
}

/** An embed field plus a client-only identity, so React keys survive reordering. */
interface DraftField extends EmbedField {
  id: string;
}

interface FormState {
  eventType: string;
  locale: TemplateLocale;
  title: string;
  url: string;
  description: string;
  color: number;
  fields: DraftField[];
  isDefault: boolean;
}

let fieldSeq = 0;

function nextFieldId(): string {
  fieldSeq += 1;
  return `field-${fieldSeq}`;
}

/** `5793266` → `'#5865f2'`. Always a lower-case 6-digit hex string. */
export function colorToHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** `'#5865F2'` → `5793266`. Returns `null` for anything that is not `#rrggbb`. */
export function hexToColor(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  return match ? Number.parseInt(match[1] as string, 16) : null;
}

function toForm(row: TemplateRow): FormState {
  return {
    eventType: row.event_type,
    locale: row.locale,
    title: row.template.title,
    url: row.template.url ?? '',
    description: row.template.description,
    color: row.template.color,
    fields: row.template.fields.map((field) => ({ ...field, id: nextFieldId() })),
    isDefault: row.is_default,
  };
}

function toTemplate(form: FormState): EmbedTemplate {
  const url = form.url.trim();
  return {
    title: form.title,
    url: url === '' ? null : url,
    description: form.description,
    color: form.color,
    fields: form.fields.map((field) => ({
      name: field.name,
      value: field.value,
      inline: field.inline,
    })),
  };
}

/**
 * «Шаблоны сообщений» — per-event-type editor for the Discord embed templates
 * behind `/api/v1/integrations/discord/templates`. The preview is rendered by
 * the API through the same renderer the worker uses, which is what keeps the
 * preview and the delivered message in step. Gated on `integration:manage`:
 * a 401/403 on the list request hides the whole section, because the host page
 * already renders its own «Недостаточно прав» block for the same permission.
 */
export default function DiscordTemplatesSection() {
  const baseId = useId();
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/v1/integrations/discord/templates', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (res.status === 401 || res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) {
          setError(`Не удалось загрузить шаблоны: ${res.status}`);
          return;
        }
        const body = (await res.json()) as TemplateRow[];
        setRows(body);
        const first = body[0];
        if (first) setForm(toForm(first));
      } catch (e) {
        setError((e as Error).message);
      }
    }
    void load();
  }, []);

  useEffect(() => {
    if (!form) return;
    const body = JSON.stringify({ template: toTemplate(form), context: PREVIEW_CONTEXT });
    const eventType = form.eventType;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/v1/integrations/discord/templates/${eventType}/preview`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body,
      })
        .then(async (res) => (res.ok ? ((await res.json()) as PreviewResponse) : null))
        .then((parsed) => {
          if (!cancelled) setPreview(parsed);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form]);

  const patch = useCallback((change: Partial<FormState>) => {
    setForm((current) => (current ? { ...current, ...change } : current));
  }, []);

  const applyRow = useCallback((row: TemplateRow) => {
    setRows((current) =>
      current.map((candidate) => (candidate.event_type === row.event_type ? row : candidate)),
    );
    setForm(toForm(row));
    setPreview(null);
  }, []);

  const mutate = useCallback(
    async (request: () => Promise<Response>, failure: string, setBusy: (busy: boolean) => void) => {
      setBusy(true);
      setError(null);
      try {
        const res = await request();
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(`${failure}: ${body.error ?? res.status}`);
          return;
        }
        applyRow((await res.json()) as TemplateRow);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [applyRow],
  );

  function selectEvent(eventType: string) {
    const row = rows.find((candidate) => candidate.event_type === eventType);
    if (!row) return;
    setForm(toForm(row));
    setPreview(null);
  }

  function save(current: FormState) {
    return mutate(
      () =>
        fetch(`/api/v1/integrations/discord/templates/${current.eventType}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ template: toTemplate(current), locale: current.locale }),
        }),
      'Не удалось сохранить шаблон',
      setSaving,
    );
  }

  function resetToDefault(current: FormState) {
    return mutate(
      () =>
        fetch(`/api/v1/integrations/discord/templates/${current.eventType}/reset`, {
          method: 'POST',
          credentials: 'include',
        }),
      'Не удалось сбросить шаблон',
      setResetting,
    );
  }

  if (forbidden) return null;

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Шаблоны сообщений</h2>
      {error ? (
        <div className="mt-3 rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}
      {form === null ? (
        <p className="mt-3 text-sm text-neutral-500">Загрузка шаблонов…</p>
      ) : (
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <label htmlFor={`${baseId}-event`} className="block text-xs text-neutral-400 mb-1">
                  Событие
                </label>
                <select
                  id={`${baseId}-event`}
                  value={form.eventType}
                  onChange={(e) => selectEvent(e.target.value)}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                >
                  {rows.map((row) => (
                    <option key={row.event_type} value={row.event_type}>
                      {eventLabel(row.event_type)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-24">
                <label htmlFor={`${baseId}-locale`} className="block text-xs text-neutral-400 mb-1">
                  Локаль
                </label>
                <select
                  id={`${baseId}-locale`}
                  value={form.locale}
                  onChange={(e) => patch({ locale: e.target.value as TemplateLocale })}
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
                >
                  {LOCALES.map((locale) => (
                    <option key={locale} value={locale}>
                      {locale}
                    </option>
                  ))}
                </select>
              </div>
              {form.isDefault ? (
                <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                  дефолтный
                </span>
              ) : null}
            </div>

            <div>
              <label htmlFor={`${baseId}-title`} className="block text-xs text-neutral-400 mb-1">
                Заголовок
              </label>
              <input
                id={`${baseId}-title`}
                value={form.title}
                onChange={(e) => patch({ title: e.target.value })}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
              />
            </div>

            <div>
              <label htmlFor={`${baseId}-url`} className="block text-xs text-neutral-400 mb-1">
                Ссылка (URL)
              </label>
              <input
                id={`${baseId}-url`}
                value={form.url}
                onChange={(e) => patch({ url: e.target.value })}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor={`${baseId}-description`}
                className="block text-xs text-neutral-400 mb-1"
              >
                Описание
              </label>
              <textarea
                id={`${baseId}-description`}
                rows={4}
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm"
              />
            </div>

            <div>
              <label htmlFor={`${baseId}-color`} className="block text-xs text-neutral-400 mb-1">
                Цвет
              </label>
              <input
                id={`${baseId}-color`}
                type="color"
                value={colorToHex(form.color)}
                onChange={(e) => patch({ color: hexToColor(e.target.value) ?? form.color })}
                className="h-8 w-16 rounded border border-neutral-800 bg-neutral-900"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs uppercase tracking-widest text-neutral-400">Поля</h3>
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      fields: [
                        ...form.fields,
                        { id: nextFieldId(), name: '', value: '', inline: false },
                      ],
                    })
                  }
                  className="rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-600"
                >
                  Добавить поле
                </button>
              </div>
              {form.fields.map((field) => (
                <div
                  key={field.id}
                  className="rounded border border-neutral-800 bg-neutral-900 p-2 space-y-2"
                >
                  <input
                    aria-label="Имя поля"
                    value={field.name}
                    onChange={(e) =>
                      patch({
                        fields: form.fields.map((candidate) =>
                          candidate.id === field.id
                            ? { ...candidate, name: e.target.value }
                            : candidate,
                        ),
                      })
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm"
                  />
                  <input
                    aria-label="Значение поля"
                    value={field.value}
                    onChange={(e) =>
                      patch({
                        fields: form.fields.map((candidate) =>
                          candidate.id === field.id
                            ? { ...candidate, value: e.target.value }
                            : candidate,
                        ),
                      })
                    }
                    className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-xs text-neutral-400">
                      <input
                        type="checkbox"
                        checked={field.inline}
                        onChange={(e) =>
                          patch({
                            fields: form.fields.map((candidate) =>
                              candidate.id === field.id
                                ? { ...candidate, inline: e.target.checked }
                                : candidate,
                            ),
                          })
                        }
                      />
                      В строку
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        patch({
                          fields: form.fields.filter((candidate) => candidate.id !== field.id),
                        })
                      }
                      className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-400 hover:border-red-700"
                    >
                      Удалить поле
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                disabled={saving || resetting}
                onClick={() => void save(form)}
                className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
              >
                {saving ? 'Сохранение…' : 'Сохранить шаблон'}
              </button>
              <button
                type="button"
                disabled={saving || resetting}
                onClick={() => void resetToDefault(form)}
                className="rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-600 disabled:opacity-40"
              >
                {resetting ? 'Сброс…' : 'Сбросить к дефолту'}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-widest text-neutral-400">Предпросмотр</h3>
            {preview ? (
              <div className="space-y-2">
                <div
                  className="rounded border border-neutral-800 bg-neutral-900 p-3 border-l-4"
                  style={{ borderLeftColor: colorToHex(preview.embed.color) }}
                >
                  <p className="text-sm font-medium text-neutral-100">{preview.embed.title}</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-neutral-300">
                    {preview.embed.description}
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {preview.embed.fields.map((field) => (
                      <div key={`${field.name}|${field.value}`}>
                        <p className="text-xs font-medium text-neutral-200">{field.name}</p>
                        <p className="text-xs text-neutral-400">{field.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
                {preview.missing_placeholders.length > 0 ? (
                  <p className="rounded border border-amber-900 bg-amber-950 p-2 text-xs text-amber-200">
                    <span>Неизвестные плейсхолдеры:</span>{' '}
                    <span className="font-mono">{preview.missing_placeholders.join(', ')}</span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
