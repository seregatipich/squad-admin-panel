// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./UploadClient', () => ({
  UploadClient: ({ token }: { token: string }) => <p>загрузка по ссылке {token}</p>,
}));

import UploadPage, { dynamic, metadata } from './page';

afterEach(cleanup);

describe('UploadPage', () => {
  it('passes the token from the URL to the client untouched', async () => {
    render(await UploadPage({ params: Promise.resolve({ token: 'one-time-abc123' }) }));

    expect(screen.getByText('загрузка по ссылке one-time-abc123')).toBeInTheDocument();
  });

  it('is never indexed and never cached, since the link is a one-time credential', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(dynamic).toBe('force-dynamic');
  });

  it('titles the tab for the uploader', () => {
    expect(metadata.title).toBe('Загрузка доказательства — Squad Admin Panel');
  });
});
