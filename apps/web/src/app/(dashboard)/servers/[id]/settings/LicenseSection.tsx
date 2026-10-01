import type { ServerLicenseState } from '@squad/shared-types';
import { useEffect, useState } from 'react';
import { Badge, Button, GroupedList, GroupedRow, InlineBanner, TextInput } from '@/components/ui';
import { apiSend } from '@/lib/api';
import { describeSettingsError, licenseRestartRequired } from './helpers';
import { useSavedFlag } from './useSavedFlag';

interface LicenseSectionProps {
  serverId: string;
  license: ServerLicenseState | null;
  container: { running: boolean; started_at: string | null } | null;
  /** Перечитывает сервер после привязки или отвязки, не сбрасывая чужие несохранённые правки. */
  onChanged: () => Promise<void>;
}

/** Лицензия сервера (License.cfg) со своим состоянием сохранения. */
export function LicenseSection({ serverId, license, container, onChanged }: LicenseSectionProps) {
  const [licenseId, setLicenseId] = useState(license?.license_id ?? '');
  const [licenseKey, setLicenseKey] = useState('');
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [licenseErr, setLicenseErr] = useState<string | null>(null);
  const [licenseSaved, flashLicenseSaved] = useSavedFlag();
  const restartRequired = licenseRestartRequired(
    license?.updated_at ?? null,
    container?.running ?? false,
    container?.started_at ?? null,
  );

  // Каждое перечитывание сервера приносит актуальный ID лицензии.
  useEffect(() => {
    setLicenseId(license?.license_id ?? '');
  }, [license]);

  async function patchLicense(payload: { license_id: string | null; license_key?: string | null }) {
    setLicenseBusy(true);
    setLicenseErr(null);
    try {
      await apiSend(`/api/v1/servers/${serverId}`, { method: 'PATCH', json: payload });
      setLicenseKey('');
      await onChanged();
      flashLicenseSaved();
    } catch (e) {
      setLicenseErr(describeSettingsError(e));
    } finally {
      setLicenseBusy(false);
    }
  }

  // ID-only edit: with a key already stored, an empty key field means
  // "keep the stored key" — send only the id.
  const saveLicense = () =>
    patchLicense(
      licenseKey ? { license_id: licenseId, license_key: licenseKey } : { license_id: licenseId },
    );

  const detachLicense = () => patchLicense({ license_id: null, license_key: null });

  return (
    <div className="space-y-3">
      {licenseErr ? <InlineBanner tone="crit" title={licenseErr} /> : null}
      {licenseSaved ? <InlineBanner tone="good" title="Сохранено" /> : null}
      <GroupedList
        title="Лицензия"
        footnote={
          restartRequired
            ? 'Лицензия сохранена и применится после перезапуска сервера.'
            : license?.configured
              ? 'Лицензия привязана и применена.'
              : 'License.cfg записывается панелью; применяется после перезапуска сервера.'
        }
      >
        {restartRequired ? (
          <GroupedRow
            label="Нужен перезапуск"
            description="Лицензия сохранена и применится после перезапуска сервера"
            control={<Badge tone="warn">рестарт</Badge>}
          />
        ) : null}
        <GroupedRow
          label="ID лицензии"
          control={
            <div className="w-56">
              <TextInput
                aria-label="ID лицензии"
                value={licenseId}
                onChange={(e) => setLicenseId(e.target.value)}
                placeholder="Не указан"
              />
            </div>
          }
        />
        <GroupedRow
          label="Ключ лицензии"
          control={
            <div className="w-56">
              <TextInput
                type="password"
                aria-label="Ключ лицензии"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                placeholder={license?.configured ? '••••••••  (сохранён)' : 'Не указан'}
              />
            </div>
          }
        />
      </GroupedList>
      <div className="flex justify-end gap-2">
        {/* Отвязка обратима — лицензию можно привязать снова, поэтому кнопка
              вторичная, а не критическая (§5). */}
        <Button disabled={licenseBusy} onClick={detachLicense}>
          Отвязать
        </Button>
        <Button
          variant="primary"
          disabled={!licenseId || (!licenseKey && !license?.configured) || licenseBusy}
          onClick={saveLicense}
        >
          Привязать
        </Button>
      </div>
    </div>
  );
}
