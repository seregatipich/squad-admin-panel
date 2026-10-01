'use client';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import type { PickRow, PreviewResponse, VersionRow } from './helpers';

const EXCLUSION_LABELS: Record<string, string> = {
  disabled: 'выключен',
  deprecated: 'устаревший слой',
  layer_cooldown: 'кулдаун слоя',
  map_cooldown: 'кулдаун карты',
};

/** Which layers the next auto-pick would draw from, which were excluded and why. */
export function PreviewCard({ preview }: { preview: PreviewResponse | null }) {
  return (
    <Card padding="none">
      <CardHeader
        title="Предпросмотр выбора"
        description={
          preview?.would_pick
            ? `Сейчас был бы выбран слой ${preview.would_pick}`
            : 'Подходящих кандидатов нет'
        }
      />
      <CardBody className="space-y-4">
        {preview && preview.eligible.length > 0 ? (
          <div data-testid="preview-eligible">
            <Table ariaLabel="Кандидаты, участвующие в выборе">
              <TableHead sticky={false}>
                <TableRow>
                  <Th>Слой</Th>
                  <Th align="right">Вес</Th>
                  <Th align="right">Вероятность</Th>
                </TableRow>
              </TableHead>
              <TableBody>
                {preview.eligible.map((row) => (
                  <TableRow key={row.layer}>
                    <Td>
                      <span className="font-mono">{row.layer}</span>
                    </Td>
                    <Td numeric>{row.weight}</Td>
                    <Td numeric>{Math.round(row.probability * 100)}%</Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {preview && preview.excluded.length > 0 ? (
          <div data-testid="preview-excluded">
            <Table ariaLabel="Кандидаты, исключённые из выбора">
              <TableHead sticky={false}>
                <TableRow>
                  <Th>Слой</Th>
                  <Th>Почему исключён</Th>
                </TableRow>
              </TableHead>
              <TableBody>
                {preview.excluded.map((row) => (
                  <TableRow key={row.layer}>
                    <Td>
                      <span className="font-mono">{row.layer}</span>
                    </Td>
                    <Td>{EXCLUSION_LABELS[row.reason] ?? row.reason}</Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {!preview ? (
          <EmptyState
            title="Предпросмотр недоступен"
            description="Панель ещё не рассчитала, какой слой был бы выбран следующим."
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

/** Log of the layers the panel picked on its own and whether each one was applied. */
export function PicksCard({ picks }: { picks: PickRow[] }) {
  return (
    <Card padding="none">
      <CardHeader title="История выборов" count={picks.length} />
      {picks.length === 0 ? (
        <EmptyState
          title="Выборов ещё не было"
          description="Как только панель выберет слой, запись появится здесь."
        />
      ) : (
        <div data-testid="picks-list">
          <Table ariaLabel="История автоматических выборов слоя">
            <TableHead sticky={false}>
              <TableRow>
                <Th>Слой</Th>
                <Th>Когда</Th>
                <Th>Результат</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {picks.map((pick) => (
                <TableRow key={pick.id}>
                  <Td>
                    <span className="font-mono">{pick.layer}</span>
                  </Td>
                  <Td>{new Date(pick.created_at).toLocaleString('ru-RU')}</Td>
                  <Td>
                    {pick.applied ? (
                      <Badge tone="good">Применён</Badge>
                    ) : (
                      <Badge tone="warn">{pick.failure_reason ?? 'не применён'}</Badge>
                    )}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

/**
 * Saved versions of the rules and the pool, with the rollback actions.
 *
 * @param canRestore The viewer may roll back; adds the actions column.
 * @param saving A request is in flight; the actions are disabled.
 * @param pendingRestore Version whose rollback was refused for layers missing from the catalog;
 *   it also offers «Откатить без них».
 * @param onRestore Rolls back to a version, optionally dropping the layers the catalog lost.
 */
export function VersionsCard({
  versions,
  canRestore,
  saving,
  pendingRestore,
  onRestore,
}: {
  versions: VersionRow[];
  canRestore: boolean;
  saving: boolean;
  pendingRestore: string | null;
  onRestore: (versionId: string, dropUnknown?: boolean) => void;
}) {
  return (
    <Card padding="none">
      <CardHeader
        title="История изменений"
        count={versions.length}
        description="Каждое сохранение на этой странице попадает в ту же историю версий, что и правки конфигов: автор, время, отпечаток и откат."
      />
      {versions.length === 0 ? (
        <EmptyState
          title="Изменений ещё не было"
          description="Первая запись появится после сохранения правил или пула слоёв."
        />
      ) : (
        <div data-testid="versions-list">
          <Table ariaLabel="История изменений автовыбора карты">
            <TableHead sticky={false}>
              <TableRow>
                <Th>Когда</Th>
                <Th>Кто</Th>
                <Th>Что изменилось</Th>
                <Th>Отпечаток</Th>
                {canRestore ? <Th align="right">Действия</Th> : null}
              </TableRow>
            </TableHead>
            <TableBody>
              {versions.map((version) => (
                <TableRow key={version.id}>
                  <Td>{new Date(version.created_at).toLocaleString('ru-RU')}</Td>
                  <Td>{version.author ?? '—'}</Td>
                  <Td>{version.message ?? '—'}</Td>
                  <Td>
                    <span className="font-mono text-ink-3" title={version.sha256}>
                      {version.sha256.slice(0, 8)}
                    </span>
                  </Td>
                  {canRestore ? (
                    <Td align="right">
                      <div className="flex items-center justify-end gap-2">
                        <Button size="sm" disabled={saving} onClick={() => onRestore(version.id)}>
                          Откатить
                        </Button>
                        {pendingRestore === version.id ? (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={saving}
                            onClick={() => onRestore(version.id, true)}
                          >
                            Откатить без них
                          </Button>
                        ) : null}
                      </div>
                    </Td>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}
