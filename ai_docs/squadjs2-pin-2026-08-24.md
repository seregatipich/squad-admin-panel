# SquadJS2 base image pin — миграция сайдкара

**Образ:** `ghcr.io/breaking-squad/squadjs` (приватный пакет GHCR)
**Пин digest:** `sha256:8982c90899212c23a1042033bd762a7e3defcd7d9888712cea89b0554a46c48a`
**Commit:** `258440d0fbc14a4a63e679c82f0f12e6bb987c81` (`master`, «fix: stop currency accrual after storage failure (#262)»)
**Verified-release run:** [`34089071382`](https://github.com/breaking-squad/squadjs2/actions/runs/34089071382), джоба `docker` — success, 2026-09-07
**Зафиксирован в:** `docker/squadjs2.Dockerfile` (`ARG SQUADJS2_DIGEST`)

Дизайн: [`docs/superpowers/specs/2026-08-24-squadjs2-migration-design.md`](../docs/superpowers/specs/2026-08-24-squadjs2-migration-design.md).
План: [`docs/superpowers/plans/2026-08-24-squadjs2-migration.md`](../docs/superpowers/plans/2026-08-24-squadjs2-migration.md).

§9 дизайна называл стартовым пином digest `sha256:7cfc1535…` (commit `d6c0e698`, run 32641097402 от 2026-08-23) и разрешал взять более свежий verified-выпуск на момент исполнения. Взят более свежий: `258440d0` — последний коммит `master` с успешной джобой `docker` (то есть прошедший проверку build identity по digest). Digest снят из лога джобы:

```bash
gh run list --repo breaking-squad/squadjs2 --workflow build-docker-image.yml --branch master --limit 5 \
  --json databaseId,conclusion,headSha,createdAt
gh api /repos/breaking-squad/squadjs2/actions/jobs/101639765535/logs | grep -E 'Digest:|SQUADJS_IMAGE_DIGEST'
#   Digest: sha256:8982c90899212c23a1042033bd762a7e3defcd7d9888712cea89b0554a46c48a
```

## Факты о пине (сняты с исходников на `258440d0`, не с образа)

| Факт | Значение | Источник |
|---|---|---|
| База | `node:20-alpine3.22`, рабочий пользователь `node` (uid/gid 1000), WORKDIR `/app` | `Dockerfile` |
| Build identity | `/usr/share/squadjs/build-identity.json`, режим `0444`, поля `commitSha`/`workflowRunId`/`workflowRunAttempt` | `Dockerfile` |
| Путь конфига | `node index.js <path>` — `argv[2]`; `readConfigFile` делает `path.resolve(__dirname, '../', configPath)`, абсолютный путь принимается как есть | `index.js:26`, `squad-server/factory.js` |
| Автообнаружение плагинов | импортируется каждый **файл** `*.js` в `squad-server/plugins/` (кроме `index.js`, `base-plugin.js`, `discord-base-*.js`); подкаталоги игнорируются; ключ конфига — имя класса дефолтного экспорта | `squad-server/plugins/index.js` |
| Коннекторы | создаются лениво и только для опций плагинов с `connector`; `connectors: {}` при единственном `PanelBridge` не поднимает ни mongoose, ни sequelize, ни discord | `squad-server/factory.js:46-95` |
| Обязательные поля конфига | `logger.verboseness` **и** `logger.colors` читаются через `Object.entries` — отсутствие любого из них роняет старт `TypeError`; `logger.timestamps` опционально | `squad-server/factory.js:26-40` |
| Родной entrypoint | `envsubst < config/$INSTANCE_NAME.json > config.json` — при `--read-only` и панельном конфиге неприменим, заменяется своим | `docker-entrypoint.sh` |
| `VOLUME` | объявлен `/app/data` | `Dockerfile` |

## Формы событий (важные отличия от RNSquadJS)

Панельный маппер читает сырые поля SquadJS2, а не RNSquadJS. Отличия, снятые с
`squad-server/index.js` на пине (и закреплённые golden-фикстурой
`docker/squadjs2/plugins/panel-bridge/test/fixtures/`):

- `PLAYER_CONNECTED` / `PLAYER_DISCONNECTED` — верхнеуровневые `steamID`/`eosID`
  (`core/id-parser.js: playerIdNames`) **удаляются** перед `emit`; идентификаторы
  доступны только через разрешённый объект `data.player`, который может быть
  `null`, если игрока ещё нет в списке RCON.
- `PLAYER_DAMAGED` / `PLAYER_WOUNDED` / `PLAYER_DIED` — `data.victim` и
  `data.attacker` — объекты игроков; `victimName`/`attackerName` удаляются.
- `PLAYER_REVIVED` — оживлённый лежит в `data.victim` (в RNSquadJS-контракте
  поле envelope называется `revived`), реаниматор — `data.reviver`.
- `SQUAD_CREATED` — `data.player` (объект, с проставленным `squadID`), ключи
  `player*ID` и `playerName` удаляются; `squadID`/`squadName`/`teamName` остаются.
- `DEPLOYABLE_DAMAGED` — исполнитель в `data.player` (`playerSuffix` удаляется);
  верхнеуровневого `attacker` нет.
- `UPDATED_PLAYER_INFORMATION` эмитится **без payload** — снимок игроков читается
  из `server.players`.

## Стоп-фактор пина: `PLAYER_DISCONNECTED` не срабатывает

Отслеживается в [#307](https://github.com/breaking-squad/squad-admin-panel/issues/307).

`squad-server/log-parser/player-disconnected.js` на пине требует в строке
`UChannel::Close: Sending CloseBunch` подстроки
`Name: EOSIpNetConnection_<N>, Driver: GameNetDriver EOSNetDriver_<N>`.
Боевой Squad пишет
`Name: RedpointEOSIpNetConnection_<N>, Driver: Name:GameNetDriver Def:GameNetDriver RedpointEOSNetDriver_<N>`.

Замер на игровом хосте (2026-09-08, все шесть серверов):

```
grep -c "Name: EOSIpNetConnection_"          /opt/squad*/SquadGame/Saved/Logs/SquadGame.log  →  0 0 0 0 0 0
grep -c "Name: RedpointEOSIpNetConnection_"  /opt/squad*/SquadGame/Saved/Logs/SquadGame.log  →  120 0 0 0 0 0
```

Других источников `PLAYER_DISCONNECTED` в SquadJS2 нет (единственный `emit` —
в этом правиле). История правила: PR #376 расширял регэксп, PR #378 его
откатил.

Последствия:

- `player.disconnected` — один из пяти производственных типов, поэтому
  **production-переключение на этом пине запрещено**: cutover-сервер молча
  перестанет получать события выхода игроков.
- Shadow-соак безопасен и полезен: parity-гейт
  (`scripts/rnsquadjs-shadow-diff.mjs`) увидит тип в prod и не увидит в shadow
  и выдаст `parity-failed` с `missingTypes: ["player.disconnected"]`.
- Разблокировка: исправить правило в `breaking-squad/squadjs2`, дождаться
  verified-выпуска, поднять `ARG SQUADJS2_DIGEST`, перепроверить golden-фикстуру
  (`docker/squadjs2/plugins/panel-bridge/test/fixtures/SquadGame.log` содержит
  обе формы строки — текущую боевую и ту, которую правило принимает).

## Ещё один факт о контуре RNSquadJS (обнаружен при снятии фикстуры)

Прежняя «parity-фикстура» `docker/rnsquadjs/plugins/panelBridge/test/fixtures/SquadGame.log.parsed.json`
состоит из 4964 строк простоя (EOS/ODK/ICMP-шум) и **не содержит ни одного
игрового события**, поэтому ничего в маппинге событий не проверяла. Фикстура
SquadJS2 собрана заново из реальных форматов строк боевых логов с
обезличенными идентификаторами.

Прогон боевого контура RNSquadJS (`squad-logs` на пине `d76fb4a8` + shipped
`eventMap.ts`) по той же фикстуре показал, насколько беднее его payload'ы:
`player.connected` без `name`, `player.revived` пустой, `player.disconnected`
без `steam_id64`, `squad.created` без `player`/`team`. SquadJS2 разрешает
игроков до emit, поэтому эти поля заполняются — контракт типов и ключей тот же,
значения полнее.

## Как пересобрать golden-фикстуру при бампе

Фикстура снята прогоном реального кода обоих движков по
`docker/squadjs2/plugins/panel-bridge/test/fixtures/SquadGame.log` (строки —
форматы боевых логов с обезличенными идентификаторами). Docker для этого не
нужен, обе стороны — обычные Node-проекты:

1. **SquadJS2-сырьё.** Склонировать `breaking-squad/squadjs2`, `git checkout <новый пин>`,
   `corepack yarn install --ignore-engines`. Скриптом в корне клона: создать
   `new SquadServer({id:1, host:'127.0.0.1', queryPort, rconPort, rconPassword,
   logReaderMode:'tail', logDir:<каталог фикстуры>, adminLists:[]})`, подменить
   `getPlayerByEOSID/getPlayerByName/getPlayerByNameSuffix/getPlayerByController/
   getSquadByID/updateAdmins` и `Layers.getLayerByClassname` на стабы с двумя
   синтетическими игроками, подписаться на 17 событий + `UPDATED_PLAYER_INFORMATION`,
   скормить строки через `server.logParser.processLine(line)` и RCON-пакеты из
   `fixtures/rcon-packets.json` через `server.rcon.processChatPacket({body})`.
   Результат → `fixtures/squadjs2-events.json`.
2. **Эталон RNSquadJS.** `npm i github:lACTEPUKCl/squad-logs` (форк форвардит
   события `squad-logs` на `state.listener` без изменений), прогнать те же
   строки через `parseLine(line, emitter)` и подать в
   `docker/rnsquadjs/plugins/panelBridge/src/eventMap.ts`.
   Результат → `fixtures/rnsquadjs-envelopes.json`.
3. **Ожидания.** `fixtures/expected-envelopes.json` — контракт из `eventMap.ts`,
   применённый к сырью SquadJS2; правится вручную при осознанном изменении
   контракта.

## Чек-лист совместимости при бампе digest

Выполнять целиком при каждом изменении `ARG SQUADJS2_DIGEST`:

1. **События и поля log-parser'а** — diff `squad-server/index.js` и
   `squad-server/log-parser/` между старым и новым коммитом: не переименованы ли
   события, не удалены ли поля перед `emit`. Прогнать
   `pnpm --filter squadjs2-panel-bridge test` (golden-фикстура ловит смену форм).
2. **RCON** — изменения в `squad-server/rcon.js` (формат `ListPlayers`, события
   `CHAT_MESSAGE`, `SQUAD_CREATED`, `RCON_ERROR`): панель полагается на
   `RCON_ERROR` для статуса и на `server.players` для деривации `name_changed`.
3. **Формат конфига** — обязательные ключи (`logger.colors`!), схема `server`,
   `connectors`, `plugins`; проверить, что пустой `connectors` по-прежнему не
   поднимает внешних клиентов.
4. **Автообнаружение плагинов** — не изменился ли список исключений и правило
   «только файлы верхнего уровня» в `squad-server/plugins/index.js`
   (панельные модули лежат в подкаталоге `panel-bridge/` именно поэтому).
5. **Node** — база остаётся Node 20+; `ioredis`/`uuid`, доставляемые в
   производный образ, должны ставиться той же версией, что в `package.json`
   пакета `squadjs2-panel-bridge`.
6. **`base-plugin.js`** — контракт `constructor(server, options, connectors)`,
   `prepareToMount`/`mount`/`unmount`, обязательные статические геттеры
   `description`/`defaultEnabled`/`optionsSpecification`, семантика
   `required` (падение, если значение равно `default`).
7. **Boot-тест** — повторить прогон из раздела ниже.

## Boot-тест пина (Task 2 плана) — выполнен частично (из исходников)

Часть утверждений проверена прогоном **реального кода пина** без Docker
(клон `breaking-squad/squadjs2` на `258440d0`, `corepack yarn install --ignore-engines`),
2026-09-08:

| Проверка | Результат |
|---|---|
| Автообнаружение находит плагин в раскладке образа (`squad-server/plugins/panel-bridge.js` + подкаталог `panel-bridge/`) | `Plugins.getPlugins()` → `PanelBridge discovered: true`, всего 48 плагинов |
| `ioredis`/`uuid` резолвятся из `squad-server/plugins/node_modules`, не из `/app/node_modules` | импорт плагина в скопированной раскладке проходит; `mount()`/`unmount()` отрабатывают, слушателей после `unmount` — 0 |
| Генерируемый конфиг принимается фабрикой | `SquadServerFactory.buildFromConfig(<конфиг из lib/squadjs2.ts>)` → `plugins: PanelBridge`, `connectors: []` |
| Пустые коннекторы не поднимают mongoose/sequelize/discord | тот же прогон: список коннекторов пуст |
| `logger.colors` обязателен | без ключа фабрика падает на `Object.entries(undefined)` — поэтому рендерер всегда его пишет |

**Остаётся непроверенным (нужен Docker и доступ к GHCR):**

- старт под uid 1001 поверх файлов образа с владельцем 1000;
- поведение `VOLUME /app/data` при `--read-only` (нужен ли `--tmpfs /app/data`);
- отсутствие слушающих портов в неймспейсе хоста (`ss -tlnp`);
- реакция на недоступный RCON — ретраи, а не crash-loop;
- сборка производного образа целиком (`docker/squadjs2.Dockerfile`).

**Статус контейнерной части: заблокирован.** Требует `docker pull` приватного пакета
`ghcr.io/breaking-squad/squadjs`. На момент реализации:

- у панельного репозитория нет доступа к пакету, секрет `GHCR_PULL_TOKEN` не заведён;
- на хосте tk104 нет `docker login ghcr.io`
  (`docker manifest inspect ghcr.io/breaking-squad/squadjs:master` → `unauthorized`);
- локальная машина разработчика без запущенного демона Docker.

Что должен зафиксировать boot-тест, когда доступ появится (команда — §3.1 дизайна
и Task 2 плана):

```bash
docker run --rm --read-only --network host --user 1001:1001 \
  -v "$PWD/logs:/squad/Logs:ro" -v "$PWD/panel-config.json:/app/panel-config.json:ro" \
  --entrypoint node \
  ghcr.io/breaking-squad/squadjs@sha256:8982c90899212c23a1042033bd762a7e3defcd7d9888712cea89b0554a46c48a \
  index.js /app/panel-config.json
```

- чистый старт под uid 1001 поверх файлов образа с владельцем 1000;
- mongoose/sequelize/discord не поднимаются при `connectors: {}`;
- поведение `VOLUME /app/data` при `--read-only` (нужен ли `--tmpfs /app/data`);
- отсутствие слушающих портов (`ss -tlnp` в неймспейсе хоста);
- реакция на недоступный RCON — ретраи, а не crash-loop.

Любой провал — стоп-фактор Фазы 1: решение согласуется с оператором.
