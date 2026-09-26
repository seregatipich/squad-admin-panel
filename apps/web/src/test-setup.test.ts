// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Поведение общей подготовки тестов (`src/test-setup.ts`) в happy-dom — среде
 * по умолчанию для DOM-тестов `@squad/web`.
 */
describe('test-setup under happy-dom', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a fetch the test did not stub instead of sending it to localhost:3000', async () => {
    await expect(fetch('/api/v1/me')).rejects.toThrow(
      new TypeError('fetch не застаблен в этом тесте: /api/v1/me'),
    );
    await expect(fetch(new Request('http://localhost:3000/api/v1/me'))).rejects.toThrow(
      'fetch не застаблен в этом тесте: http://localhost:3000/api/v1/me',
    );
  });

  it('still lets a test stub fetch and restores the guard afterwards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{"ok":true}'))),
    );
    await expect((await fetch('/api/v1/me')).json()).resolves.toEqual({ ok: true });

    vi.unstubAllGlobals();
    await expect(fetch('/api/v1/me')).rejects.toThrow(TypeError);
  });

  it('replaces the native dialog methods: showModal focuses inside, Escape cancels then closes', () => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<p>Текст</p><button type="button">Готово</button>';
    document.body.append(dialog);
    const events: string[] = [];
    dialog.addEventListener('cancel', () => events.push('cancel'));
    dialog.addEventListener('close', () => events.push('close'));

    dialog.showModal();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(dialog.querySelector('button'));

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.open).toBe(false);
    expect(events).toEqual(['cancel', 'close']);
    dialog.remove();
  });

  it('keeps the dialog open when a cancel listener prevents Escape', () => {
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    dialog.addEventListener('cancel', (event) => event.preventDefault());

    dialog.showModal();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.open).toBe(true);

    dialog.close();
    expect(dialog.open).toBe(false);
    dialog.remove();
  });
});
