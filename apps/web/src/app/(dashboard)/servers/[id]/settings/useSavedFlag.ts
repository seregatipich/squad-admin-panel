import { useCallback, useEffect, useRef, useState } from 'react';

const SAVED_FLAG_MS = 2000;

/**
 * Transient "saved" confirmation flag shared by the settings sections.
 *
 * @returns `[saved, flashSaved, clearSaved]`: `flashSaved` raises the flag for
 *   two seconds; `clearSaved` drops it at once (on the next edit). The pending
 *   timer is cancelled on unmount, so no state update fires on a gone section.
 */
export function useSavedFlag(): [boolean, () => void, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const clearSaved = useCallback(() => {
    clearTimer();
    setSaved(false);
  }, [clearTimer]);

  const flashSaved = useCallback(() => {
    clearTimer();
    setSaved(true);
    timer.current = setTimeout(() => setSaved(false), SAVED_FLAG_MS);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return [saved, flashSaved, clearSaved];
}
