# Выкат сайдкара SquadJS2 — runbook

Операторский порядок фаз 3–5 миграции сайдкара с RNSquadJS на SquadJS2.
Дизайн: [`../superpowers/specs/2026-08-24-squadjs2-migration-design.md`](../superpowers/specs/2026-08-24-squadjs2-migration-design.md).
Пин образа и чек-лист бампа: [`../../ai_docs/squadjs2-pin-2026-08-24.md`](../../ai_docs/squadjs2-pin-2026-08-24.md).

---

## 0. Пререквизиты (фаза 0) — обязательны до любого шага ниже

| Требование | Как проверить | Кто |
|---|---|---|
| Доступ к приватному пакету `ghcr.io/breaking-squad/squadjs` | `docker manifest inspect ghcr.io/breaking-squad/squadjs:master` на tk104 и на раннере | оператор (Settings пакета → Manage Actions access, либо секрет `GHCR_PULL_TOKEN`) |
| Образ сайдкара собран локально на tk104 | `docker images squad-panel/squadjs2:latest` | оператор: `docker compose --profile images build squadjs2-image` |
| CI-шаги сборки включены | в `.github/workflows/ci.yml` у шагов `log in to ghcr.io …` и `build squadjs2 sidecar image` снят `if: false` | разработчик |
| Boot-тест пина зафиксирован | раздел «Boot-тест» пин-документа заполнен фактическим выводом | оператор + разработчик |

**Пока пункт 1 не закрыт, выкат не начинается**: бридж запускает сайдкар с
`--pull never`, поэтому отсутствующий локально тег даёт мгновенный отказ запуска.

## 0.1. Известный стоп-фактор: `player.disconnected` на пине

Ишью: [#307](https://github.com/breaking-squad/squad-admin-panel/issues/307).

На пине `258440d0` правило `squad-server/log-parser/player-disconnected.js`
требует в строке лога `Name: EOSIpNetConnection_<N>, Driver: GameNetDriver EOSNetDriver_<N>`.
Squad на боевых серверах пишет `Name: RedpointEOSIpNetConnection_<N>, Driver: Name:GameNetDriver Def:GameNetDriver RedpointEOSNetDriver_<N>`
— совпадений **ноль** (проверено по всем `/opt/squad*/SquadGame/Saved/Logs/SquadGame.log`).
Следствие: SquadJS2 на этом пине **не эмитит `PLAYER_DISCONNECTED`**, а это один из
пяти производственных типов.

- Фазу 3 (shadow-соак) проходить можно и нужно — parity-гейт как раз это и поймает.
- **Фазу 4 (production) начинать нельзя**, пока правило не исправлено в
  `breaking-squad/squadjs2` и пин не поднят: иначе cutover-серверы потеряют
  события выхода игроков.

## 1. Матрица состояний

Состояние сервера ∈ {legacy, rnsquadjs-shadow, rnsquadjs-production,
squadjs2-shadow, squadjs2-production}.

| Из | Команда | Кто пишет `events:server:{id}` | Кто пишет `…:shadow` |
|---|---|---|---|
| legacy | `POST /sidecar {engine:'squadjs2', mode:'shadow'}` | штатный log-ingest | squadjs2 |
| rnsquadjs-shadow | тот же POST — это **замена** shadow-писателя | штатный log-ingest | squadjs2 |
| rnsquadjs-production | тот же POST — squadjs2 встаёт рядом в shadow | rnsquadjs | squadjs2 |
| squadjs2-shadow | `POST /sidecar {engine:'squadjs2', mode:'production'}` | squadjs2 | — |
| любое | `POST /sidecar {engine:'rnsquadjs', mode:<режим>}` — откат | по режиму | по режиму |

Инвариант одного писателя: обработчик `POST /sidecar` всегда гасит контейнеры
**обоих** движков перед запуском целевого. После любого перехода проверяйте:

```bash
docker ps --filter "label=panel.server_id=<uuid>" --format '{{.Names}}\t{{.Status}}'
# ровно одна строка: squadjs2-<uuid> или rnsquadjs-<uuid>
```

## 2. Выбор канарейки (детерминированное правило)

1. Сервер с `servers.is_canary = true`;
2. иначе — сервер, уже находящийся в состоянии rnsquadjs-shadow;
3. иначе — живой сервер с наименьшим онлайном за последние 7 дней.

```sql
SELECT id, display_name FROM servers WHERE is_canary = true AND deleted_at IS NULL;
```

## 3. Фаза 3 — канарейка в shadow, соак 24 ч

```bash
curl -sS -X POST "https://<panel>/api/v1/servers/<uuid>/sidecar" \
  -H 'content-type: application/json' -b "__Host-sid=<cookie>" \
  -d '{"engine":"squadjs2","mode":"shadow"}'
```

Сразу после перехода:

```bash
docker ps --filter "label=panel.server_id=<uuid>" --format '{{.Names}}'   # ровно один
redis-cli TTL "worker:heartbeat:sidecar:<uuid>"                          # > 0
redis-cli GET "sidecar:status:<uuid>:shadow"                             # {"state":"connected",...}
redis-cli XLEN "events:server:<uuid>:shadow"                             # растёт
docker logs --tail 50 "squadjs2-<uuid>"
```

Через 24 ч — parity-гейт:

```bash
REDIS_URL=redis://127.0.0.1:6379 node scripts/rnsquadjs-shadow-diff.mjs <uuid> 86400000 100
```

Гейт зелёный, когда `verdict: "pass"`. Разборы отказов:

| `gate` | Что значит |
|---|---|
| `insufficient-data` | за окно меньше `minEvents` боевых событий — соак не показателен, продлить |
| `parity-failed` | parity < 99 % или тип есть в prod и отсутствует в shadow |
| `name-changed-count-mismatch` | деривация `player.name_changed` разошлась по количеству больше чем на `max(2, 10 %)`, либо не сработала вовсе |
| `extras-exceeded` | shadow публикует лишнее — почти всегда два писателя, проверить `docker ps` |
| `corrupt-data` / `input-limit-exceeded` | стрим повреждён или слишком длинный, см. заголовок скрипта |

**Откат фазы 3:** `POST /sidecar {"engine":"rnsquadjs","mode":"shadow"}`.

## 4. Фаза 4 — канарейка в production, соак 24 ч

Только после зелёного гейта фазы 3 **и** закрытия стоп-фактора §0.1.

```bash
curl -sS -X POST "https://<panel>/api/v1/servers/<uuid>/sidecar" \
  -H 'content-type: application/json' -b "__Host-sid=<cookie>" \
  -d '{"engine":"squadjs2","mode":"production"}'   # 202, запуск через CUTOVER_TICK_MS
```

Ответ 202 — переключение отложено на один тик реконсиляции log-ingest (16 с),
чтобы штатный тейлер успел отпустить сервер и писатели не наложились.

Проверки в течение соака:

```bash
redis-cli SISMEMBER rnsquadjs:cutover-servers <uuid>   # 1
redis-cli TTL "worker:heartbeat:sidecar:<uuid>"        # > 0, обновляется
redis-cli XLEN "events:server:<uuid>"                  # растёт
redis-cli GET "sidecar:status:<uuid>"                  # {"state":"connected",...}
```

Функциональные проверки:

- переименование игрока приводит к `player.name_changed` и срабатыванию
  banned-name enforcement (под RNSquadJS этот тип не производился вовсе);
- вход и **выход** игрока дают `player.connected` / `player.disconnected`;
- `worker-discord` и `worker-automation` продолжают получать события без роста
  ошибок в логах.

**Откат фазы 4:** `POST /sidecar {"engine":"rnsquadjs","mode":"production"}`.

## 5. Фаза 5 — флот батчами по 5

Для каждого батча: shadow-переход → соак 24 ч → parity-гейт → production-переход
→ соак 24 ч. Батч считается зелёным, только когда зелёные все пять серверов;
любой красный сервер откатывается индивидуально, батч не продвигается.

## 6. Журнал прогонов

Заполняется по факту: дата, сервер, фаза, вывод гейта, решение.

| Дата | Сервер | Фаза | Гейт | Решение |
|---|---|---|---|---|
| — | — | — | — | не начиналось: пререквизиты §0 не закрыты |
