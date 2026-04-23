'use client';
import dynamic from 'next/dynamic';
import { use, useCallback, useEffect, useState } from 'react';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface FileItem {
  name: string;
  size: number;
  sha256: string | null;
  behavior: 'hot_reload' | 'requires_restart' | 'rotation';
  exists: boolean;
}

const BEHAVIOR_BADGE: Record<FileItem['behavior'], { label: string; className: string }> = {
  hot_reload: { label: 'live-reload', className: 'bg-green-800 text-green-100' },
  rotation: { label: 'next match', className: 'bg-sky-800 text-sky-100' },
  requires_restart: { label: 'рестарт', className: 'bg-amber-800 text-amber-100' },
};

export default function ConfigsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [serverContent, setServerContent] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
  }, [id]);

  const load = useCallback(
    async (name: string) => {
      setErr(null);
      setMsg(null);
      setSelected(name);
      try {
        const r = await fetch(`/api/v1/servers/${id}/configs/${name}`, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { content: string };
        setContent(j.content);
        setServerContent(j.content);
        setDirty(false);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [id],
  );

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
        body: JSON.stringify({ content }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const j = (await r.json()) as { behavior: string };
      setServerContent(content);
      setDirty(false);
      setMsg(
        j.behavior === 'requires_restart' ? 'Сохранено — требуется рестарт сервера' : 'Сохранено',
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
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-900 ${
                      selected === f.name ? 'bg-neutral-900' : ''
                    } ${!f.exists ? 'text-neutral-500' : ''}`}
                  >
                    <span className="truncate font-mono">{f.name}</span>
                    <span
                      className={`shrink-0 rounded px-1 py-[1px] text-[10px] uppercase tracking-widest ${badge.className}`}
                      title={
                        f.behavior === 'hot_reload'
                          ? 'Squad перечитывает файл в работе'
                          : f.behavior === 'rotation'
                            ? 'применится к следующему матчу'
                            : 'нужен рестарт контейнера'
                      }
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
          {selected ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono">{selected}</span>
                  {selectedFile ? (
                    <span
                      className={`rounded px-1 py-[1px] text-[10px] uppercase tracking-widest ${
                        BEHAVIOR_BADGE[selectedFile.behavior].className
                      }`}
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
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={discard}
                    disabled={!dirty || saving}
                    className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                  >
                    Сбросить
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || saving}
                    className="rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Сохраняю…' : 'Сохранить'}
                  </button>
                </div>
              </div>
              <MonacoEditor
                height="70vh"
                defaultLanguage="ini"
                theme="vs-dark"
                value={content}
                onChange={(v) => {
                  const next = v ?? '';
                  setContent(next);
                  setDirty(next !== serverContent);
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: 'on',
                  renderWhitespace: 'boundary',
                  scrollBeyondLastLine: false,
                }}
              />
            </>
          ) : (
            <div className="p-8 text-center text-sm text-neutral-500">
              Выберите файл слева чтобы открыть в редакторе.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
