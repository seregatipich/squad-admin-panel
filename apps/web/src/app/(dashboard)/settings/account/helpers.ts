/**
 * Платформы в порядке проверки, а не в алфавитном: порядок здесь — часть
 * правила. Android содержит токен `Linux`, а iOS — хвост `like Mac OS X`, так
 * что общий случай обязан стоять после частного, иначе телефон определится
 * как десктоп.
 */
const PLATFORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Android/i, 'Android'],
  [/iPhone|iPad|iPod/i, 'iOS'],
  [/Windows NT/i, 'Windows'],
  [/Macintosh|Mac OS X/i, 'macOS'],
  [/X11|Linux/i, 'Linux'],
];

/**
 * Браузеры в порядке проверки. Токен `Chrome/` есть у любого движка на Blink,
 * поэтому фирменные метки идут раньше него, а `Safari/` — последним: им
 * подписывается и Chrome, и Opera, и настоящий Safari, и различает их только
 * наличие `Version/`.
 */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdgA?\/(\d+)/, 'Edge'],
  [/\bOPR\/(\d+)/, 'Opera'],
  [/\bYaBrowser\/(\d+)/, 'Yandex'],
  [/\bFirefox\/(\d+)/, 'Firefox'],
  [/\bChrome\/(\d+)/, 'Chrome'],
  [/\bVersion\/(\d+).*\bSafari\//, 'Safari'],
];

/** Приложение на Electron подписывается собственным токеном перед `Chrome/`. */
const ELECTRON_APP = /\b([A-Za-z][\w.-]*)\/[\d.]+\s+Chrome\//;

const MAX_RAW_AGENT_LENGTH = 60;

/**
 * Человекочитаемое имя устройства из строки User-Agent: «Opera 134 · Linux».
 *
 * Колонка существует ради одного — дать оператору отличить свои сессии друг от
 * друга, поэтому берётся не первый попавшийся токен, а пара «браузер +
 * платформа». Версия приложения на Electron опускается: `1.34493.1` оператору
 * ничего не говорит, а имя приложения — говорит.
 *
 * @param ua Заголовок User-Agent сессии; `null` для сессий, заведённых не
 *   браузером (например, служебных).
 * @returns Подпись для колонки «Устройство»; `—`, если агент неизвестен, и сама
 *   строка агента (обрезанная), если она не похожа на User-Agent браузера.
 */
export function describeDevice(ua: string | null): string {
  if (!ua) return '—';

  const platform = PLATFORMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;

  const electronApp = /\bElectron\//.test(ua) ? ua.match(ELECTRON_APP)?.[1] : undefined;
  let browser = electronApp ?? null;
  if (browser === null) {
    for (const [pattern, name] of BROWSERS) {
      const match = ua.match(pattern);
      if (match) {
        browser = `${name} ${match[1]}`;
        break;
      }
    }
  }

  if (browser === null && platform === null) return ua.slice(0, MAX_RAW_AGENT_LENGTH);
  if (browser === null) return platform as string;
  return platform === null ? browser : `${browser} · ${platform}`;
}

const RU_PLURAL_RULES = new Intl.PluralRules('ru-RU');

/**
 * Русская форма существительного при числе.
 *
 * `Intl` берётся не ради краткости: правило «21 ключ, но 11 ключей» знает
 * далеко не каждый, кто правит строку, и рукописный `count % 10` в интерфейсе
 * ошибается ровно на этих числах.
 */
function pluralRu(count: number, one: string, few: string, many: string): string {
  const form = RU_PLURAL_RULES.select(count);
  if (form === 'one') return one;
  return form === 'few' ? few : many;
}

/**
 * Число ключей доступа с русской формой существительного: «1 ключ», «53 ключа»,
 * «11 ключей».
 *
 * @param count Количество ключей в наборе роли.
 */
export function formatPermissionCount(count: number): string {
  return `${count} ${pluralRu(count, 'ключ', 'ключа', 'ключей')}`;
}

/**
 * Подпись кнопки, открывающей историю ников: «ещё 3 ника».
 *
 * @param count Сколько прошлых ников есть сверх того, что стоит в шапке.
 */
export function formatPreviousNamesCount(count: number): string {
  return `ещё ${count} ${pluralRu(count, 'ник', 'ника', 'ников')}`;
}

/** Дата без времени: история ников читается по дням, а не по минутам. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU');
}

/** Момент времени в локальном формате для колонок таблицы сессий. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU');
}

/**
 * Насколько сессии осталось жить: «через 5 ч 59 мин».
 *
 * Ветка «истекла» остаётся и после того, как эндпоинт перестал отдавать
 * протухшие сессии: список обновляется раз в полминуты, и сессия успевает
 * истечь между опросами прямо на глазах у оператора.
 *
 * @param iso Момент истечения сессии.
 */
export function formatRelative(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return 'истекла';
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `через ${diffMin} мин`;
  const diffH = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  if (diffH < 24) return remMin > 0 ? `через ${diffH} ч ${remMin} мин` : `через ${diffH} ч`;
  const diffD = Math.floor(diffH / 24);
  return `через ${diffD} дн`;
}

/** Одна запись из истории смен ников, как её отдаёт `GET /api/v1/me/names`. */
export interface NameHistoryEntry {
  name: string;
  first_seen_at: string;
  last_seen_at: string;
}

/** Ответ `GET /api/v1/me/names`. */
export interface AccountNames {
  canonical_name: string;
  persona_name: string | null;
  history: NameHistoryEntry[];
}

/**
 * Ник для шапки страницы.
 *
 * Игровой ник главнее ника из Steam: панель обслуживает игровой сервер, и
 * оператор узнаёт себя по тому имени, под которым его видят в игре. Ник из
 * Steam остаётся запасным — он есть даже у того, кто ещё ни разу не заходил на
 * сервер.
 */
export function displayName(names: AccountNames): string {
  const canonical = names.canonical_name.trim();
  if (canonical !== '') return canonical;
  const persona = names.persona_name?.trim() ?? '';
  return persona === '' ? '—' : persona;
}

/**
 * История ников без того, который уже стоит в шапке.
 *
 * Текущий ник — такая же строка `player_name_history`, как остальные, и без
 * этого отбора он показывался бы дважды: крупно в шапке и первым в списке
 * «прошлые ники».
 *
 * Порядок эндпоинта сохраняется: он уже отсортирован по времени последней
 * встречи, от свежего к старому.
 */
export function previousNames(names: AccountNames): NameHistoryEntry[] {
  const current = displayName(names);
  return names.history.filter((entry) => entry.name !== current);
}
