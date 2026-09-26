// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UploadClient } from './UploadClient';

interface ProgressTick {
  loaded: number;
  total: number;
}

/** Minimal XMLHttpRequest stand-in: jsdom ships no upload-progress implementation. */
class FakeXhr {
  static last: FakeXhr | null = null;
  static aborted = 0;

  upload = { onprogress: null as ((tick: ProgressTick) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = '';
  method = '';
  url = '';
  body: unknown = null;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  send(body: unknown): void {
    this.body = body;
  }

  abort(): void {
    FakeXhr.aborted += 1;
  }
}

function pngFile(size = 2048): File {
  return new File([new Uint8Array(size)], 'clip.png', { type: 'image/png' });
}

function pdfFile(): File {
  return new File([new Uint8Array(16)], 'notes.pdf', { type: 'application/pdf' });
}

function dropFile(file: File): void {
  fireEvent.drop(screen.getByTestId('upload-dropzone'), {
    dataTransfer: { files: [file], types: ['Files'] },
  });
}

beforeEach(() => {
  FakeXhr.last = null;
  FakeXhr.aborted = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UploadClient', () => {
  it('renders the anonymous drop zone with the accepted formats', () => {
    render(<UploadClient token="tok-1" />);
    expect(screen.getByRole('heading', { name: /Загрузка доказательства/ })).toBeInTheDocument();
    expect(screen.getByTestId('upload-dropzone')).toBeInTheDocument();
    expect(screen.getByText(/MP4/)).toBeInTheDocument();
  });

  it('posts the chosen file to the public endpoint with the token in the query string', async () => {
    render(<UploadClient token="tok /1" />);
    await userEvent.upload(screen.getByTestId('upload-input'), pngFile());

    expect(FakeXhr.last?.method).toBe('POST');
    expect(FakeXhr.last?.url).toBe('/api/v1/public/media?token=tok%20%2F1');
    expect(FakeXhr.last?.body).toBeInstanceOf(FormData);
  });

  it('shows transferred megabytes, speed and percent while uploading', async () => {
    render(<UploadClient token="tok-1" />);
    await userEvent.upload(screen.getByTestId('upload-input'), pngFile());

    act(() => {
      FakeXhr.last?.upload.onprogress?.({ loaded: 1024 * 1024, total: 4 * 1024 * 1024 });
    });

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByTestId('upload-progress-text')).toHaveTextContent('1.0 МБ');
    expect(screen.getByTestId('upload-progress-text')).toHaveTextContent('4.0 МБ');
  });

  it('reports success once the server answers 201', async () => {
    render(<UploadClient token="tok-1" />);
    await userEvent.upload(screen.getByTestId('upload-input'), pngFile());

    act(() => {
      const xhr = FakeXhr.last;
      if (!xhr) throw new Error('no request issued');
      xhr.status = 201;
      xhr.responseText = JSON.stringify({ ok: true, media_id: 'media-1' });
      xhr.onload?.();
    });

    expect(await screen.findByRole('status')).toHaveTextContent('Файл загружен');
  });

  it('explains a spent or expired link when the server answers 410', async () => {
    render(<UploadClient token="tok-1" />);
    await userEvent.upload(screen.getByTestId('upload-input'), pngFile());

    act(() => {
      const xhr = FakeXhr.last;
      if (!xhr) throw new Error('no request issued');
      xhr.status = 410;
      xhr.onload?.();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('ссылк');
  });

  it('explains a network failure', async () => {
    render(<UploadClient token="tok-1" />);
    await userEvent.upload(screen.getByTestId('upload-input'), pngFile());

    act(() => {
      FakeXhr.last?.onerror?.();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Сеть');
  });

  it('accepts a dropped file and starts the upload', () => {
    render(<UploadClient token="tok-1" />);
    dropFile(pngFile());
    expect(FakeXhr.last?.url).toBe('/api/v1/public/media?token=tok-1');
  });

  it('refuses an unsupported format locally without issuing a request', () => {
    render(<UploadClient token="tok-1" />);
    dropFile(pdfFile());
    expect(FakeXhr.last).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('формат');
  });

  it('highlights the drop zone while a file is dragged over it', () => {
    render(<UploadClient token="tok-1" />);
    const zone = screen.getByTestId('upload-dropzone');
    fireEvent.dragOver(zone);
    expect(zone).toHaveAttribute('data-dragging', 'true');
    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute('data-dragging', 'false');
  });

  it('ignores a drop that carries no file', () => {
    render(<UploadClient token="tok-1" />);
    fireEvent.drop(screen.getByTestId('upload-dropzone'), {
      dataTransfer: { files: [], types: [] },
    });
    expect(FakeXhr.last).toBeNull();
  });

  it('aborts an in-flight upload when unmounted', async () => {
    const view = render(<UploadClient token="tok-1" />);
    await userEvent.upload(screen.getByTestId('upload-input'), pngFile());
    view.unmount();
    expect(FakeXhr.aborted).toBe(1);
  });
});
