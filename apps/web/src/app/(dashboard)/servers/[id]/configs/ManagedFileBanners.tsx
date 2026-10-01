'use client';
import Link from 'next/link';
import { InlineBanner } from '@/components/ui';
import { PANEL_MANAGED_FILE } from './config-model';

/**
 * Notices above the editor for files the panel writes itself: the rotation
 * segment, License.cfg and the Admins.cfg managed block, plus the note shown
 * after an edit of that block was undone.
 *
 * @param serverId Server the open file belongs to, for the links to the pages that own the content.
 * @param selected Name of the open file.
 * @param isManagedRotation LayerRotation.cfg carries the panel-managed segment.
 * @param isManagedAdmins Admins.cfg carries the panel-managed block.
 * @param segmentNotice An edit of the managed block was just undone.
 */
export function ManagedFileBanners({
  serverId,
  selected,
  isManagedRotation,
  isManagedAdmins,
  segmentNotice,
}: {
  serverId: string;
  selected: string;
  isManagedRotation: boolean;
  isManagedAdmins: boolean;
  segmentNotice: boolean;
}) {
  return (
    <>
      {isManagedRotation ? (
        <div className="border-b border-line p-3">
          <InlineBanner
            tone="info"
            title="Managed-сегмент управляется панелью"
            description={
              <>
                Файл открыт только для чтения — состав слоёв редактируется на странице{' '}
                <Link href={`/servers/${serverId}/rotation`} className="text-accent">
                  «Ротация»
                </Link>
                .
              </>
            }
          />
        </div>
      ) : null}
      {selected === PANEL_MANAGED_FILE ? (
        <div className="border-b border-line p-3">
          <InlineBanner
            tone="info"
            title="Файл управляется панелью"
            description={
              <>
                Содержимое показано замаскированным и только для чтения — лицензия меняется на
                странице{' '}
                <Link href={`/servers/${serverId}/settings`} className="text-accent">
                  «Настройки»
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
                <code className="rounded-ctl bg-raised px-1">{'//SQUAD-PANEL'}</code> доступны
                только для чтения — состав меняется через{' '}
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
    </>
  );
}
