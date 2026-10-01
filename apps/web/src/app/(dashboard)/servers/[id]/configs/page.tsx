'use client';
import { BEGIN_MARKER } from '@squad/shared-config/admins-config';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  EmptyState,
  InlineBanner,
  PageContainer,
  SegmentedControl,
} from '@/components/ui';
import { ApiError, apiFetch, apiSend, describeHttpError } from '@/lib/api';
import { useApiResource } from '@/lib/use-polled-resource';
import { BlameView } from './ConfigBlameView';
import { EditorView } from './ConfigEditorView';
import { HistoryView } from './ConfigHistoryView';
import {
  type Confirmation,
  confirmationText,
  PANEL_MANAGED_FILE,
  RESET_EXCLUDED_FILES,
  TABS,
  type Tab,
  UNSAVED_EDITS_WARNING,
} from './config-model';
import { DriftPanel } from './DriftPanel';
import { BEHAVIOR_BADGE, FileList } from './FileList';
import { ManagedFileBanners } from './ManagedFileBanners';
import { managedSegmentLineRange } from './managed-segment';
import { useConfigDrift } from './useConfigDrift';
import { useConfigFiles } from './useConfigFiles';
import { useConfigHistory } from './useConfigHistory';
import { useExternalChangeWatch } from './useExternalChangeWatch';
import { useManagedSegmentGuard } from './useManagedSegmentGuard';

export default function ConfigsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('editor');
  const [content, setContent] = useState<string>('');
  const [serverContent, setServerContent] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  // A config file opens read-only: these files run a live game server, and an
  // editor that accepts keystrokes the moment it loads invites edits nobody
  // meant to make. Editing is armed explicitly, per file, and disarms again
  // on save or discard.
  const [editing, setEditing] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
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

  // Restart button for requires_restart files (CFG-1, #63). A failed read
  // simply leaves the button hidden.
  const { data: me } = useApiResource<{ permissions?: string[] }>('/api/v1/me');
  const canRestart = me?.permissions?.includes('server:restart') ?? false;
  const [restarting, setRestarting] = useState(false);
  const [resetting, setResetting] = useState(false);

  const { files, refreshFiles } = useConfigFiles(id, setErr);
  const history = useConfigHistory(id, selected, tab, setErr);
  const { reset: resetHistory } = history;
  useExternalChangeWatch(id, selected, selectedRef, serverShaRef, setExternalChange);

  const load = useCallback(
    async (name: string) => {
      setErr(null);
      setMsg(null);
      // История, blame и diff принадлежат прежнему файлу; повторная загрузка
      // того же файла (после восстановления версии) их не трогает.
      if (selectedRef.current !== name) resetHistory();
      setSelected(name);
      setTab('editor');
      setEditing(false);
      setExternalChange(null);
      try {
        const j = await apiFetch<{ content: string; sha256: string | null }>(
          `/api/v1/servers/${id}/configs/${name}`,
        );
        // The operator may have clicked another file while this request was in
        // flight; an out-of-order response must not land under the wrong
        // file's editor (#607) — same guard the drift poller already uses.
        if (selectedRef.current !== name) return;
        setContent(j.content);
        setServerContent(j.content);
        setServerSha(j.sha256);
        setDirty(false);
        setCommitMessage('');
      } catch (e) {
        if (selectedRef.current !== name) return;
        setErr(describeHttpError(e));
      }
    },
    [id, resetHistory],
  );

  const drift = useConfigDrift(id, selectedRef, setErr, setMsg, load);
  const { refreshDrift } = drift;

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

  async function save() {
    if (!selected) return;
    // Captured up front: if the operator switches files while the request is
    // in flight, the response must not be applied to whatever file happens
    // to be open when it resolves (#607).
    const target = selected;
    const savedContent = content;
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const j = await apiFetch<{ behavior: string; unchanged?: boolean; sha256?: string }>(
        `/api/v1/servers/${id}/configs/${target}`,
        {
          method: 'PUT',
          // base_sha256 lets the API refuse the write with 409 if the file
          // changed on disk since this content was loaded (#608 — otherwise a
          // concurrent edit, worker write, or manual SSH change is silently
          // clobbered).
          json: {
            content: savedContent,
            message: commitMessage || undefined,
            base_sha256: serverShaRef.current ?? undefined,
          },
        },
      );
      if (selectedRef.current !== target) return;
      setServerContent(savedContent);
      if (j.sha256) setServerSha(j.sha256);
      setDirty(false);
      setEditing(false);
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
      if (e instanceof ApiError && e.status === 409) {
        if (selectedRef.current === target) {
          setErr(
            'Файл изменён на диске с момента открытия. Перезагрузите его (кнопка «Повторить» или переоткройте файл) и повторите правку.',
          );
          const currentSha = e.jsonBody<{ current_sha256?: string | null }>()?.current_sha256;
          if (currentSha) setServerSha(currentSha);
        }
        return;
      }
      if (selectedRef.current !== target) return;
      setErr(describeHttpError(e, true));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setContent(serverContent);
    setDirty(false);
    setEditing(false);
    setMsg(null);
  }

  async function restore(vid: string) {
    if (!selected) return;
    setRestoring(vid);
    try {
      await apiSend(`/api/v1/servers/${id}/configs/${selected}/restore/${vid}`, {
        method: 'POST',
        json: {},
      });
      setMsg('Восстановлено как новая версия');
      await history.loadHistory();
      await load(selected);
    } catch (e) {
      setErr(describeHttpError(e, true));
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
      await apiSend(`/api/v1/servers/${id}/restart`, { method: 'POST' });
      setMsg('Сервер перезапускается…');
    } catch (e) {
      setErr(describeHttpError(e, true));
    } finally {
      setRestarting(false);
    }
  }

  const selectFile = useCallback(
    (name: string) => {
      if (dirty) {
        setConfirmation({ kind: 'switch-file', name });
        return;
      }
      void load(name);
    },
    [dirty, load],
  );

  const requestDriftResolution = useCallback(
    (name: string, action: 'accept' | 'revert') => setConfirmation({ kind: 'drift', name, action }),
    [],
  );

  async function resetToDefault(name: string) {
    if (resetting) return;
    setResetting(true);
    setErr(null);
    setMsg(null);
    try {
      await apiSend(`/api/v1/servers/${id}/configs/${name}/reset-default`, {
        method: 'POST',
        json: {},
      });
      setMsg(`${name}: сброшен к депо-дефолту`);
      await refreshDrift();
      await load(name);
    } catch (e) {
      setErr(describeHttpError(e, true));
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
        await drift.resolveDrift(pending.name, pending.action);
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
        return drift.driftBusy !== null;
      case 'reset':
        return resetting;
    }
  }

  const selectedFile = files.find((f) => f.name === selected) ?? null;
  const isManagedRotation = selected === 'LayerRotation.cfg' && content.includes(BEGIN_MARKER);
  const isManagedAdmins = selected === 'Admins.cfg' && managedSegmentLineRange(content) !== null;
  const showRestart = selectedFile?.behavior === 'requires_restart' && canRestart;
  const showReset = selected !== null && !RESET_EXCLUDED_FILES.includes(selected);
  const { handleEditorMount, segmentNotice } = useManagedSegmentGuard(content, isManagedAdmins);

  const dialog = confirmation ? confirmationText(confirmation) : null;
  const confirmationDiscardsEdits =
    dirty &&
    confirmation !== null &&
    (confirmation.kind === 'restore' ||
      (confirmation.kind === 'reset' && confirmation.name === selected) ||
      (confirmation.kind === 'drift' && confirmation.name === selected));

  return (
    <PageContainer>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Заголовок страницы — имя сервера в layout раздела; здесь h2. */}
        <h2 className="text-[17px] font-semibold text-ink">Конфигурация сервера</h2>
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

      <DriftPanel
        items={drift.driftItems}
        diff={drift.driftDiff}
        busy={drift.driftBusy !== null}
        onOpenDiff={drift.openDriftDiff}
        onCloseDiff={drift.closeDriftDiff}
        onResolve={requestDriftResolution}
      />

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <FileList
          files={files}
          selected={selected}
          driftItems={drift.driftItems}
          onSelect={selectFile}
        />

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
                  <ManagedFileBanners
                    serverId={id}
                    selected={selected}
                    isManagedRotation={isManagedRotation}
                    isManagedAdmins={isManagedAdmins}
                    segmentNotice={segmentNotice}
                  />
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
                    editing={editing}
                    onStartEditing={() => setEditing(true)}
                    locked={isManagedRotation || selected === PANEL_MANAGED_FILE}
                    onMount={handleEditorMount}
                  />
                </>
              ) : null}

              {tab === 'history' ? (
                <HistoryView
                  versions={history.versions}
                  loading={history.versionsLoading}
                  diffFrom={history.diffFrom}
                  diffFromContent={history.diffFromContent}
                  currentContent={serverContent}
                  onOpenDiff={history.openDiff}
                  onCloseDiff={history.closeDiff}
                  onRestore={(vid) => setConfirmation({ kind: 'restore', versionId: vid })}
                  restoring={restoring}
                  canRestore={selected !== PANEL_MANAGED_FILE}
                />
              ) : null}

              {tab === 'blame' ? <BlameView blame={history.blame} /> : null}
            </>
          )}
        </Card>
      </div>

      {confirmation && dialog ? (
        <AlertDialog
          open
          onClose={() => setConfirmation(null)}
          title={dialog.title}
          body={confirmationDiscardsEdits ? `${dialog.body}${UNSAVED_EDITS_WARNING}` : dialog.body}
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
