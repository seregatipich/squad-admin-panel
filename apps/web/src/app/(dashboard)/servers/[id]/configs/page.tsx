'use client';
import type { OnMount } from '@monaco-editor/react';
import { loader } from '@monaco-editor/react';
import { BEGIN_MARKER } from '@squad/shared-config/admins-config';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { LiveIndicator } from '@/components/LiveIndicator';
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

const BEHAVIOR_BADGE: Record<FileItem['behavior'], { label: string; className: string }> = {
  hot_reload: { label: 'live-reload', className: 'bg-green-800 text-green-100' },
  rotation: { label: 'next match', className: 'bg-sky-800 text-sky-100' },
  requires_restart: { label: 'рестарт', className: 'bg-amber-800 text-amber-100' },
};

type Tab = 'editor' | 'history' | 'blame';

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
  const [diffFrom, setDiffFrom] = useState<string | null>(null);
  const [diffFromContent, setDiffFromContent] = useState<string>('');
  const [restoring, setRestoring] = useState<string | null>(null);

  const [blame, setBlame] = useState<BlameResponse | null>(null);

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
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs/${selected}/history?limit=100`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { items: Version[] };
      setVersions(j.items);
    } catch (e) {
      setErr((e as Error).message);
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
    if (!confirm('Создать новую версию с этим содержимым? История сохранится.')) return;
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
    if (!confirm('Перезапустить сервер? Игроки будут отключены на время рестарта.')) return;
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
    const question =
      action === 'accept'
        ? `Принять ручную правку ${name} с диска как новую версию?`
        : `Откатить ${name} к версии панели? Ручные изменения на диске будут перезаписаны.`;
    if (!window.confirm(question)) return;
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

  async function resetToDefault() {
    const name = selected;
    if (!name || resetting) return;
    if (
      !window.confirm(
        `Сбросить ${name} к депо-дефолту? Текущее содержимое будет заменено шаблоном.`,
      )
    )
      return;
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

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Конфигурация сервера</h1>
          <div className="text-xs font-mono text-neutral-500">{id}</div>
        </div>
        <LiveIndicator lastUpdate={lastUpdate} />
      </header>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded border border-green-900 bg-green-950 px-3 py-2 text-sm">{msg}</div>
      ) : null}
      {externalChange ? (
        <div
          data-testid="external-change-banner"
          className="flex items-center justify-between gap-3 rounded border border-amber-900 bg-amber-950/60 px-3 py-2 text-sm"
        >
          <span>
            Файл изменён извне — открыть новую версию?
            {dirty ? (
              <span className="ml-2 text-xs text-amber-300">
                (есть несохранённые правки — они не будут перезаписаны автоматически)
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={acceptExternalChange}
              disabled={dirty}
              className="rounded bg-amber-700 px-2 py-1 text-xs text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Загрузить
            </button>
            <button
              type="button"
              onClick={dismissExternalChange}
              className="rounded border border-amber-800 px-2 py-1 text-xs text-amber-200 hover:bg-amber-900/40"
            >
              Скрыть
            </button>
          </span>
        </div>
      ) : null}
      {driftItems.length > 0 ? (
        <div
          data-testid="config-drift-banner"
          className="space-y-2 rounded border border-red-900 bg-red-950/60 px-3 py-2 text-sm"
        >
          <div className="text-red-200">
            Обнаружены изменения конфигов на диске вне панели ({driftItems.length}):
          </div>
          {driftItems.map((item) => (
            <div key={item.name} className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs">{item.name}</span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void openDriftDiff(item)}
                  className="rounded border border-red-800 px-2 py-1 text-xs text-red-200 hover:bg-red-900/40"
                >
                  Diff
                </button>
                <button
                  type="button"
                  onClick={() => void resolveDrift(item.name, 'accept')}
                  disabled={driftBusy !== null}
                  className="rounded bg-sky-700 px-2 py-1 text-xs text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Принять
                </button>
                <button
                  type="button"
                  onClick={() => void resolveDrift(item.name, 'revert')}
                  disabled={driftBusy !== null}
                  className="rounded bg-amber-700 px-2 py-1 text-xs text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Откатить
                </button>
              </span>
            </div>
          ))}
          {driftDiff ? (
            <div data-testid="config-drift-diff" className="rounded border border-neutral-800">
              <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs">
                <div className="font-mono text-neutral-400">
                  {driftDiff.name}: версия панели → диск
                </div>
                <button
                  type="button"
                  onClick={() => setDriftDiff(null)}
                  className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                >
                  Закрыть diff
                </button>
              </div>
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
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-[260px_1fr] gap-4">
        <aside className="rounded border border-neutral-800 bg-neutral-950">
          <div className="border-b border-neutral-800 px-3 py-2 text-xs uppercase tracking-widest text-neutral-400">
            Файлы ({files.length})
          </div>
          <ul className="max-h-[70vh] overflow-y-auto">
            {files.map((f) => {
              const badge = BEHAVIOR_BADGE[f.behavior];
              return (
                <li key={f.name}>
                  <button
                    type="button"
                    onClick={() => {
                      if (dirty && !confirm('Есть несохранённые изменения. Сбросить?')) return;
                      void load(f.name);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-900 ${selected === f.name ? 'bg-neutral-900' : ''} ${!f.exists ? 'text-neutral-500' : ''}`}
                  >
                    <span className="truncate font-mono">{f.name}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {driftItems.some((d) => d.name === f.name) ? (
                        <span
                          data-testid="file-drift-marker"
                          title="изменён на диске вне панели"
                          className="rounded bg-red-800 px-1 py-[1px] text-[10px] uppercase tracking-widest text-red-100"
                        >
                          drift
                        </span>
                      ) : null}
                      <span
                        className={`rounded px-1 py-[1px] text-[10px] uppercase tracking-widest ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="rounded border border-neutral-800 bg-neutral-950">
          {!selected ? (
            <div className="p-8 text-center text-sm text-neutral-500">
              Выберите файл слева чтобы открыть.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono">{selected}</span>
                  {selectedFile ? (
                    <span
                      className={`rounded px-1 py-[1px] text-[10px] uppercase tracking-widest ${BEHAVIOR_BADGE[selectedFile.behavior].className}`}
                    >
                      {BEHAVIOR_BADGE[selectedFile.behavior].label}
                    </span>
                  ) : null}
                  {dirty ? (
                    <span className="rounded bg-amber-800 px-1 py-[1px] text-[10px] uppercase tracking-widest text-amber-100">
                      изменено
                    </span>
                  ) : null}
                  {showRestart ? (
                    <button
                      type="button"
                      onClick={restartServer}
                      disabled={restarting}
                      className="rounded bg-amber-700 px-2 py-1 text-[11px] text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {restarting ? 'Перезапуск…' : 'Рестарт сервера'}
                    </button>
                  ) : null}
                  {showReset ? (
                    <button
                      type="button"
                      onClick={() => void resetToDefault()}
                      disabled={resetting}
                      className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {resetting ? 'Сброс…' : 'Сброс к дефолту'}
                    </button>
                  ) : null}
                </div>
                <nav className="flex gap-1 text-xs">
                  <TabButton active={tab === 'editor'} onClick={() => setTab('editor')}>
                    Редактор
                  </TabButton>
                  <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
                    История
                  </TabButton>
                  <TabButton active={tab === 'blame'} onClick={() => setTab('blame')}>
                    Blame
                  </TabButton>
                </nav>
              </div>

              {tab === 'editor' ? (
                <>
                  {isManagedRotation ? (
                    <div className="flex items-center justify-between gap-3 border-b border-sky-900 bg-sky-950/40 px-3 py-2 text-xs text-sky-200">
                      <span>
                        Managed-сегмент управляется панелью — редактируйте на странице{' '}
                        <Link
                          href={`/servers/${id}/rotation`}
                          className="underline hover:text-sky-100"
                        >
                          «Ротация»
                        </Link>
                        .
                      </span>
                    </div>
                  ) : null}
                  {isManagedAdmins ? (
                    <div
                      data-testid="managed-admins-banner"
                      className="flex items-center justify-between gap-3 border-b border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
                    >
                      <span>
                        Блок между маркерами{' '}
                        <code className="rounded bg-amber-900/50 px-1">{'//SQUAD-PANEL'}</code>{' '}
                        управляется панелью и доступен только для чтения — меняйте состав через{' '}
                        <Link href="/settings/groups" className="underline hover:text-amber-100">
                          «Группы»
                        </Link>
                        .
                      </span>
                    </div>
                  ) : null}
                  {segmentNotice ? (
                    <div
                      data-testid="managed-segment-notice"
                      className="border-b border-amber-900 bg-amber-900/30 px-3 py-1.5 text-xs text-amber-100"
                    >
                      Правка managed-сегмента отменена — этот блок доступен только для чтения.
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
                  diffFrom={diffFrom}
                  diffFromContent={diffFromContent}
                  currentContent={serverContent}
                  onOpenDiff={openDiff}
                  onCloseDiff={() => setDiffFrom(null)}
                  onRestore={restore}
                  restoring={restoring}
                  filename={selected}
                />
              ) : null}

              {tab === 'blame' ? <BlameView blame={blame} /> : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 ${active ? 'bg-sky-700 text-white' : 'text-neutral-300 hover:bg-neutral-800'}`}
    >
      {children}
    </button>
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
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2 text-xs">
        <input
          type="text"
          value={props.commitMessage}
          onChange={(e) => props.setCommitMessage(e.target.value)}
          placeholder="Комментарий к изменению (опционально)"
          maxLength={500}
          disabled={props.readOnly}
          className="flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs disabled:opacity-40"
        />
        <button
          type="button"
          onClick={props.onDiscard}
          disabled={props.readOnly || !props.dirty || props.saving}
          className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          Сбросить
        </button>
        <button
          type="button"
          onClick={props.onSave}
          disabled={props.readOnly || !props.dirty || props.saving}
          className="rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {props.saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
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
  diffFrom: string | null;
  diffFromContent: string;
  currentContent: string;
  filename: string | null;
  onOpenDiff: (vid: string) => void;
  onCloseDiff: () => void;
  onRestore: (vid: string) => void;
  restoring: string | null;
}) {
  if (props.diffFrom) {
    return (
      <div>
        <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs">
          <div className="font-mono text-neutral-400">
            Сравнение: v{props.diffFrom.slice(0, 8)} → текущая
          </div>
          <button
            type="button"
            onClick={props.onCloseDiff}
            className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Закрыть diff
          </button>
        </div>
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
  return (
    <div className="max-h-[68vh] overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-neutral-950 text-neutral-500">
          <tr>
            <th className="px-3 py-2 text-left">Когда</th>
            <th className="px-3 py-2 text-left">Автор</th>
            <th className="px-3 py-2 text-left">Сообщение</th>
            <th className="px-3 py-2 text-left">sha256</th>
            <th className="px-3 py-2 text-right">Действия</th>
          </tr>
        </thead>
        <tbody>
          {props.versions.map((v) => (
            <tr key={v.id} className="border-t border-neutral-900">
              <td className="px-3 py-1.5 font-mono text-neutral-300">
                {new Date(v.created_at).toLocaleString()}
              </td>
              <td className="px-3 py-1.5 text-neutral-300">
                {v.author_email ?? <span className="text-neutral-500">—</span>}
              </td>
              <td className="px-3 py-1.5 text-neutral-300">
                {v.message ?? <span className="text-neutral-500 italic">без сообщения</span>}
              </td>
              <td className="px-3 py-1.5 font-mono text-neutral-500">{v.sha256?.slice(0, 12)}</td>
              <td className="px-3 py-1.5 text-right">
                <button
                  type="button"
                  onClick={() => props.onOpenDiff(v.id)}
                  className="rounded px-2 py-0.5 text-xs text-sky-400 hover:bg-neutral-900"
                >
                  diff
                </button>
                <button
                  type="button"
                  onClick={() => props.onRestore(v.id)}
                  disabled={props.restoring !== null}
                  className="rounded px-2 py-0.5 text-xs text-amber-400 hover:bg-neutral-900 disabled:opacity-40"
                >
                  {props.restoring === v.id ? '…' : 'restore'}
                </button>
              </td>
            </tr>
          ))}
          {props.versions.length === 0 ? (
            <tr>
              <td colSpan={5} className="p-8 text-center text-neutral-500">
                История пуста — файл ещё ни разу не сохранялся через панель.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function BlameView({ blame }: { blame: BlameResponse | null }) {
  if (!blame) return <div className="p-8 text-center text-sm text-neutral-500">Загрузка…</div>;
  if (blame.lines.length === 0)
    return <div className="p-8 text-center text-sm text-neutral-500">Нет истории.</div>;
  return (
    <div className="max-h-[68vh] overflow-auto font-mono text-xs">
      <table className="w-full">
        <tbody>
          {blame.lines.map((l, i) => {
            const email = l.author_user_id ? (blame.authors[l.author_user_id] ?? '?') : '—';
            return (
              <tr key={`${l.version_id}-${i}`} className="hover:bg-neutral-900/40">
                <td className="w-28 border-r border-neutral-900 px-2 py-0.5 text-neutral-500">
                  {l.version_id.slice(0, 8)}
                </td>
                <td className="w-40 border-r border-neutral-900 px-2 py-0.5 text-neutral-400">
                  {email}
                </td>
                <td className="w-36 border-r border-neutral-900 px-2 py-0.5 text-neutral-500">
                  {new Date(l.created_at).toLocaleDateString()}
                </td>
                <td className="w-10 border-r border-neutral-900 px-2 py-0.5 text-right text-neutral-500">
                  {i + 1}
                </td>
                <td className="whitespace-pre px-2 py-0.5 text-neutral-200">{l.text || ' '}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
