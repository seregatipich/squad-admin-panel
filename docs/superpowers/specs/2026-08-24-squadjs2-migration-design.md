# Миграция сайдкара на SquadJS2 — дизайн

Дата: 2026-08-24. Статус: утверждён к планированию.
План реализации: [`docs/superpowers/plans/2026-08-24-squadjs2-migration.md`](../plans/2026-08-24-squadjs2-migration.md).
Предыстория: [`2026-04-24-rnsquadjs-migration-design.md`](2026-04-24-rnsquadjs-migration-design.md) (включая §12 «Execution deviations»), ADR в [`docs/architecture/decisions.md`](../../architecture/decisions.md), пин-документ [`ai_docs/rnsquadjs-migration-pin-2026-04-24.md`](../../../ai_docs/rnsquadjs-migration-pin-2026-04-24.md).

---

## 1. Цель

Заменить движок пер-серверного сайдкара: вместо внешнего форка **RNSquadJS**
(`lACTEPUKCl/RNSquadJS`, пин `d76fb4a8`) использовать наш проприетарный
**SquadJS2** (`breaking-squad/squadjs2`, форк SquadJS 4.1.0). Панельный контракт
событий — envelope, Redis-стримы, cutover-механика — остаётся **байт-в-байт
неизменным**: меняется только адаптер между игровым сервером и панелью.

Зачем:

- RNSquadJS — чужой форк с пином на коммит 2026-04-06; каждое обновление требует
  ручного чек-листа совместимости (§7 пин-документа). SquadJS2 — наш код с
  собственным CI, verified-release-конвейером и digest-пиннингом образов.
- Одна кодовая база SquadJS для всей организации (standalone-инстансы
  `squad1/2/3/6` уже работают на SquadJS2) вместо двух расходящихся форков.
- Поводом закрыть накопленные пробелы интеграции, блокирующие дальнейший
  rollout (см. §8).

## 2. Итоговая топология

```
tk104 host
├── Squad game server container  (панель, без изменений)
├── squadjs2-{uuid}              (сайдкар, --network host, --read-only, user 1001:1001)
│     образ: squad-panel/squadjs2:latest
│       = FROM ghcr.io/breaking-squad/squadjs@sha256:<пин>  + плагин PanelBridge
│     монтирования:
│       /var/lib/squad-panel/saved/{id}/SquadGame/Saved/Logs → /squad/Logs:ro
│       /run/squad-panel/squadjs2/{id}/config.json           → /app/panel-config.json:ro
│     └── плагин PanelBridge → Redis (XADD events:server:{id}[:shadow],
│                                     SET sidecar:status:{id}, heartbeat)
└── panel api / workers          (читают те же стримы и ключи, что и сейчас)
```

Ключевые отличия от текущей топологии RNSquadJS:

1. **Нет Unix-сокета RCON.** `rconUnixServer` в panelBridge — мёртвый код
   (у `app.rcon` в `apps/api` нет ни одного вызова). В SquadJS2-сайдкар он не
   переносится. Следствия: у контейнера нет `sock/`-монтирования, env-allowlist
   бриджа сокращается, `apps/api/src/lib/rcon.ts` и декорация `app.rcon`
   удаляются на фазе очистки. RCON-трафик панели, как и сейчас, идёт через
   `worker-rcon` (deviation D4 прежней миграции сохраняется).
2. **Производный образ, а не сборка форка из исходников.** Никакого
   `upstream.patch`: SquadJS2 автообнаруживает плагины в
   `squad-server/plugins/*.js`, достаточно `COPY` файла плагина.
3. **Опции плагина — в конфиге, а не в env.** SquadJS-идиоматика: `mode`,
   `redisUrl`, `serverId` передаются в `plugins[].options`-блоке генерируемого
   конфига. Env сокращается до `SERVER_ID` и `LOG_FILE` (нужны entrypoint'у).

## 3. Компоненты

### 3.1. `docker/squadjs2.Dockerfile` (новый)

- `ARG SQUADJS2_DIGEST` → `FROM ghcr.io/breaking-squad/squadjs@sha256:${SQUADJS2_DIGEST}`.
  Переиспользуем **проверенную** сборку из verified-release-конвейера SquadJS2
  (build identity уже запечён в `/usr/share/squadjs/build-identity.json`),
  не дублируем их сборочную логику.
- `yarn add -W ioredis@<точная версия> uuid@<точная версия>` — зависимости
  плагина (base-образ их не содержит; SquadJS2 — yarn workspaces, поэтому `-W`).
- `COPY docker/squadjs2/plugins/panel-bridge/src/*.js` →
  `/app/squad-server/plugins/` — автообнаружение подхватит `PanelBridge` без
  патчей upstream.
- Собственный entrypoint **вместо** родного `docker-entrypoint.sh`
  (родной делает `envsubst < config/$INSTANCE_NAME.json > config.json` — при
  `--read-only` и панельном конфиге это и не нужно, и не сработает):
  требует `SERVER_ID`, ждёт лог-файл до 60 с, проверяет непустой
  `/app/panel-config.json`, затем `exec dumb-init node index.js /app/panel-config.json`
  (фабрика принимает путь к конфигу как `argv[2]` — `index.js:18`).
- Пин фиксируется в `ai_docs/squadjs2-pin-2026-08-24.md` (аналог прежнего
  пин-документа): digest, соответствующий commit SHA, чек-лист совместимости
  при каждом бампе.

### 3.2. `docker/squadjs2/plugins/panel-bridge/` (новый — наш код, копируется в образ)

Плагин — идиоматичный SquadJS2-плагин: JS ESM, класс-наследник `BasePlugin`
(`mount()` / `unmount()` / `optionsSpecification`), workspace-пакет панели
(`squadjs2-panel-bridge`) с vitest-тестами.

| Модуль | Назначение |
|---|---|
| `panel-bridge.js` | Вход плагина: подписки на события сервера, wiring публикатора и heartbeat, вычисление RCON-статуса. |
| `event-map.js` | SquadJS2-событие → панельный `EventEnvelope`. Контракт payload'ов — **тот же**, что в `docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts` (snake_case-поля, те же 17 типов); меняется только чтение сырых полей (в SquadJS2 события несут разрешённые объекты `data.player`/`data.victim`, а верхнеуровневые id-поля местами удаляются перед emit — точные формы фиксируются golden-фикстурой). |
| `redis-publisher.js` | `XADD events:server:{id}[:shadow] MAXLEN ~ 10000 * envelope <json>`; `SET sidecar:status:{id}[:shadow] … EX 300`. |
| `heartbeat.js` | Каждые 10 с `SET worker:heartbeat:sidecar:{id} … EX 30`; `version` — `commitSha` из `/usr/share/squadjs/build-identity.json` (замена `UPSTREAM_SHA`). |

Семантика режимов сохраняется: `mode: 'shadow'` пишет только в `:shadow`-ключи,
`mode: 'production'` — в боевые. Производственный набор типов расширяется до
**пяти**: `player.connected`, `player.disconnected`, `player.name_changed`,
`match.started`, `match.ended`.

**`player.name_changed`** (новое): в SquadJS2 нет одноимённого события; плагин
выводит его из диффа `UPDATED_PLAYER_INFORMATION` (поллинг списка игроков).
Это закрывает пробел RNSquadJS-интеграции: у cutover-серверов сейчас молча
теряется enforcement banned-name-on-rename, а parity-gate shadow-диффа
перманентно красный при любом реальном переименовании. Тип уже входит в
`EVENT_TYPES` (`packages/shared-types/src/events.ts`) — расширения enum не нужно.

**Не переносится**: `rconUnixServer` (мёртвый код, см. §2), `shadowDiff.ts`
(живёт в `scripts/`, см. §3.5).

### 3.3. Mongo / коннекторы

Генерируемый конфиг включает **только** плагин `PanelBridge`; блок `connectors`
пуст. Ни mongoose, ни MySQL/SQLite/Discord-коннекторы не инициализируются —
это проверяется boot-тестом Фазы 0 (чистый старт пина с пустыми коннекторами,
`--read-only`, без исходящих подключений кроме Redis). Postgres остаётся
единственным датастором панели.

### 3.4. Бридж (`apps/bridge`)

Новый RPC-метод `container_run_squadjs2` **рядом** с `container_run_rnsquadjs`
(старый метод сохраняется до фазы очистки — это путь отката):

- `validate/docker.go`: `SquadJS2Image = "squad-panel/squadjs2:latest"`,
  регэксп имени `^squadjs2-<uuid>$`, лейбл `panel.kind=squadjs2`.
- `runner/docker.go`: compose-аргументы — `--network host --user 1001:1001
  --read-only --restart unless-stopped`, монтирования только логи `:ro` и
  `config.json:ro` (сокет-дира нет); env-allowlist ровно `{SERVER_ID, LOG_FILE}`;
  `ensureSidecarDir` упрощается до каталога конфига (0750, root; файл конфига
  0600, chown 1001 — то же, что сейчас). `Lstat`-проверка `config.json`
  сохраняется.
- `validate/paths.go`: путь-валидатор для сайдкар-каталогов **обоих** движков
  (`/run/squad-panel/{rnsquadjs,squadjs2}/{id}`) + подключение к
  `directory_delete` — удаление сервера обязано вычищать каталог сайдкара
  (сейчас `/run/squad-panel/rnsquadjs/{id}/` с plaintext-паролем RCON
  протекает навсегда; фикс входит в миграцию, т.к. мы всё равно трогаем этот путь).
- `deploy/panel-host-bridge.tmpfiles.conf`: строка
  `d /run/squad-panel/squadjs2 0755 root root -`.

### 3.5. API (`apps/api`)

- **`src/lib/squadjs2.ts`** (новый, по образцу `lib/rnsquadjs.ts`):
  генератор конфига SquadJS2-формата и лаунч-хелпер `relaunchSquadjs2Sidecar`.
  Источники: `server_settings.queryPort` (NOT NULL в БД),
  `serverCredentials.rconPort`, пароль — парсинг `Rcon.cfg` (как сейчас).
  Скелет конфига:

  ```jsonc
  {
    "server": {
      "id": 1,
      "host": "127.0.0.1",
      "queryPort": <server_settings.query_port>,
      "rconPort": <serverCredentials.rconPort>,
      "rconPassword": "<из Rcon.cfg>",
      "logReaderMode": "tail",
      "logDir": "/squad/Logs",
      "adminLists": []
    },
    "connectors": {},
    "plugins": [
      { "plugin": "PanelBridge", "enabled": true,
        "mode": "shadow|production", "redisUrl": "<SIDECAR_REDIS_URL>",
        "serverId": "<panel uuid>" }
    ],
    "logger": { "verboseness": { "SquadServer": 1 } }
  }
  ```

- **Выбор движка** — Redis-set `squadjs2:engine-servers` (desired state, по
  образцу `rnsquadjs:cutover-servers`): членство означает «сайдкар этого
  сервера — SquadJS2». Все точки запуска (`server-install`, start/restart в
  `servers.ts`) выбирают движок по этому набору; stop/delete гасят контейнеры
  **обоих** движков (идемпотентно, как сейчас — best-effort).
- **Маршрут `GET/POST /api/v1/servers/:id/sidecar`** (новый, engine-neutral):
  - `GET` — `{server_id, engine, mode, cutover, status}`; статус читается
    сначала из `sidecar:status:{id}[:shadow]`, затем фолбэк в
    `rnsquadjs:status:{id}[:shadow]` (фолбэк удаляется на очистке).
  - `POST {engine, mode}` — переключение движка/режима: правка engine-set,
    останов старого сайдкара, **зачистка каталога старого движка**, рендер
    конфига, запуск нового. Секвенирование production-режима то же, что у
    текущего cutover-POST (SADD → 202 → ожидание `CUTOVER_TICK_MS` → повторная
    проверка → запуск); `rnsquadjs:cutover-servers` продолжает означать
    «лог-пайплайн у сайдкара» независимо от движка.
  - Старые маршруты `GET/POST /servers/:id/rnsquadjs` живут как deprecated-алиасы
    до фазы очистки (у API есть внешние потребители с токенами).
- **Env**: `SIDECAR_REDIS_URL` (фолбэк на старый `RNSQUADJS_REDIS_URL`, затем
  `redis://127.0.0.1:6379`); документируется в `.env.example` и
  `docs/operations/environment-variables.md` — сейчас `RNSQUADJS_REDIS_URL`
  не задокументирован и нигде не задан.

Скрипт **`scripts/rnsquadjs-shadow-diff.mjs`** переиспользуется как есть для
parity-гейта: стримы и envelope engine-neutral. Единственная правка —
спец-обработка `player.name_changed`: событие производится поллингом, поэтому
попарный матчинг с окном ±5 с даёт ложные расхождения; для этого типа вводится
отдельная посчётная проверка (сравнение количеств за окно с допуском) вместо
попарной. Контрактные тесты скрипта (`pnpm test:scripts`) обновляются.

### 3.6. Веб (`apps/web`)

Секция настроек сервера «Интеграция RNSquadJS» становится engine-neutral
«Интеграция SquadJS»: бейдж движка (`SquadJS2` / `RNSquadJS (legacy)` /
«Штатный парсер»), режим, статус-pill, cutover — данные из `GET …/sidecar`.
Мёртвая карточка «RNSquadJS» в досье игрока (`DossierSkillTab`) удаляется на
фазе очистки (она всегда показывает заглушку «Данные RNSquadJS недоступны»).

### 3.7. Удаления (фаза очистки, только после полного выката)

`docker/rnsquadjs/` + `docker/rnsquadjs.Dockerfile`; `container_run_rnsquadjs`
(Go + `packages/bridge-client` + `packages/shared-config/src/bridge-methods.ts`);
`apps/api/src/lib/rnsquadjs.ts`; `apps/api/src/lib/rcon.ts` + декорация
`app.rcon`; маршруты-алиасы `/rnsquadjs`; фолбэк-чтение старых Redis-ключей;
compose-сервис `rnsquadjs-image`; воркспейс-запись `docker/rnsquadjs/plugins/*`;
карточка досье; упоминания в доках. Пин-документ RNSquadJS помечается
superseded. Набор `rnsquadjs:cutover-servers` **не** переименовывается в рамках
миграции (живое prod-состояние; переименование — отдельное issue).

## 4. Неизменный контракт (менять запрещено)

1. Схема `EventEnvelope` и `EVENT_TYPES` (`packages/shared-types/src/events.ts`).
2. Стримы `events:server:{id}` / `…:shadow`, поле `envelope`, JSON-содержимое.
   Потребители — `GET /servers/:id/events`, `worker-discord` (SCAN
   `events:server:*`), `worker-automation` — не трогаются.
3. Набор `rnsquadjs:cutover-servers` и его семантика в
   `apps/workers/log-ingest` (`dropCutoverServers`) — без изменений.
4. Каталоги Squad-сервера, механика установки/обновления через SteamCMD,
   `worker-rcon` как источник `rcon:status:{id}`, A2S, tickrate.
5. Форматы ключей нового движка (`sidecar:status:*`, `worker:heartbeat:sidecar:*`)
   — новые имена, но **та же** структура JSON, что у RNSquadJS-аналогов.

## 5. Жизненные циклы

### 5.1. Установка сервера
Как сейчас (`server-install.ts`): после запуска Squad-контейнера — гарантия
каталога логов, рендер конфига, выбор режима по cutover-set; **новое** — выбор
движка по `squadjs2:engine-servers`. Ошибки сайдкара по-прежнему нефатальны
для установки.

### 5.2. Start / Stop / Restart
`start`/`restart` → `relaunch<Engine>Sidecar` по engine-set;
`stop` → `containerStop` для имён обоих движков (идемпотентно, нефатально).

### 5.3. Удаление сервера
`server-delete.ts`: `containerRm` обоих имён + **новое** `directory_delete`
каталогов `/run/squad-panel/{rnsquadjs,squadjs2}/{id}` (закрытие утечки
plaintext-пароля).

### 5.4. Обновление SquadJS2 (бамп пина)
Новый digest в `ai_docs/squadjs2-pin-*.md` → пересборка
`squad-panel/squadjs2:latest` → чек-лист совместимости (события/поля
log-parser'а, RCON, формат конфига, Node) → relaunch сайдкаров поштучно.
Squad-сервер не рестартует.

### 5.5. Доставка образа
Образ производный от **приватного** `ghcr.io/breaking-squad/squadjs` — и CI, и
tk104 нужен `docker login ghcr.io` (пакет должен быть доступен репозиторию
панели; в CI — `GITHUB_TOKEN` c `packages: read`, если доступ выдан, иначе
организационный PAT-секрет). Это пререквизит Фазы 0. Сборка: CI-джоба (как у
`rnsquadjs:ci`) + compose-сервис `squadjs2-image` под `profiles: ['images']`.
Автоматизация сборки сайдкар-образов в `deploy-tk104.yml` — существующий
пробел, наследуемый и новым образом: фиксируется отдельным issue, не в этой
миграции.

## 6. Матрица состояний и фазы выката

Текущее состояние каждого сервера ∈ {legacy, rnsquadjs-shadow,
rnsquadjs-production}. Переходы:

| Из | Шаг миграции | Кто пишет `events:server:{id}` | Кто пишет `…:shadow` |
|---|---|---|---|
| legacy | запуск squadjs2-shadow | штатный log-ingest | squadjs2 |
| rnsquadjs-shadow | **замена** rnsquadjs-shadow → squadjs2-shadow (один писатель `:shadow`) | штатный log-ingest | squadjs2 |
| rnsquadjs-production | squadjs2-shadow **рядом** (разные стримы и имена контейнеров — коллизий нет) | rnsquadjs | squadjs2 |
| соак пройден | engine-cutover: стоп rnsquadjs → squadjs2 в production (`SADD` в cutover-set только для legacy-серверов) | squadjs2 | — |

Откат на любом шаге: обратный переход тем же `POST /sidecar` — метод, образ и
конфиг-генератор RNSquadJS сохраняются до фазы очистки.

Фазы (жёсткие гейты, без параллелизма между фазами):

| Фаза | Содержание | Гейт | Откат |
|---|---|---|---|
| 0 | Пререквизиты: GHCR-доступ, пин digest, boot-тест `--read-only` c пустыми коннекторами, golden-фикстура SquadJS2 | образ стартует чисто; фикстура закоммичена | — (ничего не меняется в prod) |
| 1 | Плагин + образ + юнит-тесты (только shadow) | Tier-1 зелёный; parity фикстуры 100 % по 17 типам | — |
| 2 | Бридж + API + веб + e2e | Tier-2/3 зелёные; `dev` CI зелёный | revert merge |
| 3 | Канарейка: squadjs2-shadow, соак 24 ч, `rnsquadjs-shadow-diff` | parity ≥ 99 %, ноль missing types (name_changed — посчётный гейт) | стоп squadjs2-shadow |
| 4 | Канарейка: engine-cutover в production, соак 24 ч | heartbeat стабилен, консюмеры без деградации, e2e зелёный | `POST /sidecar {engine: rnsquadjs}` |
| 5 | Флот батчами по 5 (shadow-соак → cutover) | все зелёные 24 ч на батч | пер-серверный откат |
| 6 | Очистка (§3.7) + доки + issues на отложенное | typecheck + полный test + e2e зелёные | revert merge |

## 7. Тестирование

- **Tier 1 — юнит**: `event-map` против golden-фикстуры (parsed-вывод SquadJS2
  на том же `SquadGame.log`, что фикстура RNSquadJS — payload'ы envelope
  сравниваются с эталонными байт-в-байт); `redis-publisher` (режимы, MAXLEN);
  `heartbeat`; деривация `name_changed`; Go-валидаторы и compose-аргументы.
- **Tier 2 — интеграция**: рендер конфига из реальной БД (`queryPort`,
  `rconPort`, пароль); маршрут `/sidecar` (dual-read, переключение, аудит);
  install/start/stop/delete c фейком `containerRunSquadjs2` в
  `apps/api/test/integration/harness.ts`; контрактные тесты shadow-diff.
- **Tier 3 — e2e**: `install-lifecycle.e2e.test.ts` — полный цикл с
  SquadJS2-сайдкаром; живой прогон на tk104 до Фазы 4.
- Новый workspace-пакет обязан попасть в `test:cov`-фильтр
  (`scripts/test-cov-complete.sh` уронит CI, если забыть).

## 8. Риски и явные не-цели

Риски:

1. **Формы payload'ов SquadJS2 ≠ RNSquadJS** (разрешённые `data.player`-объекты,
   удаление верхнеуровневых id перед emit). Митигация: golden-фикстура в Фазе 0,
   TDD маппера, потом 24-ч shadow-соак с parity-гейтом.
2. **`--read-only` rootfs**: base-образ объявляет `VOLUME /app/data`; статс- и
   mongoose-пути могут писать. Митигация: boot-тест Фазы 0 (PanelBridge-only
   конфиг, нулевые коннекторы, user 1001:1001 поверх файлов образа c uid 1000).
3. **`name_changed` из поллинга**: каденс поллинга > ±5 с окна диффа. Митигация:
   посчётный гейт в скрипте (решено в §3.5, не открывается заново в соаке).
4. **HTTP-плагины при `--network host`**: `autoseed-exporter` (:32080),
   `socket-io-api` — порт-коллизии между сайдкарами на одном хосте. Митигация:
   в генерируемом конфиге эти плагины никогда не включаются; здоровье — только
   heartbeat-ключи (никаких `/readyz` панель не опрашивает).
5. **Приватный registry**: без GHCR-доступа не собирается образ. Митигация:
   пререквизит Фазы 0, проверяется до любого кода.
6. **Отсутствие пер-серверного transition-lock** (гонка конкурентных
   переключений) — осознанно наследуется от текущего cutover-POST; фиксируется
   issue, секвенирование то же.

Не-цели:

- Не трогаем standalone-инстансы SquadJS2 (`squad1/2/3/6`, Dokploy,
  targeted-safe-release): **панельные сайдкары вне их release-governance** —
  это отдельные потребители того же образа.
- Не включаем прочие плагины SquadJS2 (stats, team-balancer, chat-commands…) —
  только PanelBridge. Расширение — отдельная работа.
- Не переносим RCON-путь: `worker-rcon` остаётся авторитетным (D4).
- Не меняем поведение чата: `chat.message` не входит в производственный набор,
  cutover-серверы, как и сейчас, обслуживаются чат-командами сайдкара либо
  никем (issue вдогонку).
- Не переименовываем `rnsquadjs:cutover-servers` (issue вдогонку).

## 9. Принятые решения (2026-08-25)

1. **Стартовый пин** — последний verified-выпуск на момент планирования:
   `ghcr.io/breaking-squad/squadjs@sha256:7cfc1535f54fdda21ad73d147a054e7d7b77aa516ead139149bc4857c8a72639`
   (commit `d6c0e698` в `master` squadjs2, run `Build Docker image`
   № 32641097402 от 2026-08-23, джоба `docker` — success, то есть образ прошёл
   run-by-digest-проверку build identity). Если к старту Фазы 0 появится более
   свежий verified-digest — берётся он, пин-документ фиксирует фактический.
   Выдача GHCR-доступа пакету — операторский шаг Task 1 (админ-действие в UI
   пакета; фолбэк — org-PAT в секрете `GHCR_PULL_TOKEN`).
2. **Выбор канарейки** — детерминированное правило, без ручного решения:
   (а) сервер с `servers.is_canary = true` (метка канарейки прошлой миграции),
   иначе (б) сервер, уже находящийся в состоянии rnsquadjs-shadow,
   иначе (в) живой сервер с наименьшим онлайном за последние 7 дней.
3. **Окна соака — 24 ч, батч флота — 5 серверов** (значения прошлой миграции;
   оператор может ужесточить, ослаблять нельзя).
4. **Судьба `/rnsquadjs`-алиасов на очистке**: перед Task 20 проверить
   аудит/логи API на обращения к `/servers/:id/rnsquadjs` за последние 14 дней;
   обращений нет — алиасы удаляются, есть — оставляется 410-заглушка с
   указанием замены на один релизный цикл.
