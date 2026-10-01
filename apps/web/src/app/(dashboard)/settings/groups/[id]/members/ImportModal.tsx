'use client';

import { useState } from 'react';
import { Button, InlineBanner, Modal, Textarea } from '@/components/ui';
import { ApiError, apiSend } from '@/lib/api';
import { ACTION_ERROR_LABELS, NETWORK_ERROR_TEXT } from './members-shared';

interface ImportRowError {
  line: number;
  steam_id64: string;
  reason: string;
}

const IMPORT_REASON_LABELS: Record<string, string> = {
  invalid_steam_id64: 'некорректный SteamID64',
  duplicate_steam_id64: 'дубликат SteamID64 в файле',
  comment_too_long: 'комментарий слишком длинный',
  player_not_found: 'игрок не найден в базе',
  owner_reassignment_forbidden: 'нельзя переназначить владельца',
};

export function ImportModal({
  roleId,
  onClose,
  onImported,
}: {
  roleId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [csv, setCsv] = useState('');
  const [errors, setErrors] = useState<ImportRowError[]>([]);
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (csv.trim().length === 0) return;
    setBusy(true);
    setErrors([]);
    setTopError(null);
    try {
      await apiSend(`/api/v1/roles/${roleId}/members/import`, {
        method: 'POST',
        json: { csv },
      });
      onImported();
    } catch (e) {
      if (!(e instanceof ApiError)) {
        setTopError(NETWORK_ERROR_TEXT);
        return;
      }
      const body = e.jsonBody<{ error?: string; errors?: ImportRowError[] }>() ?? {};
      if (e.status === 422 && Array.isArray(body.errors)) {
        setErrors(body.errors);
        return;
      }
      setTopError(
        body.error ? (ACTION_ERROR_LABELS[body.error] ?? body.error) : `HTTP ${e.status}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Импорт из CSV"
      closeLabel="Закрыть"
      // Внутри окна лежит набранный файл: случайный Escape стёр бы его без
      // единого вопроса, поэтому мягкие жесты закрытия выключены.
      dismissible={false}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={csv.trim().length === 0}
          >
            Импортировать
          </Button>
        </>
      }
    >
      <div data-testid="import-modal" className="space-y-2">
        <p className="text-xs text-ink-3">
          Одна строка на игрока: <code>SteamID64</code>, необязательный комментарий после{' '}
          <code>;</code>. Если хотя бы одна строка некорректна, не импортируется ничего.
        </p>
        <Textarea
          data-testid="import-textarea"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={'76561198000000000;основной состав\n76561198000000001'}
          rows={8}
          aria-label="Строки CSV"
          className="font-mono"
        />
        {topError ? <InlineBanner tone="crit" title={`Ошибка: ${topError}`} /> : null}
        {errors.length > 0 ? (
          <div data-testid="import-errors">
            <InlineBanner
              tone="crit"
              title={`Файл отклонён — исправьте ${errors.length} строк(и) и повторите:`}
              description={
                <ul className="space-y-0.5">
                  {errors.map((e) => (
                    <li key={`${e.line}-${e.steam_id64}`}>
                      Строка {e.line} («{e.steam_id64}»):{' '}
                      {IMPORT_REASON_LABELS[e.reason] ?? e.reason}
                    </li>
                  ))}
                </ul>
              }
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
