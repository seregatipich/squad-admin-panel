import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/live-bus';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { ChatMessageList } from './ChatPanel';

const SERVER = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';

function seed(): ChatMessage[] {
  return [
    {
      id: 'c1',
      server_id: SERVER,
      ts: '2026-04-23T11:30:20.485Z',
      channel: 'ChatAll',
      player_id: 'player-uuid-1',
      player_name: 'Alpha',
      steam_id64: '76561198012345678',
      eos_id: '0002a10186d9414496bf20d22d3860ba',
      message: 'hello everyone',
    },
    {
      id: 'c2',
      server_id: SERVER,
      ts: '2026-04-23T11:31:00.000Z',
      channel: 'ChatTeam',
      player_id: null,
      player_name: 'Bravo',
      steam_id64: '76561198087654321',
      eos_id: null,
      message: 'need medic',
    },
    {
      id: 'c3',
      server_id: SERVER,
      ts: '2026-04-23T11:32:00.000Z',
      channel: 'ChatAdmin',
      player_id: null,
      player_name: 'Ghost',
      steam_id64: null,
      eos_id: null,
      message: 'server restart in 5',
    },
  ];
}

describe('ChatMessageList render', () => {
  it('renders seeded messages with channel badges, player links and text', () => {
    const html = renderToStaticMarkup(<ChatMessageList messages={seed()} />);

    expect(html).toContain('hello everyone');
    expect(html).toContain('need medic');
    expect(html).toContain('server restart in 5');

    expect(html).toContain('Все');
    expect(html).toContain('Команда');
    expect(html).toContain('Админ');

    expect(html).toContain('href="/players/player-uuid-1"');
    expect(html).toContain('href="/players?q=76561198087654321"');
    expect(html).toContain('>Ghost<');
  });

  it('renders the empty state when there are no messages', () => {
    const html = renderToStaticMarkup(<ChatMessageList messages={[]} />);
    expect(html).toContain('Сообщения появятся');
  });
});
