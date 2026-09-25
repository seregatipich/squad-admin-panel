// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const busState = vi.fn(() => 'open');
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: vi.fn(),
  useLiveBusState: () => busState(),
}));

import { ChatPanel } from './ChatPanel';

afterEach(() => {
  cleanup();
  busState.mockReturnValue('open');
});

describe('ChatPanel', () => {
  it('is a valid React component', () => {
    expect(ChatPanel).toBeDefined();
    expect(typeof ChatPanel).toBe('function');
  });

  it('names the live-bus state in words, not only by colour', () => {
    render(<ChatPanel serverId="srv-1" />);
    expect(screen.getByRole('heading', { name: 'Чат сервера' })).toBeInTheDocument();
    expect(screen.getByText('в эфире')).toBeInTheDocument();
  });

  it('says so when the event stream is down', () => {
    busState.mockReturnValue('closed');
    render(<ChatPanel serverId="srv-1" />);
    expect(screen.getByText('нет связи')).toBeInTheDocument();
  });

  it('explains an empty chat instead of showing a blank panel', () => {
    render(<ChatPanel serverId="srv-1" />);
    expect(screen.getByText(/Сообщения появятся/)).toBeInTheDocument();
  });
});
