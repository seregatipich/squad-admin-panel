'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, describeHttpError } from '@/lib/api';
import { isHardFailure } from './config-model';
import type { FileItem } from './FileList';

/**
 * The list of config files of one server.
 *
 * #1335: the list reads every allowlisted file through the bridge, so it is
 * refreshed on mount, after writes and when the tab comes back — not on a
 * poll. A hard failure (the list route 404s, or containerOnlyPreHandler
 * answers 409 external_server for a server with no config tree at all) means
 * every later refresh would fail the same way, so the tab-return refresh stops
 * instead of re-banner-ing forever (#609).
 *
 * @param serverId Server whose files are listed.
 * @param onError Receives the text of a failed refresh.
 * @returns The files and `refreshFiles`, which reloads them now.
 */
export function useConfigFiles(serverId: string, onError: (message: string) => void) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const filesStoppedRef = useRef(false);

  const refreshFiles = useCallback(async () => {
    try {
      const j = await apiFetch<{ items: FileItem[] }>(`/api/v1/servers/${serverId}/configs`);
      setFiles(j.items);
    } catch (e) {
      if (isHardFailure(e)) filesStoppedRef.current = true;
      onError(describeHttpError(e));
    }
  }, [serverId, onError]);

  useEffect(() => {
    filesStoppedRef.current = false;
    void refreshFiles();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || filesStoppedRef.current) return;
      void refreshFiles();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshFiles]);

  return { files, refreshFiles };
}
