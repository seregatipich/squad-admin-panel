/** Форма плашки — она повторяет очертания будущего содержимого. */
export type SkeletonVariant = 'text' | 'row' | 'card' | 'block';

/** Высоты подобраны под реальные элементы: строка таблицы — 36px (`h-9`). */
const SHAPE: Record<SkeletonVariant, string> = {
  text: 'h-3 w-full',
  row: 'h-9 w-full',
  card: 'h-24 w-full',
  block: 'h-16 w-full',
};

/**
 * Заглушка загрузки в форме будущего содержимого.
 *
 * Сами плашки помечены `aria-hidden`: для скринридера мерцающий прямоугольник —
 * это шум, а не информация, и без скрытия он читается как пустой список. Чтобы
 * состояние всё-таки было объявлено, передайте `label` — он выводится
 * единственной строкой в `role="status"` (вежливое объявление, не перебивающее
 * то, что оператор читает сейчас). Без `label` компонент не объявляет ничего:
 * когда на экране десяток заглушек, объявлять их все — хуже, чем молчать,
 * поэтому `label` ставят один раз на область загрузки.
 *
 * @param variant Форма плашки.
 * @param count Сколько плашек подряд, по умолчанию одна.
 * @param width Произвольная CSS-ширина (`'40%'`, `'12rem'`) — задаётся стилем,
 *   потому что сканер классов Tailwind не видит ширины, вычисленные в рантайме.
 * @param className Дополнительные классы плашки.
 * @param label Текст статуса для скринридера; без него ничего не объявляется.
 */
export function Skeleton({
  variant,
  count = 1,
  width,
  className,
  label,
}: {
  variant: SkeletonVariant;
  count?: number;
  width?: string;
  className?: string;
  label?: string;
}) {
  const plaque = `animate-pulse rounded bg-raised ${SHAPE[variant]}${className ? ` ${className}` : ''}`;

  return (
    <>
      {label && (
        // biome-ignore lint/a11y/useSemanticElements: <output> означает результат вычисления формы; здесь это объявление загрузки, а не результат
        <span role="status" className="sr-only">
          {label}
        </span>
      )}
      <div className="flex flex-col gap-2">
        {Array.from({ length: Math.max(count, 0) }, (_, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: плашки одинаковы, статичны и никогда не переупорядочиваются — другого стабильного ключа у них нет
            key={index}
            aria-hidden="true"
            className={plaque}
            style={width ? { width } : undefined}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Сетка плашек под таблицу, которая ещё грузится.
 *
 * Отдельная обёртка нужна потому, что таблица — самый частый случай загрузки в
 * панели, а её заглушка должна повторять сетку строк и колонок, а не столбик
 * одинаковых полос.
 *
 * @param rows Число строк-заглушек.
 * @param cols Число колонок в строке.
 * @param label Текст статуса для скринридера; без него ничего не объявляется.
 */
export function SkeletonTable({
  rows,
  cols,
  label,
}: {
  rows: number;
  cols: number;
  label?: string;
}) {
  return (
    <>
      {label && (
        // biome-ignore lint/a11y/useSemanticElements: <output> означает результат вычисления формы; здесь это объявление загрузки, а не результат
        <span role="status" className="sr-only">
          {label}
        </span>
      )}
      <div className="flex flex-col gap-2">
        {Array.from({ length: Math.max(rows, 0) }, (_, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: сетка заглушек статична и не переупорядочивается
          <div key={row} className="flex gap-3">
            {Array.from({ length: Math.max(cols, 0) }, (_, col) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: сетка заглушек статична и не переупорядочивается
                key={col}
                aria-hidden="true"
                className="h-9 flex-1 animate-pulse rounded bg-raised"
              />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
