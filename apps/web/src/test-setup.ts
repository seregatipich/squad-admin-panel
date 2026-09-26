/**
 * Общая подготовка каждого тестового файла `@squad/web` (`setupFiles` в
 * `vitest.config.ts`). Раньше 171 файл импортировал jest-dom сам, а 51 файл
 * держал собственную копию полифилла `<dialog>`; теперь это делается один раз
 * здесь, и новый тест получает то же окружение без копирования.
 *
 * Импорт jest-dom регистрирует матчеры (`toBeInTheDocument` и др.) и заодно
 * подключает их типы ко всей программе `tsc`, поэтому файл лежит внутри `src/`.
 */
import '@testing-library/jest-dom/vitest';

/**
 * Ни одна тестовая DOM-среда не ведёт `<dialog>` как браузер: jsdom 29 знает
 * элемент, но не реализует `showModal()`/`close()`, а happy-dom реализует их
 * без фокуса внутрь окна и без Escape. Модальные окна построены на примитивах
 * `Modal`/`AlertDialog`, поэтому полифилл ставится поверх любой реализации и
 * повторяет ровно то, на что они опираются: атрибут `open`, фокус внутрь окна и
 * цепочку Escape → отменяемое `cancel` → `close`. Он живёт только в тестах —
 * сами примитивы рассчитаны на настоящий браузер. В node-окружении
 * `HTMLDialogElement` нет, и полифилл не ставится.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const escapeHandlers = new WeakMap<HTMLDialogElement, (event: KeyboardEvent) => void>();

if (typeof HTMLDialogElement !== 'undefined') {
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

/**
 * happy-dom подменяет `fetch` своим, а тот разрешает относительный URL против
 * `http://localhost:3000` — порта `next dev` — и уходит в сеть: тест, забывший
 * застабить `fetch`, при запущенном локальном стеке получал бы ответы живого
 * сервера. В jsdom-окружении оставался `fetch` Node, который отклоняет
 * относительный URL сразу; здесь то же поведение задаётся явно. Тесты, как и
 * прежде, подменяют `fetch` через `vi.stubGlobal`.
 */
if ('happyDOM' in globalThis) {
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.reject(
      new TypeError(
        `fetch не застаблен в этом тесте: ${input instanceof Request ? input.url : String(input)}`,
      ),
    )) as typeof fetch;
}
