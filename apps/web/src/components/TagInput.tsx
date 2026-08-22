'use client';

import { useId, useState } from 'react';
import { CloseIcon, IconButton } from '@/components/ui';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  maxTags?: number;
  /**
   * Доступное имя поля ввода. Видимой подписи у него нет — её даёт заголовок
   * группы настроек, — поэтому имя живёт в скрытом `<label>`.
   */
  label?: string;
}

/**
 * Поле ввода списка тегов: набранные теги показаны «пилюлями» слева, свободное
 * место справа занимает само поле.
 *
 * Раньше контейнер был `<fieldset>` без `<legend>`, который перехватывал клик и
 * нажатие клавиши, чтобы вручную перевести фокус на поле. И то и другое — обход
 * платформы: у набора полей без легенды нет доступного имени, а поле внутри
 * него оставалось безымянным для скринридера. Теперь имя даёт настоящий
 * `<label>`, а фокус ловится сам: поле растянуто на всю свободную ширину
 * строки, поэтому щелчок по пустому месту попадает именно в него.
 *
 * @param label Доступное имя поля; по умолчанию «Теги».
 */
export function TagInput({ tags, onChange, maxTags = 20, label = 'Теги' }: Props) {
  const [input, setInput] = useState('');
  const inputId = useId();

  function addTag(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || tags.includes(trimmed) || tags.length >= maxTags) return;
    onChange([...tags, trimmed]);
    setInput('');
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-ctl border border-line bg-raised px-2 py-1 focus-within:border-accent">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 rounded-full bg-line-2 py-0.5 pl-2.5 pr-0.5 text-2xs text-ink"
        >
          {tag}
          <IconButton
            icon={<CloseIcon className="size-3" />}
            label={`Удалить тег ${tag}`}
            tone="destructive"
            onClick={() => removeTag(tag)}
            className="rounded-full"
          />
        </span>
      ))}
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <input
        id={inputId}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addTag(input);
          }
          if (e.key === 'Backspace' && input === '' && tags.length > 0) {
            const lastTag = tags[tags.length - 1];
            if (lastTag) removeTag(lastTag);
          }
        }}
        placeholder={tags.length === 0 ? 'Введите тег и нажмите Enter' : ''}
        className="h-7 min-w-[80px] flex-1 border-none bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
      />
    </div>
  );
}
