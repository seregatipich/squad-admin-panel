# План реализации подтверждаемой доставки VIP

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНЫЙ НАВЫК: выполняйте план по задачам через `superpowers:subagent-driven-development` (предпочтительно) либо `superpowers:executing-plans`. Отмечайте шаги флажками `- [ ]`.

**Цель:** Сделать назначение VIP-роли и доставку `Admins.cfg` проверяемой частью покупки на `bss.games`.

**Архитектура:** Lifecycle блокирует строку игрока, валидирует владение ролью и монотонную revision, затем атомарно пишет роль, событие и снимок outbox. Relay публикует только после commit; config-sync фиксирует в PostgreSQL подтверждённую файловую/RCON-доставку, а подписанный status агрегирует результат события.

**Стек:** TypeScript, Fastify, Zod, Drizzle/PostgreSQL, Redis Streams, Vitest, worker-rcon.

**Спецификация:** `docs/superpowers/specs/2026-09-02-vip-delivery-status-design.md`

## Общие ограничения

- Не создавать баланс, списание или компенсацию покупки в панели.
- Не перезаписывать ручную роль или роль, принадлежащую активной `vip_subscriptions`.
- Не включать SteamID64, EOS, пути, сырые ответы RCON и конфиг в status или публичные доказательства.
- Revision монотонна на игрока; БД закрепляет unique `(player_id, revision)` для ненулевой revision.
- Redis-публикация outbox выполняется только после commit; `XACK` — только после устойчивой записи результата в PostgreSQL.
- Старый producer переживает первый выпуск при `VIP_LIFECYCLE_REQUIRE_REVISION=false`; флаг включается только после выпуска сайта.
- Новых зависимостей нет.

---

### Задача 1: HMAC-окно и совместимый входной договор

**Файлы:**
- Modify: `apps/api/src/lib/vip-lifecycle-signature.ts`
- Modify: `apps/api/src/routes/integrations-vip.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `.env.example`
- Test: `apps/api/test/integration/vip-lifecycle.test.ts`
- Test: `apps/api/test/vip-lifecycle-signature.test.ts`

**Интерфейсы:**
- Produces: `verifyVipLifecycleSignature(secret, timestamp, signature, payload, nowMs?)` с окном ±300 секунд для действующего ISO 8601 timestamp.
- Produces: preflight и lifecycle body с optional `revision`, совместимым `discord_id` и флагом `VIP_LIFECYCLE_REQUIRE_REVISION`.

- [ ] **Шаг 1: Написать RED-тесты подписи и схемы**

Проверить валидную подпись на `now`, обе границы ±300 секунд, отказ на ±301,
дату без timezone, невалидный ISO и неверную подпись. В интеграционном
тесте проверить `discord_id`, optional revision при выключенном флаге и
`400 { error: 'revision_required' }` при включённом.

- [ ] **Шаг 2: Подтвердить RED**

Run:

```bash
pnpm --filter @squad/api exec vitest run test/vip-lifecycle-signature.test.ts test/integration/vip-lifecycle.test.ts
```

Expected: устаревшая/будущая подпись принимается, новых полей и флага нет.

- [ ] **Шаг 3: Ограничить HMAC по времени**

До вычисления HMAC строго разобрать действующий ISO 8601 timestamp с timezone и
проверить `Math.abs(nowMs - parsedTimestampMs) <= 300_000`. Любой отказ остаётся
`invalid_signature`; сравнение digest выполняется через `timingSafeEqual`.
Параметр `nowMs` нужен только для детерминированного теста и по умолчанию равен
`Date.now()`.

- [ ] **Шаг 4: Добавить схемы и флаг совместимости**

Preflight принимает `{ steam_id64, role_id, tier }`. Lifecycle добавляет
`revision: positive int optional` и `discord_id: 17..20 digits optional`.
Конфиг читает boolean `VIP_LIFECYCLE_REQUIRE_REVISION` с безопасным default
`false`; при `true` отсутствие revision отклоняется до транзакции. Discord id
участвует в подписанном теле и request hash, но дальше не используется.

- [ ] **Шаг 5: Подтвердить GREEN**

Повторить команду шага 2. Expected: все тесты проходят.

- [ ] **Шаг 6: Commit**

```bash
git add apps/api/src/lib/vip-lifecycle-signature.ts apps/api/src/routes/integrations-vip.ts apps/api/src/config.ts apps/api/test .env.example
git commit -m "fix(api): harden VIP lifecycle signature"
```

### Задача 2: Транзакционная сериализация, владение ролью и preflight

**Файлы:**
- Modify: `apps/api/src/routes/integrations-vip.ts`
- Modify: `apps/api/src/routes/vip-subscriptions.ts`
- Modify: `packages/db/src/economy/vip-grant.ts`
- Test: `apps/api/test/integration/vip-lifecycle.test.ts`
- Test: `apps/api/test/integration/vip-subscriptions.test.ts`
- Modify: `packages/db/test/vip-grant.unit.test.ts`

**Интерфейсы:**
- Produces: единый `checkVipLifecycleTarget(tx, input, { lockPlayer })`.
- Produces: безопасные ошибки `player_eos_missing`, `role_not_vip`, `role_conflict`, `manual_role_conflict`, `vip_subscription_conflict`, `no_target_servers`.
- Produces: preflight `{ ok, servers_total, projection_owner, expires_at }`, где
  владелец/срок возвращаются только из доказанного внешнего назначения.

- [ ] **Шаг 1: Написать RED-тесты проверок и гонки владельцев**

Проверить отсутствие EOS, inactive/mismatched tier, system role, `panel_access`,
другую роль, вручную назначенную ту же VIP-роль и активную
`vip_subscriptions`: каждый случай возвращает 403/409 и не меняет игрока,
lifecycle, аудит или outbox. Запустить параллельно внешнее lifecycle и создание
ручной подписки одному игроку; после обеих транзакций ровно один источник
владеет назначением, проигравший получает конфликт и не списывает бонусы.

- [ ] **Шаг 2: Подтвердить RED**

Run:

```bash
eval "$(bash scripts/new-test-db.sh vip-delivery-target)"
pnpm --filter @squad/api exec vitest run test/integration/vip-lifecycle.test.ts test/integration/vip-subscriptions.test.ts
pnpm --filter @squad/db exec vitest run test/vip-grant.unit.test.ts
```

Expected: текущий маршрут не проверяет EOS/tier/подписку и допускает перезапись.

- [ ] **Шаг 3: Зафиксировать проекцию и блокировку игрока**

В lifecycle-транзакции первым доменным чтением выбрать игрока через
`.select({ id, steamId64, eosId, roleId, roleExpiresAt, roleComment })` и
`.for('update')`. Не использовать `select()` всей строки. Под этой блокировкой
читать active tier, текущую активную `vip_subscriptions` и последнее действующее
lifecycle-событие, доказывающее владение внешним назначением.

- [ ] **Шаг 4: Реализовать единые правила цели**

Разрешить роль только если tier активен, точно ссылается на `role_id`, роль не
system и `panelAccess=false`, EOS непустой. Пустая роль допускает первую
покупку. Совпавшая роль допускает extension/revoke только при совпавшей внешней
purchase-линии и неизменённом результате последнего lifecycle; иначе вернуть
`manual_role_conflict`. Любая active `vip_subscriptions` даёт
`vip_subscription_conflict`.

- [ ] **Шаг 5: Закрыть обратную гонку ручной подписки**

Сохранить `SELECT ... FOR UPDATE` в `applyVipGrant`, а создание
`vip_subscriptions` после получения блокировки обязать проверить отсутствие
действующего внешнего lifecycle-владения. При конфликте откатить всю
транзакцию, включая bonus ledger. Ручная смена роли остаётся разрешённой и
выигрывает; следующий webhook увидит несовпадение владения и ничего не сотрёт.

- [ ] **Шаг 6: Повторно получить снимок серверов**

Preflight возвращает текущий `servers_total`, но lifecycle после блокировки и
всех проверок заново выбирает `{ id }` неудалённых серверов. При пустом списке
вернуть `409 { error: 'no_target_servers' }` и откатить все записи. Передать
непустой массив id в outbox helper, чтобы fan-out соответствовал одному снимку.

- [ ] **Шаг 7: Подтвердить GREEN**

Повторить команды шага 2; отдельно прогнать тест параллельной покупки не менее
20 раз в одном тесте, чтобы уникальные ограничения и row lock были
нагружены, а не замоканы.

- [ ] **Шаг 8: Commit**

```bash
git add apps/api/src/routes/integrations-vip.ts apps/api/src/routes/vip-subscriptions.ts packages/db/src/economy/vip-grant.ts apps/api/test packages/db/test/vip-grant.unit.test.ts
git commit -m "fix(api): serialize VIP role ownership"
```

### Задача 3: Ревизии, хеш тела и состояние `superseded`

**Файлы:**
- Create: `packages/db/drizzle/0108_vip_delivery_status.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema/vip-lifecycle-events.ts`
- Modify: `apps/api/src/routes/integrations-vip.ts`
- Test: `apps/api/test/integration/vip-lifecycle.test.ts`

**Интерфейсы:**
- Produces: nullable `revision`, `requestHash`, `supersededByEventId` и action `superseded`.
- Produces: partial unique `vip_lifecycle_events_player_revision_key (player_id, revision)`.

- [ ] **Шаг 1: Написать RED-тесты идемпотентности, гонок и перестановок**

Покрыть: одинаковый event/body; одинаковый event с изменённым expiry/tier;
разные events с одной revision; конкурентные revisions одного игрока; порядки
`4 -> 5` и `5 -> 4`; запоздалый expire старой purchase после новой покупки.
Проверять HTTP body, одну итоговую роль/expiry, число аудитов/outbox и status
проигравшего события `superseded`.

- [ ] **Шаг 2: Подтвердить RED**

Run: `pnpm --filter @squad/api exec vitest run test/integration/vip-lifecycle.test.ts`

Expected: повтор с изменённым телом ошибочно считается duplicate, ограничения
revision и `superseded` отсутствуют.

- [ ] **Шаг 3: Добавить совместимую миграцию и schema**

`0108_vip_delivery_status.sql` добавляет nullable `revision integer`,
`request_hash text`, `superseded_by_event_id text` и расширяет action CHECK
значением `superseded`. Создать partial unique:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS vip_lifecycle_events_player_revision_key
  ON vip_lifecycle_events (player_id, revision)
  WHERE revision IS NOT NULL;
```

`superseded_by_event_id` ссылается на `vip_lifecycle_events(event_id)` через
nullable FK. Старые строки остаются валидными без backfill.

- [ ] **Шаг 4: Зафиксировать точную идемпотентность**

Вычислять `request_hash = sha256(canonicalJson(validatedBody))`. После получения
player lock повторно читать `event_id`: совпавший hash возвращает duplicate,
отличный — `409 { error: 'event_id_conflict', event_id }`. Ошибку unique index
`player+revision` переводить в
`409 { error: 'revision_conflict', revision }`, не в 500.

- [ ] **Шаг 5: Применить глобальную revision игрока**

Под player lock выбрать максимальную ненулевую revision игрока. Меньшую
incoming revision записать с `action=superseded` и ссылкой на победителя без
мутации/outbox/аудита назначения. При большей revision пометить все прежние
незавершённые события игрока `superseded_by_event_id=incoming.event_id`, затем
применить только новое желание. Legacy без revision выполняет прежний договор
лишь при выключенном флаге и только пока у игрока нет revisioned history; после
первой revision старое тело получает `409 { error: 'revision_required' }` и не
может переиграть новую цепочку.

- [ ] **Шаг 6: Подтвердить GREEN и миграцию**

Run:

```bash
pnpm --filter @squad/api exec vitest run test/integration/vip-lifecycle.test.ts
pnpm --filter @squad/db typecheck
```

Expected: гонки имеют одного победителя; обе перестановки дают одно состояние.

- [ ] **Шаг 7: Commit**

```bash
git add packages/db/drizzle packages/db/src/schema/vip-lifecycle-events.ts apps/api/src/routes/integrations-vip.ts apps/api/test/integration/vip-lifecycle.test.ts
git commit -m "feat(db): serialize VIP lifecycle revisions"
```

### Задача 4: Строго post-commit outbox

**Файлы:**
- Modify: `packages/db/src/schema/admins-cfg-sync-outbox.ts`
- Modify: `packages/db/src/admins-cfg-outbox.ts`
- Modify: `apps/api/src/lib/admins-cfg-sync.ts`
- Modify: callers of `publishAdminsCfgSyncForAllServers` under `apps/api/src/routes/`
- Test: `apps/api/test/integration/admins-cfg-outbox.test.ts`
- Create: `packages/db/test/admins-cfg-outbox.test.ts`

**Интерфейсы:**
- Consumes: непустой `serverIds` snapshot для lifecycle, обычный DB-query для остальных callers.
- Produces: outbox fields `correlationId`, `appliedAt`, `lastError`, `reloadOutcome`; relay envelope `_outbox_id`.

- [ ] **Шаг 1: Написать RED-тесты commit-границы и relay crash**

Проверить отсутствие `XADD` до commit, видимость строки relay только после
commit, отсутствие строки/Redis при rollback и один outbox на каждый id
lifecycle-снимка. Смоделировать падение relay после `XADD`, но до
`relayed_at`: следующий запуск публикует повтор с тем же `_outbox_id`.

- [ ] **Шаг 2: Подтвердить RED**

Run:

```bash
pnpm --filter @squad/api exec vitest run test/integration/admins-cfg-outbox.test.ts
pnpm --filter @squad/db exec vitest run test/admins-cfg-outbox.test.ts
```

Expected: текущий fast path публикует внутри транзакции, envelope не содержит id.

- [ ] **Шаг 3: Расширить outbox миграцию и schema**

В ту же ещё не выпущенную `0108` добавить nullable `correlation_id`,
`applied_at`, `last_error`, `reload_outcome` и partial index по
`correlation_id`. `last_error` принимает только нормализованные коды; сырой
текст worker не сохраняет.

- [ ] **Шаг 4: Удалить Redis из транзакционного helper**

Удалить `tryImmediateDispatch` и Redis-параметр. Helper только вставляет строки
outbox; lifecycle передаёт уже полученный `serverIds`, остальные callers могут
использовать существующий выбор активных серверов. Обновить все callers, чтобы
ни один не оставил скрытый fast path.

- [ ] **Шаг 5: Публиковать correlation после commit**

Relay сериализует `{ ...payload, _outbox_id: row.id }`, после успешного `XADD`
пишет `relayed_at` и `stream_id`. Сохранить at-least-once поведение при crash;
soft-deleted сервер по-прежнему дренируется без воссоздания stream.

- [ ] **Шаг 6: Подтвердить GREEN**

Повторить команды шага 2 и существующие fan-out тесты role/whitelist/clan.

- [ ] **Шаг 7: Commit**

```bash
git add packages/db apps/api/src/lib/admins-cfg-sync.ts apps/api/src/routes apps/api/test
git commit -m "fix(outbox): publish Admins cfg tasks after commit"
```

### Задача 5: Устойчивое подтверждение файла и RCON

**Файлы:**
- Modify: `packages/db/src/admins-cfg-outbox.ts`
- Modify: `apps/workers/config-sync/src/index.ts`
- Modify: `apps/workers/config-sync/src/syncer.ts`
- Modify: `apps/workers/config-sync/src/rcon-reload.ts`
- Test: `packages/db/test/admins-cfg-outbox.test.ts`
- Test: `apps/workers/config-sync/test/syncer.test.ts`
- Test: `apps/workers/config-sync/test/rcon-reload.test.ts`
- Test: `apps/workers/config-sync/test/purchase-admins-cfg.test.ts`

**Интерфейсы:**
- Consumes: `_outbox_id` и `rconCommandResultSchema`.
- Produces: `markAdminsCfgSyncApplied(id, outcome)` и `markAdminsCfgSyncFailed(id, code)`.
- Produces: `confirmed | file_ready_for_restart | unavailable | rejected | timeout | invalid_result`.

- [ ] **Шаг 1: Написать RED-тесты результата и переходов server state**

Проверить running/starting: enqueue недостаточен, `applied_at` остаётся null до
валидного `ok=true`. Проверить mismatched request/server/command, rejected и
timeout. Смоделировать `stopped -> running` между записью и финализацией —
нужен RCON; `running -> stopped` — достаточно файла после финального чтения.

- [ ] **Шаг 2: Написать RED-тесты падений и restart/reclaim**

Покрыть падение: после файла до RCON result; после result до `applied_at`; после
`applied_at` до `XACK`. После restart/reclaim сообщение завершается без потери:
до DB-confirmation повторяется безопасно с тем же request id, после неё только
XACK. Совпавший file hash при ещё пустом `applied_at` не пропускает RCON.

- [ ] **Шаг 3: Подтвердить RED**

Run:

```bash
pnpm --filter @squad/db exec vitest run test/admins-cfg-outbox.test.ts
pnpm --filter @squad/worker-config-sync exec vitest run test/rcon-reload.test.ts test/syncer.test.ts test/purchase-admins-cfg.test.ts
```

Expected: enqueue сейчас считается достаточным, outbox application helpers отсутствуют.

- [ ] **Шаг 4: Добавить условные DB helpers**

`markAdminsCfgSyncApplied` обновляет только указанный id с
`applied_at IS NULL`, атомарно ставит время/outcome и чистит error.
`markAdminsCfgSyncFailed` оставляет `applied_at=NULL` и пишет allowlisted code.
Повтор уже applied строки возвращает её состояние, чтобы consumer мог безопасно
сделать XACK без файла или RCON.

- [ ] **Шаг 5: Дождаться точного RCON result**

Для correlated outbox использовать детерминированный
`request_id = admins-cfg-sync:<outbox_id>`. После `XADD` ждать до 4 секунд с
шагом 100 мс, парсить `rconCommandResultSchema` и принимать только совпавшие
`server_id`, `request_id`, `command=AdminReloadServerConfig`, `ok=true`.
Сырые `response/error` допускаются только в памяти/логах с редактированием.

- [ ] **Шаг 6: Повторно проверить состояние сервера**

После успешной записи/сверки файла прочитать свежий `servers.status`. Перед
финальным DB update прочитать его ещё раз. Финальный `running|starting` требует
confirmed RCON; финальный неживой статус сохраняет
`file_ready_for_restart`. Если сервер стал живым, выполнить RCON-ветку; не
использовать Redis `rcon:status` как источник lifecycle-решения.

- [ ] **Шаг 7: Изменить порядок ACK**

На временных ошибках записать безопасный code и оставить message в PEL.
Успех: сначала `markAdminsCfgSyncApplied`, затем `XACK`. При повторе applied
outbox сразу XACK. Некоррелированные старые события сохраняют прежнюю
идемпотентную синхронизацию и ACK, но не участвуют в VIP status.

- [ ] **Шаг 8: Подтвердить GREEN**

Повторить команды шага 3. Expected: тесты гонок состояния и всех crash points проходят.

- [ ] **Шаг 9: Commit**

```bash
git add packages/db/src/admins-cfg-outbox.ts packages/db/test apps/workers/config-sync
git commit -m "feat(config-sync): persist confirmed VIP delivery"
```

### Задача 6: Подписанное агрегированное состояние

**Файлы:**
- Modify: `apps/api/src/routes/integrations-vip.ts`
- Test: `apps/api/test/integration/vip-lifecycle.test.ts`
- Modify: `docs/components/api/api.md`
- Modify: `docs/components/api/configuration.md`
- Modify: `docs/components/workers/config-sync/flows.md`
- Modify: `docs/components/workers/config-sync/changelog.md`

**Интерфейсы:**
- Consumes: lifecycle supersession и outbox applied state.
- Produces: `POST /api/v1/integrations/vip/status`.

- [ ] **Шаг 1: Написать RED-тесты status**

Неизвестный event даёт 404. Проверить литеральные переходы
`accepted -> applying -> applied`, временную ошибку как `applying`, постоянный
отказ как `failed`, а старое событие после большей revision как `superseded`
даже при позднем завершении его outbox. Убедиться, что запрещённых ключей и
сырых ошибок нет на любой ветке.

- [ ] **Шаг 2: Подтвердить RED**

Run: `pnpm --filter @squad/api exec vitest run test/integration/vip-lifecycle.test.ts`

Expected: status route отсутствует.

- [ ] **Шаг 3: Реализовать status route**

Тело `{ event_id }` проходит HMAC и timestamp window. Ответ:

```ts
{
  ok: true,
  event_id: string,
  state: 'accepted' | 'applying' | 'applied' | 'failed' | 'superseded',
  action: 'assigned' | 'revoked' | 'ignored' | 'superseded',
  superseded_by_event_id?: string,
  servers_total: number,
  servers_applied: number,
  servers_pending: number,
  error_codes: string[]
}
```

`superseded` проверяется до агрегации outbox. `applied` требует
`count(*) = count(applied_at)` и непустой correlation snapshot. Временные коды
не переводят событие в failed.

- [ ] **Шаг 4: Обновить русскую документацию**

Зафиксировать `202 != applied`, HMAC window, оба 409, superseded, ownership
конфликты, поля outbox, post-commit relay и трёхшаговый rollout флага.

- [ ] **Шаг 5: Подтвердить GREEN и типы**

Run:

```bash
pnpm --filter @squad/api exec vitest run test/integration/vip-lifecycle.test.ts
pnpm --filter @squad/api typecheck
pnpm --filter @squad/worker-config-sync typecheck
pnpm --filter @squad/db typecheck
pnpm exec biome check apps/api/src/routes/integrations-vip.ts apps/api/src/lib/vip-lifecycle-signature.ts apps/workers/config-sync packages/db/src
```

- [ ] **Шаг 6: Commit**

```bash
git add apps/api/src/routes/integrations-vip.ts apps/api/test/integration/vip-lifecycle.test.ts docs
git commit -m "feat(api): expose confirmed VIP delivery status"
```

### Задача 7: Полная проверка и безопасный выпуск

**Файлы:**
- Verify only; исправления ревью коммитить отдельно.

**Интерфейсы:**
- Consumes: задачи 1–6.
- Produces: production panel contract, готовый для обязательного шлюза сайта.

- [ ] **Шаг 1: Выполнить узкий набор повторно**

Run:

```bash
pnpm --filter @squad/api exec vitest run test/vip-lifecycle-signature.test.ts test/integration/vip-lifecycle.test.ts test/integration/admins-cfg-outbox.test.ts test/integration/vip-subscriptions.test.ts
pnpm --filter @squad/worker-config-sync test
pnpm --filter @squad/db test
pnpm turbo run typecheck --filter=@squad/api --filter=@squad/worker-config-sync --filter=@squad/db
pnpm exec biome check apps/api/src/routes/integrations-vip.ts apps/api/src/lib/admins-cfg-sync.ts apps/workers/config-sync packages/db/src
```

- [ ] **Шаг 2: Выполнить отдельный сценарий гонок/перезапусков**

На реальном PostgreSQL/Redis прогнать concurrent lifecycle, `4 -> 5`, `5 -> 4`,
relay crash после XADD, config-sync restart во всех трёх контрольных точках и
переходы `stopped <-> running`. Проверить один итог роли, один победивший event,
полный outbox и отсутствие преждевременного `applied`.

- [ ] **Шаг 3: Запросить независимое ревью diff**

Передать reviewer `BASE_SHA=origin/dev`, `HEAD_SHA=HEAD`, эту спецификацию и
план. Исправить все Critical/Important и повторить затронутые тесты.

- [ ] **Шаг 4: Выполнить полный локальный gate**

Run:

```bash
pnpm test:cov
pnpm turbo run typecheck
pnpm exec biome check .
pnpm turbo run build
```

Expected: нулевой код всех команд; тяжёлый набор не повторять без изменения SHA.

- [ ] **Шаг 5: Доставить по принятой модели веток**

Запушить work branch, слить напрямую в `dev` по правилам репозитория, дождаться
зелёного `ci` на точном SHA. PR не создавать. Перед production fast-forward
`dev -> master` выполнить `bash scripts/verify-done.sh` и убедиться, что SHA
достижим из `dev`.

- [ ] **Шаг 6: Выпустить в совместимом порядке**

Сначала panel API/workers с `VIP_LIFECYCLE_REQUIRE_REVISION=false`; затем сайт с
revision, свежим совместимым ISO timestamp, обработкой 409 и status polling. После отсутствия
legacy-запросов включить флаг и повторно дождаться зелёного deploy workflow.

- [ ] **Шаг 7: Выполнить боевую приёмку без идентификаторов**

Подписанным событием тестового игрока проверить preflight, accepted, outbox и
applied, затем большей revision вернуть исходное состояние. Отдельно проверить
same-event/different-body 409 и superseded status. Зафиксировать SHA, run URLs и
только агрегированные счётчики в `squad-admin-panel#5`.
