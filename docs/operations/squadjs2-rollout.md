# Миграция сайдкара на SquadJS2 — полный порядок работ

Единственный источник правды по выкату. Дизайн: [`../superpowers/specs/2026-08-24-squadjs2-migration-design.md`](../superpowers/specs/2026-08-24-squadjs2-migration-design.md).
План реализации (фазы 0–2, уже выполнены): [`../superpowers/plans/2026-08-24-squadjs2-migration.md`](../superpowers/plans/2026-08-24-squadjs2-migration.md).
Пин образа и чек-лист бампа: [`../../ai_docs/squadjs2-pin-2026-08-24.md`](../../ai_docs/squadjs2-pin-2026-08-24.md).
Трекинг: эпик [#308](https://github.com/breaking-squad/squad-admin-panel/issues/308) — по одному issue на фазу, номера проставлены в заголовках фаз ниже.

---

## §1. Состояние на 2026-09-08

### 1.1. Что уже сделано (код)

| Что | Где | Доказательство |
|---|---|---|
| Плагин `PanelBridge` (маппер 17 типов, деривация `player.name_changed`, паблишер, heartbeat) | `docker/squadjs2/plugins/panel-bridge/` | `pnpm --filter squadjs2-panel-bridge test` → 77/77 |
| Производный образ + entrypoint | `docker/squadjs2.Dockerfile`, `docker/squadjs2/entrypoint.sh` | контрактный тест `test/image-contract.test.js` |
| Бридж: RPC `container_run_squadjs2`, валидаторы, зачистка сайдкар-каталогов | `apps/bridge/internal/{validate,runner,handlers}` | `go vet ./... && go test -race -count=1 ./...` — зелёные |
| Ключи и хелперы движка | `packages/shared-config/src/sidecar.ts` | `packages/shared-config/test/sidecar.test.ts` |
| Генератор конфига и relaunch | `apps/api/src/lib/squadjs2.ts` | `apps/api/test/lib/squadjs2.test.ts` — 17 тестов |
| Маршрут `GET/POST /api/v1/servers/:id/sidecar` | `apps/api/src/routes/server-sidecar.ts` | 22 unit + 13 интеграционных теста |
| Engine-aware жизненный цикл (install/start/stop/restart/delete) | `apps/api/src/lib/sidecar-lifecycle.ts` | `apps/api/test/sidecar-lifecycle.test.ts` |
| Engine-neutral секция настроек | `apps/web/.../settings/` | `page.sidecar.test.tsx`, `helpers.test.ts` |
| Посчётный parity-гейт `player.name_changed` | `scripts/rnsquadjs-shadow-diff.mjs` | `pnpm test:scripts` → 91/91 |
| Слито в `dev`, CI зелёный | `6ecbef01` | run [34207959716](https://github.com/breaking-squad/squad-admin-panel/actions/runs/34207959716): go/branch-guard/node/docker — success; `scripts/verify-done.sh` → PASSED |

### 1.2. Что НЕ сделано и почему

| Что | Причина | Разблокирует |
|---|---|---|
| Образ `squad-panel/squadjs2:latest` не собран | нет доступа к приватному пакету `ghcr.io/breaking-squad/squadjs` | §4 P0.1 |
| Контейнерный boot-тест пина не выполнен | нет образа | §6 P2.4 |
| Шаги сборки образа в `ci.yml` под `if: false` | нет доступа к GHCR у раннера | §4 P0.5 |
| `PLAYER_DISCONNECTED` не эмитится на пине | дефект правила в апстриме; PR [breaking-squad/squadjs2#264](https://github.com/breaking-squad/squadjs2/pull/264) открыт и зелёный, но не смёржен | §4 P0.2–P0.4 |
| Ни один сервер не переключён | `squadjs2:engine-servers` пусто — так и задумано до выката | §7 P3 |

### 1.3. Фактическое состояние прод-контура tk104 (снято 2026-09-08)

```
servers (deleted_at is null):
  01a014ad-18e1-71e1-b3f8-1011131ce414  «мой конченый кастом»                  runtime=container  status=running  is_canary=f
  01a07b4c-b2d8-742a-9135-236515f86f46  «[RU] МирДружбаЖвачка ★ BSS ★ [МИКС]»  runtime=external   status=running  is_canary=f

redis: SMEMBERS rnsquadjs:cutover-servers    → пусто
redis: SMEMBERS squadjs2:engine-servers      → пусто
docker images | grep squad-panel/            → ни rnsquadjs, ни squadjs2
docker ps -a  | grep -E "rnsquadjs|squadjs2" → контейнеров нет
/run/squad-panel/                            → есть только rnsquadjs/, каталога squadjs2/ нет
/usr/local/bin/panel-host-bridge             → сборка от 2026-07-06, container_run_squadjs2 отсутствует
```

Три следствия, которые меняют исходный план:

1. **Сайдкара в проде сейчас нет вообще** — ни контейнера, ни образа. Значит переход `legacy → squadjs2-shadow` идёт с чистого листа: останавливать нечего, «замена shadow-писателя» из §6 дизайна не понадобится.
2. **Кандидат ровно один.** Внешний сервер (`runtime=external`) сайдкар принять не может: `containerOnlyPreHandler` отвечает `409 external_server` до любого вызова бриджа. Остаётся `01a014ad-…`. Правило выбора канарейки из §9 дизайна (`is_canary` → сервер в rnsquadjs-shadow → наименьший онлайн) разрешается вырожденно — выбирать не из чего.
3. **Фаза «флот батчами по 5» пуста.** Второго контейнерного сервера нет; §9 остаётся заготовкой на будущее.

---

## §2. Как читать шаги

Каждый шаг оформлен одинаково:

- **Зачем** — причина существования шага и что он даёт следующему.
- **Кто** — `О` оператор (нужен sudo / доступ к GHCR / право мёржа), `А` агент (может выполнить сам).
- **Команда** — точная, без «примерно так».
- **Ожидаемо** — как выглядит успех.
- **Если не так** — первое действие при отклонении.
- **Пропуск ломает** — что именно откажет ниже по цепочке, если шаг не сделать.

Шаги внутри фазы выполняются строго по порядку. Фазы не пересекаются: следующая начинается только после гейта предыдущей (§13).

---

## §3. Цепочка зависимостей

```
P0.1 доступ к GHCR ───────────────┬─→ P2.1 сборка образа ─→ P2.4 boot-тест ─→ P3 shadow-соак ─┐
                                  │                                                           │
P0.2 мёрж squadjs2#264 ─→ P0.3 verified-выпуск ─→ P0.4 бамп digest ─────────┘                 │
                                                                                              ▼
P1.1 промоушен dev→master ─→ P1.2 деплой api/web ─┐                                     P4 production
P1.3 пересборка бриджа ─→ P1.4 tmpfiles ──────────┴─→ запуск сайдкара вообще возможен         │
                                                                                              ▼
                                                                                     P6 очистка RNSquadJS
```

Читается так: **без P0.1 нет образа; без образа невозможны ни boot-тест, ни shadow. Без P0.4 нельзя в production, потому что на старом digest теряются выходы игроков. Без P1.3/P1.4 бридж физически не умеет запустить сайдкар, даже если образ есть.**

---

## §4. Фаза P0 — снять внешние блокеры

> Issue: #309 · #310 · #311 · #312

### P0.1. Выдать доступ к пакету GHCR

- **Зачем.** `docker/squadjs2.Dockerfile` начинается с `FROM ghcr.io/breaking-squad/squadjs@sha256:…`. Пакет приватный: без доступа `docker build` падает на первом слое, а бридж запускает сайдкар с `--pull never`, то есть отсутствующий локально тег даёт мгновенный отказ запуска.
- **Кто.** `О` — нужен админ пакета.
- **Команда.** В GitHub: пакет `breaking-squad/squadjs` → Package settings → Manage Actions access → добавить репозиторий `squad-admin-panel` с ролью `Read`. Альтернатива: org-PAT с `read:packages` в секрете репозитория `GHCR_PULL_TOKEN`. Затем на tk104 и на раннере:
  ```bash
  echo "$GHCR_TOKEN" | docker login ghcr.io -u <username> --password-stdin
  ```
- **Ожидаемо.**
  ```bash
  docker manifest inspect ghcr.io/breaking-squad/squadjs:master | head -3   # manifest, а не unauthorized
  ```
- **Если не так.** `unauthorized` значит, доступ выдан не тому субъекту: проверить, что логин выполняется аккаунтом/токеном с `read:packages`, который добавлен к пакету.
- **Пропуск ломает.** P2.1, P2.4, P0.5 и всю фазу P3 — то есть весь выкат.

### P0.2. Смёржить апстрим-фикс `squadjs2#264`

- **Зачем.** На пине `258440d0` правило `player-disconnected.js` ждёт `Name: EOSIpNetConnection_<N>, Driver: GameNetDriver EOSNetDriver_<N>`, а Squad пишет `Name: RedpointEOSIpNetConnection_<N>, Driver: Name:GameNetDriver Def:GameNetDriver RedpointEOSNetDriver_<N>`. Совпадений на боевых логах — ноль, значит `PLAYER_DISCONNECTED` не эмитится вовсе, а `player.disconnected` входит в производственный набор из пяти типов.
- **Кто.** `О` — пуш в `master` squadjs2 публикует production-образ, на котором живут standalone-инстансы `squad1/2/3/6`; это решение не автоматизируется.
- **Команда.**
  ```bash
  gh pr view 264 --repo breaking-squad/squadjs2 --json state,mergeable,statusCheckRollup
  gh pr merge 264 --repo breaking-squad/squadjs2 --merge
  ```
- **Ожидаемо.** `mergeable: MERGEABLE`, проверка `test` — `SUCCESS`; после мёржа `state: MERGED`.
- **Если не так.** Конфликт — перебазировать ветку `fix/player-disconnected-redpoint-netdriver` на свежий `master` и прогнать `yarn test:log-parser-health` (ожидается 20/20).
- **Пропуск ломает.** P4: production на старом правиле молча теряет выходы игроков — ломаются presence, coplay и подсчёт наигранного времени.

### P0.3. Дождаться verified-выпуска squadjs2

- **Зачем.** Панель пинует образ по digest, а не по тегу, и берёт только сборки, прошедшие конвейер verified-release (джоба `docker` в `build-docker-image.yml` проверяет build identity прогоном по digest).
- **Кто.** `А` (наблюдение) / `О` (если джоба упала).
- **Команда.**
  ```bash
  gh run list --repo breaking-squad/squadjs2 --workflow build-docker-image.yml --branch master --limit 3 \
    --json databaseId,conclusion,headSha,createdAt
  JID=$(gh api /repos/breaking-squad/squadjs2/actions/runs/<run-id>/jobs \
        --jq '.jobs[]|select(.name=="docker")|.id')
  gh api "/repos/breaking-squad/squadjs2/actions/jobs/$JID/logs" | grep -E 'Digest:|SQUADJS_IMAGE_DIGEST'
  ```
- **Ожидаемо.** Джоба `docker` — `success`, в логе строка `Digest: sha256:<64 hex>`. Это и есть новый пин.
- **Если не так.** Джоба `docker` — `skipped`: это был PR-прогон, а не пуш в `master`; дождаться пуш-прогона.
- **Пропуск ломает.** P0.4 — нечего пинить.

### P0.4. Поднять `ARG SQUADJS2_DIGEST` и пересобрать golden-фикстуру

- **Зачем.** Пин — единственное, что связывает панель с конкретной проверенной сборкой; фикстура — единственное, что ловит смену форм событий при бампе.
- **Кто.** `А`.
- **Команда.**
  ```bash
  git switch -c chore/squadjs2-digest-bump origin/dev
  # 1) заменить digest в docker/squadjs2.Dockerfile и в ai_docs/squadjs2-pin-2026-08-24.md
  # 2) пройти «Чек-лист совместимости при бампе» из пин-документа целиком
  # 3) пересобрать фикстуру по инструкции «Как пересобрать golden-фикстуру» там же
  pnpm --filter squadjs2-panel-bridge test
  ```
- **Ожидаемо.** Тесты пакета зелёные; в `squadjs2-events.json` появляется **второй** `PLAYER_DISCONNECTED` — от строки текущего формата (в фикстурном логе обе формы строки лежат специально для этой проверки).
- **Если не так.** Второй `PLAYER_DISCONNECTED` не появился — фикс не в этом digest; вернуться к P0.3.
- **Пропуск ломает.** P4 (см. P0.2) и достоверность контрактного теста образа: `image-contract.test.js` сверяет digest в Dockerfile с пин-документом.

### P0.5. Включить сборку образа в CI

- **Зачем.** Пока шаги под `if: false`, CI не проверяет, что образ вообще собирается: регресс в Dockerfile обнаружится только на хосте.
- **Кто.** `А` (правка) — после того как `О` закрыл P0.1 для раннера.
- **Команда.** В `.github/workflows/ci.yml` убрать `if: false` у шагов `log in to ghcr.io for the squadjs2 base image` и `build squadjs2 sidecar image`.
- **Ожидаемо.** Джоба `docker` собирает шесть образов; `scripts/test-ci-runner-strategy.sh` продолжает проходить (он уже ожидает именно шесть).
- **Если не так.** `unauthorized` в CI — доступ выдан пользователю, а не репозиторию; либо перейти на `GHCR_PULL_TOKEN`.
- **Пропуск ломает.** Немедленно ничего, но снимает страховку от регресса Dockerfile.

### P0.6. Гейт фазы P0

Все четыре условия одновременно:

1. `docker manifest inspect ghcr.io/breaking-squad/squadjs:master` работает на tk104;
2. PR squadjs2#264 в состоянии `MERGED`;
3. в `docker/squadjs2.Dockerfile` стоит digest verified-выпуска с фиксом, и он же записан в пин-документе;
4. `pnpm --filter squadjs2-panel-bridge test` зелёный на пересобранной фикстуре.

---

## §5. Фаза P1 — доставить код на tk104

> Issue: #313

### P1.1. Промоушен `dev` → `master`

- **Зачем.** Маршрут `/sidecar`, engine-aware жизненный цикл и генератор конфига живут в API. Пока прод крутит старый образ API, `POST /sidecar` вернёт 404 и переключать будет нечем.
- **Кто.** `О` (решение о релизе) / `А` (команда).
- **Команда.**
  ```bash
  git fetch origin
  bash scripts/verify-done.sh          # обязан выйти 0 ДО промоушена
  git push origin origin/dev:master
  ```
- **Ожидаемо.** `branch-guard` в CI на `master` зелёный (SHA достижим из `dev`); запускается `deploy-tk104`.
- **Если не так.** `branch-guard` красный — на `master` попал коммит не из `dev`; разбираться до деплоя, а не после.
- **Пропуск ломает.** P3.2 — переключать нечем.

### P1.2. Дождаться `deploy-tk104` и проверить ревизию

- **Зачем.** Деплой — единственное, что переносит новый API на хост; проверка ревизии отличает «выкатилось» от «выглядит выкаченным».
- **Кто.** `А`.
- **Команда.**
  ```bash
  gh run list --branch master --workflow deploy-tk104 --limit 1 --json databaseId,status,conclusion
  curl -sS https://<panel>/health | jq -r .revision      # 40-символьный SHA == тип master
  ```
- **Ожидаемо.** `conclusion: success`; `revision` совпадает с запушенным в `master`.
- **Если не так.** `revision` вида `dev-<sha>` — на хосте быстрый деплой из рабочего дерева (`scripts/dev-deploy-tk104.sh`); повторить релизный деплой.
- **Пропуск ломает.** То же, что P1.1.

### P1.3. Пересобрать и переустановить бридж

- **Зачем.** Бридж — отдельный systemd-сервис на хосте, он **не** обновляется деплоем приложения. Текущий бинарник от 2026-07-06 не содержит `container_run_squadjs2` (проверено: `strings … | grep -c container_run_squadjs2` → `0`), поэтому API получит от него ошибку «unknown method».
- **Кто.** `О` (root) — либо `А`, если разрешён `sudo` на tk104.
- **Команда.** На tk104, после того как P1.2 обновил `~/apps/squad-admin-panel`:
  ```bash
  cd ~/apps/squad-admin-panel/apps/bridge && make build
  sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/panel-host-bridge
  sudo systemctl daemon-reload
  sudo systemctl restart panel-host-bridge.socket panel-host-bridge.service
  ```
  На хосте Go 1.22.2, а `go.mod` требует 1.25.13 — сборка сама скачает нужный toolchain (`GOTOOLCHAIN=auto`). Если сети нет, собрать на рабочей машине и скопировать: бинарник статический (`CGO_ENABLED=0`, ELF x86-64).
- **Ожидаемо.**
  ```bash
  strings /usr/local/bin/panel-host-bridge | grep -c container_run_squadjs2   # 1
  sg panel -c 'bash scripts/verify-bridge.sh'                                 # проходит
  ```
- **Если не так.** `verify-bridge.sh` падает на сокете — `systemctl status panel-host-bridge.socket` и права `/run/panel-host-bridge`.
- **Пропуск ломает.** P3.2: `POST /sidecar` вернёт 5xx, в логах API — неизвестный метод бриджа.

### P1.4. Создать рантайм-каталог движка

- **Зачем.** `ensureSquadJS2Dir` открывает корень `/run/squad-panel/squadjs2` с `O_NOFOLLOW|O_DIRECTORY` и **не создаёт** его — корень заводит systemd-tmpfiles. Сейчас каталога на хосте нет.
- **Кто.** `О`/`А` (root).
- **Команда.**
  ```bash
  sudo install -m 0644 ~/apps/squad-admin-panel/apps/bridge/deploy/panel-host-bridge.tmpfiles.conf \
    /etc/tmpfiles.d/panel-host-bridge.conf
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/panel-host-bridge.conf
  ```
- **Ожидаемо.** `ls -ld /run/squad-panel/squadjs2` → `drwxr-xr-x root root`.
- **Если не так.** Каталог не появился — проверить, что в установленном конфиге есть строка `d /run/squad-panel/squadjs2 0755 root root -`.
- **Пропуск ломает.** P3.2: запуск упадёт на открытии корня (`open squadjs2 sidecar root: no such file or directory`).

### P1.5. Гейт фазы P1

`/health` отдаёт релизную ревизию с `master`; `strings` находит новый метод в бинарнике бриджа; `/run/squad-panel/squadjs2` существует.

---

## §6. Фаза P2 — образ и предполётные проверки

> Issue: #314

### P2.1. Собрать производный образ на tk104

- **Зачем.** Бридж запускает сайдкар с `--pull never`: тег обязан существовать локально на том хосте, где стартует контейнер.
- **Кто.** `О`/`А` на tk104.
- **Команда.**
  ```bash
  cd ~/apps/squad-admin-panel
  docker compose --env-file .env.tk104 -f compose.tk104.yml --profile images build squadjs2-image
  ```
- **Ожидаемо.** `docker images squad-panel/squadjs2:latest` показывает свежий образ.
- **Если не так.** Ошибка на `FROM` — вернуться к P0.1. Ошибка на слое `deps` (`npm install`) — у демона нет сети.
- **Пропуск ломает.** P3.2.

### P2.2. Проверить раскладку плагина внутри образа

- **Зачем.** SquadJS2 импортирует **каждый** `*.js` в `squad-server/plugins/`; лишний файл без дефолтного экспорта или подменённый `base-plugin.js` уронит загрузку всех плагинов, а не только нашего.
- **Кто.** `А`.
- **Команда.**
  ```bash
  docker run --rm --entrypoint sh squad-panel/squadjs2:latest -c \
    'ls /app/squad-server/plugins/panel-bridge.js /app/squad-server/plugins/panel-bridge/ \
     && ls /app/squad-server/plugins/node_modules | head \
     && node -e "import(\"/app/squad-server/plugins/panel-bridge.js\").then(m=>console.log(m.default.name))"'
  ```
- **Ожидаемо.** Файл и каталог на месте; в `node_modules` — `ioredis` и `uuid`; вывод `PanelBridge`.
- **Если не так.** `Cannot find package 'ioredis'` — слой `deps` скопирован не туда; сверить `COPY --from=deps` в Dockerfile.
- **Пропуск ломает.** Напрямую ничего, но экономит час разбирательств на P3.2.

### P2.3. Проверить, что образ не пишет в rootfs и не слушает порты

- **Зачем.** Сайдкар запускается `--read-only --network host`; плагин, открывший порт, столкнётся с соседом на том же хосте, а запись в rootfs уронит контейнер в рантайме, а не на старте.
- **Кто.** `А`.
- **Команда.** Собрать стендовый `panel-config.json` (по образцу `apps/api/src/lib/squadjs2.ts`: `connectors: {}`, единственный плагин `PanelBridge`, обязательный `logger.colors`) и:
  ```bash
  docker run --rm --read-only --network host --user 1001:1001 \
    -v "$PWD/logs:/squad/Logs:ro" -v "$PWD/panel-config.json:/app/panel-config.json:ro" \
    -e SERVER_ID=<uuid> squad-panel/squadjs2:latest
  ss -tlnp | grep -E ':32080'      # в другом терминале: пусто
  ```
- **Ожидаемо.** Контейнер стартует под uid 1001 поверх файлов, принадлежащих 1000; в логе нет попыток mongoose/sequelize; новых слушающих портов не появилось.
- **Если не так.** Падение на записи — добавить `--tmpfs /app/data` в `composeSquadJS2Args` (базовый образ объявляет `VOLUME /app/data`) и покрыть это Go-тестом.
- **Пропуск ломает.** P3.2 может «стартовать и умереть» без внятной причины.

### P2.4. Зафиксировать boot-тест в пин-документе

- **Зачем.** Пин-документ читают при следующем бампе; незаписанный результат равен невыполненному.
- **Кто.** `А`.
- **Команда.** Заполнить раздел «Boot-тест пина» фактическим выводом P2.2–P2.3: старт под uid 1001, поведение `VOLUME /app/data` при `--read-only`, отсутствие слушающих портов, реакция на недоступный RCON (ретраи, не crash-loop).
- **Ожидаемо.** В разделе не осталось фразы «остаётся непроверенным».
- **Пропуск ломает.** Следующий бамп digest пройдёт вслепую.

### P2.5. Гейт фазы P2

Образ собран на tk104; плагин и зависимости на месте; контейнер чисто стартует в панельных ограничениях; результат записан.

---

## §7. Фаза P3 — канарейка в shadow, соак 24 ч

> Issue: #315

Канарейка: **`01a014ad-18e1-71e1-b3f8-1011131ce414`** («мой конченый кастом») — единственный сервер с `runtime=container` (§1.3).

### P3.1. Снять базовую линию до переключения

- **Зачем.** Без замера «до» невозможно отличить деградацию от нормы, а parity-гейт сравнивает боевой поток с теневым.
- **Кто.** `А`.
- **Команда.**
  ```bash
  ID=01a014ad-18e1-71e1-b3f8-1011131ce414
  redis-cli XLEN "events:server:$ID"
  redis-cli XLEN "events:server:$ID:shadow"
  redis-cli SISMEMBER rnsquadjs:cutover-servers "$ID"    # ожидаем 0
  ```
- **Ожидаемо.** Боевой стрим растёт (его пишет штатный log-ingest), теневой пуст, сервер вне cutover-набора.
- **Пропуск ломает.** P3.5 — не с чем сравнивать.

### P3.2. Переключить движок в shadow

- **Зачем.** Shadow — единственный режим, в котором сайдкар ничего не решает: боевые события по-прежнему пишет штатный парсер, сайдкар пишет в `:shadow`, и их можно сравнить.
- **Кто.** `О` (право `server:stop`).
- **Команда.**
  ```bash
  curl -sS -X POST "https://<panel>/api/v1/servers/$ID/sidecar" \
    -H 'content-type: application/json' -b "__Host-sid=<cookie>" \
    -d '{"engine":"squadjs2","mode":"shadow"}'
  ```
- **Ожидаемо.** `200` и тело `{"server_id":…,"engine":"squadjs2","mode":"shadow","container_id":"…"}`.
- **Если не так.** `409 external_server` — взят внешний сервер (§1.3). `5xx` — идти по цепочке §3: P1.3 → P1.4 → P2.1.
- **Пропуск ломает.** Всё дальнейшее.

### P3.3. Проверить инвариант одного писателя

- **Зачем.** Два сайдкара на одном стриме дают дубликаты, из-за которых parity-гейт становится бессмысленным (симптом — `extras-exceeded`).
- **Кто.** `А`.
- **Команда.**
  ```bash
  docker ps --filter "label=panel.server_id=$ID" --format '{{.Names}}\t{{.Status}}'
  ```
- **Ожидаемо.** Ровно одна строка — `squadjs2-$ID`, статус `Up`.
- **Если не так.** Две строки — обработчик не догасил соседа: остановить лишний контейнер вручную и завести баг.

### P3.4. Проверить признаки жизни

- **Зачем.** Отличить «контейнер запущен» от «сайдкар работает»: heartbeat пишет плагин, а не docker.
- **Кто.** `А`.
- **Команда.**
  ```bash
  redis-cli TTL  "worker:heartbeat:sidecar:$ID"     # > 0, обновляется каждые 10 с
  redis-cli GET  "sidecar:status:$ID:shadow"        # {"state":"connected",...}
  redis-cli XLEN "events:server:$ID:shadow"         # растёт
  docker logs --tail 50 "squadjs2-$ID"
  curl -sS -b "__Host-sid=<cookie>" "https://<panel>/api/v1/servers/$ID/sidecar" | jq
  ```
- **Ожидаемо.** `GET /sidecar` отдаёт `engine: "squadjs2"`, `mode: "shadow"`, `status.state: "connected"`.
- **Если не так.** Heartbeat есть, а стрим не растёт — сайдкар не видит лог: сверить бинд `/squad/Logs` и наличие файла (entrypoint ждёт его до 60 с).

### P3.5. Соак 24 часа и parity-гейт

- **Зачем.** Сутки покрывают полный цикл сервера — сид, полный раунд, смену карты, ночную ротацию лога; час покрывает только удачное стечение обстоятельств.
- **Кто.** `А`.
- **Команда.** Через 24 часа:
  ```bash
  REDIS_URL=redis://127.0.0.1:6379 node scripts/rnsquadjs-shadow-diff.mjs "$ID" 86400000 100
  ```
- **Ожидаемо.** `"verdict": "pass"`, `"gate": "pass"`, `parityPct ≥ 99`, `missingTypes: []`, `|prodNameChanged − shadowNameChanged| ≤ max(2, 10 %)`.
- **Если не так.** Разбор по таблице §12.

### P3.6. Проверить `player.name_changed` вручную

- **Зачем.** Тип производится поллингом `UPDATED_PLAYER_INFORMATION`, а не строкой лога, и гейт проверяет его по количеству — ручная проверка подтверждает, что деривация вообще работает.
- **Кто.** `О` (нужен живой игрок или тестовый аккаунт).
- **Команда.** Сменить ник на сервере, затем:
  ```bash
  redis-cli XREVRANGE "events:server:$ID:shadow" + - COUNT 20 | grep -o 'player.name_changed' | head
  ```
- **Ожидаемо.** Событие появляется в пределах одного интервала поллинга (30 с).
- **Пропуск ломает.** P4: под RNSquadJS этот тип не производился вовсе, значит регресса «как было» тут нет — есть только новая функциональность, и она должна быть подтверждена до боевого режима.

### P3.7. Гейт фазы P3

`verdict: pass` на окне 24 ч; ровно один сайдкар-контейнер; heartbeat не прерывался; `player.name_changed` подтверждён вручную.

**Откат фазы P3:** `POST /sidecar {"engine":"rnsquadjs","mode":"shadow"}` — либо, поскольку RNSquadJS-образа на хосте нет, просто `docker rm -f squadjs2-$ID` и `SREM squadjs2:engine-servers $ID`: боевой поток всё это время писал штатный парсер, потери событий нет.

---

## §8. Фаза P4 — канарейка в production, соак 24 ч

> Issue: #316

Начинать **только** после P0.6 (фикс `PLAYER_DISCONNECTED` в пине) и P3.7.

### P4.1. Переключить режим в production

- **Зачем.** Это первый момент, когда сайдкар становится единственным источником событий: `SADD` в `rnsquadjs:cutover-servers` заставляет worker-log-ingest отпустить сервер.
- **Кто.** `О`.
- **Команда.**
  ```bash
  curl -sS -X POST "https://<panel>/api/v1/servers/$ID/sidecar" \
    -H 'content-type: application/json' -b "__Host-sid=<cookie>" \
    -d '{"engine":"squadjs2","mode":"production"}'
  ```
- **Ожидаемо.** `202` и `{"status":"switching"}`. Контейнер перезапускается **не сразу**: обработчик ждёт один тик реконсиляции log-ingest (`CUTOVER_TICK_MS` = 16 с), чтобы штатный тейлер успел отпустить сервер и писатели не наложились.
- **Если не так.** `202` пришёл, а через минуту контейнера нет — смотреть `docker logs`, затем логи API: при провале отложенного запуска обработчик делает `SREM` и пишет `sidecar switch failed; rolled back to legacy`.

### P4.2. Подтвердить переход через 30–60 секунд

- **Кто.** `А`.
- **Команда.**
  ```bash
  redis-cli SISMEMBER rnsquadjs:cutover-servers "$ID"   # 1
  redis-cli GET  "sidecar:status:$ID"                   # боевой ключ, без :shadow
  redis-cli XLEN "events:server:$ID"                    # растёт
  docker ps --filter "label=panel.server_id=$ID" --format '{{.Names}}'   # ровно один
  ```
- **Ожидаемо.** Всё выше выполняется одновременно.
- **Если не так.** `SISMEMBER` = 0 — переключение откатилось само (см. P4.1).

### P4.3. Проверить пять производственных типов на живом сервере

- **Зачем.** Именно эти пять типов панель считает боевыми; остальные двенадцать в production-режиме отбрасываются паблишером до `XADD`.
- **Кто.** `О` + `А`.

  | Тип | Как вызвать | Что должно произойти |
  |---|---|---|
  | `player.connected` | зайти на сервер | событие в стриме, в payload есть `name` (под RNSquadJS его не было) |
  | `player.disconnected` | выйти с сервера | событие в стриме — **главная проверка фикса P0.2** |
  | `player.name_changed` | сменить ник | событие + срабатывание banned-name правил, если ник под запретом |
  | `match.started` | смена карты | событие с `from_state: WaitingToStart` |
  | `match.ended` | конец раунда | событие с `to_state: WaitingPostMatch` |

- **Если не так.** Нет `player.disconnected` — на хосте старый digest; вернуться к P0.4.

### P4.4. Проверить потребителей

- **Зачем.** Стрим читают `worker-discord` (SCAN по `events:server:*`), `worker-automation` и обработчик banned-names в log-ingest; молчащий потребитель — такая же авария, как пустой стрим.
- **Кто.** `А`.
- **Команда.**
  ```bash
  docker logs --since 30m squad-admin-panel-worker-discord-1    | grep -iE "error|warn" | tail
  docker logs --since 30m squad-admin-panel-worker-automation-1 | grep -iE "error|warn" | tail
  docker logs --since 30m squad-admin-panel-worker-log-ingest-1 | grep -iE "error|warn" | tail
  ```
- **Ожидаемо.** Ошибок не прибавилось относительно базовой линии.

### P4.5. Соак 24 часа

- **Зачем.** Ловит то, что не видно за минуту: утечки, обрывы RCON, переживание рестарта Squad и ночной ротации лога.
- **Кто.** `А`.
- **Команда.** Раз в несколько часов повторять P4.2 и следить, что `worker:heartbeat:sidecar:$ID` не пропадал (TTL 30 с, запись каждые 10 с).
- **Ожидаемо.** Heartbeat непрерывен, `XLEN` растёт монотонно, у потребителей нет новых ошибок.

### P4.6. Гейт фазы P4

Сутки в production без откатов; все пять типов подтверждены на живом сервере; потребители без деградации.

**Откат фазы P4:** `POST /sidecar {"engine":"rnsquadjs","mode":"shadow"}` — вернёт сервер под штатный парсер (`SREM` из cutover-набора выполняется в `finally`, то есть даже если перезапуск сайдкара упал). Прямой откат к RNSquadJS-сайдкару потребует сначала собрать его образ: `docker compose … --profile images build rnsquadjs-image`.

---

## §9. Фаза P5 — остальной флот

### P5.1. Проверить, есть ли кого выкатывать

```sql
SELECT id, display_name, status FROM servers
 WHERE deleted_at IS NULL AND runtime = 'container';
```

**Сейчас** — ровно одна строка, канарейка. Фаза пустая; к ней возвращаются, когда появится второй контейнерный сервер.

### P5.2. Порядок для будущих серверов

Батчами по 5: для каждого сервера батча — P3.2 → P3.5 (shadow-соак 24 ч, parity-гейт) → P4.1 → P4.5 (production-соак 24 ч). Батч зелёный, только когда зелёны все его серверы; красный сервер откатывается индивидуально и не блокирует остальных, но батч не продвигается.

### P5.3. Внешние серверы

`runtime='external'` сайдкар не получают никогда: у них нет контейнера, конфиг-дерева и логов на хосте, а `/sidecar` отвечает `409 external_server`. Их события по-прежнему приходят через SSH-источник лога в log-ingest.

---

## §10. Фаза P6 — очистка RNSquadJS

> Issue: #317

Запускается, когда **весь** контейнерный флот прожил на SquadJS2 ≥ 7 дней без откатов.

### P6.1. Проверить, пользуется ли кто-то deprecated-алиасами

- **Зачем.** У `/servers/:id/rnsquadjs` могут быть внешние потребители с токенами; удаление вслепую ломает их молча.
- **Команда.** Проверить аудит и логи API за 14 дней на обращения к `/rnsquadjs`.
- **Решение.** Обращений нет — удалить маршрут; есть — оставить заглушку `410 Gone` с указанием замены на один релизный цикл.

### P6.2. Снять фолбэк чтения legacy-ключей

Из `GET /api/v1/servers/:id/sidecar` убрать чтение `rnsquadjs:status:*` (`legacySidecarStatusKey`) и сам хелпер из `packages/shared-config/src/sidecar.ts`.

### P6.3. Удалить RNSquadJS-контур

- `docker/rnsquadjs/`, `docker/rnsquadjs.Dockerfile`, запись `docker/rnsquadjs/plugins/*` в `pnpm-workspace.yaml`, фильтр `--filter panel-bridge` в `test:cov`, сервис `rnsquadjs-image` в обоих compose-файлах, шаги сборки в `ci.yml` и счётчики в `scripts/test-ci-runner-strategy.sh` (шесть образов станут пятью);
- `container_run_rnsquadjs` по всей цепочке: Go (`validate`, `runner`, `handlers` + тесты), `packages/shared-config/src/bridge-methods.ts`, `packages/bridge-client`;
- `apps/api/src/lib/rnsquadjs.ts`, `apps/api/src/routes/server-rnsquadjs.ts`, `apps/api/src/lib/rcon.ts` и декорация `app.rcon`;
- в вебе — мёртвая карточка «RNSquadJS» в `DossierSkillTab` и константа `RNSQUADJS_UNAVAILABLE`.

**Порядок важен:** сначала маршруты и API (P6.1–P6.2), потом бридж, потом образ. Обратный порядок оставляет API, вызывающий несуществующий RPC.

### P6.4. Не переименовывать `rnsquadjs:cutover-servers`

Это живое prod-состояние: переименование требует миграции набора и одновременного обновления worker-log-ingest. Отдельная задача, не часть очистки.

### P6.5. Проверить гейты после удаления

```bash
bash scripts/test-cov-complete.sh
bash scripts/test-ci-runner-strategy.sh
pnpm turbo run typecheck && pnpm exec biome check . && pnpm test:cov
cd apps/bridge && go vet ./... && go test -race -count=1 ./...
```

### P6.6. Обновить документацию

ADR-дополнение в `docs/architecture/decisions.md` (движок — только SquadJS2), `map.md`, `docs/components/api/api.md`, `docs/components/shared-config/data-model.md`, `docs/development/testing.md`; пометить `ai_docs/rnsquadjs-migration-pin-2026-04-24.md` полностью историческим.

### P6.7. Завести отложенные задачи

1. `chat.message` вне производственного набора — cutover-серверы без панельных чат-команд;
2. переименование `rnsquadjs:cutover-servers` в engine-neutral;
3. пер-серверный transition-lock на `POST /sidecar` (сейчас конкурентные переключения не сериализуются — унаследовано от прежнего cutover-POST);
4. автоматизация сборки сайдкар-образа в `deploy-tk104.yml` (сейчас образ собирается на хосте руками).

### P6.8. Закрыть issue #307

После бампа digest и зелёной фазы P4 — комментарий с доказательствами и закрытие.

### P6.9. Гейт фазы P6

Полный локальный гейт зелёный, `dev` CI зелёный, e2e прогон зелёный, `scripts/verify-done.sh` → 0.

---

## §11. Матрица откатов

| Из состояния | Команда отката | Что происходит с событиями |
|---|---|---|
| squadjs2-shadow | `POST /sidecar {"engine":"rnsquadjs","mode":"shadow"}`, либо `docker rm -f squadjs2-<id>` + `SREM squadjs2:engine-servers <id>` | ничего не теряется: боевой поток всё это время пишет штатный парсер |
| squadjs2-production | `POST /sidecar {"engine":"rnsquadjs","mode":"shadow"}` | сервер возвращается под штатный парсер; краткий разрыв в единицы секунд, дубликатов нет — `SREM` выполняется после запуска замены |
| сайдкар не стартует вовсе | `SREM rnsquadjs:cutover-servers <id>` | log-ingest подхватывает сервер на следующем тике (15 с) |
| бридж после обновления сломан | переустановить прошлый бинарник, `systemctl restart panel-host-bridge` | сайдкары не запускаются и не гасятся; на события не влияет, пока сервер вне cutover-набора |

Общее правило: **сначала поднять писателя, потом снимать флаг**; обратный порядок оставляет сервер без единого источника событий.

---

## §12. Диагностика: симптом → причина → действие

| Симптом | Наиболее вероятная причина | Действие |
|---|---|---|
| `POST /sidecar` → `409 external_server` | сервер `runtime='external'` | сайдкар ему не положен, §9 P5.3 |
| `POST /sidecar` → 5xx, в логах «unknown method» | бридж не обновлён | P1.3 |
| в логах бриджа «open squadjs2 sidecar root» | нет `/run/squad-panel/squadjs2` | P1.4 |
| «config.json not rendered» | API не смог отрендерить конфиг (нет `server_settings`, нет `Rcon.cfg`, нет пароля) | проверить `GET /servers/:id` и `Rcon.cfg` на хосте |
| контейнер стартует и сразу выходит, код 64/65/69 | entrypoint: 64 — нет `SERVER_ID`; 65 — пустой конфиг; 69 — лог не появился за 60 с | смотреть бинды и наличие `/squad/Logs/SquadGame.log` |
| heartbeat есть, `:shadow` пуст | сайдкар не читает лог либо на сервере нет активности | `docker logs`, проверить `logDir` и права на бинд |
| гейт `extras-exceeded` | два писателя на одном стриме | P3.3, погасить лишний контейнер |
| гейт `parity-failed`, `missingTypes: ["player.disconnected"]` | старый digest без фикса | P0.2–P0.4 |
| гейт `name-changed-count-mismatch` | деривация не сработала либо разошлась по количеству | P3.6; проверить, что `UPDATED_PLAYER_INFORMATION` приходит (нужен рабочий RCON) |
| гейт `insufficient-data` | за окно меньше `minEvents` боевых событий | продлить соак, а не понижать порог |
| гейт `corrupt-data` | в стриме битые записи | не «чинить» скрипт: найти источник битых envelope |
| CI висит в `queued`, ни одна джоба не стартовала | org-раннер `selfhost-1` offline | `bash scripts/check-runner-health.sh`; поднять раннер может только владелец организации |

---

## §13. Сводная таблица гейтов

| Гейт | Условие | Ссылка |
|---|---|---|
| G0 | GHCR доступен; squadjs2#264 смёржен; digest поднят; фикстура пересобрана и зелёная | §4 P0.6 |
| G1 | `/health` отдаёт релизную ревизию; в бридже есть `container_run_squadjs2`; `/run/squad-panel/squadjs2` существует | §5 P1.5 |
| G2 | образ собран на tk104; плагин и зависимости на месте; чистый старт в `--read-only`; boot-тест записан | §6 P2.5 |
| G3 | `verdict: pass` на окне 24 ч; один контейнер; heartbeat непрерывен; `name_changed` подтверждён | §7 P3.7 |
| G4 | сутки в production; пять типов подтверждены живьём; потребители без деградации | §8 P4.6 |
| G5 | флот (когда появится) зелёный ≥ 7 дней | §9 |
| G6 | полный гейт + CI + e2e + `verify-done.sh` после удаления RNSquadJS | §10 P6.9 |

Ни один гейт не бывает «почти зелёным»: любое невыполненное условие означает возврат к соответствующей фазе.

---

## §14. Справочник

### 14.1. Redis-ключи

| Ключ | Кто пишет | Смысл |
|---|---|---|
| `squadjs2:engine-servers` | API (`POST /sidecar`) | членство = движок сервера SquadJS2 |
| `rnsquadjs:cutover-servers` | API | сайдкар владеет лог-пайплайном; log-ingest пропускает такие серверы |
| `events:server:{id}` / `…:shadow` | штатный парсер или сайдкар | поток envelope, поле `envelope` |
| `sidecar:status:{id}` / `…:shadow` | плагин, `SET … EX 300` | связь сайдкара с RCON |
| `worker:heartbeat:sidecar:{id}` | плагин, `SET … EX 30` каждые 10 с | живость сайдкара |
| `rcon:status:{id}` | worker-rcon, **не трогать** | владелец — worker-rcon (D4) |
| `rnsquadjs:status:{id}` / `…:shadow` | legacy-сайдкар | читается только как фолбэк до P6.2 |

### 14.2. Пути и имена

```
контейнер:            squadjs2-{uuid}   (лейблы panel.server_id, panel.kind=squadjs2)
образ:                squad-panel/squadjs2:latest   (запуск с --pull never)
конфиг на хосте:      /run/squad-panel/squadjs2/{uuid}/config.json   (0600, uid 1001; каталог 0750 root)
в контейнере:         /app/panel-config.json (ro), /squad/Logs (ro)
env сайдкара:         ровно {SERVER_ID, LOG_FILE} — всё остальное в конфиге
бридж:                /usr/local/bin/panel-host-bridge, /etc/tmpfiles.d/panel-host-bridge.conf
репозиторий на tk104: ~/apps/squad-admin-panel
compose на tk104:     docker compose --env-file .env.tk104 -f compose.tk104.yml
```

### 14.3. Частые команды

```bash
# состояние движка и режима
curl -sS -b "__Host-sid=<cookie>" "https://<panel>/api/v1/servers/<uuid>/sidecar" | jq

# parity-гейт за сутки
REDIS_URL=redis://127.0.0.1:6379 node scripts/rnsquadjs-shadow-diff.mjs <uuid> 86400000 100

# здоровье раннера перед ожиданием CI
bash scripts/check-runner-health.sh

# механическая проверка завершённости (из чекаута dev)
bash scripts/verify-done.sh
```

---

## §15. Журнал прогонов

Заполняется по факту.

| Дата | Сервер | Фаза | Гейт | Решение |
|---|---|---|---|---|
| 2026-09-08 | — | P0 | не пройден | ждём GHCR-доступ и мёрж squadjs2#264 |
