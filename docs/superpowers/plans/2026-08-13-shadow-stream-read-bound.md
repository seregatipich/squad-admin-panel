# Ограниченное чтение shadow-потоков RNSquadJS — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ограничить объём каждого `XRANGE` в ручной проверке RNSquadJS и отклонять невалидные параметры до подключения к Redis.

**Architecture:** Сценарий остаётся одним CLI-файлом. Входные параметры нормализуются до создания клиента, `readStream` запрашивает `limit + 1`, передаёт сравнению не более `limit` записей и поднимает общий флаг переполнения. Наличие флага завершает проверку fail-closed отдельным gate.

**Tech Stack:** Node.js 22, ESM, Redis Streams через ioredis, встроенный `node:test`, Biome.

## Global Constraints

- `MAX_STREAM_RECORDS` по умолчанию равен `100000`, допустимый диапазон — `1..1000000`.
- `sinceMs` и `minEvents` — безопасные целые числа не меньше нуля.
- Ошибка параметра даёт exit `2` до создания Redis-клиента.
- Переполнение любого потока даёт gate `input-limit-exceeded` и exit `1`.
- Частичная выборка никогда не может дать `pass`.
- Семантика envelope, список sidecar-событий и пороги parity/extras не меняются.

---

### Task 1: Строгая проверка числовых параметров

**Files:**
- Modify: `scripts/rnsquadjs-shadow-diff.test.ts`
- Modify: `scripts/rnsquadjs-shadow-diff.mjs`

**Interfaces:**
- Consumes: позиционные `sinceMsRaw`, `minEventsRaw` и `process.env.MAX_STREAM_RECORDS`.
- Produces: нормализованные `sinceMs`, `minEvents`, `maxStreamRecords`; ошибки CLI с exit `2`.

- [ ] **Step 1: Добавить красные проверки окна и предела**

Расширить тестовый запуск явным окружением:

```ts
function runCli(args: string[], env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, REDIS_URL, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
```

Добавить два независимых сценария:

```ts
it('rejects non-integer, negative, and non-numeric lookback windows with exit 2', () => {
  for (const window of ['-1', '1.5', 'not-a-number']) {
    const result = runCli([SERVER_ID, window, '0'], {
      REDIS_URL: 'redis://127.0.0.1:notaport',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`invalid sinceMs: ${window}`));
    assert.equal(result.stdout, '');
  }
});

it('rejects unsafe stream record limits with exit 2', () => {
  for (const limit of ['0', '-1', '1.5', 'not-a-number', '1000001']) {
    const result = runCli([SERVER_ID, '60000', '0'], {
      MAX_STREAM_RECORDS: limit,
      REDIS_URL: 'redis://127.0.0.1:notaport',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`invalid MAX_STREAM_RECORDS: ${limit}`));
    assert.equal(result.stdout, '');
  }
});
```

- [ ] **Step 2: Запустить только новые сценарии и подтвердить красное состояние**

Run:

```bash
pnpm --filter panel-bridge build
pnpm exec tsx --test --test-name-pattern='lookback windows|stream record limits' scripts/rnsquadjs-shadow-diff.test.ts
```

Expected: FAIL — текущий CLI не отклоняет `sinceMs` до Redis и игнорирует `MAX_STREAM_RECORDS`.

- [ ] **Step 3: Добавить минимальную нормализацию до создания Redis-клиента**

В `scripts/rnsquadjs-shadow-diff.mjs` заменить нестрогое вычисление окна и добавить предел:

```js
const sinceMs = Number(sinceMsRaw ?? 24 * 3600 * 1000);
if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
  console.error(`invalid sinceMs: ${sinceMsRaw}`);
  process.exit(2);
}
const minEvents = Number(minEventsRaw ?? process.env.MIN_EVENTS ?? 100);
if (!Number.isSafeInteger(minEvents) || minEvents < 0) {
  console.error(`invalid minEvents: ${minEventsRaw ?? process.env.MIN_EVENTS}`);
  process.exit(2);
}
const maxStreamRecords = Number(process.env.MAX_STREAM_RECORDS ?? 100_000);
if (
  !Number.isSafeInteger(maxStreamRecords) ||
  maxStreamRecords < 1 ||
  maxStreamRecords > 1_000_000
) {
  console.error(`invalid MAX_STREAM_RECORDS: ${process.env.MAX_STREAM_RECORDS}`);
  process.exit(2);
}
const since = Math.max(0, Date.now() - sinceMs);
```

- [ ] **Step 4: Подтвердить зелёное состояние новых и существующих проверок параметров**

Run:

```bash
pnpm exec tsx --test --test-name-pattern='minimums|lookback windows|stream record limits' scripts/rnsquadjs-shadow-diff.test.ts
```

Expected: 3 сценария PASS, 0 FAIL.

- [ ] **Step 5: Зафиксировать цикл**

```bash
git add scripts/rnsquadjs-shadow-diff.mjs scripts/rnsquadjs-shadow-diff.test.ts
git commit -m 'fix(ops): валидировать параметры shadow-diff (#282)'
```

### Task 2: Ограниченный `XRANGE` и fail-closed gate

**Files:**
- Modify: `scripts/rnsquadjs-shadow-diff.test.ts`
- Modify: `scripts/rnsquadjs-shadow-diff.mjs`

**Interfaces:**
- Consumes: `maxStreamRecords` из Task 1.
- Produces: `maxStreamRecords`, `inputLimitExceeded` в JSON-вердикте и gate `input-limit-exceeded`.

- [ ] **Step 1: Добавить красную граничную проверку**

Добавить две совпадающие записи в оба потока, запустить CLI с пределом `2` и
проверить обычный `pass`; затем добавить третью пару и проверить усечённые
счётчики и fail-closed:

```ts
it('fails closed after a bounded number of records', async () => {
  const now = new Date().toISOString();
  for (let index = 0; index < 2; index += 1) {
    const event = { type: 'player.connected', ts: now, payload: { steamId: `p-${index}` } };
    await appendEnvelope(PROD_STREAM, event);
    await appendEnvelope(SHADOW_STREAM, event);
  }

  const boundary = runCli([SERVER_ID, '60000', '2'], { MAX_STREAM_RECORDS: '2' });
  assert.equal(boundary.status, 0, boundary.stderr);
  assert.equal(verdict(boundary).inputLimitExceeded, false);
  assert.equal(verdict(boundary).prod, 2);

  const extra = { type: 'player.connected', ts: now, payload: { steamId: 'p-2' } };
  await appendEnvelope(PROD_STREAM, extra);
  await appendEnvelope(SHADOW_STREAM, extra);
  const exceeded = runCli([SERVER_ID, '60000', '2'], { MAX_STREAM_RECORDS: '2' });
  assert.equal(exceeded.status, 1);
  assert.equal(verdict(exceeded).gate, 'input-limit-exceeded');
  assert.equal(verdict(exceeded).inputLimitExceeded, true);
  assert.equal(verdict(exceeded).maxStreamRecords, 2);
  assert.equal(verdict(exceeded).prod, 2);
  assert.equal(verdict(exceeded).shadow, 2);
});
```

Во все полные ожидаемые JSON добавить литералы:

```ts
maxStreamRecords: 100_000,
inputLimitExceeded: false,
```

- [ ] **Step 2: Запустить граничный сценарий и подтвердить красное состояние**

Run:

```bash
pnpm exec tsx --test --test-name-pattern='bounded number of records' scripts/rnsquadjs-shadow-diff.test.ts
```

Expected: FAIL — текущий CLI читает третью запись и не возвращает `inputLimitExceeded`.

- [ ] **Step 3: Реализовать один ограниченный запрос на поток**

Добавить общий флаг и ограничить `readStream`:

```js
let badRecords = 0;
let inputLimitExceeded = false;
async function readStream(name) {
  const raw = await redis.xrange(name, String(since), '+', 'COUNT', maxStreamRecords + 1);
  if (raw.length > maxStreamRecords) inputLimitExceeded = true;
  const events = [];
  for (const [, fields] of raw.slice(0, maxStreamRecords)) {
    // существующая семантическая проверка envelope без изменений
  }
  return events;
}
```

Перед другими причинами отказа поставить:

```js
if (inputLimitExceeded) {
  gate = 'input-limit-exceeded';
} else if (badRecords > 0) {
  // текущие ветки gate без изменений
}
```

В JSON-вердикт добавить `maxStreamRecords` и `inputLimitExceeded`.

- [ ] **Step 4: Запустить весь профильный набор**

Run:

```bash
pnpm test:scripts
```

Expected: 10 сценариев PASS, 0 FAIL.

- [ ] **Step 5: Проверить формат и разницу**

Run:

```bash
pnpm exec biome check scripts/rnsquadjs-shadow-diff.mjs scripts/rnsquadjs-shadow-diff.test.ts
git diff --check
git diff origin/dev...HEAD
```

Expected: Biome и `diff --check` PASS; разница ограничена #282 и документами.

- [ ] **Step 6: Зафиксировать реализацию**

```bash
git add scripts/rnsquadjs-shadow-diff.mjs scripts/rnsquadjs-shadow-diff.test.ts
git commit -m 'fix(ops): ограничить чтение shadow-потоков (#282)'
```

### Task 3: Полная приёмка рабочей ветки

**Files:**
- Verify only: весь репозиторий

**Interfaces:**
- Consumes: два зелёных цикла Tasks 1–2.
- Produces: чистая отправленная ветка, пригодная к независимой приёмке и последующему слиянию в `dev`.

- [ ] **Step 1: Запустить полный локальный барьер**

Run:

```bash
bash scripts/pre-push-checklist.sh
```

Expected: все доступные обязательные шаги PASS; тесты не пропущены из-за отсутствия БД.

- [ ] **Step 2: Проверить механическое состояние**

Run:

```bash
git status --short --branch
git log --oneline origin/dev..HEAD
git diff --check origin/dev...HEAD
```

Expected: дерево чистое, только коммиты #282, ошибок разницы нет.

- [ ] **Step 3: Отправить ветку и выполнить feature-проверку**

Run:

```bash
git push -u origin fix/282-shadow-stream-bound
bash scripts/verify-done.sh --feature
```

Expected: точный `HEAD` равен удалённой ветке, происхождение от `dev` подтверждено.

- [ ] **Step 4: Оставить доказательства в #282**

Указать красные и зелёные команды, точный SHA, полный локальный барьер,
независимый вердикт и внешний блокер `dev` CI #281. Перевести задачу в Review,
но не вливать ветку до восстановления self-hosted runner.
