# Миграция сайдкара на SquadJS2 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить движок пер-серверного сайдкара с форка RNSquadJS на проприетарный SquadJS2 (`breaking-squad/squadjs2`), сохранив панельный контракт событий байт-в-байт, и вывести RNSquadJS из кодовой базы после полного выката.

**Architecture:** Производный образ `squad-panel/squadjs2:latest` = `FROM ghcr.io/breaking-squad/squadjs@sha256:<пин>` + плагин `PanelBridge` (JS ESM, наследник `BasePlugin`, автообнаружение — без патчей upstream). Сайдкар `squadjs2-{uuid}`: `--network host --read-only --user 1001:1001`, монтирования только логи `:ro` и конфиг `:ro`; Unix-сокет RCON не переносится (мёртвый код). Опции плагина (`mode`, `redisUrl`, `serverId`) — в генерируемом API конфиге SquadJS-формата. Плагин публикует прежний `EventEnvelope` в `events:server:{id}[:shadow]` (теперь с `MAXLEN ~ 10000`), статус в новые engine-neutral ключи `sidecar:status:{id}[:shadow]`, heartbeat в `worker:heartbeat:sidecar:{id}`. Выбор движка — Redis-set `squadjs2:engine-servers`; `rnsquadjs:cutover-servers` и его семантика в log-ingest не меняются. RNSquadJS-метод/образ/генератор сохраняются как путь отката до фазы очистки. Полный дизайн: [`docs/superpowers/specs/2026-08-24-squadjs2-migration-design.md`](../specs/2026-08-24-squadjs2-migration-design.md).

**Tech Stack:** JS ESM (плагин, Node 20 — базовый образ SquadJS2), TypeScript (панель), Vitest, Fastify 5 + Zod, Drizzle/Postgres, ioredis, Go 1.22 (бридж), Docker, GHCR.

**Global Constraints:**

- Контракт из §4 спеки неизменен: `EventEnvelope`, `EVENT_TYPES`, стримы `events:server:{id}[:shadow]` (поле `envelope`), набор `rnsquadjs:cutover-servers`, потребители стримов.
- Производственный набор типов плагина: `player.connected`, `player.disconnected`, `player.name_changed`, `match.started`, `match.ended` (5 типов; `name_changed` — новое требование, деривация из `UPDATED_PLAYER_INFORMATION`).
- Env-allowlist сайдкара: ровно `{SERVER_ID, LOG_FILE}`. Никаких `PANEL_BRIDGE_MODE`/`PANEL_BRIDGE_SOCKET`/`REDIS_URL` в env нового движка.
- В конфиге сайдкара никогда не включаются HTTP-слушающие плагины (`autoseed-exporter`, `socket-io-api`) — порт-коллизии при `--network host`.
- Каждая задача — TDD: красный тест → реализация → зелёный; коммит и пуш по завершении задачи; перед коммитом — тесты пакета + `typecheck` + `biome check`.
- Новый workspace-пакет обязан попасть в `test:cov`-фильтр корневого `package.json` (иначе `scripts/test-cov-complete.sh` уронит CI).
- Фазы 3–5 (соаки, канарейка, флот) — операторские, по runbook из Task 19; фаза 6 (очистка) начинается только после полного выката флота.

---

## Статус на 2026-09-08

| Фаза | Задачи | Статус | Доказательство |
|---|---|---|---|
| 0 — пререквизиты | Task 1–3 | частично | пин и каркас сборки готовы (`ai_docs/squadjs2-pin-2026-08-24.md`), golden-фикстура снята прогоном реального кода обоих движков. **Не сделано:** доступ к приватному пакету GHCR (Task 1 Step 1) и контейнерный boot-тест (Task 2) — оба упираются в этот доступ |
| 1 — плагин и образ | Task 4–10 | частично | пакет `squadjs2-panel-bridge` — 77 тестов зелёные; Dockerfile и entrypoint написаны и покрыты контрактным тестом. **Не сделано:** сборка образа и smoke (Task 10 Step 3), включение CI-шагов (Task 10 Step 4) — нет доступа к GHCR |
| 2 — бридж, API, веб, e2e | Task 11–18 | **готово** | слито в `dev` (`6ecbef01`), CI [34207959716](https://github.com/breaking-squad/squad-admin-panel/actions/runs/34207959716) зелёный целиком, `scripts/verify-done.sh` → PASSED |
| 3–5 — выкат | Task 19 | не начинался | runbook написан (`docs/operations/squadjs2-rollout.md`); прогон канарейки блокирован фазой P0 runbook'а |
| 6 — очистка | Task 20 | не начиналась | по условию — только после полного выката |

**Что изменилось относительно исходного плана** (детали и команды — в
[`docs/operations/squadjs2-rollout.md`](../../operations/squadjs2-rollout.md)):

1. Обнаружен стоп-фактор апстрима: на пине `258440d0` не срабатывает `PLAYER_DISCONNECTED`
   (issue [#307](https://github.com/breaking-squad/squad-admin-panel/issues/307), фикс —
   [squadjs2#264](https://github.com/breaking-squad/squadjs2/pull/264)). Production-переключение
   запрещено до бампа digest.
2. Прежняя parity-фикстура RNSquadJS оказалась логом простоя без единого игрового события,
   поэтому фикстура собрана заново из реальных форматов строк с обезличенными идентификаторами.
3. Payload'ы SquadJS2 богаче RNSquadJS (у того `player.connected` был без `name`,
   `player.revived` пустым, `player.disconnected` без `steam_id64`). Контракт типов и ключей
   сохранён, «байт-в-байт» из §4 дизайна выполняется на уровне схемы, не значений.
4. В проде сейчас один контейнерный сервер и один внешний, сайдкаров нет вообще, поэтому
   фаза 5 («флот батчами по 5») пуста, а канарейка определяется вырожденно.
5. Закрыта утечка: каталог сайдкара с plaintext-паролем RCON переживал удаление сервера —
   `directory_delete` расширен на `/run/squad-panel/{rnsquadjs,squadjs2}/{uuid}`.

---

## Файлы

### Создаются

- `docker/squadjs2.Dockerfile` — производный образ с плагином и своим entrypoint.
- `docker/squadjs2/entrypoint.sh` — SERVER_ID-guard, ожидание лога, exec `node index.js /app/panel-config.json`.
- `docker/squadjs2/plugins/panel-bridge/package.json` — пакет `squadjs2-panel-bridge` (vitest, ioredis, uuid).
- `docker/squadjs2/plugins/panel-bridge/src/panel-bridge.js` — вход плагина (`BasePlugin`).
- `docker/squadjs2/plugins/panel-bridge/src/panel-bridge/event-map.js` — SquadJS2-событие → `EventEnvelope`.
- `docker/squadjs2/plugins/panel-bridge/src/panel-bridge/name-change-tracker.js` — деривация `player.name_changed`.
- `docker/squadjs2/plugins/panel-bridge/src/panel-bridge/redis-publisher.js` — XADD/статус с режимами.
- `docker/squadjs2/plugins/panel-bridge/src/panel-bridge/heartbeat.js` — heartbeat с build-identity `version`.
- `docker/squadjs2/plugins/panel-bridge/src/base-plugin.js` — локальный дубль контракта `BasePlugin` только для юнит-тестов; в образ не копируется.

> **Отклонение от исходной раскладки.** Вспомогательные модули лежат в подкаталоге
> `src/panel-bridge/`, а не рядом с входом. SquadJS2 импортирует **каждый** файл `*.js`
> верхнего уровня в `squad-server/plugins/` и берёт `Plugin.name` у дефолтного экспорта, поэтому
> модуль без дефолтного экспорта уронил бы загрузку всех плагинов. Подкаталоги загрузчик
> пропускает (`dirent.isFile()`), поэтому вход остаётся единственным файлом. По той же причине
> `docker/squadjs2.Dockerfile` копирует файлы поимённо, а не по маске: маска затащила бы
> тестовый `base-plugin.js` поверх апстримного.
- `docker/squadjs2/plugins/panel-bridge/test/*.test.js` — юнит-тесты модулей.
- `docker/squadjs2/plugins/panel-bridge/test/fixtures/` — golden-фикстура (Task 3).
- `apps/api/src/lib/squadjs2.ts` — конфиг-рендер, env-builder, `relaunchSquadjs2Sidecar`.
- `apps/api/src/routes/server-sidecar.ts` — `GET/POST /api/v1/servers/:id/sidecar`.
- `apps/api/test/lib/squadjs2.test.ts`, `apps/api/test/server-sidecar.test.ts`, `apps/api/test/integration/server-sidecar.test.ts`.
- `packages/shared-config/src/sidecar.ts` — `SQUADJS2_ENGINE_SET`, билдеры ключей `sidecar:status:*`, `worker:heartbeat:sidecar:*`.
- `ai_docs/squadjs2-pin-2026-08-24.md` — пин digest + чек-лист совместимости при бампе.
- `docs/operations/squadjs2-rollout.md` — runbook фаз 3–5.

### Изменяются

- `pnpm-workspace.yaml` — `docker/squadjs2/plugins/*`.
- `package.json` (корень) — пакет в `test:cov`-фильтре.
- `apps/bridge/internal/validate/docker.go`, `paths.go` + тесты — образ/имя/лейбл SquadJS2, валидатор сайдкар-каталогов обоих движков.
- `apps/bridge/internal/runner/docker.go` + тест — `composeSquadJS2Args`, упрощённый `ensureSidecarDir`, `RunSquadJS2`.
- `apps/bridge/internal/handlers/handlers.go` + тест — метод `container_run_squadjs2`; `directory_delete` принимает сайдкар-каталоги.
- `apps/bridge/deploy/panel-host-bridge.tmpfiles.conf` — `/run/squad-panel/squadjs2`.
- `packages/shared-config/src/bridge-methods.ts`, `packages/bridge-client/src/{types,client}.ts` + тесты.
- `apps/api/src/routes/index.ts` — регистрация `server-sidecar` (обязательна: parity-тест регистрации маршрутов).
- `apps/api/src/routes/{server-install,servers}.ts`, `apps/api/src/lib/server-delete.ts` + тесты — engine-aware запуск, стоп/удаление обоих движков, зачистка каталогов.
- `apps/api/test/integration/harness.ts` — фейк `containerRunSquadjs2`.
- `apps/api/test/e2e/install-lifecycle.e2e.test.ts` — жизненный цикл со SquadJS2.
- `apps/web/src/app/(dashboard)/servers/[id]/settings/{page.tsx,helpers.ts}` + тесты — engine-neutral секция.
- `scripts/rnsquadjs-shadow-diff.mjs` + `scripts/rnsquadjs-shadow-diff.test.ts` — посчётный гейт `name_changed`.
- `docker-compose.yml`, `compose.tk104.yml` — сервис `squadjs2-image` (`profiles: ['images']`).
- `.github/workflows/ci.yml` — сборка `squad-panel/squadjs2:ci` (с GHCR-логином).
- `.env.example`, `docs/operations/environment-variables.md` — `SIDECAR_REDIS_URL`.
- Доки: `docs/architecture/decisions.md` (ADR-дополнение), `docs/architecture/map.md`, `docs/components/api/api.md`, `docs/components/shared-config/data-model.md`, `docs/development/testing.md`.

### Удаляются (только Task 20, после выката)

- `docker/rnsquadjs/`, `docker/rnsquadjs.Dockerfile`, воркспейс-запись `docker/rnsquadjs/plugins/*`, compose-сервис `rnsquadjs-image`.
- `container_run_rnsquadjs` по всей цепочке (Go, shared-config, bridge-client), `apps/api/src/lib/rnsquadjs.ts`, `apps/api/src/routes/server-rnsquadjs.ts` (алиасы), `apps/api/src/lib/rcon.ts` + декорация `app.rcon`.
- Фолбэк-чтение `rnsquadjs:status:*`, карточка «RNSquadJS» в `DossierSkillTab`, `RNSQUADJS_UNAVAILABLE`.

---

## Фаза 0 — пререквизиты и де-риск

### Task 1: Доступ к GHCR, пин digest, инфраструктура образа

**Files:** `ai_docs/squadjs2-pin-2026-08-24.md` (создать), `docker-compose.yml`, `compose.tk104.yml`, `.github/workflows/ci.yml`.

- [ ] **Step 1: Доступ пакета.** Оператор выдаёт репозиторию `squad-admin-panel` доступ `read` к GHCR-пакету `breaking-squad/squadjs` (Settings пакета → Manage Actions access) либо кладёт org-PAT в секрет `GHCR_PULL_TOKEN`. Проверка с хоста tk104 и локально:

```bash
docker login ghcr.io -u <user> --password-stdin
docker manifest inspect ghcr.io/breaking-squad/squadjs:master | head -5
```

- [x] **Step 2: Зафиксировать digest.** Стартовый пин определён в §9 спеки: `sha256:7cfc1535f54fdda21ad73d147a054e7d7b77aa516ead139149bc4857c8a72639` (commit `d6c0e698`, run 32641097402 от 2026-08-23, джоба `docker` — success). Если к моменту исполнения есть более свежий verified-выпуск (`gh run list --repo breaking-squad/squadjs2 --workflow build-docker-image.yml` — последний run с успешной джобой `docker`; digest — в блоке `Digest` её лога) — взять его. Записать в `ai_docs/squadjs2-pin-2026-08-24.md`: digest, commit SHA, дата, ссылка на run; раздел «Чек-лист совместимости при бампе» (события и поля log-parser'а, сигнатуры RCON, формат конфига, версия Node, plugins-автообнаружение).
- [x] **Step 3: Compose-сервис.** В оба compose-файла добавить сервис `squadjs2-image` под `profiles: ['images']` (context `.`, dockerfile `docker/squadjs2.Dockerfile`, tag `squad-panel/squadjs2:latest`, `command: ['/bin/true']`) — по образцу `rnsquadjs-image`.
- [x] **Step 4: CI-сборка.** В `ci.yml` добавить шаг `docker build -f docker/squadjs2.Dockerfile -t squad-panel/squadjs2:ci .` с предварительным `docker/login-action` (SHA-пин! — `scripts/test-workflow-pins.sh` уронит CI за тег) на `GITHUB_TOKEN`/`GHCR_PULL_TOKEN`. Шаг добавить, но пометить `if: false` до готовности Dockerfile в Task 10, затем включить там же.
- [x] **Step 5: Commit** `chore(squadjs2): пин образа, GHCR-доступ, каркас сборки`.

### Task 2: Boot-тест де-риска базового образа

Цель: доказать до написания кода, что пин стартует в панельных ограничениях.

**Files:** временные файлы в scratch-каталоге (в репозиторий не попадают); результат — раздел «Boot-тест» в `ai_docs/squadjs2-pin-2026-08-24.md`.

- [ ] **Step 1: Минимальный конфиг.** Собрать `panel-config.json`: `server` со стендовыми `host/queryPort/rconPort/rconPassword`, `logReaderMode: "tail"`, `logDir` на каталог с копией фикстурного `SquadGame.log`; `connectors: {}`; `plugins: []`; `logger` минимальный.
- [ ] **Step 2: Запуск в панельных ограничениях:**

```bash
docker run --rm --read-only --network host --user 1001:1001 \
  -v "$PWD/logs:/squad/Logs:ro" -v "$PWD/panel-config.json:/app/panel-config.json:ro" \
  --entrypoint node ghcr.io/breaking-squad/squadjs@sha256:<пин> index.js /app/panel-config.json
```

- [ ] **Step 3: Зафиксировать в пин-документе:** чистый старт под uid 1001 (файлы образа принадлежат 1000 — читаемость проверяется именно здесь); mongoose не подключается при пустых коннекторах; поведение `VOLUME /app/data` при `--read-only` (анонимный том или необходимость `--tmpfs`); отсутствие слушающих портов (`ss -tlnp`); реакция на недоступный RCON (retry, не crash-loop). Любой провал — стоп-фактор: решение (доработка в squadjs2 или обход) согласуется с оператором до Фазы 1.
- [ ] **Step 4: Commit** `docs(squadjs2): результаты boot-теста пина`.

### Task 3: Golden-фикстура SquadJS2

Цель: пер-событийный эталон «сырое событие SquadJS2 → ожидаемый envelope» для TDD маппера. Точные формы payload'ов SquadJS2 отличаются от RNSquadJS (разрешённые `data.player`-объекты; в `PLAYER_DISCONNECTED` верхнеуровневые id-поля удаляются перед emit) — фикстура снимает эти различия фактом, а не предположением.

**Files:** `docker/squadjs2/plugins/panel-bridge/test/fixtures/` (создать).

- [x] **Step 1:** Переиспользовать существующий лог `docker/rnsquadjs/plugins/panelBridge/test/fixtures/` (`SquadGame.log`, при отсутствии — снять с канарейки как в Task 1 прежнего плана).
- [x] **Step 2:** Прогнать пин SquadJS2 по логу (запуск из Task 2, `logReaderMode: "tail"` на статичном файле; при необходимости — вспомогательный скрипт с подпиской на все 17 + `UPDATED_PLAYER_INFORMATION` событий, дампящий JSON-массив `{event, data}`), сохранить как `squadjs2-events.json`.
- [x] **Step 3:** Эталонные envelope получить **из RNSquadJS-контура на том же логе** (прогон существующего `eventMap.ts` по `SquadGame.log.parsed.json` либо повторный прогон RNSquadJS-пайплайна) → `expected-envelopes.json`. Кормить SquadJS2-сырьё в RNSquadJS-маппер нельзя — формы raw-событий разные. Суть шага — **ручное выравнивание** двух последовательностей по паре (тип, таймштамп) в парную фикстуру `{squadjs2Raw, expectedEnvelope}`; расхождения в составе событий (лишние/отсутствующие) фиксируются в пин-документе как факт о движке.
- [x] **Step 4: Commit** `test(squadjs2): golden-фикстура событий и эталонные envelope`.

---

## Фаза 1 — плагин и образ (только shadow)

### Task 4: Каркас workspace-пакета `squadjs2-panel-bridge`

**Files:** `docker/squadjs2/plugins/panel-bridge/package.json`, `pnpm-workspace.yaml`, корневой `package.json`.

- [x] **Step 1:** `package.json` пакета: `"name": "squadjs2-panel-bridge"`, `"type": "module"`, deps `ioredis` + `uuid` (точные версии — те же добавляются в образ в Task 10), devDep `vitest`, скрипты `test`/`test:cov`.
- [x] **Step 2:** `pnpm-workspace.yaml` — добавить `docker/squadjs2/plugins/*`; корневой `test:cov` — добавить `--filter=squadjs2-panel-bridge`.
- [x] **Step 3:** Проверить гейт: `bash scripts/test-cov-complete.sh` — зелёный.
- [x] **Step 4: Commit** `chore(squadjs2): каркас пакета squadjs2-panel-bridge`.

### Task 5: `event-map.js` — маппер событий (TDD по фикстуре)

**Files:** `src/event-map.js`, `test/event-map.test.js` (пути внутри пакета).

- [x] **Step 1 (red):** Тест: для каждой записи `squadjs2-events.json` маппер выдаёт envelope, глубоко равный соответствующему из `expected-envelopes.json` (без `event_id`/`ts`); отдельные кейсы — `PLAYER_DISCONNECTED` без верхнеуровневого `steamID` (чтение из `data.player`), `CHAT_MESSAGE` (`channel` из `data.chat`), null-безопасность отсутствующих игроков.
- [x] **Step 2 (green):** Реализовать 17 мапперов. Контракт типов/payload'ов — копия `eventMap.ts` RNSquadJS (snake_case, те же поля); источники полей — сырые формы SquadJS2 из фикстуры. Envelope: `{event_id: uuidv7, version: 1, type, server_id, ts: ISO(data.time), actor: {kind:'system', id:null}, correlation_id: null, payload}`.
- [x] **Step 3:** `pnpm --filter squadjs2-panel-bridge test` зелёный. **Commit** `feat(squadjs2): маппер событий SquadJS2 → EventEnvelope`.

### Task 6: `name-change-tracker.js` — деривация `player.name_changed`

Закрывает пробел: RNSquadJS-контур не эмитит `player.name_changed`, из-за чего cutover-серверы теряют banned-name-on-rename, а parity-гейт перманентно красный.

**Files:** `src/name-change-tracker.js`, `test/name-change-tracker.test.js`.

- [x] **Step 1 (red):** Тесты: на `UPDATED_PLAYER_INFORMATION` трекер сравнивает имена по `steamID`; смена имени → событие `player.name_changed` с payload'ом, идентичным штатному парсеру (`apps/workers/log-ingest` — поля `steam_id64`, `old_name`, `new_name`; сверить с продюсером в `src/parser/` и фикстурами log-ingest); первый снапшот игрока события не даёт; выход игрока чистит состояние.
- [x] **Step 2 (green):** Реализация с bounded-состоянием (Map по steamID, очистка на `PLAYER_DISCONNECTED`).
- [x] **Step 3: Commit** `feat(squadjs2): деривация player.name_changed из поллинга`.

### Task 7: `redis-publisher.js` — публикация с режимами

**Files:** `src/redis-publisher.js`, `test/redis-publisher.test.js`.

- [x] **Step 1 (red):** Тесты (ioredis-мок): shadow-режим пишет только `events:server:{id}:shadow` и `sidecar:status:{id}:shadow`; production — без суффикса и **только** 5 производственных типов (`player.connected`, `player.disconnected`, `player.name_changed`, `match.started`, `match.ended`), остальные дропаются до XADD; `XADD` с `MAXLEN ~ 10000` (устранение расхождения с легаси-паблишером); статус `SET … EX 300` c JSON `{state, lastChange}`.
- [x] **Step 2 (green):** Реализация по образцу `redisPublisher.ts` RNSquadJS c новыми именами ключей из `packages/shared-config/src/sidecar.ts` (билдеры дублируются в JS-плагине константами — плагин не импортирует TS-пакеты; тест сверяет строки с эталоном).
- [x] **Step 3: Commit** `feat(squadjs2): Redis-паблишер с режимами и MAXLEN`.

### Task 8: `heartbeat.js`

**Files:** `src/heartbeat.js`, `test/heartbeat.test.js`.

- [x] **Step 1 (red):** Тесты: каждые 10 с `SET worker:heartbeat:sidecar:{id} <json> EX 30`; payload `{name: 'squadjs2:{id}', ts, pid, hostname, version, started_at, status: 'ok'}`; `version` — `commitSha` из `/usr/share/squadjs/build-identity.json` (путь инжектируется, файл мокается; при нечитаемом файле — `'unknown'`); `stop()` снимает таймер.
- [x] **Step 2 (green):** Реализация. **Commit** `feat(squadjs2): heartbeat сайдкара с build-identity`.

### Task 9: `panel-bridge.js` — вход плагина

**Files:** `src/panel-bridge.js`, `test/panel-bridge.test.js`.

- [x] **Step 1 (red):** Тесты с фейковым `server` (EventEmitter + `options`): `optionsSpecification` объявляет `mode` (default `'shadow'`), `redisUrl` (default `redis://127.0.0.1:6379`), `serverId` (required); `mount()` подписывает 17 событий + `UPDATED_PLAYER_INFORMATION`, стартует heartbeat, публикует статус `connected` при маунте и `disconnected` на `RCON_ERROR` (модель статуса — best-effort, как у RNSquadJS-моста); `unmount()` снимает все подписки (SquadJS2 их требует — см. `test/plugin-unmount-listeners.test.js` upstream), гасит heartbeat, закрывает Redis.
- [x] **Step 2 (green):** Реализация: класс `PanelBridge extends BasePlugin` (импорт `./base-plugin.js` — файл лежит рядом в каталоге плагинов образа; в юнит-тестах — лёгкий стаб с тем же контрактом `constructor(server, options, connectors)`).
- [x] **Step 3:** Полный прогон пакета + `biome check`. **Commit** `feat(squadjs2): плагин PanelBridge`.

### Task 10: Dockerfile + entrypoint + включение CI-сборки

**Files:** `docker/squadjs2.Dockerfile`, `docker/squadjs2/entrypoint.sh`, `.github/workflows/ci.yml`.

- [x] **Step 1:** Dockerfile по §3.1 спеки: `ARG SQUADJS2_DIGEST` (default — пин из ai_docs), `FROM ghcr.io/breaking-squad/squadjs@sha256:${SQUADJS2_DIGEST}`, `yarn add -W ioredis@<x> uuid@<y>` (точно те версии, что в package.json пакета), `COPY docker/squadjs2/plugins/panel-bridge/src/*.js /app/squad-server/plugins/`, свой `ENTRYPOINT`.
- [x] **Step 2:** `entrypoint.sh`: fail при пустом `SERVER_ID`; `LOG_FILE` default `/squad/Logs/SquadGame.log`; ожидание лог-файла до 60 с; проверка непустого `/app/panel-config.json`; `exec dumb-init node index.js /app/panel-config.json`.
- [ ] **Step 3:** Локальная сборка + smoke: контейнер с конфигом из Task 2, но `plugins: [{"plugin":"PanelBridge","enabled":true,"mode":"shadow","serverId":"<uuid>"}]` и живым Redis → в `events:server:<uuid>:shadow` появляются envelope, есть heartbeat-ключ. Вывод команд — в пин-документ.
- [ ] **Step 4:** Включить CI-шаг из Task 1 Step 4 (`if: false` убрать). CI зелёный.
- [x] **Step 5: Commit** `feat(squadjs2): производный образ сайдкара`.

---

## Фаза 2 — бридж, API, веб, e2e

### Task 11: Go-бридж — `container_run_squadjs2` и зачистка каталогов

**Files:** `apps/bridge/internal/validate/{docker,paths}.go` + тесты, `apps/bridge/internal/runner/docker.go` + тест, `apps/bridge/internal/handlers/handlers.go` + тест, `apps/bridge/deploy/panel-host-bridge.tmpfiles.conf`.

- [x] **Step 1 (red):** Go-тесты: `SquadJS2Image = "squad-panel/squadjs2:latest"` не в `allowedImages` generic-запуска; `ContainerName` принимает `squadjs2-<uuid>`; `composeSquadJS2Args` — точные аргументы: `--network host --user 1001:1001 --read-only --restart unless-stopped --pull never`, лейблы `panel.server_id`/`panel.kind=squadjs2`, монтирования логов `:ro` и `{root}/{id}/config.json:/app/panel-config.json:ro`, **без** sock-тома; env-allowlist ровно `{SERVER_ID, LOG_FILE}` (валидация как у RNSquadJS: неизвестные ключи, `=`, NUL/CR/LF — отказ); `Lstat`-guard конфига; `validate.SidecarDirPath` принимает ровно `/run/squad-panel/{rnsquadjs,squadjs2}/{uuid}` и отвергает всё вне; `directory_delete` пропускает эти пути.
- [x] **Step 2 (green):** Реализация: `PanelSquadJS2Root = "/run/squad-panel/squadjs2"`, `ensureSidecarDir` для нового корня (0750 root, без sock-поддира), `RunSquadJS2`, диспетч `container_run_squadjs2` (params `{server_id, env}` → `{container_id, status}`), расширение `directory_delete`. tmpfiles: `d /run/squad-panel/squadjs2 0755 root root -`.
- [x] **Step 3:** `go vet ./... && go test -race -count=1 ./...` (Linux). **Commit** `feat(bridge): запуск сайдкара SquadJS2 и удаление сайдкар-каталогов`.

### Task 12: shared-config + bridge-client

**Files:** `packages/shared-config/src/{bridge-methods,sidecar}.ts` + тесты, `packages/bridge-client/src/{types,client}.ts` + тесты.

- [x] **Step 1 (red):** Тесты: `BRIDGE_METHODS` содержит `container_run_squadjs2`; `sidecar.ts` экспортирует `SQUADJS2_ENGINE_SET = 'squadjs2:engine-servers'`, `sidecarStatusKey(id, mode)`, `sidecarHeartbeatKey(id)` и `isSquadjs2Server(redis, id)` (SISMEMBER); bridge-client — `containerRunSquadjs2` c таймаутом 60 с и типами `ContainerRunSquadjs2Params/Result`.
- [x] **Step 2 (green):** Реализация. **Commit** `feat(shared): метод и ключи сайдкара SquadJS2`.

### Task 13: `apps/api/src/lib/squadjs2.ts` — конфиг и relaunch

**Files:** `apps/api/src/lib/squadjs2.ts`, `apps/api/test/lib/squadjs2.test.ts`.

- [x] **Step 1 (red):** Тесты: `renderSquadjs2Config` собирает JSON из §3.5 спеки — `queryPort` из `server_settings` (NOT NULL), `rconPort` из `serverCredentials`, пароль — regex `Password=` из `Rcon.cfg` через `bridge.fileRead` (переиспользовать существующий парсер из `lib/rnsquadjs.ts`, вынести в общий модуль — без дублирования); `plugins` — ровно один `PanelBridge` с `mode`/`redisUrl` (`SIDECAR_REDIS_URL` → фолбэк `RNSQUADJS_REDIS_URL` → `redis://127.0.0.1:6379`)/`serverId`; `writeSquadjs2Config` — атомарная запись 0600 + chown 1001 в `/run/squad-panel/squadjs2/{id}/config.json`; `buildSquadjs2Env` — ровно `{SERVER_ID, LOG_FILE}`; `relaunchSquadjs2Sidecar` — конфиг → режим по `SISMEMBER rnsquadjs:cutover-servers` → `containerRm` (проглатывается) → `containerRunSquadjs2`.
- [x] **Step 2 (green):** Реализация по образцу `lib/rnsquadjs.ts`. `.env.example` + `docs/operations/environment-variables.md`: `SIDECAR_REDIS_URL`.
- [x] **Step 3: Commit** `feat(api): генератор конфига и relaunch сайдкара SquadJS2`.

### Task 14: Маршрут `GET/POST /api/v1/servers/:id/sidecar`

**Files:** `apps/api/src/routes/server-sidecar.ts`, `apps/api/src/routes/index.ts`, `apps/api/test/server-sidecar.test.ts`, `apps/api/test/integration/server-sidecar.test.ts`.

- [x] **Step 1 (red):** Тесты:
  - `GET` (perm `server:view`): `{server_id, engine, mode, cutover, status}`; `engine` по `SQUADJS2_ENGINE_SET`; статус — dual-read (`sidecar:status:*`, фолбэк `rnsquadjs:status:*`); режим — cutover ⇒ `production`, иначе живой `:shadow`-ключ ⇒ `shadow`, иначе `legacy`.
  - `POST {engine, mode}` (perm `server:stop`, аудит `server.sidecar.switch`): смена движка правит engine-set, гасит контейнер старого движка, зовёт `directory_delete` старого каталога (устранение утечки plaintext-пароля), рендерит конфиг, запускает новый; `mode: 'production'` секвенируется как текущий cutover-POST (`SADD` → 202 → `CUTOVER_TICK_MS` → повторный `SISMEMBER` → запуск; `SREM` при провале); `mode: 'shadow'` для сервера в production — сначала запуск shadow-замены, `SREM` в `finally`. Существующий `GET/POST /servers/:id/rnsquadjs` продолжает работать (регресс-тест не меняется).
- [x] **Step 2 (green):** Реализация; регистрация в `registerRoutes()` (parity-тест регистрации уронит сборку, если забыть). **Инвариант одного писателя:** после любого `POST /sidecar` у сервера остаётся ровно один сайдкар-контейнер — обработчик всегда гасит контейнеры *обоих* движков перед запуском целевого (для same-engine это прежний `containerRm`-relaunch), чтобы на `:shadow`-стриме никогда не оказалось двух писателей. Тест на это обязателен. Транзишен-lock не добавляется (наследуемый пробел, issue — Task 20).
- [x] **Step 3:** Изолированная БД: `eval "$(bash scripts/new-test-db.sh sidecar)"`; мутации в тестах скоупить по `steamId64` (гайд AGENTS.md) + прогнать `test-isolation.regression.test.ts`. **Commit** `feat(api): engine-neutral маршрут сайдкара с переключением движка`.

### Task 15: Жизненный цикл — install/start/stop/restart/delete

**Files:** `apps/api/src/routes/{server-install,servers}.ts`, `apps/api/src/lib/server-delete.ts` + их тесты.

- [x] **Step 1 (red):** Тесты: install и start/restart зовут `relaunchSquadjs2Sidecar` для сервера в engine-set и `relaunchSidecar` (RNSquadJS) — вне его; stop — `containerStop` **обоих** имён (`rnsquadjs-{id}`, `squadjs2-{id}`, нефатально); delete — `containerRm` обоих + `directory_delete` обоих сайдкар-каталогов.
- [x] **Step 2 (green):** Реализация (диспетчер движка — по `isSquadjs2Server`). Ошибки сайдкара при install остаются нефатальными (emit в progress-стрим).
- [x] **Step 3: Commit** `feat(api): engine-aware жизненный цикл сайдкара`.

### Task 16: Веб — engine-neutral секция настроек

**Files:** `apps/web/src/app/(dashboard)/servers/[id]/settings/{page.tsx,helpers.ts}`, тесты `page.rnsquadjs.test.tsx` → `page.sidecar.test.tsx`, `helpers.test.ts`.

- [x] **Step 1 (red):** Тесты: секция «Интеграция SquadJS» читает `GET …/sidecar`; бейдж движка («SquadJS2» / «RNSquadJS (legacy)»); прежние лейблы режима («Продакшен»/«Теневой режим»/«Штатный парсер») и статус-pill сохраняются; self-hide на 403 — как раньше.
- [x] **Step 2 (green):** `helpers.ts`: типы `SidecarEngine`, `SidecarIntegration` (расширение прежних); переключатель в UI **не** добавляется (операции — через API/runbook, как у cutover сейчас).
- [x] **Step 3: Commit** `feat(web): engine-neutral секция интеграции SquadJS`.

### Task 17: Интеграционный harness + e2e

**Files:** `apps/api/test/integration/harness.ts`, `apps/api/test/e2e/install-lifecycle.e2e.test.ts`.

- [x] **Step 1:** Фейк `containerRunSquadjs2` в harness (запись вызовов, как у `containerRunRnsquadjs`).
- [x] **Step 2 (red→green):** e2e: сервер в engine-set проходит install → start → stop → delete со SquadJS2-сайдкаром (вызовы фейка, конфиг на диске, зачистка каталога при delete); сервер вне engine-set — прежний RNSquadJS-путь (регресс).
- [x] **Step 3:** Полный локальный гейт: `pnpm turbo run typecheck && pnpm exec biome check . && pnpm test:cov`. **Commit** `test(api): e2e жизненного цикла SquadJS2-сайдкара`.

### Task 18: shadow-diff — посчётный гейт `name_changed`

**Files:** `scripts/rnsquadjs-shadow-diff.mjs`, `scripts/rnsquadjs-shadow-diff.test.ts`.

- [x] **Step 1 (red):** Тесты: `player.name_changed` исключается из попарного ±5 с матчинга (событие производится поллингом — каденс превышает окно); вместо этого — посчётная проверка за окно наблюдения: `|count_prod − count_shadow| ≤ max(2, 10 %)` — иначе гейт `name-changed-count-mismatch`; отсутствие типа в shadow при наличии в prod остаётся провалом; прочие `SIDE_TYPES` — без изменений; контрактные exit-коды и гейты (`input-limit-exceeded` и др.) не меняются.
- [x] **Step 2 (green):** Реализация; `pnpm test:scripts` зелёный.
- [x] **Step 3: Commit** `feat(scripts): посчётный parity-гейт для player.name_changed`.

---

## Фазы 3–5 — выкат (операторский runbook)

### Task 19: Runbook и прогон канарейки

**Files:** `docs/operations/squadjs2-rollout.md` (создать).

- [x] **Step 1:** Написать runbook по §6 спеки — матрица состояний, команды на каждый переход (`POST /sidecar`), какой контейнер/стрим проверять, критерии гейтов, строка отката для каждой фазы. Выбор канарейки — правило из §9 спеки: `servers.is_canary = true` → иначе сервер в rnsquadjs-shadow → иначе наименьший онлайн за 7 дней; соак 24 ч, батч 5 — зафиксировано там же:
  - Фаза 3 (канарейка, shadow): `POST /sidecar {engine:'squadjs2', mode:'shadow'}` — для rnsquadjs-shadow-сервера это **замена** shadow-писателя: старый rnsquadjs-shadow-сайдкар обязан быть остановлен тем же POST-ом до запуска squadjs2 (инвариант одного писателя из Task 14 — проверить `docker ps` после перехода: ровно один `squadjs2-{id}`); для rnsquadjs-production — squadjs2-shadow работает рядом (разные стримы); соак 24 ч; `node scripts/rnsquadjs-shadow-diff.mjs <uuid>` — parity ≥ 99 %, ноль missing types, посчётный гейт `name_changed` зелёный.
  - Фаза 4 (канарейка, production): `POST /sidecar {engine:'squadjs2', mode:'production'}`; проверки: heartbeat `worker:heartbeat:sidecar:{id}` стабилен, `XLEN events:server:{id}` растёт, banned-name-on-rename срабатывает (ручной тест переименования), `worker-discord`/`worker-automation` без деградации; соак 24 ч. Откат: `POST /sidecar {engine:'rnsquadjs', mode:'production'}`.
  - Фаза 5 (флот): батчи по 5, каждый — shadow-соак → cutover → 24 ч зелёные.
- [ ] **Step 2:** Прогнать канарейку по runbook, вписать фактические результаты (id прогонов, выводы diff-скрипта) в runbook-журнал.
- [x] **Step 3: Commit** `docs(operations): runbook выката SquadJS2`.

---

## Фаза 6 — очистка

### Task 20: Удаление RNSquadJS-контура и финализация

Выполняется **только** после того, как весь флот прожил ≥ 7 дней на SquadJS2 без откатов.

**Files:** раздел «Удаляются» выше + доки.

- [ ] **Step 1:** Снять фолбэк-чтение `rnsquadjs:status:*` в `/sidecar`-GET; судьба алиасов `/servers/:id/rnsquadjs` — по правилу §9 спеки: нет обращений в аудите/логах API за 14 дней — удалить, есть — 410-заглушка с указанием замены на один релизный цикл.
- [ ] **Step 2:** Удалить файлы и цепочки из раздела «Удаляются»; `pnpm-workspace.yaml`, `test:cov`-фильтр, compose-файлы, `ci.yml` — синхронно. `bash scripts/test-cov-complete.sh` зелёный.
- [ ] **Step 3:** Веб: удалить мёртвую карточку «RNSquadJS» из `DossierSkillTab` + `RNSQUADJS_UNAVAILABLE` (+ тесты).
- [ ] **Step 4:** Доки: ADR-дополнение в `decisions.md` (движок сайдкара — SquadJS2; ключи `sidecar:*`; RNSquadJS удалён); `map.md`, `api.md`, `data-model.md`, `testing.md`; пометить `ai_docs/rnsquadjs-migration-pin-2026-04-24.md` как superseded (ссылка на новый пин-документ).
- [ ] **Step 5:** Завести GitHub-issues на отложенное (ссылки — в ADR): (1) `chat.message` вне производственного набора — cutover-серверы без панельных чат-команд (существующее поведение, унаследовано); (2) переименование `rnsquadjs:cutover-servers` в engine-neutral (живое prod-состояние, требует миграции набора); (3) пер-серверный transition-lock на `/sidecar`-POST; (4) автоматизация сборки сайдкар-образа в `deploy-tk104.yml`.
- [ ] **Step 6:** Полный гейт + e2e; merge в `dev`; CI зелёный; `bash scripts/verify-done.sh`.
