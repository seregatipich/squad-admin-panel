// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense, useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/abc/configs'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Fake Monaco editor/model captured by the `next/dynamic` stub so the test can
// drive the onMount decorations + undo-guard and assert on them.
interface FakeChange {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}
interface CapturedDecoration {
  range: { startLineNumber: number; endLineNumber: number };
  options: { className?: string; hoverMessage?: { value: string } };
}
const editorCapture: {
  onChange?: (v: string | undefined) => void;
  changeListener?: (ev: { changes: FakeChange[] }) => void;
  decorations: CapturedDecoration[];
  undoTriggers: number;
  eol: 'LF' | 'CRLF';
  mounted: boolean;
} = { decorations: [], undoTriggers: 0, eol: 'LF', mounted: false };

function resetCapture() {
  editorCapture.onChange = undefined;
  editorCapture.changeListener = undefined;
  editorCapture.decorations = [];
  editorCapture.undoTriggers = 0;
  editorCapture.eol = 'LF';
  editorCapture.mounted = false;
}

class FakeRange {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
}

const fakeMonaco = {
  Range: FakeRange,
  editor: {
    EndOfLineSequence: { LF: 0, CRLF: 1 },
    EndOfLinePreference: { TextDefined: 1, LF: 2, CRLF: 3 },
  },
};

function makeFakeEditor(value: string) {
  const model = {
    getValue: (_pref?: number) => value,
    setEOL: (seq: number) => {
      editorCapture.eol = seq === fakeMonaco.editor.EndOfLineSequence.CRLF ? 'CRLF' : 'LF';
    },
  };
  return {
    getModel: () => model,
    createDecorationsCollection: (decs: CapturedDecoration[]) => {
      editorCapture.decorations = decs;
      return {
        clear: () => {
          editorCapture.decorations = [];
        },
        set: (next: CapturedDecoration[]) => {
          editorCapture.decorations = next;
        },
      };
    },
    onDidChangeModelContent: (cb: (ev: { changes: FakeChange[] }) => void) => {
      editorCapture.changeListener = cb;
      return { dispose: () => undefined };
    },
    trigger: (_source: string, handlerId: string) => {
      if (handlerId === 'undo') editorCapture.undoTriggers += 1;
    },
  };
}

vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function MonacoStub(props: {
      value?: string;
      options?: { readOnly?: boolean };
      onChange?: (v: string | undefined) => void;
      onMount?: (editor: unknown, monaco: unknown) => void;
    }) {
      editorCapture.onChange = props.onChange;
      const mountedRef = useRef(false);
      useEffect(() => {
        if (mountedRef.current || !props.onMount) return;
        mountedRef.current = true;
        editorCapture.mounted = true;
        props.onMount(makeFakeEditor(props.value ?? ''), fakeMonaco);
      });
      return (
        <div data-testid="monaco-stub" data-readonly={String(Boolean(props.options?.readOnly))} />
      );
    },
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import ConfigsPage from './page';

const MANAGED_ROTATION_CONTENT = [
  '// operator header',
  '//SQUAD-PANEL BEGIN — не редактировать вручную',
  'Yehorivka RAAS v11',
  '//SQUAD-PANEL END',
].join('\r\n');

const MANAGED_ADMINS_CONTENT = [
  '// operator header',
  '//SQUAD-PANEL BEGIN — не редактировать вручную',
  'Group=Admin:changemap',
  'Admin=76561198000000001:Admin',
  '//SQUAD-PANEL END',
].join('\r\n');

const PLAIN_CONFIG_CONTENT = '[SquadName]\nName=Test Server\n';
const SERVER_CRLF_CONTENT = ['[SquadName]', 'ServerName="X"', 'MaxPlayers=80'].join('\r\n');

function mockFetch(fileName: string, content: string, behavior: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.endsWith('/configs')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                { name: fileName, size: content.length, sha256: 'abc', behavior, exists: true },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith(`/configs/${fileName}`)) {
        return Promise.resolve(
          new Response(JSON.stringify({ name: fileName, content, sha256: 'abc', behavior }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

interface FetchCall {
  method: string;
  url: string;
  body?: string;
}

function installFetch(opts: {
  fileName: string;
  content: string;
  behavior: string;
  permissions?: string[];
}): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: init?.body as string | undefined });
      if (url.endsWith('/api/v1/me')) {
        return Promise.resolve(
          new Response(JSON.stringify({ permissions: opts.permissions ?? [] }), { status: 200 }),
        );
      }
      if (method === 'POST' && url.endsWith('/restart')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'restarting' }), { status: 200 }),
        );
      }
      if (method === 'PUT' && url.endsWith(`/configs/${opts.fileName}`)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ behavior: opts.behavior, unchanged: false, sha256: 'def' }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('/configs')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  name: opts.fileName,
                  size: opts.content.length,
                  sha256: 'abc',
                  behavior: opts.behavior,
                  exists: true,
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith(`/configs/${opts.fileName}`)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name: opts.fileName,
              content: opts.content,
              sha256: 'abc',
              behavior: opts.behavior,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
  return calls;
}

beforeEach(() => {
  resetCapture();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ConfigsPage params={Promise.resolve({ id: 'abc' })} />
      </Suspense>,
    );
  });
}

async function openFile(name: string) {
  const fileButton = await screen.findByText(name);
  await act(async () => {
    fileButton.click();
  });
  await screen.findByTestId('monaco-stub');
  // flush the onMount effect + the decorations effect it schedules
  await act(async () => {});
}

describe('ConfigsPage', () => {
  it('is a valid React component', () => {
    expect(ConfigsPage).toBeDefined();
    expect(typeof ConfigsPage).toBe('function');
  });

  it('renders LayerRotation.cfg read-only with a managed-segment banner when it contains the markers', async () => {
    mockFetch('LayerRotation.cfg', MANAGED_ROTATION_CONTENT, 'rotation');
    await renderPage();
    const fileButton = await screen.findByText('LayerRotation.cfg');
    await act(async () => {
      fileButton.click();
    });
    await screen.findByTestId('monaco-stub');
    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByText(/управляется панелью/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '«Ротация»' })).toHaveAttribute(
      'href',
      '/servers/abc/rotation',
    );
  });

  it('keeps a plain config file editable with no banner', async () => {
    mockFetch('Server.cfg', PLAIN_CONFIG_CONTENT, 'requires_restart');
    await renderPage();
    const fileButton = await screen.findByText('Server.cfg');
    await act(async () => {
      fileButton.click();
    });
    await screen.findByTestId('monaco-stub');
    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'false');
    expect(screen.queryByText(/управляется панелью/)).not.toBeInTheDocument();
  });
});

describe('ConfigsPage — Admins.cfg managed segment', () => {
  it('shows the managed banner and stays segment-level editable (not whole-file read-only)', async () => {
    installFetch({
      fileName: 'Admins.cfg',
      content: MANAGED_ADMINS_CONTENT,
      behavior: 'hot_reload',
    });
    await renderPage();
    await openFile('Admins.cfg');
    expect(screen.getByTestId('managed-admins-banner')).toBeInTheDocument();
    expect(screen.getByText(/управляется панелью/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '«Группы»' })).toHaveAttribute(
      'href',
      '/settings/groups',
    );
    // segment-level protection: the file itself remains editable
    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'false');
  });

  it('decorates exactly the managed-segment line range', async () => {
    installFetch({
      fileName: 'Admins.cfg',
      content: MANAGED_ADMINS_CONTENT,
      behavior: 'hot_reload',
    });
    await renderPage();
    await openFile('Admins.cfg');
    expect(editorCapture.decorations).toHaveLength(1);
    expect(editorCapture.decorations[0]?.range.startLineNumber).toBe(2);
    expect(editorCapture.decorations[0]?.range.endLineNumber).toBe(5);
    expect(editorCapture.decorations[0]?.options.className).toBe('squad-managed-segment');
  });

  it('undoes an edit that intersects the segment but lets an outside edit through', async () => {
    installFetch({
      fileName: 'Admins.cfg',
      content: MANAGED_ADMINS_CONTENT,
      behavior: 'hot_reload',
    });
    await renderPage();
    await openFile('Admins.cfg');
    expect(editorCapture.changeListener).toBeTypeOf('function');

    const before = editorCapture.undoTriggers;
    await act(async () => {
      editorCapture.changeListener?.({
        changes: [
          { range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 5 } },
        ],
      });
    });
    expect(editorCapture.undoTriggers).toBe(before + 1);

    await act(async () => {
      editorCapture.changeListener?.({
        changes: [
          { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 } },
        ],
      });
    });
    expect(editorCapture.undoTriggers).toBe(before + 1);
  });

  it('shows neither banner nor decorations when Admins.cfg has no markers', async () => {
    installFetch({
      fileName: 'Admins.cfg',
      content: '// just a comment, no managed markers\n',
      behavior: 'hot_reload',
    });
    await renderPage();
    await openFile('Admins.cfg');
    expect(screen.queryByTestId('managed-admins-banner')).not.toBeInTheDocument();
    expect(screen.queryByText(/управляется панелью/)).not.toBeInTheDocument();
    expect(editorCapture.decorations).toHaveLength(0);
  });
});

describe('ConfigsPage — restart button', () => {
  it('renders the restart button for a requires_restart file when /me grants server:restart', async () => {
    installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
      permissions: ['server:restart'],
    });
    await renderPage();
    await openFile('Server.cfg');
    expect(await screen.findByRole('button', { name: 'Рестарт сервера' })).toBeInTheDocument();
  });

  it('hides the restart button when the caller lacks server:restart', async () => {
    installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
      permissions: [],
    });
    await renderPage();
    await openFile('Server.cfg');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Рестарт сервера' })).not.toBeInTheDocument();
  });

  it('hides the restart button for a non-requires_restart file even with the permission', async () => {
    installFetch({
      fileName: 'Admins.cfg',
      content: MANAGED_ADMINS_CONTENT,
      behavior: 'hot_reload',
      permissions: ['server:restart'],
    });
    await renderPage();
    await openFile('Admins.cfg');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Рестарт сервера' })).not.toBeInTheDocument();
  });

  it('POSTs to /servers/:id/restart after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
      permissions: ['server:restart'],
    });
    await renderPage();
    await openFile('Server.cfg');
    const btn = await screen.findByRole('button', { name: 'Рестарт сервера' });
    await act(async () => {
      btn.click();
    });
    expect(
      calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/servers/abc/restart')),
    ).toBe(true);
  });
});

describe('ConfigsPage — CRLF round-trip', () => {
  it('submits CRLF content back to PUT with \\r\\n intact', async () => {
    const calls = installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
    });
    await renderPage();
    await openFile('Server.cfg');

    const edited = `${SERVER_CRLF_CONTENT}\r\nExtra=1`;
    await act(async () => {
      editorCapture.onChange?.(edited);
    });
    const saveButton = await screen.findByRole('button', { name: 'Сохранить' });
    await act(async () => {
      saveButton.click();
    });

    const put = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith('/api/v1/servers/abc/configs/Server.cfg'),
    );
    expect(put).toBeDefined();
    const sent = JSON.parse(put?.body ?? '{}') as { content: string };
    expect(sent.content).toContain('\r\n');
    expect(sent.content).toBe(edited);
  });
});
