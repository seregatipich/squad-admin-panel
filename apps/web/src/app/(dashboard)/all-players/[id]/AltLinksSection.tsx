'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldRow,
  InlineBanner,
  Modal,
  Select,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Textarea,
  Th,
} from '@/components/ui';
import {
  type AltCandidate,
  buildLinkPayload,
  formatRejectedMark,
  LINK_TYPE_LABELS_RU,
  PLAYER_LINK_TYPES,
  type PlayerLink,
  type PlayerLinkStatus,
  type PlayerLinkType,
  splitCandidates,
} from './alt-links';

/** Уверенность — состояние оценки; слово рядом с числом несёт тот же смысл, что и цвет (§5). */
const CONFIDENCE_TONE: Record<AltCandidate['confidence'], BadgeTone> = {
  high: 'crit',
  medium: 'warn',
  low: 'neutral',
};

const CONFIDENCE_LABELS_RU: Record<AltCandidate['confidence'], string> = {
  high: 'высокая',
  medium: 'средняя',
  low: 'низкая',
};

interface DecisionModalState {
  candidate: AltCandidate;
  status: PlayerLinkStatus;
}

/**
 * "Возможные альты и связи" player-card section (ALT-2, issue #120): shows
 * durable admin verdicts on top (`player_links`, via GET .../links) and the
 * ALT-1 candidate engine below it, with «Подтвердить связь»/«Отклонить»
 * actions that write those verdicts. Rejected candidates are collapsed and
 * marked rather than hidden (AC: still visible in the full ALT-1 output).
 * Hidden entirely without `player:view_ips` (401/403), matching the other
 * IP-gated player-card sections.
 */
export function AltLinksSection({ playerId }: { playerId: string }) {
  const [links, setLinks] = useState<PlayerLink[] | null>(null);
  const [candidates, setCandidates] = useState<AltCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<DecisionModalState | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setHidden(false);
    setError(null);
    try {
      const [linksRes, candidatesRes] = await Promise.all([
        fetch(`/api/v1/players/${playerId}/links`, { credentials: 'include', cache: 'no-store' }),
        fetch(`/api/v1/players/${playerId}/alt-candidates`, {
          credentials: 'include',
          cache: 'no-store',
        }),
      ]);
      if (
        linksRes.status === 401 ||
        linksRes.status === 403 ||
        candidatesRes.status === 401 ||
        candidatesRes.status === 403
      ) {
        setHidden(true);
        return;
      }
      if (!linksRes.ok) throw new Error(`HTTP ${linksRes.status}`);
      if (!candidatesRes.ok) throw new Error(`HTTP ${candidatesRes.status}`);
      const linksBody = (await linksRes.json()) as { links: PlayerLink[] };
      const candidatesBody = (await candidatesRes.json()) as { candidates: AltCandidate[] };
      setLinks(linksBody.links);
      setCandidates(candidatesBody.candidates);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [playerId]);

  useEffect(() => {
    load();
  }, [load]);

  if (hidden) return null;

  const confirmedLinks = (links ?? []).filter((link) => link.status === 'confirmed');
  const { unresolved, rejected } = splitCandidates(candidates ?? []);
  const undecided = unresolved.filter((candidate) => candidate.link === null);

  return (
    <Card as="section" padding="none">
      <CardHeader title="Возможные альты и связи" />

      <CardBody className="space-y-6">
        {error ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить связи игрока"
            description={error}
            action={
              <Button size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            }
          />
        ) : loading ? (
          <SkeletonTable rows={4} cols={4} label="Загрузка связей" />
        ) : (
          <>
            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold text-ink">
                Подтверждённые связи{confirmedLinks.length > 0 ? ` (${confirmedLinks.length})` : ''}
              </h3>
              {confirmedLinks.length === 0 ? (
                <EmptyState
                  title="Подтверждённых связей нет"
                  description="Ни одна связь с другим аккаунтом ещё не подтверждена администратором."
                />
              ) : (
                <ul className="divide-y divide-line rounded-ctl border border-line">
                  {confirmedLinks.map((link) => (
                    <li key={link.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <Badge tone="good" size="sm">
                        {LINK_TYPE_LABELS_RU[link.link_type]}
                      </Badge>
                      <span className="font-medium">{link.other_player?.current_name ?? '—'}</span>
                      {link.note ? <span className="text-ink-3">— {link.note}</span> : null}
                      <span className="ml-auto text-xs text-ink-3">
                        {link.created_by ? `подтвердил ${link.created_by.name}, ` : ''}
                        {new Date(link.updated_at).toLocaleDateString('ru-RU')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold text-ink">
                Возможные альты{undecided.length > 0 ? ` (${undecided.length})` : ''}
              </h3>
              {undecided.length === 0 ? (
                <EmptyState
                  title="Кандидатов не найдено"
                  description="Ни один другой аккаунт не пересекается с этим по IP и времени входа."
                />
              ) : (
                <Table ariaLabel="Кандидаты в альты">
                  <TableHead sticky={false}>
                    <tr>
                      <Th>Кандидат</Th>
                      <Th>Уверенность</Th>
                      <Th align="right">Общих IP</Th>
                      <Th>Решение</Th>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {undecided.map((candidate) => (
                      <TableRow key={candidate.player_id}>
                        <Td className="font-medium">{candidate.current_name ?? '—'}</Td>
                        <Td>
                          <Badge tone={CONFIDENCE_TONE[candidate.confidence]} size="sm">
                            {CONFIDENCE_LABELS_RU[candidate.confidence]} ({candidate.score})
                          </Badge>
                        </Td>
                        <Td numeric>{candidate.shared_ip_count}</Td>
                        <Td>
                          <span className="flex gap-1.5">
                            <Button
                              size="sm"
                              onClick={() => setModal({ candidate, status: 'confirmed' })}
                            >
                              Подтвердить связь
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => setModal({ candidate, status: 'rejected' })}
                            >
                              Отклонить
                            </Button>
                          </span>
                        </Td>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {rejected.length > 0 ? (
                <div className="space-y-2">
                  <Button
                    variant="plain"
                    size="sm"
                    aria-expanded={showRejected}
                    onClick={() => setShowRejected((v) => !v)}
                  >
                    {showRejected ? 'Скрыть' : 'Показать'} отклонённые ({rejected.length})
                  </Button>
                  {showRejected ? (
                    <ul className="divide-y divide-line rounded-ctl border border-line">
                      {rejected.map((candidate) => (
                        <li
                          key={candidate.player_id}
                          className="flex flex-wrap items-center gap-2 px-3 py-2 text-ink-3"
                        >
                          <span className="font-medium text-ink-2">
                            {candidate.current_name ?? '—'}
                          </span>
                          {candidate.link ? (
                            <span className="text-xs">{formatRejectedMark(candidate.link)}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </section>
          </>
        )}
      </CardBody>

      <DecisionModal
        playerId={playerId}
        state={modal}
        onClose={() => setModal(null)}
        onDone={() => {
          setModal(null);
          load();
        }}
      />
    </Card>
  );
}

function DecisionModal({
  playerId,
  state,
  onClose,
  onDone,
}: {
  playerId: string;
  state: DecisionModalState | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [linkType, setLinkType] = useState<PlayerLinkType>('alt');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const linkTypeId = useId();
  const noteId = useId();

  const status = state?.status ?? 'confirmed';

  // Каждое открытие начинается со значений, соответствующих решению: отказ —
  // это связь «не связаны», подтверждение — «альт».
  useEffect(() => {
    if (!state) return;
    setLinkType(state.status === 'rejected' ? 'unrelated' : 'alt');
    setNote('');
    setModalError(null);
  }, [state]);

  const submit = useCallback(async () => {
    if (!state) return;
    setSubmitting(true);
    setModalError(null);
    try {
      const payload = buildLinkPayload(
        state.candidate.player_id,
        linkType,
        state.status,
        note,
        state.candidate,
      );
      const res = await fetch(`/api/v1/players/${playerId}/links`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 409) {
        setModalError('Связь уже существует.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDone();
    } catch (err) {
      setModalError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [playerId, linkType, note, state, onDone]);

  return (
    <Modal
      open={state !== null}
      onClose={onClose}
      title={status === 'confirmed' ? 'Подтвердить связь' : 'Отклонить кандидата'}
      description={state ? (state.candidate.current_name ?? state.candidate.player_id) : undefined}
      size="sm"
      closeLabel="Закрыть"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Отмена
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={submitting}>
            {status === 'confirmed' ? 'Подтвердить' : 'Отклонить'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FieldRow label="Тип связи" htmlFor={linkTypeId}>
          <Select
            id={linkTypeId}
            value={linkType}
            onChange={(e) => setLinkType(e.target.value as PlayerLinkType)}
          >
            {PLAYER_LINK_TYPES.map((type) => (
              <option key={type} value={type}>
                {LINK_TYPE_LABELS_RU[type]}
              </option>
            ))}
          </Select>
        </FieldRow>

        <FieldRow label="Заметка (необязательно)" htmlFor={noteId}>
          <Textarea
            id={noteId}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
          />
        </FieldRow>

        {modalError ? <InlineBanner tone="crit" title={modalError} /> : null}
      </div>
    </Modal>
  );
}
