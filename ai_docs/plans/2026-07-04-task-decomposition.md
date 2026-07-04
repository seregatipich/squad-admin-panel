# Squad Admin Panel — декомпозиция на задачи

Документ преобразует спецификацию `squad-panel-spec.md` в набор самодостаточных задач с критериями приёмки и зависимостями. Каждая задача сформулирована так, чтобы её можно было отдать исполнителю (или агенту) целиком.

Нумерация: `<ОБЛАСТЬ>-<номер>`. Фаза указана в заголовке. Зависимости — по ID задач.

---

## ⚠️ Корректировки спецификации по результатам проверки фактов

Перед декомпозицией проверены ключевые технические утверждения. Следующие места спецификации **расходятся с действительностью** и в задачах ниже уже исправлены:

1. **«Squad перечитывает Admins.cfg каждую минуту» — ненадёжное утверждение.** По актуальным данным изменения Admins.cfg применяются на следующей ротации карты **или немедленно через RCON-команду `AdminReloadServerConfig`**. Вывод для задач: после каждого push'а Admins.cfg панель ОБЯЗАНА вызывать `AdminReloadServerConfig` через RCON, а не полагаться на пассивное перечитывание. (Затрагивает §2.0 шаг 5, §2.7.4 п.7, классификацию `hot_reload` в §6.2.)

2. **RCON-команды смены карты.** Актуальные команды — `AdminChangeLayer <layer>` и `AdminSetNextLayer <layer>` (категории Level/Layer после Squad 2.0+). `AdminChangeMap` — устаревшее наименование. В задачах используются актуальные команды.

3. **GeoLite2 нельзя «бандлить» в дистрибутив панели.** GeoLite2 бесплатна, но требует аккаунт MaxMind + license key (с мая 2024 — ещё и Account ID), а редистрибуция базы в составе продукта требует отдельной коммерческой redistribution-лицензии. Вывод: оператор вводит свои MaxMind Account ID + License Key в настройках панели; панель скачивает и обновляет базу через `geoipupdate`-совместимый механизм. Без ключа — graceful degradation (IP без геолокации).

4. **Формат Bans.cfg.** Реальный формат строки бана: `Banned:<SteamID64>:<unix-timestamp окончания>` (0 = перманентный), опционально с префиксом `<имя админа> [SteamID <id админа>]` и `// комментарий`. RCON `AdminBan` пишет в файл сам. Учтено в задачах модерации.

5. **SteamCMD.** Dedicated server — App ID **403240**, `login anonymous`, сам клиент игры — 393380. Linux-бинарь: `SquadGame/Binaries/Linux/SquadGameServer`. Подтверждено.

6. **RCON.** Source RCON protocol, TCP, дефолтный порт **21114**, конфиг в `Rcon.cfg`. `ListPlayers` в актуальных версиях возвращает Online IDs (EOS + steam). Подтверждено.

7. **Admins.cfg формат** `Group=<имя>:<perm1>,<perm2>` и `Admin=<SteamID64>:<группа> // комментарий` — подтверждён. Список permissions из §2.4 соответствует Squad wiki; при этом permissions в файле не валидируются сервером, и при добавлении новых permissions разработчиками файл не перезаписывается — whitelist в коде панели должен быть выносим в конфиг.

8. **RemoteAdminListHosts.cfg** — альтернативный механизм: сервер сам подтягивает admin-список по URL, формат файла тот же, permissions из нескольких списков объединяются. Добавлена опциональная задача-исследование (SYNC-9): возможно, для мульти-серверной синхронизации он надёжнее, чем push файлов.

9. **RNSquadJS** — публично подтвердить точный репозиторий/Mongo-схему не удалось (экосистема: SquadJS, SquadStatJS, SquadStatsJSPRO, MySquadStats и пр.). Задача STATS-1 переформулирована как обязательное исследование с фиксацией версии (pin tag) до любой имплементации.

10. **SquadJS** (Team-Silver-Sphere/SquadJS) — зрелый открытый референс парсинга SquadGame.log и RCON-обвязки. В задачи парсинга добавлено требование сверять регэкспы с актуальными парсерами SquadJS, а не выводить с нуля.

---

# WS-0. Фундамент (предусловие для всего P0)

### INFRA-1. Скелет проекта и docker compose [P0]
**Что сделать:** Монорепо: `api` (backend), `web` (frontend), `bridge` (агент на хосте), `workers` (config-sync, log-ingest, rcon), миграции БД. Docker compose: PostgreSQL 16+ (с pg_partman), Redis 7+, api, web, workers, опциональный профиль GlitchTip. One-command deploy: `docker compose up -d`. Uninstall-скрипт с полной очисткой volumes и `/var/lib/squad-panel`.
**Критерии приёмки:** чистая Ubuntu 24.04 → `git clone && docker compose up -d` поднимает панель; `docker compose --profile glitchtip up` поднимает error tracking; uninstall-скрипт удаляет всё и идемпотентен.
**Зависимости:** нет.

### INFRA-2. CI/CD и публикация образов [P0]
**Что сделать:** Pipeline (GitHub Actions): lint, unit-тесты, integration-тесты (compose в CI), сборка и публикация образов в ghcr.io с тегами по semver и `latest`.
**Критерии приёмки:** PR не мержится без зелёных тестов; push тега `v*` публикует образы.
**Зависимости:** INFRA-1.

### INFRA-3. Observability baseline [P0]
**Что сделать:** Pino structured JSON-логи с redaction секретов (RCON-пароли, session tokens, MaxMind key); `/metrics` (Prometheus) на каждом сервисе; `/healthz` (liveness) и `/readyz` (readiness, проверяет PG/Redis/bridge); сквозной request correlation ID (заголовок → логи → audit).
**Критерии приёмки:** в логах нет ни одного секрета (тест с grep по фикстурам); `/readyz` падает при недоступном PG; correlation ID одного запроса находится во всех сервисах.
**Зависимости:** INFRA-1.

### INFRA-4. Bridge — агент на хосте [P0]
**Что сделать:** Процесс на хосте (systemd unit), RPC-канал с панелью (WebSocket/gRPC + mTLS или token). RPC-методы: `file_read` (бинарно), `file_atomic_write` (tmp → fsync → rename → fsync dir), `container_run/stop/rm/stats`, `host_metrics`, `steamcmd_run` (со стримингом прогресса). Версия bridge передаётся в handshake.
**Критерии приёмки:** `file_atomic_write` выдерживает kill -9 в любой момент (файл либо старый, либо новый, никогда не битый — тест); потеря соединения → авто-reconnect с backoff; панель показывает bridge connected/disconnected + version.
**Зависимости:** INFRA-1.

### INFRA-5. Схема БД: ядро [P0]
**Что сделать:** Миграции: `organizations` (singleton, `settings jsonb` с `first_owner_claimed`, `depot_version`), `roles` (id uuid, name, color, `squad_permissions text[]`, `panel_access bool`, `can_assign_roles bool`, `can_edit_roles bool`, `is_system bool`), `players` (id uuid v7 PK, `eos_id text NOT NULL UNIQUE`, `steam_id64 bigint NULL` + partial unique, `canonical_name`, `name_normalized`, `created_at`, `last_seen_at`, `last_known_ip inet`, `role_id uuid NULL FK`, `total_time_played_seconds bigint default 0`), `sessions`, `servers`, `audit_log`. CHECK-constraint: `squad_permissions <@ <whitelist>` (whitelist из таблицы/конфига, см. корректировку №7). Сид дефолтных ролей из §2.5.
**Важно (исправление несостыковки спеки):** все дочерние таблицы (`player_name_history`, `player_ip_history`, `player_sessions`, `player_daily_presence`) ссылаются на **`players.id` (uuid)**, а НЕ на `steam_id64` — иначе EOS-only игроки теряют историю, а это противоречит §1.1.4.
**Критерии приёмки:** миграции идемпотентны (up/down); сид создаёт 6 ролей §2.5 ровно один раз; вставка permission вне whitelist отклоняется.
**Зависимости:** INFRA-1.

### INFRA-6. Audit log с hash-chain [P0]
**Что сделать:** Таблица `audit_log` append-only: `id`, `actor_player_id uuid NULL`, `action text`, `target jsonb`, `before jsonb`, `after jsonb`, `created_at`, `prev_hash`, `row_hash = sha256(prev_hash || canonical_json(row))`. DB-триггеры: запрет UPDATE/DELETE; запись через единый внутренний API. Endpoint + кнопка «Verify chain integrity» + out-of-band скрипт верификации.
**Критерии приёмки:** UPDATE/DELETE по таблице падает с ошибкой даже от owner-роли БД; verify обнаруживает подмену любой строки (тест с ручной правкой через psql от superuser).
**Зависимости:** INFRA-5.

### INFRA-7. Setup wizard [P0]
**Что сделать:** Endpoints `/api/v1/setup/*` + UI первого запуска: создание организации (имя, базовые настройки). Пользователь НЕ создаётся (он появится при первом Steam-логине). После завершения — все setup-endpoints возвращают `410 Gone`.
**Критерии приёмки:** повторный вызов любого setup-endpoint после завершения → 410; wizard недоступен после завершения и при прямом заходе по URL.
**Зависимости:** INFRA-5.

### INFRA-8. Backup/restore через restic [P0/P1]
**Что сделать (P0):** контейнер/cron с restic: daily backup, pre-commands `pg_dump` и Redis `BGSAVE`, encrypted repository (S3/local/любой restic backend через env), retention 7 daily / 4 weekly / 6 monthly, `restic forget --prune` по расписанию.
**Что сделать (P1):** UI: manual backup trigger, browse snapshots, restore flow с выбором snapshot и явным confirm.
**Критерии приёмки:** P0 — после `docker compose down -v` + restore панель полностью работоспособна (e2e-тест); P1 — restore из UI восстанавливает выбранный snapshot.
**Зависимости:** INFRA-1.

### INFRA-9. Host dashboard [P0]
**Что сделать:** Страница: hostname, OS, kernel, CPU, RAM, disk, network хоста (через bridge `host_metrics`); live-метрики (CPU%, RAM, disk, net rates) с обновлением каждые 5–10 с (WebSocket); статус bridge; алерты в UI: bridge disconnected, PostgreSQL недоступен.
**Критерии приёмки:** остановка bridge → алерт в UI ≤15 с; метрики обновляются без перезагрузки страницы.
**Зависимости:** INFRA-4.

---

# WS-1. Аутентификация и сессии

### AUTH-1. Steam OpenID 2.0 логин [P0]
**Что сделать:** Единственный способ входа. Кнопка «Войти через Steam» → redirect на `https://steamcommunity.com/openid/login` → callback с **серверной верификацией подписи** (`check_authentication` обратно к Steam, валидация `openid.claimed_id` строго по паттерну `https://steamcommunity.com/openid/id/<steamid64>`, защита от подмены realm/return_to). Извлечённый SteamID64 → lookup в `players` по `steam_id64`. Rate limiting на callback (например 10 req/min/IP, 429 + Retry-After).
**Критерии приёмки:** подделанный callback без валидной подписи отклоняется (интеграционный тест с моком Steam); SteamID64 извлекается только из верифицированного claimed_id; превышение лимита → 429.
**Зависимости:** INFRA-5.

### AUTH-2. Login-time check и 403-страницы [P0]
**Что сделать:** После верификации Steam: записи в `players` нет ИЛИ `role_id IS NULL` → 403 «У вас нет доступа к панели»; роль есть, но `panel_access=false` → 403 «Ваша роль не имеет доступа к панели»; `panel_access=true` → создать сессию. Owner-флаги — hardcoded в backend независимо от БД.
**Критерии приёмки:** все три ветки покрыты e2e-тестами; залогиниться без роли невозможно ни одним обходным путём (прямые API-вызовы тоже 401/403).
**Зависимости:** AUTH-1, ROLE-1.

### AUTH-3. First-login Owner assignment [P0]
**Что сделать:** Если на момент логина `organizations.settings.first_owner_claimed = false` → присвоить логинящемуся роль Owner (UPDATE существующей записи `players` по steam_id64 или INSERT новой) и атомарно (в одной транзакции, с блокировкой строки organizations) выставить флаг в `true`. Срабатывает ровно один раз за всю жизнь инсталляции; не сбрасывается ни удалением Owner-аккаунта, ни снятием роли.
**Критерии приёмки:** конкурентный тест: 10 параллельных первых логинов → ровно один Owner; после claim повторный логин нового пользователя получает 403; флаг переживает рестарты.
**Зависимости:** AUTH-1, ROLE-1, INFRA-7.

### AUTH-4. Sliding sessions TTL 24h [P0]
**Что сделать:** Сессия живёт 24 ч с момента последней активности: каждый authenticated request → `last_activity_at=now()`, `expires_at=last_activity_at+24h`, с троттлингом записи не чаще 1 раза в 60 с на сессию. Просроченная сессия → 401 → redirect на Steam login. Снятие роли / потеря `panel_access` → немедленная инвалидация всех сессий игрока (server-side + WebSocket logout).
**Критерии приёмки:** активность каждые 23 ч держит сессию бесконечно; 24 ч тишины → 401; снятие роли разлогинивает открытую вкладку ≤5 с; БД получает ≤1 UPDATE сессии в минуту при шторме запросов.
**Зависимости:** AUTH-2.

### AUTH-5. Session management UI [P0]
**Что сделать:** Страница активных сессий текущего пользователя: IP, user agent, last_activity_at, «истекает через X ч». Кнопки: logout конкретной сессии, logout из всех устройств.
**Критерии приёмки:** logout чужой вкладки убивает её ≤5 с (WebSocket push); «выйти везде» оставляет только текущую сессию (или ни одной — по выбору дизайна, зафиксировать).
**Зависимости:** AUTH-4.

### AUTH-6. API tokens [P1]
**Что сделать:** Создание/ревокация API-токенов со scopes; токен показывается один раз, хранится хэш; аутентификация по `Authorization: Bearer`; запись использования в audit.
**Критерии приёмки:** ревокованный токен → 401 немедленно; scope-нарушение → 403; в БД нет plaintext токенов.
**Зависимости:** AUTH-2.

---

# WS-2. Identity игроков и обработка подключений

### PLAYER-1. Алгоритм обработки подключения (§1.1.2) [P0]
**Что сделать:** На событие подключения (eos_id всегда; nickname всегда; steam_id64 если Steam-клиент): lookup по `eos_id`. Найден → при смене ника UPDATE `canonical_name` + INSERT в `player_name_history`; при появлении steam_id64 (был NULL) → UPDATE + audit `player.steam_linked`; UPDATE `last_seen_at`. Не найден → INSERT (uuidv7, eos_id, имя, steam_id64?, created_at, last_seen_at, role_id=NULL) + первый observation в name_history + audit `player.created`. Конфликт Steam↔EOS (для eos_id пришёл другой steam_id64, чем в БД): conflict-флаг на игроке + audit-alert, steam_id64 = последний наблюдаемый.
**Критерии приёмки:** идемпотентность (повторное событие не плодит записей); конкурентные подключения одного игрока на два сервера → одна запись (upsert по eos_id); все ветки покрыты unit-тестами.
**Зависимости:** INFRA-5, EVT-1.

### PLAYER-2. История никнеймов [P0]
**Что сделать:** Таблица `player_name_history` (`player_id uuid FK`, `name`, `name_normalized`, `observed_at`). INSERT при каждой обнаруженной смене ника (RCON poll или connect). Дедупликация: тот же ник в тот же день → UPDATE `observed_at`, без дублей. `name_normalized` = lowercase + strip clan tags (зафиксировать алгоритм: убрать префиксы в `[]`/`()`/`<>` и ведущие не-буквенные символы). UTF-8 хранится как есть (эмодзи, кириллица, спецсимволы — тестовые кейсы `✪ Mdc︱ Шyxer`, `[MDC] PlayerName`).
**Критерии приёмки:** смена ника видна в истории с timestamp; 50 заходов за день под одним ником → одна запись; поиск по `name_normalized` находит игрока без clan tag.
**Зависимости:** PLAYER-1.

### PLAYER-3. История IP + GeoIP [P0]
**Что сделать:** Таблица `player_ip_history` (`player_id uuid FK`, `ip inet`, `country_code`, `country_name`, `region`, `city`, `timezone_offset`, `latitude`, `longitude`, `first_seen_at`, `last_seen_at`, `observation_count`, `UNIQUE(player_id, ip)`). На каждое подключение: GeoIP-резолв → `INSERT ... ON CONFLICT DO UPDATE last_seen_at, observation_count+1` → UPDATE `players.last_known_ip`. Геоданные замораживаются на момент observation (не пересчитываются).
**GeoIP-механизм (см. корректировку №3):** оператор вводит MaxMind Account ID + License Key в настройках; панель скачивает GeoLite2-City (mmdb) и обновляет по расписанию (еженедельно); без ключа — IP сохраняется, геополя NULL, UI показывает «гео недоступно: добавьте MaxMind ключ в настройках».
**Критерии приёмки:** повторный заход с того же IP инкрементит counter, не плодит строк; обновление базы GeoLite2 не меняет исторические записи; панель полностью работоспособна без MaxMind-ключа.
**Зависимости:** PLAYER-1.

### PLAYER-4. Карточка игрока `/players/{id}` — identity-секции [P0]
**Что сделать:** Страница по UUID (не по steam_id64). Секции: SteamID64 (кликабельная ссылка → `https://steamcommunity.com/profiles/{id}`, «—» если NULL), EOS ID (кнопка copy-to-clipboard), текущий ник, аватар-заглушка (инициалы), «Создан» (created_at), «Заходил» (last_seen_at), виджет роли (см. ROLE-6), «Другие ники» (sorted desc по observed_at, формат «Сегодня 09:05:16» / «05/10/2025 11:18:31»), секция «Локация»: текущая (флаг + страна − регион/город (+TZ) + IP + время) и «Другие локации» desc. **IP и точная локация видны только при permission `player:view_ips`** (Owner и роли с panel_access по решению оператора — зафиксировать: в P0 гейт = `panel_access`, отдельный флаг — backlog); без него — только страна.
**Критерии приёмки:** карточка EOS-only игрока корректна (нет Steam-виджета, всё остальное работает); пользователь без права не видит IP ни в UI, ни в API-ответе (фильтрация на сервере).
**Зависимости:** PLAYER-2, PLAYER-3, ROLE-5.

### PLAYER-5. Список `/users` (игроки с ролями) [P0]
**Что сделать:** Таблица `SELECT … WHERE role_id IS NOT NULL`: nickname, SteamID64, role-badge с цветом, last_seen_at, кнопка «Снять роль» (если у смотрящего `can_assign_roles`). Поиск по нику/SteamID, фильтр по роли.
**Критерии приёмки:** фильтр+поиск работают вместе; снятие роли мгновенно убирает строку и триггерит SYNC-3.
**Зависимости:** ROLE-5, SYNC-3.

### PLAYER-6. Поиск и admin tools [P1]
**Что сделать:** Глобальный поиск игроков: по текущему и историческим никам (через name_history), SteamID64, EOS ID. Player notes от админов (CRUD + audit). Sortable-колонки в `/players` (nickname, last_seen, created, total_time_played). Фильтры: online сейчас / активные баны / новые (<7 дней).
**Критерии приёмки:** поиск по старому нику находит игрока; notes видны всем с panel_access, авторство фиксируется.
**Зависимости:** PLAYER-2, PRES-4, MOD-2.

---

# WS-3. Роли и доступы (RBAC)

### ROLE-1. CRUD ролей + модель [P0]
**Что сделать:** API: `POST/PATCH/DELETE /api/v1/roles`, `GET /api/v1/roles`. Роль = имя + цвет + `squad_permissions[]` (whitelist 21 значение из §2.4) + три флага (`panel_access`, `can_assign_roles`, `can_edit_roles`). Валидация: assign/edit-флаги требуют `panel_access=true`. Один игрок — одна роль. Owner: `is_system=true`, не редактируется/не удаляется/не переименовывается (403 на любые мутации), флаги и permissions hardcoded. DELETE роли → все её игроки получают `role_id=NULL` (в одной транзакции) + триггер синка + инвалидация их сессий, если роль имела panel_access. Все мутации требуют `can_edit_roles` и пишутся в audit (before/after).
**Критерии приёмки:** попытка `can_assign_roles=true` при `panel_access=false` → 422; DELETE возвращает количество затронутых игроков; мутация Owner → 403; пользователь без `can_edit_roles` → 403.
**Зависимости:** INFRA-5, INFRA-6.

### ROLE-2. Назначение/снятие роли игроку [P0]
**Что сделать:** `PUT /api/v1/players/{id}/role` (id = UUID), `DELETE /api/v1/players/{id}/role`. Требует `can_assign_roles`. Запрет выдачи Owner через API (403 всегда). Самозащита Owner: единственный Owner не может снять/сменить свою роль (409 + текст «Вы единственный Owner. Сначала выдайте роль Owner другому пользователю» — но выдача Owner возможна только прямой правкой БД, значит реальный сценарий: 409 всегда для единственного Owner; зафиксировать это поведение в API-доке). Снятие роли с panel_access → инвалидация сессий игрока. Каждая мутация → audit + триггер SYNC-3.
**Критерии приёмки:** выдача роли EOS-only игроку работает (он просто не попадёт в Admins.cfg — см. SYNC-2); сессии снятого админа умирают ≤5 с; конкурентные назначения сериализуются.
**Зависимости:** ROLE-1, AUTH-4.

### ROLE-3. Страница `/settings/groups` — inline-редактор [P0]
**Что сделать:** Все роли стопкой карточек (макет §2.3): Название, Цвет (color-picker + hex), три свитча (assign/edit задизейблены при выключенном panel_access), 21 чекбокс permissions в три колонки, ⚠️-бейдж на changemap/kick/ban/manageserver, ссылка на Squad wiki Server_Administration, «Открыть список членов (N) →». Inline editing: debounced auto-save 500 мс, optimistic UI с rollback и toast при ошибке. «+ Создать роль» — inline-карточка с placeholder «Новая роль». Корзина с confirm («затронет N пользователей»); у Owner корзины нет, контролы read-only.
**Критерии приёмки:** быстрый клик по 5 чекбоксам → один PATCH; обрыв сети при сохранении → чекбокс откатывается + toast; Owner-карточка ничем не мутируется из UI.
**Зависимости:** ROLE-1.

### ROLE-4. Страница членов роли `/settings/groups/{role_id}/members` [P0/P1]
**Что сделать (P0):** header (имя+цвет, «← Назад»), search по нику/SteamID64, pagination (рассчитывать на 200+ записей), колонки nickname/SteamID64/last_seen_at/«Снять роль», «+ Добавить игрока» (modal-поиск по players: ник, аватар, last_seen → клик → assign).
**Что сделать (P1):** bulk: импорт из CSV-textarea (SteamID в строке, optional comment после `;`, превалидация до commit, отчёт об ошибках построчно; SteamID без записи в `players` — отклонять или создавать stub-запись — зафиксировать решение: отклонять, т.к. players требует eos_id NOT NULL), «Удалить выбранных», «Переместить в другую роль», комментарий к назначению (→ `// комментарий` после `Admin=`-строки), экспорт CSV.
**Критерии приёмки:** P0 — добавление/снятие из списка триггерит синк; P1 — CSV с 1 битой строкой не коммитит ничего и показывает, какая строка бита.
**Зависимости:** ROLE-2; P1-часть: SYNC-2.

### ROLE-5. Виджет роли на карточке игрока [P0]
**Что сделать:** Текущая роль (имя+цвет) или «—». Dropdown «Выдать роль» (все роли кроме Owner и текущей), «Снять роль» с confirm. Без `can_assign_roles` — read-only.
**Критерии приёмки:** optimistic update с rollback; Owner отсутствует в dropdown.
**Зависимости:** ROLE-2, PLAYER-4.

### ROLE-6. P1-доработки редактора [P1]
**Что сделать:** «Скопировать права из другой роли» при создании (preset-dropdown); realtime-фильтр чекбоксов permissions; live preview «как это выглядит в Admins.cfg» (collapsible footer карточки, рендер из тех же функций генерации, что SYNC-2).
**Критерии приёмки:** preview побайтно совпадает с тем, что уйдёт в файл (общий код генерации).
**Зависимости:** ROLE-3, SYNC-2.

---

# WS-4. Синхронизация Admins.cfg

### SYNC-1. Транзакционная очередь синка [P0]
**Что сделать:** Каждая мутация из ROLE-1/ROLE-2 в своей транзакции добавляет sync-task (outbox-таблица в PG, релей в Redis Stream `events:admins-cfg-sync:<server_id>` — чтобы не терять таски при падении между commit и XADD). Worker `config-sync` — consumer group, идемпотентная обработка, ack после успешного push.
**Критерии приёмки:** kill worker'а посреди обработки → таск переобрабатывается без дублей эффекта; мутация без последующего синка невозможна (outbox-тест).
**Зависимости:** ROLE-1, ROLE-2, INFRA-4.

### SYNC-2. Генерация managed-сегмента [P0]
**Что сделать:** Чистая функция БД → текст сегмента между `//SQUAD-PANEL BEGIN — не редактировать вручную` и `//SQUAD-PANEL END`: `Group=<имя>:<perms через запятую>` для каждой роли с непустыми squad_permissions (роль только с panel_access — НЕ пишется; Owner пишется как обычная роль, если у неё есть permissions — а они есть всегда, все 21); `Admin=<steam_id64>:<role_name>` для каждого игрока с ролью, имеющей squad_permissions, **и `steam_id64 IS NOT NULL`** (EOS-only — пропускаются); P1: `// комментарий` из назначения. Line endings внутри сегмента — `\r\n`. Детерминированный порядок (роли по имени, админы по steam_id64) — для стабильного хэша.
**Открытый вопрос для имплементатора:** имя роли попадает в файл как есть → запретить в имени роли символы `:`, `,`, перевод строки и не-ASCII (валидация в ROLE-1; кириллическое «Название» из UI — это display name, а в Admins.cfg идёт отдельный латинский slug — добавить поле `slug` в roles).
**Критерии приёмки:** snapshot-тесты генерации; два вызова на одних данных дают побайтно идентичный результат; EOS-only игрок с ролью отсутствует в выводе.
**Зависимости:** INFRA-5.

### SYNC-3. Worker config-sync: read-modify-write [P0]
**Что сделать:** Для каждого таска: `file_read` Admins.cfg бинарно → найти сегмент regex'ом (dotall) → нет маркеров: вставить сегмент в начало файла → регенерировать содержимое (SYNC-2) → сравнить sha256 старого/нового сегмента → equal: skip (идемпотентность) → diff: `file_atomic_write` всего файла, сохранив байты вне маркеров и их line endings нетронутыми → **вызвать RCON `AdminReloadServerConfig`** (см. корректировку №1) → audit `admins_cfg.synced` (actor, server_id, before/after segment hash, groups_count, admins_count; полный diff не пишем).
**Критерии приёмки:** файл с чужими сегментами (`//SQSTAT DELIMETER`) и ручными правками вне маркеров — байты вне маркеров не изменены (побайтный тест); смешанные line endings снаружи сохраняются; повторный таск без изменений не пишет файл; после push на живом сервере права применяются без рестарта (e2e на dev-сервере).
**Зависимости:** SYNC-1, SYNC-2, INFRA-4, RCON-1.

### SYNC-4. Drift detection [P0]
**Что сделать:** Раз в 5 минут (configurable) сравнивать hash сегмента в файле каждого сервера с ожидаемым из БД. Drift → alert на странице сервера: «Admins.cfg на сервере X изменён вне панели» + кнопка «Force sync» (перезапись, audit `admins_cfg.force_synced`). «Принять изменения» — НЕ реализуется в P0 (зафиксировать в UI текстом-подсказкой «скопируйте значения в редактор ролей вручную»).
**Критерии приёмки:** ручная правка внутри маркеров через ssh → алерт ≤6 мин; Force sync восстанавливает сегмент и гасит алерт.
**Зависимости:** SYNC-3.

### SYNC-5. Per-server lifecycle синка [P0]
**Что сделать:** Создание сервера → немедленный initial push полного сегмента. Удаление → прекращение синка, очистка очереди. Сервер недоступен → retry с exponential backoff (cap 5 мин), failed attempts в audit. Недоступность >1 ч → алерт «Server X не получил последние изменения Admins.cfg».
**Критерии приёмки:** новый сервер получает актуальный сегмент до первого старта; после часа даунтайма алерт виден, после восстановления синк догоняет и алерт гаснет.
**Зависимости:** SYNC-3, SRV-1.

### SYNC-9. [Исследование] RemoteAdminListHosts.cfg как альтернатива push'у [P1]
**Что сделать:** Проверить на живом сервере: частоту перезагрузки remote-списков, поведение при недоступном URL, merge нескольких списков. Если механизм надёжен — спроектировать вариант: панель хостит admin-список по внутреннему URL, серверы подтягивают сами (упрощает мульти-сервер). Решение: остаёмся на push или мигрируем. Результат — ADR-документ.
**Критерии приёмки:** ADR с замерами и решением.
**Зависимости:** SYNC-3.

---

# WS-5. Управление Squad-серверами

### SRV-1. Wizard установки сервера [P0]
**Что сделать:** UI-wizard: имя, порты (game 7787/UDP по умолчанию, query 27165/UDP, RCON 21114/TCP, beacon), пути. Установка: bridge запускает SteamCMD `login anonymous` + `app_update 403240 validate` в общий read-only volume `squad-depot` (~12 GiB, один на все серверы); прогресс стримится в UI по WebSocket (парсинг stdout SteamCMD). Автогенерация Server.cfg + Rcon.cfg (RCON password — генерировать криптослучайно, хранить в БД шифрованно) копированием дефолтов из depot. Запись в `servers`. Initial Admins.cfg push (SYNC-5).
**Критерии приёмки:** с нуля до работающего сервера только через UI; прогресс-бар отражает реальные проценты SteamCMD; повторная установка переиспользует depot (не качает 12 GiB заново); коллизия портов между серверами валидируется до установки.
**Зависимости:** INFRA-4, INFRA-5.

### SRV-2. Запуск в Docker [P0]
**Что сделать:** Каждый сервер — контейнер: `--network host`, бинды `/var/lib/squad-panel/configs/{uuid}/ServerConfig` (RW) и `/var/lib/squad-panel/saved/{uuid}` (RW), depot read-only, `--ulimit nofile=65536:65536`, `--restart=unless-stopped`. CPU/RAM-лимиты НЕ ставятся по умолчанию; добавляются только из `server_settings` (CPU affinity/weight, memory, nice, IOWeight — UI opt-in). `docker stats` → Prometheus (cpu%, mem, netrx/tx per server).
**Критерии приёмки:** два сервера на одном хосте на разных портах работают одновременно; OOM-kill не происходит без заданного лимита; метрики контейнера видны в `/metrics`.
**Зависимости:** SRV-1.

### SRV-3. Start/Stop/Restart/Delete [P0]
**Что сделать:** Кнопки одним кликом. Graceful stop: RCON `AdminBroadcast "<предупреждение>"` → `AdminEndMatch` → stop контейнера с TimeoutStopSec=60. Force stop (kill) — с дополнительным confirm. Delete — стоп + удаление контейнера + полная очистка `configs/{uuid}` и `saved/{uuid}` + удаление из БД (с confirm, перечисляющим что будет удалено). Всё — в audit.
**Критерии приёмки:** graceful stop не корраптит save; повторное нажатие во время операции — no-op (идемпотентность/locks); delete не оставляет файлов и контейнеров.
**Зависимости:** SRV-2, RCON-1.

### SRV-4. Статус и health [P0]
**Что сделать:** Страница сервера: status (running/stopped/crashed), uptime, player count, current layer, tickrate (из RCON/логов). A2S-query (UDP query port) — индикатор «виден в Steam Server Browser». Crash detection: контейнер умер не по команде панели → событие `server.crashed` + алерт; рестарт от `unless-stopped` → `server.restarted`.
**Критерии приёмки:** kill -9 процесса сервера → crash-событие и алерт ≤30 с; A2S-индикатор зелёный на живом сервере.
**Зависимости:** SRV-2, EVT-1, RCON-1.

### SRV-5. Координированное обновление depot [P0]
**Что сделать:** `POST /api/v1/depot/update`: graceful stop всех серверов → init-контейнер SteamCMD `app_update 403240 validate` → старт всех серверов обратно. UI: глобальный баннер «Updating Squad depot — all servers offline for ~10 min» + progress. `organizations.depot_version` — для индикатора «доступно обновление» (P0: ручной запуск; авточек версии — backlog).
**Критерии приёмки:** во время обновления операции с серверами заблокированы; падение SteamCMD → серверы поднимаются на старой версии + алерт; повторный запуск во время идущего → 409.
**Зависимости:** SRV-3.

### SRV-6. Update одного сервера и License Management [P1]
**Что сделать:** (a) app_update с прогрессом для серверов с индивидуальной установкой (если останутся — при shared depot задача вырождается в SRV-5; уточнить и при необходимости закрыть как dup); (b) License.cfg: ввод LicenseId/LicenseKey через UI, валидация формата, attach/detach к серверу, рестарт-badge. (c) Server groups и tags для организации списка серверов.
**Критерии приёмки:** лицензия применяется после рестарта; группы фильтруют список серверов.
**Зависимости:** SRV-1, CFG-1.

### RCON-1. RCON-клиент (worker-rcon) [P0]
**Что сделать:** Source-RCON клиент (TCP 21114): persistent connection per server, auto-reconnect, очередь команд, таймауты. Команды P0: `ListPlayers` (парсинг: ID, Online IDs EOS/steam, name, team, squad, role), `ListSquads`, `AdminBroadcast`, `AdminEndMatch`, `AdminReloadServerConfig`, `ShowNextMap`. Poll ListPlayers каждые 30 с → события `rcon.players_polled` + обновление identity (PLAYER-1, PLAYER-2). Сверить парсеры с актуальным SquadJS (корректировка №10).
**Критерии приёмки:** обрыв TCP → reconnect без потери очереди; парсер ListPlayers покрыт фикстурами с реального сервера (включая ники с эмодзи/кириллицей); poll не создаёт >1 соединения на сервер.
**Зависимости:** INFRA-4, SRV-2.

---

# WS-6. События и логи

### EVT-1. Парсинг SquadGame.log (worker log-ingest) [P0]
**Что сделать:** Live-tail `saved/{uuid}/SquadGame/Saved/Logs/SquadGame.log` (inotify + позиция в файле, обработка ротации). События P0: `server.ready`, `player.connected` (eos_id, name, steam_id64?, IP из LogNet/LogEOS строк), `player.disconnected`, `match.started`, `match.ended`, `server.crashed`, `server.restarted`, `rcon.players_polled`. Регэкспы сверить с SquadJS log-parser и покрыть фикстурами реальных логов. Storage: `events` partitioned по месяцам (pg_partman), retention 24 мес с auto-drop партиций. Recovery: при рестарте worker'а продолжать с сохранённой позиции; если файл ротировался — дочитать старый.
**Критерии приёмки:** подключение реального игрока на dev-сервере → событие в БД ≤5 с со всеми ID; kill worker'а посреди файла → после рестарта ни потерь, ни дублей (offset-тест); партиция старше 24 мес дропается.
**Зависимости:** INFRA-4, INFRA-5, SRV-2.

### EVT-2. UI событий [P0/P1]
**Что сделать (P0):** Per-server event log: фильтры по type, time range, player; click → raw envelope JSON. **(P1):** export CSV.
**Критерии приёмки:** фильтры комбинируются; выборка за месяц по одному серверу <1 c на 1M событий (индексы).
**Зависимости:** EVT-1.

### LOG-1. Retention raw-логов — 10 дней [P0]
**Что сделать:** Worker log-ingest раз в час сканирует `saved/*/SquadGame/Saved/Logs/`: файлы `SquadGame*.log` с `mtime + 10d < now()` — удалять; текущий live `SquadGame.log` (без timestamp в имени) — никогда. Логировать count/bytes удалённого.
**Критерии приёмки:** live-файл с искусственно старым mtime не удаляется; rotated 11-дневной давности удаляется; метрика удалений в observability.
**Зависимости:** EVT-1.

### LOG-2. Browse/download логов через UI [P1]
**Что сделать:** Tab «Логи» на странице сервера: список файлов (size, mtime, бейдж «live»), скачивание стримингом через bridge `file_read`. Permission `server:download_logs` (дефолт — роли с panel_access).
**Критерии приёмки:** скачивание 500 MB файла не держит его в памяти целиком (стриминг); без permission — 403.
**Зависимости:** LOG-1, INFRA-4.

### LOG-3. Архив логов в backup [P2]
**Что сделать:** Флаг «Архивировать в backup» в настройках сервера (default off): перед удалением по retention файл уходит в restic с правилами 7d/4w/6m.
**Зависимости:** LOG-1, INFRA-8.

### CHAT-1. Live chat viewer [P1] / фильтрация [P2]
**Что сделать (P1):** WebSocket-стрим чата из SquadGame.log в реальном времени (страница сервера). **(P2):** фильтры (mute-слова, регэкспы).
**Критерии приёмки:** сообщение в игре → в UI ≤3 с; reconnect WebSocket не теряет хвост (буфер последних N).
**Зависимости:** EVT-1.

---

# WS-7. Presence tracking

### PRES-1. Таблица player_sessions [P0]
**Что сделать:** `player_sessions`: `id bigserial`, `player_id uuid` (не steam_id64 — см. INFRA-5), `server_id`, `connected_at`, `disconnected_at NULL`, `duration_seconds NULL`, `closed_reason` (`disconnect|server_crashed|kicked|banned`), `mode` (`online|boost|queue`; P0 — всегда `online`). Индексы: `(player_id, connected_at desc)`, `(server_id, connected_at desc)`, partial `WHERE disconnected_at IS NULL`, BRIN по connected_at. Партиционирование по месяцам (pg_partman), retention 24 мес. Создание из `player.connected`, закрытие из `player.disconnected`. Crash-fallback: при `server.restarted/crashed` закрыть все open-сессии сервера с `closed_reason='server_crashed'`, duration = `min(now − connected_at, last_event_at − connected_at)`.
**Критерии приёмки:** connect без disconnect + crash → сессия закрыта корректной длительностью; дубль connect-события не открывает вторую сессию того же игрока на том же сервере.
**Зависимости:** EVT-1, PLAYER-1.

### PRES-2. Дневные агрегаты player_daily_presence [P0]
**Что сделать:** `(player_id, day, server_id)` PK; `online_seconds`, `boost_seconds`, `queue_seconds`, `session_count`. Worker раз в час пересчитывает текущий день, в полночь финализирует вчерашний. Сессии через полночь корректно режутся по дням. При закрытии сессии — обновлять `players.total_time_played_seconds`.
**Критерии приёмки:** сессия 23:00–01:00 даёт по часу в каждый из двух дней; SUM по агрегатам == SUM по сессиям (reconciliation-тест); recompute идемпотентен.
**Зависимости:** PRES-1.

### PRES-3. UI: график и аккумуляторы [P0]
**Что сделать:** На карточке игрока: bar chart по дням (30/90/365), Y — часы, stacked (в P0 один цвет online), tooltip с точными числами на клик. Card «Онлайн: XXXXч XXм» из total_time_played. Live-индикатор: open-сессия → зелёная точка + «Онлайн» + живой таймер «уже 2ч 15м».
**Критерии приёмки:** график за 365 дней рендерится <1 с (читает только агрегаты); таймер тикает без перезагрузки.
**Зависимости:** PRES-2.

### PRES-4. P1: boost/queue, календарь, по серверам [P1]
**Что сделать:** Режим `boost` — у игрока роль с permission `reserve` на момент сессии; `queue` — если очередь определима из RCON/логов (предварительно — spike-исследование, что Squad реально отдаёт; если ничего — режим откладывается с фиксацией в ADR). Cards «Буст» и «Бонусы» (формула default `online + 2×boost`, настройка — P2). Календарь week-grid 7×24 с блоками сессий (hover → время, цвет = mode). Tab «По серверам» (pie/table). Sortable «Online status» в `/players`.
**Зависимости:** PRES-2, ROLE-1.

### PRES-5. Праймтайм [P2]
**Что сделать:** Гистограмма presence по часам суток за 30 дней + rolling average → top contiguous range → «Праймтайм 16:02–19:53». TZ — из последнего geoip timezone_offset. Recompute раз в день.
**Зависимости:** PRES-2, PLAYER-3.

---

# WS-8. Модерация

### MOD-1. Live players list [P0]
**Что сделать:** На странице сервера: онлайн-игроки (nickname, SteamID64, EOS ID, team, squad, время на сервере), обновление каждые 30 с из RCON poll, клик по игроку → его карточка.
**Критерии приёмки:** список совпадает с in-game; EOS-only игроки отображаются.
**Зависимости:** RCON-1, PLAYER-1.

### MOD-2. Moderation actions [P1]
**Что сделать:** Таблица `moderation_actions` (player_id, server_id, type, reason, duration, author_player_id, created_at, evidence[]). Действия через RCON: Kick (`AdminKick "<id|name>" <reason>`), Warn (`AdminWarn`), Ban (`AdminBan "<id>" <duration> <reason>`; длительности `0`=perm, `1d`, `1M` и т.п. — формат подтверждён), Unban (правка Bans.cfg: формат `Banned:<steamid64>:<unix-expiry>`, см. корректировку №4 — удаление строки через managed-правку файла + `AdminReloadServerConfig`). UI: кнопки с карточки игрока и из live-списка, обязательный reason, confirm на ban. Каждое действие → audit + moderation history.
**Критерии приёмки:** бан из UI виден в Bans.cfg в корректном формате и реально не пускает игрока; unban убирает строку, не трогая чужие записи и комментарии; история фильтруется по игроку/типу/серверу.
**Зависимости:** RCON-1, PLAYER-4, SYNC-3 (механика правки cfg переиспользуется).

### MOD-3. Evidence [P1]
**Что сделать:** Attach к moderation action: скриншот/видео-ссылка/фрагмент chat log; хранение файлов (локальный volume, размер-лимиты); отображение в истории.
**Зависимости:** MOD-2.

### MOD-4. Массовые операции модерации [P2]
**Что сделать:** kick all, ban multiple с одним confirm; выбор игроков из live-списка/поиска; каждое действие — отдельная запись в moderation history + audit; защита от случайного массового бана (двойной confirm, лимит).
**Критерии приёмки:** массовый бан N игроков создаёт N записей и N строк в Bans.cfg; отмена/ошибка на одном не откатывает уже применённые (или транзакционно — зафиксировать); audit содержит инициатора и список целей.
**Зависимости:** MOD-2.

### MOD-5. Appeals portal + workflow [P3]
**Что сделать:** публичный URL подачи апелляции по SteamID + бану (без сессии панели), очередь рассмотрения, статусы (pending/approved/rejected), уведомление решением, audit; approve → снятие бана через MOD-2-механику.
**Критерии приёмки:** апелляция создаётся анонимно и попадает в очередь; approve снимает бан и уведомляет; все переходы статуса в audit.
**Зависимости:** MOD-2.

---

# WS-9. Редактор конфигов

### CFG-1. Monaco-редактор 19 .cfg файлов [P1]
**Что сделать:** Monaco с INI-подсветкой; список файлов из §6.1; чтение/запись через bridge (`file_read`/`file_atomic_write`, CRLF сохраняется); классификация §6.2 с бейджами: `hot_reload` (Admins/Bans/Remote*Hosts — после записи дёргать `AdminReloadServerConfig`), `requires_restart` (Server/Rcon/License/CustomOptions/MOTD/ServerMessages — бейдж «требует рестарта» + кнопка рестарта), `rotation` (применится со следующего матча). Для Admins.cfg managed-сегмент в редакторе read-only (подсветка «управляется панелью»).
**Критерии приёмки:** сохранение не ломает CRLF и кодировку; правка managed-сегмента из редактора невозможна; hot_reload-файл применяется без рестарта (e2e).
**Зависимости:** INFRA-4, RCON-1, SYNC-3.

### CFG-2. Git-versioning и drift [P1]
**Что сделать:** Каждый `configs/{uuid}` — git-репозиторий: commit на каждое сохранение (author = actor), история, diff, rollback на любую ревизию (rollback = новый commit). Drift detection: git HEAD vs filesystem → алерт + diff + «принять» (commit as-is) / «откатить». Reset файла к дефолту из depot.
**Критерии приёмки:** rollback восстанавливает файл побайтно; ручная правка по ssh ловится и разрешается обеими кнопками.
**Зависимости:** CFG-1.

---

# WS-10. Whitelist (поверх RBAC)

### WL-1. Shortcuts для whitelist [P1]
**Что сделать:** One-click «В whitelist» с карточки игрока (назначение роли с единственным permission `reserve`; роль выбирается в настройках организации, дефолт QueuePriority). Импорт CSV (SteamID64 + optional comment) → bulk-assign через ROLE-4-механику. Экспорт CSV.
**Критерии приёмки:** one-click идемпотентен; импорт 200 строк с 3 битыми → отчёт, ничего не закоммичено.
**Зависимости:** ROLE-2, ROLE-4.

### WL-2. Шаблон whitelist-группы на все серверы [P2]
**Что сделать:** Уточнить необходимость: роли и так глобальны (§2.1), вероятно dup → закрыть или переформулировать при груминге. Если оставляем — шаблон группы, применяемый ко всем серверам одним действием.
**Критерии приёмки:** решение зафиксировано (dup/closed или переформулировано); при реализации — применение шаблона на все серверы одним действием.
**Зависимости:** ROLE-4.

### WL-3. Applications portal + approval workflow + авто-expire [P3]
**Что сделать:** Публичный портал заявок на whitelist/VIP + approval workflow + авто-expire через N дней (поле `role_expires_at` у назначения + worker-чистильщик, снимающий истёкшие роли и триггерящий SYNC-3).
**Критерии приёмки:** заявка проходит одобрение и выдаёт роль на срок; истёкший срок автоматически снимает роль и синкает Admins.cfg; всё в audit.
**Зависимости:** ROLE-2, ROLE-4.

---

# WS-11. Gameplay stats (RNSquadJS) — P2

### STATS-1. [Блокирующее исследование] Верификация RNSquadJS [P2, расследование — P0/P1]
**Что сделать:** Найти и зафиксировать: точный репозиторий/образ RNSquadJS, лицензию, Mongo-схему `mainstats` (поля из §8B.5), стабильность схемы между версиями → pin конкретного tag. Проверить multi-RCON: сколько одновременных подключений с одного source IP реально допускает актуальный Squad-сервер (worker-rcon + RNSquadJS одновременно), существует ли опция вида MaxRconConnections. Проверить `--network host` совместимость двух процессов на loopback-RCON. Оценить объём Mongo и retention. Результат — обновлённый `RNSQUADJS_INTEGRATION.md` с ответами на все 4 открытых вопроса §8B.10. **Без закрытия этой задачи имплементация STATS-2..5 не начинается.**
**Зависимости:** RCON-1.

### STATS-2. Sidecar-инфраструктура [P2]
**Что сделать:** Compose: `rnsquad-mongo` (один, healthcheck, persistent volume) + `rnsquadjs-<uuid>` на каждый сервер (через существующие bridge `container_*`). config.json генерируется панелью: включён только плагин `rnsStats`, остальные off. Lifecycle: установка сервера поднимает оба контейнера; удаление — стоп+rm обоих + drop db `rnsquad_<uuid>`.
**Зависимости:** STATS-1, SRV-1.

### STATS-3. Worker stats-importer [P2]
**Что сделать:** Read-only Mongo-клиент; Redis-кэш TTL 60 с; change streams для инвалидации; RPC `stats.getPlayer`; cross-server merge при `serverId=all` (sum counters, recompute kd/winrate, max lastActiveAt, name с последнего активного); retention — drop mainstats с lastActiveAt > 2 лет.
**Зависимости:** STATS-2.

### STATS-4. API + UI [P2]
**Что сделать:** `GET /api/v1/players/{id}/stats?serverId=<uuid>|all`, permission `stats:view`. UI-блоки «Скилл» (donut winrate + grid 3×3; поле «Урон» в RNSquadJS отсутствует — скрыть) и «Киты» (sorted `Main.roles`), tab «По серверам», секция «Stats integration» на странице сервера (status, Monaco JSON-editor конфига, toggles плагинов, restart RNSquadJS). **(P1, заранее):** placeholder-блоки с финальными пропорциями + tooltip «Available in Phase 2».
**Зависимости:** STATS-3, PLAYER-4.

---

# WS-12. Automation [P2]

### AUTO-1. Triggers
«если {condition} → {action}»: conditions (keyword в чате, player count threshold, time of day, player flags), actions (RCON-команда, kick, warn, notify admin); dry-run тест правила до активации; история срабатываний; всё в audit.
**Зависимости:** EVT-1, CHAT-1, RCON-1.

### AUTO-2. Scheduler
Задачи по расписанию (restart, смена layer через `AdminSetNextLayer`/`AdminChangeLayer`, broadcast); cron-синтаксис или UI-picker; история выполнений; защита от наложения на depot-update.
**Зависимости:** SRV-3, RCON-1.

### AUTO-3. Alerts
Email (server crashed, unusual activity, admin login с нового IP — по player_ip_history админа), Web Push, custom rules.
**Зависимости:** EVT-1, PLAYER-3.

### AUTO-4. In-game chat commands
`!stats`, `!rules`, `!report` через RCON; история. **Конфликт-чек:** если включён RNSquadJS со своими chat-командами — не дублировать (см. §8B.9).
**Зависимости:** CHAT-1, RCON-1.

---

# WS-13. Интеграции [P2/P4]

### INT-1. Steam Web API [P2]
Профиль (real avatar — заменяет заглушку PLAYER-4), VAC ban status (`vac_banned`, «Да/Нет/—», только Steam-игроки), game ownership. API key оператора в настройках; rate-limit-aware батчинг.
**Зависимости:** PLAYER-4.

### INT-2. GeoIP-аномалии [P2]
Country switch alert (смена страны <24 ч → audit + notification), multi-country soft-flag (порог N в настройках), map view локаций на карточке.
**Зависимости:** PLAYER-3, AUTO-3.

### INT-3. External ban sources + cheater detection [P4]
**Что сделать:** Спроектировать после P2 (конкретизируется задачами CBAN-* из анализа конкурента): подписка на внешние источники банов/читеров, импорт и проверка входящих игроков, флаги на карточке.
**Критерии приёмки:** зафиксировано в CBAN-*; INT-3 — зонтичная формулировка.
**Зависимости:** PLAYER-4, EVT-1.

### INT-4. Plugin system (hooks на events) [P4]
**Что сделать:** Система плагинов с хуками на события; events-таблица уже спроектирована как envelope (EVT-1), что упрощает hooks; sandbox/permissions для плагинов.
**Критерии приёмки:** плагин может подписаться на тип события и получить envelope; ошибка плагина не роняет worker.
**Зависимости:** EVT-1.

---

# WS-14. Gameplay features [P3]

### GAME-1. Map voting: автоголосование за следующую карту, конфигурация кандидатов и времени, история; применение через `AdminSetNextLayer`. Учесть встроенную Layer Voting систему Squad (LayerVoting*.cfg) — сначала ADR: своя реализация vs конфигурация встроенной.
### GAME-2. Team balancer: autobalance по skill/hours, manual кнопка, rules engine (не разбивать сквады, уважать clan tags); требует STATS-* для skill-данных.

---

# WS-15. Analytics и public pages [P2/P3]

### AN-1. [P2] Dashboard: peak players по времени суток, match outcomes, popular maps (источник — events + presence); per-server разрез; export CSV/JSON.
### AN-2. [P2] Public stats portal (опциональный, отдельный read-only слой без сессий панели). [P3] Embeddable-виджеты (online count, current map) и кастомизируемые внешние страницы.
**Зависимости:** EVT-1, PRES-2, STATS-3.

---

# WS-16. UX [P0–P2]

### UX-1. [P0] Dark mode (default), inline-валидация форм, loading/empty states с CTA, человекочитаемые ошибки (EN в P0), OpenAPI/Swagger UI на `/api/docs` (генерация из схем, не вручную).
### UX-2. [P1] i18n EN/RU (включая RU-ошибки); все строки P0 — через i18n-слой с самого начала, чтобы P1 был переводом, а не рефакторингом.
### UX-3. [P2] Keyboard shortcuts (Ctrl+K global search по игрокам/серверам/страницам).

---

## Граф критического пути P0

```
INFRA-1 → INFRA-5 → ROLE-1 → ROLE-2 → SYNC-1 → SYNC-3 → SYNC-4/5
        ↘ INFRA-4 → SRV-1 → SRV-2 → RCON-1 ↗        ↘ e2e: роль из UI
        ↘ INFRA-7 → AUTH-1 → AUTH-3 → AUTH-2 → AUTH-4   применяется in-game
SRV-2 → EVT-1 → PLAYER-1 → PRES-1 → PRES-2 → PRES-3
EVT-1 → LOG-1;  INFRA-6 — поперёк всех мутаций
```

**Definition of Done для P0 (vertical slice):** оператор разворачивает панель одной командой → проходит wizard → логинится через Steam и становится Owner → устанавливает Squad-сервер через UI → сервер стартует и виден в Steam Browser → реальный игрок заходит и появляется в панели (карточка, события, presence) → Owner создаёт роль, выдаёт её игроку → запись появляется в Admins.cfg всех серверов и применяется in-game без рестарта (через AdminReloadServerConfig) → всё это видно в audit log → ночной backup восстановим.


---

# Дополнения: функциональность из анализа конкурента (SQSTAT)

Новые задачи, покрывающие функциональность, присутствующую у конкурента SQSTAT (`breaking.sqstat.ru`), но отсутствующую в исходной декомпозиции. Функциональность адаптирована под архитектуру проекта (PostgreSQL/uuid, RBAC, bridge, воркеры, RCON, парсинг логов); технологии конкурента (PHP/jQuery/MySQL) не переносятся. Каждая задача содержит блок «Контекст (SQSTAT)» со ссылкой на главу `ai_docs/rival-analysis/`.


---

# WS-17. Кланы (из анализа SQSTAT)

### CLAN-1. Модель данных кланов: clans + clan_members [P1]
**Контекст (SQSTAT):** У конкурента клан — полноценная сущность (`clan.data`: name, tags[], expire, max слотов, protected, public, discord_id) с ростером на 45+ участников и ролями Глава/Зам (глава 18, §3.1; глава 91, §6.6). У нас кланов нет вообще; GAME-2 уже ссылается на «clan tags», не имея источника данных.
**Что сделать:** Миграции. Таблица `clans`: `id uuid v7 PK`, `name text NOT NULL UNIQUE (≤32)`, `tags text[] NOT NULL DEFAULT '{}'` (уникальность тега глобально по всем кланам — partial-констрейнт/триггер, тег не может принадлежать двум кланам), `description text`, `max_priority_slots int NOT NULL DEFAULT 10`, `priority_expires_at timestamptz NULL` (NULL = бессрочно; монетизационное поле SQSTAT — платёжную интеграцию НЕ делаем, только срок), `is_tag_protected bool NOT NULL DEFAULT false`, `is_public bool NOT NULL DEFAULT false`, `primary_server_id uuid NULL FK servers`, `created_at`, `updated_at`, `deleted_at NULL` (soft-delete для истории). Таблица `clan_members`: `clan_id uuid FK clans`, `player_id uuid FK players.id` (НЕ steam_id64 — EOS-only игроки состоят в кланах наравне), `member_role text CHECK IN ('leader','deputy','member')`, `has_priority bool NOT NULL DEFAULT false`, `joined_at timestamptz`, PK `(clan_id, player_id)`, уникальный индекс `(player_id)` — игрок ровно в одном клане (модель SQSTAT), индекс `(clan_id, member_role)`. Констрейнт-триггер: ровно один `leader` на клан; COUNT(has_priority) ≤ `max_priority_slots`.
**Критерии приёмки:** повторное добавление игрока во второй клан отклоняется на уровне БД; понижение `max_priority_slots` ниже текущего числа приоритетов отклоняется с внятной ошибкой; тег, занятый другим кланом, не сохраняется; миграции идемпотентны и проходят на чистой БД.
**Зависимости:** INFRA-5, PLAYER-1.

### CLAN-2. API управления кланом: CRUD, rename, expire, настройки, disband + RBAC-гейт [P1]
**Контекст (SQSTAT):** Конкурент даёт создание/редактирование клана (`createSquad`), смену срока приоритета (`changeExpire` с пресетами +1/+3/+6 мес, год, бессрочно), тумблеры `public`/`protected` и удаление клана с 3-секундным cooldown на confirm (глава 18, §5, §6.1, §6.3).
**Что сделать:** Новый panel-флаг роли `can_manage_clans` (добавить в модель ROLE-1 и редактор ролей). Endpoints: `POST /api/v1/clans` (create), `PATCH /api/v1/clans/{id}` (name/description/tags/max_priority_slots/primary_server_id — rename это PATCH name), `PATCH /api/v1/clans/{id}/settings` (`is_public`, `is_tag_protected`), `PATCH /api/v1/clans/{id}/expire` (`priority_expires_at`, пресеты считает фронт), `DELETE /api/v1/clans/{id}` (disband = soft-delete + снятие всех клан-приоритетов через CLAN-4). Двухуровневый доступ: полный — `can_manage_clans`; лидер/зам клана (по `clan_members.member_role`) может PATCH description и настройки своего клана, но не expire/max/tags/disband. Каждая мутация → `audit_log` (before/after). Валидация: name ≤32, tags без запятых, `max_priority_slots` 0–999.
**Критерии приёмки:** пользователь без `can_manage_clans` и без лидерства получает 403; лидер меняет description своего клана, но получает 403 на `expire` и на чужой клан; disband снимает приоритеты и клан исчезает из директории, но записи `clan_members` доступны в истории; все мутации видны в audit_log с корректной hash-chain.
**Зависимости:** CLAN-1, ROLE-1, INFRA-6.

### CLAN-3. Ростер: поиск, add/remove, роли участников, передача лидерства [P1]
**Контекст (SQSTAT):** Ростер управляется через `findPlayer` (поиск ≥3 символов по нику/SteamID/тегу, debounce 300 мс), `addPlayer` с ролью прямо из результатов поиска (add-as-leader/add-as-deputy), `removePlayer` с confirm; «transfer ownership» реализован сменой `type` участника (глава 18, §2.4, §5, §6.2).
**Что сделать:** Endpoints: `GET /api/v1/clans/{id}/members` (ростер: player_id, ник, steam_id64/eos_id, member_role, has_priority, joined_at, last_seen и 60-дневный онлайн из `player_daily_presence` — server-side пагинация и сортировка, в отличие от SQSTAT); `GET /api/v1/players/search?q=` переиспользовать/расширить из PLAYER-6 — в ответе добавить `clan_id` кандидата (уже в клане → добавление заблокировано в UI); `POST /api/v1/clans/{id}/members` (`player_id`, `member_role`); `DELETE /api/v1/clans/{id}/members/{player_id}`; `PATCH /api/v1/clans/{id}/members/{player_id}` (`member_role`). Передача лидерства: `POST /api/v1/clans/{id}/transfer-leadership` (`player_id`) — атомарно в транзакции: старый leader → deputy, новый → leader. Права: `can_manage_clans` — всё; leader — add/remove/roles/transfer в своём клане; deputy — add/remove рядовых. Удаление участника снимает его клан-приоритет (CLAN-4). Все мутации → audit_log.
**Критерии приёмки:** transfer атомарен (искусственный сбой между шагами не оставляет клан с 0 или 2 лидерами); deputy не может удалить leader; удаление участника с приоритетом освобождает слот и уходит в очередь синка whitelist; поиск находит EOS-only игрока без steam_id64.
**Зависимости:** CLAN-1, CLAN-2, PLAYER-6 (поиск; если PLAYER-6 не готов — минимальный поиск внутри задачи), PRES-2.

### CLAN-4. Клан-приоритет: пул слотов + интеграция с whitelist/reserve [P1/P2]
**Контекст (SQSTAT):** Ядро клановой фичи конкурента: участникам из пула `max` слотов выдаётся приоритет очереди чекбоксом (`vipPlayer`), счётчик «35 из 999»; `vip_mode==2` показывает приоритет «из иного источника» неизменяемым (глава 18, §3.2, §4, §7). У нас reserve уже идёт через RBAC/whitelist (WL-1, SYNC-2/3) — клан-приоритет надо положить поверх этого механизма, а не рядом.
**Что сделать:** P1: `PUT /api/v1/clans/{id}/members/{player_id}/priority` (`enabled: bool`) — переключает `clan_members.has_priority` с проверкой пула (`COUNT ≤ max_priority_slots`) и `priority_expires_at > now()`. Материализация: включение/выключение ставит задачу в очередь синка (SYNC-1) — игрок попадает в managed-сегмент Admins.cfg с permission `reserve` (генератор SYNC-2 расширить источником `clan_priority` рядом с ролями; строка помечается комментарием источника). Просроченный `priority_expires_at` → worker (расширение AUTO-2-scheduler или отдельный cron-worker) снимает материализацию всех приоритетов клана, не трогая `has_priority` (при продлении срока приоритеты возвращаются). Конфликт источников: если у игрока reserve уже есть от роли — UI показывает замок «приоритет из другого источника» (аналог `vip_mode==2`), toggle заблокирован. P2: карточка игрока (PLAYER-4) показывает источник reserve: «роль X» / «клан Y».
**Критерии приёмки:** включение приоритета появляется в Admins.cfg после синка и пропадает при выключении/удалении из клана/disband; попытка включить сверх пула → 409 с текстом про лимит; истечение `priority_expires_at` убирает всех из cfg в течение интервала worker'а, продление возвращает без ручных действий; у игрока с reserve-ролью клан-toggle заблокирован и синк не создаёт дубль строки.
**Зависимости:** CLAN-1, CLAN-3, SYNC-2, SYNC-3, WL-1, ROLE-2.

### CLAN-5. Tag protection: авто-кик самозванцев с клан-тегом [P2]
**Контекст (SQSTAT):** Флаг `protected` («Защита тега») автоматически кикает игроков, носящих зарегистрированные теги клана, но не состоящих в ростере; списки обновляются каждые ~10 минут — сильная анти-имперсонация фича (глава 18, §3.1, §8).
**Что сделать:** В worker-rcon (или отдельный worker clan-guard) цикл раз в 2–5 минут: `ListPlayers` по каждому серверу → для каждого онлайн-игрока проверить ник на префикс-совпадение с `tags` кланов, у которых `is_tag_protected = true` (нормализация ника как в PLAYER-2: сравнение case-insensitive, тег как префикс); совпадение + игрок отсутствует в `clan_members` этого клана → `AdminWarn "<id>" "Тег <tag> защищён кланом <name>. Смените ник."`, при повторном обнаружении через grace-период (настраиваемый, default 5 мин) → `AdminKick` с той же причиной. Каждый warn/kick → запись в `moderation_actions` (type `clan_tag_protection`, author = system) + audit_log. Kill-switch: глобальный флаг в настройках панели, выключающий механизм целиком. Исключение: игроки с panel_access не кикаются, только warn (защита от само-локаута админов).
**Критерии приёмки:** e2e на dev-сервере: игрок с чужим защищённым тегом получает warn, после grace-периода — kick, событие в moderation history; участник клана с тем же тегом не тронут; выключение `is_tag_protected` мгновенно останавливает кики; kill-switch работает.
**Зависимости:** CLAN-1, RCON-1, MOD-2, PLAYER-2.

### CLAN-6. Агрегированная статистика клана и график активности [P2]
**Контекст (SQSTAT):** Дашборд клана: 60-дневный bar chart онлайна с date-range, суммарный онлайн + boost-часы, primetime-окна, primary server, агрегированные kills/deaths/revives + K/D, топ-10 участников с подиумом топ-5 (глава 18, §2.3, §8).
**Что сделать:** `GET /api/v1/clans/{id}/stats?from=&to=` (default 60 дней): `chart[]` — дневной суммарный онлайн участников из `player_daily_presence` (SUM по текущему ростеру); `totals` — online_seconds, boost_seconds (PRES-4), primary server (сервер с max суммарного онлайна за период); `primetime[]` — переиспользовать алгоритм PRES-5 на агрегате клана; `combat` — kills/deaths/revives/K:D суммой по участникам из stats-таблиц STATS-3 (при недоступности RNSquadJS — деградация: combat-блок скрыт, ответ помечен `combat_available: false`, без ошибки); `top[]` — топ-10 участников по kills за период. Экспорт `GET /api/v1/clans/{id}/stats/export?format=csv` (как downloadOnline у SQSTAT). Тяжёлые агрегаты кэшировать (materialized view `clan_daily_presence` с refresh раз в час или кэш в API, зафиксировать выбор в ADR-комментарии миграции). UI на карточке клана (CLAN-9): stacked bar chart с date-range пресетами, карточки totals, чипы primetime, подиум топ-5 + список топ-10. Доступ: panel_access.
**Критерии приёмки:** SUM chart == SUM totals за период (reconciliation-тест); ответ на клане из 50 участников за 365 дней < 1 с (только агрегаты, без сырых сессий); без STATS-3 страница рендерится без combat-блока и без ошибок в консоли; CSV скачивается и сходится с графиком.
**Зависимости:** CLAN-1, PRES-2, PRES-4, PRES-5, STATS-3 (опционально, graceful degradation), AN-1.

### CLAN-7. Онлайн-участники клана по серверам (live) [P2]
**Контекст (SQSTAT):** Панель per-server presence: по каждому серверу — участники клана онлайн с командой/фракцией и длительностью текущей сессии; позволяет заметить «клан-стак» на сервере (глава 18, §2.2, §8).
**Что сделать:** `GET /api/v1/clans/{id}/online`: `{server_id: [{player_id, name, team, squad, session_started_at}]}` — join открытых `player_sessions` (`disconnected_at IS NULL`) с `clan_members` + данные team/squad из RCON-снапшота MOD-1. WebSocket-топик `clan:{id}:online`: push при connect/disconnect участника (подписка из событий PRES-1). UI-блок на карточке клана: секция на сервер, строка участника с живым таймером сессии (тикает на клиенте), клик → карточка игрока. Один формат времени везде (секунды с сервера, форматирование на клиенте) — не воспроизводить баг SQSTAT со смешанными секундами/миллисекундами.
**Критерии приёмки:** заход/выход участника отражается в открытой странице клана без перезагрузки < 5 с; сервер без участников онлайн показывает явный empty-state; таймер сессии совпадает с фактическим временем ±1 мин.
**Зависимости:** CLAN-1, PRES-1, MOD-1.

### CLAN-8. История матчей клана [P2]
**Контекст (SQSTAT):** Дашборд показывает последние 10 игр клана: карта, команды, тикеты, победитель, seed-флаг и число участников клана в матче (глава 18, §2.3 `Game`).
**Что сделать:** `GET /api/v1/clans/{id}/matches?page=` — матчи (источник: события `match.started/ended` из EVT-1; слой матчей — таблица `matches`, если её ещё нет к моменту реализации, создать в этой задаче: `id uuid, server_id, map, started_at, ended_at, team1, team2, tickets1, tickets2, winner, is_seed`), где ≥1 участник клана имел пересекающуюся по времени сессию на этом сервере; в ответе — `clan_participants_count` и список участников. Пагинация server-side. UI-таблица на карточке клана: карта, сервер, счёт тикетов, победитель (подсветка), участники клана (аватар-чипы), длительность; фильтр по серверу; клик → страница матча (если есть из EVT-2/STATS-4) или expand-детали.
**Критерии приёмки:** матч с двумя участниками клана показывает `clan_participants_count = 2`; матч без участников не попадает в список; seed-матчи помечены; пагинация стабильна при новых матчах (keyset или created_at cursor).
**Зависимости:** CLAN-1, EVT-1, PRES-1.

### CLAN-9. UI: директория кланов и карточка клана [P1]
**Контекст (SQSTAT):** У конкурента клан — центральная страница с дашбордом, ростером, presence и настройками; вход из любого упоминания клана в приложении (глава 18, §1). Нужен эквивалент в нашем web с dark mode и i18n.
**Что сделать:** Страница `/clans` (директория): таблица кланов — имя, теги (чипы), участников, занято/всего приоритет-слотов, срок приоритета (badge «истёк»/«через N дней»/«бессрочно»), primary server; поиск по имени/тегу; кнопка «Создать клан» (модал CLAN-2) для `can_manage_clans`. Страница `/clans/{id}` (карточка): header (имя, теги, badges приоритета и tag-protection, счётчик слотов «N из M»), tabs: «Обзор» (статистика CLAN-6 + online CLAN-7), «Ростер» (таблица CLAN-3: server-side sort/пагинация, роль-badge Глава/Зам, toggle приоритета с optimistic UI и revert-on-error + блокировкой на 3 с как у SQSTAT, кнопка удаления с confirm, модал добавления с live-поиском ≥3 символов и debounce 300 мс, выбор роли при добавлении), «Матчи» (CLAN-8), «Настройки» (CLAN-2: rename, description, теги-чипы, слоты, expire с пресетами, тумблеры public/protected, danger-zone disband с confirm + 3-секундный cooldown). Виджет «Клан» на карточке игрока PLAYER-4 (имя-ссылка + роль в клане). Экспорт ростера CSV. Все строки через i18n EN/RU, dark mode, mobile-friendly (таблицы — горизонтальный скролл в контейнере).
**Критерии приёмки:** browser-evidence всех вкладок и всех мутаций (create → add member → toggle priority → rename → disband) на обеих локалях; toggle приоритета при ошибке API откатывается визуально; пользователь без прав видит карточку read-only без управляющих элементов; директория из 100 кланов пагинируется.
**Зависимости:** CLAN-2, CLAN-3, CLAN-4, CLAN-6, CLAN-7, CLAN-8, PLAYER-4, UX-2.

### CLAN-10. Публичные страницы кланов [P3]
**Контекст (SQSTAT):** Флаг `public` открывает read-only страницу клана не-редакторам, явно исключая информацию о приоритете очереди (глава 18, §3.1, §7).
**Что сделать:** В рамках публичного слоя AN-2: `GET /public/clans/{id}` для кланов с `is_public = true` — без сессии панели, отдельный rate-limited read-only слой. Содержимое: имя, теги, описание, ростер (только ник и роль в клане — без SteamID, приоритетов, last_seen, IP), график активности и суммарная статистика (CLAN-6 без boost), история матчей. Клан с `is_public = false` → 404 (не 403, не раскрывать существование). SEO-минимум: title/og-теги. Выключение флага мгновенно закрывает страницу.
**Критерии приёмки:** публичная страница не содержит SteamID/EOS/приоритетов ни в HTML, ни в JSON-ответах (проверка тестом на весь payload); приватный клан отдаёт 404 анонимно, но открывается авторизованному с panel_access по обычному URL; rate limit срабатывает.
**Зависимости:** CLAN-6, CLAN-8, CLAN-9, AN-2.


---

# WS-18. Метки подозреваемых и комментарии админов (из анализа SQSTAT)

### MARK-1. Модель меток подозрения + API [P1]
**Контекст (SQSTAT):** У конкурента на игрока вешается одна скалярная метка подозрения (enum 1–8: WallHack, AimBot, SpeedHack, спавн объектов, перезарядка, гриф, нелегальный конфиг, токсичность; 0 = снять), таксономия захардкожена в JS в двух местах, автор и история установки не хранятся (`create_date` есть, «кто» — нет) — это их задокументированная слабость (rival-analysis/sections/08-notes-suspects.md §3, §6–7). Переносим функциональность и закрываем оба пробела: автор-атрибуция и несколько активных меток одновременно.
**Что сделать:** Две таблицы. `mark_types` (`id smallint PK`, `slug text UNIQUE`, `label_en text`, `label_ru text`, `icon text`, `severity smallint`, `is_active bool DEFAULT true`, `sort_order smallint`) — сидируется миграцией восемью типами SQSTAT (slug'и: `wallhack`, `aimbot`, `speedhack`, `object_spawn`, `reload_exploit`, `griefing`, `illegal_config`, `toxic`). `player_marks` (`id uuid v7 PK`, `player_id uuid NOT NULL FK players.id`, `mark_type_id smallint FK mark_types.id`, `comment text NULL (≤512)`, `created_by uuid NOT NULL FK players.id`, `created_at timestamptz`, `cleared_by uuid NULL FK players.id`, `cleared_at timestamptz NULL`, `clear_reason text NULL`); активная метка = строка с `cleared_at IS NULL`; частичный уникальный индекс `UNIQUE(player_id, mark_type_id) WHERE cleared_at IS NULL` — у игрока может быть несколько активных меток разных типов (в отличие от SQSTAT), но не дубли одного типа. Снятие метки — UPDATE `cleared_by/cleared_at`, строки никогда не удаляются (полная история «кто/когда поставил и снял»). API: `POST /api/v1/players/{id}/marks` (body: `mark_type_id`, `comment?`), `DELETE /api/v1/players/{id}/marks/{mark_id}` (body: `clear_reason?`), `GET /api/v1/players/{id}/marks?include_cleared=true|false`, `GET /api/v1/mark-types`. RBAC-гейт: установка/снятие — `panel_access` (как у SQSTAT: планка ниже карательных действий); автор всегда штампуется из сессии, клиент его не передаёт. Каждая установка/снятие пишется в `audit_log` (before/after). Повторная установка активного типа → 409.
**Критерии приёмки:** на игрока ставятся две метки разных типов, дубль типа → 409; снятие сохраняет строку с `cleared_by/cleared_at` и видно в `include_cleared=true`; в `audit_log` есть записи и на set, и на clear с актором; EOS-only игрок (steam_id64 NULL) помечается без ошибок; пользователь без `panel_access` → 403.
**Зависимости:** INFRA-5, INFRA-6, PLAYER-1.

### MARK-2. UI меток на карточке игрока [P1]
**Контекст (SQSTAT):** Метка ставится в один клик из выпадающего меню в шапке модалки игрока (без confirm), активный пункт задизейблен, при активной метке рендерится пульсирующий warning-баннер с иконкой и подсвечивается строка игрока в таблицах (rival-analysis/sections/08-notes-suspects.md §5.2). Низкофрикционный ввод — сильная сторона, копируем.
**Что сделать:** На `/players/{id}` (PLAYER-4) добавить: (1) кнопку-дропдаун «Метки» со списком активных `mark_types` (иконка + локализованный label EN/RU), клик → `POST .../marks` без confirm, optimistic UI; уже активные типы показаны отмеченными, повторный клик по активному → снятие с мини-confirm (только для снятия); (2) баннер-блок активных меток под шапкой карточки: для каждой — иконка, label, кто и когда поставил, опциональный comment, кнопка «Снять»; (3) вкладку/секцию «История меток» (все строки включая снятые: тип, поставил/снял, даты, причины) — читается из `GET .../marks?include_cleared=true`; (4) badge-индикатор метки рядом с ником игрока во всех списках, где рендерится player-chip (`/players`, онлайн-список, событийные таблицы) — приглушённая подсветка строки как у SQSTAT `player_mark`. Изменение метки пушится по WebSocket, открытые карточки/списки обновляются без reload. Тёмная тема и i18n EN/RU обязательны.
**Критерии приёмки:** установка метки из дропдауна мгновенно отражается в баннере и в открытом у второго админа списке (WebSocket, без reload); история показывает снятые метки с авторами обеих операций; badge виден в `/players` у помеченного игрока.
**Зависимости:** MARK-1, PLAYER-4.

### MARK-3. Страница watchlist подозреваемых `/suspects` [P1]
**Контекст (SQSTAT):** Отдельная nav-страница «Метки» — глобальный реестр всех помеченных игроков: ник, last seen, иконка причины, статус бана; мультиселект-фильтр по типам метки (OR); клик по строке открывает карточку. Это готовая очередь триажа «подозреваемый, но ещё не наказанный» (rival-analysis/sections/08-notes-suspects.md §1, §4.2, §7).
**Что сделать:** Страница `/suspects` (gate: `panel_access`) поверх `GET /api/v1/suspects` — серверная выборка игроков с ≥1 активной меткой. Колонки: ник (цвет роли), SteamID64/EOS-индикатор, активные метки (иконки с tooltip: тип + кто/когда поставил), last_seen_at, статус бана (активен/нет — из данных модерации MOD-2), дата первой активной метки. Фильтры: мультиселект по типам метки (OR), текстовый поиск по нику (включая историю ников через name_history), чекбокс «только без активного бана» (тот самый триаж, которого у SQSTAT нет). Сортировка по last_seen_at и дате метки, keyset-pagination. Клик по строке → `/players/{id}`. Пункт в навигации с counter активных подозреваемых.
**Критерии приёмки:** игрок с двумя активными метками отображается одной строкой с двумя иконками; фильтр «AimBot OR WallHack» + «без бана» возвращает корректное пересечение; поиск по старому нику находит помеченного игрока; снятие последней метки убирает игрока со страницы (WebSocket или рефетч).
**Зависимости:** MARK-1, MARK-2, MOD-2, PLAYER-2.

### MARK-4. Управление таксономией меток [P2]
**Контекст (SQSTAT):** Таксономия из 8 типов захардкожена клиентски и продублирована в фильтре и модалке — «a competitor could make the taxonomy dynamic» (rival-analysis/sections/08-notes-suspects.md §3, §7). Делаем справочник редактируемым.
**Что сделать:** UI в настройках `/settings/mark-types` (gate: `can_edit_roles` — администрирование справочников панели, отдельный флаг не вводим): список типов с drag-sort (`sort_order`), редактирование `label_en/label_ru/icon/severity`, создание нового типа, деактивация (`is_active=false`) вместо удаления — исторические `player_marks` ссылаются на тип всегда; деактивированный тип пропадает из дропдауна установки, но остаётся в фильтрах и истории. Восемь сидированных типов редактируемы, но не удаляемы (только деактивация). API: `POST/PATCH /api/v1/mark-types`, мутации в audit_log. Иконки — фиксированный набор из иконочного шрифта панели (select-пикер).
**Критерии приёмки:** новый тип сразу доступен в дропдауне MARK-2 без деплоя; деактивация типа не ломает `/suspects` и историю меток; пользователь без `can_edit_roles` → 403.
**Зависимости:** MARK-1, ROLE-1.

### PNOTE-1. Заметки админов: модель, per-player история и лента на карточке [P1]
**Контекст (SQSTAT):** Комментарии — append-only заметки ≤256 символов, автор штампуется сервером, доступны из слайд-аута модалки на любой странице, с count-badge; редактирования/удаления нет, тело двойно-эскейпится (rival-analysis/sections/08-notes-suspects.md §2.2, §5.1, §7). PLAYER-6 уже включает «Player notes (CRUD + audit)» — эта задача формализует модель и добавляет per-player историю на карточке, не дублируя PLAYER-6 (см. amendment).
**Что сделать:** Единая модель для notes из PLAYER-6: таблица `player_notes` (`id uuid v7 PK`, `player_id uuid NOT NULL FK players.id`, `author_id uuid NOT NULL FK players.id`, `body text NOT NULL (trim non-empty, ≤2000)`, `created_at`, `updated_at NULL`, `deleted_at timestamptz NULL`, `deleted_by uuid NULL`). Превосходим SQSTAT: multiline-body до 2000 символов, редактирование автором (`updated_at` + пометка «изменено»), soft-delete (автором или `can_edit_roles`), тело хранится как plain text без HTML-эскейпа в БД (эскейп только при рендере). API: `POST /api/v1/players/{id}/notes`, `PATCH /api/v1/notes/{note_id}`, `DELETE /api/v1/notes/{note_id}` (soft), `GET /api/v1/players/{id}/notes` (desc, keyset-pagination, soft-deleted скрыты). Gate: чтение/создание — `panel_access`; автор из сессии. Все мутации → audit_log (before/after). UI на `/players/{id}`: секция «Заметки» — лента (автор с цветом роли, относительная дата, body), композер с Enter/кнопкой, count-badge с числом заметок в шапке карточки; пустое состояние «Нет заметок». Новая заметка появляется у других открытых карточек по WebSocket.
**Критерии приёмки:** заметка от второго админа появляется в открытой карточке без reload; заметка с кавычками/`<script>` рендерится литерально (без XSS и без `&quot;`-артефактов); редактирование чужой заметки без `can_edit_roles` → 403; soft-deleted не возвращается в списке, но её before/after есть в audit_log; count-badge инкрементится сразу после отправки.
**Зависимости:** INFRA-5, INFRA-6, PLAYER-4.

### PNOTE-2. Глобальная лента заметок `/notes` [P2]
**Контекст (SQSTAT):** Страница «Комментарии» — кросс-игровой аудит-фид всех заметок всех админов (1090 строк живьём), с поиском по целевому игроку, по автору-админу и по тексту; двойное назначение — накопленное знание о игроках и подотчётность стаффа (rival-analysis/sections/08-notes-suspects.md §1, §4.1, §7).
**Что сделать:** Страница `/notes` (gate: `panel_access`) поверх `GET /api/v1/notes` — все заметки по всем игрокам, desc, keyset-pagination. Колонки: дата, автор (цвет роли), целевой игрок (клик → `/players/{id}`), текст (truncate + expand). Фильтры: текстовый поиск по body (pg `ILIKE`/trigram-индекс), по нику целевого игрока (с учётом name_history), по автору (select из пользователей с ролью), date-range. Для аудита стаффа: переключатель «показывать удалённые» (видит только `can_edit_roles`; удалённые — зачёркнуты, с «кем удалено»). Экспорт текущей выборки в CSV.
**Критерии приёмки:** поиск по фрагменту текста + фильтр по автору работают вместе; клик по строке ведёт на карточку игрока с открытой секцией заметок; без `can_edit_roles` удалённые не видны ни в UI, ни в API-ответе; CSV соответствует активным фильтрам.
**Зависимости:** PNOTE-1, ROLE-2.


---

# WS-18. Забаненные ники и общая сеть банов (из анализа SQSTAT)

### BANNAME-1. Правила бана по никнейму: модель + CRUD + UI [P1]
**Контекст (SQSTAT):** У SQSTAT есть страница «Забаненные ники» (`bannames`, ~371 правило в живой инсталляции): чёрный список ников, `addBanName`/`removeBanName` доступны с любой страницы. У конкурента хранится только literal-строка без типа матчинга, автора и причины — мы фиксируем это как gap и делаем богаче (rival-analysis/sections/10-banname-collab.md §10.2, §10.5).
**Что сделать:** Таблица `banned_name_rules`: `id uuid`, `pattern text NOT NULL`, `match_type enum('exact','substring','regex') NOT NULL DEFAULT 'exact'` (exact — case-insensitive полное совпадение; substring — case-insensitive вхождение; regex — PCRE-подмножество), `reason text NULL`, `action enum('kick','alert') NOT NULL DEFAULT 'kick'`, `is_active bool DEFAULT true`, `created_by uuid REFERENCES players(id)`, `created_at`, `hit_count int DEFAULT 0`, `last_hit_at timestamptz NULL`. Уникальность `(pattern, match_type)`. Для regex — валидация на сервере при сохранении: компиляция + защита от ReDoS (лимит длины паттерна 256, выполнение матчинга с таймаутом/через RE2-совместимую библиотеку); невалидный regex → 422 с текстом ошибки. API: `GET/POST /api/v1/banned-names`, `PATCH/DELETE /api/v1/banned-names/{id}`; листинг с поиском по pattern, фильтром по match_type/is_active, пагинацией. RBAC-гейт: чтение — `panel_access`; мутации — роль содержит squad-permission `ban`. Каждая мутация → `audit_log` (before/after). UI-страница `/banned-names`: таблица (паттерн, тип, действие, причина, автор, добавлен, hits), модалка добавления с выбором типа матчинга, live-превью «проверить ник против правила» (поле для тестовой строки), пустой submit невозможен (в отличие от SQSTAT — у них нет валидации вообще). Dark mode, i18n EN/RU.
**Критерии приёмки:** правило каждого из трёх типов создаётся, редактируется и удаляется с записью в audit_log; невалидный regex и пустой pattern отклоняются с 422; пользователь без squad-permission `ban` получает 403 на мутации, но видит список; превью корректно показывает match/no-match для всех трёх типов.
**Зависимости:** INFRA-5, INFRA-6, ROLE-1.

### BANNAME-2. Enforcement: автокик по нику при подключении [P1]
**Контекст (SQSTAT):** У конкурента применение bannames делает серверный «бот» — игрок с запрещённым ником авто-обрабатывается при заходе; панель лишь ведёт список (rival-analysis/sections/10-banname-collab.md §10.1). Мы реализуем enforcement внутри своего пайплайна log-ingest + RCON, без внешнего бота.
**Что сделать:** В worker log-ingest на событии `player.connected` (и на смене ника, если EVT-1 её эмитит) прогонять актуальный ник через активные правила `banned_name_rules` (кэш правил в памяти воркера, инвалидация по NOTIFY/поллингу раз в 30 с; порядок проверки exact → substring → regex, первый матч побеждает). При матче: если `action='kick'` — через worker-rcon `AdminKick "<eos_id|steam_id64>" <причина>` (шаблон сообщения игроку в настройках, RU/EN, с указанием причины правила); если `action='alert'` — только уведомление. В обоих случаях: запись в `events` (тип `banname.matched`, payload: player_id, rule_id, nickname), инкремент `hit_count`/`last_hit_at` правила, запись в `moderation_actions` (type `name_kick`, author_player_id NULL = система, reason из правила), WebSocket-пуш админам онлайн. Анти-петля: cooldown — не кикать того же `player_id` по тому же правилу чаще 1 раза в 60 с; после 3 киков подряд за 10 минут — эскалация в alert-канал (AUTO-3) «игрок переподключается с запрещённым ником», без автобана (автобан — сознательно вне scope, решает админ).
**Критерии приёмки:** e2e — игрок с ником, попадающим под substring-правило, кикается в течение ≤10 с после появления `player.connected` в логе; `hit_count` растёт; событие видно в ленте событий и в moderation history игрока; cooldown предотвращает kick-loop (проверено симуляцией повторных connect); alert-правило не кикает, но пушит уведомление.
**Зависимости:** BANNAME-1, EVT-1, RCON-1, MOD-2.

### BANNAME-3. Quick-add ника из любого контекста + бейдж на карточке [P2]
**Контекст (SQSTAT):** `addBanName`/`removeBanName` доступны из контекстного меню практически на каждой странице — админ блокирует ник там, где его увидел; на карточке игрока есть флаг `name_banned` (rival-analysis/sections/10-banname-collab.md §10.2.3, 09-bans.md §2.2). Низкофрикционная модерация, стоит перенести.
**Что сделать:** Кнопка «Забанить ник» в: карточке игрока (PLAYER-4, для текущего ника и каждого ника из истории PLAYER-2), live-списке игроков (MOD-1 через MOD-2-панель действий), chat viewer. Кнопка открывает предзаполненную модалку BANNAME-1 (pattern = ник, match_type = exact, редактируемо) — не мгновенный silent-инсерт, чтобы админ видел, что создаёт. Если текущий ник игрока уже матчится активным правилом — на карточке игрока бейдж «Ник забанен» со ссылкой на правило и кнопкой «Разбанить ник» (деактивация правила, audit). На странице `/banned-names` в строке правила — счётчик срабатываний и ссылка «последние срабатывания» (фильтрованная лента `events` по rule_id). RBAC — как в BANNAME-1 (squad-permission `ban`).
**Критерии приёмки:** из карточки игрока и из истории ников правило создаётся в 2 клика; бейдж «Ник забанен» появляется/исчезает при активации/деактивации правила; переход «правило → срабатывания» показывает корректно отфильтрованные события.
**Зависимости:** BANNAME-1, BANNAME-2, PLAYER-2, PLAYER-4.

### CBAN-1. Внешние источники банов: модель + управление подписками [P1]
**Контекст (SQSTAT):** «Ру-Баны» (`collabans`) — федеративный реестр ~17 510 забаненных игроков, агрегированный из множества сообществ; каждая запись атрибутирована источником (community, admin, reason, даты, cnt). Синхронизация у конкурента серверная и непрозрачная (rival-analysis/sections/10-banname-collab.md §10.3, §10.5). Мы делаем механизм подписки явным и управляемым. Конкретизирует INT-3.
**Что сделать:** Таблицы: `external_ban_sources` (`id uuid`, `name text`, `url text`, `format enum('squad_bans_cfg','battlemetrics_json','json_generic','csv')`, `auth_header text NULL` (секрет — только в БД, в API не отдаётся), `trust_level enum('trusted','normal','low') DEFAULT 'normal'`, `discord_url text NULL`, `enabled bool`, `poll_interval_minutes int DEFAULT 60 CHECK (>=15)`, `last_sync_at`, `last_sync_status enum('ok','error') NULL`, `last_sync_error text NULL`, `imported_count int DEFAULT 0`, `created_at`) и `external_bans` (`id uuid`, `source_id uuid FK`, `steam_id64 text NULL`, `eos_id text NULL`, `CHECK (steam_id64 IS NOT NULL OR eos_id IS NOT NULL)`, `nickname text NULL`, `reason text NULL`, `admin_name text NULL`, `issued_at timestamptz NULL`, `expires_at timestamptz NULL` (NULL = перманентный), `raw jsonb`, `imported_at`, `revoked_at timestamptz NULL`, UNIQUE `(source_id, coalesce(steam_id64,''), coalesce(eos_id,''), coalesce(issued_at,'epoch'))`). Важно: внешние баны НЕ имеют FK на `players` — игрок может быть не известен панели; связывание с `players.id` выполняется lookup'ом по steam_id64/eos_id на чтении (индексы по обоим полям). API: CRUD `/api/v1/ban-sources` + `POST /api/v1/ban-sources/{id}/sync` (ручной запуск). RBAC-гейт: НОВЫЙ panel-флаг `can_manage_ban_sources` в ролях (мутации источников); чтение агрегата — `panel_access`. Все мутации источников → audit_log. UI: страница `/settings/ban-sources` — карточки источников: имя, trust-бейдж, discord-ссылка, статус последнего синка (ok/error + текст ошибки), счётчик записей, свитч enabled, кнопка «Синхронизировать сейчас».
**Критерии приёмки:** источник создаётся/редактируется/выключается только при наличии `can_manage_ban_sources` (иначе 403); auth_header никогда не возвращается в API-ответах; миграции и уникальный индекс дедупликации работают (повторный импорт той же записи не создаёт дубль); ROLE-редактор (ROLE-1) показывает новый флаг.
**Зависимости:** INFRA-5, INFRA-6, ROLE-1.

### CBAN-2. Worker ban-sync: периодический импорт и merge [P1]
**Контекст (SQSTAT):** У конкурента пул collabans пополняется server/bot-side без клиентского «sync now»; панель — только читатель агрегата (rival-analysis/sections/10-banname-collab.md §C-D, §10.3.5). Мы реализуем импорт как наблюдаемый воркер с адаптерами форматов.
**Что сделать:** Новый worker `ban-sync` (или job внутри существующего workers-процесса — решить при имплементации по образцу config-sync): по `poll_interval_minutes` каждого enabled-источника скачивает список и парсит адаптером формата: `squad_bans_cfg` — строки `Banned:<SteamID64>:<unix-expiry>` (0 = перманент, опциональный префикс админа и `// комментарий` — парсить в admin_name/reason, формат подтверждён корректировкой №4 декомпозиции); `battlemetrics_json` и `json_generic` — маппинг полей по конфигу источника; `csv` — колонки по конфигу. Merge-семантика: upsert по уникальному ключу; записи, исчезнувшие из источника, помечаются `revoked_at = now()` (не удаляются — история); протухшие по `expires_at` считаются неактивными на чтении. Ограничения устойчивости: таймаут скачивания 30 с, лимит размера 20 МБ, невалидные строки скипаются со счётчиком в отчёте синка; ошибка источника → `last_sync_status='error'` + текст, экспоненциальный backoff, alert через AUTO-3 после 3 подряд неудач. Каждый синк пишет summary-событие в `events` (тип `bansync.completed`: source_id, added/updated/revoked/skipped) и метрики (Prometheus: длительность, размер, ошибки). Ручной `POST .../sync` ставит задачу вне очереди.
**Критерии приёмки:** источник в формате Bans.cfg импортируется корректно (перманент/временный/с комментарием — все три варианта покрыты тестами); повторный синк без изменений даёт 0 added/updated; удаление строки из источника приводит к `revoked_at`, а не к DELETE; упавший источник виден на `/settings/ban-sources` с текстом ошибки и алертит после 3 неудач.
**Зависимости:** CBAN-1, AUTO-3.

### CBAN-3. Агрегированный реестр + «найден в N внешних банлистах» на карточке [P2]
**Контекст (SQSTAT):** Киллер-фича конкурента: строка игрока агрегирует баны из многих сообществ, каждая карточка несёт имя источника, админа, причину, тип (перманент/временный), дату; `checkBans` по клику показывает статус игрока по всем сообществам. Это shared reputation intelligence (rival-analysis/sections/10-banname-collab.md §10.4 п.1–3, 09-bans.md §C-5).
**Что сделать:** Endpoint `GET /api/v1/players/{id}/external-bans` — по steam_id64/eos_id игрока собирает активные и исторические записи из `external_bans`, группирует по источнику: `{source: {name, trust_level, discord_url}, bans: [{reason, admin_name, issued_at, expires_at, is_active}], total}`. Страница `/external-bans` (аналог collabans-браузера): серверная пагинация, поиск по нику/SteamID64/EOS ID/причине, фильтр «только перманентные», фильтр по источнику; строка = игрок (ник или бейдж «нет ника»), список карточек по источникам; клик → карточка игрока, если игрок известен панели, иначе — просмотр raw-записи. Визуальный язык как у конкурента: перманент — красный бейдж, временный — янтарный; trust_level источника — отдельный бейдж (trusted/normal/low). На карточке игрока (PLAYER-4) — блок «Внешние банлисты»: свёрнутый бейдж «Найден в N внешних банлистах» (N = число источников с активным баном; 0 → зелёная галка «не найден»), по клику раскрывается per-source разбивка. RBAC: чтение — `panel_access`. Кэш агрегата не нужен (индексы по steam_id64/eos_id достаточны), но замерить p95 на 100k+ записей.
**Критерии приёмки:** игрок, присутствующий в двух источниках, показывает «Найден в 2 внешних банлистах» и две карточки с корректными trust/перманент-бейджами; EOS-only игрок (без steam_id64) матчится по eos_id; истёкший и revoked-бан не считаются активными, но видны в истории; поиск на `/external-bans` работает по всем четырём полям.
**Зависимости:** CBAN-2, PLAYER-4.

### CBAN-4. Проверка входящих при подключении (checkBans-on-join) [P2]
**Контекст (SQSTAT):** У конкурента `checkBans` — ручной запрос из модалки; enforcement внешних банов делает бот. Мы объединяем: автоматическая проверка каждого подключающегося против агрегированной базы с настраиваемой реакцией по trust-уровню источника (rival-analysis/sections/09-bans.md §C-4/C-5, 10-banname-collab.md §10.3.5).
**Что сделать:** В worker log-ingest на `player.connected` — lookup активных `external_bans` по steam_id64/eos_id игрока (кэш «горячего» множества id в памяти воркера, обновление после каждого синка CBAN-2). При матче — реакция по настройке источника: новое поле `on_match enum('none','alert','kick') DEFAULT 'alert'` в `external_ban_sources` (`kick` разрешён только при `trust_level='trusted'` — валидация на API). `alert`: WebSocket-пуш админам онлайн + уведомление AUTO-3 («игрок X найден в банлисте Y: причина»); `kick`: RCON `AdminKick` с сообщением из шаблона + запись в `moderation_actions` (type `external_ban_kick`, система как автор, reason = источник + причина). Всегда: событие `events` тип `externalban.matched` (player_id, source_id, external_ban_id). Автобан локально НЕ выполняется никогда — только kick/alert; локальный бан админ выносит вручную с карточки (кнопка «Забанить локально» с предзаполненной причиной из внешней записи → флоу MOD-2). Cooldown кика — как в BANNAME-2.
**Критерии приёмки:** подключение игрока из trusted-источника с `on_match='kick'` приводит к кику ≤10 с и записи в moderation history; `alert`-источник даёт уведомление без кика; попытка поставить `kick` на источник с trust_level≠trusted отклоняется 422; событие матча видно в ленте событий; «Забанить локально» открывает предзаполненную форму MOD-2.
**Зависимости:** CBAN-2, CBAN-3, EVT-1, RCON-1, MOD-2, AUTO-3.

### CBAN-5. Публикация собственного банлиста (outbound-федерация) [P3]
**Контекст (SQSTAT):** Федерация у конкурента двусторонняя, но серверная: локальные баны попадают в общий пул автоматически (rival-analysis/sections/10-banname-collab.md §C-D). Чтобы участвовать в сети банов как источник (а не только потребитель), панель должна уметь отдавать свой список наружу — тогда два инстанса нашей панели федерируются друг с другом через CBAN-1/CBAN-2 без центрального сервера.
**Что сделать:** Read-only endpoint `GET /api/v1/public/banlist?format=squad_cfg|json`, аутентификация bearer-токеном (выпуск/отзыв через механизм API-токенов AUTH-6, отдельный scope `banlist:read`), rate limit. Форматы: `squad_cfg` — строки `Banned:<SteamID64>:<unix-expiry>` + `// <reason>` (только игроки со steam_id64); `json` — полный вид с eos_id, nickname, reason, issued_at, expires_at, admin (без PII сверх этого: IP и комментарии админов не публикуются никогда). Настройки публикации на `/settings/ban-sources` (вкладка «Публикация»): master-свитч, что включать — все активные баны / только перманентные; отозванные и «erased»-баны не публикуются. Источник данных — `moderation_actions` type ban/unban (MOD-2). Выдача кэшируется (ETag/Last-Modified), каждый выпуск/отзыв токена → audit_log. RBAC настроек — `can_manage_ban_sources` (флаг из CBAN-1). Задокументировать формат в OpenAPI, чтобы чужой инстанс панели мог подписаться через CBAN-1 (`json_generic`).
**Критерии приёмки:** второй инстанс панели (или curl) с валидным токеном получает список в обоих форматах; unban убирает запись из выдачи; без токена/с отозванным токеном — 401; фильтр «только перманентные» соблюдается; IP-адреса и админ-комментарии отсутствуют в выдаче; e2e — инстанс A подписан на инстанс B через CBAN-1/CBAN-2 и видит его баны на `/external-bans`.
**Зависимости:** CBAN-1, CBAN-2, MOD-2, AUTH-6.


---

# WS-19. Репорты игроков и лог голосований (из анализа SQSTAT)

### REPORT-1. Приём in-game репортов (!report) и схема хранения [P1]
**Контекст (SQSTAT):** SQSTAT ведёт лог игровых репортов (`!report`): цель, текст, сервер, время — с переходом в карточку игрока (rival-analysis §14.5). При этом у конкурента нет ни личности репортёра, ни жизненного цикла — обе дыры закрываем сразу на уровне схемы (§14.8 «Gaps to beat»).
**Что сделать:** Таблица `player_reports`: `id uuid v7 PK`, `server_id FK`, `reporter_player_id uuid FK players.id NULL` (in-game репорт всегда имеет репортёра; NULL зарезервирован для анонимных источников), `target_player_id uuid FK players.id NULL` (репорт может не резолвиться в игрока), `target_raw text` (как цель названа в сообщении), `body text NOT NULL`, `source enum('ingame','ui')`, `status enum('pending','in_review','resolved','rejected') DEFAULT 'pending'`, `handler_player_id uuid FK NULL`, `resolution_note text NULL`, `created_at`, `claimed_at`, `resolved_at`. Индексы по `(status, created_at)`, `target_player_id`, `server_id`. В worker log-ingest — парсер chat-сообщений вида `!report <цель> <текст>` из SquadGame.log: записать событие в envelope `events` (type `player_report`) и создать строку в `player_reports`, резолвя репортёра и цель в `players.id` через алгоритм PLAYER-1 (EOS-only игроки поддерживаются). Дедупликация: повторный `!report` того же репортёра по той же цели в течение 5 минут не создаёт новую строку, а дописывает текст к существующей pending-записи. WebSocket-событие `report.created` для UI.
**Критерии приёмки:** `!report` в игровом чате в течение ≤5 с появляется строкой в `player_reports` с корректными uuid репортёра и цели; EOS-only репортёр/цель сохраняются; повторный репорт в окне дедупликации не плодит строки; событие видно в `events`.
**Зависимости:** INFRA-5, EVT-1, PLAYER-1.

### REPORT-2. API и очередь модерации репортов [P1]
**Контекст (SQSTAT):** У конкурента страница `reports` — плоский read-only список с фильтрами по нику/тексту/серверу и переходом в карточку игрока (§14.5). Очереди модерации нет вовсе — это заявленный дифференциатор (§14.8).
**Что сделать:** API: `GET /api/v1/reports` (фильтры: `status`, `server_id`, `target_player_id`, `reporter_player_id`, `q` — полнотекст по body, диапазон дат; сортировка по `created_at`; пагинация с настраиваемым page size), `GET /api/v1/reports/{id}`, `PATCH /api/v1/reports/{id}` (переходы статуса: `pending→in_review` (claim, проставляет `handler_player_id`+`claimed_at`), `in_review→resolved|rejected` с обязательным `resolution_note`; claim чужого `in_review` — 409, снять может сам обработчик или Owner). RBAC: просмотр — `panel_access`; claim/resolve/reject — НОВЫЙ panel-флаг роли `can_handle_reports`. Каждый переход статуса — запись в `audit_log` (before/after). UI-страница `/reports`: очередь карточками (сервер-тег, время, репортёр → цель, текст, статус-бейдж, обработчик), фильтры в сайдбаре, счётчик pending в навигации, live-добавление новых репортов по WebSocket; клик по репортёру/цели → карточка игрока. Dark mode, i18n EN/RU.
**Критерии приёмки:** очередь фильтруется по всем параметрам; claim блокирует двойную обработку; resolve без note невозможен; все переходы в audit_log; новый репорт появляется в открытой очереди без перезагрузки; флаг `can_handle_reports` реально запрещает мутации на API-уровне.
**Зависимости:** REPORT-1, ROLE-1, INFRA-6, PLAYER-4.

### REPORT-3. Связка репортов с модерацией и обратная связь репортёру [P1/P2]
**Контекст (SQSTAT):** У SQSTAT из ленты репортов один клик до полного арсенала бан/кик/сообщение через модалку игрока, а среди шаблонов сообщений есть «Ваш репорт рассматривается модерацией» (§14.6, §14.8) — тесную петлю «репорт → действие → ответ» нужно воспроизвести и формализовать.
**Что сделать:** P1: nullable-колонка `report_id uuid FK player_reports.id` в `moderation_actions`; на карточке репорта кнопки Warn/Kick/Ban по цели с предзаполненной причиной из текста репорта — действие идёт через механику MOD-2 и автоматически линкуется к репорту; на карточке репорта отображаются все связанные действия, на карточке игрока — репорты, где он цель. Кнопка «Уведомить репортёра»: `AdminWarn` репортёру с шаблоном («репорт принят в работу» / «репорт рассмотрен»), если он онлайн (проверка через MOD-1-poll). P2: автоуведомление репортёра при claim и при resolve/reject (если онлайн); группировка pending-репортов по одной цели («N репортов на игрока X» одним блоком) и массовый resolve группы одним действием с одним audit-контекстом.
**Критерии приёмки:** бан из карточки репорта виден и в moderation history игрока, и на карточке репорта; уведомление приходит репортёру в игру; групповой resolve закрывает все репорты группы и пишет audit по каждому.
**Зависимости:** REPORT-2, MOD-2, MOD-1, RCON-1.

### REPORT-4. Подача репорта из панели и evidence [P2]
**Контекст (SQSTAT):** У конкурента репорты попадают только из игры; подать репорт из панели или приложить доказательства нельзя (§14.5). Даём админам/модераторам второй канал с вложениями.
**Что сделать:** `POST /api/v1/reports` (`source='ui'`, `reporter_player_id` = текущий пользователь, цель — выбор игрока через поиск, текст обязателен); форма «Пожаловаться» на карточке игрока (PLAYER-4). Вложения: переиспользовать хранилище evidence из MOD-3 (скриншот/видео-ссылка/фрагмент chat log, те же лимиты) через таблицу `report_evidence (report_id, evidence_id)`; отображение вложений на карточке репорта. Гейт на создание — `panel_access`; audit на создание.
**Критерии приёмки:** репорт из UI появляется в общей очереди с `source='ui'` и вложениями; файлы отдаются только авторизованным; лимиты размера соблюдаются.
**Зависимости:** REPORT-2, MOD-3, PLAYER-4.

### REPORT-5. Аналитика репортов и trusted-reporter [P3]
**Контекст (SQSTAT):** Конкурент не отслеживает репортёров вообще — нет веса доверия, нет детекции репорт-спама, нет статистики по целям (§14.8 «Gaps to beat»).
**Что сделать:** Материализованные метрики: по репортёру — всего/resolved/rejected, доля подтверждённых (репорт resolved + связанное moderation action) → рейтинг доверия, бейдж «trusted» на карточке репорта; детекция спама (M rejected-репортов за окно → флаг и алерт через механику AUTO-3); по цели — счётчик репортов за 30/90 дней с подсветкой рецидивистов в очереди; секция на дашборде AN-1: динамика репортов, среднее время от `created_at` до `resolved_at` (SLA), топ целей, разрез по серверам, export CSV.
**Критерии приёмки:** рейтинг репортёра пересчитывается при resolve/reject; спам-флаг срабатывает на пороге и виден в очереди; SLA-график на дашборде совпадает с контрольной выборкой из БД.
**Зависимости:** REPORT-3, AN-1, AUTO-3.

### VOTE-1. Захват встроенных голосований Squad из SquadGame.log [P1]
**Контекст (SQSTAT):** SQSTAT пишет полный лог игровых голосований: инициатор, тип (пропуск/смена карты), карты current/next/target, собрано/необходимо, длительность, исход и даже полный поимённый список голосовавших — который его UI никогда не показывает (§14.3.2, §14.8). Забираем всё, включая «тёмные данные».
**Что сделать:** В worker log-ingest — парсер строк встроенных голосований Squad (map skip / map change / layer voting; admin-инициированные голосования учесть отдельным типом): начало голосования, отдельные голоса, завершение. Таблицы: `game_votes` (`id uuid v7 PK`, `server_id FK`, `initiator_player_id uuid FK players.id NULL`, `vote_type enum('map_skip','map_change','admin')`, `map_current`, `map_next NULL`, `map_target NULL`, `votes_collected int`, `votes_required int`, `result enum('passed','failed','cancelled')`, `duration_s int`, `started_at`, `ended_at`) и `game_vote_ballots` (`vote_id FK`, `player_id uuid FK players.id`, `choice enum('yes','no')`, `voted_at`; PK `(vote_id, player_id)`). Каждое голосование — также событие в envelope `events` (types `vote_started`/`vote_ended`). Незавершённое голосование при рестарте сервера закрывается как `cancelled`. WebSocket `vote.ended` для live-ленты. Перед реализацией — фиксация фактического формата лог-строк на актуальной версии Squad (мини-исследование в рамках задачи; результат — в ai_docs).
**Критерии приёмки:** инициированное в игре голосование появляется в `game_votes` с корректными initiator, картами, счётчиками и исходом; поимённые голоса лежат в `game_vote_ballots` с uuid игроков (EOS-only поддерживаются); рестарт сервера посреди голосования даёт `cancelled`, а не висящую запись.
**Зависимости:** INFRA-5, EVT-1, PLAYER-1.

### VOTE-2. UI лога голосований с фильтрами [P1]
**Контекст (SQSTAT):** Страница votes конкурента — карточки с бейджем исхода, тройкой карт и порогами, но фильтр только по серверу, без дат/типа/инициатора и без сортировки (§14.4, §14.8 «Thin filters»). Делаем то же, но с полноценными фильтрами и раскрытием ростера голосовавших.
**Что сделать:** API `GET /api/v1/votes` (фильтры: `server_id`, `vote_type`, `result`, `initiator_player_id` или поиск по нику, диапазон дат; сортировка по `started_at`; пагинация с настраиваемым page size) и `GET /api/v1/votes/{id}` (с ростером ballots). UI-страница `/votes`: карточки (сервер-тег, время, инициатор → карточка игрока, тип, бейдж исхода, собрано/необходимо, current → next → target с превью карт из существующих ассетов слоёв, длительность), раскрываемый список проголосовавших с переходом в карточки игроков; live-добавление завершённых голосований по WebSocket; на странице сервера — виджет «последние голосования». Гейт — `panel_access` (read-only, мутаций нет). Dark mode, i18n EN/RU.
**Критерии приёмки:** все фильтры и сортировка работают вместе с пагинацией; ростер раскрывается и ведёт на карточки игроков; новое голосование появляется в открытой ленте без перезагрузки; страница корректна на мобильном.
**Зависимости:** VOTE-1, PLAYER-4.

### VOTE-3. Аналитика голосований [P2]
**Контекст (SQSTAT):** Конкурент собирает поимённые данные голосований, но не анализирует их — per-server pass rate, повторные инициаторы скипов и участие игроков остаются «тёмными данными» (§14.8). Прямая возможность out-analyze.
**Что сделать:** Секция «Голосования» на дашборде AN-1: pass rate по серверам и по картам (какие карты чаще скипают), динамика количества голосований, топ инициаторов с долей успешных, распределение по времени суток; детекция «серийных скиперов» (N инициированных скипов за окно) с выводом флага на карточке игрока; на карточке игрока — счётчики «инициировал / участвовал в голосованиях»; export CSV/JSON. Источник — SQL-агрегаты по `game_votes`/`game_vote_ballots`, без внешних sidecar'ов.
**Критерии приёмки:** метрики совпадают с контрольными SQL-запросами; фильтр по серверу и периоду применяется ко всем графикам секции; флаг серийного скипера появляется при достижении порога и виден на карточке игрока.
**Зависимости:** VOTE-1, VOTE-2, AN-1.


---

# WS-18. Детект твинков/альтов и связи игроков (из анализа SQSTAT)

### ALT-1. Движок кандидатов в альты по общим IP + эвристики [P1]
**Контекст (SQSTAT):** «Поиск твинков» (`player→twink`, 03 §4.3, 92 §4) отдаёт список кандидатов с общими IP: имя, SteamID, флаг «Есть перманентный бан», список совпавших локаций с временем захода обоих аккаунтов и humanized-дельтой. Это признанный «standout anti-ban-evasion tool» конкурента и главный форензик-инструмент против обхода банов.
**Что сделать:** Endpoint `GET /api/v1/players/{id}/alt-candidates`. Ядро — SQL по `player_ip_history`: все `player_id`, деливщие хотя бы один `ip` с целевым игроком (`JOIN player_ip_history a ON a.ip = b.ip AND a.player_id != b.player_id`), с агрегатами: количество общих IP, минимальная дельта `|a.last_seen_at − b.last_seen_at|` по совпавшему IP (`min_time_delta_seconds`), список совпадений `{ip, geo, candidate_seen_at, owner_seen_at}`. Поверх IP-сигнала — score из дополнительных эвристик: совпадение `name_normalized` из `player_name_history` (общие исторические ники), «молодой» аккаунт (`created_at` кандидата после последнего бана целевого игрока), близкие SteamID64 (дельта < настраиваемого порога — пакетная регистрация). Каждый сигнал — отдельное поле ответа с весом; итоговый `confidence` (low/medium/high) считается на сервере, формула — в настройках с дефолтами. Исключения: таблица `alt_ignored_ips` (`ip` или CIDR, `note`, `created_by uuid FK players.id`) для VPN/CGNAT/интернет-кафе — совпадения по этим адресам не участвуют в score (но показываются серым с пометкой «shared IP»); CRUD исключений — на странице `/settings/alt-detection`. В ответе кандидата: `has_active_ban`/`has_permanent_ban` (из `moderation_actions`), текущий ник, ссылка на карточку. Ответ фильтруется на сервере: без permission `player:view_ips` (см. ALT-8) endpoint возвращает 403. Пагинация и лимит кандидатов (default 50, sort by confidence desc). Индекс по `player_ip_history(ip)` — добавить миграцией, EXPLAIN-проверка, что запрос не делает seq scan на таблице с 10M строк.
**Критерии приёмки:** два игрока с одним общим IP взаимно видят друг друга в кандидатах с корректной дельтой времени; IP из ignore-листа исключает пару из score, но совпадение видно с пометкой; кандидат с активным перманентным баном помечен флагом; пользователь без `player:view_ips` получает 403 и не видит ни IP, ни кандидатов; запрос на фикстуре 1M+ строк укладывается в 500 мс (индексный план).
**Зависимости:** PLAYER-2, PLAYER-3, MOD-2, ALT-8.

### ALT-2. Ручное подтверждение/отклонение связи + таблица player_links [P1]
**Контекст (SQSTAT):** У конкурента результат twink-поиска эфемерный — админ каждый раз запускает поиск заново, подтверждённые связи нигде не фиксируются (gap 92 §11). Закрепление вердикта админа превращает разовую форензику в накопленное знание и позволяет строить предупреждения при банах (ALT-7).
**Что сделать:** Таблица `player_links` (`id uuid v7 PK`, `player_a_id uuid FK players.id`, `player_b_id uuid FK players.id`, `CHECK (player_a_id < player_b_id)` + `UNIQUE(player_a_id, player_b_id)` — неориентированное ребро без дублей, `link_type` enum (`alt` | `family_share` | `same_household` | `unrelated`), `status` enum (`confirmed` | `rejected`), `evidence_snapshot jsonb` — слепок сигналов ALT-1 на момент решения, `note text`, `created_by uuid FK players.id`, `created_at`, `updated_at`). API: `POST /api/v1/players/{id}/links` (подтвердить кандидата с типом), `PATCH /api/v1/player-links/{link_id}` (сменить тип/статус), `DELETE` — запрещён, вместо него `status=rejected` (история решений не теряется). `rejected`-пара скрывается из блока «Возможные альты» (ALT-6), но остаётся видимой в выдаче ALT-1 с пометкой «отклонено админом N дата». Все мутации требуют `player:view_ips` и пишут в `audit_log` before/after. UI: кнопки «Подтвердить связь» / «Отклонить» прямо в списке кандидатов, модалка выбора `link_type` + note.
**Критерии приёмки:** подтверждение создаёт одну запись независимо от того, с какой стороны пары оно сделано; повторное подтверждение той же пары → 409; rejected-пара не показывается в «Возможные альты», но в полной выдаче ALT-1 помечена; каждое решение видно в audit_log с evidence_snapshot; EOS-only игроки (steam_id64 NULL) линкуются без ошибок.
**Зависимости:** ALT-1, INFRA-6.

### ALT-3. Co-play граф «Часто играет с» [P2]
**Контекст (SQSTAT):** Конкурент показывает связи только через Steam-друзей и ручное сравнение календарей; регулярного co-play графа у него нет — это возможность превзойти. При этом сам паттерн «кто с кем играет» прямо вытекает из его co-presence инструмента (03 §4.3) и просится в автоматизацию.
**Что сделать:** Worker-задача (в составе существующего воркера агрегатов presence, cron раз в сутки): по `player_sessions` считать попарные пересечения — для каждой пары игроков на одном `server_id` суммировать `overlap_seconds = SUM(LEAST(a.disconnected_at, b.disconnected_at) − GREATEST(a.connected_at, b.connected_at))` и `shared_session_count` за rolling-окно 90 дней. Результат — таблица `player_coplay` (`player_a_id uuid`, `player_b_id uuid`, `CHECK (a<b)`, `server_id`, `window_start date`, `overlap_seconds`, `shared_session_count`, PK по четвёрке). Отсечка шума: в выдачу попадают пары с `shared_session_count >= N` И `overlap_seconds >= M` (оба порога в настройках, дефолт 5 сессий / 10 часов). Инкрементальный пересчёт только за вчерашний день, полный rebuild — административная команда. API: `GET /api/v1/players/{id}/coplay` (топ-20 по overlap, агрегировано по всем серверам, с разбивкой по серверам в details). Гейт — `panel_access` (IP не участвуют, `player:view_ips` не требуется). Anti-signal для ALT-1: пара, регулярно играющая ОДНОВРЕМЕННО на одном сервере, — скорее друзья, чем альты одного человека; передавать `coplay_overlap` в score ALT-1 с отрицательным весом.
**Критерии приёмки:** пара с 10 совместными сессиями видна у обоих игроков с одинаковым overlap; пары ниже порогов не возвращаются; ночной пересчёт на фикстуре 100k сессий/день укладывается в 5 минут; reconciliation-тест: пересчёт полного окна == сумме инкрементов; наличие большого coplay-overlap снижает confidence кандидата в ALT-1.
**Зависимости:** PRES-1, PRES-2, ALT-1.

### ALT-4. Сравнение онлайна двух игроков (co-presence календарь) [P2]
**Контекст (SQSTAT):** `twinkOnline` (03 §2.4, §4.3): недельный FullCalendar с наложением сессий двух аккаунтов — админ визуально доказывает, что аккаунты никогда не онлайн одновременно (один человек) либо регулярно онлайн вместе (разные люди). Ключевой шаг twink-workflow конкурента.
**Что сделать:** Endpoint `GET /api/v1/players/{id}/compare-online?other={player_id}&from=...&to=...` — сессии обоих игроков из `player_sessions` за интервал (max 31 день), сгруппированные по игроку, с `server_id` и mode. UI: страница/модалка «Сравнить онлайн» из списка кандидатов ALT-1 и из блока «Возможные альты»: week-grid 7×24 (переиспользовать календарный компонент PRES-4), сессии игрока A одним цветом, игрока B другим, пересечения — штриховкой; навигация по неделям; summary-строка «Совместный онлайн за период: Xч Yм; одновременных заходов: N». Тёмная тема и i18n EN/RU как во всём UI. Гейт — `panel_access`; если вход инициирован из alt-кандидатов, IP-детали в этом экране всё равно не показываются (только время сессий).
**Критерии приёмки:** два игрока с известными фикстурными сессиями отображаются без наложения ошибочных интервалов, пересечение подсвечено и совпадает с ручным расчётом; интервал > 31 дня → 422; переключение недели догружает данные без перезагрузки страницы; RU/EN переводы полные.
**Зависимости:** PRES-4, ALT-1.

### ALT-5. Проверка Steam-друзей между двумя аккаунтами [P2]
**Контекст (SQSTAT):** `findFriends` (03 §2.4): кнопка «Проверить друзья» отвечает `in_friend: bool` — Steam-социальное ребро как подтверждающий/опровергающий сигнал в alt-workflow («В друзьях» / «Не найдено»).
**Что сделать:** В рамках интеграции Steam Web API (INT-1) добавить метод `GET /api/v1/players/{id}/steam-friend-check?other={player_id}`: `ISteamUser/GetFriendList` для одного из аккаунтов, поиск steam_id64 второго. Ответ: `in_friend: bool | null` + `reason` (`private_profile` | `no_steam_id` | `api_key_missing`) — у EOS-only игроков и при приватном friends-листе результат `null` с человекочитаемой причиной, не ошибка. Кэш результата 24 ч (Redis) — friends-лист не запрашивается на каждый клик. Rate-limit-aware очередь запросов из INT-1 переиспользуется. Кнопка «Проверить друзья» в карточке кандидата ALT-1 и в ALT-4; результат («В друзьях» / «Не найдено» / «Профиль скрыт») сохраняется в `evidence_snapshot` при подтверждении связи через ALT-2. Гейт — `panel_access`.
**Критерии приёмки:** пара реальных друзей даёт `in_friend=true`; приватный профиль даёт `null/private_profile` и корректный текст в UI (не крэш); без Steam API key фича деградирует в «недоступно: добавьте Steam API key»; повторный клик в течение суток не бьёт Steam API (кэш-хит виден в логах).
**Зависимости:** INT-1, ALT-1, ALT-2.

### ALT-6. Блоки «Возможные альты» и «Часто играет с» на карточке игрока [P1/P2]
**Контекст (SQSTAT):** У конкурента twink-поиск спрятан за кнопкой в модалке (03 §4.2); связи не видны, пока админ не запустит поиск руками. Вынос на карточку делает сигнал пассивно-заметным — админ видит альтов при любом открытии игрока.
**Что сделать:** P1: секция «Возможные альты» на `/players/{id}` (после секции «Локация»): топ-5 кандидатов из ALT-1 (confidence badge, общих IP: N, мин. дельта humanized, флаг перм-бана красным), подтверждённые связи из ALT-2 — отдельным списком сверху с бейджем типа (`alt`/`family_share`/...), кнопка «Все кандидаты» → полный список с действиями подтверждения/отклонения. Секция рендерится только при `player:view_ips`; без права секция полностью отсутствует в HTML и в API-ответе (не «пустая»). Ленивая загрузка (запрос ALT-1 уходит при развороте секции, не при открытии карточки). P2: секция «Часто играет с» из ALT-3 (топ-10: ник, суммарный overlap humanized, число сессий, клик → карточка; кнопка «Сравнить онлайн» → ALT-4) — видна при `panel_access`. Empty-state обеих секций с пояснением. i18n EN/RU, dark mode.
**Критерии приёмки:** у игрока с кандидатами секция показывает их с корректными числами, подтверждённые связи — выше кандидатов; у пользователя без `player:view_ips` секция «Возможные альты» отсутствует в DOM и данных, а «Часто играет с» видна; открытие карточки без разворота секции не вызывает запрос ALT-1 (проверка по network); EOS-only игрок отображается в обеих секциях без Steam-виджетов.
**Зависимости:** PLAYER-4, ALT-1, ALT-2, ALT-3, ALT-4.

### ALT-7. Предупреждение об альтах при бане [P2]
**Контекст (SQSTAT):** Конкурент помечает кандидатов флагом «Есть перманентный бан» (03 §4.3), но обратной связи нет — при выдаче бана админ не видит, что у игрока есть известные альты, и обход бана обнаруживается постфактум. Замыкание цикла «бан → альты» — прямое усиление их сильнейшей фичи.
**Что сделать:** В flow бана MOD-2 (модалка Ban на карточке и в live-списке) перед подтверждением — запрос `GET /api/v1/players/{id}/ban-alt-warning`: подтверждённые связи типа `alt` из ALT-2 + кандидаты ALT-1 с `confidence=high`. Если непусто — в confirm-диалоге блок «У игрока есть связанные аккаунты» со списком (ник, тип связи/confidence, онлайн-статус, активные баны) и чекбоксами «Забанить также» напротив каждого подтверждённого альта (только `status=confirmed`, `link_type=alt`; кандидаты — только предупреждение, без чекбокса). Отмеченные альты банятся тем же вызовом MOD-2 (та же причина, длительность, evidence), каждый — отдельной записью `moderation_actions` + отдельной строкой audit с ссылкой на исходный бан (`related_action_id`). Для пользователей без `player:view_ips` предупреждение деградирует до «У игрока есть N подтверждённых связанных аккаунтов» без ников и деталей, без чекбоксов. Событие `alt.ban_evasion_suspected` в `events`/alerts (AUTO-3): подключение игрока, у которого подтверждённый alt-линк ведёт на аккаунт с активным баном, — push-уведомление админам.
**Критерии приёмки:** бан игрока с подтверждённым альтом показывает предупреждение до выполнения RCON-команды; отметка чекбокса банит оба аккаунта, обе записи в Bans.cfg корректны и связаны в audit; у игрока без связей диалог бана не замедляется (warning-запрос параллелен, таймаут 2 с → бан без блока); заход альта забаненного игрока порождает alert.
**Зависимости:** ALT-1, ALT-2, MOD-2, AUTO-3.

### ALT-8. Permission `player:view_ips` как отдельный панельный флаг [P1]
**Контекст (SQSTAT):** У конкурента IP и twink-поиск видны любому админу, открывшему карточку (03 §8 «ungated»), что отмечено как compliance-риск (92 §11 «Heavy PII retention»). PLAYER-4 нашего плана уже требует гейт `player:view_ips`, но в P0 он временно равен `panel_access`, а отдельный флаг вынесен в backlog — весь WS-18 стоит на этом флаге, поэтому он реализуется здесь.
**Что сделать:** Миграция: флаг `can_view_ips boolean NOT NULL DEFAULT false` в таблице ролей (четвёртый панельный флаг рядом с `panel_access`/`can_assign_roles`/`can_edit_roles`; валидация — требует `panel_access=true`, как в ROLE-1). Owner — hardcoded `true`. Middleware-гейт `player:view_ips` маппится на этот флаг; перевести на него существующие места: IP/локация в PLAYER-4 (API-фильтрация + UI), полный `player_ip_history` в API, и все ALT-endpoint'ы, где указано. Чекбокс в редакторе ролей ROLE-3 с подсказкой «Доступ к IP-адресам игроков и поиску альтов». Backfill: существующим ролям с `panel_access=true` при миграции проставить `can_view_ips=true` (сохранение поведения P0, без регрессии доступа), с записью в audit. Изменение флага роли — стандартный audit ROLE-1; смена флага инвалидирует кэш permissions активных сессий членов роли.
**Критерии приёмки:** роль с `panel_access=true, can_view_ips=false` видит карточку игрока без секций IP/локации/альтов и получает 403 на ALT-1; `can_view_ips=true` при `panel_access=false` → 422; после миграции ни один существующий пользователь панели не потерял доступ к IP; снятие флага применяется к уже залогиненному пользователю без re-login.
**Зависимости:** ROLE-1, ROLE-2, PLAYER-4.


---

# WS-18. Боевые логи: kills/deaths/revives/damage/teamkills (из анализа SQSTAT)

### COMBAT-1. Расширение worker log-ingest combat-событиями [P1]
**Контекст (SQSTAT):** SQSTAT ведёт пять пер-событийных боевых логов (kills 4.4M, deaths 5.6M, revives 1.2M, damages 13.4M, teamkills 0.65M строк) — всё извлекается из логов сервера, без внешнего sidecar (см. `ai_docs/rival-analysis/sections/13-combat-logs.md`, §13.1, §13.3). У нас EVT-1 парсит только connect/disconnect/match/crash — боевых событий нет вообще.
**Что сделать:** Расширить парсер worker log-ingest (EVT-1) набором combat-событий из SquadGame.log: `combat.damage` (LogSquadTrace `ApplyDamage`/`OnTakeDamage`: attacker, victim, weapon, damage amount), `combat.wound` (`Wound`: incapacitation), `combat.death` (`Die`: убийца, жертва, оружие), `combat.revive` (`ReviveDone`/аналог: медик, реанимированный). Регэкспы сверить с SquadJS log-parser (log-parser/squad — единственный проверенный референс сигнатур) и покрыть фикстурами реальных логов dev-сервера, включая suicide (attacker == victim), урон от среды/deployable (attacker отсутствует) и bot/nil-акторов. Резолвинг участников в `players.id uuid` через identity-механизм PLAYER-1 (по eos_id из строки лога; steam_id64 — вторично); если игрок ещё не известен — создать запись игрока тем же алгоритмом, что и при подключении. Teamkill-детекция на этапе парсинга: сравнить teamId атакующего и жертвы по состоянию из `rcon.players_polled`/событий матча на момент события → флаг `is_teamkill` на `combat.death` и `combat.damage`. События пишутся тем же pipeline, что и EVT-1 (envelope + типизированная запись, см. COMBAT-2), с привязкой к `server_id` и к текущему матчу (`match.started`/`match.ended` из EVT-1 определяют границы; `match_id` NULL, если матч-контекст неизвестен, например при рестарте worker'а посреди раунда).
**Критерии приёмки:** kill/damage/revive реального игрока на dev-сервере → типизированное событие в БД ≤5 с с корректными `attacker_player_id`/`victim_player_id` (uuid), weapon, damage; teamkill в игре → `is_teamkill=true`; suicide и урон без атакующего не ломают парсер (фикстуры); EOS-only игрок (без steam_id64) корректно резолвится в players.id; рестарт worker'а посреди файла → ни потерь, ни дублей combat-событий (offset-тест как в EVT-1).
**Зависимости:** EVT-1, PLAYER-1.

### COMBAT-2. Схема хранения combat_events (partitioned, uuid FK) [P1]
**Контекст (SQSTAT):** конкурент держит 5 отдельных MySQL-таблиц, ключуется на SteamID64 и на каждой загрузке страницы гоняет полный `COUNT(*)` за 0.1–2.76 с (§13.2.3, §13.10). Мы объединяем всё в одну типизированную таблицу на `players.id` и проектируем под keyset-пагинацию.
**Что сделать:** Таблица `combat_events`: `id bigint generated always as identity`, `event_type` (`death|damage|wound|revive`), `server_id`, `match_id bigint NULL`, `attacker_player_id uuid NULL REFERENCES players(id)`, `victim_player_id uuid NOT NULL REFERENCES players(id)` (для revive: attacker = медик, victim = реанимированный), `weapon text NULL`, `damage numeric NULL`, `attacker_kit text NULL`, `is_teamkill boolean NOT NULL DEFAULT false`, `occurred_at timestamptz NOT NULL`. Никаких steam_id64-колонок — только uuid (EOS-only игроки сохраняют историю). Партиционирование по месяцам через pg_partman (как `events` в EVT-1), retention 24 мес с auto-drop. Индексы под фильтры UI: `(server_id, occurred_at desc)`, `(attacker_player_id, occurred_at desc)`, `(victim_player_id, occurred_at desc)`, partial `(victim_player_id, occurred_at desc) WHERE is_teamkill` — и BRIN по `occurred_at`. Для счётчиков страниц — быстрый approximate count (reltuples по партициям) вместо `COUNT(*)`; точный count только при активных фильтрах и с statement_timeout.
**Критерии приёмки:** миграция применяется на чистую БД и на БД с данными; вставка 1M синтетических событий → выборка «события игрока за месяц» <300 мс, «teamkills сервера за неделю» <300 мс (EXPLAIN подтверждает index-only/partition pruning); партиция старше 24 мес дропается; FK на players(id) работает для игрока без steam_id64.
**Зависимости:** INFRA-5, COMBAT-1.

### COMBAT-3. API боевых логов с keyset-пагинацией [P1]
**Контекст (SQSTAT):** пять одинаковых по контракту страниц конкурента — это одна и та же выборка с разными алиасами сторон (§13.4.1, §13.10), OFFSET-пагинация + отдельный дорогой count-запрос. Мы отдаём один endpoint с фасетом типа события и cursor-пагинацией.
**Что сделать:** `GET /api/v1/combat-events` с параметрами: `type` (multi: death|damage|wound|revive), `serverId` (multi), `matchId`, `attackerPlayerId`, `victimPlayerId`, `playerId` (любая сторона), `attackerName`/`victimName` (substring, через nickname-историю PLAYER-2 текущего имени), `weapon` (substring), `teamkillsOnly` (bool), `from`/`to` (ISO 8601), `cursor`/`limit` (keyset по `(occurred_at, id)`, limit ≤200). Ответ: rows (обе стороны — `{player_id, current_name}`) + `nextCursor` + `approxTotal`. Дополнительно `GET /api/v1/combat-events/export` — стриминговый CSV по тем же фильтрам (лимит 100k строк на выгрузку). RBAC-гейт: новый panel-флаг `combat:view` (по умолчанию у ролей с `panel_access`); без него — 403. Это read-only API — записей в audit_log не требуется (мутаций нет).
**Критерии приёмки:** OpenAPI-схема в `/api/docs`; комбинация фильтров (игрок+оружие+сервер+период) отдаёт корректный результат; пролистывание глубокой страницы (эквивалент offset 500k) через cursor — <500 мс; CSV-экспорт 100k строк стримится, не держа всё в памяти; запрос без `combat:view` → 403.
**Зависимости:** COMBAT-2, PLAYER-2, ROLE-1.

### COMBAT-4. UI «Боевой лог» — единая страница с фасетами [P1/P2]
**Контекст (SQSTAT):** у конкурента пять почти одинаковых страниц с левым фильтр-рейлом (Кто/Кого/Сервер/период с 21 пресетом дат), причём поле `damage` приходит в payload, но никогда не показывается, а открыть карточку второй стороны можно только на kills (§13.4–13.6, §13.10). Делаем одну страницу лучше пяти.
**Что сделать (P1):** Страница `/servers/{id}/combat-log` и глобальная `/combat-log`: одна таблица с фасетом типа события (табы/чипы: Убийства, Смерти, Ранения, Реанимации, Урон, Тимкиллы — «Тимкиллы» = фильтр `teamkillsOnly`), колонки: время (локальное, tooltip с ISO), сервер-бейдж, Кто, Кого, Оружие, Урон (видимая и сортируемая в фасете «Урон» — то, что SQSTAT прячет), бейдж TK. Обе стороны события кликабельны → карточка игрока PLAYER-4 (у SQSTAT — только primary). Фильтр-панель: Кто/Кого (autocomplete по игрокам), оружие, сервер (multiselect), период с пресетами (сегодня, вчера, 24ч, неделя, месяц, 30/60/90 дней, всё время, кастомный диапазон). Cursor-пагинация «показать ещё»/infinite scroll, approx-счётчик. Dark mode, i18n EN/RU, mobile-friendly (карточный режим на узких экранах). **(P2):** deep-link фильтров в URL (шэрится между админами), кнопка CSV-экспорта (COMBAT-3), переход «показать в контексте матча» при наличии `match_id`.
**Критерии приёмки:** каждый фасет и каждый фильтр дают корректную выборку (браузерная проверка на dev-данных); клик по любой из сторон открывает карточку игрока; колонка «Урон» отображается в фасете урона; страница на 13M+ строк листается без деградации (keyset); все строки через i18n-слой; элементы не перекрываются на мобильной ширине.
**Зависимости:** COMBAT-3, PLAYER-4, UX-1, UX-2.

### COMBAT-5. Teamkill-трекинг: агрегат на игрока и модерация [P1/P2]
**Контекст (SQSTAT):** teamkills у конкурента — пассивный лог: нет пер-игрокового счётчика, нет surfacing повторных нарушителей, нет никакого workflow (§13.3 playerTeamkill, §13.10 «Teamkills is passive»). Это прямо названная брешь, которую мы закрываем.
**Что сделать (P1):** Агрегат `player_teamkill_stats` (`player_id uuid PK`, `tk_total`, `tk_7d`, `tk_30d`, `victim_of_tk_total`, `last_tk_at`), инкрементально обновляемый worker'ом log-ingest при `combat.death is_teamkill=true`; скользящие окна пересчитываются ежечасной джобой. Виджет «Тимкиллы» на карточке игрока PLAYER-4: счётчики + последние 10 TK-событий со ссылкой в боевой лог с префильтром. Страница `/moderation/teamkills` (гейт `combat:view`): топ нарушителей за период, сортировка по tk_7d/tk_30d/total, клик → карточка игрока, откуда доступны действия модерации MOD-2 (warn/kick/ban — они и пишут audit). **(P2):** настраиваемый порог «N тимкиллов за M часов» → алерт админам через механизм AUTO-3 и опциональный auto-warn нарушителю через RCON `AdminWarn` (действие идёт через MOD-2-пайплайн и попадает в audit_log с before/after).
**Критерии приёмки:** teamkill на dev-сервере → счётчик игрока инкрементируется ≤10 с; окна 7d/30d корректны после ежечасного пересчёта (тест с бэкдейтом событий); топ нарушителей совпадает с ручной агрегацией по combat_events; (P2) превышение порога → алерт доставлен, auto-warn виден в игре и в audit_log.
**Зависимости:** COMBAT-2, PLAYER-4, MOD-2, AUTO-3.

### COMBAT-6. Live-стрим боевых событий (WebSocket) [P2]
**Контекст (SQSTAT):** у конкурента боевые логи — только polling-таблицы; live-наблюдение за происходящим на сервере (в т.ч. мгновенное появление тимкиллов) отсутствует. У нас уже есть WebSocket-инфраструктура (live players MOD-1, chat CHAT-1) — расширяем её combat-каналом.
**Что сделать:** WebSocket-канал `combat:{server_id}`: worker log-ingest публикует combat-события в реальном времени; на странице сервера — переключатель «Live» в боевом логе (COMBAT-4): новые события доклеиваются сверху, TK подсвечены; фильтр по типам применяется на клиенте к стриму. Reconnect не теряет хвост (буфер последних N событий по паттерну CHAT-1). Подписка гейтится тем же `combat:view`.
**Критерии приёмки:** kill в игре → строка в live-режиме UI ≤3 с; teamkill визуально выделен; обрыв и восстановление WebSocket не приводят к пропущенным событиям в пределах буфера; без `combat:view` подписка отклоняется.
**Зависимости:** COMBAT-1, COMBAT-4, CHAT-1.


---

# WS-18. История матчей (из анализа SQSTAT)

### MATCH-1. Сущность match и worker-сборка из событий [P1]
**Контекст (SQSTAT):** У конкурента страница «Игры» (rival-analysis §12) — журнал на ~28.5K строк с сущностью Game: сервер, layer, фракции t1/t2, unix start/end, тикеты обеих команд, победитель (`t1|t2|""`), флаг `is_seed`, длительность в секундах. Это фундамент всей истории матчей; у нас матчи существуют только как сырые события `match.started/match.ended` в envelope-таблице.
**Что сделать:** Таблица `matches`: `id uuid v7 PK`, `server_id uuid FK`, `layer text` (полное имя, напр. `Harju_RAAS_v1`), `map text` (базовая карта, derived), `game_mode text` (`AAS|RAAS|Invasion|Skirmish|Seed|...`, derived из layer), `team1_faction text`, `team2_faction text`, `team1_tickets int NULL`, `team2_tickets int NULL`, `winner text NULL` (`team1|team2|draw`), `is_seed boolean NOT NULL DEFAULT false` (эвристика: game_mode = Seed ИЛИ онлайн на старте ниже конфигурируемого порога — брать из последнего `rcon.players_polled` перед стартом), `started_at timestamptz NOT NULL`, `ended_at timestamptz NULL`, `duration_seconds int NULL`, `end_reason text` (`ended|server_crashed|server_restarted`). Индексы: `(server_id, started_at desc)`, `(started_at desc)`, `(layer)`, partial `WHERE ended_at IS NULL`. Сборка — в worker log-ingest (расширение EVT-1, без нового воркера): `match.started` открывает строку; `match.ended` закрывает (тикеты/победитель из строки лога, при нехватке данных — обогащение через RCON `ShowCurrentMap`/`ShowNextMap` на старте раунда); `server.crashed/server.restarted` закрывает открытый матч сервера с `end_reason` и `winner=NULL`. Идемпотентность: повторная обработка того же события (offset-recovery EVT-1) не создаёт дубль — уникальность по `(server_id, started_at)`. Каждая строка `events` периода матча получает возможность связывания через интервал (`started_at`, `ended_at`) — отдельный FK в events не вводить. Регэкспы тикетов/фракций сверить с SquadJS-парсером (`LogSquadTrace ... ROUND WINNER` и т.п.) и покрыть фикстурами реальных логов.
**Критерии приёмки:** сыгранный на dev-сервере раунд → строка в `matches` с layer, обеими фракциями, тикетами, победителем и `duration_seconds = ended_at − started_at` ≤10 с после конца раунда; kill сервера посреди раунда → матч закрыт с `end_reason='server_crashed'`, `winner IS NULL`; повторный проигрыш лога с того же offset не создаёт дублей; Seed-layer → `is_seed=true`.
**Зависимости:** EVT-1, RCON-1, INFRA-5.

### MATCH-2. Per-match ростер (match_players) [P1]
**Контекст (SQSTAT):** Детальная страница `/game/<id>` конкурента показывает состав команд матча (rival-analysis §12, §2.3 — ростер и per-player результативность). У нас presence-сессии (PRES-1) есть, но привязки «кто играл в этом матче и за какую команду» нет.
**Что сделать:** Таблица `match_players`: `match_id uuid FK matches`, `player_id uuid FK players(id)` (никогда не steam_id64), `team smallint NULL` (1/2), `squad_name text NULL`, `joined_at timestamptz`, `left_at timestamptz NULL`, `play_seconds int`, PK `(match_id, player_id)`. Заполнение worker'ом log-ingest при закрытии матча: пересечение интервала матча с `player_sessions` (PRES-1) даёт участников и `play_seconds` (сумма пересечений, если игрок переподключался); team/squad — из последнего снапшота `rcon.players_polled` внутри интервала матча (RCON ListPlayers отдаёт TeamID/SquadID). Игрок, зашедший на последних N секундах (конфиг, default 60), всё равно попадает в ростер — фильтрация по play_seconds делается на чтении, не на записи. Обновление live: для открытого матча ростер вычисляется on-the-fly из open-сессий + последнего RCON poll, без записи в таблицу до закрытия.
**Критерии приёмки:** матч с известным составом на dev-сервере → все игроки в `match_players` с корректными team и play_seconds; игрок с reconnect посреди матча — одна строка, play_seconds = сумма кусков; EOS-only игрок (без steam_id64) присутствует в ростере; SUM(play_seconds) участника за день согласуется с PRES-2 (reconciliation-тест в пределах длительности матчей).
**Зависимости:** MATCH-1, PRES-1, MOD-1.

### MATCH-3. Per-match результативность игроков [P2]
**Контекст (SQSTAT):** Дашборд статистики конкурента агрегирует kills/death/revival/damage/wound по серверам и дням (rival-analysis §11, ключи C2), а карточка матча показывает per-player K/D. У нас combat-данные запланированы только как глобальные агрегаты игрока через RNSquadJS (STATS-*), без разреза «в рамках матча».
**Что сделать:** Расширить `match_players` колонками `kills int`, `deaths int`, `teamkills int`, `wounds int`, `revives int` (NULL = данных нет). Первичный источник — combat-события из SquadGame.log: расширить EVT-1 типами `player.wounded`, `player.died`, `player.revived`, `player.teamkilled` (регэкспы из SquadJS log-parser: `LogSquad: Player ... has been wounded/died/revived`), атрибуция к матчу по интервалу, к игроку — по eos_id → `players.id`. Заполнять при закрытии матча одним агрегирующим запросом по `events` интервала. Fallback/enrichment из STATS-3 не делать (RNSquadJS отдаёт lifetime-агрегаты, не per-match) — источник только log-parsing, это зафиксировать в ADR при имплементации. Damage per-match не считать (в логах нет надёжного суммируемого урона) — колонку не заводить.
**Критерии приёмки:** тестовый раунд с известными килами → `kills/deaths/wounds/revives` в `match_players` совпадают с фактом; teamkill учтён и в `teamkills`, и в `kills` не попадает; матчи, сыгранные до включения combat-парсинга, показывают NULL (UI: «нет данных»), а не нули; пересчёт закрытого матча идемпотентен.
**Зависимости:** MATCH-2, EVT-1.

### MATCH-4. API списка и карточки матчей [P1]
**Контекст (SQSTAT):** Конкурент отдаёт список двухфазно: быстрый fetch строк (100/страница) + отложенный COUNT(*) отдельным запросом `pagination=true` — быстрый first paint на 28.5K строк (rival-analysis §12, C2/C3). Слабости, которые бьём: нет сортировки колонок, нет экспорта, сырые SQL-алиасы (`t1.map`) в фильтрах клиента.
**Что сделать:** `GET /api/v1/matches` — фильтры: `serverIds[]` (uuid), `layer` (substring, ILIKE по параметризованному запросу — никаких сырых алиасов), `dateFrom/dateTo`, `hideSeeding=true|false` (default true — то, что SQSTAT шлёт в payload, но не даёт фильтровать), `winner` (`team1|team2|draw|null`), `playerId` (uuid — матчи с участием игрока, join `match_players`); сортировка `sort=started_at|duration_seconds|layer` + `order`, default `started_at desc`; keyset-пагинация (cursor по `(started_at, id)`), `limit ≤100`. COUNT — отдельный `GET /api/v1/matches/count` с теми же фильтрами (повторяем двухфазный паттерн конкурента). `GET /api/v1/matches/{id}` — матч + ростер (`match_players` join `players`: id, текущий nickname, team, squad_name, play_seconds, kills/deaths/teamkills/wounds/revives) + агрегаты по командам. `GET /api/v1/matches/export?format=csv` с теми же фильтрами (лимит 10K строк) — экспорт, которого у конкурента на этой странице нет. RBAC: read-only отчётность → гейт `panel_access` (новый permission-флаг не нужен). Мутаций нет → audit_log не пишется. Все ответы — числа числами (не строками, в отличие от SQSTAT).
**Критерии приёмки:** список за месяц по одному серверу на 100K матчей <300 мс (EXPLAIN использует `(server_id, started_at desc)`); `hideSeeding=true` скрывает `is_seed`; `playerId`-фильтр возвращает только матчи из ростера игрока; count и строки согласованы при одинаковых фильтрах; без `panel_access` — 403; CSV открывается в Excel/Numbers с корректными датами; OpenAPI-схемы в `/api/docs`.
**Зависимости:** MATCH-1, MATCH-2, ROLE-1.

### MATCH-5. UI: страница /matches — список с фильтрами [P1]
**Контекст (SQSTAT):** Страница «Игры»: закреплённый фильтр-сайдбар (карта, мультиселект серверов, date range с ~11 пресетами) + таблица 100/страница; тикеты — цветной pill на имени команды (зелёный победитель / красный проигравший), трофей-колонка = индикатор ничьей (rival-analysis §12, §5, §7). Бьём их слабости: сортировка колонок, фильтр seed-раундов, SPA-переход на карточку.
**Что сделать:** Страница `/matches`: фильтр-панель (substring по layer, мультиселект серверов, date-range picker с пресетами «сегодня/вчера/неделя/месяц/30 дней/всё время/custom», toggle «Скрывать seeding» default on) + таблица: сервер (бейдж коротким именем), layer, начало, конец (пусто + бейдж «Идёт» для открытого матча), команда 1 и команда 2 (pill с тикетами: зелёный у победителя, красный у проигравшего, нейтральный при ничьей/незавершённом — паттерн SQSTAT), длительность, победитель. Клик по строке → `/matches/{id}` внутри SPA (не full reload, в отличие от `/game/<id>` конкурента). Сортировка по клику на заголовки started_at/duration/layer. Infinite scroll или пагинация на keyset-курсоре; счётчик «Всего: N» подгружается отложенно из `/matches/count`, не блокируя первую отрисовку. Кнопка «Экспорт CSV» (MATCH-4). Live: WebSocket-событие `match.started/match.ended` обновляет верх списка без перезагрузки. Dark mode, все строки через i18n-слой (EN/RU). Мобильная вёрстка: фильтры сворачиваются в drawer, таблица — горизонтальный скролл без наложений.
**Критерии приёмки:** все фильтры комбинируются и отражаются в URL (shareable link); toggle seeding мгновенно перезапрашивает список; открытый матч показывает «Идёт» и живую длительность; конец раунда на dev-сервере → строка обновилась ≤5 с без F5; сортировка работает по трём колонкам; на 375px-вьюпорте нет наложений элементов.
**Зависимости:** MATCH-4, UX-1, UX-2.

### MATCH-6. UI: карточка матча /matches/{id} [P1/P2]
**Контекст (SQSTAT):** Детальный вид `/game/<id>` конкурента — отдельная server-rendered страница с ростерами и per-player результативностью (rival-analysis §12, §2.3; точная схема у конкурента не задокументирована — Gaps). Делаем свой полноценный аналог внутри SPA.
**Что сделать (P1):** Шапка: сервер, layer + game_mode, started/ended (humanized + точный timestamp в tooltip), длительность, результат — две фракции с тикетами и подсветкой победителя, бейджи «Seeding» / «Прерван» (`end_reason != 'ended'`). Две колонки ростеров по командам: nickname (link → `/players/{id}`), squad_name, время в матче; игроки, покинувшие матч до конца, — приглушённым стилем. Соседние матчи: ссылки «← предыдущий / следующий →» по этому серверу. **(P2, после MATCH-3):** колонки K/D/TK/wounds/revives в ростерах с сортировкой, сводка по командам (сумма килов/ревайвов), и timeline событий матча (лента `events` интервала: kills, teamkills, wounds — reuse фильтров EVT-2). Открытый матч: live-режим — ростер из on-the-fly расчёта (MATCH-2), автообновление по WebSocket.
**Критерии приёмки:** карточка завершённого матча открывается <500 мс; клик по игроку ведёт на его карточку; EOS-only игрок кликабелен и открывается корректно; для матчей без combat-данных P2-колонки показывают «—», а не 0; переход список → карточка → назад сохраняет фильтры и позицию скролла списка.
**Зависимости:** MATCH-4, MATCH-5, PLAYER-4; P2-часть: MATCH-3, EVT-2.

### MATCH-7. «Последние матчи» на карточке игрока [P1]
**Контекст (SQSTAT):** У конкурента история игр и профиль игрока не связаны напрямую (переход только list → detail). Связка «карточка игрока → его последние матчи» — наше преимущество поверх их модели данных.
**Что сделать:** Секция «Последние матчи» на `/players/{id}` (PLAYER-4): последние 10 матчей игрока (источник — `GET /api/v1/matches?playerId={id}`): сервер, layer, дата, длительность участия (play_seconds), исход с позиции игрока (Победа/Поражение/Ничья — по team игрока vs winner), после MATCH-3 — его K/D в матче. Ссылка «Все матчи» → `/matches?playerId={id}` (MATCH-5 поддерживает playerId-фильтр как chip «Игрок: <nickname>»). Мини-виджет winrate за последние 30 матчей (Побед X из Y) — считать на API одним запросом.
**Критерии приёмки:** секция рендерится <300 мс на игроке с 5K матчей (keyset + индекс по `match_players(player_id)` — добавить в MATCH-2 индекс `(player_id, match_id)`); исход корректен для обеих команд и ничьей; «Все матчи» открывает предзафильтрованный список с chip; у игрока без матчей — empty state с пояснением, с какого момента ведётся история.
**Зависимости:** MATCH-4, MATCH-5, PLAYER-4.


---

# WS-18. Сидинг и ротация карт (из анализа SQSTAT)

### SEED-1. Детекция seeding-состояния сервера и сид-прогресс [P1]
**Контекст (SQSTAT):** SQSTAT держит глобальный флаг `isSeeding` в каждом ответе `getServer` (пульсация в шапке панели), deep-link `/?start_seed=true` открывает seeding-хелпер, а seed-слои («Sumari Seed v1») видны прямо в поле `map` (rival-analysis/sections/01-dashboard.md, §1, §2.1). У нас понятие «сервер сидится» отсутствует вовсе.
**Что сделать:** State machine seeding per server в worker-rcon: сервер считается в состоянии `seeding`, когда player count (из RCON poll `ListPlayers`, RCON-1) ниже порога `live_at` ИЛИ текущий layer — seed-слой (матч по каталогу слоёв ROT-1, поле `is_seed`; fallback — regex `/seed/i` по имени layer). Пороги per server в `servers.settings jsonb`: `seed_live_at` (default 60), `seed_hysteresis` (default 5, чтобы не дребезжало на границе). Переходы пишутся в `events`-envelope: `server.seeding_started` / `server.seeding_ended` (payload: player_count, layer, порог). API: `GET /api/v1/servers/{id}/seeding` → `{state, current_players, live_at, progress_pct, started_at}`. WebSocket push при смене состояния и изменении прогресса. UI: бейдж «Seeding» + progress bar «N/live_at» на странице сервера и в списке серверов; настройка порогов на странице сервера (гейт: panel-флаг `can_edit_roles` НЕ подходит — использовать squad permission `manageserver` у роли актора). Просмотр — `panel_access`. Изменение порогов → audit (before/after).
**Критерии приёмки:** заход игроков через порог с гистерезисом порождает ровно одну пару started/ended событий; смена на seed-layer при полном сервере всё равно даёт `seeding_started`; прогресс-бар обновляется по WS без перезагрузки страницы; изменение порога видно в audit_log.
**Зависимости:** RCON-1, EVT-1, ROT-1, INFRA-6.

### SEED-2. Учёт сид-вклада игроков и бонусы сидерам [P2]
**Контекст (SQSTAT):** SQSTAT ведёт seeder-часы в месяц и авто-выдаёт Discord-роль сидера при превышении `seeders_hours` (rival-analysis/sections/16-settings.md, §16.3 Discord Bot config), плюс отдельный booster-timeline на дашборде (01-dashboard.md, §4.6). Награда за сид — механика удержания игроков; частично это монетизация/экономика (VIP/reserve как приз).
**Что сделать:** Расширить enum `mode` в `player_sessions` (PRES-1) значением `seed`: worker presence при событиях `server.seeding_started/ended` (SEED-1) режет открытые сессии на границе перехода — интервал внутри seeding-окна пишется как `mode='seed'`. В `player_daily_presence` (PRES-2) добавить колонку `seed_seconds` (миграция + пересчёт агрегатора). В формуле «Бонусы» (PRES-4) добавить слагаемое `k_seed × seed` (default `k_seed = 3`, настройка организации). Авто-награда: настройка организации `{threshold_hours_per_month, reward_role_id}` — worker раз в сутки считает сид-часы за скользящие 30 дней и назначает/снимает роль-награду через механику ROLE-2 (то же API, actor = system, audit `seed.reward_granted/revoked`); роль-награда обязана быть без `panel_access` (валидация при сохранении настройки). Отметить: это экономическая/монетизационная механика (reserve/VIP как приз за сид) — сама выдача платных привилегий вне scope, здесь только автоматизация роли. UI: карточка игрока — card «Сид: XXч XXм» рядом с «Буст» (PRES-4), цвет `seed` в календаре сессий; страница настроек награды — гейт `can_edit_roles`.
**Критерии приёмки:** сессия, пересекающая границу seeding→live, разрезана на два интервала с корректными mode; `seed_seconds` за день сходится с суммой интервалов; игрок, набравший порог, получает роль в течение суток и теряет её при падении ниже порога; обе операции в audit_log; попытка указать роль-награду с `panel_access=true` отклоняется с 422.
**Зависимости:** SEED-1, PRES-2, PRES-4, ROLE-2, INFRA-6.

### SEED-3. Сид-календарь и расписание сид-стартов [P2]
**Контекст (SQSTAT):** SQSTAT имеет seeding-хелпер с deep-link `/?start_seed=true` и win/seeding-режим ротации (`rotation.isWin`), т.е. сид у конкурента — планируемая процедура, а не случайность (01-dashboard.md §1, §4.5; 16-settings.md §16.4.2). У нас планирования сида нет.
**Что сделать:** Таблица `seed_schedule`: `id uuid`, `server_id FK`, `starts_at timestamptz`, `seed_layer text` (валидация по каталогу ROT-1, `is_seed=true`), `broadcast_text text NULL`, `recurrence text NULL` (cron-выражение для регулярных сидов, напр. каждую субботу 10:00), `created_by uuid FK players.id`, `enabled bool`. Исполнение — регистрация job'ов в scheduler AUTO-2 (не собственный планировщик): в `starts_at` выполнить `AdminSetNextLayer <seed_layer>` (или `AdminChangeLayer`, если сервер пуст — порог из SEED-1) + опциональный `AdminBroadcast`. CRUD API `/api/v1/servers/{id}/seed-schedule` (гейт: squad permission `changemap`), каждая мутация → audit. UI: календарь (week/month grid) на странице сервера: запланированные сид-старты + исторические seeding-окна из событий SEED-1 (started/ended) как закрашенные интервалы; создание записи кликом по слоту. Защита от конфликтов: предупреждение при пересечении с depot-update окном (переиспользовать проверку AUTO-2 «защита от наложения на depot-update»).
**Критерии приёмки:** запись с recurrence порождает выполнение в каждый матчинг cron; выполнение видно в истории AUTO-2 и в audit; исторические сид-окна отображаются в календаре из реальных событий; пользователь без `changemap` видит календарь read-only.
**Зависимости:** SEED-1, ROT-1, AUTO-2, INFRA-6.

### SEED-4. Уведомления «нужен сид» [P2/P3]
**Контекст (SQSTAT):** SQSTAT пульсирует seeding-индикатором в шапке для всех залогиненных и раздаёт seeder-роль в Discord — фактически канал мобилизации сидеров (01-dashboard.md §1; 16-settings.md §16.3). У нас каналов «позвать на сид» нет.
**Что сделать (P2):** Кнопка «Позвать сидеров» на странице сервера (гейт: squad permission `chat` ИЛИ `manageserver`): рассылает уведомление подписчикам через механику алертов AUTO-3 (Web Push + email) с текстом, названием сервера и join-ссылкой `steam://connect/<ip>:<port>`; rate-limit — не чаще 1 раза в 2 часа на сервер (429 с Retry-After в API, disabled-кнопка с таймером в UI); вызов → audit `seed.call_sent`. Подписка: в личных настройках пользователя панели toggle «Уведомлять о сидах» per server (таблица `seed_subscriptions`: `player_id uuid FK`, `server_id`, `channel`). **(P3):** авто-уведомление по событию `server.seeding_started` из запланированного сида SEED-3 (за N минут до `starts_at`, N в настройке записи) — тоже через AUTO-3, с тем же rate-limit.
**Критерии приёмки:** подписанный пользователь получает push с работающей join-ссылкой; повторный вызов раньше 2 часов отклоняется и в API, и задизейблен в UI; отписка прекращает доставку; каждый ручной вызов в audit_log с актором.
**Зависимости:** SEED-1, SEED-3, AUTO-3, INFRA-6.

### ROT-1. Каталог слоёв (layers) + ADR «своя ротация vs встроенные механизмы Squad» [P1]
**Контекст (SQSTAT):** SQSTAT строит map picker из живого каталога `getServerMaps` — карты, режимы, фракции, юниты, тикеты, техника — и рендерит ротацию с флагами фракций из `list[layer].teams` (01-dashboard.md §4.5, §2.2). Без справочника слоёв ни редактор ротации, ни календарь, ни валидация невозможны.
**Что сделать:** Таблица `layers`: `id`, `name text UNIQUE` (точное имя для RCON), `map text`, `gamemode text` (RAAS/AAS/Invasion/Seed/Skirmish/TC/Destruction…), `version text`, `is_seed bool`, `teams jsonb` (фракции/юниты/тикеты, если извлекаемы), `depot_version text`, `deprecated bool`. Источник: генерация из файлов установленного сервера через bridge `file_read` (снапшот доступных слоёв после каждого depot-update; конкретный источник — layer-список из паков/конфигов — зафиксировать при реализации), fallback — статический датасет под текущую версию Squad, обновляемый вместе с `depot_version`. API `GET /api/v1/layers?map=&gamemode=&is_seed=` (гейт `panel_access`). **ADR (блокирует ROT-2/ROT-4):** собственная управляемая ротация (managed-сегмент `LayerRotation.cfg` + расписания панели) vs конфигурация встроенных механизмов Squad (нативная ротация + `LayerVoting*.cfg`); согласовать с ADR из GAME-1, чтобы не принять два противоречащих решения о LayerVoting. Зафиксировать в `ai_docs/`.
**Критерии приёмки:** после depot-update каталог содержит слои новой версии, исчезнувшие помечены `deprecated`; фильтры API работают; ADR принят и на него ссылаются ROT-2/ROT-4/GAME-1.
**Зависимости:** INFRA-4, INFRA-5.

### ROT-2. Редактор ротации LayerRotation.cfg (пул, порядок, drag-and-drop) [P1/P2]
**Контекст (SQSTAT):** SQSTAT редактирует ротацию как raw-textarea по дням недели с гейтом `canEdit` и флагами фракций у каждой строки (16-settings.md §16.4.2; 01-dashboard.md §4.5). У нас `rotation`-файлы лишь классифицированы в CFG-1 как «применится со следующего матча», отдельного редактора нет.
**Что сделать (P1):** Страница «Ротация» на странице сервера: упорядоченный список слоёв из `LayerRotation.cfg` (чтение через bridge `file_read`), каждая строка — карточка с картой/режимом/тикетами из каталога ROT-1; неизвестные каталогу строки помечаются warning-бейджем (сохранять как есть, `//`-комментарии и порядок вне управляемого списка не терять). Добавление из пула: фильтруемый picker по каталогу ROT-1 (map/gamemode/is_seed). Запись — managed-сегментная read-modify-write механика SYNC-3 (маркеры BEGIN/END MANAGED, атомарная запись, CRLF), бейдж «применится со следующего матча» (классификация из CFG-1); в Monaco-редакторе CFG-1 managed-сегмент `LayerRotation.cfg` — read-only с подсветкой «управляется панелью» (как Admins.cfg). Гейт записи: squad permission `changemap`; просмотр — `panel_access`. Каждое сохранение → audit (before/after текст сегмента). **(P2):** drag-and-drop порядок (с keyboard-фолбэком «вверх/вниз» для accessibility), копирование ротации на другой сервер (confirm с diff), кнопка «Перемешать» с сохранением ограничения «не более одного одинакового map подряд».
**Критерии приёмки:** сохранение не трогает строки вне managed-сегмента; drag-and-drop порядок совпадает с порядком строк в файле после записи; пользователь без `changemap` видит список read-only без кнопок; неизвестный слой сохраняется без потери и помечен в UI; операция в audit_log.
**Зависимости:** ROT-1, CFG-1, SYNC-3, INFRA-6.

### ROT-3. Виджет «текущая/следующая карта» + быстрая смена [P1]
**Контекст (SQSTAT):** правый сайдбар дашборда SQSTAT показывает current/next map (`map`, `nextMap`, `map_start`), кнопки «Сменить»/«Следующая»/skip/«Очистить следующую» и map-конфигуратор (01-dashboard.md §2.1.1, §4.5). У нас SRV-4 показывает только current layer, управления картой нет.
**Что сделать:** Виджет на странице сервера: текущий layer (карта/режим из ROT-1, время с начала матча — из события `match.started` EVT-1), следующий layer (`ShowNextMap` через RCON-1, poll вместе с ListPlayers). Действия (гейт: squad permission `changemap`, каждая → audit + confirm): «Следующая» — picker по каталогу ROT-1 → `AdminSetNextLayer <layer>`; «Сменить сейчас» → `AdminChangeLayer <layer>` (confirm с предупреждением о сбросе матча); «Завершить матч» → `AdminEndMatch`. WS push обновляет виджет при `match.started/ended` и смене next map. Пустой next (`ShowNextMap` без установленного) → «по ротации».
**Критерии приёмки:** установка next map отражается в виджете ≤30 с (или мгновенно по WS после действия из панели); все три действия в audit_log с layer в payload; без `changemap` кнопки скрыты, а API отвечает 403; picker не даёт отправить `deprecated` слой без явного подтверждения.
**Зависимости:** RCON-1, EVT-1, ROT-1, INFRA-6.

### ROT-4. Календарь ротации: планирование слоёв и недельные профили [P2/P3]
**Контекст (SQSTAT):** ключевой дифференциатор SQSTAT — ротации по дням недели (табы Стандартная/Пн–Вс, ✔/✘-индикация кастомных дней) и FullCalendar сыгранных карт `mapCalendar` (16-settings.md §16.4.2–16.4.3; 01-dashboard.md §4.5). Squad нативно недельных ротаций не умеет — реализуем поверх managed-cfg и планировщика (в соответствии с ADR ROT-1).
**Что сделать (P2):** Календарь на странице сервера, два слоя данных: (а) история сыгранных карт из событий `match.started/ended` (EVT-1) — read-only; (б) запланированные смены: таблица `rotation_schedule` (`id uuid`, `server_id`, `scheduled_at timestamptz`, `layer text` — валидация по ROT-1, `mode enum('set_next','force_change')`, `created_by uuid FK players.id`, `enabled bool`). Исполнение через scheduler AUTO-2: в `scheduled_at` → `AdminSetNextLayer` (или `AdminChangeLayer` для `force_change`); конфликт-чек с seed-расписанием SEED-3 и depot-update окном (warning при создании). CRUD-гейт: squad permission `changemap`, мутации → audit. Создание — кликом по слоту календаря с picker'ом ROT-1. **(P3):** недельные профили ротации: до 7 именованных вариантов managed-сегмента `LayerRotation.cfg` с привязкой к дням недели (default + переопределения, ✔/✘-индикация как у SQSTAT); worker в настраиваемое время (default 04:00 по TZ сервера) подменяет managed-сегмент профилем дня через механику ROT-2 (запись + audit `rotation.profile_applied`), «применится со следующего матча».
**Критерии приёмки:** сыгранные карты появляются в календаре из реальных событий; запланированная смена исполняется через AUTO-2 и видна в его истории и в audit; пересечение с сид-стартом SEED-3 даёт warning при сохранении; профиль дня недели применён — в файле сегмент профиля, вне сегмента ничего не изменилось; день без профиля использует default.
**Зависимости:** ROT-1, ROT-2, ROT-3, AUTO-2, EVT-1, SEED-3, INFRA-6.


---

# WS-18. Discord-интеграция: бот и вебхуки (из анализа SQSTAT)

### DISCORD-1. Настройки Discord-интеграции и безопасное хранение вебхуков [P1]
**Контекст (SQSTAT):** У конкурента вкладки `discordbot`/`discord` в настройках хранят guild_id, ID каналов и 12 вебхуков на типы событий (report, log, alert, cheater, grief, crash, endmatch, weekend, monitoring, request, collab_ban, collab_warn) — но рендерит живые webhook-токены прямо в HTML (rival-analysis/sections/16-settings.md, §16.3, критическая находка о leaked secrets). Функциональность переносим, дыру — нет.
**Что сделать:** Миграции: `discord_integration` (singleton на организацию: `guild_id text`, `bot_token_encrypted bytea NULL`, `enabled bool`) и `discord_webhooks` (`id uuid`, `event_type text` из фиксированного enum: `server_crashed`, `ban_issued`, `unban`, `kick`, `warn`, `admin_login`, `player_report`, `match_ended`, `map_changed`, `marked_player_joined`, `drift_detected`, `server_monitoring`; `webhook_url_encrypted bytea`, `channel_label text`, `enabled bool`, `mention_everyone bool default false`, `server_id uuid NULL FK` — NULL = все серверы). Секреты шифруются at-rest (ключ из env, задокументировать в `.env.example`); API `/api/v1/integrations/discord` (GET/PUT) и `/api/v1/integrations/discord/webhooks` (CRUD) никогда не возвращают URL целиком — только маску вида `…/1234…/****` и флаг `configured`; повторная запись URL требует полного нового значения. Redaction webhook-URL и bot-token во всех логах panели и воркеров (общий logger-фильтр по паттерну `discord.com/api/webhooks`). RBAC-гейт: новый panel-флаг роли `can_manage_integrations` (миграция к `roles`); чтение масок — тоже под этим флагом. Каждая мутация → audit_log (before/after с замаскированными секретами). UI: страница `/settings/integrations/discord` — список типов событий с toggle, полем URL (write-only), меткой канала, кнопкой «Test» (см. DISCORD-2), dark-mode, i18n EN/RU.
**Критерии приёмки:** GET настроек не содержит ни одного полного webhook-URL/токена (тест на маскирование); строка webhook-URL не появляется в логах api/workers при отправке и при ошибке (тест с форс-ошибкой); пользователь без `can_manage_integrations` получает 403 на все endpoints; мутации видны в audit_log без открытых секретов.
**Зависимости:** INFRA-5, INFRA-6, ROLE-1.

### DISCORD-2. Worker discord-notify: маршрутизация событий в вебхуки [P1]
**Контекст (SQSTAT):** Конкурент шлёт в Discord уведомления по каждому включённому типу события: краши сервера, баны, репорты, вход помеченного игрока (с `@everyone` при совпадении IP с баном), конец матча и т.д. (16-settings.md §16.3, таблица webhooks). Это ядро ценности интеграции — переносим на нашу шину событий.
**Что сделать:** Новый воркер `discord-notify`: подписка на `events` (envelope из EVT-1) и на записи `audit_log`/`moderation_actions` (ban/kick/warn/unban — MOD-2, admin_login — из auth-событий, crash — из статуса SRV-4, drift — SYNC-4, report — chat-команда `!report`). Маппинг «тип события → включённые вебхуки» из `discord_webhooks` (учитывая `server_id`); отправка Discord embed через webhook API с обработкой 429 (уважать `retry_after`), retry с backoff (макс. 5 попыток), очередь с dedup по `event_id` (at-least-once допустим, дубликаты подавляются). `mention_everyone` добавляет `@everyone` только для `marked_player_joined` при совпадении IP джойнящегося с активным баном (по `player_ip_history` + `moderation_actions`). Endpoint `POST /api/v1/integrations/discord/webhooks/{id}/test` (гейт `can_manage_integrations`) — тестовое сообщение, результат в UI. Метрики воркера: sent/failed/rate-limited (в observability из INFRA-3). Ошибки доставки не блокируют обработку событий панелью.
**Критерии приёмки:** бан из UI (MOD-2) приводит к сообщению в настроенный канал ≤5 с (интеграционный тест с mock Discord API); 429 от Discord → повтор после `retry_after`, без потери сообщения; выключенный вебхук не получает событий; kill воркера в момент отправки не теряет и не дублирует видимо событие после рестарта (dedup-тест); тестовая отправка возвращает пользователю успех/конкретную ошибку.
**Зависимости:** DISCORD-1, EVT-1, MOD-2, SYNC-4.

### DISCORD-3. Шаблоны Discord-сообщений [P2]
**Контекст (SQSTAT):** У конкурента формат сообщений зашит в PHP-бота; операторы не могут менять текст. Даём то же покрытие, но с редактируемыми шаблонами — «beat, not copy».
**Что сделать:** Таблица `discord_message_templates` (`event_type text UNIQUE`, `template jsonb` — title/description/color/fields с плейсхолдерами `{player_name}`, `{steam_id64}`, `{eos_id}`, `{server_name}`, `{reason}`, `{duration}`, `{actor_name}`, `{map}` и т.п.; `locale text` EN/RU). Дефолтные шаблоны сидятся миграцией для всех типов из DISCORD-1. Рендер в воркере discord-notify: подстановка с экранированием Discord-markdown, отсутствующий плейсхолдер → пустая строка + warn-лог. UI на `/settings/integrations/discord`: редактор шаблона с live-preview embed и кнопкой «Reset to default»; гейт `can_manage_integrations`; изменения → audit. Ссылки в embed ведут на карточку игрока панели (`/players/{id}` по uuid).
**Критерии приёмки:** изменённый шаблон применяется к следующему событию без рестарта воркера; сид создаёт шаблоны ровно один раз; невалидный плейсхолдер не роняет отправку; preview совпадает с реально доставленным embed (ручная проверка + snapshot-тест рендера).
**Зависимости:** DISCORD-2, UX-2.

### DISCORD-4. OAuth-линковка Discord-аккаунта к игроку [P2]
**Контекст (SQSTAT):** Конкурент связывает Discord-аккаунт с игроком и показывает флаг `discord` в списках и клановом ростере (93-action-catalog.md, §4.3 и таблицы `allPlayers`/`adminPlayers`); на линковке держится весь роль-синк и гейминг-движок (16-settings.md §16.3).
**Что сделать:** Discord OAuth2 (scope `identify`): `GET /api/v1/players/me/discord/link` → redirect на Discord, callback валидирует `state` (CSRF) и пишет в `player_discord_links` (`player_id uuid PK FK players.id`, `discord_user_id text UNIQUE`, `discord_username text`, `linked_at timestamptz`); один Discord-аккаунт — один игрок и наоборот, конфликт → понятная ошибка с указанием, что аккаунт уже привязан. Self-service линковка доступна любому залогиненному с `panel_access`; принудительная отвязка чужой линковки — `can_assign_roles`; линковка/отвязка → audit. Client id/secret — в настройках DISCORD-1 (шифрование как у вебхуков). UI: блок «Discord» на карточке игрока (PLAYER-4): username + дата линковки, кнопки Link/Unlink; бейдж «Discord» в списке `/users` (PLAYER-5).
**Критерии приёмки:** полный цикл link → отображение на карточке → unlink работает в браузере; повторная линковка того же Discord-аккаунта к другому игроку отклоняется; подделанный `state` → 403; записи в audit на link/unlink; discord_user_id не утекает в публичные endpoints.
**Зависимости:** DISCORD-1, PLAYER-4, AUTH-1.

### DISCORD-5. Роль-синк: роль панели → роль Discord [P3]
**Контекст (SQSTAT):** Конкурент синкает VIP/moderator-роли Discord с ролями панели (`vip_sync`/`moderator_sync`, 16-settings.md §16.3, вкладка discordbot). Полный gamification-движок (top-киллеры, playtime-тиры) — отдельная тема поверх STATS-*, здесь только базовый роль-синк.
**Что сделать:** Бот-часть воркера discord-notify (или отдельный воркер `discord-bot`) c bot_token из DISCORD-1 и правами Manage Roles в guild. Таблица `discord_role_mappings` (`role_id uuid FK roles.id`, `discord_role_id text`, `enabled bool`). На событие назначения/снятия роли (ROLE-2, через audit/событие) — выдать/забрать соответствующую Discord-роль линкованному игроку (DISCORD-4); периодический reconcile (раз в час) чинит дрейф в обе стороны с приоритетом панели (panel is source of truth), расхождения — в лог + опционально в monitoring-вебхук. Настройка маппингов в UI `/settings/integrations/discord`, гейт `can_manage_integrations`, мутации → audit. Отметить: применение к leaderboard-ролям (top-kills и т.п.) — будущее расширение после STATS-3, зафиксировать в описании интерфейса маппинга (source: panel_role сейчас, leaderboard позже).
**Критерии приёмки:** назначение роли игроку с линковкой выдаёт Discord-роль ≤60 с; снятие роли забирает её; игрок без линковки — no-op без ошибок; reconcile восстанавливает вручную снятую в Discord роль; отсутствие у бота права Manage Roles → внятная ошибка в UI, а не тихий фейл.
**Зависимости:** DISCORD-4, DISCORD-2, ROLE-2.

### DISCORD-6. Discord-бот: команды и статус-каналы [P3]
**Контекст (SQSTAT):** У конкурента бот переименовывает канал в живой статус сервера (шаблон `🟢c_100x7_👮2` — карта, онлайн, число админов; 16-settings.md §16.3, поле `chan_id`) и обслуживает admin-заявки/уведомления. Переносим статус-канал и read-only slash-команды.
**Что сделать:** В воркере discord-bot: (1) статус-канал — поле `status_channel_id` на сервер (миграция к `servers` или в `discord_webhooks`), переименование канала раз в 5–10 мин (лимиты Discord на channel rename — 2 запроса/10 мин, соблюдать) в шаблон `{emoji}{map_code}_{players}x{queue}_{admins}` из данных RCON-poll (MOD-1/PRES-2); (2) slash-команды `/status [server]` (карта, онлайн, очередь), `/player <name|steamid>` (краткая карточка + ссылка на панель), `/online-admins`; команды доступны только Discord-аккаунтам, линкованным (DISCORD-4) с игроком, чья роль имеет `panel_access`; ответы ephemeral; каждый вызов команды → audit_log (actor = player по линковке). Никаких мутирующих команд (ban/kick из Discord) в этой задаче — зафиксировать как явный не-скоуп с отсылкой к MOD-2 UI.
**Критерии приёмки:** канал показывает актуальные карту/онлайн с отставанием ≤10 мин без превышения rate-limit (нет 429 в логах за сутки soak); `/status` от нелинкованного или без `panel_access` → отказ с подсказкой линковки; `/player` находит игрока по нику и steam_id64 и даёт ссылку на `/players/{uuid}`; вызовы команд видны в audit.
**Зависимости:** DISCORD-4, DISCORD-5, RCON-1, MOD-1.


---

# WS-18. Баг-трекер и видео/демо-доказательства (из анализа SQSTAT)

### ISSUE-1. Модель и API внутреннего трекера тикетов [P2]
**Контекст (SQSTAT):** У конкурента есть встроенный баг-трекер (глава 15, §15.1): админы подают тикеты «Баг»/«Предложение» о самой панели, список фильтруется open/closed с пагинацией по 20. У SQSTAT трекер create/read-only — статусы, назначение и комментарии существуют в данных, но не в UI; это прямая точка дифференциации (§15.3).
**Что сделать:** Миграции: таблица `issues` (`id uuid v7 PK`, `number bigserial UNIQUE` для человекочитаемого «#42», `author_player_id uuid NOT NULL FK players.id`, `assignee_player_id uuid NULL FK players.id`, `title text NOT NULL CHECK length<=200`, `body text NOT NULL CHECK length<=4000`, `state text CHECK IN ('open','in_progress','closed')`, `created_at`, `updated_at`, `closed_at NULL`); таблица `issue_labels` (`id`, `name`, `color`, `is_system`) с сидом `bug`/`suggestion`/`question`; связка `issue_label_links (issue_id, label_id)`; таблица `issue_comments` (`id uuid`, `issue_id FK`, `author_player_id uuid FK players.id`, `body text CHECK length<=4000`, `created_at`). API: `POST /api/v1/issues`, `GET /api/v1/issues?state=&label=&assignee=&q=&page=&per_page=` (серверная пагинация и полнотекстовый поиск по title/body через `tsvector`), `GET /api/v1/issues/{id}`, `PATCH /api/v1/issues/{id}` (title/body/labels/assignee/state), `POST /api/v1/issues/{id}/comments`. RBAC-гейт: чтение и создание тикетов/комментариев — `panel_access`; смена state, назначение assignee и редактирование чужих тикетов — новый panel-флаг роли **`can_manage_issues`** (миграция добавляет колонку в `roles`, Owner получает флаг автоматически). Все мутации пишут before/after в `audit_log`.
**Критерии приёмки:** тикет создаётся с автором = текущий игрок и попадает в `state=open`; фильтры state/label/assignee и поиск возвращают корректные срезы с пагинацией; пользователь без `can_manage_issues` получает 403 на закрытие чужого тикета, но может закрыть свой; каждая мутация видна в audit_log с before/after.
**Зависимости:** INFRA-5, INFRA-6, ROLE-1.

### ISSUE-2. UI трекера `/issues`: список, создание, карточка тикета [P2]
**Контекст (SQSTAT):** Страница issues у конкурента — карточный список с двумя кнопками-фильтрами и модалкой создания (body ≤512 симв. + 2 метки); нет поиска, пагинации в UI, автора и деталей (§15.1.3–15.1.5). Реализуем полноценный экран, закрывая эти пробелы.
**Что сделать:** Страница `/issues`: таблица/карточный список (номер `#N`, title, цветные label-чипы, автор, assignee, state-бейдж, created/updated), фильтры по state/label/assignee, строка поиска, реальная пагинация. Кнопка «Создать» → форма (title, body, мультиселект меток) с inline-валидацией лимитов. Карточка тикета `/issues/{id}`: полное описание, лента комментариев с формой добавления, панель действий (закрыть/переоткрыть/взять в работу, назначить assignee — видимость по `can_manage_issues`), ссылка на автора → карточка игрока `/players/{id}`. Обновление ленты комментариев и state по WebSocket-push. Dark-mode, все строки через i18n-слой (EN/RU).
**Критерии приёмки:** создание, комментирование, закрытие и переоткрытие работают из UI и отражаются без перезагрузки страницы; фильтры и пагинация меняют URL (deep-link работает); у пользователя без `can_manage_issues` кнопки управления скрыты, а прямой вызов API даёт 403 с человекочитаемой ошибкой; пустой список показывает empty-state с CTA «Создать тикет».
**Зависимости:** ISSUE-1, UX-1, UX-2.

### ISSUE-3. Связь тикетов с сущностями панели и авто-тикеты из модерации [P3]
**Контекст (SQSTAT):** У конкурента тикеты — свободный текст без привязок; выводы §15.3 прямо называют структурную связь с сущностями лёгким преимуществом. В нашей панели тикет должен уметь ссылаться на игрока, сервер или moderation action (например «разобраться с жалобой на игрока X»).
**Что сделать:** Таблица `issue_links` (`issue_id FK`, `entity_type text CHECK IN ('player','server','moderation_action','media_file')`, `entity_id uuid`, UNIQUE по тройке). API: `POST/DELETE /api/v1/issues/{id}/links`; в `GET /api/v1/issues/{id}` — развёрнутые ссылки (имя игрока, имя сервера и т.д.). UI: блок «Связанные объекты» на карточке тикета с автодополнением по игрокам/серверам; на карточке игрока `/players/{id}` — счётчик и список связанных открытых тикетов. Кнопка «Создать тикет» из карточки moderation action (предзаполняет link и title). Гейт: как в ISSUE-1 (`panel_access` на чтение/добавление своих ссылок, `can_manage_issues` на удаление чужих). Audit на добавление/удаление ссылок.
**Критерии приёмки:** тикет, созданный из moderation action, автоматически связан с ним и с игроком-нарушителем; удаление игрока невозможно при живых ссылках либо ссылки каскадно помечаются (зафиксировать выбранную стратегию в миграции); блок ссылок кликабелен и ведёт на соответствующие карточки.
**Зависимости:** ISSUE-1, ISSUE-2, MOD-2, PLAYER-4.

### VIDEO-1. Медиа-хранилище: таблица, upload API, лимиты, стриминг [P1]
**Контекст (SQSTAT):** У конкурента есть страница Video/Demos (глава 15, §15.2): drag-and-drop загрузка MP4/AVI до 2 ГБ с прогресс-баром, но хранение вынесено на YouTube/Telegram, нет плеера в панели и нет структурных привязок. Делаем собственное медиа-хранилище как фундамент для evidence.
**Что сделать:** Таблица `media_files` (`id uuid v7 PK`, `uploader_player_id uuid NULL FK players.id` — NULL для токен-загрузок, `kind text CHECK IN ('video','image','external_link')`, `original_filename`, `mime_type`, `size_bytes`, `sha256`, `storage_path text NULL`, `external_url text NULL` — CHECK: заполнено ровно одно из storage_path/external_url, `title`, `description`, `created_at`, `deleted_at NULL` soft-delete). Файлы хранятся на выделенном named volume `media-storage`, смонтированном в `api`; путь = `media/<yyyy>/<mm>/<uuid>.<ext>`. API: `POST /api/v1/media` — resumable chunked upload (tus-протокол или chunk+offset), допустимые mime `video/mp4`, `video/webm`, `image/png`, `image/jpeg`; лимит размера из настроек организации (default 2 GiB), проверка magic bytes, подсчёт sha256 и дедупликация по хешу; `POST /api/v1/media/link` — регистрация внешней ссылки (YouTube/Discord CDN и т.п.) с валидацией URL; `GET /api/v1/media/{id}/stream` — отдача с поддержкой HTTP Range (перемотка в плеере); `GET /api/v1/media/{id}`, `DELETE /api/v1/media/{id}` (soft-delete). RBAC-гейт: загрузка и просмотр — `panel_access`; удаление чужих файлов — новый panel-флаг роли **`can_manage_media`**. Квота volume мониторится: при заполнении >90% — алерт в observability. Upload и delete → audit_log.
**Критерии приёмки:** загрузка 1.5 GiB mp4 проходит с докера наружу (проверка с хоста через реальный endpoint), переживает обрыв соединения и докачивается с offset; файл с неверными magic bytes отклоняется с точной ошибкой; range-запрос `bytes=1000000-` возвращает 206; повторная загрузка того же файла не дублирует место на диске; soft-delete скрывает файл из выдачи, но строка и audit остаются.
**Зависимости:** INFRA-1, INFRA-5, INFRA-6, ROLE-1.

### VIDEO-2. Привязка медиа к игроку/матчу/бану/репорту и просмотр в историях [P1/P2]
**Контекст (SQSTAT):** Ключевой недостаток конкурента (§15.2.2, §15.3): видео связывается с нарушителем только прозой в description. Структурная привязка demo → игрок/матч/бан с встроенным плеером — прямое конкурентное преимущество.
**Что сделать:** [P1] Таблица `media_links` (`media_id FK media_files`, `entity_type text CHECK IN ('player','moderation_action','match','issue')`, `entity_id uuid`, `linked_by_player_id uuid FK players.id`, `created_at`, UNIQUE по media+entity). API: `POST/DELETE /api/v1/media/{id}/links`, `GET /api/v1/players/{id}/media`, `GET /api/v1/moderation-actions/{id}/media`. Поле `evidence[]` в `moderation_actions` (MOD-2/MOD-3) заменяется ссылками через `media_links` — UI модерации при бане/кике предлагает прикрепить файл или ссылку прямо в confirm-диалоге. UI: вкладка «Evidence» на карточке игрока `/players/{id}` — сетка превью с встроенным HTML5-плеером (стриминг из VIDEO-1, jump-to-timestamp через `?t=`), у каждой записи — кто и когда прикрепил, к какому действию. [P2] entity_type `match`: привязка к матчу из events (EVT-1) с выбором раунда из истории матчей. Гейт: прикрепление — `panel_access`; открепление чужого — `can_manage_media`. Все привязки/открепления → audit.
**Критерии приёмки:** видео, прикреплённое при бане, видно в moderation history этого бана и на вкладке Evidence игрока; плеер играет с перемоткой прямо в панели (браузерное подтверждение); EOS-only игрок (без steam_id64) корректно накапливает evidence через `players.id`; открепление без `can_manage_media` чужой привязки → 403.
**Зависимости:** VIDEO-1, MOD-2, PLAYER-4, EVT-1 (для [P2]-части).

### VIDEO-3. Делегированная загрузка по одноразовому токену [P2]
**Контекст (SQSTAT):** Двухэндпоинтная схема конкурента (§15.0.3–15.0.4, §15.3): админ минтит одноразовый токен (2 часа, 1 использование), внешний игрок грузит файл без аккаунта через public-endpoint. Переносим паттерн и усиливаем его: токен заранее привязывается к цели (игрок/moderation action), так что footage автоматически ложится в нужное дело.
**Что сделать:** Таблица `media_upload_tokens` (`id uuid`, `token_hash bytea` — в БД только sha256 токена, `issued_by_player_id uuid FK players.id`, `target_entity_type/target_entity_id NULL` — предпривязка из VIDEO-2, `expires_at` = now()+2h настраиваемо, `used_at NULL`, `max_size_bytes`). API: `POST /api/v1/media/upload-tokens` (гейт `panel_access`; ответ содержит одноразовый URL вида `/upload/{token}` — показывается один раз); публичные endpoints без сессии панели: `GET /upload/{token}` — минимальная страница загрузки (drag-and-drop, прогресс-бар c МБ и скоростью, dark-mode, i18n EN/RU), `POST /api/v1/public/media?token=` — приём файла через механику VIDEO-1 с лимитами токена; атомарная отметка `used_at` (повторное использование → 410). Rate-limit на public-endpoint по IP. После успешной загрузки файл автоматически получает `media_links` на предпривязанную цель и статус «ожидает модерации»: виден админам с пометкой untrusted, минтер получает WebSocket-уведомление. Минт и погашение токена → audit.
**Критерии приёмки:** ссылка работает ровно один раз и умирает через 2 часа (оба случая — тестом); файл, загруженный по токену с предпривязкой к бану, появляется в evidence этого бана с пометкой «загружено по ссылке, аноним»; повторный POST с тем же токеном → 410; страница загрузки работает без cookie/сессии панели (браузерное подтверждение).
**Зависимости:** VIDEO-1, VIDEO-2.

### VIDEO-4. Внешняя публикация медиа: YouTube/Telegram fan-out [P4]
**Контекст (SQSTAT):** Конкурент фан-аутит каждый ролик в YouTube + Telegram (§15.2.1, §15.2.5) — это экономит диск и даёт публичный канал «нарушений», но без плеера в панели и с квотной задержкой YouTube. У нас первичное хранение своё (VIDEO-1), публикация — опциональная надстройка для комьюнити-канала.
**Что сделать:** Новый worker `media-publisher`: очередь публикаций (`media_publications`: `media_id FK`, `destination CHECK IN ('youtube','telegram')`, `status CHECK IN ('queued','uploading','published','failed')`, `external_id/external_url NULL`, `error NULL`, retry с backoff и уважением daily-квоты YouTube API). Настройки организации: OAuth-credentials YouTube и bot-token/chat_id Telegram — только через env/секреты, в UI лишь статус подключения. UI: на карточке медиа кнопка «Опубликовать» (выбор направлений) — гейт `can_manage_media`; статус публикации и внешняя ссылка отображаются на карточке; после успешной публикации опционально освобождать локальный файл, оставляя `external_url` (переключатель в настройках). Публикация и удаление → audit. Отметить: фича носит витринно-комьюнитийный характер (публичный канал нарушений), не входит в ядро модерации.
**Критерии приёмки:** ролик уходит в тестовый Telegram-канал и появляется `external_url`; ошибка квоты YouTube переводит задачу в retry, а не в failed, и видна в UI; секреты не попадают в логи и audit; режим «освободить локальный файл» сохраняет воспроизведение по внешней ссылке.
**Зависимости:** VIDEO-1, VIDEO-2, INFRA-3.


---

# WS-17. Экономика бонусов и VIP-подписки (из анализа SQSTAT)

### ECON-1. Модель данных экономики: леджер бонусов и баланс [P2]
**Контекст (SQSTAT):** У конкурента каждый игрок имеет целочисленный бонусный баланс («Ваши бонусы» в шапке профиля), а roster VIP несёт live-поля `online/boost/queue` — бонусы начисляются за проведённое время и служат внутренней валютой (rival-analysis §04 п.2.1, §06 п.2.2). Это монетизационная/лояльностная механика, у нас пока есть только формула-заглушка в PRES-4.
**Что сделать:** Таблица `bonus_transactions` (append-only леджер): `id bigserial`, `player_id uuid FK players.id`, `amount int` (знаковый), `type` enum (`earn_online|earn_boost|earn_seed|spend|adjust`), `reference_type/reference_id` (ссылка на источник: день начисления `player_daily_presence`, покупка VIPSUB-5, ручная корректировка), `comment`, `actor_player_id uuid NULL` (для ручных операций), `created_at`. Партиционирование по месяцам (pg_partman), retention 24 мес. Денормализованный `players.bonus_balance int NOT NULL DEFAULT 0`, обновляемый в одной транзакции со вставкой в леджер; reconciliation-джоба сверяет `bonus_balance == SUM(amount)`. Уникальный индекс `(player_id, type, reference_type, reference_id)` для идемпотентности начислений. Ручные `adjust` пишутся в `audit_log` (before/after баланса).
**Критерии приёмки:** баланс всегда равен сумме леджера (reconciliation-тест); повторная вставка начисления за тот же день отклоняется constraint'ом; списание ниже нуля невозможно (CHECK/транзакционная проверка); `adjust` виден в audit с автором.
**Зависимости:** INFRA-5, INFRA-6, PRES-2.

### ECON-2. Worker-economy: начисление бонусов за онлайн/буст/сид [P2]
**Контекст (SQSTAT):** Конкурент начисляет бонусы за накопленный онлайн и boost-время (поля `online.online`, `online.boost` в roster VIP, rival-analysis §06 п.2.2); формула у нас предварительно зафиксирована в PRES-4 как `online + 2×boost`. Нужен реальный механизм начисления.
**Что сделать:** Новый worker `worker-economy` (или джоба в существующем presence-агрегаторе): после финализации дня в `player_daily_presence` (PRES-2) начисляет каждому игроку `round(k_online×online_seconds/3600 + k_boost×boost_seconds/3600 + k_seed×seed_seconds/3600)` бонусов одной транзакцией `earn_online`/`earn_boost`/`earn_seed` с `reference = (player_id, day)`. Seed-время: секунды сессий, когда на сервере было < `seed_threshold` игроков (порог из настроек ECON-3; счётчик игроков — из RCON-poll worker-rcon, снапшоты уже есть у MOD-1/PRES-1) — добавить колонку `seed_seconds` в `player_daily_presence`. Пересчёт дня идемпотентен: при recompute старые транзакции дня сторнируются или заменяются (upsert по уникальному ключу ECON-1). Начисления не пишутся в audit_log (машинные), но метрики worker'а — в observability.
**Критерии приёмки:** день с 2ч online + 1ч boost при дефолтных коэффициентах даёт ожидаемую сумму; повторный запуск за тот же день не задваивает баланс; сессия на пустом сервере (< порога) даёт `earn_seed`; EOS-only игрок (без steam_id64) получает начисления наравне со всеми.
**Зависимости:** ECON-1, PRES-2, PRES-4.

### ECON-3. Настройки экономики организации `/settings/economy` [P2]
**Контекст (SQSTAT):** У конкурента формула и коэффициенты зашиты на сервере; наша PRES-4 явно откладывает «настройку формулы» на P2 — эта задача её реализует.
**Что сделать:** Страница `/settings/economy` и таблица `organization_settings` (key/value JSONB) или выделенная `economy_settings`: `k_online`, `k_boost`, `k_seed` (float, дефолты 1/2/3), `seed_threshold` (int, дефолт 40), `economy_enabled` (bool), стоимости привилегий для ECON-6/VIPSUB-5 (JSONB-каталог `{vip_tier_id: {days, price}}`). API `GET/PUT /api/v1/settings/economy`. RBAC-гейт: новый panel-флаг роли `can_manage_economy` (миграция ROLE-1-модели; Owner имеет всегда). Каждое изменение — audit_log (before/after). Изменение коэффициентов действует только на будущие начисления (леджер не пересчитывается ретроактивно). UI: форма с валидацией, dark-mode, i18n EN/RU. Явно пометить в UI и доках: экономика — монетизационная механика, по умолчанию выключена.
**Критерии приёмки:** изменение `k_boost` меняет начисления следующего дня и не трогает прошлые; PUT без `can_manage_roles`/`can_manage_economy` → 403; изменение видно в audit; при `economy_enabled=false` worker ECON-2 не начисляет и UI-блоки скрыты.
**Зависимости:** ECON-1, ROLE-1, INFRA-6.

### ECON-4. UI экономики на карточке игрока: баланс, история, корректировки [P2]
**Контекст (SQSTAT):** Профиль конкурента показывает владельцу баланс бонусов, VIP-статус и подписки прямо в шапке (rival-analysis §04 п.2.1) — профиль работает как лояльностный дашборд.
**Что сделать:** На карточке `/players/{id}`: card «Бонусы: N» (заменяет вычисляемую заглушку PRES-4 — читает `players.bonus_balance`), рядом VIP-статус «до DD.MM.YYYY» (из VIPSUB-1). Tab/секция «История бонусов»: `GET /api/v1/players/{id}/bonus-transactions?type=&from=&to=` (пагинация, из леджера ECON-1) — тип, сумма, источник, автор, дата. Кнопка «Корректировать баланс» (модал: ±amount, обязательный comment) → `POST /api/v1/players/{id}/bonus-adjustments`; гейт — `can_manage_economy` (ECON-3); WebSocket-пуш обновляет баланс без перезагрузки. Просмотр баланса/истории доступен любому с `panel_access`.
**Критерии приёмки:** корректировка из UI мгновенно меняет card и создаёт строку истории и audit-запись; фильтры истории работают; без `can_manage_economy` кнопка скрыта и API отвечает 403.
**Зависимости:** ECON-1, ECON-3, PLAYER-4.

### ECON-5. Лидерборд по бонусам [P2/P3]
**Контекст (SQSTAT):** Конкурент строит топы игроков и конвертирует их в Discord-роли (rival-analysis §16.3 Discord Bot); публичный рейтинг по бонусам/онлайну — retention-механика.
**Что сделать (P2):** `GET /api/v1/leaderboards/bonuses?period=all|30d&limit=100` — топ по балансу (all) и по сумме начислений за окно (30d, из леджера; материализованное представление с refresh раз в час). Страница `/leaderboards/bonuses`: таблица (место, ник, баланс/начислено, суммарный онлайн из PRES-2), клик → карточка игрока; гейт `panel_access`. **(P3):** опциональная публичная read-only версия страницы (флаг в ECON-3) без PII (только ник + значения).
**Критерии приёмки:** топ-100 отдаётся <500 мс (читает materialized view); период 30d считает начисления, а не баланс; EOS-only игроки присутствуют; при выключенной экономике страница скрыта из навигации.
**Зависимости:** ECON-1, ECON-2, PRES-2.

### ECON-6. Трата бонусов на привилегии (внутренний магазин) [P3]
**Контекст (SQSTAT):** У конкурента бонусы — валюта, на которую игрок получает VIP/подписки (профиль объединяет баланс, VIP-до-даты и «Подписки», rival-analysis §04 п.2.1). Явно монетизационная механика.
**Что сделать:** «Магазин привилегий»: каталог из ECON-3 (тир VIP → срок → цена в бонусах). `POST /api/v1/players/{id}/bonus-purchases {tier_id}`: одна транзакция БД — списание `spend` из леджера (с проверкой баланса), выдача/продление срочной роли через механику VIPSUB-1 (продление = `role_expires_at += days`), audit. Выполняется либо админом с `can_manage_economy` с карточки игрока, либо самим игроком через self-service VIPSUB-5. Отказ при недостатке средств — атомарный, без частичного списания.
**Критерии приёмки:** покупка списывает ровно цену, выдаёт роль на срок и триггерит SYNC-3 (строка появляется в Admins.cfg); недостаток баланса → 409 без изменений; два конкурентных запроса не уводят баланс в минус (тест на race); всё в audit.
**Зависимости:** ECON-1, ECON-3, VIPSUB-1, SYNC-3.

### VIPSUB-1. Срочные назначения ролей: `role_expires_at` + worker-чистильщик [P1]
**Контекст (SQSTAT):** Ядро VIP-механики конкурента — `changeGroup` с термом (`date`, пресеты день/1·2·3·6 мес/год/навсегда) и quick-кнопкой «VIP +1 месяц» (rival-analysis §06 п.3B, §7). У нас WL-3 (P3) упоминает `role_expires_at` мимоходом — эта задача выносит механику в отдельный переиспользуемый P1-фундамент.
**Что сделать:** Добавить `role_expires_at timestamptz NULL` и `role_comment varchar(128) NULL` к назначению роли игрока (модель ROLE-2; NULL = бессрочно). API назначения (`PUT /api/v1/players/{id}/role`) принимает `expires_at` и `comment`; UI-виджет роли (ROLE-5-модал) получает пресеты срока: день / +1 / +2 / +3 / +6 мес / +1 год / навсегда и quick-кнопку «+1 месяц» (продлевает от `max(now, role_expires_at)`). Новый worker `role-expirer` (интервал ≤5 мин): находит истёкшие назначения, снимает роль (`role_id=NULL`), пишет audit-запись с системным актором и триггерит SYNC-3 (перегенерация managed-сегмента Admins.cfg + `AdminReloadServerConfig`). Гейт — существующий `can_assign_roles`; самоснятие/самопродление запрещено (как в ROLE-2). Срок и комментарий видны на карточке игрока и в списке `/users`.
**Критерии приёмки:** роль, выданная «на день», через сутки автоматически снята, строка исчезла из Admins.cfg без рестарта; «+1 месяц» от активного срока продлевает от `role_expires_at`, от истёкшего — от `now`; worker идемпотентен и переживает рестарт; все выдачи/снятия/автоснятия в audit.
**Зависимости:** ROLE-2, SYNC-3, INFRA-6.

### VIPSUB-2. VIP-roster: страница `/vips` [P2]
**Контекст (SQSTAT):** Страница `vips` конкурента — read+search roster всех держателей привилегий: SteamID, ник, срок, last seen, накопленный онлайн, заметка; 395 строк, drill-in в карточку (rival-analysis §06 п.1, §4–5). У нас есть только `/settings/groups/{role_id}/members` по одной роли.
**Что сделать:** Страница `/vips` и `GET /api/v1/role-assignments?role_ids=&q=&last_seen_from=&last_seen_to=&expiring_within_days=&page=` — сводный список игроков со ВСЕМИ ролями сразу (JOIN players × roles): колонки бейдж роли (цвет/имя), ник, SteamID64/EOS, срок (`role_expires_at`, «∞» для бессрочных, подсветка «истекает ≤7 дн»), last seen (из PRES-данных), суммарный онлайн (`players.total_time_played_seconds`), комментарий. Фильтры: роль (мультиселект), ник/ID, диапазон last seen, «скоро истекает». Клик по строке → карточка игрока. Сортировка по сроку/last seen/онлайну, серверная пагинация 50. Гейт — `panel_access` (read); мутации только через виджет роли (VIPSUB-1). Dark-mode, i18n.
**Критерии приёмки:** roster на 500+ назначениях пагинируется и фильтруется <1 с; фильтр «истекает ≤7 дн» совпадает с данными; EOS-only игроки отображаются; страница не содержит собственных мутаций.
**Зависимости:** VIPSUB-1, PRES-2, PLAYER-4.

### VIPSUB-3. Тиры VIP-привилегий (каталог) [P2]
**Контекст (SQSTAT):** У конкурента VIP — один `group_id=3` с permission `reserve` («QueuePriority» — чистый queue-skip, rival-analysis §16.3 матрица групп), плюс клановый reserved-slot. Тиры позволяют продавать разные наборы (только reserve / reserve+cameraman и т.д.) на разные сроки. Монетизационная механика.
**Что сделать:** Таблица `vip_tiers`: `id uuid`, `name`, `role_id uuid FK roles.id`, `description`, `default_days int NULL`, `sort_order`, `is_active`. Тир ссылается на существующую роль RBAC (например «VIP Bronze» → роль с `reserve`; «VIP Gold» → роль с `reserve+cameraman+balance`) — приоритет очереди в Squad бинарен (`reserve`), поэтому тиры различаются составом squad_permissions и панельными плюшками, что зафиксировать в описании тира. CRUD `GET/POST/PUT/DELETE /api/v1/vip-tiers`, управление на `/settings/economy` (секция «VIP-тиры»), гейт `can_edit_roles`. Выдача тира = выдача его роли через VIPSUB-1 (с дефолтным сроком тира); тиры используются каталогом ECON-6/VIPSUB-5. Audit на CRUD.
**Критерии приёмки:** создание тира и выдача его игроку кладёт нужные permissions в Admins.cfg; деактивация тира скрывает его из магазина, не снимая уже выданные роли; удаление тира с активными назначениями запрещено (409).
**Зависимости:** ROLE-1, VIPSUB-1, ECON-3.

### VIPSUB-4. Напоминания об истечении VIP [P2]
**Контекст (SQSTAT):** Конкурент ищет «скоро истекающих» VIP только ручным поиском по roster (rival-analysis §06 п.9 «retention tooling»); проактивные напоминания — способ обойти его в удержании доноров.
**Что сделать:** Расширить механику алертов AUTO-3 типом `role_expiring`: ежедневная джоба worker'а `role-expirer` (VIPSUB-1) находит назначения с `role_expires_at` в окнах 7/3/1 день и создаёт уведомления: (а) админам с `can_assign_roles` — панельное уведомление + email/Web Push по каналам AUTO-3; (б) самому игроку — in-game `AdminWarn "<id>" VIP expires in N days` при его следующем заходе на сервер (по событию `player.connected` из EVT-1; максимум одно предупреждение на окно). Дедупликация: таблица `expiry_notifications (assignment_ref, window)` — повторно не слать. Бейдж «истекает» на карточке игрока и в `/vips` (VIPSUB-2). Настройка окон и каналов — на `/settings/economy`.
**Критерии приёмки:** роль с истечением через 3 дня порождает ровно одно уведомление окна «3d» (повторный прогон джобы не дублирует); игрок при заходе получает AdminWarn один раз; продление роли сбрасывает выданные окна.
**Зависимости:** VIPSUB-1, AUTO-3, EVT-1, RCON-1.

### VIPSUB-5. Подписки и самообслуживание VIP [P3]
**Контекст (SQSTAT):** Профиль конкурента показывает владельцу «Подписки» (активные recurring) отдельно от разового VIP (rival-analysis §04 п.2.1) — VIP продаётся и как подписка. Явно монетизационная механика.
**Что сделать:** Таблица `vip_subscriptions`: `id uuid`, `player_id uuid FK players.id`, `tier_id FK vip_tiers.id`, `status` (`active|cancelled|expired`), `renews_every_days`, `price_bonuses int`, `next_renewal_at`, `created_at/cancelled_at`. Джоба в worker'е `role-expirer`: в `next_renewal_at` пытается списать `price_bonuses` через ECON-6-механику → при успехе продлевает роль (VIPSUB-1) и сдвигает `next_renewal_at`; при нехватке средств — помечает `expired`, шлёт уведомление (VIPSUB-4-каналы). Self-service: страница `/me` для аутентифицированного игрока БЕЗ `panel_access` (Steam-логин AUTH уже есть; доступ только к собственным данным — отдельный минимальный layout): баланс, история бонусов, активный VIP/подписка, покупка/продление тира за бонусы (`POST /api/v1/me/purchases`, `POST/DELETE /api/v1/me/subscriptions`). Админ-выдача подписки — с карточки игрока, гейт `can_manage_economy`. Все операции в audit. Оплата реальными деньгами (платёжный шлюз) — вне скоупа, зафиксировать как отдельное будущее исследование; валюта здесь — только бонусы ECON.
**Критерии приёмки:** подписка автопродлевается при достаточном балансе (роль продлена, бонусы списаны, audit); при нехватке — статус `expired`, роль доснимается VIPSUB-1 по сроку, игрок уведомлён; игрок без `panel_access` видит на `/me` только себя (доступ к чужим id → 403); отмена подписки не отзывает уже оплаченный период.
**Зависимости:** VIPSUB-1, VIPSUB-3, ECON-6, ECON-4.


---

# WS-LEAD. Лидерборды, топы и серверная статистика (из анализа SQSTAT)

### LEAD-1. Материализованные агрегаты для топов: player_stat_periods + worker leaderboard-aggregator [P1/P2]
**Контекст (SQSTAT):** Топ SQSTAT (`topPlayers`, глава 20) считает рейтинг тяжёлым live-SQL по всей базе — на проде запрос сломан и отдаёт клиенту сырой SQL. Дашборд статистики (глава 11) — один RPC на ~1.5 с из ~8 агрегатных запросов. Оба случая показывают: без предагрегации топы и стат-срезы не масштабируются.
**Что сделать:** Таблица `player_stat_periods`: `player_id uuid` FK → `players.id`, `server_id uuid NULL` (NULL = все серверы), `period_type` (`day|week|month|season|alltime`), `period_start date`, метрики `online_seconds`, `seeding_seconds`, `kills`, `deaths`, `teamkills`, `revives`, `kd_ratio numeric` (deaths=0 → kills), `matches_played`. PK `(player_id, server_id, period_type, period_start)`, партиционирование по `period_type/period_start` (pg_partman), индексы по каждой сортируемой метрике `(period_type, period_start, server_id, <metric> DESC)`. **[P1]** источники online/seeding — `player_daily_presence` (PRES-2) + события EVT-1; worker `leaderboard-aggregator` (расширение схемы существующих workers) пересчитывает текущие day/week/month каждые 15 минут, закрытые периоды финализирует и не трогает; recompute идемпотентен. **[P2]** combat-метрики (kills/deaths/revives/teamkills) подтягиваются из stats-importer (STATS-3), до его готовности колонки заполняются нулями и в API помечаются `available:false`. Rollup `server_id=NULL` = сумма по серверам с пересчётом kd. Redis-кэш готовых страниц топов TTL 60 с, инвалидация после пересчёта.
**Критерии приёмки:** пересчёт недельного периода дважды даёт идентичные строки; сессия через полночь попадает в оба дня и ровно один раз в неделю; SUM(online_seconds) по day-строкам == SUM по `player_daily_presence` (reconciliation-тест); выборка топ-100 по любой метрике за любой период < 100 мс на 100k игроков (EXPLAIN использует индекс, без seq scan).
**Зависимости:** INFRA-5, PRES-2, EVT-1, STATS-3.

### LEAD-2. API лидербордов `/api/v1/leaderboards` [P1]
**Контекст (SQSTAT):** `POST /ajax/table.php action=topPlayers` (глава 20) — пагинация 30/страница, фильтр по нику/SteamID, сортировка только через селектор метрики; при ошибке эндпоинт утекает сырой SQL и ошибку драйвера клиенту. Переносим контракт, закрываем дыру.
**Что сделать:** `GET /api/v1/leaderboards?metric=online|kills|deaths|kd|revives|teamkills|seeding|bonus&period=day|week|month|season|alltime&period_start=<date>&server_id=<uuid|all>&search=<nick|steam_id64|eos_id>&page=&per_page=` поверх LEAD-1. Ответ: `rows[{rank, player_id, current_name, steam_id64, eos_id, metric_value, secondary:{online_seconds,kills,deaths,kd}}]`, `total_rows`, `total_pages`; rank — глобальный по срезу, не по странице. Ошибки — только opaque envelope `{error:{code,message}}`, никаких SQL/stack (регресс-тест). RBAC-гейт: `panel_access`; публичная выдача — отдельным read-only слоём в AN-2 (см. amendments), управляется настройкой `leaderboards_public` (Owner, запись в audit_log). Rate limit на search-запросы. OpenAPI-схема (UX-1).
**Критерии приёмки:** пагинация и rank стабильны при одинаковых значениях метрики (tie-break по player_id); поиск по частичному нику и точному steam_id64/eos_id работает; принудительно сломанный запрос к БД возвращает opaque-ошибку без текста SQL; p95 ответа топ-страницы < 200 мс (кэш LEAD-1).
**Зависимости:** LEAD-1, PLAYER-2.

### LEAD-3. UI `/leaderboards`: страница топов с окнами периодов [P1]
**Контекст (SQSTAT):** Страница `top` (глава 20) — фикс-рейл фильтров, таблица 30/страница, клик по строке открывает досье игрока. Ключевые слабости конкурента: заголовки-иконки без подписей и без сортировки, и главное — нет окна времени (datepicker мёртвый, топ только all-time). Побеждаем ровно здесь.
**Что сделать:** Страница `/leaderboards`: закреплённый фильтр-рейл (нік/SteamID search, селектор сервера «все + каждый», селектор периода: сегодня/неделя/месяц/сезон/всё время + стрелки навигации по прошлым периодам); таблица с подписанными, тултипнутыми и **кликабельно-сортируемыми** колонками (`#`, игрок, онлайн, kills, deaths, K/D, revives, сидинг), активная метрика подсвечена; server-side пагинация 30/страница с инфо-строкой «Страница N из M · Всего K» (`Intl.NumberFormat`); клик по строке → `/players/{id}` (Ctrl/Alt — не перехватывать, чтобы работало выделение текста); rank-медали топ-3. Combat-колонки до готовности STATS-3 скрыты (`available:false` из LEAD-2), без пустых столбцов. Dark mode, i18n EN/RU, мобильная вёрстка (горизонтальный скролл таблицы в контейнере). Гейт: `panel_access`.
**Критерии приёмки:** переключение периода/сервера/метрики обновляет таблицу без перезагрузки страницы; сортировка по любому столбцу работает с сервера (не client-side по странице); скриншот-тест dark/light; state фильтров сохраняется в query-string (шэрабельная ссылка).
**Зависимости:** LEAD-2, PLAYER-4, UX-2.

### LEAD-4. Топ по бонусам и бусту (экономика) [P2]
**Контекст (SQSTAT):** Топ конкурента ранжирует также по `bonuses` и `boost` (глава 20, §2.1) — это монетизационная/экономическая механика (бонусы копятся за онлайн с множителем буста). Переносим как отдельную метрику, помечено как монетизация.
**Что сделать:** В `player_stat_periods` (LEAD-1) добавить `bonus_points numeric` и `boost_seconds` (уже считается PRES-4 как режим сессии); worker начисляет бонусы по формуле из PRES-4 (`online + 2×boost`, коэффициенты — настройка панели, Owner, audit_log). В LEAD-2 метрики `bonus|boost`; в LEAD-3 колонки «Бонусы» и «Буст» (иконки + подписи), видимость управляется настройкой `economy_enabled`. Списание/трата бонусов — вне скоупа (отдельная экономическая фича, если появится).
**Критерии приёмки:** изменение коэффициентов формулы влияет только на будущие начисления (закрытые периоды не пересчитываются) и пишется в audit_log; при `economy_enabled=false` колонки и метрики не отдаются API и не рендерятся.
**Зависимости:** LEAD-1, LEAD-2, LEAD-3, PRES-4.

### LEAD-5. Серверный стат-дашборд `/statistics` (расширение AN-1) [P2]
**Контекст (SQSTAT):** Страница `statistics` (глава 11) — 20 графиков Chart.js: avg/peak online по дням, онлайн по часам суток и дням недели, очередь, матчи, режимы (doughnut), карты (без Seed/Skirmish), чат, тимкиллы, новые игроки, выданные наказания, admins online, KPI-полоса Среднее/Максимум/Всего. Гэпы конкурента: нет экспорта, нет drill-down, один RPC на 1.5 с, утечка profiling-таймингов.
**Что сделать:** Реализовать серверный срез AN-1 как страницу `/statistics`: контролы — date-range с пресетами (сегодня/вчера/неделя/месяц/30 дней/произвольный) и мультиселект серверов (все по умолчанию, запрос — по закрытию дропдауна, debounce); блоки графиков: (1) население — avg online/day, peak online (+queue)/day, avg queue/day, онлайн по часам суток, онлайн по дням недели — источник `player_daily_presence` + PRES-1 (per-server, stacked, фиксированный цвет сервера во всех графиках); (2) матчи — матчей/день, doughnut по режимам, топ карт (Seed/Skirmish исключать из «боевых», показывать отдельно) — источник events `round.*`/`map.*` (EVT-1); (3) сообщество — новых игроков/день (первый `player.connected`), сообщений чата/день, тимкиллы/день — events; (4) модерация — наказаний/день (bans+kicks+warns из audit_log/MOD-2), avg/peak админов онлайн (presence игроков с ролью, имеющей squad-permissions). Каждый time-series — KPI-подзаголовок «Среднее / Максимум / Всего». API: `GET /api/v1/statistics?start&end&servers=…` — данные из отдельных материализованных daily-агрегатов `server_daily_stats` (worker LEAD-1 расширяется), не live-скан events; ответ строго типизирован числами (у SQSTAT строки/числа вперемешку), без профилировочных полей. Drill-down: клик по бару → предфильтрованная страница событий (EVT-2)/чата/банов. Export CSV/JSON всего среза (закрывает гэп конкурента). Гейт: `panel_access`. Dark mode, i18n, WebSocket не требуется (по кнопке/фильтрам).
**Критерии приёмки:** ответ API за 30 дней × 6 серверов < 500 мс; сумма stacked-баров равна total в KPI; смена диапазона/серверов перерисовывает все графики атомарно с единым loading-состоянием; экспорт открывается в таблицах; drill-down ведёт на список с теми же фильтрами дат/сервера.
**Зависимости:** LEAD-1, AN-1, PRES-2, EVT-1, MOD-2, ROLE-1.

### LEAD-6. Сидинг: детекция, учёт и топ сидеров [P2]
**Контекст (SQSTAT):** Конкурент считает Seed-матчи отдельной категорией (глава 11: `modes.Seed`, карты Seed исключены из «настоящих» матчей), но не награждает сидеров и не ведёт их топ — очевидная точка дифференциации для комьюнити-серверов.
**Что сделать:** Правило сидинга: сессия (или её часть) идёт в `seeding_seconds`, если активный layer — Seed-режим (из events `map.changed`/`round.started`, EVT-1) ИЛИ онлайн сервера ниже порога `seeding_threshold` (настройка per-server, default 40, Owner/`can_edit_roles` не требуется — гейт настройки `panel_access` + audit_log). Разрез сессии по интервалам смены условия. Запись в `player_stat_periods.seeding_seconds` (LEAD-1). UI: метрика «Сидинг» в `/leaderboards` (LEAD-3), карточка «Сидинг: XXч» на странице игрока (PLAYER-4), график «seeding hours/day» в LEAD-5. Опционально экономика: множитель бонусов за сидинг-время (коэффициент в настройках LEAD-4).
**Критерии приёмки:** сессия, начавшаяся на Seed-layer и продолжившаяся на боевом, делится корректно (unit-тест на границе события смены карты); изменение порога не пересчитывает закрытые периоды; топ сидеров за неделю совпадает с ручным подсчётом на фикстуре событий.
**Зависимости:** LEAD-1, PRES-1, EVT-1.

### LEAD-7. Сезоны лидербордов [P2/P3]
**Контекст (SQSTAT):** У конкурента топ только all-time (глава 20, §7 — «missing time window is the key competitive gap»). Сезонные срезы — стандарт игровых рейтингов и прямое превосходство над SQSTAT.
**Что сделать:** **[P2]** Таблица `seasons`: `id uuid`, `name`, `starts_at`, `ends_at`, `status` (`upcoming|active|closed`); CRUD `POST/PATCH /api/v1/seasons` (гейт: Owner или роль с `can_edit_roles`; audit_log); не более одного active; worker LEAD-1 агрегирует `period_type='season'` по границам активного сезона. **[P3]** Финализация: по `ends_at` scheduler (AUTO-2) замораживает срез (флаг `finalized`, дальнейший пересчёт запрещён), архив прошлых сезонов в селекторе периода LEAD-3, страница итогов сезона (топ-3 по каждой метрике), опциональный AdminBroadcast о старте/финале сезона через AUTO-3.
**Критерии приёмки:** события вне окна сезона не попадают в сезонный срез; после финализации повторный пересчёт не меняет строки (тест); селектор в UI показывает закрытые сезоны read-only; создание/правка сезона видна в audit_log с before/after.
**Зависимости:** LEAD-1, LEAD-3, AUTO-2, AUTO-3.


---

# WS-18. Хранилище чата, история и шаблоны сообщений (из анализа SQSTAT)

### CHATLOG-1. Таблица chat_messages и запись из log-ingest [P1]
**Контекст (SQSTAT):** SQSTAT персистит весь внутриигровой чат (все скоупы + броадкасты) в MySQL и строит на нём отдельную страницу-архив с поиском и фильтрами (rival-analysis/sections/02-chat.md, §2.1–2.4). У нас CHAT-1 даёт только live-стрим без хранения — история теряется при закрытии страницы.
**Что сделать:** Таблица `chat_messages`: `id bigserial`, `player_id uuid NOT NULL FK → players.id`, `server_id uuid NOT NULL`, `sent_at timestamptz NOT NULL`, `scope` enum (`all|team|squad|admin|broadcast|direct`), `team_id smallint NULL`, `squad_id int NULL`, `message text NOT NULL`, `source` enum (`log|panel`), `is_flagged boolean NOT NULL DEFAULT false`. Партиционирование по месяцам через pg_partman, retention 12 месяцев (настройка организации), покрытие restic-бэкапом как у остальных партиционированных таблиц. Индексы: `(player_id, sent_at desc)`, `(server_id, sent_at desc)`, GIN pg_trgm по `message`, BRIN по `sent_at`. Worker log-ingest: расширить парсер EVT-1 событиями чата из SquadGame.log (все скоупы), резолвить автора в `player_id` по EOS/SteamID через механику PLAYER-1 (EOS-only игроки обязаны сохранять историю), писать строку в `chat_messages` и параллельно пушить в WebSocket-стрим CHAT-1 (единый пайплайн, без второго парсера). Броадкасты и адресные сообщения, отправленные из панели (MSG-2/MSG-3), также писать сюда с `source='panel'` и `player_id` = автор-админ — архив един для входящих и исходящих.
**Критерии приёмки:** сообщение в игре появляется в таблице ≤5 с; EOS-only игрок корректно связан по `player_id`; broadcast из панели виден в архиве со `scope='broadcast'` и `source='panel'`; партиция создаётся автоматически, retention удаляет партиции старше срока; вставка 1M строк не деградирует live-стрим CHAT-1.
**Зависимости:** EVT-1, PLAYER-1, INFRA-5, CHAT-1.

### CHATLOG-2. API архива чата: поиск, фильтры, пагинация [P1]
**Контекст (SQSTAT):** страница `chat` конкурента — searchable-архив с фильтрами по нику/SteamID, подстроке сообщения, серверам (multiselect), скоупам, диапазону дат и серверной пагинацией по 300 строк (02-chat.md, §2.2–2.3). Ограничение конкурента — поиск по тексту не длиннее 17 символов; его надо превзойти.
**Что сделать:** `GET /api/v1/chat/messages` — фильтры: `serverId[]`, `scope[]`, `playerQuery` (подстрока ника из nickname-истории PLAYER-2, точный SteamID64 или EOS ID → резолв в `player_id`), `text` (подстрока без искусственного лимита длины, через pg_trgm), `from`/`to` (timestamptz), `flaggedOnly` (bool, см. CHATLOG-5), `source`. Keyset-пагинация по `(sent_at, id)` (не offset), `limit ≤ 300`; отдельный `GET /api/v1/chat/messages/count` с теми же фильтрами. В ответе — денормализованные `player.nickname`, `player.id`, `scope`, `serverId`. RBAC-гейт: `panel_access` (архив чата — базовая админ-поверхность, отдельный флаг не нужен). Чтение в audit не пишется (read-only).
**Критерии приёмки:** выборка за месяц по одному серверу при 1M строк <1 с; комбинация всех фильтров работает; keyset-пагинация не теряет и не дублирует строки при живой вставке; запрос без `panel_access` → 403.
**Зависимости:** CHATLOG-1, PLAYER-2.

### CHATLOG-3. UI: глобальный архив чата `/chat` [P1]
**Контекст (SQSTAT):** отдельный пункт навигации `chat`: фиксированный сайдбар фильтров слева + широкая таблица, цветные бейджи скоупов с иконками, клик по строке открывает карточку игрока (02-chat.md, §3, §7). Броадкасты админов интерливятся с чатом игроков — подотчётность.
**Что сделать:** Страница `/chat` (nav-пункт «Чат»): панель фильтров (игрок, текст, серверы-multiselect, скоупы-multiselect, date range, toggle «только флагнутые»), таблица: время, сервер, флаг команды, ник (клик → `/players/{id}`), бейдж скоупа (цвет+иконка на скоуп: all/team/squad/admin/broadcast/direct — одинаковая палитра с live-viewer CHAT-1), текст (`word-break`). Тумблер «Live» дозаписывает новые сообщения сверху через WebSocket CHAT-1 при пустых date-фильтрах. Виртуализация списка для длинных страниц, кнопка «ещё» (keyset). Дарк-тема, i18n EN/RU, мобильная вёрстка (сайдбар складывается в drawer). Гейт: `panel_access`.
**Критерии приёмки:** фильтры и «Live» работают одновременно без дублей; клик по строке ведёт на карточку автора, включая EOS-only; страница юзабельна на 375px-ширине; все строки локализованы EN/RU.
**Зависимости:** CHATLOG-2, CHAT-1, PLAYER-4.

### CHATLOG-4. История чата на карточке игрока [P1]
**Контекст (SQSTAT):** карточка игрока конкурента показывает его сообщения; клик по любой строке архива открывает модал игрока (02-chat.md, §3 «Row interaction»). Пер-игроковая история — ключевой инструмент разбора репортов.
**Что сделать:** Tab «Чат» на `/players/{id}`: тот же табличный компонент, что CHATLOG-3, но с зашитым `player_id` (кросс-серверная история, фильтры по серверу/скоупу/дате/тексту сохраняются). Счётчик сообщений за 30 дней в заголовке таба. Deep-link из архива: «показать всё от игрока» → этот таб. API — существующий `GET /api/v1/chat/messages?playerId=` (расширить CHATLOG-2 параметром `playerId`). Гейт: `panel_access`.
**Критерии приёмки:** история EOS-only игрока полна; фильтры работают внутри таба; переход из архива сохраняет контекст игрока; выборка по игроку с 50k сообщений <1 с (индекс `(player_id, sent_at desc)`).
**Зависимости:** CHATLOG-2, PLAYER-4.

### CHATLOG-5. Серверный профанити-детект и флаги сообщений [P2]
**Контекст (SQSTAT):** конкурент флагает мат одним захардкоженным клиентским RU-регэкспом и даёт фильтр «Только Мат» (02-chat.md, §7). Сам rival-анализ отмечает: это стоит превзойти конфигурируемым серверным многоязычным решением.
**Что сделать:** Настраиваемые word-list'ы в настройках организации (таблица `chat_flag_rules`: `id`, `pattern` (word|regex), `locale`, `enabled`, `created_by uuid FK → players.id`); дефолтный seed RU+EN. Worker log-ingest на вставке прогоняет сообщение по активным правилам → `is_flagged=true` + `matched_rule_id`. Кнопка «переиндексировать N дней» (фоновый job) после изменения правил. UI: в CHATLOG-3/CHATLOG-4 флагнутые строки помечаются иконкой-предупреждением, фильтр `flaggedOnly` уже предусмотрен в API. Редактирование правил — гейт `can_edit_roles` (управление политиками организации, новый флаг не вводим); каждое изменение правил → audit_log. Флаги — вход для триггеров AUTO-1 (condition «flagged message»).
**Критерии приёмки:** новое правило флагает последующие сообщения без рестарта воркера; переиндексация идемпотентна; regex-правило с катастрофическим backtracking отклоняется валидацией; изменение правил видно в audit с before/after.
**Зависимости:** CHATLOG-1, INFRA-6, ROLE-1.

### MSG-1. Шаблоны сообщений (canned messages) [P1]
**Контекст (SQSTAT):** композеры конкурента содержат 17–18 преднабранных модераторских фраз с подстановкой `{player}` — рутинное принуждение к правилам за два клика (02-chat.md, §5.1–5.2, §7). У нас шаблонов нет нигде.
**Что сделать:** Таблица `message_templates`: `id uuid`, `title`, `body text` (≤512 — лимит RCON-сообщения), `category` (`warn|info|vip|other`), `locale` (`en|ru`), `sort_order`, `is_enabled`, `created_by uuid FK → players.id`, timestamps. Поддерживаемые токены: `{player}` (ник адресата/сквадлидера), `{server}` (имя сервера) — подстановка на клиенте перед отправкой, предпросмотр в композере. CRUD `GET/POST/PATCH/DELETE /api/v1/message-templates`; чтение — `panel_access`, мутации — гейт `can_edit_roles`; мутации в audit_log. Seed ~15 дефолтных фраз EN+RU (правила клейма техники, предупреждение о нечитаемом нике, извинение за TK и т.п.). UI: страница `/settings/message-templates` (список с drag-sort, inline-редактор, toggle enabled) + компонент «выбор шаблона» (переиспользуется в MSG-2, MSG-3, MSG-4): клик по шаблону заполняет textarea с подстановкой токенов.
**Критерии приёмки:** шаблон с `{player}` подставляет ник в предпросмотре и в отправленном тексте; тело >512 символов отклоняется на API; отключённый шаблон не виден в пикере; CRUD без `can_edit_roles` → 403; создание/правка/удаление — в audit.
**Зависимости:** INFRA-5, INFRA-6, ROLE-1.

### MSG-2. Прямое сообщение игроку с карточки и live-листа [P1]
**Контекст (SQSTAT):** action `message` — адресное in-game сообщение одному игроку с шаблонами, повтором по кадансу (1×/30/40/60/90/120 с) и чекбоксом «записать в карточку» (02-chat.md, §2.5, §5.1). Связывает live-модерацию с audit-трейлом.
**Что сделать:** `POST /api/v1/servers/{serverId}/players/{playerId}/message` — body: `message` (≤512), `repeat` (`once|30|60|90|120` секунд между повторами, длительность серии ≤10 мин), `logToCard` (bool). Доставка: worker-rcon → `AdminWarn "<eos/steam id>" <msg>` (адресный экранный месседж Squad); повторы планирует worker-rcon, серия отменяется при disconnect игрока (по PRES-открытой сессии/RCON poll). Гейт: squad-permission `chat` в роли отправителя (тот же гейт, что даёт AdminWarn/AdminBroadcast в игре). Каждая отправка → audit_log; при `logToCard=true` — дополнительно запись в `chat_messages` (`scope='direct'`, `source='panel'`, `player_id`=автор) с привязкой адресата, видимая в CHATLOG-4 и в moderation-хронологии MOD-2. UI: кнопка «Сообщение» на карточке игрока (PLAYER-4) и в live-листе (MOD-1): модал с пикером шаблонов MSG-1, счётчиком символов, селектом повтора (default «1 раз»), чекбоксом «записать в карточку».
**Критерии приёмки:** сообщение появляется у игрока в игре; повтор 30 с шлёт серию и останавливается при disconnect; без permission `chat` кнопка скрыта и API → 403; `logToCard` создаёт запись, видимую на карточке; каждая отправка в audit с текстом и адресатом.
**Зависимости:** RCON-1, MOD-1, PLAYER-4, MSG-1, CHATLOG-1.

### MSG-3. Broadcast с страницы сервера и сообщение скваду [P1]
**Контекст (SQSTAT):** на дашборде конкурента — инлайн-инпут Broadcast с confirm-гейтом и envelope-кнопка «сообщение скваду» у каждой панели сквада с повтором и шаблонами (02-chat.md, §2.5, §5.2–5.3; 01-dashboard.md). У нас broadcast есть только как шаг graceful-stop (SRV-3) и в планах AUTO-2 — ручного композера нет.
**Что сделать:** (1) Broadcast: инлайн-композер на странице сервера рядом с live-листом MOD-1 (input + пикер шаблонов MSG-1, min 2 символа, confirm-диалог «Отправить как Broadcast?») → `POST /api/v1/servers/{serverId}/broadcast` → worker-rcon `AdminBroadcast <msg>`; echo в `chat_messages` (`scope='broadcast'`, `source='panel'`) — броадкаст виден в архиве среди сообщений игроков. (2) Сообщение скваду: у squad-группы в live-листе (сгруппированном по team/squad из `ListSquads`) кнопка-конверт → модал (шаблоны с `{player}`=ник сквадлидера, повтор как в MSG-2) → `POST /api/v1/servers/{serverId}/squads/{squadId}/message`; доставка — итерация по текущим членам сквада из последнего RCON poll, `AdminWarn` каждому (в Squad нет squad-scoped RCON-команды); состав пересчитывается перед каждым повтором. Гейт обоих: squad-permission `chat`. Обе операции → audit_log (для сквада — список фактических адресатов).
**Критерии приёмки:** broadcast виден всем в игре и появляется в архиве CHATLOG-3 интерливом с чатом; сообщение скваду получают все текущие члены и не получают вышедшие из сквада между повторами; confirm обязателен для broadcast; без `chat` → 403 и скрытые кнопки; audit содержит текст и адресатов.
**Зависимости:** RCON-1, MOD-1, MSG-1, CHATLOG-1.

### MSG-4. Запланированные и повторяющиеся broadcast через scheduler [P2]
**Контекст (SQSTAT):** конкурент закрывает регулярные объявления повтором «до 120 с»; полноценные запланированные броадкасты (правила сервера каждые N минут, анонс события в заданное время) — естественное превосходство поверх нашего AUTO-2, где broadcast уже заявлен как тип задачи.
**Что сделать:** Расширение AUTO-2, не параллельный механизм: тип scheduled-задачи `broadcast` получает пикер шаблонов MSG-1 (с подстановкой `{server}`), выбор серверов (один/несколько/все), режимы «однократно в дату-время» и «интервал/cron»; ротация нескольких шаблонов по кругу для одного правила (анти-спам: минимальный интервал 5 мин). Отправка — тот же путь, что MSG-3 (worker-rcon `AdminBroadcast` + echo в `chat_messages` c `source='panel'`). История выполнений и toggle enable/disable — из механики AUTO-2. Гейт: создание/правка правил — `can_edit_roles`; правила и каждое изменение — audit_log.
**Критерии приёмки:** правило «каждые 30 мин по кругу 3 шаблона» шлёт их поочерёдно и видно в архиве; разовая отправка на 3 сервера создаёт 3 записи истории; интервал <5 мин отклоняется; disable останавливает рассылку без удаления правила.
**Зависимости:** AUTO-2, MSG-1, MSG-3.


---

# WS-19. Досье игрока: оружие, техника, киты (из анализа SQSTAT)

### DOSSIER-1. Техника в combat-пайплайне: события и каталог локализации [P2]
**Контекст (SQSTAT):** профиль конкурента показывает две таблицы по технике: «Техника» (kills/урон из управляемой техники) и «Уничтожение техники» (сколько единиц каждого типа игрок уничтожил и каким оружием), причём во второй таблице утекают сырые asset-ID (`Tigr_RWS`, `T72B3`) — прямо названный polish-gap, который мы закрываем локализацией (см. `ai_docs/rival-analysis/sections/04-player-profile.md` §2.5–2.6, §7).
**Что сделать:** Расширить парсер worker log-ingest (COMBAT-1) vehicle-событиями из SquadGame.log: урон по технике и уничтожение техники (строки `ApplyDamage`/`Die`, где жертва — vehicle-актор, а не игрок; сигнатуры сверить с SquadJS log-parser и покрыть фикстурами с dev-сервера, включая deployable/environment-урон без атакующего). В `combat_events` (COMBAT-2) добавить: `event_type` значение `vehicle_destroyed`, колонки `victim_vehicle text NULL` (сырой asset-ID уничтоженной/повреждённой техники) и `attacker_vehicle text NULL` (asset-ID техники, из которой действовал атакующий, если он был в технике на момент события — определяется по последнему possess/enter-vehicle событию игрока из лога); `victim_player_id` для vehicle-событий становится NULLABLE (жертва — техника). Атакующий резолвится в `players.id uuid` тем же identity-механизмом, что и в COMBAT-1. Отдельная справочная таблица `vehicle_catalog` (`asset_id text PK`, `name_en text`, `name_ru text`, `vehicle_class text` — APC/IFV/MBT/Heli/Logi/…, `icon text NULL`): сид-миграция из открытых данных Squad-вики/SquadJS, незнакомый asset-ID не ломает пайплайн — событие пишется, каталог дополняется админом через простой CRUD `GET/PUT /api/v1/vehicle-catalog` (гейт `panel_access` + `can_edit_roles` не нужен — новый panel-флаг не требуется, достаточно `combat:view` на чтение и Owner/`panel_access`-роль с существующим правом конфигурирования на запись; мутации каталога пишутся в audit_log с before/after).
**Критерии приёмки:** уничтожение техники на dev-сервере → событие `vehicle_destroyed` в БД ≤5 с с корректными `attacker_player_id`, `weapon`, `victim_vehicle`; выстрел из турели техники по игроку → у `combat.death`/`combat.damage` заполнен `attacker_vehicle`; asset-ID, отсутствующий в каталоге, не теряет событие и виден в UI как сырой ID с пометкой «нет локализации»; правка каталога через API отражается в выдаче и в audit_log; фикстуры покрывают урон технике без атакующего.
**Зависимости:** COMBAT-1, COMBAT-2.

### DOSSIER-2. Агрегаты досье: пер-оружейная и пер-техника статистика [P2]
**Контекст (SQSTAT):** профиль конкурента рендерит карточки «Оружие» (kills + damage на каждое оружие, топ по убийствам) и таблицы техники (kills/урон из техники; уничтожено единиц по типам, с разбивкой по оружию) — всё из агрегатов по kill-логам (04 §2.4–2.6). У нас combat_events (COMBAT-2) даёт сырьё, но агрегатов на игрока нет.
**Что сделать:** Три инкрементальные агрегатные таблицы, ключ — `players.id uuid` (не steam_id64): `player_weapon_stats` (`player_id uuid`, `weapon text`, `kills int`, `teamkills int`, `damage numeric NULL`, `shots_events int` — число damage-событий, `last_used_at timestamptz`, PK `(player_id, weapon)`); `player_vehicle_stats` (`player_id`, `vehicle_asset_id`, `kills int`, `damage numeric NULL`, PK `(player_id, vehicle_asset_id)` — статистика ИЗ техники, источник `attacker_vehicle` из DOSSIER-1); `player_vehicle_kills` (`player_id`, `victim_vehicle_asset_id`, `weapon`, `destroyed_count int`, PK `(player_id, victim_vehicle_asset_id, weapon)` — уничтожение техники). `damage` NULLABLE везде: если источник (лог-строка) не содержит величину урона, агрегат копит только счётчики, UI показывает «—» (требование: «Урон» может отсутствовать в источнике). Обновление: worker log-ingest инкрементит агрегаты в той же транзакции, что и вставка combat_event (UPSERT); ночная reconcile-джоба пересчитывает агрегаты из combat_events за последние 48 ч и алертит при расхождении (защита от пропусков при рестартах). Retention агрегатов — бессрочный (в отличие от 24-мес retention сырых combat_events — агрегаты переживают drop партиций, это и есть «многолетняя история» конкурента).
**Критерии приёмки:** kill из АК-74 на dev-сервере → `player_weapon_stats` инкрементирован ≤10 с; уничтожение техники → `player_vehicle_kills` инкрементирован с верной парой (техника, оружие); reconcile после искусственного пропуска событий восстанавливает счётчики; дроп партиции combat_events старше 24 мес не меняет агрегаты; событие без величины урона не ломает UPSERT (damage остаётся NULL/прежним); EOS-only игрок агрегируется по uuid.
**Зависимости:** COMBAT-2, DOSSIER-1.

### DOSSIER-3. Время по китам/ролям: player_kit_time [P2]
**Контекст (SQSTAT):** таблица «Киты» на профиле — накопленное игровое время по каждой роли (Medic 258ч 36м, LAT 130ч 33м, …), т.е. хранится `player_kit_time[player, kit] = seconds` (04 §2.3). У нас STATS-4 показывает только счётчики использования китов из RNSquadJS (`Main.roles`), а времени по ролям нет нигде.
**Что сделать:** Источник — периодический опрос RCON `ListPlayers` через worker-rcon (RCON-1), который уже отдаёт текущую роль каждого онлайн-игрока: worker накапливает интервалы «игрок X в роли Y с t1 по t2» (смена роли или дисконнект закрывает интервал; интервалы длиннее 2× периода опроса усечь до периода — защита от пропущенных poll'ов) и инкрементит таблицу `player_kit_time` (`player_id uuid`, `kit text` — нормализованное имя роли без факционного префикса, `server_id uuid`, `seconds bigint`, `last_played_at timestamptz`, PK `(player_id, kit, server_id)`). Нормализация имён ролей (например `_SL_`, `_Medic_`, `_Rifleman_` из полного role-string) — общий маппинг-модуль с фикстурами на актуальные role-строки Squad. Явно НЕ дублировать STATS-4: RNSquadJS-киты (counts) остаются как есть; `player_kit_time` — независимый time-based источник из RCON, и именно он кормит вкладку «Киты» досье (DOSSIER-6), а STATS-4-блок сворачивается в неё (см. amendment).
**Критерии приёмки:** игрок в роли Medic 10 минут на dev-сервере → `player_kit_time` ≥ 9 и ≤ 11 минут; смена роли посреди сессии делит время между двумя китами; рестарт worker-rcon не даёт ни двойного счёта, ни «бесконечного» интервала; role-string каждой фракции из фикстур нормализуется в единое имя кита; суммарное kit-время игрока за сессию не превышает длительность сессии из player_sessions (PRES-2, sanity-тест).
**Зависимости:** RCON-1, PLAYER-1, PRES-2.

### DOSSIER-4. Тренд K/D по месяцам и винрейт [P2]
**Контекст (SQSTAT):** блок «Скилл» конкурента показывает K/D-донат `[kills, deaths]`, stacked-bar убийств/смертей по месяцам с K/D в tooltip'е (`player_kd_year`) и винрейт с раздельными матчи/победы/поражения, где wins+losses < matches — ничьи учитываются отдельно (04 §1a, §2.2). У нас нет ни месячного тренда, ни винрейта на игрока.
**Что сделать:** Таблица `player_monthly_combat` (`player_id uuid`, `month date` — первое число месяца, `kills int`, `deaths int`, `teamkills int`, `revives int`, `damage_dealt numeric NULL`, PK `(player_id, month)`), инкрементально обновляемая worker log-ingest вместе с DOSSIER-2 (UPSERT по месяцу `occurred_at`); тот же принцип NULLABLE damage. Винрейт — НЕ отдельная таблица: считается запросом по `match_players` (MATCH-2): `matches = count(*)`, `wins`, `losses`, `draws = matches - wins - losses` (матчи без исхода/ничьи не искажают винрейт — как у конкурента), `winrate = wins / NULLIF(wins + losses, 0)`; для карточки — материализованное представление `player_match_summary` с refresh каждые 15 мин. K/D lifetime = сумма по `player_monthly_combat` (или по DOSSIER-2), K/D-тренд = помесячные строки за запрошенное окно.
**Критерии приёмки:** события двух разных месяцев ложатся в две строки `player_monthly_combat`; сумма помесячных kills совпадает с ручным `count(*)` по combat_events; винрейт игрока с 5 победами, 3 поражениями и 2 ничьими = 62.5%, matches = 10; refresh MV укладывается в 15-минутное окно на 100k match_players-строк; месяц без событий отсутствует в ответе (UI дорисовывает нули сам).
**Зависимости:** COMBAT-2, MATCH-2, DOSSIER-2.

### DOSSIER-5. API консолидированного досье [P2]
**Контекст (SQSTAT):** профиль конкурента — SSR-страница без единого JSON-endpoint'а (0 XHR, данные запечены в HTML и inline-массивы Chart.js) — нечего переиспользовать ни мобильному клиенту, ни виджетам (04 §1a, §8). Мы отдаём то же содержимое одним чистым API.
**Что сделать:** `GET /api/v1/players/{id}/dossier?from=&to=&serverId=<uuid|all>` — один ответ с секциями: `skill` (kills, deaths, kd, teamkills, revives, damage_dealt|null, matches, wins, losses, draws, winrate — из DOSSIER-4), `kd_trend` (помесячный массив `{month, kills, deaths}`), `weapons[]` (топ-N + `total_count`, сортировка по kills, damage|null — из player_weapon_stats), `vehicles[]` и `vehicle_kills[]` (из player_vehicle_stats/player_vehicle_kills, каждая позиция обогащена `name_en`/`name_ru`/`vehicle_class` из vehicle_catalog; при отсутствии в каталоге — `asset_id` + флаг `unlocalized:true`), `kits[]` (`{kit, seconds, last_played_at}` из player_kit_time). Параметры `from`/`to` применяются к `kd_trend` (помесячные строки) и прокидываются в winrate-запрос; lifetime-агрегаты (weapons/vehicles/kits) отдаются целиком с пометкой `period:"all"` — честно задокументировать в OpenAPI, что они не фильтруются по датам (агрегаты не датированы; полная date-фильтрация потребовала бы скана combat_events и в scope не входит). RBAC-гейт: `combat:view` (тот же panel-флаг, что COMBAT-3 — досье производно от боевых логов); read-only, audit_log не пишется. Ответ кэшируется в Redis TTL 60 с по ключу `(player_id, params)`.
**Критерии приёмки:** OpenAPI-схема в `/api/docs`; ответ для игрока с данными во всех секциях валиден и собирается <500 мс на dev-объёме; игрок без combat-истории → секции с нулями/пустыми массивами, HTTP 200 (не 404); поле damage = null сериализуется как null, а не 0; без `combat:view` → 403; `serverId=all` суммирует по серверам, конкретный uuid — фильтрует (kits/vehicles), несуществующий player id → 404.
**Зависимости:** DOSSIER-2, DOSSIER-3, DOSSIER-4, ROLE-1.

### DOSSIER-6. UI-вкладки досье на карточке игрока: Скилл / Оружие / Техника / Киты [P2/P3]
**Контекст (SQSTAT):** сила конкурента — вся статистика игрока на одном экране: скилл-грид, K/D-донат, тренд по месяцам, карточки оружия, две таблицы техники, киты (04 §7). Мы переносим это на карточку игрока PLAYER-4 вкладками, исправляя их баги: локализуем технику и честно обрабатываем отсутствующий урон.
**Что сделать (P2):** На карточке игрока `/players/{id}` — блок «Досье» с вкладками (lazy-load каждой при первом открытии, данные из DOSSIER-5): **Скилл** — грид KPI (K/D, винрейт, матчи/победы/поражения/ничьи, убийства, смерти, поднятия, тимкиллы, урон), donut kills/deaths и stacked-bar тренд по месяцам с K/D в tooltip (селектор периода: 3/6/12 мес/всё время); сюда же встраиваются RNSquadJS-блоки STATS-4 как под-секция «RNSquadJS» с явной пометкой источника — два источника не смешиваются в одних цифрах (см. amendment к STATS-4). **Оружие** — карточки/таблица топ-оружия: kills, teamkills, урон; сортировка по kills и по урону. **Техника** — две под-таблицы: «На технике» (kills/урон из техники) и «Уничтожено» (тип техники + оружие + количество), везде локализованные имена из vehicle_catalog (RU/EN по текущей локали), сырой asset-ID — только в tooltip и при `unlocalized:true`. **Киты** — таблица роль → время (`Nч Nм`) → последний раз, сортировка по времени. Сквозное правило «Урон недоступен»: если damage = null, ячейка показывает «—» с tooltip «Источник не содержит данных об уроне», а сортировка по урону скрывается — никаких нулей, вводящих в заблуждение. Селектор сервера (все/конкретный) для kits/vehicles. Dark mode, i18n EN/RU, mobile: вкладки — горизонтальный скролл-чипы, таблицы — карточный режим. **(P3):** deep-link на вкладку (`/players/{id}?tab=weapons`), drill-down из строки оружия/техники в боевой лог COMBAT-4 с префильтром (игрок + оружие), экспорт досье в CSV.
**Критерии приёмки:** браузерная проверка на dev-данных: каждая вкладка рендерит корректные значения, совпадающие с API; игрок без истории — empty-state с пояснением, не пустая таблица; damage = null отображается «—», сортировка по урону недоступна; уничтоженная техника показана локализованным именем, незнакомый asset — сырым ID с пометкой; RNSquadJS-подсекция явно помечена источником и не суммируется с combat-цифрами; все строки через i18n-слой; на мобильной ширине элементы не перекрываются; переключение вкладок не перезапрашивает уже загруженные данные.
**Зависимости:** DOSSIER-5, PLAYER-4, COMBAT-4.


---

# Правки существующих задач (интеграция новой функциональности)

Уточнения scope существующих задач для интеграции новых возможностей (собрано при декомпозиции; это НЕ отдельные задачи, а заметки для груминга существующих):

- PLAYER-6: фраза «Player notes от админов (CRUD + audit)» остаётся, но реализация должна использовать модель PNOTE-1 (таблица player_notes, body ≤2000, edit/soft-delete, автор из сессии) вместо отдельной ad-hoc схемы; добавить в «Зависимости» PLAYER-6 ссылку на PNOTE-1, а критерий «notes видны всем с panel_access, авторство фиксируется» оставить без изменений — он покрывается PNOTE-1.
- PLAYER-6: фильтр «активные баны» в списке игроков полезно дополнить badge активных меток из MARK-2 (см. MARK-2, пункт 4) — правка UI-скоупа, не новой задачи.
- EVT-1: дополнить перечень событий пометкой, что combat-подтипы (combat.death/damage/wound/revive) добавляются отдельной задачей COMBAT-1 тем же pipeline (envelope + типизированная таблица), чтобы исполнитель EVT-1 заложил расширяемость enum'а типов событий.
- EVT-2: указать, что боевые события в общем event log показываются свёрнуто/ссылкой на /combat-log (COMBAT-4), чтобы не дублировать полноценный combat-UI внутри generic-лога событий.
- STATS-4: добавить cross-link: агрегаты RNSquadJS (K/D, winrate из Mongo) и сырые combat_events (COMBAT-2, из парсинга SquadGame.log) — разные источники; на карточке игрока блок «Скилл» (STATS) и виджет «Тимкиллы»/ссылка на боевой лог (COMBAT-5) не должны смешиваться; дублирования нет — STATS не хранит пер-событийных строк.
- AN-1: расширить источники дашборда combat_events (популярность оружия, TK-rate по серверам) после реализации COMBAT-2 — сейчас указаны только events + presence.
- MOD-2: упомянуть страницу /moderation/teamkills (COMBAT-5) как дополнительную точку входа в moderation actions.
- GAME-2 (team balancer): заменить эвристику «уважать clan tags» на использование реальных данных ростера/тегов из clans/clan_members (CLAN-1) — добавить зависимость от CLAN-1.
- PLAYER-4 (карточка игрока): добавить виджет клана (имя-ссылка + роль в клане) — реализуется в CLAN-9, но в PLAYER-4 стоит упомянуть слот под виджет.
- PLAYER-6 (поиск): расширить ответ поиска полем clan_id кандидата, чтобы UI добавления в клан (CLAN-3) блокировал игроков, уже состоящих в клане.
- WL-1 / SYNC-2 (whitelist/генерация managed-сегмента): в генераторе появится второй источник reserve — clan_priority (CLAN-4); в UI whitelist показывать источник (роль vs клан) и блокировать индивидуальное редактирование клан-строк (аналог vip_mode==2 у SQSTAT).
- PRES-5 (праймтайм): алгоритм переиспользуется на агрегате клана в CLAN-6 — вынести расчёт primetime в переиспользуемую функцию/модуль, а не приватную логику карточки игрока.
- AN-2 (public portal): публичные страницы кланов (CLAN-10) должны жить в этом же read-only слое — учесть при проектировании роутинга и rate limiting.
- ROLE-1/ROLE-3 (модель ролей и редактор): добавить новый panel-флаг can_manage_clans (вводится в CLAN-2) в список panel-флагов и в UI редактора ролей.
- PLAYER-4: убрать формулировку «в P0 гейт = panel_access, отдельный флаг — backlog» и сослаться на ALT-8, который вводит панельный флаг can_view_ips (permission player:view_ips) и переводит на него IP/локацию карточки.
- ROLE-1: в модели роли зафиксировать четвёртый панельный флаг can_view_ips (валидация: требует panel_access=true; Owner hardcoded true) — вводится миграцией ALT-8.
- ROLE-3: добавить чекбокс can_view_ips в inline-редактор ролей (реализация — в ALT-8, но упоминание в задаче редактора нужно, чтобы не потерялось при груминге).
- MOD-2: в UI бана добавить ссылку на pre-ban alt-warning (ALT-7) — confirm-диалог бана должен уметь встраивать блок предупреждения о связанных аккаунтах и опцию «Забанить также».
- INT-1: расширить scope Steam Web API методом GetFriendList с rate-limit-очередью и кэшем — потребитель ALT-5 (проверка Steam-друзей между двумя аккаунтами).
- INT-3 (External ban sources + cheater detection, P4): раскрыт и конкретизирован задачами CBAN-1..CBAN-5 с повышением приоритета до P1/P2 — в INT-3 оставить только cheater-detection-часть (или пометить ban-sources-часть как superseded by CBAN-*) и добавить перекрёстную ссылку на WS-18.
- ROLE-1/ROLE-3: в модель ролей и редактор добавляется НОВЫЙ panel-флаг can_manage_ban_sources (вводится задачей CBAN-1) — учесть в списке флагов редактора ролей.
- PLAYER-4: карточка игрока получает два новых блока — бейдж «Ник забанен» (BANNAME-3) и блок «Внешние банлисты / найден в N внешних банлистах» (CBAN-3); дублировать эти секции в PLAYER-4 не нужно, только упомянуть как расширения.
- MOD-2: словарь type в moderation_actions расширяется значениями name_kick (BANNAME-2) и external_ban_kick (CBAN-4) с системным автором (author_player_id NULL).
- AUTO-4 (In-game chat commands): пункт `!report` не должен вести собственную «историю» — команда обязана создавать запись в player_reports через пайплайн REPORT-1; добавить зависимость REPORT-1 и убрать дублирующее хранение.
- MOD-2 (Moderation actions): таблица moderation_actions получает nullable-колонку report_id (FK player_reports.id) — вводится задачей REPORT-3; при груминге MOD-2 учесть будущую колонку, самому MOD-2 менять ничего не нужно.
- GAME-1 (Map voting): раздел «история» голосований покрывается VOTE-1/VOTE-2 (захват встроенных голосований из SquadGame.log + UI); GAME-1 сузить до автоголосования/конфигурации кандидатов и сослаться на VOTE-1 как источник истории, чтобы не дублировать парсер и таблицы.
- MOD-3 (Evidence): хранилище evidence переиспользуется задачей REPORT-4 через связку report_evidence — при реализации MOD-3 сделать сущность evidence независимой от moderation_actions (отдельная таблица evidence + link-таблицы), иначе REPORT-4 потребует рефакторинга.
- AN-1: источник для 'match outcomes' и 'popular maps' переключить с сырых events на таблицу matches (MATCH-1) — дешевле и даёт фракции/тикеты/is_seed; добавить зависимость MATCH-1 и исключение seeding-раундов из 'popular maps' (паттерн SQSTAT §11 chartMaps).
- EVT-1: расширить список парсимых событий combat-типами player.wounded/player.died/player.revived/player.teamkilled — требуется для MATCH-3 (можно оставить как P2-подпункт внутри EVT-1 или сослаться на MATCH-3).
- EVT-2: на строках событий, попадающих в интервал матча, добавить ссылку на карточку матча /matches/{id} (после MATCH-1).
- PLAYER-4: в перечень секций карточки игрока добавить секцию 'Последние матчи' (реализация — MATCH-7, дублировать не нужно, только упомянуть в составе карточки).
- AUTO-3 (Alerts): добавить Discord как канал доставки алертов через worker discord-notify (DISCORD-2) вместо собственной реализации; зависимость AUTO-3 дополнить DISCORD-2 (опционально).
- INT-3 (External ban sources / CBAN-*): кросс-серверная рассылка банов/подозрительных игроков (collab_ban/collab_warn у SQSTAT) должна переиспользовать транспорт DISCORD-2 (event_type ban_issued + отдельные webhooks), а не отдельный отправщик.
- AUTO-4 (!report): маршрутизация репортов из чата в Discord-канал реализуется через event_type player_report в DISCORD-2 — при реализации AUTO-4 не дублировать отправку.
- STATS-3/AN-1: gamification-движок SQSTAT (авто-роли за top-kills/medic/SL/playtime-тиры) отмечен как будущее расширение маппингов DISCORD-5 после появления leaderboard-данных — при груминге STATS-* добавить отдельную задачу на leaderboard-роли.
- MOD-3 (Evidence): частично покрывает видео-ссылки и локальное хранение файлов; переформулировать так, чтобы MOD-3 использовал медиа-хранилище VIDEO-1 и таблицу media_links из VIDEO-2 вместо собственного поля evidence[] и собственного volume — убрать дублирование механики хранения, оставить за MOD-3 только UX прикрепления в flow модерации
- MOD-2 (Moderation actions): колонку evidence[] в moderation_actions заменить на связи через media_links (VIDEO-2), чтобы evidence были полноценными медиа-записями с audit и uploader'ом
- MOD-5 (Appeals portal): добавить возможность прикладывать медиа-доказательства к апелляции через механику одноразовых токенов VIDEO-3 (public upload без сессии панели уже реализован там)
- PRES-1: расширить enum mode в player_sessions значением 'seed' (сейчас online|boost|queue) — требуется для SEED-2.
- PRES-2: добавить колонку seed_seconds в player_daily_presence и учесть её в часовом/полуночном пересчёте агрегатора (SEED-2).
- PRES-4: формула «Бонусы» default 'online + 2×boost' расширяется слагаемым k_seed×seed (default 3, настройка организации); в календаре сессий добавить цвет для mode='seed' (SEED-2).
- GAME-1: ADR по LayerVoting согласовать/объединить с ADR из ROT-1 ('своя ротация vs встроенные механизмы Squad'), чтобы не принять два противоречащих решения.
- AUTO-2: scheduler должен предоставлять переиспользуемый внутренний API регистрации job'ов (RCON-команда в момент T + история выполнений + защита от наложения на depot-update), т.к. SEED-3 и ROT-4 регистрируют свои задачи через него, а не реализуют собственные планировщики.
- CFG-1: managed-сегмент LayerRotation.cfg в Monaco-редакторе сделать read-only с подсветкой «управляется панелью» (по аналогии с Admins.cfg) после реализации ROT-2.
- SRV-4: страница сервера уже показывает current layer — ROT-3 заменяет/расширяет это виджетом «текущая/следующая карта»; при реализации SRV-4 не дублировать быстрые действия смены карты.
- AN-1: сузить формулировку до общего dashboard-каркаса и сослаться на LEAD-5, который детализирует серверные стат-срезы конкурента (население/матчи/чат/модерация, KPI-полоса, drill-down, export); export CSV/JSON из AN-1 реализуется в LEAD-5.
- AN-2: публичный stats-portal должен переиспользовать LEAD-2 как read-only источник публичных лидербордов (настройка leaderboards_public), добавить зависимость от LEAD-2/LEAD-3.
- PRES-4: формула бонусов (online + 2×boost) становится единым источником начислений для топа по бонусам — вынести коэффициенты в настройку, на которую ссылается LEAD-4 (не дублировать формулу).
- PRES-5: пер-игроковый праймтайм остаётся как есть; серверный аналог (онлайн по часам суток/дням недели) покрывается LEAD-5 — добавить перекрёстную ссылку, чтобы исполнители не строили два разных агрегата по часам.
- PRES-4: карточка «Бонусы» должна читать баланс из леджера ECON-1 (players.bonus_balance), а не вычислять `online + 2×boost` на лету; фразу «настройка — P2» заменить ссылкой на ECON-3 (/settings/economy); добавить ECON-1 в связанные задачи.
- WL-3: механика `role_expires_at` + worker-чистильщик выносится в VIPSUB-1 (P1) — WL-3 должна переиспользовать её, а не реализовывать заново; добавить зависимость VIPSUB-1 и убрать собственную реализацию auto-expire из формулировки.
- ROLE-1: модель роли расширяется новым panel-флагом `can_manage_economy` (вводится в ECON-3) — учесть при груминге как forward-compatible миграцию.
- PRES-2: в player_daily_presence добавляется колонка seed_seconds (вводится в ECON-2) — упомянуть при реализации, чтобы схема сразу допускала расширение.
- CHAT-1: уточнить, что live-стрим и хранилище CHATLOG-1 питаются одним пайплайном парсинга в log-ingest (не два парсера); P2-фильтрация CHAT-1 (mute-слова/регэкспы) должна переиспользовать серверные правила флагов CHATLOG-5 вместо собственного механизма.
- AUTO-2: тип задачи «broadcast» реализуется через MSG-4 — добавить зависимость от MSG-1 (шаблоны) и указать, что отправка идёт путём MSG-3 с echo в chat_messages.
- AUTO-1: в conditions добавить «flagged chat message» на базе is_flagged из CHATLOG-5 (вместо повторного keyword-матчинга по сырому чату).
- MOD-1: в live-лист добавить кнопки «Сообщение» (per-player, MSG-2) и конверт «Сообщение скваду» (per-squad, MSG-3); для последнего лист должен группироваться по team/squad из ListSquads.
- PLAYER-4: карточка игрока получает tab «Чат» (CHATLOG-4) и кнопку «Сообщение» (MSG-2) — упомянуть в списке секций карточки.
- MOD-3: фрагмент chat log как evidence может ссылаться на записи chat_messages (CHATLOG-1) вместо свободного текста.
- STATS-4: вкладки «Скилл»/«Киты» на карточке игрока переезжают внутрь блока «Досье» (DOSSIER-6) как под-секция «RNSquadJS» с явной пометкой источника; STATS-4 остаётся поставщиком RNSquadJS-данных, но не создаёт отдельные вкладки — цифры RNSquadJS и combat_events не смешиваются; правило «Урон отсутствует в RNSquadJS — скрыть» заменяется общим паттерном DOSSIER-6 (ячейка «—» с tooltip).
- COMBAT-2: схема combat_events расширяется в DOSSIER-1 — новое значение event_type `vehicle_destroyed`, колонки `victim_vehicle`/`attacker_vehicle`, `victim_player_id` становится NULLABLE для vehicle-событий; упомянуть это в COMBAT-2, чтобы миграция закладывала enum/констрейнт расширяемыми.
- PLAYER-4: карточка игрока получает новый блок «Досье» с вкладками Скилл/Оружие/Техника/Киты (DOSSIER-6) — учесть в layout карточки место под lazy-load вкладки.
- COMBAT-4: добавить поддержку префильтра «игрок + оружие» по deep-link — используется drill-down'ом из DOSSIER-6 (P3).
