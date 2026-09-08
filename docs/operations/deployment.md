# Deployment

Single-host deployment model. The entire panel stack runs via `docker compose up -d` on one Linux machine. The Go host bridge runs outside Docker as a systemd service.

## Prerequisites

- Ubuntu 22.04 / 24.04 LTS or Debian 12.
- Docker Engine 24+ with Compose v2 (`docker compose version`).
- Go 1.25.13+ if building the bridge locally (binary can also be pre-built in CI).
- ~50 GB free disk for the `squad-depot` volume.
- `sudo` access on the host.

The `scripts/install-host-bridge.sh` script handles all one-time host setup. Run it before starting the stack. If `.env` already exists, the installer synchronizes `DATA_DIR` and `PANEL_GID` so compose bind mounts and bridge peer checks match the host.

## tk104 production deployment

`compose.tk104.yml` (deployed via `scripts/deploy-tk104.sh`, env file `.env.tk104`) is a
standalone compose file for the tk104 host — it does not extend `docker-compose.yml`. It
mirrors the same service topology (api/web/caddy + all workers + bridge socket mount on
`api`/workers that need it), adapted to tk104's Caddy DNS-01 Caddyfile and named-volume
storage instead of `${DATA_DIR}`-bind-mounted volumes for postgres/redis/caddy. Keep the
two files in sync by hand when the bridge-facing env/volumes on a worker change in
`docker-compose.yml`. `.env.tk104` additionally needs `PANEL_GID` and `DATA_DIR` set to
match the host's `panel` group and the data tree created by `install-host-bridge.sh`.

`scripts/deploy-tk104.sh` считается успешным только после двух обязательных
проверок: сервис `api` должен получить Compose health `healthy` не позднее 120
секунд, затем локальный HTTPS-запрос через Caddy должен вернуть успешный HTTP-код
(`curl --fail`). Таймаут API, сетевой сбой и HTTP 4xx/5xx завершают deploy
ненулевым кодом до сообщения `Deploy complete`.

## Единый вход через bss.games

Панель не подтверждает Steam-личность самостоятельно: штатная страница входа
переходит на `https://bss.games`, а панель независимо определяет текущие права
по своему RBAC после возврата пользователя. После боевой приёмки прямые
Steam-маршруты панели удалены: удостоверение личности выполняет только сайт.

В `.env.tk104` обязательны:

```dotenv
BSS_SITE_URL=https://bss.games
BSS_SSO_CLIENT_ID=squad-admin-panel
BSS_SSO_CLIENT_SECRET=<общий секрет из закрытого хранилища>
BSS_SSO_CLIENT_SECRET_NEXT=
```

В production общий секрет хранится как Actions secret
`BSS_SSO_SHARED_SECRET` одновременно в репозиториях панели и сайта. Полный
выпуск `master` перед сборкой передаёт его на `tk104` только через stdin и
запускает `scripts/configure-bss-sso-env.sh`. Скрипт атомарно меняет только
договор SSO, VIP-lifecycle и точный `APP_VERSION=<SHA master>` в `.env.tk104`,
сохраняет права файла и не печатает значения. `/health.version` после выпуска
обязан совпасть с этим SHA. Для VIP скрипт получает отдельный ключ через HMAC-контекст
`bss-vip-lifecycle-v1`, поэтому один открытый ключ не переиспользуется двумя
протоколами. Повторный выпуск безопасен, не накапливает временные файлы и
сохраняет уже включённый строгий режим ревизий.

Автоматический полный выпуск запускается только push-событием ветки `master`.
Для ручного `target=full` выбери `master` и обязательно передай
`expected_sha=<выбранный SHA>`: несовпадение останавливает задание первым шагом,
до checkout, SSH и любых изменений production.

Для независимой проверки прав панели сайт использует отдельный API-ключ только
с областями `user:view` и `role:view`. Его открытое значение хранится как
Actions secret `PANEL_READ_API_TOKEN` в обоих репозиториях, но не записывается
в `.env.tk104`: панель сохраняет в PostgreSQL только SHA-256-хеш. Перед
включением SSO один раз запусти ручной `deploy-tk104` из точного SHA ветки
`dev` с `target=site-read-token`. Операция требует ровно одного действующего
пользователя с системной ролью `Owner`, не перезапускает сервисы, повторяется
идемпотентно и при смене секрета отзывает только прежний ключ назначения
`bss.games: проверка доступа`. Затем сайт атомарно добавляет открытое значение
в своё окружение при SSO-активации. В журнале панели остаются только назначение,
области доступа и число отозванных прежних ключей.

После первого совместимого production-выпуска один раз запусти ручной
`deploy-tk104` с `target=sso-cutover` и точным SHA `master`. Задание останавливает
API, выполняет `revoke-sessions-for-sso-cutover.js --confirm-all-sessions`, а
затем поднимает API обратно через `trap` при любом исходе и ждёт внешний
`/health`. Повторный запуск снова отзовёт все текущие сеансы, поэтому это не
обычная операция выпуска. Все пять заданий `deploy-tk104` удаляют временный ключ
SSH и отдельный файл доверия с раннера в `always()`. Каждое задание принимает
ключ хоста только из заранее сверенного Actions secret
`TK104_SSH_KNOWN_HOSTS`, проверяет запись для `tk104.duckdns.org` и использует
`StrictHostKeyChecking=yes`; runtime `ssh-keyscan` и доверие при первом
подключении запрещены. При плановой смене ключа оператор сначала сверяет новый
fingerprint по независимому доверенному каналу, затем заменяет secret.

## Гарантированная доставка VIP

Первый совместимый выпуск панели передаёт в API
`VIP_LIFECYCLE_WEBHOOK_SECRET` и оставляет
`VIP_LIFECYCLE_REQUIRE_REVISION=false`, пока production-сайт ещё может работать
на прежнем коде. После публикации и проверки точного SHA сайта запусти ручной
`deploy-tk104` из точного SHA `master` с параметрами:

```text
target=vip-revision-cutover
expected_sha=<текущий SHA панели в master>
site_expected_sha=<фактически опубликованный SHA bss.games>
vip_revision_mode=true
```

Задание сначала требует от `https://bss.games/readyz` этот SHA и безопасное
runtime-состояние `vip_guaranteed_activation_enabled=false`: продажи остаются
закрыты до доказанного строгого режима. От панели до записи
оно требует точный `master` в `/health.version`. Скрипт и compose берутся из
checkout этого SHA и передаются во временный каталог на tk104, поэтому dev-preview
не может подменить исполняемые файлы. До первой записи задание на самом хосте
без вывода значений сверяет общий секрет постоянным по времени сравнением,
производный VIP-секрет, канонические URL/client ID, пустой ротационный секрет и
`APP_VERSION`. Любое расхождение завершает cutover без изменения `.env.tk104` и
без перезапуска API. При `vip_revision_mode=true` тот же действующий
API-контейнер под единым PostgreSQL advisory lock проверяет ownership и в этой
же транзакции ставит durable-флаг `panel_meta.vip_lifecycle_strict=true`. Аудит
проверяет только проекции, доказуемо связанные с последним действующим
`assigned`-событием: marker, игрок, роль, revision, срок, служебный комментарий
и единственная безопасная активная пара tier↔role должны совпасть. Ручное
назначение без lifecycle-истории не усыновляется и не считается потерянной
проекцией; потерянный или конфликтующий marker останавливает cutover. В выводе
есть только количества, без идентификаторов игроков.

Durable-флаг включает DB-backstop даже для уже работающего старого процесса и
прямого SQL: обычный writer не может назначить роль из `vip_tiers`, снять или
заменить внешнюю проекцию без точного нового lifecycle-события той же
транзакции. Пока есть действующая внешняя проекция, также нельзя удалить или
изменить её tier mapping либо сделать связанную роль системной/доступной в
панели. API возвращает безопасный `409`, а bulk-операции откатываются целиком.
Перед аудитом и при каждом запуске API до HTTP-listen дополнительно сверяется
точный fingerprint функций и trigger-ов; их удаление, `DISABLE`, перепривязка или дрейф
тела функции останавливают запуск/cutover fail-closed.

Все writer-пути панели для `Admins.cfg` — доставка outbox, active/force sync,
редактор, восстановление версии, установка и восстановление сервера — держат
один PostgreSQL advisory-xact lock на `server_id` от повторной проверки outbox
до атомарной записи, точного RCON-подтверждения и `applied_at`. Каждая реальная
попытка RCON получает новый `request_id`. При strict-режиме клиентский или
архивный файл задаёт только неуправляемые строки: все `Admin=`/`Group=`,
лишние marker-блоки и orphan-marker удаляются, а единственный канонический блок
строится из текущей БД перед `//SQSTAT DELIMETER`. Чтение strict-флага держит
`FOR SHARE` до конца файловой транзакции, поэтому cutover не обгоняет уже
начатый relaxed writer.

Этот lock действует только внутри панели. Перед открытием продаж оператор
обязан доказать единственного writer-а тех же путей: периодическую запись
`Admins.cfg` из `squadbot2`/SQSTAT нужно отключить либо перевести под тот же
fence. После этого требуется canary не короче одного полного пятиминутного
цикла внешнего синхронизатора с повторной сверкой файла и статуса доставки.
Кратковременный успешный write/reload до такого canary не доказывает
устойчивость выдачи или возврата VIP.

После изменения задание проверяет внутри контейнера точные SHA, режим и
производный VIP-секрет, затем принимает внешний
`/health` и закрытую подписанную границу VIP (заведомо неверная подпись должна
получить ровно `401`, а корректно подписанный lifecycle без `revision` —
`400 revision_required`). При отказе оно возвращает прежний
режим и заново поднимает API даже после остановки неудачного кандидата, затем
повторно принимает его; временные файлы удаляются. Обычные последующие
выпуски не сбрасывают режим: API с env=`false` отказывается стартовать при
сохранённом durable-флаге. Для аварийного отката сначала выключи продажи на
сайте, затем повтори задание с `vip_revision_mode=false`; ветка отката
останавливает API и только затем снимает DB-флаг отдельной разрешённой
операцией. Один лишь откат image панели или ошибочная env не ослабляют границу.

На сайте им дословно соответствуют:

```dotenv
PANEL_SSO_PUBLIC_URL=https://tk104.duckdns.org
PANEL_SSO_CLIENT_ID=squad-admin-panel
PANEL_SSO_CLIENT_SECRET=<тот же общий секрет>
PANEL_SSO_CLIENT_SECRET_NEXT=
```

Разрешён ровно один callback:
`https://tk104.duckdns.org/api/v1/auth/bss/callback`. Секреты получает только
API-контейнер; web получает один несекретный `BSS_SITE_URL`. Неполный набор,
HTTP-origin в production, путь/query во внешнем URL, короткий секрет или
совпадающие current/next останавливают API до начала обслуживания запросов.

### Первый выпуск и отзыв старых сессий

Сначала выпустите совместимый сайт и панель с одинаковым контрактом, проверьте
`/health`, затем один раз отзовите сессии, созданные старым прямым входом.
Команда должна выполняться при остановленном API: она берёт короткую
эксклюзивную блокировку таблицы, удаляет только найденные точные
`session:<id>`/`session-touch:<id>` ключи без `SCAN`, затем удаляет строки
PostgreSQL и печатает только итоговое число.

```bash
docker compose --env-file .env.tk104 -f compose.tk104.yml stop api
docker compose --env-file .env.tk104 -f compose.tk104.yml run --rm --no-deps api \
  node --enable-source-maps dist/tools/revoke-sessions-for-sso-cutover.js \
  --confirm-all-sessions
docker compose --env-file .env.tk104 -f compose.tk104.yml up -d api
curl -fsk https://tk104.duckdns.org/health
```

При ошибке команды сначала верните API через `up -d api`, проверьте PostgreSQL
и Redis и повторите команду: до успешного удаления из Redis строки базы не
исчезают. Успешный отзыв необратим — откат image не восстановит завершённые
сессии, пользователи войдут заново. Остальные данные не меняются.

### Ротация общего секрета без перерыва

1. Добавьте новый секрет как `*_SECRET_NEXT` одновременно на сайте и панели.
2. На панели сделайте новый секрет current, а старый временно next. Сайт ещё
   отправляет старый, но принимает новый.
3. На сайте сделайте новый секрет current, а старый временно next.
4. Проверьте вход и полный выход в обоих направлениях, затем очистите next в
   обоих приложениях.

Не повторяйте автоматически callback или обмен кода. Только идемпотентный
полный отзыв делает один повтор с небольшой случайной задержкой при сетевом
сбое/5xx; `429` не повторяется немедленно.

## CI/CD runners

Every job — verification and deployment alike — runs on the organization's own
runners, addressed **by group**:

```yaml
runs-on:
  group: selfhost-group-1
```

Label-based selection is switched off for this project, so `runs-on: self-hosted`
matches nothing and such a job queues forever, while `runs-on: ubuntu-*` would quietly
pull in a GitHub-hosted machine. `scripts/test-ci-runner-strategy.sh` fails CI on
either mistake.

- **`ci` runs on that group.** The workflow runs only for trusted `dev`/`master`
  pushes and explicit dispatches — never `pull_request`, which is the boundary that
  keeps outside code away from a machine holding production credentials. Superseded
  runs are cancelled so a merge wave does not queue behind itself. The `node` job's
  PostgreSQL/Redis service containers publish to Docker-assigned ports; `Resolve
  service ports` exports those values through both normal and `TEST_*` variables. The
  `go` job installs the pinned Go toolchain through SHA-pinned `actions/setup-go`. The
  `docker` job builds every production image and executes the backup/restore round
  trip. The runner is persistent, so Docker layers, volumes and workspaces accumulate
  between runs and need watching.
- **`deploy-tk104` runs on the same group.** Repository-level self-hosted runners are
  disabled by organization policy, and the production host itself is not a runner; the
  organization runner reaches production over SSH. All referenced actions remain
  SHA-pinned — that requirement carries more weight now that verification shares the
  machine on which this workflow writes the production deploy key (#248).
- **`deploy-tk104` deploys over SSH.** The `deploy` job (triggered
  by a push to `master`) writes the `TK104_SSH_KEY` secret to a deploy key, `rsync`s
  the checkout to `seregatipich@tk104.duckdns.org:~/apps/squad-admin-panel/`
  (excluding `.git`, `.env*`, `data`, build output), then runs
  `scripts/deploy-tk104.sh` on the host over SSH, and gates on the external
  `https://tk104.duckdns.org/health` probe.
- **`deploy-web-preview` redeploys only `web`, from `dev`.** Same workflow file,
  triggered by a `workflow_run` event once `ci` finishes green on `dev` (or manually
  via `workflow_dispatch` with `target: web`). It rsyncs `dev`'s checkout to the same
  `~/apps/squad-admin-panel/` directory and same `compose.tk104.yml` project as the
  `deploy` job above, then runs `scripts/deploy-tk104-web.sh`, which only rebuilds
  and restarts the `web` service (`docker compose ... build web` /
  `up -d --no-deps web`) — api/workers/postgres/redis keep running whatever `deploy`
  last shipped from `master`. Both jobs share the `deploy-tk104` concurrency group so
  they never touch the compose project at the same time, but this still means tk104
  serves **unpromoted `dev` code on the production frontend** between deploys —
  accepted tradeoff for a fast preview loop; promote `dev` → `master` as usual once a
  change is ready to actually ship. Per GitHub's `workflow_run`/`workflow_dispatch`
  semantics, this second job only activates once the workflow file itself has reached
  the default branch (`master`) — merging it into `dev` alone does not arm the
  trigger.

### Fast developer deploy (`scripts/dev-deploy-tk104.sh`)

Both jobs above cost a full CI run plus a queue on a runner group with one
machine in it — 30–40 minutes before a one-line UI change is visible on
tk104. For the inner loop, [`scripts/dev-deploy-tk104.sh`](../../scripts/dev-deploy-tk104.sh)
does the same two steps the workflow does (rsync the tree to
`~/apps/squad-admin-panel/`, rebuild one service of the same
`compose.tk104.yml` project) straight from a developer workstation over SSH,
with no GitHub Actions involved. The deploy target is still tk104; only the
courier changes.

```bash
scripts/dev-deploy-tk104.sh              # rebuild web only (default)
scripts/dev-deploy-tk104.sh api          # rebuild api only, no migrator
scripts/dev-deploy-tk104.sh worker-rcon  # rebuild one worker container
CONFIRM_FULL_DEPLOY=deploy scripts/dev-deploy-tk104.sh full
```

It ships the **working tree**, uncommitted changes included, so what tk104
serves afterwards is not a released revision: the stamp it sets is
`dev-<short sha>` (plus `-dirty`) where a released deploy stamps a 40-hex
commit SHA. `/health` is served by the api container and reports that stamp
only for the `api` and `full` targets — a web-only deploy deliberately leaves
the api, and therefore `/health`, on the last released revision. `.env*`, `data/` and build output are excluded exactly as in the
workflow, so host secrets and state survive. The `full` target runs
`scripts/deploy-tk104.sh`, which applies migrations from unreviewed code to the
production database, and therefore refuses to start without
`CONFIRM_FULL_DEPLOY=deploy`.

This is a preview path, not a release path: land the change through
`dev` → `master` as usual, and the next `master` deploy overwrites the preview.
Contracts: `scripts/operations-scripts.test.ts` (part of `pnpm test:scripts`).

GitHub Free for organizations currently includes 2,000 hosted Linux minutes per
month. If the quota is exhausted, do not weaken the gate or redirect verification to
the production host: batch accepted changes, restore the dedicated verification
runner, or wait for the allowance reset. The runner split is guarded by
`scripts/test-ci-runner-strategy.sh`.

## Container topology

| Service | Image | Notes |
|---|---|---|
| `caddy` | `caddy:2-alpine` | TLS termination + reverse proxy. Ports 80 + 443. |
| `api` | `docker/api.Dockerfile` | Fastify 5, port 3000 (internal only). |
| `web` | `docker/web.Dockerfile` | Next.js 15 SSR, internal only, proxied by Caddy. |
| `migrator` | `docker/api.Dockerfile` | One-shot: runs Drizzle migrations then exits. |
| `postgres` | `postgres:16-alpine` | Port 5432, bound to `127.0.0.1` only. |
| `redis` | `redis:7-alpine` | Port 6379, bound to `127.0.0.1` only. Append-only persistence. |
| `worker-log-ingest` | `docker/worker.Dockerfile` | Tails squad container logs via bridge, writes events to Redis Streams. |
| `worker-rcon` | `docker/worker.Dockerfile` | `--network host`. RCON poller (ListPlayers every 30 s). |
| `worker-config-sync` | `docker/worker.Dockerfile` | Consumes Admins.cfg sync events and writes managed role/group segments. |
| `worker-audit-archiver` | `docker/worker.Dockerfile` | Cold-archives `audit_log` rows older than 90 days. |
| `worker-event-partition` | `docker/worker.Dockerfile` | Monthly Postgres partition rotation. |
| `worker-role-expirer` | `docker/worker.Dockerfile` | Clears expired player roles and enqueues Admins.cfg sync. |
| `worker-seed-reward` | `docker/worker.Dockerfile` | Grants or revokes the configured seed reward role from rolling 30-day presence. |
| `worker-metrics-sampler` | `docker/worker.Dockerfile` | Samples `host_metrics` via bridge every 15 s, writes to `host:metrics` stream. |
| `worker-media-publisher` | `docker/worker.Dockerfile` | Publishes queued media to YouTube/Telegram. Shares the `media_data` volume with `api`; inert until `YOUTUBE_*`/`TELEGRAM_*` are set. |
| `backup` (optional) | `mazzolino/restic:latest` | Profile `backup`. Daily restic snapshot of postgres + redis volumes. |

### Bridge daemon (host, not Docker)

`panel-host-bridge` runs as a systemd service outside compose. It listens on `/run/panel-host-bridge/bridge.sock` (Unix socket, 0660 `root:panel`). Containers that need bridge access bind-mount the socket and run with primary GID = `panel` GID.

## Volumes

All named volumes are bind-mounted from `${DATA_DIR}` (set in `.env`). `install-host-bridge.sh` creates this directory tree automatically.

| Volume | Bind source | Contents |
|---|---|---|
| `postgres_data` | `${DATA_DIR}/postgres` | Postgres WAL + data files. |
| `redis_data` | `${DATA_DIR}/redis` | Redis AOF. |
| `caddy_data` | `${DATA_DIR}/caddy-data` | TLS certificates. |
| `caddy_config` | `${DATA_DIR}/caddy-config` | Caddy auto-config. |
| `backup_repo` | `${DATA_DIR}/backup-repo` | Restic repository (optional). |
| `squad-depot` | `${DATA_DIR}/depot` | Steam-fetched Squad game files (~45 GB). Populated once by `depot_update`. |

Per-server configs and saved state live at `/var/lib/squad-panel/` (a symlink to `${DATA_DIR}/servers/`) on the host, bind-mounted into each Squad container.

## TLS

Caddy handles TLS automatically. Set `TLS_ISSUER` in `.env`:

| Value | Behavior |
|---|---|
| `internal` (default) | Self-signed local CA. Good for dev and LAN deployments. |
| `acme` | Let's Encrypt (or other ACME CA). Requires a public DNS name in `APP_DOMAIN` and a valid `ACME_EMAIL`. |

## First deploy

Preferred path:

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

sudo ./scripts/bootstrap.sh
```

Manual path:

```bash
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

cp .env.example .env
# Fill APP_DOMAIN, PANEL_PUBLIC_URL, BSS_*, POSTGRES_PASSWORD,
# APP_ENCRYPTION_KEY and SESSION_SECRET
# Generate secrets: openssl rand -base64 32
# Save APP_ENCRYPTION_KEY offline — losing it makes RCON passwords unrecoverable.

sudo ./scripts/install-host-bridge.sh
# idempotent — creates panel group, systemd unit + socket, data tree, squad-depot volume,
# and updates DATA_DIR + PANEL_GID in .env when the file exists.

sudo usermod -aG panel "$USER" && newgrp panel

docker compose config --quiet
docker compose up -d --build
```

`migrator` runs before `api` starts. When `api` becomes healthy, Caddy begins routing. Open `https://${APP_DOMAIN}/login`: вход продолжится через bss.games, а первая подтверждённая учётная запись станет Owner. Затем она перейдёт через `/setup` для начальной настройки.

## Staging deployment gate

Use the same single-host model for dev/staging as production. A staging host is ready only after these checks pass:

```bash
docker compose config --quiet
sg panel -c 'bash scripts/verify-bridge.sh'
docker compose ps
curl -sk https://${APP_DOMAIN}/health
curl -sk https://${APP_DOMAIN}/ready
curl -skI https://${APP_DOMAIN}/api/docs
```

Expected results:

- `verify-bridge.sh` exits `0` and covers every bridge RPC method.
- `/health` returns `{"status":"ok", ...}`.
- `/ready` returns HTTP 200 with `status:"ok"` and `checks.postgres`, `checks.redis`, `checks.bridge` equal to `ok`.
- `/api/docs` returns an HTTP 200/30x response from the API docs UI.
- Новая панель завершает первый Owner-вход через bss.games и начальную настройку.
- The dashboard loads and the bridge/worker health widgets do not report a persistent outage.

Dokploy can be used to build or restart the compose stack after the host has been prepared, but it is not a complete deployment boundary for this project. The host bridge, `panel` group, systemd socket/service, data tree, and `squad-depot` bind volume must be installed and verified outside Dokploy first.

## Image rebuild flow

After changing TypeScript source:

```bash
# Rebuild only affected services — faster than a full build
docker compose build api
docker compose build web
docker compose build worker-rcon worker-log-ingest worker-metrics-sampler

# Apply and restart
docker compose up -d api web worker-rcon worker-log-ingest worker-metrics-sampler
```

After changing the Go bridge:

```bash
cd apps/bridge && make build
sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/panel-host-bridge
sudo systemctl restart panel-host-bridge.service
# Note: `cp` fails with "Text file busy" on a running binary — always use `install`.
```

## Panel update procedure

```bash
git pull
pnpm install
docker compose build api web worker-rcon worker-log-ingest worker-config-sync worker-audit-archiver worker-event-partition worker-role-expirer worker-seed-reward worker-metrics-sampler
docker compose up -d
```

Migrations run automatically when the `migrator` service starts as part of `docker compose up -d`. No manual migration step is needed for panel updates.

If the bridge binary changed:

```bash
cd apps/bridge && make build
sudo install -m 0755 bin/panel-host-bridge /usr/local/bin/panel-host-bridge
sudo systemctl restart panel-host-bridge.service
```

## Rollback

1. `git checkout <previous-tag>`
2. `pnpm install`
3. Rebuild and restart affected services.
4. Database migrations are forward-only. If the new schema has destructive changes, refer to [`migrations.md`](./migrations.md) for the manual rollback procedure.

Для отката единого входа верните предыдущий image панели и прежний UI, не
меняя общий секрет сайта. Уже отозванные одноразовой командой сессии не
восстанавливаются; это единственная необратимая часть перехода.

## Verifying a deployment

```bash
sg panel -c 'bash scripts/verify-bridge.sh'   # bridge RPC smoke test
curl -sk https://${APP_DOMAIN}/health          # {"status":"ok"}
curl -sk https://${APP_DOMAIN}/ready           # {"status":"ok","checks":{"postgres":"ok","redis":"ok","bridge":"ok"}}
curl -skI https://${APP_DOMAIN}/api/docs        # API docs UI responds
```

The `/ready` endpoint returns 503 if any dependency is unhealthy.

## Backup (optional)

Enable the `backup` profile:

```bash
docker compose --profile backup up -d backup
```

Requires `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` in `.env`. Snapshots are taken daily at 03:00 UTC. Retention: 7 daily, 4 weekly, 6 monthly.

The `backup` service (image built from [`docker/restic.Dockerfile`](../../docker/restic.Dockerfile)) does **not** snapshot the raw data directories. Before every snapshot its `PRE_COMMANDS` produce **logical dumps** — `pg_dump -Fc` for Postgres and `redis-cli --rdb` for Redis — into the `backup_dump` volume (`${DATA_DIR}/backup-dump`), and restic snapshots that directory. Logical dumps restore cleanly into a fresh, freshly-migrated stack; a raw snapshot of live WAL/AOF files cannot guarantee that. `pg_dump`/`redis-cli` reuse `POSTGRES_PASSWORD` — no additional secret is required. The service waits for `postgres` and `redis` to be healthy (`depends_on`) before it starts.

### Disaster-recovery restore (manual)

Restore is a deliberate host operation, run with [`scripts/restore.sh`](../../scripts/restore.sh) — it is **not** automated (CI only exercises the mechanism, see below). Run a dry run first; it lists the snapshots and mutates nothing:

```bash
scripts/restore.sh                        # dry run — prints the plan and `restic snapshots`
scripts/restore.sh --apply                # destructive — overwrites live Postgres + Redis (latest)
scripts/restore.sh --apply --snapshot ID  # destructive — restore a specific restic snapshot id
```

`--apply` restores the selected snapshot (default `latest`; `--snapshot` takes a restic short/long id or `latest` and is regex-validated so it cannot smuggle arguments): it waits for `postgres` to be healthy, runs `pg_restore --clean --if-exists`, then reloads the Redis dataset. Run it with `sudo` if `${DATA_DIR}/redis` is not writable by your user — the Redis container owns those files (uid 999), and `--apply` rewrites them on the host. Redis is loaded via a one-off `redis-server` that reads the restored `dump.rdb` and rewrites it into an AOF, because the `redis` service runs with `--appendonly yes` and would otherwise ignore a bare `dump.rdb`.

### Backup/restore from the panel UI (INFRA-8-P1)

Operators with the `host:manage` permission get a **Настройки → Бэкапы** page (`/settings/backup`) that lists the restic snapshots, triggers a manual backup, and restores a chosen snapshot behind a strong typed confirmation (the operator must type the snapshot's short id). The API container has no docker socket, so these operations go through the Go host bridge — new RPCs `backup_snapshots` (`restic snapshots --json`), `backup_run` (`docker compose --profile backup run --rm backup backup`) and `backup_restore` (wraps `scripts/restore.sh --apply --snapshot <id>`) — behind the routes `GET/POST /api/v1/host/backups` and `POST /api/v1/host/backups/:id/restore` (audited `backup.run` / `backup.restore`).

Because the bridge shells out to `docker compose` and `scripts/restore.sh` from the panel's deploy directory, its systemd unit must set that directory so the RPCs inherit `.env` (`RESTIC_PASSWORD`, `POSTGRES_PASSWORD`):

```ini
# /etc/systemd/system/panel-host-bridge.service — [Service]
Environment=PANEL_COMPOSE_DIR=/opt/squad-admin-panel   # dir holding docker-compose.yml + .env + scripts/
# ProtectSystem=strict also requires the deploy dir on ReadWritePaths for the restore path.
```

Unset or non-absolute `PANEL_COMPOSE_DIR` makes the backup RPCs fail closed (`forbidden`), so the UI degrades to a clear error rather than running from an unexpected directory.

**Acceptance procedure (full `down -v` recovery).** This is the manual proof that a total-loss restore works. It destroys the live stack — run it only against a scratch host or a copy of production:

```bash
docker compose --profile backup up -d backup      # start the backup service
docker compose --profile backup run --rm backup backup   # force one snapshot now
docker compose --profile backup down -v            # stop everything, drop the volumes
rm -rf data/postgres/* data/redis/*                # bind mounts survive `down -v`; wipe them too
docker compose up -d postgres redis                # fresh, empty databases
scripts/restore.sh --apply                          # restore from the restic repository
```

Because the panel's volumes are host bind mounts (`type=none, o=bind`), `down -v` removes the volume definitions but leaves `${DATA_DIR}/{postgres,redis}` on disk; the `rm -rf` step is required to genuinely simulate data loss. The automated equivalent — build the image, dump, snapshot, `down -v`, restore, assert the seeded row and key survive — runs on every CI push via [`scripts/test-backup-restore.sh`](../../scripts/test-backup-restore.sh) in the `docker` job.

The full-stack version of this procedure is scripted in [`scripts/test-fullstack-down-v.sh`](../../scripts/test-fullstack-down-v.sh): it brings the **whole** compose stack up, seeds a canary, snapshots, runs the literal `down -v`, restores with `scripts/restore.sh --apply`, then asserts the api `/health` endpoint returns 200 (panel operational) and the seeded Postgres row + Redis key survived. It is **run-deferred** — the destructive whole-stack cycle exceeds the standard hosted runner's 2 vCPU / 8 GB / 14 GB envelope (see #219) — so it is **not** wired into CI and refuses to run unless explicitly opted in on a scratch host with Docker and ample RAM:

```bash
RUN_FULLSTACK_DOWN_V=1 bash scripts/test-fullstack-down-v.sh
```

## See also

- [`setup.md`](./setup.md) — initial host setup including first-owner claim.
- [`environment-variables.md`](./environment-variables.md) — full `.env` reference.
- [`migrations.md`](./migrations.md) — database migration workflow.
- [`monitoring.md`](./monitoring.md) — observability and diagnostics.
- [`docs/components/bridge/README.md`](../components/bridge/README.md) — bridge daemon details.
