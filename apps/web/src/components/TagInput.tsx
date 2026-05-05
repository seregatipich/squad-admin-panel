'use client';

import { useRef, useState } from 'react';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  maxTags?: number;
}

export function TagInput({ tags, onChange, maxTags = 20 }: Props) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

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
    <fieldset
      className="flex flex-wrap items-center gap-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5"
      onClick={() => inputRef.current?.focus()}
      onKeyDown={() => inputRef.current?.focus()}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="text-neutral-500 hover:text-red-400"
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
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
        className="min-w-[80px] flex-1 border-none bg-transparent text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
      />
    </fieldset>
  );
}
