'use client';
import dynamic from 'next/dynamic';
import { use, useCallback, useEffect, useState } from 'react';

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

  async function refreshFiles() {
    try {
      const r = await fetch(`/api/v1/servers/${id}/configs`, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { items: FileItem[] };
      setFiles(j.items);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

  const load = useCallback(
    async (name: string) => {
      setErr(null);
      setMsg(null);
      setSelected(name);
      setTab('editor');
      try {
        const r = await fetch(`/api/v1/servers/${id}/configs/${name}`, {
          credentials: 'include',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { content: string };
        setContent(j.content);
        setServerContent(j.content);
        setDirty(false);
        setCommitMessage('');
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [id],
  );

  async function loadHistory() {
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
  }

  async function loadBlame() {
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
  }

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
      const j = (await r.json()) as { behavior: string; unchanged?: boolean };
      setServerContent(content);
      setDirty(false);
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

  const selectedFile = files.find((f) => f.name === selected) ?? null;

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Конфигурация сервера</h1>
        <div className="text-xs font-mono text-neutral-500">{id}</div>
      </header>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded border border-green-900 bg-green-950 px-3 py-2 text-sm">{msg}</div>
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
                    <span
                      className={`shrink-0 rounded px-1 py-[1px] text-[10px] uppercase tracking-widest ${badge.className}`}
                    >
                      {badge.label}
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
                />
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
          className="flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
        />
        <button
          type="button"
          onClick={props.onDiscard}
          disabled={!props.dirty || props.saving}
          className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          Сбросить
        </button>
        <button
          type="button"
          onClick={props.onSave}
          disabled={!props.dirty || props.saving}
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
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          wordWrap: 'on',
          renderWhitespace: 'boundary',
          scrollBeyondLastLine: false,
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
                <td className="w-10 border-r border-neutral-900 px-2 py-0.5 text-right text-neutral-600">
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
