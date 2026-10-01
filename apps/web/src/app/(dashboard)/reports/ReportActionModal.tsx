import { Button, FieldRow, InlineBanner, Modal, Textarea, TextInput } from '@/components/ui';
import { BanAltWarningBlock } from './BanAltWarningBlock';
import { ACTION_LABELS, REASON_MAX } from './helpers';
import type { ReportActionModalState } from './report-card-hooks';

/** Modal for a moderation action taken from a report; renders nothing while `modal.type` is unset. */
export function ReportActionModal({
  reportId,
  modal,
}: {
  reportId: string;
  modal: ReportActionModalState;
}) {
  if (!modal.type) return null;
  return (
    <Modal
      open
      onClose={modal.close}
      title={ACTION_LABELS[modal.type]}
      size="md"
      closeLabel="Отмена"
      dismissible={!modal.busy}
      footer={
        <>
          <Button variant="secondary" onClick={modal.close} disabled={modal.busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={modal.submit} loading={modal.busy}>
            {ACTION_LABELS[modal.type]}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FieldRow label="Причина" htmlFor={`action-reason-${reportId}`}>
          <Textarea
            id={`action-reason-${reportId}`}
            value={modal.reason}
            onChange={(e) => modal.setReason(e.target.value)}
            rows={3}
            maxLength={REASON_MAX}
          />
        </FieldRow>
        {modal.type === 'ban' ? (
          <>
            <FieldRow
              label="Срок бана"
              htmlFor={`action-ban-length-${reportId}`}
              hint="0 — навсегда; иначе, например, 3d или 12h."
            >
              <TextInput
                id={`action-ban-length-${reportId}`}
                value={modal.banLength}
                onChange={(e) => modal.setBanLength(e.target.value)}
                className="font-mono"
              />
            </FieldRow>
            <BanAltWarningBlock
              warning={modal.banAltWarning}
              loading={modal.banAltWarningLoading}
              error={modal.banAltWarningError}
              selectedAltIds={modal.selectedAltIds}
              onToggleAlt={modal.toggleAlt}
            />
          </>
        ) : null}
        {modal.error ? (
          <InlineBanner tone="crit" title="Действие не выполнено" description={modal.error} />
        ) : null}
      </div>
    </Modal>
  );
}
