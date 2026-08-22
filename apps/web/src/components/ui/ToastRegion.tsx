import type { ReactNode } from 'react';

/**
 * Общая область всплывающих уведомлений — нижний правый угол окна.
 *
 * Каждое уведомление панели раньше само прибивалось к `fixed bottom-4 right-4`,
 * поэтому два одновременных сообщения ложились друг на друга и верхнее прятало
 * нижнее. Теперь позицию знает только область: уведомления внутри неё —
 * обычные блоки в колонке и укладываются стопкой сами.
 *
 * Область не перехватывает указатель (`pointer-events-none`), иначе невидимая
 * колонка накрыла бы правый край страницы; каждое уведомление возвращает
 * перехват себе через `pointer-events-auto`.
 */
export function ToastRegion({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-end gap-2 px-4">
      {children}
    </div>
  );
}
