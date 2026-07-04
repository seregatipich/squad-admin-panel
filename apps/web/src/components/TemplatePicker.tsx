'use client';
import { useMemo } from 'react';
import {
  CATEGORY_LABELS,
  type MessageTemplate,
  pickableTemplates,
  substituteTokens,
  type TokenContext,
} from '@/lib/messageTemplates';

export function TemplatePicker({
  templates,
  context,
  onSelect,
  emptyLabel = 'Нет доступных шаблонов.',
}: {
  templates: MessageTemplate[];
  context: TokenContext;
  onSelect: (text: string) => void;
  emptyLabel?: string;
}) {
  const pickable = useMemo(() => pickableTemplates(templates), [templates]);

  if (pickable.length === 0) {
    return <div className="text-xs text-neutral-500">{emptyLabel}</div>;
  }

  return (
    <ul className="space-y-1.5" aria-label="Шаблоны сообщений">
      {pickable.map((template) => {
        const preview = substituteTokens(template.body, context);
        return (
          <li key={template.id}>
            <button
              type="button"
              onClick={() => onSelect(preview)}
              className="block w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-left hover:border-neutral-600"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-neutral-200">{template.title}</span>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
                  {CATEGORY_LABELS[template.category]}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-neutral-400">{preview}</p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
