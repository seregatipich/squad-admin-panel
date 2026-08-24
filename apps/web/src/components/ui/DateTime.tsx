export type DateTimeMode = 'absolute' | 'relative' | 'both';

/**
 * Тексты относительного времени. Примитив ничего не склоняет и не переводит
 * сам: «5 минут назад» и «5 minutes ago» отличаются не только словами, но и
 * правилами выбора формы, поэтому строку целиком отдаёт вызывающая сторона.
 */
export type RelativeLabels = {
  justNow: string;
  secondsAgo: (n: number) => string;
  minutesAgo: (n: number) => string;
  hoursAgo: (n: number) => string;
  daysAgo: (n: number) => string;
};

/*
 * Набор опций фиксирован и задан явно. `toLocaleString()` без опций отдаёт
 * разный формат в зависимости от браузера и версии ICU, из-за чего соседние
 * списки панели показывают одно и то же время по-разному. `hourCycle: 'h23'`,
 * а не `hour12: false`: последний в части локалей разрешается в h24 и печатает
 * полночь как «24:05».
 */
const ABSOLUTE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

/*
 * Только время суток — для колонок, где дата не несёт информации: журнал
 * действий за сегодня, время последнего опроса сервера. Часовой цикл тот же,
 * что и в полном формате, чтобы «00:05» в одной колонке не превращалось в
 * «12:05 AM» в соседней.
 */
const CLOCK_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

/* Порог «только что» совпадает с порогом свежести живых данных в
   `LiveIndicator` (10 с): в панели «сейчас» означает одно и то же везде. */
const JUST_NOW_MS = 10_000;

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function absoluteFor(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, ABSOLUTE_OPTIONS).format(date);
}

function relativeFor(date: Date, now: number, labels: RelativeLabels): string {
  const diff = now - date.getTime();
  // Отрицательная разница — рассинхронизация часов клиента и сервера, а не
  // будущее событие: «через −3 секунды» показывать некорректно.
  if (diff < JUST_NOW_MS) return labels.justNow;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return labels.secondsAgo(seconds);

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return labels.minutesAgo(minutes);

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.hoursAgo(hours);

  return labels.daysAgo(Math.floor(hours / 24));
}

/**
 * Абсолютное время в едином формате панели — ДД.ММ.ГГГГ, ЧЧ:ММ:СС для
 * локалей с таким порядком полей.
 *
 * @param value момент времени: ISO-строка, миллисекунды эпохи или `Date`.
 * @param locale локаль форматирования; обязательна — компонент её не угадывает.
 * @returns отформатированная строка либо `null`, если дата невалидна.
 */
export function formatAbsolute(value: string | number | Date, locale: string): string | null {
  const date = toDate(value);
  return date === null ? null : absoluteFor(date, locale);
}

/**
 * Время суток в едином формате панели — ЧЧ:ММ:СС.
 *
 * @param value момент времени: ISO-строка, миллисекунды эпохи или `Date`.
 * @param locale локаль форматирования; обязательна — функция её не угадывает.
 * @returns отформатированную строку либо `null`, если дата невалидна.
 */
export function formatClock(value: string | number | Date, locale: string): string | null {
  const date = toDate(value);
  return date === null ? null : new Intl.DateTimeFormat(locale, CLOCK_OPTIONS).format(date);
}

/**
 * Относительное время: «только что», секунды, минуты, часы, дни.
 *
 * Единица выбирается по последней целиком прошедшей: 59 с — секунды, 60 с —
 * минуты, 59 мин — минуты, 60 мин — часы, 23 ч — часы, 24 ч — дни.
 *
 * @param value момент времени: ISO-строка, миллисекунды эпохи или `Date`.
 * @param now точка отсчёта в миллисекундах эпохи.
 * @param labels тексты для каждой единицы.
 * @returns строку либо `null`, если дата невалидна.
 */
export function formatRelative(
  value: string | number | Date,
  now: number,
  labels: RelativeLabels,
): string | null {
  const date = toDate(value);
  return date === null ? null : relativeFor(date, now, labels);
}

type DateTimeBaseProps = {
  value: string | number | Date;
  /** Локаль форматирования; обязательна — компонент её не угадывает. */
  locale: string;
  /** Точка отсчёта для относительного режима; по умолчанию `Date.now()`. */
  now?: number;
  /** Что показать вместо невалидной даты. */
  fallback?: string;
  className?: string;
};

/*
 * Тексты нужны ровно тем режимам, которые их печатают. Объединение вместо
 * необязательного поля: `mode="relative"` без словаря — ошибка типизации, а
 * не пустая строка на экране.
 */
type DateTimeModeProps =
  | { mode?: 'absolute'; relativeLabels?: RelativeLabels }
  | { mode: 'relative' | 'both'; relativeLabels: RelativeLabels };

export type DateTimeProps = DateTimeBaseProps & DateTimeModeProps;

/**
 * Момент времени в разметке: `<time>` с машинночитаемым `dateTime` и
 * абсолютным значением во всплывающей подсказке при любом режиме.
 *
 * Относительное время отвечает на вопрос «давно ли», абсолютное — «когда
 * именно»; подсказка держит второе под рукой, не тратя на него ширину строки.
 */
export function DateTime(props: DateTimeProps) {
  const {
    value,
    locale,
    mode = 'absolute',
    relativeLabels,
    now,
    fallback = '—',
    className,
  } = props;

  const date = toDate(value);
  // `<time>` без корректного `dateTime` хуже его отсутствия: машина прочтёт
  // мусор как дату. Невалидное значение остаётся обычным текстом.
  if (date === null) return <span className={className}>{fallback}</span>;

  const absolute = absoluteFor(date, locale);
  const relative =
    mode !== 'absolute' && relativeLabels
      ? relativeFor(date, now ?? Date.now(), relativeLabels)
      : null;

  return (
    <time
      dateTime={date.toISOString()}
      title={absolute}
      className={className}
      // Время на сервере и в браузере считается в разных часовых поясах и в
      // разные миллисекунды, поэтому расхождение текста здесь ожидаемо.
      suppressHydrationWarning
    >
      {relative ?? absolute}
      {/* Пробел настоящим текстом, а не отступом: без него скопированная
          строка и синтезированная речь слипаются в «ч:222.08.2026». */}
      {mode === 'both' && relative !== null && <span className="text-ink-3"> {absolute}</span>}
    </time>
  );
}
