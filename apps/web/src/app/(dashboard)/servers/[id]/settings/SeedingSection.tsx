import {
  meSquadPermissionsResponse,
  type SeedingSettingsResponse,
  seedingSettingsResponse,
} from '@squad/shared-types';
import { useEffect, useState } from 'react';
import { Button, GroupedList, GroupedRow, InlineBanner, TextInput } from '@/components/ui';
import { describeSettingsError, fetchValidated } from './helpers';
import { useSavedFlag } from './useSavedFlag';

interface SeedingSectionProps {
  serverId: string;
  seedLiveAt: number;
  seedHysteresis: number;
  /** Вызывается с ответом API после успешного сохранения, чтобы страница обновила свои данные. */
  onSaved: (updated: SeedingSettingsResponse) => void;
}

/**
 * Пороги сидинга. Секция привязана к праву `manageserver` (а не к
 * `server:edit_settings`, которое управляет остальной страницей) и целиком
 * скрыта без него, а не показывается и отвечает 403 — так же, как композитор
 * чата на странице сервера сверяется с `/api/v1/me` заранее.
 */
export function SeedingSection({
  serverId,
  seedLiveAt,
  seedHysteresis,
  onSaved,
}: SeedingSectionProps) {
  const [canManageServer, setCanManageServer] = useState(false);
  const [seedingDraft, setSeedingDraft] = useState<{
    seed_live_at?: number;
    seed_hysteresis?: number;
  }>({});
  const [seedingBusy, setSeedingBusy] = useState(false);
  const [seedingErr, setSeedingErr] = useState<string | null>(null);
  const [seedingSaved, flashSeedingSaved, clearSeedingSaved] = useSavedFlag();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await fetchValidated('/api/v1/me', meSquadPermissionsResponse, 'профиль');
        if (!cancelled) setCanManageServer(me.squad_permissions?.includes('manageserver') ?? false);
      } catch {
        // permission fetch is best-effort; the section simply stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveSeedingSettings() {
    setSeedingBusy(true);
    setSeedingErr(null);
    try {
      onSaved(
        await fetchValidated(
          `/api/v1/servers/${serverId}/seeding-settings`,
          seedingSettingsResponse,
          'пороги сидинга',
          { method: 'PUT', json: seedingDraft },
        ),
      );
      setSeedingDraft({});
      flashSeedingSaved();
    } catch (e) {
      setSeedingErr(describeSettingsError(e));
    } finally {
      setSeedingBusy(false);
    }
  }

  if (!canManageServer) return null;

  return (
    <div className="space-y-3">
      {seedingErr ? <InlineBanner tone="crit" title={seedingErr} /> : null}
      {seedingSaved ? <InlineBanner tone="good" title="Сохранено" /> : null}
      <GroupedList
        title="Пороги сидинга"
        footnote="Сервер считается «живым», когда игроков не меньше порога; гистерезис не даёт состоянию дрожать у границы."
      >
        <GroupedRow
          label="Порог live"
          description="Игроков"
          control={
            <div className="w-28">
              <TextInput
                type="number"
                aria-label="Порог live (игроков)"
                value={seedingDraft.seed_live_at ?? seedLiveAt}
                onChange={(e) => {
                  setSeedingDraft((prev) => ({
                    ...prev,
                    seed_live_at: Number(e.target.value),
                  }));
                  clearSeedingSaved();
                }}
                min={1}
                max={200}
              />
            </div>
          }
        />
        <GroupedRow
          label="Гистерезис"
          description="Игроков"
          control={
            <div className="w-28">
              <TextInput
                type="number"
                aria-label="Гистерезис (игроков)"
                value={seedingDraft.seed_hysteresis ?? seedHysteresis}
                onChange={(e) => {
                  setSeedingDraft((prev) => ({
                    ...prev,
                    seed_hysteresis: Number(e.target.value),
                  }));
                  clearSeedingSaved();
                }}
                min={0}
                max={50}
              />
            </div>
          }
        />
      </GroupedList>
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={Object.keys(seedingDraft).length === 0}
          loading={seedingBusy}
          onClick={saveSeedingSettings}
        >
          Сохранить пороги
        </Button>
      </div>
    </div>
  );
}
