'use client';
import { useId, useMemo } from 'react';
import { Badge } from '@/components/ui';
import {
  CATEGORY_LABELS,
  type MessageTemplate,
  pickableTemplates,
  substituteTokens,
  type TokenContext,
} from '@/lib/messageTemplates';

/**
 * Список готовых сообщений: заголовок шаблона, категория и предпросмотр с уже
 * подставленными подстановками.
 *
 * Нажатие на шаблон немедленно подставляет его текст в поле сообщения и
 * ничего не отправляет. Это сказано подписью над списком: без неё оператор не
 * знает, чем кончится нажатие, и в окне, где соседняя кнопка шлёт сообщение
 * на сервер, догадываться об этом он не должен.
 *
 * @param context Значения подстановок (`{player}` и прочие) для предпросмотра.
 * @param onSelect Получает текст шаблона с уже выполненными подстановками.
 * @param emptyLabel Что показать, когда включённых шаблонов нет.
 */
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
  const hintId = useId();

  if (pickable.length === 0) {
    return <p className="text-xs text-ink-3">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-2">
      <p id={hintId} className="text-xs text-ink-3">
        Нажмите шаблон — его текст сразу подставится в поле сообщения.
      </p>
      <ul className="space-y-1.5" aria-label="Шаблоны сообщений" aria-describedby={hintId}>
        {pickable.map((template) => {
          const preview = substituteTokens(template.body, context);
          return (
            <li key={template.id}>
              <button
                type="button"
                onClick={() => onSelect(preview)}
                className="block w-full rounded-ctl border border-line bg-raised px-3 py-2 text-left transition-colors duration-150 hover:bg-line-2"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-ink">{template.title}</span>
                  <Badge size="sm">{CATEGORY_LABELS[template.category]}</Badge>
                </span>
                <span className="mt-1 line-clamp-2 block text-xs text-ink-3">{preview}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
