'use client';
import dynamic from 'next/dynamic';
import { memo } from 'react';
import { Button, Card, CardHeader, InlineBanner } from '@/components/ui';

const MonacoDiff = dynamic(
  () => import('@monaco-editor/react').then((m) => ({ default: m.DiffEditor })),
  { ssr: false },
);

/** Файл, содержимое которого на диске разошлось с последней версией панели. */
export interface DriftItem {
  name: string;
  state: 'in_sync' | 'drift' | 'missing' | 'unreachable' | 'unknown';
  disk_sha256: string | null;
  version_sha256: string | null;
  tip_version_id: string | null;
}

/** Открытое сравнение «версия панели → диск» для одного файла. */
export interface DriftDiff {
  name: string;
  tip: string;
  disk: string;
}

interface DriftPanelProps {
  items: DriftItem[];
  diff: DriftDiff | null;
  /** Идёт разрешение дрейфа: кнопки «Принять»/«Откатить» заблокированы. */
  busy: boolean;
  onOpenDiff: (item: DriftItem) => void;
  onCloseDiff: () => void;
  onResolve: (name: string, action: 'accept' | 'revert') => void;
}

/**
 * Баннер дрейфа конфигов с построчным разрешением и сравнением версий.
 *
 * Обёрнут в `memo`: страница перерисовывается на каждое нажатие клавиши в
 * редакторе, а пропсы панели при наборе текста не меняются (обработчики
 * страницы стабильны), так что панель при этом не пересчитывается.
 */
export const DriftPanel = memo(function DriftPanel({
  items,
  diff,
  busy,
  onOpenDiff,
  onCloseDiff,
  onResolve,
}: DriftPanelProps) {
  if (items.length === 0) return null;
  return (
    <div data-testid="config-drift-banner" className="space-y-3">
      <InlineBanner
        tone="warn"
        title={`Конфиги изменены на диске вне панели (${items.length})`}
        description={
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.name} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs text-ink-2">{item.name}</span>
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => onOpenDiff(item)}>
                    Diff
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => onResolve(item.name, 'accept')}
                  >
                    Принять
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => onResolve(item.name, 'revert')}>
                    Откатить
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        }
      />
      {diff ? (
        <div data-testid="config-drift-diff">
          <Card padding="none">
            <CardHeader
              title={`${diff.name}: версия панели → диск`}
              actions={
                <Button size="sm" variant="ghost" onClick={onCloseDiff}>
                  Закрыть сравнение
                </Button>
              }
            />
            <MonacoDiff
              height="45vh"
              language="ini"
              theme="vs-dark"
              original={diff.tip}
              modified={diff.disk}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 13,
                renderSideBySide: true,
                scrollBeyondLastLine: false,
              }}
            />
          </Card>
        </div>
      ) : null}
    </div>
  );
});
