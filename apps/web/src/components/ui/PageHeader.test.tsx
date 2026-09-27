// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader } from './PageHeader';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders the title as the single level-one heading', () => {
    render(<PageHeader title="Игроки" />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Игроки' })).toBeInTheDocument();
  });

  it('renders the subtitle and the meta line', () => {
    render(<PageHeader title="Сервер" subtitle="Основной состав" meta={<span>uptime 4ч</span>} />);
    expect(screen.getByText('Основной состав')).toBeInTheDocument();
    expect(screen.getByText('uptime 4ч')).toBeInTheDocument();
  });

  it('omits the subtitle, meta, status and actions slots when they are not given', () => {
    const { container } = render(<PageHeader title="Пусто" />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders breadcrumbs as a navigation landmark with the last crumb as the current page', () => {
    render(
      <PageHeader
        title="Discord"
        breadcrumbsLabel="Хлебные крошки"
        breadcrumbs={[
          { label: 'Настройки', href: '/settings' },
          { label: 'Интеграции', href: '/settings/integrations' },
          { label: 'Discord' },
        ]}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Хлебные крошки' });
    expect(within(nav).getByRole('link', { name: 'Настройки' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(within(nav).getByRole('link', { name: 'Интеграции' })).not.toHaveAttribute(
      'aria-current',
    );

    const crumbs = within(nav).getAllByRole('listitem');
    expect(crumbs).toHaveLength(3);
    expect(within(crumbs[crumbs.length - 1]).getByText('Discord')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the last crumb as the current page even when it is a link', () => {
    render(
      <PageHeader
        title="Игрок"
        breadcrumbs={[
          { label: 'Игроки', href: '/all-players' },
          { label: 'Игрок', href: '/all-players/1' },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Игрок' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Игроки' })).not.toHaveAttribute('aria-current');
  });

  it('renders the back arrow as a link named by backLabel', () => {
    render(<PageHeader title="Сессия" backHref="/servers/7" backLabel="Назад к серверу" />);
    expect(screen.getByRole('link', { name: 'Назад к серверу' })).toHaveAttribute(
      'href',
      '/servers/7',
    );
  });

  it('renders the status slot next to the title and the actions on the right', () => {
    render(
      <PageHeader
        title="Дашборд"
        status={<span>в эфире</span>}
        actions={
          <button type="button" onClick={() => {}}>
            Обновить
          </button>
        }
      />,
    );
    expect(screen.getByText('в эфире')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Обновить' })).toBeInTheDocument();
  });
});
