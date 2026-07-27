// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvidenceSection } from './EvidenceSection';

const EVIDENCE_RESPONSE = {
  items: [
    {
      link: {
        id: 'link-1',
        entity_type: 'moderation_action',
        entity_id: 'action-1',
        created_at: '2026-07-09T10:00:00.000Z',
      },
      media: {
        id: 'media-1',
        kind: 'video',
        original_filename: 'clip.mp4',
        external_url: null,
        title: 'Аимбот на записи',
      },
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EvidenceSection', () => {
  it('is a valid React component', () => {
    expect(EvidenceSection).toBeDefined();
    expect(typeof EvidenceSection).toBe('function');
  });

  it('renders the evidence list from a mocked fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(EVIDENCE_RESPONSE), { status: 200 })),
      ),
    );

    render(<EvidenceSection playerId="player-1" />);
    expect(screen.getByText('Загрузка…')).toBeInTheDocument();

    await screen.findByText('Аимбот на записи');
    expect(screen.getByText('Доказательства (1)')).toBeInTheDocument();
  });

  it('hides entirely on 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
      ),
    );

    const { container } = render(<EvidenceSection playerId="player-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders a video element whose source points at the media stream route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(EVIDENCE_RESPONSE), { status: 200 })),
      ),
    );

    render(<EvidenceSection playerId="player-1" />);
    await screen.findByText('Аимбот на записи');

    const video = document.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video?.getAttribute('src')).toBe('/api/v1/media/media-1/stream');
  });
});
