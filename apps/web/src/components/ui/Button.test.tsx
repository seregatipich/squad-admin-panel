// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, ButtonLink, type ButtonSize, type ButtonVariant, IconButton } from './Button';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'destructive', 'plain'];
const SIZES: ButtonSize[] = ['sm', 'md'];

afterEach(cleanup);

describe('Button', () => {
  it('рендерит каждый вариант как нажимаемую кнопку с подписью', async () => {
    for (const variant of VARIANTS) {
      const onClick = vi.fn();
      const { unmount } = render(
        <Button variant={variant} onClick={onClick}>
          Применить
        </Button>,
      );

      const button = screen.getByRole('button', { name: 'Применить' });
      expect(button).toBeEnabled();
      await userEvent.click(button);
      expect(onClick).toHaveBeenCalledTimes(1);

      unmount();
    }
  });

  it('рендерит каждый размер', () => {
    for (const size of SIZES) {
      const { unmount } = render(<Button size={size}>Сохранить</Button>);
      expect(screen.getByRole('button', { name: 'Сохранить' })).toBeInTheDocument();
      unmount();
    }
  });

  it('по умолчанию не отправляет форму', () => {
    render(<Button>Действие</Button>);
    expect(screen.getByRole('button', { name: 'Действие' })).toHaveAttribute('type', 'button');
  });

  it('передаёт нативные пропсы кнопки', () => {
    render(
      <Button type="submit" name="action" value="ban" form="mod-form">
        Забанить
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Забанить' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveAttribute('name', 'action');
    expect(button).toHaveAttribute('value', 'ban');
    expect(button).toHaveAttribute('form', 'mod-form');
  });

  it('в состоянии disabled не вызывает onClick', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Удалить
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Удалить' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('в состоянии loading выставляет aria-busy, блокирует кнопку и сохраняет подпись', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Перезапустить
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Перезапустить' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('не выставляет aria-busy, пока действие не идёт', () => {
    render(<Button>Перезапустить</Button>);
    expect(screen.getByRole('button', { name: 'Перезапустить' })).not.toHaveAttribute('aria-busy');
  });

  it('доступна с клавиатуры и срабатывает по Enter и пробелу', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Отправить</Button>);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Отправить' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('заблокированная кнопка не получает фокус по Tab', async () => {
    render(
      <>
        <Button disabled>Заблокирована</Button>
        <Button>Следующая</Button>
      </>,
    );

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Следующая' })).toHaveFocus();
  });
});

describe('ButtonLink', () => {
  it('рендерит ссылку с href, а не кнопку', () => {
    render(<ButtonLink href="/all-players">Все игроки</ButtonLink>);

    expect(screen.getByRole('link', { name: 'Все игроки' })).toHaveAttribute(
      'href',
      '/all-players',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('передаёт нативные пропсы ссылки', () => {
    render(
      <ButtonLink href="https://example.test" variant="primary" target="_blank" rel="noreferrer">
        Документация
      </ButtonLink>,
    );

    const link = screen.getByRole('link', { name: 'Документация' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });
});

describe('IconButton', () => {
  it('берёт доступное имя из label и дублирует его в title', () => {
    render(<IconButton icon={<svg aria-hidden="true" />} label="Скопировать SteamID" />);

    const button = screen.getByRole('button', { name: 'Скопировать SteamID' });
    expect(button).toHaveAttribute('title', 'Скопировать SteamID');
  });

  it('вызывает onClick и уважает disabled', async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <IconButton icon={<svg aria-hidden="true" />} label="Обновить" onClick={onClick} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <IconButton icon={<svg aria-hidden="true" />} label="Обновить" onClick={onClick} disabled />,
    );
    const button = screen.getByRole('button', { name: 'Обновить' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('рендерит оба размера и оба тона', () => {
    for (const size of SIZES) {
      for (const tone of ['default', 'destructive'] as const) {
        const { unmount } = render(
          <IconButton
            icon={<svg aria-hidden="true" />}
            label={`${size}-${tone}`}
            size={size}
            tone={tone}
          />,
        );
        expect(screen.getByRole('button', { name: `${size}-${tone}` })).toBeInTheDocument();
        unmount();
      }
    }
  });

  it('не компилируется без label — доступное имя обязательно', () => {
    // @ts-expect-error label обязателен по типу: кнопка-значок без имени невидима для скринридера.
    const withoutLabel = <IconButton icon={<svg aria-hidden="true" />} />;
    expect(withoutLabel).toBeTruthy();
  });
});
