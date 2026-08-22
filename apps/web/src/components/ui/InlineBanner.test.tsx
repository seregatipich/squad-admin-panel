// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineBanner, type InlineBannerTone } from './InlineBanner';

afterEach(cleanup);

describe('InlineBanner', () => {
  it.each<[InlineBannerTone, string]>([
    ['info', 'status'],
    ['good', 'status'],
    ['warn', 'alert'],
    ['crit', 'alert'],
  ])('exposes tone %s as role="%s"', (tone, role) => {
    render(<InlineBanner tone={tone} title="Сервер недоступен" />);
    expect(screen.getByRole(role)).toHaveTextContent('Сервер недоступен');
  });

  it('renders the description and the action', () => {
    const onRetry = vi.fn();
    render(
      <InlineBanner
        tone="crit"
        title="Запрос не выполнен"
        description="Сервер ответил 500."
        action={
          <button type="button" onClick={onRetry}>
            Повторить
          </button>
        }
      />,
    );

    expect(screen.getByText('Сервер ответил 500.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss from a close button that has an accessible name', () => {
    const onDismiss = vi.fn();
    render(
      <InlineBanner
        tone="info"
        title="Обновление доступно"
        onDismiss={onDismiss}
        dismissLabel="Закрыть сообщение"
      />,
    );

    const close = screen.getByRole('button', { name: 'Закрыть сообщение' });
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has no close button when the banner is not dismissible', () => {
    render(<InlineBanner tone="good" title="Настройки сохранены" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
