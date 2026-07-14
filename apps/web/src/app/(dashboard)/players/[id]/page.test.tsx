// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/players/b1e2c3d4-0000-0000-0000-000000000001'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/RoleColorDot', () => ({ RoleColorDot: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import PlayerDetailPage, { ClanWidget } from './page';

afterEach(() => {
  cleanup();
});

describe('PlayerDetailPage', () => {
  it('is a valid React component', () => {
    expect(PlayerDetailPage).toBeDefined();
    expect(typeof PlayerDetailPage).toBe('function');
  });
});

describe('ClanWidget', () => {
  it('links to the clan and shows the member role label', () => {
    render(
      <ClanWidget clan={{ id: 'clan-1', name: 'Альфа', tags: ['ALF'], member_role: 'deputy' }} />,
    );
    const link = screen.getByRole('link', { name: /Альфа/ });
    expect(link).toHaveAttribute('href', '/clans/clan-1');
    expect(link).toHaveTextContent('Зам');
  });

  it('renders leader and member role labels', () => {
    const { rerender } = render(
      <ClanWidget clan={{ id: 'clan-1', name: 'Альфа', tags: [], member_role: 'leader' }} />,
    );
    expect(screen.getByRole('link')).toHaveTextContent('Глава');

    rerender(
      <ClanWidget clan={{ id: 'clan-1', name: 'Альфа', tags: [], member_role: 'member' }} />,
    );
    expect(screen.getByRole('link')).toHaveTextContent('Участник');
  });

  it('renders nothing for a clanless player', () => {
    const { container } = render(<ClanWidget clan={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
