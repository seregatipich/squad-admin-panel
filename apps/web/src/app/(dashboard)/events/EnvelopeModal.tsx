'use client';
import { InlineBanner, Modal, Skeleton } from '@/components/ui';
import { useApiResource } from '@/lib/use-polled-resource';
import { type EventEnvelope, type EventListItem, formatDateTime, kindLabel } from './helpers';

/** Dialog with the raw envelope of the selected event, loaded when it opens. */
export function EnvelopeModal({
  event,
  onClose,
}: {
  event: EventListItem | null;
  onClose: () => void;
}) {
  const eventId = event?.event_id ?? null;
  const resource = useApiResource<EventEnvelope>(
    eventId === null ? null : `/api/v1/events/${eventId}`,
  );
  const envelope = resource.data ?? null;
  const loading = resource.loading;
  const error = resource.errorMessage;

  return (
    <Modal
      open={event !== null}
      onClose={onClose}
      title={event ? kindLabel(event.kind) : 'Событие'}
      description={event ? `${formatDateTime(event.occurred_at)} · ${event.event_id}` : undefined}
      size="lg"
      closeLabel="Закрыть"
    >
      {loading ? (
        <Skeleton variant="text" count={6} label="Загружаем конверт события" />
      ) : error ? (
        <InlineBanner tone="crit" title="Не удалось загрузить конверт" description={error} />
      ) : envelope ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-ctl bg-raised p-3 font-mono text-2xs leading-relaxed text-ink-2">
          {JSON.stringify(envelope, null, 2)}
        </pre>
      ) : null}
    </Modal>
  );
}
