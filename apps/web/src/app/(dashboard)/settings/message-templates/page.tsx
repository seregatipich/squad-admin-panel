'use client';
import { useEffect, useMemo, useState } from 'react';
import { TemplatePicker } from '@/components/TemplatePicker';
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
  IconButton,
  InlineBanner,
  PageHeader,
  Select,
  Skeleton,
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
import {
  CATEGORY_LABELS,
  LOCALE_LABELS,
  MESSAGE_BODY_MAX,
  MESSAGE_TEMPLATE_CATEGORIES,
  MESSAGE_TEMPLATE_LOCALES,
  type MessageTemplate,
  type MessageTemplateCategory,
  type MessageTemplateLocale,
  substituteTokens,
} from '@/lib/messageTemplates';

interface Me {
  permissions: string[];
}

interface DraftForm {
  title: string;
  body: string;
  category: MessageTemplateCategory;
  locale: MessageTemplateLocale;
  sortOrder: number;
}

const EMPTY_DRAFT: DraftForm = {
  title: '',
  body: '',
  category: 'warn',
  locale: 'ru',
  sortOrder: 0,
};

export default function MessageTemplatesPage() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [samplePlayer, setSamplePlayer] = useState('Игрок42');
  const [sampleServer, setSampleServer] = useState('Squad #1');
  const [composed, setComposed] = useState('');
  const [pendingDelete, setPendingDelete] = useState<MessageTemplate | null>(null);

  const canEdit = useMemo(() => me?.permissions.includes('role:edit') ?? false, [me]);
  const sampleContext = useMemo(
    () => ({ player: samplePlayer, server: sampleServer }),
    [samplePlayer, sampleServer],
  );

  async function loadTemplates() {
    const res = await fetch('/api/v1/message-templates', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setTemplates((await res.json()) as MessageTemplate[]);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, tplRes] = await Promise.all([
          fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/v1/message-templates', { credentials: 'include', cache: 'no-store' }),
        ]);
        if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
        if (!tplRes.ok) throw new Error(`HTTP ${tplRes.status}`);
        if (cancelled) return;
        setMe((await meRes.json()) as Me);
        setTemplates((await tplRes.json()) as MessageTemplate[]);
      } catch (e) {
        if (!cancelled) setMsg({ kind: 'err', text: (e as Error).message });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  function resetDraft() {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  }

  function startEdit(template: MessageTemplate) {
    setEditingId(template.id);
    setDraft({
      title: template.title,
      body: template.body,
      category: template.category,
      locale: template.locale,
      sortOrder: template.sort_order,
    });
    setMsg(null);
  }

  async function submitDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.title.trim()) {
      setMsg({ kind: 'err', text: 'Укажите название шаблона.' });
      return;
    }
    if (!draft.body.trim()) {
      setMsg({ kind: 'err', text: 'Текст шаблона не может быть пустым.' });
      return;
    }
    if (draft.body.length > MESSAGE_BODY_MAX) {
      setMsg({ kind: 'err', text: `Текст длиннее ${MESSAGE_BODY_MAX} символов.` });
      return;
    }
    setBusy(true);
    setMsg(null);
    const payload = {
      title: draft.title.trim(),
      body: draft.body,
      category: draft.category,
      locale: draft.locale,
      sort_order: draft.sortOrder,
    };
    try {
      const res = await fetch(
        editingId ? `/api/v1/message-templates/${editingId}` : '/api/v1/message-templates',
        {
          method: editingId ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${body.error ?? 'ошибка'}`);
      }
      await loadTemplates();
      resetDraft();
      setMsg({ kind: 'ok', text: editingId ? 'Шаблон обновлён.' : 'Шаблон создан.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(template: MessageTemplate) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/message-templates/${template.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_enabled: !template.is_enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadTemplates();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(template: MessageTemplate) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/message-templates/${template.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (editingId === template.id) resetDraft();
      await loadTemplates();
      setMsg({ kind: 'ok', text: 'Шаблон удалён.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  }

  const bodyPreview = substituteTokens(draft.body, sampleContext);

  return (
    <>
      <PageHeader
        title="Шаблоны сообщений"
        subtitle={
          <>
            Заготовленные фразы для модерации. Токены{' '}
            <code className="rounded-ctl bg-raised px-1 font-mono">{'{player}'}</code> и{' '}
            <code className="rounded-ctl bg-raised px-1 font-mono">{'{server}'}</code> подставляются
            при отправке. Отключённые шаблоны не показываются в композере.
          </>
        }
      />

      {msg ? <InlineBanner tone={msg.kind === 'ok' ? 'good' : 'crit'} title={msg.text} /> : null}

      {loading ? (
        <Card>
          <Skeleton variant="row" count={5} label="Загрузка шаблонов сообщений" />
        </Card>
      ) : (
        <>
          {canEdit ? (
            <Card padding="none" as="section">
              <CardHeader title={editingId ? 'Редактировать шаблон' : 'Новый шаблон'} />
              <form onSubmit={submitDraft}>
                <CardBody className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
                    <FieldRow label="Название" className="sm:col-span-2">
                      <TextInput
                        value={draft.title}
                        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                        maxLength={120}
                      />
                    </FieldRow>
                    <FieldRow label="Категория">
                      <Select
                        value={draft.category}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            category: e.target.value as MessageTemplateCategory,
                          }))
                        }
                      >
                        {MESSAGE_TEMPLATE_CATEGORIES.map((category) => (
                          <option key={category} value={category}>
                            {CATEGORY_LABELS[category]}
                          </option>
                        ))}
                      </Select>
                    </FieldRow>
                    <FieldRow label="Язык">
                      <Select
                        value={draft.locale}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            locale: e.target.value as MessageTemplateLocale,
                          }))
                        }
                      >
                        {MESSAGE_TEMPLATE_LOCALES.map((locale) => (
                          <option key={locale} value={locale}>
                            {LOCALE_LABELS[locale]}
                          </option>
                        ))}
                      </Select>
                    </FieldRow>
                  </div>

                  <FieldRow
                    label="Текст"
                    hint={
                      <>
                        <span className={draft.body.length > MESSAGE_BODY_MAX ? 'text-crit' : ''}>
                          {draft.body.length} / {MESSAGE_BODY_MAX}
                        </span>
                        {draft.body ? (
                          <>
                            {' · Предпросмотр: '}
                            <span className="text-ink-2">{bodyPreview}</span>
                          </>
                        ) : null}
                      </>
                    }
                  >
                    <Textarea
                      value={draft.body}
                      onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                      maxLength={MESSAGE_BODY_MAX}
                      rows={3}
                      placeholder="{player}, освободите технику без экипажа на {server}."
                    />
                  </FieldRow>

                  <FieldRow label="Порядок" className="max-w-[8rem]">
                    <TextInput
                      type="number"
                      min={0}
                      value={draft.sortOrder}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, sortOrder: Number(e.target.value) || 0 }))
                      }
                    />
                  </FieldRow>
                </CardBody>
                <CardFooter>
                  {editingId ? (
                    <Button variant="secondary" onClick={resetDraft}>
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

          <Card padding="none" as="section">
            <CardHeader
              title="Шаблоны"
              count={templates.length > 0 ? templates.length : undefined}
            />
            {templates.length === 0 ? (
              <EmptyState
                title="Шаблонов пока нет"
                description={
                  canEdit
                    ? 'Создайте первый шаблон формой выше — он сразу появится в композере.'
                    : 'Шаблоны создаёт администратор с правом изменения ролей.'
                }
              />
            ) : (
              <Table ariaLabel="Шаблоны сообщений">
                <TableHead>
                  <tr>
                    <Th>Название</Th>
                    <Th>Категория</Th>
                    <Th>Язык</Th>
                    <Th>Текст</Th>
                    <Th align="right">Порядок</Th>
                    <Th>Состояние</Th>
                    {canEdit ? <Th align="right">Действия</Th> : null}
                  </tr>
                </TableHead>
                <TableBody>
                  {templates.map((template) => (
                    <TableRow key={template.id}>
                      <Td>{template.title}</Td>
                      <Td className="text-ink-2">{CATEGORY_LABELS[template.category]}</Td>
                      <Td className="text-ink-2">{LOCALE_LABELS[template.locale]}</Td>
                      <Td className="max-w-md text-ink-2">{template.body}</Td>
                      <Td numeric className="text-ink-3">
                        {template.sort_order}
                      </Td>
                      <Td>
                        <Badge tone={template.is_enabled ? 'good' : 'neutral'} size="sm">
                          {template.is_enabled ? 'включён' : 'отключён'}
                        </Badge>
                      </Td>
                      {canEdit ? (
                        <Td align="right">
                          <div className="flex items-center justify-end gap-2">
                            <Switch
                              label={`Включить шаблон ${template.title}`}
                              checked={template.is_enabled}
                              disabled={busy}
                              onChange={() => void toggleEnabled(template)}
                            />
                            <Button size="sm" disabled={busy} onClick={() => startEdit(template)}>
                              Изменить
                            </Button>
                            <IconButton
                              icon={<TrashIcon />}
                              label={`Удалить шаблон ${template.title}`}
                              size="sm"
                              tone="destructive"
                              disabled={busy}
                              onClick={() => setPendingDelete(template)}
                            />
                          </div>
                        </Td>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card padding="none" as="section">
            <CardHeader
              title="Пробный композер"
              description="Выбор шаблона подставляет токены и заполняет поле. Отключённые шаблоны здесь не показываются."
            />
            <CardBody className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FieldRow label="Имя игрока — {player}">
                  <TextInput
                    value={samplePlayer}
                    onChange={(e) => setSamplePlayer(e.target.value)}
                  />
                </FieldRow>
                <FieldRow label="Название сервера — {server}">
                  <TextInput
                    value={sampleServer}
                    onChange={(e) => setSampleServer(e.target.value)}
                  />
                </FieldRow>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="max-h-80 overflow-y-auto pr-1">
                  <TemplatePicker
                    templates={templates}
                    context={sampleContext}
                    onSelect={setComposed}
                  />
                </div>
                <FieldRow label="Итоговое сообщение">
                  <Textarea
                    value={composed}
                    onChange={(e) => setComposed(e.target.value)}
                    rows={6}
                    placeholder="Выберите шаблон слева…"
                  />
                </FieldRow>
              </div>
            </CardBody>
          </Card>
        </>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Удалить шаблон"
        body={
          pendingDelete
            ? `Шаблон «${pendingDelete.title}» будет удалён без возможности восстановления и пропадёт из композера.`
            : ''
        }
        confirmLabel="Удалить шаблон"
        cancelLabel="Отмена"
        tone="destructive"
        busy={busy && pendingDelete !== null}
        onConfirm={() => {
          if (pendingDelete) void deleteTemplate(pendingDelete);
        }}
      />
    </>
  );
}
