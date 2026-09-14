// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
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

/**
 * jsdom 29 знает элемент `<dialog>`, но не реализует `showModal()`/`close()`.
 * Полифилл живёт только в тестах — `AlertDialog` рассчитан на настоящий
 * браузер. Воспроизводится то, на что опирается `Modal`: атрибут `open`, фокус
 * внутрь окна и цепочка Escape → отменяемое `cancel` → `close`.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const escapeHandlers = new WeakMap<HTMLDialogElement, (event: KeyboardEvent) => void>();

if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const notPrevented = this.dispatchEvent(new Event('cancel', { cancelable: true }));
      if (notPrevented) this.close();
    };
    escapeHandlers.set(this, onKeyDown);
    this.addEventListener('keydown', onKeyDown);
    this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    const onKeyDown = escapeHandlers.get(this);
    if (onKeyDown) {
      this.removeEventListener('keydown', onKeyDown);
      escapeHandlers.delete(this);
    }
    this.dispatchEvent(new Event('close'));
  };
}

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

interface DriftItemFixture {
  name: string;
  state: 'in_sync' | 'drift' | 'missing' | 'unreachable' | 'unknown';
  disk_sha256: string | null;
  version_sha256: string | null;
  tip_version_id: string | null;
}

interface VersionFixture {
  id: string;
  sha256: string;
  author_user_id: string | null;
  author_email: string | null;
  message: string | null;
  size: number;
  created_at: string;
}

function installFetch(opts: {
  fileName: string;
  content: string;
  behavior: string;
  permissions?: string[];
  drift?: DriftItemFixture[];
  versions?: VersionFixture[];
  /** Ответ на сохранение; 500 позволяет тесту получить полосу ошибки. */
  putStatus?: number;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: init?.body as string | undefined });
      if (url.includes('/history')) {
        return Promise.resolve(
          new Response(JSON.stringify({ items: opts.versions ?? [] }), { status: 200 }),
        );
      }
      if (method === 'POST' && url.includes('/restore/')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      if (url.endsWith('/configs/drift')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ items: opts.drift ?? [], checked_at: '2026-07-26T00:00:00Z' }),
            { status: 200 },
          ),
        );
      }
      if (
        method === 'POST' &&
        (url.endsWith('/drift/accept') ||
          url.endsWith('/drift/revert') ||
          url.endsWith('/reset-default'))
      ) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, unchanged: false }), { status: 200 }),
        );
      }
      if (url.includes('/versions/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ content: 'tip content\n' }), { status: 200 }),
        );
      }
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
        const status = opts.putStatus ?? 200;
        if (status !== 200) {
          return Promise.resolve(new Response('boom', { status }));
        }
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

/** Файловый стенд на два файла: нужен и переключению файлов, и режиму правки. */
const BODIES: Record<string, string> = {
  'Server.cfg': '[SquadName]\nServerName="A"\n',
  'MOTD.cfg': 'добро пожаловать\n',
};

function installTwoFiles(): FetchCall[] {
  const calls: FetchCall[] = [];
  const json = (payload: unknown) =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: init?.body as string | undefined });
      if (url.endsWith('/configs/drift')) return json({ items: [] });
      if (url.endsWith('/api/v1/me')) return json({ permissions: [] });
      if (url.endsWith('/configs')) {
        return json({
          items: Object.entries(BODIES).map(([name, body]) => ({
            name,
            size: body.length,
            sha256: `sha-${name}`,
            behavior: 'hot_reload',
            exists: true,
          })),
        });
      }
      const hit = Object.keys(BODIES).find((name) => url.endsWith(`/configs/${name}`));
      if (hit) {
        return json({
          name: hit,
          content: BODIES[hit],
          sha256: `sha-${hit}`,
          behavior: 'hot_reload',
        });
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
  return calls;
}

/**
 * Снять режим только для чтения: файл открывается на просмотр, правка
 * включается зелёной кнопкой «Изменить» в углу редактора.
 */
async function startEditing() {
  await clickButton('Изменить');
}

/** Нажать кнопку с этим именем и дать React прогнать эффекты. */
async function clickButton(name: string) {
  const button = await screen.findByRole('button', { name });
  await act(async () => {
    button.click();
  });
}

/** Подтвердить открытый диалог его собственной кнопкой действия. */
async function confirmDialog(confirmLabel: string) {
  await clickButton(confirmLabel);
}

/**
 * Отказаться от открытого диалога.
 *
 * «Отмена» — имя сразу двух выходов, крестика и кнопки подвала; оператору
 * нужна именно кнопка подвала, она в разметке последняя.
 */
async function cancelDialog() {
  const exits = screen.getAllByRole('button', { name: 'Отмена' });
  const cancel = exits.at(-1);
  if (!cancel) throw new Error('диалог подтверждения не открылся');
  await act(async () => {
    cancel.click();
  });
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

  it('opens a plain config file read-only with no banner, and «Изменить» makes it editable', async () => {
    mockFetch('Server.cfg', PLAIN_CONFIG_CONTENT, 'requires_restart');
    await renderPage();
    const fileButton = await screen.findByText('Server.cfg');
    await act(async () => {
      fileButton.click();
    });
    await screen.findByTestId('monaco-stub');
    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'true');
    expect(screen.queryByText(/управляется панелью/)).not.toBeInTheDocument();

    await startEditing();
    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'false');
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
    // segment-level protection: the file itself remains editable once the
    // operator arms editing — the banner is not whole-file read-only.
    await startEditing();
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
    const calls = installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
      permissions: ['server:restart'],
    });
    await renderPage();
    await openFile('Server.cfg');
    await clickButton('Рестарт сервера');

    expect(screen.getByRole('heading', { name: 'Перезапустить сервер?' })).toBeInTheDocument();
    await confirmDialog('Перезапустить сервер');

    expect(
      calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/servers/abc/restart')),
    ).toBe(true);
  });

  it('не перезапускает сервер, если оператор отказался в диалоге', async () => {
    const calls = installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
      permissions: ['server:restart'],
    });
    await renderPage();
    await openFile('Server.cfg');
    await clickButton('Рестарт сервера');
    await cancelDialog();

    expect(
      screen.queryByRole('heading', { name: 'Перезапустить сервер?' }),
    ).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('ConfigsPage — режим просмотра и правки', () => {
  const SAVE = 'Сохранить';
  const EDIT = 'Изменить';
  const CANCEL = 'Отмена';

  it('открывает файл на просмотр: редактор только для чтения, панели сохранения нет', async () => {
    installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
    });
    await renderPage();
    await openFile('Server.cfg');

    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByRole('button', { name: EDIT })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SAVE })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Комментарий к изменению')).not.toBeInTheDocument();
  });

  it('«Изменить» открывает правку: кнопка уходит, появляется панель сохранения', async () => {
    installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
    });
    await renderPage();
    await openFile('Server.cfg');
    await startEditing();

    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'false');
    expect(screen.queryByRole('button', { name: EDIT })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: SAVE })).toBeInTheDocument();
    expect(screen.getByLabelText('Комментарий к изменению')).toBeInTheDocument();
  });

  it('после успешного сохранения возвращается в просмотр', async () => {
    installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
    });
    await renderPage();
    await openFile('Server.cfg');
    await startEditing();
    await act(async () => {
      editorCapture.onChange?.(`${SERVER_CRLF_CONTENT}\r\nExtra=1`);
    });
    await clickButton(SAVE);

    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByRole('button', { name: EDIT })).toBeInTheDocument();
  });

  // Без этого оператор, нажавший «Изменить» по ошибке, остался бы в режиме
  // правки навсегда: «Отмена» раньше блокировалась, пока нет правок.
  it('«Отмена» возвращает в просмотр даже когда ничего не поменяли', async () => {
    installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
    });
    await renderPage();
    await openFile('Server.cfg');
    await startEditing();
    await clickButton(CANCEL);

    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByRole('button', { name: EDIT })).toBeInTheDocument();
  });

  it('«Отмена» откатывает несохранённые правки и не шлёт PUT', async () => {
    const calls = installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
    });
    await renderPage();
    await openFile('Server.cfg');
    await startEditing();
    await act(async () => {
      editorCapture.onChange?.(`${SERVER_CRLF_CONTENT}\r\nExtra=1`);
    });
    await clickButton(CANCEL);

    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(screen.queryByText('изменено')).not.toBeInTheDocument();
  });

  it('файл под управлением панели не получает кнопку «Изменить» вовсе', async () => {
    mockFetch('LayerRotation.cfg', MANAGED_ROTATION_CONTENT, 'rotation');
    await renderPage();
    await openFile('LayerRotation.cfg');

    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'true');
    expect(screen.queryByRole('button', { name: EDIT })).not.toBeInTheDocument();
  });

  it('открытие другого файла снова начинается с просмотра', async () => {
    installTwoFiles();
    await renderPage();
    await openFile('Server.cfg');
    await startEditing();
    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'false');

    await openFile('MOTD.cfg');

    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByRole('button', { name: EDIT })).toBeInTheDocument();
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
    await startEditing();

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

describe('ConfigsPage — config drift (CFG-2 #64)', () => {
  const DRIFT_ITEM: DriftItemFixture = {
    name: 'MOTD.cfg',
    state: 'drift',
    disk_sha256: 'd15c0000',
    version_sha256: 'aaaa0000',
    tip_version_id: 'tip-0001',
  };

  it('renders config-drift-banner when drift reported', async () => {
    installFetch({
      fileName: 'MOTD.cfg',
      content: 'panel text\n',
      behavior: 'hot_reload',
      drift: [DRIFT_ITEM],
    });
    await renderPage();
    const banner = await screen.findByTestId('config-drift-banner');
    expect(within(banner).getByText('MOTD.cfg')).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Принять' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Откатить' })).toBeInTheDocument();
    // drifting files are marked in the file list
    expect(await screen.findByTestId('file-drift-marker')).toBeInTheDocument();
  });

  it('does not render the banner when every file is in sync', async () => {
    installFetch({
      fileName: 'MOTD.cfg',
      content: 'panel text\n',
      behavior: 'hot_reload',
      drift: [{ ...DRIFT_ITEM, state: 'in_sync', disk_sha256: 'aaaa0000' }],
    });
    await renderPage();
    await act(async () => {});
    expect(screen.queryByTestId('config-drift-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-drift-marker')).not.toBeInTheDocument();
  });

  it('accept and revert buttons call their endpoints after confirm', async () => {
    const calls = installFetch({
      fileName: 'MOTD.cfg',
      content: 'panel text\n',
      behavior: 'hot_reload',
      drift: [DRIFT_ITEM],
    });
    await renderPage();

    await act(async () => {
      within(await screen.findByTestId('config-drift-banner'))
        .getByRole('button', { name: 'Принять' })
        .click();
    });
    await confirmDialog('Принять правку с диска');
    expect(
      calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url.endsWith('/api/v1/servers/abc/configs/MOTD.cfg/drift/accept'),
      ),
    ).toBe(true);

    await act(async () => {
      within(await screen.findByTestId('config-drift-banner'))
        .getByRole('button', { name: 'Откатить' })
        .click();
    });
    await confirmDialog('Откатить к версии панели');
    expect(
      calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url.endsWith('/api/v1/servers/abc/configs/MOTD.cfg/drift/revert'),
      ),
    ).toBe(true);
  });

  it('does not call accept/revert when the confirmation is declined', async () => {
    const calls = installFetch({
      fileName: 'MOTD.cfg',
      content: 'panel text\n',
      behavior: 'hot_reload',
      drift: [DRIFT_ITEM],
    });
    await renderPage();

    await act(async () => {
      within(await screen.findByTestId('config-drift-banner'))
        .getByRole('button', { name: 'Принять' })
        .click();
    });
    await cancelDialog();

    await act(async () => {
      within(await screen.findByTestId('config-drift-banner'))
        .getByRole('button', { name: 'Откатить' })
        .click();
    });
    await cancelDialog();

    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('diff button opens the drift diff view (panel tip vs disk)', async () => {
    const calls = installFetch({
      fileName: 'MOTD.cfg',
      content: 'disk content\n',
      behavior: 'hot_reload',
      drift: [DRIFT_ITEM],
    });
    await renderPage();
    const banner = await screen.findByTestId('config-drift-banner');
    await act(async () => {
      within(banner).getByRole('button', { name: 'Diff' }).click();
    });
    expect(await screen.findByTestId('config-drift-diff')).toBeInTheDocument();
    expect(
      calls.some(
        (c) =>
          c.method === 'GET' &&
          c.url.endsWith('/api/v1/servers/abc/configs/MOTD.cfg/versions/tip-0001'),
      ),
    ).toBe(true);
  });

  it('reset-default calls its endpoint', async () => {
    const calls = installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
    });
    await renderPage();
    await openFile('Server.cfg');
    await clickButton('Сброс к дефолту');

    expect(
      screen.getByRole('heading', { name: 'Сбросить Server.cfg к депо-дефолту?' }),
    ).toBeInTheDocument();
    await confirmDialog('Сбросить к дефолту');

    expect(
      calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url.endsWith('/api/v1/servers/abc/configs/Server.cfg/reset-default'),
      ),
    ).toBe(true);
  });

  it('hides the reset-default button for panel-managed and managed-segment files', async () => {
    installFetch({
      fileName: 'Admins.cfg',
      content: MANAGED_ADMINS_CONTENT,
      behavior: 'hot_reload',
    });
    await renderPage();
    await openFile('Admins.cfg');
    expect(screen.queryByRole('button', { name: 'Сброс к дефолту' })).not.toBeInTheDocument();
  });
});

describe('ConfigsPage — вкладки и история версий', () => {
  const VERSION: VersionFixture = {
    id: 'ver-0001',
    sha256: 'abcdef0123456789',
    author_user_id: 'u1',
    author_email: 'admin@example.com',
    message: 'поднял лимит игроков',
    size: 42,
    created_at: '2026-07-26T10:00:00.000Z',
  };

  it('переключатель разделов открывает историю версий таблицей', async () => {
    installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
      versions: [VERSION],
    });
    await renderPage();
    await openFile('Server.cfg');

    await act(async () => {
      screen.getByRole('tab', { name: 'История' }).click();
    });

    expect(screen.getByRole('table', { name: 'История версий файла' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Автор' })).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
  });

  it('пустая история объявляется отдельным состоянием, а не пустой таблицей', async () => {
    installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
      versions: [],
    });
    await renderPage();
    await openFile('Server.cfg');

    await act(async () => {
      screen.getByRole('tab', { name: 'История' }).click();
    });

    expect(screen.getByText('История пуста')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'История версий файла' })).not.toBeInTheDocument();
  });

  it('восстановление версии проходит только через подтверждение', async () => {
    const calls = installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
      versions: [VERSION],
    });
    await renderPage();
    await openFile('Server.cfg');
    await act(async () => {
      screen.getByRole('tab', { name: 'История' }).click();
    });

    await clickButton('Восстановить');
    await cancelDialog();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/restore/'))).toBe(false);

    await clickButton('Восстановить');
    await confirmDialog('Восстановить как новую версию');
    expect(
      calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url.endsWith('/api/v1/servers/abc/configs/Server.cfg/restore/ver-0001'),
      ),
    ).toBe(true);
  });
});

describe('ConfigsPage — несохранённые правки при переключении файла', () => {
  it('спрашивает подтверждение и открывает соседний файл только после согласия', async () => {
    const calls = installTwoFiles();
    await renderPage();
    await openFile('Server.cfg');

    await act(async () => {
      editorCapture.onChange?.('[SquadName]\nServerName="B"\n');
    });
    expect(screen.getByText('изменено')).toBeInTheDocument();

    await act(async () => {
      screen.getByText('MOTD.cfg').click();
    });
    expect(screen.getByRole('heading', { name: 'Открыть другой файл?' })).toBeInTheDocument();

    await cancelDialog();
    expect(calls.some((c) => c.url.endsWith('/configs/MOTD.cfg'))).toBe(false);
    expect(screen.getByText('изменено')).toBeInTheDocument();

    await act(async () => {
      screen.getByText('MOTD.cfg').click();
    });
    await confirmDialog('Открыть без сохранения');
    expect(calls.some((c) => c.url.endsWith('/api/v1/servers/abc/configs/MOTD.cfg'))).toBe(true);
    expect(screen.queryByText('изменено')).not.toBeInTheDocument();
  });

  it('открывает файл сразу, когда несохранённых правок нет', async () => {
    const calls = installTwoFiles();
    await renderPage();
    await openFile('Server.cfg');

    await act(async () => {
      screen.getByText('MOTD.cfg').click();
    });

    expect(screen.queryByRole('heading', { name: 'Открыть другой файл?' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/api/v1/servers/abc/configs/MOTD.cfg'))).toBe(true);
  });
});

describe('ConfigsPage — полоса ошибки', () => {
  it('«Повторить» не стирает несохранённые правки открытого файла', async () => {
    const calls = installFetch({
      fileName: 'Server.cfg',
      content: SERVER_CRLF_CONTENT,
      behavior: 'requires_restart',
      putStatus: 500,
    });
    await renderPage();
    await openFile('Server.cfg');
    await startEditing();

    await act(async () => {
      editorCapture.onChange?.(`${SERVER_CRLF_CONTENT}\r\nExtra=1`);
    });
    await clickButton('Сохранить');

    expect(screen.getByRole('alert')).toHaveTextContent('Запрос к серверу не прошёл');
    const getsBefore = calls.filter(
      (c) => c.method === 'GET' && c.url.endsWith('/api/v1/servers/abc/configs/Server.cfg'),
    ).length;

    await clickButton('Повторить');

    // Файл не перечитан, правка на месте: список файлов обновился, редактор — нет.
    expect(
      calls.filter(
        (c) => c.method === 'GET' && c.url.endsWith('/api/v1/servers/abc/configs/Server.cfg'),
      ).length,
    ).toBe(getsBefore);
    expect(screen.getByText('изменено')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
