# Changelog

## 2026-10-01 — Removed the «Нужен сид» (Need a seed) card from the server page

### Removed

- The server page no longer shows the «Нужен сид» (Need a seed) card with the «Позвать сидеров» (Call seeders) button (`SeedCallButton`). The `GET/POST /api/v1/servers/:id/seed-call` API and the automatic seeding notifications are unchanged.

## 2026-10-01 — Faction in the team header on the server page

### Added

- The team column header in «Игроки на сервере» (Players on the server) shows the faction from the open match next to the unit name: «58th Motorized Brigade · Команда 1 · Russian Ground Forces» («Команда 1» = Team 1). If the unit name is unknown, it shows «Команда N» (Team N) and the faction.

## 2026-09-30 — Limits and a read-only container root (#47, #75)

### Changed

- `docker/compose.yml` and `docker/compose.stand.yml`: the `web` container runs with `read_only: true`, `mem_limit: 1g`, `cpus: 2.0`; `/tmp` and the Next.js cache `/app/apps/web/.next/cache` (uid 1000) are mounted as tmpfs. Measured on the stand: about 120 MiB. See `docs/operations/deployment.md`.

## 2026-09-27 — Infrastructure flag and a note in Blame (#36)

### Added

- «Настройки → Группы» (Settings → Groups): a «Может управлять инфраструктурой» (Can manage infrastructure) toggle (`can_manage_infrastructure`). It is switched off together with «Доступ к панели» (Panel access), and new roles are created without it.
- Server configs, the «Blame» tab: if the API truncated the history (`truncated`), a note above the table explains that lines from earlier edits are attributed to the oldest of the versions shown.


## 2026-09-28 — Server logs and configs (#42)

### Changed

- The live container log on the server page opens only with the `server:download_logs` permission (#1239).
- The configs page does not poll the file list on a timer (only on open, after a write and when returning to the tab), and does not poll drift and the open file on a hidden tab (#1335).

## 2026-09-28 — Server settings and the alt detector (#43)

### Changed

- «Настройки сервера» (Server settings): the «Ресурсы» (Resources) block (memory, CPU, I/O limits, nice, CPU affinity) was removed — these values were never applied to the container, although the page promised «применяется при следующем запуске» (applied on next start).
- «Детектор альтов» (Alt detector): without the `player:manage_alt_detection` permission the page opens read-only — the weight fields are locked, and there are no «Добавить» (Add), «Удалить» (Delete) or «Сохранить» (Save) buttons.

## 2026-09-28 — API route audit, group w3-15 (#44)

### Changed

- The public whitelist application is submitted after signing in through Steam: the SteamID64 comes from the sign-in and is shown read-only. Without signing in, the page offers «Войти через Steam» (Sign in with Steam).
- «Настройки → Флаги чата» (Settings → Chat flags): the reindex description explains that deleting, disabling or changing a pattern immediately clears the rule's marks; starting it again while a reindex is running shows a clear message.
- «Настройки → Экономика» (Settings → Economy): the error for deleting a tier with subscription history advises disabling the tier. «Настройки → Whitelist» (Settings → Whitelist): new skip reasons for import rows (duplicate SteamID64, comment too long).

## 2026-09-28 — SteamID confirmation in whitelist applications (#52)

### Changed

- «Настройки → Whitelist» (Settings → Whitelist), applications: each application has the label «SteamID подтверждён входом через Steam» (SteamID confirmed by Steam sign-in) or «SteamID не подтверждён» (SteamID not confirmed).
- Public application page: the «Войти через Steam» (Sign in with Steam) link — after signing in, the application is submitted for the user's own SteamID64 and marked as confirmed. Messages for 409 (a hint to sign in through Steam) and 403 (SteamID64 does not match the account).

## 2026-09-28 — Audit #60: CSP with nonce, API failures, modal windows, matches

### Security

- `Content-Security-Policy` is built in `src/middleware.ts` on every request: `script-src 'self' 'nonce-<n>'` without `'unsafe-inline'`. The root layout renders all pages dynamically so that Next.js puts the nonce on its inline scripts. `next.config.mjs` no longer sets the CSP.

### Fixed

- `apiFetch` limits a request to `API_TIMEOUT_MS` (10 s) and throws an `ApiError` with the status. `getSession()` returns `null` only on 401/403; an API failure shows the root error boundary «Панель недоступна» (Panel unavailable) rather than the sign-in screen.
- A finished match without a winner in «Последние матчи» (Recent matches) is labelled «Неизвестно» (Unknown) instead of «В процессе» (In progress).
- `Modal`: the close button and Escape keep working after the owner rejected the close (for example, while a backup restore is in progress); the dialog no longer closes by itself when `open = true`.
- The match list and the map widget refresh when a match starts and ends via `server.events.appended`. The API never published `match.started`/`match.ended` frames; the `test/live-bus-parity.test.ts` test prevents the web `LiveEvent` union from declaring types that do not exist in the API.
## 2026-09-28 — Player card: audit fixes (#81)

### Fixed

- «Доказательства» (Evidence): publication statuses arrive together with the list (no per-file request); while a publication is queued or uploading, the status refreshes itself (every 15 s, for at most 10 minutes), and «Опубликовать» (Publish) is visible only to users with `can_manage_media`; a 403 denial names the missing permission.
- «История модерации» (Moderation history): «Показать ещё» (Show more) loads older actions, and the counter marks an incomplete list with «+»; «Открепить» (Unpin) asks for confirmation and refreshes «Доказательства» (Evidence).
- «Заметки» (Notes): edits and deletions by other moderators arrive in real time, and a note created during the first load no longer disappears; send, edit and delete errors are labelled separately, and «Повторить» (Retry) is offered only for a load error.
- Nickname ban, «Пожаловаться» (Report), VIP subscription, «Голосования» (Votes), Steam friends check: transient failures no longer hide the block permanently — they are shown with «Повторить» (Retry); «Голосования» is hidden on 401/403 like the neighbouring sections.
- «Пожаловаться» (Report): the server list loads when the dialog opens; attachments that were removed, and attachments of a cancelled report, are deleted from the media library; send errors are shown in Russian.
- «Присутствие» (Presence): «Наиграно» (Time played) does not show 0 while loading or on error; «Повторить» (Retry) can no longer overwrite the data of the selected period; the «Бонусы» (Bonuses) tile is renamed «Взвешенное время» (Weighted time) with a formula supplied by the server; prime-time hours are no longer buttons.
- «Часто играет с» (Often plays with) requests exactly 10 partners without a per-server breakdown.
- The type of the last moderation action, the «VIP-подписка» (VIP subscription) source in the bonus history, and subscription-grant errors are shown in Russian.
- Date filters in the bonus and chat history count days in the browser's time zone, like the displayed time.
- API responses for the sections are validated before rendering; an invalid response is shown as an error instead of crashing the card. The player identifier in the URL is validated as a UUID, and API path segments are encoded.

## 2026-09-30 — Web component audit (#89)

### Changed

- The whitelist portal explains a `429` response in Russian: «Слишком много заявок с этого адреса. Попробуйте позже.» (Too many applications from this address. Try again later.).
- `Admins.cfg` drift banner: polling stops after `401/403/404` and skips ticks on a hidden tab; a failed «Синхронизировать» (Sync) shows an error (including in the «недоступен» (unavailable) banner), and the refresh timer is cleared on unmount. An unreachable hash comparison was removed.
- A server announcement substitutes the server name into `{server}`; templates with `{player}` are not offered in a general announcement. `BroadcastComposer` gained a `serverName` prop.
- A direct message to a player shows a Russian explanation instead of the raw API error code.
- «Повторить» (Retry) in the player dossier goes through the same effect as a filter change, so the request with stale parameters is cancelled.
- «Логи» (Logs): a first-load error shows a banner with «Повторить» (Retry) instead of an endless skeleton; the «Экспорт» (Export) button is visible only with the `host:metrics` permission (`canExport` prop); entry times are shown in the operator's time zone.
- Sign-out: an unsuccessful `/api/v1/auth/logout` response leads to `/login?error=logout_failed` with a warning and without auto-redirecting into the panel; a network failure no longer causes an unhandled rejection.
- `MetricsChart`: `maxY` is the lower bound of the scale; values above it no longer go outside the chart.
- `PlayerMarks`: the mark-type directory is loaded once; a late response for the previous player does not overwrite the new player's marks.
- `ServerBar` recreates its `ResizeObserver` only when the bar appears and disappears.
- `TagInput` limits the tag length (`maxTagLength`, 50); the server settings page rolls back the tags and shows an error if the API rejected the save.
- `UpdateProgressModal` drops WebSocket frames without a text `message`.
- The connection banner redirects to `/login` on `401` and stops polling after unmount.
- The host metrics packing format is taken from `@squad/shared-config/metrics-pack`; the upload MIME type list comes from `@squad/shared-types`.

### Removed

- The unused `RoleEditor` component and its tests; the artificial `void rolePermissions` was removed from the API.

## 2026-09-27 — Whitelist does not replace other roles (#8)

### Changed

- Player card, the «Whitelist» block: the «В whitelist» (To whitelist) button is shown for a player without a role. If the player already has another role, a user with the role-management permission first confirms the role replacement by its name, while others see which role the player has. There is no button for the panel owner.
- «Настройки → Whitelist» (Settings → Whitelist): the whitelist role and the role used when approving an application can be chosen only by a user with the role-management permission. Others approve the application with the whitelist role. Denial errors and new skip reasons for import rows are shown in Russian.

## 2026-09-27 — Depot update and server installation

### Changed

- The `/servers/new` wizard explains in Russian the `409 depot_update_in_progress` refusal from `POST /api/v1/servers/:id/install`: the server is created, but the installation is not started while the game files are being updated (#20). Previously only `HTTP 409` was shown.
- «Обновить» (Update) in the server settings explains the `409 servers_running` refusal (#20).

## 2026-09-27 — Next.js and sharp update

### Security

- `next` raised to `^15.5.26` (fix for GHSA-2xp9-vwfh-vxw4 from 15.5.24), the `sharp` override raised to `^0.35.5` (GHSA-rgj7-g3m4-5g8c). See #22.
- The Next image optimizer is disabled (`images.unoptimized: true`): the panel does not use `next/image`, so the `/_next/image` endpoint is no longer served. Verified by `test/image-optimizer.regression.test.ts`.

## 2026-09-27 — Squad creator crowns

### Added

- In «Игроки онлайн» (Players online), a squad creator's crown appears after the squad leader star. Grey: the player created the squad and handed over command while staying in it. Red: left the squad or the server while being its leader (red takes precedence over grey). The tooltip lists the squads line by line, for example «Создал отряд "Alpha" в 21:04, передал командование: Ivan (21:10)» (Created squad "Alpha" at 21:04, handed over command: Ivan (21:10)).
- The event log labels `squad.created`, `squad.leader_changed` and `squad.disbanded` as «Отряд создан» (Squad created), «Смена командира отряда» (Squad leader changed), «Отряд распущен» (Squad disbanded).

## 2026-09-16 — Sign-in through Steam

### Changed

- `/login` and `/setup` again lead to «Войти через Steam» (Sign in with Steam); the user menu and the `/me` header no longer link to bss.games, and the global sign-out ends only the panel sessions.
- The «Интеграция SquadJS» (SquadJS integration) section reads `GET /api/v1/servers/:id/rnsquadjs` and always shows the RNSquadJS engine.

## 2026-09-08 — Live player list without a timer

### Changed

- «Игроки онлайн» (Players online) no longer polls the API on a timer. The list is driven by the event bus: worker-rcon publishes `rcon.roster` right after refreshing the roster (now every 5 seconds instead of 30), and a row appears as soon as the player joins. The only out-of-schedule re-reads are returning to the tab and restoring the bus after a disconnect, when events were lost.

## 2026-09-08 — Roster at the top of the page, live updates, auto-pick map history

### Added

- The «Голосование за карту» (Map vote) page gained an «История изменений» (Change history) card: who changed what and when, the version fingerprint and a rollback button. This is the same version history as in the config editor. If a version has a layer that disappeared from the catalog, the screen names it and offers «Откатить без них» (Roll back without them).

### Changed

- The «Игроки онлайн» (Players online) block is moved to the very top of the server page — above the status and the map; only incident banners remain above it.
- The squad's «закрыт» (locked) label is replaced by a red lock with a caption in the tooltip and for the screen reader: in a column half a page wide, the squad name matters more.
- The list header lost the "updates every 30 seconds" caption and the shared «Выделить всех» (Select all) checkbox. Instead of the caption there is a data-age indicator, as on the status card; selection remains in the squad header. The fallback poll is sped up from 30 to 10 seconds; the main path is the bus event right after the server poll.

### Removed

- The «Сид-календарь» (Seed calendar) page is removed together with its tab. The seeding schedule API, the scheduler tick and the overlap warnings in the rotation calendar are untouched.

## 2026-09-07 — Players online in two columns by team

### Changed

- The «Игроки онлайн» (Players online) block on the server page now looks like the squads screen in the game: two columns, one per team, with the faction name and player and squad counters in the header. Inside a column, the command squad comes first, then squads by number, with players without a squad at the end; the squad header shows its number, name, the «закрыт» (locked) label and its fill level `n/9`. The leader always goes first in their squad, with a star next to the name. Both columns are always present, even while one of the teams is empty; players without a team are shown in a separate block below the columns. Below 1280px the columns stack on top of each other.
- The SteamID64 and EOS ID columns were removed from the table — there is no room for them at half width; both identifiers remain in the player name tooltip and in the dossier. The kit from the role is shown next to the name (`USA_Rifleman_01` → «Rifleman»). The «Выделить всех» (Select all) checkbox moved to the card header.

## 2026-09-07 — Log source of an external server

### Added

- In the external server settings, the «Источник логов (SSH)» (Log source (SSH)) section: host, port, user, path to `SquadGame.log`, a read toggle, the tail state (reading / connecting / error) and the panel public key for `authorized_keys`; the «Перевыпустить ключ» (Reissue key) and «Удалить источник» (Delete source) buttons.

## 2026-09-05 — Connecting an existing server over RCON

### Added

- The `/servers/new` wizard gained a «Установить на этом хосте / Подключить существующий» (Install on this host / Connect existing) switch. The second mode is a form for the RCON address, port and password plus the A2S and game ports; it sends `POST /api/v1/servers/external` and immediately opens the server page, without an install step.
- In the external server settings, the «RCON-подключение» (RCON connection) section (`PUT /external-connection`); leaving the password field empty keeps the stored one.

### Changed

- An external server is marked with the «внешний» (external) badge in the list and in the section header. It has no «Старт/Стоп/Рестарт/Обновить игру» (Start/Stop/Restart/Update game) buttons, CPU/RAM tiles, container log or log files; instead it shows the RCON address and the A2S port. The «Конфиги» (Configs), «Ротация» (Rotation), «Календарь ротации» (Rotation calendar) and «Мониторинг» (Monitoring) subsections are hidden, as are the «Сеть» (Network), «Ресурсы» (Resources), «Архив логов» (Log archive) and «Лицензия» (License) sections in the settings.
- The server list button is renamed from «Установить новый» (Install new) to «Добавить сервер» (Add server) — there are now two ways.

## 2026-09-03 — The target of an entry in «Последних действиях» (Recent actions) is no longer blindly truncated

### Fixed

- The dashboard truncated the `target_id` of any log entry to eight characters, so `host · localhost` was shown as `host · localhos`. Now only UUIDs are shortened to eight characters; other identifiers (`localhost`, `days:30`, `1`) are shown in full, and long ones are still cut off by CSS with the full value in `title`.

## 2026-09-01 — Seamless transition between the site and the panel (#299)

### Changed

- `/login` checks for an existing session and, if there is none, redirects the user once to the unified sign-in at `bss.games`. After an error, an explicit retry button remains, with no endless redirects.
- The direct button and the Steam routes were removed after production acceptance. The moderator menu and the self-service header gained a link to the site, a panel-only sign-out and a global sign-out from the site and the panel.
- The global sign-out accepts a return address only from the panel API; the client does not trust an address from the request. Session-management targets are at least 44 pixels tall.

## 2026-08-30 — «Аккаунт» (Account): statistics first, full width, no server selection

### Changed

- `/settings/account` is no longer squeezed into the `reading` column (768px) of the
  «Настройки» (Settings) section. The route was moved into the `(account)` group —
  `app/(dashboard)/(account)/settings/account/` — the address is the same, but the settings
  shell no longer wraps it, and the page itself takes `PageContainer
  width="full"`. Reason: it now holds weapon, vehicle and match tables
  that a narrow column cramps; the other two dozen «Настройки» (Settings) screens
  stay on `reading`, as decided in their layout.
- Block order: game statistics and recent matches now come above the profile.
  SteamID64 and the number of keys are reference information that is looked at once in a lifetime.
- `DossierSection` accepts `serverFilter` (default `true`). On the user's own
  page it is `false`: one's own in-game statistics are computed across all servers
  at once, and a server selector there is a superfluous control. The request for the
  server list is not sent at all in this mode. On the player card the selector stays —
  an admin needs it.

## 2026-08-25 — Own in-game statistics on the «Аккаунт» (Account) page

### Added

- The `/settings/account` page shows the player their own in-game
  statistics: the «Игровая статистика» (Game statistics) block (the same tabs «Скилл» (Skill), «Оружие» (Weapons),
  «Техника» (Vehicles), «Киты» (Kits), the K/D trend and «Уничтожено техники» (Vehicles destroyed) as on the player
  card) and «Последние матчи» (Recent matches). Both blocks read the routes for their own
  `player_id` from `GET /api/v1/me`; the dossier lets the session owner through without
  `combat:view`, while the match summary was already open to anyone who has
  panel access.
- The «Онлайн» (Online) tile in the «Скилл» (Skill) tab — time on servers for the selected period
  (`skill.online_seconds`), the twelfth one. Format `Nч Nм` (N h N m).

### Changed

- `DossierSection` and `RecentMatchesSection` with all their plumbing
  (`DossierSkillTab`, `DossierWeaponsTab`, `DossierVehiclesTab`,
  `DossierKitsTab`, `DossierSkillChart`, `dossier.ts`, `recent-matches.ts` and
  their tests) moved from `app/(dashboard)/all-players/[id]/` to
  `src/components/`. Files next to a route belong to that route: a second
  consumer would have had to import them through `(dashboard)/all-players/[id]`,
  which nobody in this app does.
- `DossierSection` accepts an optional `title` (default «Досье» (Dossier)):
  on the user's own page the section is called «Игровая статистика» (Game statistics), not «досье» (dossier).
- `formatKitTime` was renamed to `formatPlayTime` — it formats not only
  kit time but also time on the server.
- Empty states of the dossier tabs no longer speak about the player in the third person
  («…этого игрока» (…this player), «…с его участием» (…involving them)): on the user's own page this read as
  text about someone else. Whose section it is is already stated in the heading.

## 2026-08-25 — Panel in Russian only: the language switcher removed

### Removed

- `LocaleSwitch.tsx` and `LocaleSwitch.test.tsx` — the RU/EN buttons that
  `TopNav.tsx` and `/login` showed in the right corner. The panel never
  offered switching the language to two different audiences at once, so
  the choice itself was superfluous.
- `apps/web/src/i18n/dictionaries/en.ts` and the `localeSwitch.*` keys in
  `ru.ts` — the English dictionary and the switcher captions had no
  consumers without `LocaleSwitch`. `ru.ts` remains the only dictionary and
  the source of truth for the `t()` keys.
- `apps/web/src/i18n/server.ts` — read the `locale` cookie only for the root
  layout; after `<html lang="ru">` became a constant, it
  had no callers left.
- `apps/web/src/i18n/config.ts` collapsed to a single locale: `LOCALES = ['ru']`,
  `LOCALE_COOKIE`/`isLocale`/`resolveLocale` were removed as code without consumers.
  `<html lang="ru">` no longer depends on the `locale` cookie — an old
  `locale=en` cookie in the browser now simply means nothing. `INTL_LOCALE` and
  `useIntlLocale()` (added the day before for date formatting) stay:
  they are now a one-value map, `ru` → `ru-RU`.
- `vehicleDisplayName()` in `all-players/[id]/dossier.ts` lost its `locale`
  parameter — the player dossier always shows `name_ru`, falling back to
  `name_en`, then to `asset_id`; `DossierVehiclesTab.tsx` no longer reads
  `useLocale()`.

## 2026-08-24 — Dates in the panel locale and honest states of the host card

### Fixed

- Dates were printed in the browser locale, not the panel's: the players table showed
  `8/23/2026, 11:35:00 AM` in the Russian interface, and the complaints queue, two clicks away,
  showed `22.08.2026, 03:33`. The culprits were 24 calls to `toLocaleString()` and its
  relatives without a locale argument in 14 files; the format also depended on the
  machine and the ICU version. Everything was switched to `DateTime` / `formatAbsolute` with the tag
  from the new `useIntlLocale()`.
- The «Хост» (Host) card on the dashboard promised metrics that would never come: while
  `panel-host-bridge` was down, it spun four endless skeletons
  «загружаем метрики» (loading metrics) and the caption «Загружаем сведения о хосте…» (Loading host details…). Now
  agent unavailability is distinguished from waiting for data and explained in text.
- The «Серверы» (Servers) card was set to `h-full` and stretched to match the neighbouring
  host card — three table rows and three hundred pixels of emptiness below them.

### Added

- `useIntlLocale()` (`src/i18n/LocaleProvider.tsx`) and the `INTL_LOCALE` map
  (`src/i18n/config.ts`): interface locale → BCP-47 tag for `Intl`
  (`ru` → `ru-RU`, `en` → `en-GB`, not the American `en`).
- `formatClock()` — only the time of day in the same 24-hour format, for
  columns where the date carries no information.
- `src/i18n/date-locale.regression.test.ts` — scans the sources and fails
  the build if a formatting call without a locale comes back.
## 2026-08-24 — «Аккаунт» (Account) page: cleanup and the nickname in the header

### Fixed

- The «Устройство» (Device) column in the sessions table showed `Mozilla/5.0 (KHTML, like
  Gecko)` in all rows at once: the greedy `.*` in the User-Agent parsing regex
  consumed the string up to the last parenthesis, and for any Blink-based browser that is
  `(KHTML, like Gecko)`. The column exists to
  tell sessions apart, and it told none apart. The parsing was rewritten to
  a «browser + platform» pair (`Opera 134 · Linux`, `Claude · Linux`).
- The number of access keys is now inflected correctly in Russian: it was «53 ключей», now it is
  «53 ключа» (the correct plural form of "keys"). The form comes from `Intl.PluralRules`.

### Changed

- The «Идентификатор игрока» (Player ID, an internal UUID) and
  «Имя» (Name) rows were removed from the «Профиль» (Profile) block: the nickname moved to the right edge of the page header, next to it is the nickname
  change history behind the «ещё N ников» (N more nicknames) button (a modal window). The data comes from the new
  `GET /api/v1/me/names`.
- The liveness indicator and the «Выход» (Sign out) section were removed from the page. Sign-out stays in the user
  menu in the panel header (`TopNav`), so the way to sign out is not lost.
- User-Agent parsing, numeral inflection and the choice of the displayed nickname were moved
  into `settings/account/helpers.ts`, following the sibling pages of the section: they were
  unreachable for tests inside `page.tsx`.


## 2026-08-22 — Redesign: the panel is built from Apple HIG primitives

### Added

- `docs/components/web/design-system.md` — the layout contract: five typography
  steps from a base of 13px, an 8-point grid, four permitted content widths,
  three surface levels, colour only as state, minimum
  tap targets, mandatory screen states, rules for tables and grouped
  lists.
- `apps/web/src/components/ui/` — 24 primitives that implement these rules:
  the page shell (`PageContainer`, `PageHeader`), cards, buttons, tables,
  a toolbar with search and pagination, screen states (`Skeleton`,
  `EmptyState`, `InlineBanner`), modal windows, fields and grouped lists,
  segmented controls, menus, badges, metric tiles, a single time format
  and a vector icon set. The primitives do not read the translation dictionary —
  all human-readable text arrives through props.
- Loading and error screens for the panel, the public part and the personal account
  (`loading.tsx` / `error.tsx` in every route group) and a
  «страница не найдена» (page not found) page. Previously an exception in a server component showed the
  Next.js system screen in English and with no way back.
- A showcase for the «Настройки» (Settings) section (`/settings`): the twenty pages of the section
  existed only as dropdown menu items, and the `/settings` address
  opened nothing.
- The shell of the «Сервер» (Server) section (`servers/[id]/layout.tsx`): the server name as the
  section's only `<h1>` and segmented navigation across subpages
  instead of nine text links with arrows. The route
  `/servers/[id]/combat-log` existed, but nothing linked to it.
- Direct actions on a player in the server's live roster. To kick a single
  person, the operator went through a bulk scenario of six to seven steps.

### Changed

- All panel pages were moved to the primitives: one width instead of five,
  one page heading instead of nine variants, sticky table headers with
  number alignment, a single filter bar, skeletons instead of a
  «Загрузка…» (Loading…) line, empty states that distinguish «ничего нет» (nothing here) and «фильтр ничего не
  нашёл» (the filter found nothing).
- English column headers in Russian tables were translated (Total playtime,
  Last seen, Created, Actor, Hits, Slug, Permissions). Technical
  identifiers — SteamID64, EOS ID, RCON, CIDR, URL, SHA-256 — were kept.
- The top bar dropdown menus became real `role="menu"` menus: arrows,
  Home/End, type-ahead search, Escape with focus return. The command palette is a
  combobox with an `option` list and `aria-activedescendant`.
- Toasts were consolidated into one area: three of them pinned themselves to the
  bottom-right corner and covered each other.
- The server switcher strip sticks below the top bar; the height of all
  sticky chrome is published as the `--chrome-h` variable, from which the table
  headers are offset.

### Fixed

- There was no focus trap in any modal window of the panel: `aria-modal`
  was declared, but focus was not held, Escape worked in twelve files out of
  thirty-eight, and focus was not returned to the trigger anywhere. All dialogs
  were moved to the native `<dialog>`.
- The bulk moderation dialog destroyed the entered reason on a click outside the panel;
  the update dialog closed in the middle of a running operation.
- 29 native `confirm()` calls were replaced with dialogs that name exactly what
  will happen; irreversible host operations require typing an exact string.
- The helper text `text-neutral-600` (#78787D) gave 3.87:1 against the page
  background — below the AA threshold — and was used 121 times for semantic states.
  The placeholder was coloured at 2.5:1, although for 108 fields it was the only label.
- The sticky table header slid under the server strip on the dashboard, servers,
  statistics, matches and chat.
- `MetricsChart` stretched the SVG via `preserveAspectRatio="none"`, so that
  the shape of the curve did not match the data.
- All-caps was removed from semantic headings: 340 occurrences → 33 (the service
  labels above values remain). Font sizes below 11px were removed entirely (144 occurrences
  `text-[10px]` → 0).

## 2026-08-22 — Redesign: Apple HIG palette and top navigation

### Changed

- The panel's colour scheme was moved to Apple system colours in the dark
  variant. The surfaces are systemGray6/5/4 (`#1C1C1E` / `#2C2C2E` / `#3A3A3C`)
  instead of near-black `#0A0A0A`: white text on `#1C1C1E` gives 17:1 instead of
  21:1, which is noticeably easier on the eyes over a whole shift. The accent is high-contrast systemBlue
  `#409CFF` (4.9:1 on a card; the regular `#0A84FF`
  gave 3.8:1 and did not pass AA for small text), the states are
  systemGreen/Orange/Red in the same variants.
- The tokens in `apps/web/src/styles/globals.css` are defined in two layers:
  semantic (`bg`/`surface`/`raised`, `ink*`, `accent`, `good`/`warn`/
  `crit`) for the new interface, and an override of the stock Tailwind scales
  (`neutral`/`sky`/`emerald`/`amber`/`red` plus categorical shades).
  The panel has ~6200 colour classes across 79 pages written through the stock
  scales — retargeting recolours the whole interface at once without touching
  the page markup. Both layers give identical colours.
- Hardcoded chart colours (recharts, hand-written SVGs, the server palette
  in `lib/server-color.ts`) were moved to the same values — CSS variables do not
  reach them. The Steam and Discord brand colours were left as they are.
- The Inter and JetBrains Mono fonts are loaded locally via `@fontsource`,
  without contacting Google Fonts: the panel must look the same on a host
  without internet.

### Added

- `TopNav.tsx` — a top navigation bar 46 px high instead of a side menu
  224 px wide. Top-level items: «Дашборд» (Dashboard; a direct link),
  «Серверы» (Servers), «Игроки» (Players), «Инструменты» (Tools), «Сообщество» (Community), «Аудит» (Audit), «Настройки» (Settings).
  Sections with several columns expand into a mega menu anchored to the
  bar rather than to the button. Menus open on click and close on Escape,
  a click outside the bar, and on navigation. It contains a search field (opens the command
  palette), the user menu, `LogoutButton` and `LocaleSwitch`.
- `ServerBar.tsx` — a server switcher below the bar: one chip per server with
  status and current online count, only on `/dashboard`, `/servers`,
  `/statistics`, `/matches` and `/chat`. Data from `GET /api/v1/servers`,
  updated by live bus events.
- `/servers` and `/servers/new` were added to the navigation; the side menu
  did not link to them at all.
- `openCommandPalette()` in `lib/commandPalette.ts` — a DOM event by which the
  top bar opens the palette: both components are client components and siblings under the
  server layout, so they cannot share state directly.

### Removed

- `SidebarNav.tsx` and the `nav.brand` localization key (the top bar does not
  draw a brand). All permission checks, the economy gate, the localization keys and the live
  complaint counter were moved into `TopNav` without loss.

## 2026-08-11 — A clear role assignment expiry (#268)

### Changed

- Both role assignment forms use the shared `RoleExpiryDateField`: instead of
  a `datetime-local` with hours and a date order that depends on the browser language, the field
  always shows `ДД/ММ/ГГГГ` (DD/MM/YYYY) and opens the native calendar when pressed anywhere in the
  visible area.
- The selected date is stored as the end of the same UTC day
  (`23:59:59.999Z`), so the day is included in full and is returned to the
  form stably. An empty value still means a permanent role.
- The comment is labelled as an optional grant reason visible to other
  administrators. The `/users` modal and the player card use the
  same text and behaviour.

## 2026-08-04 — Live progress for the depot-update flows

### Added

- New `UpdateProgressModal` (`apps/web/src/components/UpdateProgressModal.tsx`) — connects to the shared `GET /api/v1/depot/progress/ws` (see the `api` changelog's matching entry) and streams lines into the existing `LogConsole`, mirroring the WS-into-`LogConsole` pattern the install wizard (`servers/new/page.tsx`) already used. Ignores any `done` frame received before the server's `{backfill_complete:true}` marker — it belongs to a previous, already-finished run replayed as history, not the one just watched.
- Wired into the server detail page's "Обновить игру" (Update game) button (`servers/[id]/page.tsx`): the button previously showed "Обновление..." (Updating...) for only the instant its `POST` took to return, then silently reverted while the real update kept running for minutes. It now opens the progress modal on a successful start and stays labeled/re-openable ("Обновление... (открыть лог)", i.e. Updating... (open log)) until the run's terminal frame arrives, even if the modal itself is closed and reopened.
- Wired into the fleet dashboard's `DepotUpdateModal` flow (`dashboard/page.tsx`): starting an update now opens `UpdateProgressModal` instead of just closing the selection dialog with no further feedback.

### Fixed

- `dashboard/page.tsx`'s `DepotUpdateModal onStart` handler posted `{stop_server_ids: serverIds}` to `POST /api/v1/depot/update`, but the route's Zod schema reads `server_ids` — the modal's "these servers will be stopped" checkboxes had no effect on the actual request; the depot update always ran with an empty `server_ids: []`, so operators who checked servers to protect them were not being protected. Also now surfaces a non-200 response as a thrown error instead of proceeding to show progress for an update that never started.

## 2026-07-27 — VIPSUB-5 removal of `/no-access`, panel guard on `(dashboard)` (#171)

### Added

- Panel-access guard in `apps/web/src/app/(dashboard)/layout.tsx` — a session whose `me.permissions` array is empty is redirected to `/me` instead of rendering the admin shell. `GET /api/v1/me` is a `selfService` route, so `requireSession()` succeeds for a `self_service` session too; `/` already sent such a player to `/me` (`apps/web/src/app/page.tsx`), but that covered only the post-login hop — typing a `(dashboard)` URL by hand would otherwise render the sidebar around content every panel-gated route answers `401` for. The check is the same one the root page makes: `derivePanelPermissions` hands the whole non-gated catalogue to anyone with `panel_access`, so an empty set proves its absence. It sits deliberately **outside** the `GET /api/v1/setup/status` try/catch, because `redirect()` aborts by throwing and that bare `catch` would swallow it.
- `apps/web/src/app/(dashboard)/layout.test.tsx` — two cases pinning the guard: a session with `permissions: []` throws `NEXT_REDIRECT` and calls `redirect('/me')`, a session holding `servers.view` renders. The `next/navigation` mock now throws like the real `redirect`, otherwise the guard would fall through and the assertion would pass for the wrong reason.

### Removed

- `apps/web/src/app/no-access/page.tsx` and `page.test.tsx` — the page became unreachable with VIPSUB-5 (#171): every successful Steam login now gets a session, `panel`-scoped with a redirect to `/` when the role has `panel_access` and `self_service`-scoped with a redirect to `/me` when it does not (a player with no role at all included). Nothing produces `/no-access?steam_id64=…&reason=no_role|role_no_access` any more.
- All `noAccess.*` keys from `apps/web/src/i18n/dictionaries/ru.ts` and `en.ts` — «Доступ запрещён» (Access denied), «Steam ID {steamId} не имеет роли в этой панели.» (Steam ID {steamId} has no role in this panel.), both `reason` variants with their hints, the `.first-owner-claimed` Owner hint and the «Вернуться на страницу входа» (Back to the sign-in page) link had no consumer left. `i18n.test.ts` interpolates `login.error.notAuthorized` instead, which carries the surviving `{steamId}` placeholder.
- `apps/web/e2e/no-access.spec.ts`, plus the route's cases in `apps/web/test/pages-graph.test.ts` and `apps/web/test/pages/auth.test.ts`.
## 2026-07-27 — DISCORD-5 the «Синхронизация ролей» (Role sync) section (#152)

### Added

- `apps/web/src/app/(dashboard)/settings/integrations/discord/DiscordRoleMappingsSection.tsx` — «Синхронизация ролей» (Role sync) on `/settings/integrations/discord`, over `GET/POST/PATCH/DELETE /api/v1/integrations/discord/role-mappings`. A table of panel role → Discord role id with an inline enabled/disabled toggle and «Удалить» (Delete), a create form (role `<select>` from `GET /api/v1/roles` × a snowflake field), and «Синхронизировать сейчас» (Sync now) on `POST …/role-mappings/reconcile`. The role select hides the system `Owner` role and any role that already has a mapping, since the API enforces one mapping per role.
- A red banner rendered from the `status` the list route returns: `roleSyncStatusText` (exported for tests) gives the missing-`Manage Roles` case its own Russian wording because it is the one failure an operator can fix, and falls back to the worker's message for anything else. This is the UI half of DISCORD-5's "no silent failure" criterion.
- The section self-hides on `403` — `GET /api/v1/me` exposes no `can_manage_integrations` boolean, so the permission rule is not duplicated client-side.
## 2026-07-27 — VIDEO-4 publishing media to YouTube/Telegram (#160)

### Added

- `apps/web/src/app/(dashboard)/players/[id]/MediaPublishControl.tsx` — «Опубликовать» (Publish) on each evidence item: pick the destinations, `POST /api/v1/media/:id/publications`, then per-destination status and the external link once published. `can_manage_media` is not exposed by `GET /api/v1/me`, so the control **self-hides on a 403** from the publications endpoint instead of reading a capability flag. It renders nothing for an `external_link` — there is no local file to upload, and the API would answer `not_a_stored_file`. Mounted from `EvidenceSection.tsx`.
- `apps/web/src/app/(dashboard)/players/[id]/media-publications.ts` — pure helpers with their own unit tests: `destinationLabel`, `publicationsUrl`, `isPublishable`, `statusLabel`, `publicationErrorLabel`. `statusLabel` splits the API's single `queued` state three ways («ждёт квоту YouTube» (waiting for YouTube quota) / «повтор запланирован» (retry scheduled) / «нет настроек интеграции» (no integration settings)); an operator watching «в очереди» (queued) for six hours otherwise cannot tell which is happening. An unrecognised error code is shown verbatim rather than swallowed.
- `apps/web/src/app/(dashboard)/settings/integrations/media/page.tsx` — «Публикация медиа» (Media publishing) settings page: connection status for both destinations (presence only, since the API returns booleans and never values) and the «освобождать локальный файл» (free the local file) switch, which keeps showing its stored value if the `PATCH` is rejected rather than pretending it moved. Registered in `nav.ts`, both i18n dictionaries, `test/pages-graph.test.ts` and `test/pages/settings.test.ts`.

## 2026-07-27 — MOD-3 moderation history with evidence on the player card (#60)

### Added

- `apps/web/src/app/(dashboard)/players/[id]/ModerationHistorySection.tsx` — «История модерации» (Moderation history) section on `/players/{id}`, the first UI consumer of `GET /api/v1/players/:playerId/moderation-actions`. Each entry shows the action type as a coloured badge, the reason, the author (panel user or worker system label), the server and the time, plus an «отменено» (cancelled) marker on a reverted action. The media evidence attached to an action renders inline: images and video through the Range-streaming route (`/api/v1/media/:id/stream`, VIDEO-1 #157), external links as an anchor. The section self-hides on `401`/`403`, matching the other player-card sections.
- `apps/web/src/app/(dashboard)/players/[id]/moderation-history.ts` — pure helpers behind it: `moderationActionLabel`/`moderationActionBadgeClass` (Russian labels for the panel's `warn`/`kick`/`ban`/`unban` and the worker-issued `name_kick`/`external_ban_kick`/`external_ban.local_ban`/`clan_tag_protection`, raw value as fallback), `formatModerationDate`, `authorLabel`, `evidenceLabel`, `mediaStreamUrl`, `detachEvidenceUrl`, and `canDetachEvidence`.
- «Открепить» (Unpin) on an evidence item, calling `DELETE /api/v1/media/:id/links` (VIDEO-2, #158). It is offered **only on links the viewer created themselves**: the server also accepts someone else's link from a `can_manage_media` holder, but that flag is not exposed on `GET /api/v1/me`, so the panel cannot gate on it client-side — `canDetachEvidence` is the single place to widen once it is. A `403` from the route is surfaced rather than silently swallowed.
## 2026-07-27 — ISSUE-3 linked objects on a ticket and linked tickets on a player (#156)

### Added

- `apps/web/src/app/(dashboard)/issues/[id]/IssueLinksBlock.tsx` — «Связанные объекты» (Linked objects) on the ticket card: the expanded `links[]` from `GET /api/v1/issues/:id`, each row a type badge plus a link to `/players/{id}`, `/servers/{id}` or the media stream. A target that no longer exists renders struck-through and non-clickable. Adding a link uses the existing `PlayerSearchSelect` autocomplete for players and a plain `<select>` for servers; the server option is offered only when `GET /api/v1/servers` succeeds, because that route needs `server:view` which a tracker user need not hold. The remove button appears only for links the viewer may detach (own link, or `can_manage_issues`), mirroring the API gate.
- `apps/web/src/app/(dashboard)/issues/[id]/issue-links.ts` — pure helpers behind that block: `entityTypeLabel`, `canRemoveLink`, `linkErrorMessage` (Russian text for 403/404/409/422), `sortLinks`.
- `apps/web/src/app/(dashboard)/players/[id]/IssueLinksSection.tsx` — «Связанные тикеты» (Linked tickets) on `/players/{id}`: the counter and list of unclosed tickets naming the player (`GET /api/v1/players/:playerId/issues`), each linking to `/issues/{id}`. Self-hides on `401`/`403` and when the player has no linked ticket, matching the other player-card sections.
## 2026-07-27 — LEAD-5 the `/statistics` stats dashboard (#176)

### Added

- `apps/web/src/app/(dashboard)/statistics/` — the `/statistics` server statistics dashboard: a thin `'use client'` page over `StatisticsBrowser`, which owns a single fetch, a single `loading` state and a single `data` state, so changing the date range or the server selection redraws every chart atomically.
- Controls: date-range presets (Сегодня / Вчера / Неделя / Месяц / 30 дней / Произвольно, i.e. Today / Yesterday / Week / Month / 30 days / Custom, with two `YYYY-MM-DD` inputs for the custom range) and a server multiselect defaulting to every server. The selection is committed when the dropdown closes and then debounced by 300 ms, so a burst of checkbox clicks collapses into one request.
- Blocks: population (average online, peak online, average queue, online by hour of day, online by day of week), matches (matches per day, doughnut by mode, top combat maps), community (new players, chat messages, teamkills) and moderation (punishments, average/peak admins online). Each time-series prints a «Среднее / Максимум / Всего» (Average / Maximum / Total) KPI line computed from the same stacked values the chart draws.
- Export: a CSV link carrying the loaded window and a JSON blob download of the exact payload.
- Drill-down: clicking a bar segment offers a link into `/events`, `/chat`, `/combat-log` or `/external-bans` pre-filtered to that server and, where the destination supports it, that day (`preset=custom&from=D&to=D`). `/external-bans` parses neither filter today, so its link is deliberately bare.
- `apps/web/src/lib/server-color.ts` — deterministic `serverId → colour`, assigned by position in the **sorted** list of known server ids so a server keeps one colour across every chart and every refetch.
- `apps/web/src/app/(dashboard)/statistics/StatisticsCharts.tsx` — the recharts surface, loaded through `next/dynamic` so recharts stays out of the page's first-load bundle.
- Nav entry «Статистика» (Statistics) → `/statistics` with `nav.statistics` added to both `ru.ts` and `en.ts`.

Gating is self-hide-on-403: `GET /api/v1/me` does not expose `panelAccess`, so the page surfaces the API's refusal rather than pre-checking a capability, matching `dashboard/analytics-panel.tsx`. The clock is read in a post-mount `useEffect`, never during render, so the CSV href cannot cause a hydration mismatch.
## 2026-07-27 — VIDEO-3 public upload page via a one-time link (#159)

### Added

- `apps/web/src/app/(public)/upload/[token]/page.tsx` + `UploadClient.tsx` — session-less upload page under the `(public)` route group (the `middleware.ts` matcher does not cover `/upload`, so no session gate applies). Drag-and-drop plus a file picker over the four allowlisted formats, a progress bar with transferred megabytes and speed via `XMLHttpRequest` (the only browser API that reports upload progress), and Russian status/error copy mapped from the public endpoint's `410`/`413`/`415`/`429`/`400`. The token is never validated client-side, so an invalid link fails at upload time with the same `410` as a spent one.
- `apps/web/src/app/(public)/upload/[token]/upload-progress.ts` — pure helpers (`formatMegabytes`, `formatSpeed`, `computeProgress`, `isAcceptedUploadType`, `uploadErrorMessage`) unit-tested independently of the component.
- `apps/web/e2e/public-upload.spec.ts` — Playwright confirmation that the page renders and uploads from a browser context carrying no `__Host-sid` cookie, and that the same link then fails. Runs only via `pnpm --filter @squad/web test:e2e`; the vitest config excludes `e2e/**`.

### Changed

- `EvidenceSection.tsx` gains «Получить ссылку для загрузки» (Get an upload link; `POST /api/v1/media/upload-tokens`, pre-bound to the player being viewed), which renders the one-time URL exactly once in a read-only field because the API never returns it again. Evidence delivered through a link is labelled «загружено по ссылке, аноним» (uploaded via link, anonymous), and the section refreshes itself on the `media.uploaded` live event (ignoring events bound to a different player's card).
- `apps/web/src/lib/live-bus.ts` — client `LiveEvent` union gains `media.uploaded`, kept in lockstep with `apps/api/src/plugins/live-bus.ts`.

## 2026-07-27 — VIDEO-2 evidence section on the player card (#158)

### Added

- `apps/web/src/app/(dashboard)/players/[id]/EvidenceSection.tsx` — «Доказательства» (Evidence) section on `/players/{id}`, listing media evidence attached to the player directly or via a moderation action against them (`GET /api/v1/players/:playerId/media`). Video and image files play/render inline through the existing Range-streaming route (`/api/v1/media/:id/stream`, VIDEO-1 #157); external links open in a new tab. The section self-hides on `401`/`403`, matching the other player-card sections.

## 2026-07-26 — DISCORD-3 Discord message-template editor

### Added

- `apps/web/src/app/(dashboard)/settings/integrations/discord/DiscordTemplatesSection.tsx` — «Шаблоны сообщений» (Message templates) section on `/settings/integrations/discord`: per-event-type embed editor (title, url, description, colour, fields) over `GET/PUT /api/v1/integrations/discord/templates`, a «Сбросить к дефолту» (Reset to default) button on `POST …/reset`, and a debounced server-rendered live preview on `POST …/preview` that names every placeholder the renderer could not substitute. Gated on `integration:manage`; the section renders nothing on a 403.
## 2026-07-26 — PLAYER-6 sortable player list (#27)

### Added

- `apps/web/src/app/(dashboard)/players/helpers.ts` — pure sort/filter helpers for the list page: `nextSortState` (two-state per-column toggle with per-column first-click direction), `sortIndicator` (`↑`/`↓`/`↕`), and `buildPlayersListQuery` (emits `sort`, `dir`, and optional `filter=new`).
- **Created** column on `/players`, rendering each player's `first_seen_at` between Total playtime and Last seen.
- Sortable «Ник» (Nickname), Total playtime, Created, and Last seen headers, each a `SortHeader` button that drives `GET /api/v1/players?sort=&dir=` server-side and shows its direction indicator.
- `новые (<7 дней)` (new, <7 days) checkbox that adds `filter=new` to the list request.

The «Статус» (Status) header's client-side online sort, the `только онлайн` (online only) checkbox, and the in-memory search box are unchanged and still client-side.
## 2026-07-26 — DOSSIER-6 player dossier tabs

### Added

- `apps/web/src/app/(dashboard)/players/[id]/DossierSection.tsx` — «Досье» (Dossier) block on the player card, fed by exactly one `GET /api/v1/players/:playerId/dossier` request per (server, period) selection; switching tabs never refetches.
- Four tabs render from that single payload: `DossierSkillTab.tsx` (eleven combat KPIs, period selector, kills-vs-deaths donut and stacked month trend), `DossierWeaponsTab.tsx` (top-N weapon table with kills/damage sorting), `DossierVehiclesTab.tsx` («На технике» (On vehicles) and «Уничтожено» (Destroyed) sub-tables) and `DossierKitsTab.tsx` (kit time, longest first).
- The block self-hides on `401`/`403` because the route is gated on `combat:view`, which `GET /api/v1/me` does not report — there is no permission flag to gate on client-side.
- `skill.damage_dealt` is permanently null upstream, so the «Урон» (Damage) tile and every null damage cell render `—` titled «Источник не содержит данных об уроне» (The source has no damage data); a zero is never substituted.
- Vehicle names are localised from the `vehicle_catalog` `name_ru`/`name_en` columns via `useLocale()`; an uncatalogued row shows its raw asset id titled «Нет в каталоге техники» (Not in the vehicle catalog).
- The server selector appears only on «Скилл» (Skill) and «Киты» (Kits); «Оружие» (Weapons) and «Техника» (Vehicles) state «Пожизненно, без разбивки по серверам» (Lifetime, no per-server breakdown), matching the route's own lifetime-only aggregates.
- `apps/web/src/app/(dashboard)/players/[id]/dossier.ts` — response types, formatters, sorters and the client-side zero-fill for the months the API's `matches_played > 0` filter drops, with `dossier.test.ts` unit coverage; `DossierSection.test.tsx` covers all four tabs, the empty state, the 401/403 self-hide and the no-refetch rule.
- `DossierSkillChart.tsx` is loaded through `next/dynamic`, keeping recharts out of the curated static import graphs.

## 2026-07-25 — WL-3 whitelist application portal

### Added

- `apps/web/src/app/(public)/public/whitelist/page.tsx` — public, no-session application form (SteamID64 + message + optional contact) reading the open/closed switch from `/api/v1/public/whitelist/settings` and posting to `/api/v1/public/whitelist/applications`; renders closed / success / duplicate / error states.
- `apps/web/src/app/(dashboard)/settings/whitelist/ApplicationsSection.tsx` — review queue on `/settings/whitelist`: portal open/closed toggle + default-term, status filter, and per-application approve (role + term preset → time-bounded grant) / reject (note). Gated on `whitelist:edit` for mutations, `whitelist:view` for reads.

## 2026-07-14 — CBAN-4 local-ban action

### Added

- The player card's external-ban section now shows «Забанить локально» (Ban locally) for active records when the viewer has the Squad `ban` permission.
- The confirmation form requires a server, prefills the source/reason, accepts Squad's ban-duration syntax, and reports the successful target server inline.

## 2026-07-05 — PNOTE-2 global notes feed

### Added

- `apps/web/src/app/(dashboard)/notes/page.tsx` — new `/notes` page: cross-player admin-notes feed over `GET /api/v1/notes`. Columns: date, author (role-color dot), target player (links to `/players/{id}#notes`), note body (truncate + expand). Filter bar combines text search, target-nickname, author select (`GET /api/v1/notes/authors`), and a date range; keyset "показать ещё" (show more) pagination; "Экспорт CSV" (Export CSV) downloads the current filtered selection via `GET /api/v1/notes/export`. A "Показывать удалённые" (Show deleted) toggle appears only when the API reports `can_view_deleted`; deleted rows render struck-through with the deleting admin. Dark theme, Russian labels, mobile-friendly.
- `notes` link added to the sidebar "Управление" (Management) group.
- `NotesSection` (player card) gained an `id="notes"` anchor so the feed's target link opens the player's notes section.
- `apps/web/src/app/(dashboard)/notes/page.test.tsx` — validates the component export.

## 2026-07-05 — AN-1 dashboard analytics widgets

### Added

- `apps/web/src/app/(dashboard)/dashboard/analytics-panel.tsx` — dashboard analytics widget rendering a peak-players-by-hour bar chart, match-outcome distribution, popular maps/layers, summary stat tiles, per-server + time-window filters, and CSV/JSON export buttons. Fetches `GET /api/v1/analytics/dashboard`. Dark theme, Russian labels, accessible (single-hue magnitude bars, legend + direct labels so identity is never color-alone).
- `apps/web/src/app/(dashboard)/dashboard/analytics-data.ts` — pure presentation helpers (hour/duration formatting, outcome percentages, peak scaling, window range, query builder) with `analytics-data.test.ts` unit coverage; `analytics-panel.test.tsx` validates the component export.

## 2026-05-05 — Server settings editor page

### Added

- `apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx` — new settings editor page at `/servers/:id/settings` with three sections: Сеть (Network; network ports, disabled when server is running), Игра (Game; maxPlayers, tickrate), and Ресурсы (Resources; memory, CPU, IO resource limits). Fetches from `GET /api/v1/servers/:id`, saves via `PUT /api/v1/servers/:id/settings`.
- "Настройки →" (Settings →) link added to the server detail page header alongside existing "Конфиги →" (Configs →) and "События →" (Events →) links.
- `apps/web/src/app/(dashboard)/servers/[id]/settings/page.test.tsx` — unit test validating the component export.

## 2026-05-04 — Unit test coverage for lib utilities and middleware

### Added

- `src/lib/api.test.ts` — 9 unit tests for `apiFetch`: URL construction, headers, error throwing.
- `src/lib/dal.test.ts` — 8 unit tests for `getSession`, `requireSession`, and `SESSION_COOKIE`.
- `src/lib/live-bus.test.ts` — 8 unit tests for the SSR no-op stub returned by `getLiveBus()`.
- `src/lib/use-live-bus.test.ts` — 3 unit tests verifying hook exports.
- `test/middleware.test.ts` — 10 unit tests for `middleware` redirect logic and `config.matcher`.

## 2026-05-02 — Epic 2 Phase 2 follow-up

### Added

- `/users` page now has a search box (nickname / SteamID64) and a role filter dropdown, plus a per-row "Снять" (Remove) button (gated by `user:manage_roles`).
- Player card role widget renders read-only for users without `user:manage_roles` — they see the current role + color but no «Изменить» (Edit) / «Снять» (Remove) buttons.

### Changed

- Player card role dropdown excludes Owner and the player's current role per spec §2.6.4.
- The «Снять» (Remove) button on the player card now hits the new `DELETE /api/v1/players/:steamId/role` endpoint.

## 2026-05-01 — Epic 2 Phase 2: groups editor + members page + drift banner

### Added

- `apps/web/src/app/(dashboard)/settings/groups/page.tsx` — inline role editor. Stacked role cards with name + hex color picker + 3 access-flag switches + 21 Squad permissions in 3 columns with ⚠️ on dangerous ones. Debounced auto-save (500 ms after the last click), optimistic UI with rollback on save failure, "+ Создать роль" (+ Create role) button, ⌫ delete with confirm, "Открыть список членов" (Open member list) link, collapsible "Как это выглядит в Admins.cfg" (How this looks in Admins.cfg) preview, link to Squad wiki Server Administration.
- `apps/web/src/app/(dashboard)/settings/groups/[id]/members/page.tsx` — paginated members list per role with search by nickname/SteamID64, add-player modal with player search, remove button per row.
- `apps/web/src/components/AdminsCfgDriftBanner.tsx` — drift alert on the server detail page. Polls `/api/v1/admins-cfg/drift?server_id=...` every 30 s; when the file's managed segment hash diverges from the DB's (or the bridge is unreachable), shows a banner with a Force-sync button.

### Changed

- `apps/web/src/components/SidebarNav.tsx` — sidebar entry "Роли" (Roles) replaced with "Группы" (Groups) pointing at `/settings/groups`. The legacy `/roles` page remains in the codebase as a deprecated route but is no longer linked.
- `apps/web/src/components/RoleColorDot.tsx` — accepts hex color codes in addition to palette names; hex codes render via `style={{ backgroundColor: color }}`.

## 2026-04-27 — Sidebar redesign: grouped nav + active-route indicator

### Added

- `apps/web/src/components/SidebarNav.tsx` — client component that owns dashboard navigation. Five permission-filtered groups with uppercase tracked-out headers; active route gets a sky-400 left bar + `bg-neutral-900` row via `usePathname()`; whole group hidden when its only items are gated out.

### Changed

- `apps/web/src/app/(dashboard)/layout.tsx` — sidebar markup extracted into `SidebarNav`; the layout server component now only fetches the session and forwards `permissions` + `canonical_name`.
- `apps/web/src/styles/globals.css` — wrapped the global `a { @apply text-sky-400 ... }` rule in `@layer base` so per-component utility classes (e.g. `text-neutral-300` on nav links) actually win the cascade. Visual behaviour for plain `<a>` is unchanged.

### Removed

- The "Серверы" (Servers) link from the dashboard sidebar — the dashboard page already shows the live server table inline, so the entry was redundant. The `/servers` route still resolves; it is reachable from the dashboard "все →" (all →) CTA and from `/servers/[id]` deep links.

### Migration notes

- No env or API surface changes. `e2e/dashboard.spec.ts` continues to pass: `nav.toContainText('Серверы')` matches the new `СЕРВЕРЫ` (SERVERS) group header; `'Серверы'` is the Russian word for "Servers".
## 2026-04-28 — Playwright e2e for the disk breakdown modal

### Added

- `apps/web/e2e/disk-breakdown.spec.ts` — four-case Playwright spec exercised against the live panel via the existing `ownerPage` fixture: (1) `[data-testid="disk-card"]` click opens the `role="dialog"` named «Что занимает панель» (What the panel takes up) and renders the «Всего:» (Total:) line plus the «По типу» (By type) heading; (2) the «Обновить» (Refresh) button drives `cache_age_seconds` to 0 within 10 s, asserted via «обновлено 0 сек назад» (updated 0 sec ago); (3) pressing Escape hides the dialog; (4) clicking the backdrop hides the dialog. The spec follows the existing `apps/web/e2e/` layout (the plan's `apps/web/test/e2e/` path was a planning-only artifact — Playwright's `testDir` is `./e2e`).

### Notes

- The spec is shipped as code only — like the bridge e2e suite it gets exercised on the deployment host (or staging replica) where the live panel stack and seeded Owner cookies are available. It is NOT executed in this commit.

## 2026-04-28 — `<DiskBreakdownModal>` for the dashboard disk card

### Added

- `apps/web/src/components/DiskBreakdownModal.tsx` — controlled modal opened when the operator clicks the dashboard disk card. Props: `{ open, onOpenChange, initialData, onRefresh }`. Renders the «По типу» (By type) list (configs / saved-total / squad-depot / docker volumes / docker images / audit-archive sorted by bytes desc) and the «По серверам (saved)» (By servers (saved)) scrollable table (linked first-8-chars UUIDs to `/servers/<uuid>`). Component-private `fmt(bytes)` formats sizes in `B/KB/MB/GB/TB` with magnitude-dependent precision. Refresh button calls `onRefresh()`, which is the parent-supplied closure that hits `GET /api/v1/host/disk-usage?refresh=1`. Backdrop click and Escape close the modal.

### Changed

- `apps/web/src/app/(dashboard)/dashboard/page.tsx` — disk-card click now opens the new `DiskBreakdownModal` instead of the metric-history modal. CPU / RAM / Network cards still open `MetricHistoryModal` unchanged. New state `diskModalOpen`, new callback `refreshDiskBreakdown` that hits `?refresh=1` and updates the dashboard's polled `diskBreakdown` state in addition to returning the fresh payload to the modal. Disk card's outer `<button>` now carries `data-testid="disk-card"` for the upcoming Playwright e2e.
- `apps/api/src/routes/host.ts` — `GET /api/v1/host/disk-usage` now accepts an optional `?refresh=1` query (Zod-coerced boolean). When truthy the API passes `{ force: true }` to `bridge.panelDiskUsage()`.
- `packages/bridge-client/src/client.ts` — `panelDiskUsage(opts?: { force?: boolean })` forwards the `force` flag to the bridge as a `{ force: true }` params payload.
- `apps/bridge/internal/handlers/handlers.go` — `panelDiskUsage` decodes optional `{ force?: bool }` params; when `force` is true it skips the 5-minute cache read but still writes the fresh result back into the cache so subsequent non-force calls benefit.

## 2026-04-28 — Dashboard disk bar renders Панель (Panel) / Прочее (Other) sub-segments

### Changed

- `apps/web/src/app/(dashboard)/dashboard/page.tsx` — `DiskCard` now consumes the `diskBreakdown` prop (renamed from the prior placeholder `_diskBreakdown`). When the payload is present the card's progress track stacks two segments inside it: `Панель` (Panel) in `bg-purple-500` followed by `Прочее` (Other) in `bg-purple-300`, sized from `panel_pct` and `max(0, usedPct - panelPct)` so they always equal the total used % shown in the card title. A swatch legend below the bar shows both percentages with one-decimal precision. While `diskBreakdown` is `null` (initial load or transient fetch failure) the bar gracefully falls back to the existing single-segment threshold-tinted (emerald/amber/red) rendering and the legend is hidden.
- `ResourceCard` gained two optional props — `progressSegments` (array of `{widthPct, className}`) and `progressLegend` (array of `{label, pct, swatchClassName}`) — that toggle the segmented variant. RAM and CPU cards continue to render the original single-segment bar untouched.

### Notes

- Purple was chosen over the threshold-tinted hues to stay consistent with the existing disk-card identity (the `MetricHistoryModal` open-button hover ring is already `purple-700/40`) and to avoid colliding with the emerald/amber/red traffic-light tones used by the threshold logic. Keeping the segmented bar in a single distinct hue family means the operator can read «Панель vs Прочее» (Panel vs Other) without confusing it with «healthy vs warning».

## 2026-04-28 — Dashboard fetches /host/disk-usage in preparation for disk sub-segment

### Added

- `apps/web/src/app/(dashboard)/dashboard/page.tsx` — new `diskBreakdown` state populated by polling `GET /api/v1/host/disk-usage` every 30 s on mount. Failures are tolerated silently. The state is plumbed through `HostBlock` to `DiskCard` but not yet rendered — Task 6 will add the visual sub-segment that splits the disk bar into «панель» (panel) / «остальное» (other) / «свободно» (free).

## 2026-04-26 — Bundle F: archive UI + connection banner + live-bus client

### Added

- `apps/web/src/lib/live-bus.ts` — singleton `LiveBusHandle` for `wss://.../api/v1/ws/live` with the discriminated `LiveEvent` union mirrored from the API. Auto-pong, exponential reconnect (`[1s,2s,4s,8s,16s,30s]`), idle-close after 5 s with no subscribers.
- `apps/web/src/lib/use-live-bus.ts` — `useLiveBusEvents`, `useLiveBusState`, `useBridgeState` hooks.
- `apps/web/src/components/connection-banner.tsx` — sticky banner: red on WS loss, amber on bridge down, hidden when both healthy. Mounted in `(dashboard)/layout.tsx`.
- `apps/web/src/app/(dashboard)/servers/archive/page.tsx` — soft-deleted servers table.
- `apps/web/src/app/(dashboard)/servers/archive/[id]/page.tsx` — archive detail + per-cfg backup viewer.
- `apps/web/src/app/(dashboard)/servers/archive/[id]/restore/page.tsx` — restore wizard: slug input → POST /restore (handles 409 inline) → POST /install (WS log tail) → POST /restore-configs (summary card) → POST /start.

### Changed

- `apps/web/src/app/(dashboard)/servers/[id]/page.tsx` — delete confirm copy: «Файлы будут стёрты с диска. Бэкап `.cfg` сохранится в архиве (раздел Архив серверов).» (Files will be erased from disk. The `.cfg` backup will be kept in the archive (the server archive section).)
- `apps/web/src/app/(dashboard)/servers/page.tsx` — subscribes to `server.status` and `rcon.status` via `useLiveBusEvents` for instant row updates; REST poll dropped to 120 s focus-refetch fallback.

### Migration notes

- No env var changes. The WS URL is derived from `window.location`; Caddy already forwards the upgrade headers.

## 2026-04-25 (e2e Playwright specs)

### Added
- `apps/web/e2e/_fixtures.ts`: `ownerPage` / `unauthedPage` Playwright fixtures backed by Steam-only DB seeding (no email/password, no Steam OAuth needed in tests).
- `apps/web/e2e/helpers.ts`: Rewrote `seedOwner` / `teardownOwner` / `loginAndAttachCookie` for the new single-role RBAC model (players table, sessions table, Redis session cache). Removed dependency on the deleted `users`, `organizations`, `user_role_assignments`, `organization_members` tables.
- 7 new critical-page specs: `login.spec.ts`, `no-access.spec.ts`, `dashboard.spec.ts`, `servers-new.spec.ts`, `roles.spec.ts`, `users.spec.ts`, `player-detail.spec.ts` — 19 tests, all passing.

### Fixed
- `auth.spec.ts`: Updated for Steam-only login (removed email/password form assertions).
- `live-refresh.spec.ts`: Removed `getOrgId()` call (organizations table gone), removed `org_id` from synthetic server inserts, replaced `auth/login` probe with a direct session action, replaced `UPDATE users SET display_name` with `UPDATE players SET canonical_name`.
- `server-detail-live.spec.ts`: Updated `seedOwner` call to new signature.
- `server-logs-resilience.spec.ts`: Updated `seedOwner` call, removed `org_id` from synthetic server inserts.

## 2026-04-26 (property tests)

### Added
- Extracted `nameToSlug`, `sanitizeSlug`, and `CYRILLIC_TO_LATIN` from `page.tsx` into `apps/web/src/app/(dashboard)/servers/new/_slug.ts` so they are importable by tests.
- Property-based tests for slug logic in `apps/web/test/property/slug.test.ts` (4 properties, 100 runs each): output always matches SLUG_RE, no leading dash after sanitize, 64-char max, already-valid slugs round-trip.

## 2026-04-26

### Removed
- `/servers` page: status filter chips (`all/running/starting/stopped/ready/failed/installing/pending`). Free-text search remains. The status dot per row already conveys state at a glance, and the chips added noise without payoff. Underlying `STATUS_FILTERS` constant and `filter` state deleted.

## 2026-04-25

### Added
- `/roles` page: filterable role list with `RoleColorDot`, edit/delete actions gated by `role:edit` / `role:delete`.
- `/roles/new` page: `RoleEditor` in create mode, POST /api/v1/roles on submit.
- `/roles/[id]` page: `RoleEditor` in edit mode; read-only banner for Owner system role.
- `/users` page: panel user list (players with non-null `role_id`), `AssignModal` for role assignment via player search.
- `RoleEditor` component: full permission checkboxes grouped by category, color picker, search filter, read-only guard for Owner role.
- `RoleColorDot` component: 16-color dot for use in role tables and color pickers.
- `PanelAccessSection` on `/players/[steam_id64]`: inline role assignment with Owner confirm dialog and last-Owner guard (409 handling).
- `/no-access` landing page for authenticated users without a panel role.
- Sidebar conditional links for Roles (`role:view`) and Users (`user:view`).
- Owner role confirm dialog in `AssignModal` and `PanelAccessSection`.

### Removed
- `/setup` page removed from the route table (setup flow superseded by the first-owner auto-claim).

---

## 2026-04-20

### Added
- `/settings/account` page: profile display, active session list with individual and bulk revoke.
- `/settings/tokens` page: API token creation with scope subset picker, one-time plaintext reveal, revoke.
- `LiveIndicator` component: pulsing freshness indicator used across all polling pages.

---

## 2026-04-10

### Added
- Monaco config editor at `/servers/[id]/configs`: three-tab layout (Editor / History / Blame), dirty-tracking, optional commit message, diff viewer, restore action.
- `LogConsole` component: sticky-to-bottom log viewer with error banner and "↓ к последней" (↓ to latest) scroll pill.

---

## 2026-03-28

### Added
- Server install wizard at `/servers/new`: Cyrillic-to-Latin slug transliteration, port fields, WebSocket log tail during installation.
- `RestartBridgeButton` component: confirmation modal for `POST /api/v1/host/restart`.
- `MetricHistoryModal` and `MetricHistoryChart` components: 24-hour history charts for CPU, RAM, disk, and network metrics.

---

## 2026-03-15

### Added
- Initial dashboard page at `/dashboard`: summary cards, server table, host block, recent activity feed, connections health panel.
- `/servers` page: server list with status filter and action buttons.
- `/players` and `/players/[steam_id64]` pages.
- `/audit` page: full audit log with expandable context.
- `/logs` page: live log stream with `LogList` component.
- `LogList` component: source/level/server/text filters, pause, cursor-based polling, export.
- `LogoutButton` component in the dashboard sidebar.

## 2026-09-30 — Web component follow-up (#89)

### Changed

- The Admins.cfg drift banner shows the sync buttons only with the `admin_group:edit` permission (#765, #766).
- The metrics chart places points by time: gaps in the data are visible as breaks (#786).
- `formatDurationRu` and `formatHours` were moved into `apps/web/src/lib/format.ts` (#1350).

## 2026-09-30 — Web libraries audit (#91)

### Changed

- A role's expiry in the caption is shown as «До ДД/ММ/ГГГГ включительно (UTC)» (Until DD/MM/YYYY inclusive (UTC)): the date is always computed in UTC (#835).
- The CSP policy is the same for all pages: `img-src` is allowed for Steam avatars and `data:`, `font-src data:` and `worker-src blob:` for Monaco; client-side navigation to the «Конфиги» (Configs) tab no longer loses the font and workers (#1306, #1307).
- The live-bus reconnect uses the shared `jitteredBackoffMs` function from `ws-backoff.ts` (#838).
- The web coverage thresholds were raised to what is actually achieved: lines/statements 85%, functions 72% (#839).
- `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` are enabled in the web `tsconfig.json` (#1320).
- The Steam sign-in button was extracted into `SteamLoginLink` (#771); the unneeded `playwright` devDependency was removed from `apps/web` (#431).
