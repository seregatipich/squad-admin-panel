'use client';
import type { OnMount } from '@monaco-editor/react';
import { loader } from '@monaco-editor/react';
import { BEGIN_MARKER } from '@squad/shared-config/admins-config';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
import {
  AlertDialog,
  type AlertDialogTone,
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardHeader,
  DateTime,
  EmptyState,
  InlineBanner,
  PageContainer,
  SegmentedControl,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import { managedSegmentLineRange } from './managed-segment';

const POLL_MS = 8000;

type EditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

// Pin the AMD loader to the exact vendored monaco-editor build (#242) so the
// browser always fetches the same DOMPurify copy this repo's dependency
// pins were audited against, instead of whatever "latest" CDN resolves to.
loader.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs' } });

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });
const MonacoDiff = dynamic(
  () => import('@monaco-editor/react').then((m) => ({ default: m.DiffEditor })),
  { ssr: false },
);

interface FileItem {
  name: string;
  size: number;
  sha256: string | null;
  behavior: 'hot_reload' | 'requires_restart' | 'rotation';
  exists: boolean;
}

interface Version {
  id: string;
  sha256: string;
  author_user_id: string | null;
  author_email: string | null;
  message: string | null;
  size: number;
  created_at: string;
}

interface BlameLine {
  text: string;
  version_id: string;
  author_user_id: string | null;
  created_at: string;
}

interface BlameResponse {
  lines: BlameLine[];
  authors: Record<string, string>;
}

// CFG-2 (#64): generic drift status for the non-managed config files.
interface DriftItem {
  name: string;
  state: 'in_sync' | 'drift' | 'missing' | 'unreachable' | 'unknown';
  disk_sha256: string | null;
  version_sha256: string | null;
  tip_version_id: string | null;
}

/** Files whose drift/reset story is owned by dedicated machinery — no
 *  reset-to-depot-default button for them. */
const RESET_EXCLUDED_FILES = ['License.cfg', 'Admins.cfg', 'LayerRotation.cfg'];

/**
 * Когда правка доедет до игры. Метка русская и короткая, а полное объяснение
 * живёт в `title`: в списке из двадцати файлов на подпись есть одна строка.
 */
const BEHAVIOR_BADGE: Record<
  FileItem['behavior'],
  { label: string; hint: string; tone: BadgeTone }
> = {
  hot_reload: {
    label: 'на лету',
    hint: 'Squad перечитает файл сам, в течение примерно 60 секунд',
    tone: 'good',
  },
  rotation: {
    label: 'со следующим матчем',
    hint: 'Правка применится, когда начнётся следующий матч',
    tone: 'accent',
  },
  requires_restart: {
    label: 'рестарт',
    hint: 'Правка применится только после перезапуска сервера',
    tone: 'warn',
  },
};

type Tab = 'editor' | 'history' | 'blame';

const TABS = [
  { value: 'editor', label: 'Редактор' },
  { value: 'history', label: 'История' },
  { value: 'blame', label: 'Blame' },
];

/**
 * Вопрос, на который оператор ещё не ответил.
 *
 * Раньше это был `window.confirm`, и вся ветка была синхронной. Диалог
 * подтверждения асинхронный, поэтому намерение приходится хранить: пока окно
 * открыто, страница помнит, что именно она собиралась сделать.
 */
type Confirmation =
  | { kind: 'switch-file'; name: string }
  | { kind: 'restore'; versionId: string }
  | { kind: 'restart' }
  | { kind: 'drift'; name: string; action: 'accept' | 'revert' }
  | { kind: 'reset'; name: string };

/** Текст диалога подтверждения: что произойдёт и как называется само действие. */
function confirmationText(c: Confirmation): {
  title: string;
  body: string;
  confirmLabel: string;
  tone: AlertDialogTone;
} {
  switch (c.kind) {
    case 'switch-file':
      return {
        title: 'Открыть другой файл?',
        body: 'В открытом файле есть несохранённые правки. Если открыть другой файл, они пропадут — на диске и в истории останется прежнее содержимое.',
        confirmLabel: 'Открыть без сохранения',
        tone: 'default',
      };
    case 'restore':
      return {
        title: 'Восстановить эту версию?',
        body: 'Содержимое версии станет новой версией файла. История сохранится целиком, ничего не удаляется.',
        confirmLabel: 'Восстановить как новую версию',
        tone: 'default',
      };
    case 'restart':
      return {
        title: 'Перезапустить сервер?',
        body: 'Игроки будут отключены на время рестарта.',
        confirmLabel: 'Перезапустить сервер',
        tone: 'default',
      };
    case 'drift':
      return c.action === 'accept'
        ? {
            title: `Принять правку ${c.name} с диска?`,
            body: 'Содержимое файла с диска станет новой версией в панели.',
            confirmLabel: 'Принять правку с диска',
            tone: 'default',
          }
        : {
            title: `Откатить ${c.name} к версии панели?`,
            body: 'Ручные изменения на диске будут перезаписаны. Панель их не сохраняла, восстановить будет нечем.',
            confirmLabel: 'Откатить к версии панели',
            tone: 'destructive',
          };
    case 'reset':
      return {
        title: `Сбросить ${c.name} к депо-дефолту?`,
        body: 'Текущее содержимое файла будет заменено шаблоном из поставки. Прежнее содержимое останется в истории версий.',
        confirmLabel: 'Сбросить к дефолту',
        tone: 'default',
      };
  }
}

export default function ConfigsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('editor');
  const [content, setContent] = useState<string>('');
  const [serverContent, setServerContent] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [versions, setVersions] = useState<Version[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [diffFrom, setDiffFrom] = useState<string | null>(null);
  const [diffFromContent, setDiffFromContent] = useState<string>('');
  const [restoring, setRestoring] = useState<string | null>(null);

  const [blame, setBlame] = useState<BlameResponse | null>(null);

  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [serverSha, setServerSha] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState<{ sha: string; content: string } | null>(
    null,
  );
  const dirtyRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const serverShaRef = useRef<string | null>(null);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    serverShaRef.current = serverSha;
  }, [serverSha]);

  // Admins.cfg managed-segment read-only enforcement (CFG-1, #63). monaco
  // 0.56.0 has no read-only-range API, so the segment is guarded by a
  // decorations overlay plus an undo of any edit that touches it — the rest
  // of the file stays editable.
  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<MonacoInstance | null>(null);
  const decorationsRef = useRef<ReturnType<EditorInstance['createDecorationsCollection']> | null>(
    null,
  );
  const protectedRangeRef = useRef<{ startLine: number; endLine: number } | null>(null);
  const undoingRef = useRef(false);
  const [editorReady, setEditorReady] = useState(false);
  const [segmentNotice, setSegmentNotice] = useState(false);
  const segmentNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restart button for requires_restart files (CFG-1, #63).
  const [canRestart, setCanRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Config drift banner + resolution (CFG-2, #64).
  const [driftItems, setDriftItems] = useState<DriftItem[]>([]);
  const [driftDiff, setDriftDiff] = useState<{ name: string; tip: string; disk: string } | null>(
    null,
  );
  const [driftBusy, setDriftBusy] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const refreshFiles = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs`, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { items: FileItem[] };
      setFiles(j.items);
      setLastUpdate(new Date());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void refreshFiles();
    const t = setInterval(() => {
      void refreshFiles();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refreshFiles]);

  const refreshDrift = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs/drift`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) return;
      const j = (await r.json()) as { items: DriftItem[] };
      setDriftItems(j.items.filter((i) => i.state === 'drift'));
    } catch {
      // best-effort polling; keep the last known drift state on transient errors
    }
  }, [id]);

  useEffect(() => {
    void refreshDrift();
    const t = setInterval(() => {
      void refreshDrift();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refreshDrift]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    async function poll() {
      const target = selectedRef.current;
      if (!target) return;
      try {
        const r = await fetch(`/api/v1/servers/${id}/configs/${target}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) return;
        const j = (await r.json()) as { content: string; sha256: string | null };
        if (cancelled || selectedRef.current !== target) return;
        if (j.sha256 && serverShaRef.current && j.sha256 !== serverShaRef.current) {
          setExternalChange({ sha: j.sha256, content: j.content });
        }
      } catch {
        // ignore transient errors during polling
      }
    }
    const t = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id, selected]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
        if (!r.ok || cancelled) return;
        const me = (await r.json()) as { permissions?: string[] };
        if (!cancelled) setCanRestart(me.permissions?.includes('server:restart') ?? false);
      } catch {
        // best-effort; the restart button simply stays hidden without the permission
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const flashSegmentNotice = useCallback(() => {
    setSegmentNotice(true);
    if (segmentNoticeTimer.current) clearTimeout(segmentNoticeTimer.current);
    segmentNoticeTimer.current = setTimeout(() => setSegmentNotice(false), 2500);
  }, []);

  const handleEditorMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      editor.onDidChangeModelContent((ev) => {
        // Ignore the model change our own undo produces, otherwise the guard
        // would fight the undo it just issued and loop forever.
        if (undoingRef.current) return;
        const range = protectedRangeRef.current;
        if (!range) return;
        const touchesSegment = ev.changes.some(
          (c) =>
            c.range.startLineNumber <= range.endLine && c.range.endLineNumber >= range.startLine,
        );
        if (!touchesSegment) return;
        undoingRef.current = true;
        editor.trigger('managed-segment', 'undo', null);
        undoingRef.current = false;
        flashSegmentNotice();
      });
      setEditorReady(true);
    },
    [flashSegmentNotice],
  );

  const load = useCallback(
    async (name: string) => {
      setErr(null);
      setMsg(null);
      setSelected(name);
      setTab('editor');
      setExternalChange(null);
      try {
        const r = await fetch(`/api/v1/servers/${id}/configs/${name}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { content: string; sha256: string | null };
        setContent(j.content);
        setServerContent(j.content);
        setServerSha(j.sha256);
        setDirty(false);
        setCommitMessage('');
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [id],
  );

  const acceptExternalChange = useCallback(() => {
    if (!externalChange) return;
    if (dirtyRef.current) return;
    setContent(externalChange.content);
    setServerContent(externalChange.content);
    setServerSha(externalChange.sha);
    setDirty(false);
    setExternalChange(null);
    setMsg('Загружена новая версия с диска');
  }, [externalChange]);

  const dismissExternalChange = useCallback(() => {
    setExternalChange(null);
  }, []);

  const loadHistory = useCallback(async () => {
    if (!selected) return;
    setVersionsLoading(true);
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs/${selected}/history?limit=100`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { items: Version[] };
      setVersions(j.items);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setVersionsLoading(false);
    }
  }, [id, selected]);

  const loadBlame = useCallback(async () => {
    if (!selected) return;
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs/${selected}/blame`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as BlameResponse;
      setBlame(j);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id, selected]);

  useEffect(() => {
    if (tab === 'history') void loadHistory();
    if (tab === 'blame') void loadBlame();
  }, [tab, loadBlame, loadHistory]);

  async function save() {
    if (!selected) return;
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs/${selected}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, message: commitMessage || undefined }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const j = (await r.json()) as { behavior: string; unchanged?: boolean; sha256?: string };
      setServerContent(content);
      if (j.sha256) setServerSha(j.sha256);
      setDirty(false);
      setExternalChange(null);
      setCommitMessage('');
      setMsg(
        j.unchanged
          ? 'Нет изменений — версия не создана'
          : j.behavior === 'requires_restart'
            ? 'Сохранено — требуется рестарт сервера'
            : j.behavior === 'rotation'
              ? 'Сохранено — применится со следующим матчем'
              : 'Сохранено — Squad перечитает в течение ~60 секунд',
      );
      void refreshFiles();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setContent(serverContent);
    setDirty(false);
    setMsg(null);
  }

  async function openDiff(vid: string) {
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs/${selected}/versions/${vid}`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { content: string };
      setDiffFromContent(j.content);
      setDiffFrom(vid);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function restore(vid: string) {
    if (!selected) return;
    setRestoring(vid);
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs/${selected}/restore/${vid}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      setMsg('Восстановлено как новая версия');
      await loadHistory();
      await load(selected);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRestoring(null);
    }
  }

  async function restartServer() {
    if (restarting) return;
    setRestarting(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/servers/${id}/restart`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      setMsg('Сервер перезапускается…');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRestarting(false);
    }
  }

  async function resolveDrift(name: string, action: 'accept' | 'revert') {
    setDriftBusy(name);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs/${name}/drift/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      setMsg(
        action === 'accept'
          ? `${name}: правка с диска принята как новая версия`
          : `${name}: файл восстановлен из версии панели`,
      );
      setDriftDiff(null);
      await refreshDrift();
      if (selectedRef.current === name) await load(name);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDriftBusy(null);
    }
  }

  async function openDriftDiff(item: DriftItem) {
    setErr(null);
    try {
      let tip = '';
      if (item.tip_version_id) {
        const r = await fetch(
          `/api/v1/servers/${id}/configs/${item.name}/versions/${item.tip_version_id}`,
          { credentials: 'include' },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        tip = ((await r.json()) as { content: string }).content;
      }
      const diskR = await fetch(`/api/v1/servers/${id}/configs/${item.name}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!diskR.ok) throw new Error(`HTTP ${diskR.status}`);
      const disk = ((await diskR.json()) as { content: string }).content;
      setDriftDiff({ name: item.name, tip, disk });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function resetToDefault(name: string) {
    if (resetting) return;
    setResetting(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs/${name}/reset-default`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      setMsg(`${name}: сброшен к депо-дефолту`);
      await refreshDrift();
      await load(name);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setResetting(false);
    }
  }

  /** Выполнить то действие, ради которого открывали диалог подтверждения. */
  async function runConfirmation() {
    const pending = confirmation;
    if (!pending) return;
    switch (pending.kind) {
      case 'switch-file':
        setConfirmation(null);
        await load(pending.name);
        return;
      case 'restore':
        await restore(pending.versionId);
        break;
      case 'restart':
        await restartServer();
        break;
      case 'drift':
        await resolveDrift(pending.name, pending.action);
        break;
      case 'reset':
        await resetToDefault(pending.name);
        break;
    }
    setConfirmation(null);
  }

  /** Идёт ли уже запрос по открытому вопросу — окно на это время запирается. */
  function confirmationBusy(pending: Confirmation): boolean {
    switch (pending.kind) {
      case 'switch-file':
        return false;
      case 'restore':
        return restoring !== null;
      case 'restart':
        return restarting;
      case 'drift':
        return driftBusy !== null;
      case 'reset':
        return resetting;
    }
  }

  const selectedFile = files.find((f) => f.name === selected) ?? null;
  const isManagedRotation = selected === 'LayerRotation.cfg' && content.includes(BEGIN_MARKER);
  const isManagedAdmins = selected === 'Admins.cfg' && managedSegmentLineRange(content) !== null;
  const showRestart = selectedFile?.behavior === 'requires_restart' && canRestart;
  const showReset = selected !== null && !RESET_EXCLUDED_FILES.includes(selected);

  useEffect(() => {
    if (!editorReady) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    // Squad ships CRLF configs; keep the model's EOL aligned so getValue()
    // (and therefore the PUT payload) round-trips byte-identically.
    if (content.includes('\r\n')) {
      model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
    }
    const range = isManagedAdmins ? managedSegmentLineRange(content) : null;
    protectedRangeRef.current = range;
    decorationsRef.current?.clear();
    decorationsRef.current = null;
    if (range) {
      decorationsRef.current = editor.createDecorationsCollection([
        {
          range: new monaco.Range(range.startLine, 1, range.endLine, 1),
          options: {
            isWholeLine: true,
            className: 'squad-managed-segment',
            linesDecorationsClassName: 'squad-managed-segment-gutter',
            hoverMessage: { value: 'управляется панелью' },
          },
        },
      ]);
    }
  }, [editorReady, content, isManagedAdmins]);

  useEffect(
    () => () => {
      if (segmentNoticeTimer.current) clearTimeout(segmentNoticeTimer.current);
    },
    [],
  );

  const dialog = confirmation ? confirmationText(confirmation) : null;

  return (
    <PageContainer>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Заголовок страницы — имя сервера в layout раздела; здесь h2. */}
        <h2 className="text-[17px] font-semibold text-ink">Конфигурация сервера</h2>
        <LiveIndicator lastUpdate={lastUpdate} />
      </div>

      {err ? (
        <InlineBanner
          tone="crit"
          title="Запрос к серверу не прошёл"
          description={err}
          action={
            <Button
              size="sm"
              onClick={() => {
                setErr(null);
                void refreshFiles();
                // Открытый файл перечитывается только когда в нём нет правок:
                // «Повторить» не имеет права молча стереть несохранённое.
                if (selected && !dirtyRef.current) void load(selected);
              }}
            >
              Повторить
            </Button>
          }
        />
      ) : null}
      {msg ? (
        <InlineBanner
          tone="good"
          title={msg}
          onDismiss={() => setMsg(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}

      {externalChange ? (
        <div data-testid="external-change-banner">
          <InlineBanner
            tone="warn"
            title="Файл изменён извне — открыть новую версию?"
            description={
              dirty
                ? 'Есть несохранённые правки, поэтому автоматически ничего не перезаписывается: сначала сохраните или сбросьте их.'
                : 'На диске появилось содержимое новее того, что открыто в редакторе.'
            }
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={acceptExternalChange} disabled={dirty}>
                  Загрузить
                </Button>
                <Button size="sm" onClick={dismissExternalChange}>
                  Скрыть
                </Button>
              </div>
            }
          />
        </div>
      ) : null}

      {driftItems.length > 0 ? (
        <div data-testid="config-drift-banner" className="space-y-3">
          <InlineBanner
            tone="warn"
            title={`Конфиги изменены на диске вне панели (${driftItems.length})`}
            description={
              <ul className="space-y-1">
                {driftItems.map((item) => (
                  <li key={item.name} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs text-ink-2">{item.name}</span>
                    <span className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" onClick={() => void openDriftDiff(item)}>
                        Diff
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={driftBusy !== null}
                        onClick={() =>
                          setConfirmation({ kind: 'drift', name: item.name, action: 'accept' })
                        }
                      >
                        Принять
                      </Button>
                      <Button
                        size="sm"
                        disabled={driftBusy !== null}
                        onClick={() =>
                          setConfirmation({ kind: 'drift', name: item.name, action: 'revert' })
                        }
                      >
                        Откатить
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            }
          />
          {driftDiff ? (
            <div data-testid="config-drift-diff">
              <Card padding="none">
                <CardHeader
                  title={`${driftDiff.name}: версия панели → диск`}
                  actions={
                    <Button size="sm" variant="ghost" onClick={() => setDriftDiff(null)}>
                      Закрыть сравнение
                    </Button>
                  }
                />
                <MonacoDiff
                  height="45vh"
                  language="ini"
                  theme="vs-dark"
                  original={driftDiff.tip}
                  modified={driftDiff.disk}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 13,
                    renderSideBySide: true,
                    scrollBeyondLastLine: false,
                  }}
                />
              </Card>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card padding="none">
          <CardHeader title="Файлы" count={files.length} />
          <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
            {files.map((f) => {
              const badge = BEHAVIOR_BADGE[f.behavior];
              return (
                <li key={f.name}>
                  <button
                    type="button"
                    aria-current={selected === f.name || undefined}
                    onClick={() => {
                      if (dirty) {
                        setConfirmation({ kind: 'switch-file', name: f.name });
                        return;
                      }
                      void load(f.name);
                    }}
                    className={`flex h-9 w-full items-center justify-between gap-2 px-3 text-left text-xs transition-colors duration-150 hover:bg-raised/40 ${
                      selected === f.name ? 'bg-raised' : ''
                    } ${f.exists ? '' : 'text-ink-3'}`}
                  >
                    <span className="truncate font-mono">{f.name}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {driftItems.some((d) => d.name === f.name) ? (
                        <span data-testid="file-drift-marker">
                          <Badge tone="crit" size="sm" title="Изменён на диске вне панели">
                            изменён
                          </Badge>
                        </span>
                      ) : null}
                      <Badge tone={badge.tone} size="sm" title={badge.hint}>
                        {badge.label}
                      </Badge>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card padding="none" as="section">
          {!selected ? (
            <EmptyState
              title="Файл не выбран"
              description="Выберите файл в списке слева — он откроется в редакторе, вместе с историей версий и авторством строк."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-semibold text-ink">{selected}</span>
                  {selectedFile ? (
                    <Badge
                      tone={BEHAVIOR_BADGE[selectedFile.behavior].tone}
                      size="sm"
                      title={BEHAVIOR_BADGE[selectedFile.behavior].hint}
                    >
                      {BEHAVIOR_BADGE[selectedFile.behavior].label}
                    </Badge>
                  ) : null}
                  {dirty ? (
                    <Badge tone="warn" size="sm">
                      изменено
                    </Badge>
                  ) : null}
                  {showRestart ? (
                    <Button
                      size="sm"
                      loading={restarting}
                      onClick={() => setConfirmation({ kind: 'restart' })}
                    >
                      Рестарт сервера
                    </Button>
                  ) : null}
                  {showReset ? (
                    <Button
                      size="sm"
                      loading={resetting}
                      onClick={() => setConfirmation({ kind: 'reset', name: selected })}
                    >
                      Сброс к дефолту
                    </Button>
                  ) : null}
                </div>
                <SegmentedControl
                  items={TABS}
                  value={tab}
                  onChange={(value) => setTab(value as Tab)}
                  size="sm"
                  ariaLabel="Что показывать по файлу"
                />
              </div>

              {tab === 'editor' ? (
                <>
                  {isManagedRotation ? (
                    <div className="border-b border-line p-3">
                      <InlineBanner
                        tone="info"
                        title="Managed-сегмент управляется панелью"
                        description={
                          <>
                            Файл открыт только для чтения — состав слоёв редактируется на странице{' '}
                            <Link href={`/servers/${id}/rotation`} className="text-accent">
                              «Ротация»
                            </Link>
                            .
                          </>
                        }
                      />
                    </div>
                  ) : null}
                  {isManagedAdmins ? (
                    <div data-testid="managed-admins-banner" className="border-b border-line p-3">
                      <InlineBanner
                        tone="warn"
                        title="Блок //SQUAD-PANEL управляется панелью"
                        description={
                          <>
                            Строки между маркерами{' '}
                            <code className="rounded-ctl bg-raised px-1">{'//SQUAD-PANEL'}</code>{' '}
                            доступны только для чтения — состав меняется через{' '}
                            <Link href="/settings/groups" className="text-accent">
                              «Группы»
                            </Link>
                            . Остальной файл редактируется как обычно.
                          </>
                        }
                      />
                    </div>
                  ) : null}
                  {segmentNotice ? (
                    <div data-testid="managed-segment-notice" className="border-b border-line p-3">
                      <InlineBanner
                        tone="warn"
                        title="Правка managed-сегмента отменена"
                        description="Этот блок доступен только для чтения."
                      />
                    </div>
                  ) : null}
                  <EditorView
                    content={content}
                    onChange={(v) => {
                      setContent(v);
                      setDirty(v !== serverContent);
                    }}
                    commitMessage={commitMessage}
                    setCommitMessage={setCommitMessage}
                    dirty={dirty}
                    saving={saving}
                    onSave={save}
                    onDiscard={discard}
                    readOnly={isManagedRotation}
                    onMount={handleEditorMount}
                  />
                </>
              ) : null}

              {tab === 'history' ? (
                <HistoryView
                  versions={versions}
                  loading={versionsLoading}
                  diffFrom={diffFrom}
                  diffFromContent={diffFromContent}
                  currentContent={serverContent}
                  onOpenDiff={openDiff}
                  onCloseDiff={() => setDiffFrom(null)}
                  onRestore={(vid) => setConfirmation({ kind: 'restore', versionId: vid })}
                  restoring={restoring}
                />
              ) : null}

              {tab === 'blame' ? <BlameView blame={blame} /> : null}
            </>
          )}
        </Card>
      </div>

      {confirmation && dialog ? (
        <AlertDialog
          open
          onClose={() => setConfirmation(null)}
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.confirmLabel}
          cancelLabel="Отмена"
          tone={dialog.tone}
          busy={confirmationBusy(confirmation)}
          onConfirm={runConfirmation}
        />
      ) : null}
    </PageContainer>
  );
}

function EditorView(props: {
  content: string;
  onChange: (v: string) => void;
  commitMessage: string;
  setCommitMessage: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  readOnly?: boolean;
  onMount?: OnMount;
}) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <TextInput
          value={props.commitMessage}
          onChange={(e) => props.setCommitMessage(e.target.value)}
          placeholder="Комментарий к изменению (необязательно)"
          aria-label="Комментарий к изменению"
          maxLength={500}
          disabled={props.readOnly}
          className="flex-1"
        />
        <Button onClick={props.onDiscard} disabled={props.readOnly || !props.dirty || props.saving}>
          Сбросить
        </Button>
        <Button
          variant="primary"
          onClick={props.onSave}
          loading={props.saving}
          disabled={props.readOnly || !props.dirty}
        >
          Сохранить
        </Button>
      </div>
      <MonacoEditor
        height="65vh"
        defaultLanguage="ini"
        theme="vs-dark"
        value={props.content}
        onChange={(v) => props.onChange(v ?? '')}
        onMount={props.onMount}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          wordWrap: 'on',
          renderWhitespace: 'boundary',
          scrollBeyondLastLine: false,
          readOnly: props.readOnly ?? false,
        }}
      />
    </>
  );
}

function HistoryView(props: {
  versions: Version[];
  loading: boolean;
  diffFrom: string | null;
  diffFromContent: string;
  currentContent: string;
  onOpenDiff: (vid: string) => void;
  onCloseDiff: () => void;
  onRestore: (vid: string) => void;
  restoring: string | null;
}) {
  const locale = useIntlLocale();
  if (props.diffFrom) {
    return (
      <div>
        <CardHeader
          title={`Сравнение: v${props.diffFrom.slice(0, 8)} → текущая`}
          actions={
            <Button size="sm" variant="ghost" onClick={props.onCloseDiff}>
              Закрыть сравнение
            </Button>
          }
        />
        <MonacoDiff
          height="65vh"
          language="ini"
          theme="vs-dark"
          original={props.diffFromContent}
          modified={props.currentContent}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            renderSideBySide: true,
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    );
  }

  if (props.loading && props.versions.length === 0) {
    return (
      <div className="p-4">
        <SkeletonTable rows={6} cols={5} label="Загружаем историю версий" />
      </div>
    );
  }

  if (props.versions.length === 0) {
    return (
      <EmptyState
        title="История пуста"
        description="Файл ещё ни разу не сохранялся через панель — первая версия появится после первого сохранения."
      />
    );
  }

  return (
    <Table dense maxHeight="68vh" ariaLabel="История версий файла">
      <TableHead>
        <TableRow>
          <Th>Когда</Th>
          <Th>Автор</Th>
          <Th>Сообщение</Th>
          <Th>SHA-256</Th>
          <Th align="right">Действия</Th>
        </TableRow>
      </TableHead>
      <TableBody>
        {props.versions.map((v) => (
          <TableRow key={v.id}>
            <Td className="whitespace-nowrap tabular-nums">
              <DateTime value={v.created_at} locale={locale} />
            </Td>
            <Td>{v.author_email ?? <span className="text-ink-3">—</span>}</Td>
            <Td>{v.message ?? <span className="text-ink-3">без сообщения</span>}</Td>
            <Td className="font-mono text-ink-3">{v.sha256?.slice(0, 12)}</Td>
            <Td align="right">
              <span className="flex items-center justify-end gap-1">
                <Button size="sm" variant="plain" onClick={() => props.onOpenDiff(v.id)}>
                  Сравнить
                </Button>
                <Button
                  size="sm"
                  loading={props.restoring === v.id}
                  disabled={props.restoring !== null}
                  onClick={() => props.onRestore(v.id)}
                >
                  Восстановить
                </Button>
              </span>
            </Td>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BlameView({ blame }: { blame: BlameResponse | null }) {
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
  );
}
