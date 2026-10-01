import { useState } from 'react';
import { Button, FieldRow, InlineBanner, Modal, Textarea } from '@/components/ui';
import { apiSend } from '@/lib/api';
import { NOTE_MAX, playerLabel, type ReportTargetGroup } from './helpers';
import { ReportCard } from './ReportCard';
import { describeReportError } from './report-errors';

/**
 * A "N жалоб на игрока X" block for the pending queue (REPORT-3, #113 P2):
 * groups every pending/in-review report against one target under a single
 * "Закрыть группу" action that resolves them all in one request, each still
 * getting its own audit entry server-side.
 *
 * Заметка закрытия спрашивается в модальном окне, а не через `window.prompt`:
 * системный запрос не поддаётся стилю, не показывает, какую именно группу
 * закрывают, и в браузере может быть отключён пользователем целиком.
 */
export function ReportGroupBlock({
  group,
  canHandle,
  onSaved,
}: {
  group: ReportTargetGroup;
  canHandle: boolean;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askNote, setAskNote] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  const targetLabel = playerLabel(group.target_player_id, group.target_name);

  async function closeGroup() {
    const trimmed = note.trim();
    if (!trimmed) {
      setNoteError('Нужна заметка для закрытия группы.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiSend('/api/v1/reports/bulk-resolve', {
        method: 'POST',
        json: {
          target_player_id: group.target_player_id,
          status: 'resolved',
          resolution_note: trimmed,
        },
      });
      setAskNote(false);
      setNote('');
      onSaved();
    } catch (e) {
      setError(describeReportError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    /* Поверхность предупреждающего тона, а не `Card`: тон карточки задаётся
       её собственными `border-line`/`bg-surface`, и переопределение тех же
       свойств утилитами Tailwind разрешается порядком правил в готовом CSS,
       а не порядком классов здесь. */
    <section className="space-y-3 rounded-card border border-warn/40 bg-warn/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">
          {group.reports.length} жалоб на игрока {targetLabel}
        </h2>
        {canHandle ? (
          <Button
            size="sm"
            onClick={() => {
              setNoteError(null);
              setAskNote(true);
            }}
          >
            Закрыть группу
          </Button>
        ) : null}
      </div>

      {error ? <InlineBanner tone="crit" title="Группа не закрыта" description={error} /> : null}

      <div className="space-y-3">
        {group.reports.map((report) => (
          <ReportCard key={report.id} report={report} canHandle={canHandle} onSaved={onSaved} />
        ))}
      </div>

      {askNote ? (
        <Modal
          open
          onClose={() => setAskNote(false)}
          title="Закрыть группу жалоб"
          description={`Все жалобы на игрока ${targetLabel} будут помечены решёнными.`}
          size="sm"
          closeLabel="Отмена"
          dismissible={!busy}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAskNote(false)} disabled={busy}>
                Отмена
              </Button>
              <Button variant="primary" onClick={closeGroup} loading={busy}>
                Закрыть группу
              </Button>
            </>
          }
        >
          <FieldRow
            label="Заметка для закрытия группы"
            hint="Останется в журнале по каждой жалобе группы."
            error={noteError ?? undefined}
            required
          >
            <Textarea
              value={note}
              maxLength={NOTE_MAX}
              invalid={Boolean(noteError)}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteError(null);
              }}
            />
          </FieldRow>
        </Modal>
      ) : null}
    </section>
  );
}
