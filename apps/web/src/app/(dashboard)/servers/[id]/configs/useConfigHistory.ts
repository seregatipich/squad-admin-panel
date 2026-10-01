'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, describeHttpError } from '@/lib/api';
import type { BlameResponse, Tab, Version } from './config-model';

/**
 * Version history, blame and the version-versus-current diff of the open file.
 * History and blame load when their tab is opened.
 *
 * @param serverId Server owning the file.
 * @param selected Name of the open file.
 * @param tab Tab currently shown.
 * @param onError Receives the text of a failed request.
 * @returns The loaded data plus `loadHistory`, `openDiff`, `closeDiff` and
 *   `reset`, which drops everything that belongs to the previous file.
 */
export function useConfigHistory(
  serverId: string,
  selected: string | null,
  tab: Tab,
  onError: (message: string) => void,
) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [diffFrom, setDiffFrom] = useState<string | null>(null);
  const [diffFromContent, setDiffFromContent] = useState<string>('');
  const [blame, setBlame] = useState<BlameResponse | null>(null);

  const loadHistory = useCallback(async () => {
    if (!selected) return;
    setVersionsLoading(true);
    try {
      const j = await apiFetch<{ items: Version[] }>(
        `/api/v1/servers/${serverId}/configs/${selected}/history?limit=100`,
      );
      setVersions(j.items);
    } catch (e) {
      onError(describeHttpError(e));
    } finally {
      setVersionsLoading(false);
    }
  }, [serverId, selected, onError]);

  const loadBlame = useCallback(async () => {
    if (!selected) return;
    try {
      setBlame(
        await apiFetch<BlameResponse>(`/api/v1/servers/${serverId}/configs/${selected}/blame`),
      );
    } catch (e) {
      onError(describeHttpError(e));
    }
  }, [serverId, selected, onError]);

  useEffect(() => {
    if (tab === 'history') void loadHistory();
    if (tab === 'blame') void loadBlame();
  }, [tab, loadBlame, loadHistory]);

  const openDiff = useCallback(
    async (versionId: string) => {
      try {
        const j = await apiFetch<{ content: string }>(
          `/api/v1/servers/${serverId}/configs/${selected}/versions/${versionId}`,
        );
        setDiffFromContent(j.content);
        setDiffFrom(versionId);
      } catch (e) {
        onError(describeHttpError(e));
      }
    },
    [serverId, selected, onError],
  );

  const closeDiff = useCallback(() => setDiffFrom(null), []);

  const reset = useCallback(() => {
    setVersions([]);
    setBlame(null);
    setDiffFrom(null);
    setDiffFromContent('');
  }, []);

  return {
    versions,
    versionsLoading,
    diffFrom,
    diffFromContent,
    blame,
    loadHistory,
    openDiff,
    closeDiff,
    reset,
  };
}
