import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  FieldRow,
  InlineBanner,
  Select,
  Skeleton,
  StatusBadge,
  type StatusState,
  Textarea,
} from '@/components/ui';
import { apiSend } from '@/lib/api';
import type { ReportListItem, ReportStatus } from '@/lib/live-bus';
import {
  ACTION_LABELS,
  actionTypeBadge,
  evidenceBadgeLabel,
  formatDateTime,
  isRecidivist,
  NOTE_MAX,
  NOTIFY_TEMPLATE_LABELS,
  playerLabel,
  REPORTER_SPAM_LABEL,
  REPORTER_TRUSTED_LABEL,
  type ReportActionType,
  type ReporterNotifyTemplate,
  recidivistBadgeLabel,
  STATUS_LABELS,
} from './helpers';
import { PlayerRef } from './PlayerRef';
import { ReportActionModal } from './ReportActionModal';
import { ReportEvidenceBlock } from './ReportEvidenceBlock';
import { useLinkedActions, useReportActionModal, useReporterNotify } from './report-card-hooks';
import { describeReportError } from './report-errors';

/**
 * Состояние жалобы в терминах индикаторов дизайн-системы.
 *
 * `in_review` и `rejected` делят тон `idle`: ни одна из этих жалоб не ждёт
 * действия оператора прямо сейчас, а различает их подпись бейджа — состояние
 * никогда не кодируется одним цветом (§5).
 */
const STATUS_STATE: Record<ReportStatus, StatusState> = {
  pending: 'warn',
  in_review: 'idle',
  resolved: 'good',
  rejected: 'idle',
};

export function ReportCard({
  report,
  canHandle,
  onSaved,
}: {
  report: ReportListItem;
  canHandle: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<ReportStatus>(report.status);
  const [note, setNote] = useState(report.resolution_note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linked = useLinkedActions(report.id);
  const actionModal = useReportActionModal(report, () => {
    if (linked.open) void linked.load();
  });
  const notify = useReporterNotify(report.id);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (status !== report.status) body.status = status;
      const trimmedNote = note.trim();
      if (trimmedNote !== (report.resolution_note ?? ''))
        body.resolution_note = trimmedNote || null;
      if (Object.keys(body).length === 0) {
        setEditing(false);
        return;
      }
      await apiSend(`/api/v1/reports/${report.id}`, { method: 'PATCH', json: body });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(describeReportError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card as="article" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-ink-3">
          <Badge>{report.server_slug ?? report.server_name ?? report.server_id.slice(0, 8)}</Badge>
          <span>{formatDateTime(report.created_at)}</span>
        </div>
        <div className="flex items-center gap-2">
          {report.evidence.length > 0 ? (
            <Badge title="Есть вложения">{evidenceBadgeLabel(report.evidence)}</Badge>
          ) : null}
          <StatusBadge
            state={STATUS_STATE[report.status]}
            label={STATUS_LABELS[report.status]}
            size="sm"
          />
        </div>
      </div>

      {/* Пара «кто на кого» — это и есть заголовок карточки: он даёт блоку имя
          в дереве заголовков и подчиняет себе «Доказательства» уровнем ниже. */}
      <h2 className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
        <PlayerRef id={report.reporter_player_id} name={report.reporter_name} />
        {report.reporter_trusted ? <Badge tone="good">{REPORTER_TRUSTED_LABEL}</Badge> : null}
        {report.reporter_spam_flagged ? <Badge tone="crit">{REPORTER_SPAM_LABEL}</Badge> : null}
        <span aria-hidden="true" className="mx-1 font-normal text-ink-3">
          →
        </span>
        <span className="sr-only">жалуется на</span>
        <PlayerRef
          id={report.target_player_id}
          name={report.target_name}
          fallbackRaw={report.target_raw}
        />
        {isRecidivist(report.target_report_count_90d ?? 0) ? (
          <Badge tone="warn">{recidivistBadgeLabel(report.target_report_count_90d ?? 0)}</Badge>
        ) : null}
      </h2>

      <p className="whitespace-pre-wrap text-[13px] text-ink-2">{report.body}</p>

      {report.evidence.length > 0 ? <ReportEvidenceBlock evidence={report.evidence} /> : null}

      {report.handler_name || report.handler_player_id ? (
        <p className="text-xs text-ink-3">
          Обработчик: {playerLabel(report.handler_player_id, report.handler_name)}
        </p>
      ) : null}

      {canHandle ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {report.target_player_id
            ? (Object.keys(ACTION_LABELS) as ReportActionType[]).map((type) => (
                <Button key={type} size="sm" onClick={() => actionModal.open(type)}>
                  {ACTION_LABELS[type]}
                </Button>
              ))
            : null}
          {report.reporter_player_id ? (
            <>
              <Select
                size="sm"
                aria-label="Шаблон уведомления"
                value={notify.template}
                onChange={(e) => notify.setTemplate(e.target.value as ReporterNotifyTemplate)}
              >
                {(Object.keys(NOTIFY_TEMPLATE_LABELS) as ReporterNotifyTemplate[]).map((tpl) => (
                  <option key={tpl} value={tpl}>
                    {NOTIFY_TEMPLATE_LABELS[tpl]}
                  </option>
                ))}
              </Select>
              <Button size="sm" onClick={notify.submit} loading={notify.busy}>
                Уведомить репортёра
              </Button>
            </>
          ) : null}
          <Button size="sm" onClick={linked.toggle} aria-expanded={linked.open}>
            Связанные действия
          </Button>
          <Button size="sm" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            Обработать
          </Button>
        </div>
      ) : null}

      {notify.message ? (
        <InlineBanner
          tone={notify.message.kind === 'ok' ? 'good' : 'crit'}
          title={notify.message.text}
          onDismiss={notify.dismissMessage}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}

      {linked.open ? (
        <div className="border-t border-line pt-3">
          {linked.loading ? (
            <Skeleton variant="text" count={2} label="Загрузка связанных действий" />
          ) : !linked.actions || linked.actions.length === 0 ? (
            <p className="text-xs text-ink-3">Связанных действий пока нет.</p>
          ) : (
            <ul className="space-y-1">
              {linked.actions.map((action) => (
                <li
                  key={action.id}
                  className="flex flex-wrap items-center gap-2 text-xs text-ink-3"
                >
                  <Badge size="sm">{actionTypeBadge(action.action_type)}</Badge>
                  <span>{formatDateTime(action.created_at)}</span>
                  <span>
                    {action.author.kind === 'player' ? action.author.name : action.author.label}
                  </span>
                  {action.reason ? <span className="text-ink-2">{action.reason}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {editing ? (
        <div className="space-y-3 border-t border-line pt-3">
          <FieldRow label="Статус жалобы">
            <Select value={status} onChange={(e) => setStatus(e.target.value as ReportStatus)}>
              {(Object.keys(STATUS_LABELS) as ReportStatus[]).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </FieldRow>
          <FieldRow label="Заметка обработчика">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={NOTE_MAX}
              placeholder="Заметка обработчика"
            />
          </FieldRow>
          {error ? <InlineBanner tone="crit" title="Не сохранено" description={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEditing(false)}>
              Отмена
            </Button>
            <Button variant="primary" size="sm" onClick={save} loading={saving}>
              Сохранить
            </Button>
          </div>
        </div>
      ) : null}

      <ReportActionModal reportId={report.id} modal={actionModal} />
    </Card>
  );
}
