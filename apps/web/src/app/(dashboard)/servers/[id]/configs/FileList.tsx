'use client';
import { memo } from 'react';
import { Badge, type BadgeTone, Card, CardHeader } from '@/components/ui';
import type { DriftItem } from './DriftPanel';

/** Файл конфигурации сервера из списка `/configs`. */
export interface FileItem {
  name: string;
  size: number;
  sha256: string | null;
  behavior: 'hot_reload' | 'requires_restart' | 'rotation';
  exists: boolean;
}

/**
 * Когда правка доедет до игры. Метка русская и короткая, а полное объяснение
 * живёт в `title`: в списке из двадцати файлов на подпись есть одна строка.
 */
export const BEHAVIOR_BADGE: Record<
  FileItem['behavior'],
  { label: string; hint: string; tone: BadgeTone }
> = {
  hot_reload: {
    label: 'на лету',
    hint: 'Squad перечитает файл сам, в течение примерно 60 секунд',
    tone: 'good',
  },
  rotation: {
    label: 'со следующим матчем',
    hint: 'Правка применится, когда начнётся следующий матч',
    tone: 'accent',
  },
  requires_restart: {
    label: 'рестарт',
    hint: 'Правка применится только после перезапуска сервера',
    tone: 'warn',
  },
};

interface FileListProps {
  files: FileItem[];
  selected: string | null;
  driftItems: DriftItem[];
  onSelect: (name: string) => void;
}

/**
 * Список файлов конфигурации с пометками «на лету»/«рестарт» и дрейфа.
 *
 * Обёрнут в `memo`: при наборе текста в редакторе страница перерисовывается на
 * каждое нажатие, а пропсы списка не меняются, поэтому список (и поиск дрейфа
 * по каждому файлу) пропускается.
 */
export const FileList = memo(function FileList({
  files,
  selected,
  driftItems,
  onSelect,
}: FileListProps) {
  return (
    <Card padding="none">
      <CardHeader title="Файлы" count={files.length} />
      <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
        {files.map((f) => {
          const badge = BEHAVIOR_BADGE[f.behavior];
          return (
            <li key={f.name}>
              <button
                type="button"
                aria-current={selected === f.name || undefined}
                onClick={() => onSelect(f.name)}
                className={`flex h-9 w-full items-center justify-between gap-2 px-3 text-left text-xs transition-colors duration-150 hover:bg-raised/40 ${
                  selected === f.name ? 'bg-raised' : ''
                } ${f.exists ? '' : 'text-ink-3'}`}
              >
                <span className="truncate font-mono">{f.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {driftItems.some((d) => d.name === f.name) ? (
                    <span data-testid="file-drift-marker">
                      <Badge tone="crit" size="sm" title="Изменён на диске вне панели">
                        изменён
                      </Badge>
                    </span>
                  ) : null}
                  <Badge tone={badge.tone} size="sm" title={badge.hint}>
                    {badge.label}
                  </Badge>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
});
