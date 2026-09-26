// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageTemplate } from '@/lib/messageTemplates';
import { TemplatePicker } from './TemplatePicker';

const TEMPLATES: MessageTemplate[] = [
  {
    id: 't1',
    title: 'Тимчат-варн',
    body: '{player}, соблюдай тимчат!',
    category: 'warn',
    locale: 'ru',
    sort_order: 0,
    is_enabled: true,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 't2',
    title: 'Выключен',
    body: 'Этого не должно быть в списке',
    category: 'info',
    locale: 'ru',
    sort_order: 1,
    is_enabled: false,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

afterEach(cleanup);

describe('TemplatePicker', () => {
  it('offers only enabled templates and reports the substituted text on click', () => {
    const onSelect = vi.fn();
    render(
      <TemplatePicker templates={TEMPLATES} context={{ player: 'Alpha' }} onSelect={onSelect} />,
    );

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(screen.getByText('Alpha, соблюдай тимчат!')).toBeInTheDocument();
    expect(screen.getByText('Предупреждение')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Тимчат-варн'));
    expect(onSelect).toHaveBeenCalledWith('Alpha, соблюдай тимчат!');
  });

  // Нажатие подставляет текст молча, поэтому список обязан сказать об этом
  // заранее — иначе оператор не знает, отправит он сейчас сообщение или нет.
  it('describes what picking a template does', () => {
    render(<TemplatePicker templates={TEMPLATES} context={{}} onSelect={vi.fn()} />);
    const list = screen.getByRole('list', { name: 'Шаблоны сообщений' });
    const describedBy = list.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      /сразу подставится в поле сообщения/i,
    );
  });

  it('shows the caller-supplied empty label when nothing is pickable', () => {
    render(<TemplatePicker templates={[]} context={{}} onSelect={vi.fn()} emptyLabel="Пусто." />);
    expect(screen.getByText('Пусто.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
