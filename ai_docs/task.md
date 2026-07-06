# Phase 0 — Техническое задание

**Проект:** Open-source self-hosted Squad Admin Panel
**Фаза:** Phase 0 (Foundation — full vertical slice)
**Длительность:** 8-10 недель
**Язык:** Russian (UI, docs, communication с пользователем)
**Для кого:** AI-агент или developer, реализующий P0 с нуля

---

## ⚠️ КРИТИЧЕСКАЯ ДИРЕКТИВА (прочитать ПЕРВЫМ)

**Результат твоей работы передаётся финальному пользователю — реальному администратору, который установит панель на свой production-сервер.** Это не демо, не прототип, не "первая итерация".

**Три железных правила:**

1. **Пользователю передаётся ПОЛНОСТЬЮ РАБОЧИЙ, ПОЛНОСТЬЮ СООТВЕТСТВУЮЩИЙ ТРЕБОВАНИЯМ, ЦЕЛИКОМ ФУНКЦИОНИРУЮЩИЙ, ПОЛНОСТЬЮ ОТТЕСТИРОВАННЫЙ ПРОДУКТ.** Каждое требование из §17 Acceptance criteria и §1B User stories должно работать на реальной системе, не только в теории.

2. **Агент НИКОГДА НЕ ЗАКАНЧИВАЕТ РАБОТУ, пока она не выполнена идеально.** Единственный stop-condition — полная верификация по 10 фронтам §18C и генерация `PHASE_0_COMPLETION_REPORT.md` с всеми `[x]`. Не "почти готово", не "9 из 10 работает". Все 10, по всем фронтам.

3. **TDD обязателен. Всё покрывается тестами ПО ХОДУ разработки, а не после.** Red-green-refactor цикл на каждую функцию. Тесты пишутся ДО имплементации. Без тестов код не считается написанным.

4. **Squad — single source of truth.** Ты работаешь с тем, что Squad server **реально создаёт, пишет, отдаёт по RCON и логирует**, а не с тем что предполагается в документации или PDD Appendix A. Перед имплементацией — **экспериментальная фаза §0A**: ставишь Squad руками, наблюдаешь, документируешь, обновляешь PDD/TZ под реальность. Только потом пишешь код.

**Подробные правила, acceptance matrix, verification loop, 10 фронтов качества — в §18-§20.** Экспериментальная фаза — в §0A. Прочитай их дважды.

**Прежде чем написать первую строчку кода** ты должен:
- Прочитать весь §18 (правила)
- Прочитать §18A (Definition of Done matrix)
- Прочитать §18B (verification loop)
- Прочитать §18C (10 фронтов качества)
- Прочитать §20 (формат финального report)
- **Выполнить ВСЮ §0A экспериментальную фазу с EXPERIMENT_REPORT.md**
- Понимать что остановиться раньше = невыполненная задача

---

## 0. Что нужно прочитать до начала работы

### Контекст окружения

**Репозиторий проекта:** `git@github.com:breaking-squad/squad-admin-panel.git`
**Рабочая директория агента:** `/home/squad/squad-admin-panel/` (клонировать туда)
**Экспериментальная директория:** `/home/squad/squad-experiment/` (отдельно от репо, не коммитится)
**Учётные данные sudo:** `user: squad, password: squad`
**Host OS:** Linux (Ubuntu 22.04/24.04 LTS или Debian 12)

**Самый первый шаг:** `§0A.0` — клонировать репозиторий, перейти в него, проверить что всё на месте. **Только потом** читать документы и начинать работу.

### Документы

1. **Этот документ** (`PHASE_0_TZ.md`) — он самодостаточный, всё нужное здесь. Читается целиком, не по диагонали. Особое внимание — §0A (экспериментальная фаза), §18-§20.
2. **PDD** (`squad-admin-panel-pdd.md`) — для контекста. Особенно:
   - Часть I (принципы)
   - Часть II §4.1 (архитектура)
   - Часть III (Phase 0) — product scope + technical scope + features + implementation + acceptance
   - Appendix A (Squad reference — константы, configs, RCON, log patterns) — **проверь на actual behavior через §0A**
3. **Research-документ** (если доступен) — ссылки на repos и best practices для каждой технологии.

Если что-то расходится между этим TZ и PDD — **побеждает это TZ**.
Если что-то расходится между TZ и реальным поведением Squad server — **побеждает Squad**. Squad — single source of truth для всего что связано с самим dedicated server (configs, log format, RCON protocol, файловая структура, lifecycle). См. §0A.

---

## 0A. ЭКСПЕРИМЕНТАЛЬНАЯ ФАЗА — обязательна ДО написания любого кода

### Почему это нужно

Appendix A в PDD, все regex patterns, все описания configs — **это лучший guess на основании документации и community knowledge**. Но **Squad server — non-deterministic в деталях**:
- Configs появляются не сразу после `app_update`. Большинство `*.cfg` файлов создаются сервером **при первом запуске**. Некоторые — после первого успешного match'а. Некоторые — только если в launch args передали определённые флаги.
- Файловая структура `/opt/squad-servers/{uuid}/` внутри может отличаться между Squad версиями (v10.3 vs v10.4).
- Log format может поменяться в minor Squad update — regex patterns в Appendix A могут не ловить актуальные строки.
- RCON response format `ListPlayers` может иметь variations (разные Squad versions, при 0 игроков vs при N игроков, edge cases с mod'ами).

**Ты не можешь построить работающий продукт на догадках.** Ты должен увидеть своими глазами что Squad делает, прежде чем писать код который его парсит.

### Что делать

Перед имплементацией **ты ставишь Squad-сервер руками и изучаешь что реально происходит**. Это отдельная фаза, она предшествует всему остальному.

### Доступы и репозиторий

Пользователь предоставляет доступ:
- **sudo**: `user: squad, password: squad`
- **Permissions**: на любые apt install / systemd operations / filesystem modifications что нужно для эксперимента
- **Network**: доступ в Steam CDN (steamcmd может качать), доступ к GitHub (для `git clone`)

**Репозиторий проекта:**
- URL: `git@github.com:breaking-squad/squad-admin-panel.git`
- Путь для клонирования: `/home/squad/squad-admin-panel/`
- Рабочая директория агента: `/home/squad/squad-admin-panel/`
- Экспериментальная директория (отдельно): `/home/squad/squad-experiment/`

### Шаги экспериментальной фазы

#### Шаг 0A.0 — Клонирование репозитория и подготовка рабочей директории

Перед экспериментом с Squad — получить репозиторий в рабочую директорию:

```bash
# SSH-ключ уже должен быть настроен для доступа к breaking-squad org
# Если git push/pull не работает — остановиться и спросить user'а, не пытаться обойти

cd /home/squad
git clone git@github.com:breaking-squad/squad-admin-panel.git
cd squad-admin-panel

# Проверить что репо на месте
git status
git log --oneline -5
git remote -v

# Создать отдельную директорию для экспериментальной фазы (вне репозитория, чтобы не засорять)
mkdir -p /home/squad/squad-experiment
```

**Зафиксируй в `docs/experiment/00-setup.md` (внутри репо):**
- Commit hash на который попал (`git rev-parse HEAD`)
- Current branch (`git branch --show-current`)
- Готов ли репо к работе (нет uncommitted changes)
- Путь где лежит: `/home/squad/squad-admin-panel/`
- Путь экспериментальной директории: `/home/squad/squad-experiment/` (для временных файлов Squad-сервера, не коммитится в репо)

**Важно:**
- Все коммиты делаются в `/home/squad/squad-admin-panel/`
- Временные файлы эксперимента (установленный Squad-сервер, его логи, dumps) лежат в `/home/squad/squad-experiment/` — **не** в репозитории
- Только документация эксперимента (`docs/experiment/*.md` и `docs/experiment/configs-default/*.cfg`) копируется в репо и коммитится

Если `git clone` упал (нет доступа, wrong key) — **не обходишь через https или fork**, а останавливаешься и докладываешь user'у.

#### Шаг 0A.1 — Установка чистого Squad-сервера вручную

Используй стандартный официальный процесс ([wiki.squad.com/Setting_up_a_Squad_dedicated_server](https://squad.fandom.com/wiki/Server_Administration)):

```bash
# Установить steamcmd
sudo apt update
sudo apt install -y steamcmd lib32gcc-s1 lib32stdc++6

# Установить Squad dedicated server в известную папку
mkdir -p /home/squad/squad-experiment
cd /home/squad/squad-experiment
steamcmd \
  +force_install_dir /home/squad/squad-experiment/server \
  +login anonymous \
  +app_update 403240 validate \
  +quit
```

**Зафиксируй в `docs/experiment/01-install.md`:**
- Сколько времени занял download (размер, скорость канала)
- Какой оказался итоговый объём директории
- `tree -L 2 /home/squad/squad-experiment/server/` — снимок структуры **сразу после install, до первого старта**
- Содержимое `/home/squad/squad-experiment/server/SquadGame/` — что там есть до первого старта
- **Есть ли `SquadGame/ServerConfig/` после install?** Скорее всего нет. Если есть — что в нём?
- Какие бинарники где лежат (SquadGameServer.sh, SquadGame/Binaries/Linux/SquadGameServer)

#### Шаг 0A.2 — Первый запуск сервера

Запустить сервер напрямую (не через systemd пока):

```bash
cd /home/squad/squad-experiment/server
./SquadGameServer.sh Port=7787 QueryPort=27165 BeaconPort=15000 FIXEDMAXPLAYERS=20 RANDOM=ALWAYS -log 2>&1 | tee /home/squad/squad-experiment/first-run.log
```

Дождаться когда в логе появится `LogInit: Engine is initialized` или `Server is ready for connections` (или аналогичная строка, смотри какая точно).

**Зафиксируй в `docs/experiment/02-first-run.md`:**
- Сколько времени от старта до "ready" (shader compile на первом запуске может занимать 30-120 сек)
- Какие **новые** директории и файлы появились после первого старта — сравни `tree -L 4` до и после
- **ОЖИДАЕМОЕ:** должна появиться `SquadGame/ServerConfig/` директория с `.cfg` файлами. Подтверди это.
- Список **всех** `.cfg` файлов в `SquadGame/ServerConfig/` после первого запуска — имена, размеры, их дефолтное содержимое. Скорее всего это:
  - `Server.cfg`
  - `Rcon.cfg`
  - `Admins.cfg`
  - `MapRotation.cfg`
  - `LevelRotation.cfg`
  - `Layers.cfg`
  - `LayerRotation.cfg`
  - `License.cfg`
  - `Bans.cfg`
  - `Remote.cfg` или что-то ещё
  - (точный список — зафиксировать **фактический**, не гадать)
- Содержимое каждого `.cfg` файла full dump в `docs/experiment/configs-default/{filename}.cfg`
- Файлы создались **сразу при старте** или **после ready**? Или после первого match? Проверить timestamp'ами.

#### Шаг 0A.3 — Остановка и повторный запуск

```bash
# Ctrl+C на сервере
# Wait ≤ 60 сек до clean shutdown
```

**Зафиксируй в `docs/experiment/03-shutdown.md`:**
- Сколько времени занял graceful shutdown
- Какие файлы Squad записывает при shutdown (savegames? stats? обновления configs?)
- Появились ли новые файлы после shutdown

Запустить сервер **второй раз** с тем же командой:

**Зафиксируй:**
- Время старта (должно быть быстрее — shaders cached)
- Пересоздаются ли `.cfg` файлы? Squad их трогает или оставляет в покое?
- **Что произойдёт если я изменю `Server.cfg` между запусками** — применятся ли изменения?

#### Шаг 0A.4 — RCON connection

Настроить RCON (отредактировать `Rcon.cfg` с паролем, перезапустить сервер) и подключиться клиентом:

```bash
# mcrcon или аналог
apt install -y mcrcon   # или скачать с github.com/Tiiffi/mcrcon/releases
mcrcon -H 127.0.0.1 -P 21114 -p "YOUR_PASSWORD" -t
```

**Зафиксируй в `docs/experiment/04-rcon.md`:**
- Точный формат `Rcon.cfg` (какой именно поле для пароля, какой для порта, нужна ли строка `Enabled=true`, есть ли IP whitelist)
- RCON команды которые работают и их точные response format:
  - `ListPlayers` (с 0 игроками — какой формат? с 1 игроком? с несколькими?)
  - `ListSquads`
  - `ShowCurrentMap`
  - `ShowNextMap`
  - `AdminBroadcast <message>`
  - `AdminEndMatch`
  - `AdminChangeMap <layer>`
- **Actual response bytes** — сохрани hex dump хотя бы одного RCON response для `ListPlayers` (через wireshark или tcpdump) чтобы убедиться что multi-packet handling работает как ожидается по Source RCON protocol spec

#### Шаг 0A.5 — Log parsing reality check

Подключить тестового игрока в сервер (свой Steam accounts или вторую VM с Squad client). Засечь каждое событие:

**Зафиксируй в `docs/experiment/05-log-patterns.md`:**
- Actual log line когда сервер стартовал и готов (точная строка целиком)
- Actual log line при **player join** — скорее всего это несколько строк подряд в течение миллисекунд. Сохрани их ВСЕ в правильном порядке. Это критично для correlation в worker-log-ingest.
- Actual log line при **player disconnect**
- Actual log line при **match start** и **match end**
- Actual log line при **AdminKick**, **AdminWarn**, **AdminBan** (через RCON)
- Actual log line при **chat message** (если доступно)

**Для каждого сравни с regex patterns из PDD Appendix A:**
- Совпадает regex? ✅
- Не совпадает? ❌ — зафиксируй actual pattern, обнови regex под реальность
- Есть edge cases которые Appendix A не покрывает? Зафиксируй.

**НЕ ДОВЕРЯЙ Appendix A вслепую.** Если Appendix A говорит что pattern такой-то, а в реальности в логе другой — верим реальности.

#### Шаг 0A.6 — Launch arguments experimentation

Попробовать запустить сервер с разными launch args чтобы понять что требуется:

```bash
# Минимальный набор
./SquadGameServer.sh

# С обязательными портами
./SquadGameServer.sh Port=7787 QueryPort=27165

# Полный набор из документации
./SquadGameServer.sh Port=7787 QueryPort=27165 BeaconPort=15000 FIXEDMAXPLAYERS=20 FIXEDMAXTICKRATE=50 MULTIHOME=0.0.0.0 RANDOM=ALWAYS -log
```

**Зафиксируй в `docs/experiment/06-launch-args.md`:**
- Какие args **обязательны** (сервер падает без них)
- Какие args **необязательны** (дефолты работают)
- Какие args имеют **квирки** (например `-log` — что даёт?)
- Ошибки которые возникают при отсутствии args — текст ошибок

#### Шаг 0A.7 — systemd unit test

Написать прототип systemd unit на основе наблюдений из §0A.1-0A.6 и template из §8 TZ. Установить его вручную, запустить сервер через systemctl.

**Зафиксируй в `docs/experiment/07-systemd.md`:**
- Итоговый unit file который **реально работает** в твоей тестовой environment
- Работает ли `TasksMax=infinity` (должен — UE5 spawns много threads)
- Работают ли **все** hardening directives из template без проблем? Если `MemoryDenyWriteExecute=true` ломает сервер (что маловероятно, UE5 не JIT-ит) — зафиксируй и убери
- `systemd-analyze security squad-server-{uuid}` — что показывает
- Test crash recovery: `kill -9` Squad process → systemd рестартит? Через сколько секунд?
- Test graceful stop: `systemctl stop` → сколько занимает shutdown?

#### Шаг 0A.8 — A2S query from outside

С другой машины (или через тест A2S-клиент):

```bash
# Установить python-a2s или аналог
pip install python-a2s
python -c "import a2s; print(a2s.info(('VM_IP', 27165)))"
```

**Зафиксируй в `docs/experiment/08-discovery.md`:**
- Работает ли A2S query? Какой response format?
- **Appears ли сервер в Steam Server Browser → Community Servers?** Сделай screenshot, зафиксируй через сколько секунд после старта появился
- Какие поля в A2S response используемы (current players, max players, map name, game name)

#### Шаг 0A.9 — Experiment report

После завершения всех 8 шагов — consolidate findings в **`docs/experiment/EXPERIMENT_REPORT.md`**:

```markdown
# Squad Server Experiment Report

**Date:** YYYY-MM-DD
**VM:** Ubuntu 22.04 LTS, 8 GB RAM, 150 GB disk
**Squad version tested:** v10.X (какая актуальная на момент эксперимента)
**SteamCMD version:** X.Y
**Time to install:** N minutes, M GB downloaded

## Key findings

### 1. Config files lifecycle
- Configs создаются при **[first start / install / first match / etc]** — точный ответ с доказательствами
- Full list of .cfg files создаваемых Squad: [список]
- [Какие-либо квирки]

### 2. Squad directory structure (actual)
[tree output + аннотации что где]

### 3. Log patterns (actual vs PDD Appendix A)
| Pattern | PDD Appendix A regex | Actual log line | Match? | Action |
|---|---|---|---|---|
| server.ready | ... | ... | ✅ / ❌ | [если ❌ — updated regex] |
| player.connected | ... | ... | ... | ... |
[etc]

### 4. RCON protocol findings
- Exact ListPlayers response format (с примерами для 0/1/N players)
- Any version-specific quirks
- Multi-packet behaviour verified with hex dump

### 5. Launch arguments — required vs optional
[table]

### 6. systemd integration
- Unit file что работает
- Shutdown timing
- Crash recovery timing
- hardening directives compatibility

### 7. Steam Server Browser discovery
- Screenshot of server visible
- Time from start to appearance

### 8. Deviations from PDD / TZ assumptions

Если что-то в PDD или TZ оказалось неверным — **зафиксируй явно**:
- Appendix A pattern X предполагал regex `...` — actual `...`, updated
- TZ §8 предполагал unit template `...` — MemoryDenyWriteExecute вызвал проблему — removed / kept after investigation
- etc

### 9. Updates applied to TZ / PDD

Список изменений в `squad-admin-panel-pdd.md` Appendix A или в `PHASE_0_TZ.md` §X — на что исправлено based on findings.

### 10. Ready to proceed?

[x] Все 8 экспериментальных шагов выполнены
[x] Все findings documented
[x] PDD/TZ updated where reality differed
[x] Squad server устанавливается, запускается, принимает RCON, парсится, виден извне
[x] Confident that Phase 0 implementation will build on accurate foundation

---

**Signed off to start main implementation.**
```

### Шаг 0A.10 — Обновление PDD и TZ based on findings

Если в experiment report выявлены расхождения с тем что написано в PDD Appendix A или в этом TZ — **ты обязан их исправить**:
- Открыть `squad-admin-panel-pdd.md` → Appendix A → внести corrections с комментарием `<!-- Updated per experiment 2026-MM-DD -->`
- Открыть `PHASE_0_TZ.md` → §8, §9, §10, другие affected секции → внести corrections с комментарием
- Commit отдельно от кода: `docs: update PDD/TZ per Squad server experiment findings`

**Только после этого** ты начинаешь имплементацию по обновлённым спецификациям.

### Почему эта фаза не опциональна

**Без неё ты будешь писать код на предположениях.** И на неделю 5 из 10 обнаружишь что `player.connected` regex ловит 80% случаев, а 20% edge cases (игроки с EOS-only без Steam, reconnect'ы, timeouts) не ловит — и тогда переписывать worker-log-ingest целиком.

**С experiment phase** ты потратишь 1-2 дня, но:
- Regex'ы валидированы на реальных логах
- Systemd unit проверен в реальных условиях
- RCON protocol прогнан через hex dump
- Все assumptions в TZ обновлены реальностью

**Это инвестиция с ROI.** Делается один раз перед всей остальной работой.

### Блокеры в экспериментальной фазе

Если в ходе эксперимента ты упираешься в то что не можешь объяснить:
- Squad не запускается — какая ошибка? — пытаешься разобраться сам, если не получается — документируешь в `docs/experiment/blockers.md` и спрашиваешь пользователя
- RCON не коннектится — debug через tcpdump / wireshark, проверяешь `Rcon.cfg`, проверяешь firewall, читаешь server log

**Не идёшь дальше пока предыдущий шаг не понятен.** Основанная на непонимании имплементация — гарантированный fail.

---

## 1. Цель P0

В конце P0 у администратора стоит работающий Squad-сервер, которым он управляет через веб-панель, и он видит в реальном времени кто на него подключился.

Формально — это **проверяемый end-to-end сценарий:**

> Админ берёт чистую Linux-машину (Ubuntu 22.04/24.04 LTS или Debian 12+), делает `git clone && docker compose up -d`, проходит setup wizard, нажимает в UI "Install new server", ждёт 30-60 минут пока скачается Squad depot (90-110 GB), нажимает "Start". Открывает Squad-клиент на другой машине, находит свой сервер в Steam Server Browser → Community Servers, подключается. **В UI панели на другом tab'е через 30 секунд появляется его SteamID, никнейм, EOS ID, время подключения.** В audit log — все admin actions. Всё работает на трёх чистых VM трёх distributions подряд с `docker compose down -v` между прогонами.

Это **не** скелет и **не** прототип. Это минимальный работающий продукт. Всё что не входит в scope — либо работает на реальных данных, либо не делается вообще.

---

## 1A. Персоны (кто пользуется панелью)

### Администратор-владелец (Owner)
Создатель/хозяин community. Поднимает панель на своём сервере, ставит Squad-сервер, приглашает admin'ов. Технически грамотный (умеет ssh в Linux, знает что такое Docker), но не sysadmin-эксперт. Хочет «поставить и работать», без настройки ansible/terraform/k8s. Боится что что-то сломает сервер.

**Основные цели:**
- Быстро поднять панель на своей машине без боли
- Поставить Squad-сервер без ручной возни со steamcmd
- Не думать о security (TLS, RBAC, audit — "работает из коробки")
- Видеть что происходит на его сервере

### Младший админ (Admin / Senior Admin)
Модератор сервера, которого Owner пригласил. В P0 функции ограничены (старт/стоп сервера, просмотр игроков). Большинство модерационных действий (kick/warn/ban) в Phase 1.

**Основные цели в P0:**
- Войти в панель, понять статус серверов
- Видеть кто сейчас играет
- При необходимости рестартить зависший сервер

### Наблюдатель (Viewer)
Read-only доступ. Например, помощник сообщества, которому показывают статистику. В P0 — минимум: видит список серверов и их статус, не может ничего менять.

### Не-персона: игрок Squad
Игрок, который подключается к серверу, в P0 **не взаимодействует с панелью напрямую**. Он просто играет в Squad как обычно. Панель его *видит* (записывает его в БД через RCON + logs), но ему самому от панели ничего не нужно.

### Пакетная персона: "developer, поднимающий панель впервые"
Из открытых источников (GitHub README). Решает попробовать. Эта персона — главный экзамен для UX P0. Если quickstart занимает > 15 минут (не считая SteamCMD download) — мы проиграли. Большинство пользователей ожидают опыта "n8n self-hosted" / "Immich" / "Outline".

---

## 1B. User stories

Формат: **As [персона], I want [действие] so that [finality]**.

Приоритет: P0 = обязательно в этой фазе. После каждой story — acceptance criteria.

### US-01. Первая установка панели
**As** developer/owner впервые поднимающий панель,
**I want** поднять всю систему одной командой из чистого git-clone,
**so that** могу оценить продукт за 15 минут (не считая SteamCMD download).

**Acceptance:**
- `git clone` → `cp .env.example .env` (и отредактировать одну строку `APP_DOMAIN=`) → `sudo ./scripts/install-host-bridge.sh` → `docker compose up -d` → открыть браузер → увидеть setup wizard
- Всё должно сработать за ≤ 5 минут до момента когда браузер показывает wizard
- Никаких "теперь ещё поставь nginx / отредактируй /etc/postgresql / создай пользователя в БД руками"

### US-02. First-run setup
**As** owner впервые открывший панель,
**I want** создать организацию и свой аккаунт через дружелюбный wizard,
**so that** получить рабочую систему без необходимости разбираться в конфигах.

**Acceptance:**
- Wizard проводит по шагам: welcome → check пререк → create org → create owner → verify bridge → generate encryption key → success
- Каждый шаг объясняет что происходит 1-2 предложениями на русском
- Если check пререк упал (неподдерживаемый дистрибутив, bridge не активен) — показывает что именно сломано и как чинить
- Повторное открытие `/setup` после успешного завершения → 410 Gone, redirect на `/login`

### US-03. Вход с 2FA
**As** owner,
**I want** защитить свой аккаунт двухфакторной аутентификацией,
**so that** даже утечка пароля не даст доступ к админ-панели с правом остановить мой продакшн-сервер.

**Acceptance:**
- В `/settings/account` нажал "Enable 2FA" → QR code + manual entry key
- Сохранил в Authenticator app (Google Authenticator / Authy / 1Password)
- Ввёл текущий TOTP код → 2FA включён
- Одновременно получил 8 backup codes для сохранения
- Следующий login: email + password → требует TOTP
- Потерял phone → ввёл backup code → залогинен; тот же код повторно → rejected
- Rate-limit на login: 5 попыток / 15 минут per IP

### US-04. Главный dashboard
**As** владелец/админ зашедший в панель,
**I want** увидеть одну страницу где сразу понятно состояние системы,
**so that** могу быстро оценить "всё нормально или надо вмешиваться?".

**Acceptance:**
- `/dashboard` показывает:
  - Host info card: hostname, OS, kernel, CPU model + cores, RAM used/total, disk used/total на `/opt/squad-servers`
  - Bridge status card: connected/disconnected, version, uptime
  - Servers summary: сколько установлено, сколько running, сколько failed
  - Last 10 events (мини-feed): `server.start`, `player.connected`, etc.
- Метрики live-обновляются каждые 5-10 сек
- Если что-то критичное (bridge disconnected, нет PostgreSQL) — красный баннер сверху

### US-05. Установка первого Squad-сервера
**As** owner,
**I want** установить Squad-сервер через wizard в UI,
**so that** не нужно вручную читать docs про SteamCMD, systemd unit и launch arguments.

**Acceptance:**
- `/servers/new` запускает wizard
- Шаг 1 — Basic info: имя, slug, description
- Шаг 2 — Network: порты (game/query/beacon/RCON) — auto-suggest свободные через bridge scan
- Шаг 3 — Server settings: max_players (default 100), tickrate (default 50), multihome (default 0.0.0.0)
- Шаг 4 — Advanced (collapsed by default): resource limits (все поля пустые → no limits), extra launch args
- Шаг 5 — Review → "Install"
- На клике "Install":
  - API создаёт `servers` record со status=`installing`
  - Opens WebSocket → streams progress:
    - `📦 Installing system dependencies...` (apt_install)
    - `⬇️ Downloading Squad server (0% → 100%)...` (steamcmd, real-time прогресс)
    - `📝 Generating configs...`
    - `⚙️ Writing systemd unit...`
    - `🔥 Configuring firewall...`
    - `✅ Server ready`
- После завершения: status=`ready`, server виден в таблице
- Если что-то упало (нет места на диске, SteamCMD timeout) — понятная error message, status=`failed`, в `/audit` — запись с полным context

### US-06. Запуск Squad-сервера и появление в Steam browser
**As** owner с установленным сервером,
**I want** запустить его и убедиться что игроки могут к нему подключиться,
**so that** знаю что мой сервер действительно работает.

**Acceptance:**
- В `/servers` или `/servers/{id}` нажал "Start"
- Status переходит `ready` → `running`
- Карточка сервера через 30-60 сек показывает: uptime растёт, player count 0, current map (из RCON)
- Сервер **появляется в Steam Server Browser → Community Servers** — это проверяется руками с другого компа
- Открыл Squad-клиент на другой машине → Server Browser → фильтр по имени моего сервера → виден → кнопка Connect работает

### US-07. Увидеть реальных игроков на сервере
**As** админ,
**I want** видеть кто сейчас играет на моём сервере,
**so that** мог бы понять если происходит что-то необычное (слишком мало игроков, знакомые никнеймы читеров, etc).

**Acceptance:**
- На `/servers/{id}` секция "Live players" обновляется каждые 30 сек
- Для каждого игрока показывается: никнейм, SteamID64 (с link на Steam profile), EOS ID, duration на сервере, team/squad (если RCON позволяет)
- Новый игрок зашёл → через ≤ 30 сек виден в списке
- Игрок вышел → через ≤ 60 сек пропадает из live list, но остаётся в `/players` с обновлённым `last_seen_at`
- В `/players` полный список всех кто когда-либо был (с поиском по nickname и SteamID)

### US-08. История никнеймов игрока
**As** админ расследующий инцидент (жалоба "меня обидел игрок X, но он сменил ник"),
**I want** видеть всю историю никнеймов конкретного игрока,
**so that** могу идентифицировать его независимо от текущего ника.

**Acceptance:**
- Open `/players/{steam_id64}` → показывает canonical_name + all historical names в хронологическом порядке
- Каждая запись имеет first_seen_at, last_seen_at, observation_count
- Игрок заходит под новым ником → через ≤ 30 сек new row в `player_name_history`

### US-09. Управление жизненным циклом сервера
**As** админ,
**I want** stop/restart сервер одним кликом,
**so that** могу применить config changes, перезагрузить после crash или задеплоить обновление.

**Acceptance:**
- Stop button → confirmation dialog ("Are you sure? Current match will end") → click confirm
- Graceful sequence (видимый в UI): AdminBroadcast "Server shutting down in 60s" → wait → AdminEndMatch → systemctl stop → через ≤ 60 сек status=`stopped`
- Restart button → stop + start, status возвращается `running`
- Force-stop option (kill -9) — есть, но за extra confirmation
- Crash автоматически восстанавливается (systemd Restart=on-failure), UI отражает: был running → кратко failed → снова running

### US-10. Audit log просмотр
**As** owner заподозривший что admin сделал что-то лишнее,
**I want** посмотреть полный лог действий через UI,
**so that** могу провести расследование.

**Acceptance:**
- `/audit` — пагинированная таблица: timestamp, actor (user display_name + email), action, target, status code, duration
- Фильтры: by actor, by action_type, by time range, by target_type
- Клик на строку → detailed view с before/after snapshots (JSON-diff viewer)
- Невозможно редактировать или удалять записи (DB triggers) — видно что поле disabled в UI и объяснение
- `scripts/verify-audit-chain.ts` (out-of-band) может валидировать что chain не нарушен

### US-11. Resource limits (optional, advanced)
**As** owner запускающий несколько Squad-серверов на одной машине,
**I want** ограничить использование CPU/RAM каждым сервером,
**so that** один лагающий сервер не положит остальные.

**Acceptance:**
- По умолчанию в wizard лимитов **нет** (секция collapsed, fields empty)
- Развернул секцию "Advanced → Resource limits" → поля CPUAffinity, CPUWeight, MemoryHigh, MemoryMax, Nice, IOWeight
- Заполнил только те что нужны (например MemoryMax=12G) → panel генерирует drop-in `.service.d/limits.conf` только с этим ключом
- Пустые поля → соответствующие ключи отсутствуют в drop-in
- Удалил все лимиты через редактирование — drop-in file удаляется

### US-12. Остановка и очистка системы
**As** пользователь тестирующий панель,
**I want** полностью удалить установку (containers + volumes + Squad servers + systemd units) одной командой,
**so that** могу попробовать снова или перенести на другую машину.

**Acceptance:**
- `./scripts/uninstall.sh` (идёт в комплекте) — запрашивает confirmation, удаляет:
  - `docker compose down -v` (containers + volumes)
  - Все squad-server-*.service units (stop + disable + rm)
  - `/opt/squad-servers/*` files (опционально с confirm)
  - `panel-host-bridge.service` + socket
  - `panel` group
- После этого `./scripts/install-host-bridge.sh` + `docker compose up -d` снова работает с нуля

---

## 1C. Use cases (end-to-end flows)

### UC-01. Happy path: от нуля до работающего сервера с игроком

**Precondition:** чистая Ubuntu 22.04 / 24.04 LTS / Debian 12 VM с 8GB RAM, 150GB disk, доступ по ssh.

1. Owner: `git clone https://github.com/org/squad-admin-panel`
2. Owner: `cp .env.example .env`, редактирует `APP_DOMAIN=admin.my-community.com`, `POSTGRES_PASSWORD=...`, `APP_ENCRYPTION_KEY=$(openssl rand -base64 32)`
3. Owner: `sudo ./scripts/install-host-bridge.sh` → устанавливает bridge daemon, добавляет текущего user в группу panel
4. Owner: logout + login (чтобы активировалась новая группа), `docker compose up -d`
5. Waits ≤ 120 сек → `docker compose ps` shows all healthy
6. Open `https://admin.my-community.com` в браузере → redirect на `/setup`
7. Setup wizard: welcome → env check (passes) → create org "My Community" → create user (owner@my-community.com, password "correct horse battery staple") → verify bridge (connected) → save encryption key → success
8. Redirect на `/login` → login с созданными creds
9. Dashboard показывает: host info (VM specs), bridge connected, 0 servers
10. Owner: enable 2FA в `/settings/account` → scan QR → confirm TOTP → save backup codes → 2FA enabled
11. Logout → login → требует TOTP → success
12. Click "Install new server"
13. Wizard: name "Main", slug auto → "main", ports auto-suggested (7787/27165/15000/21114), RCON password auto-gen, max_players 100, tickrate 50, no resource limits, no extra args → Review → Install
14. WebSocket progress stream: apt install (~30 сек) → SteamCMD download (~45 min для 95GB) → generate configs → write systemd unit → daemon-reload → ufw rules → complete
15. Server row status = `ready`
16. Click "Start" → status `starting` → через ≤ 60 сек `running`, карточка показывает uptime, 0 players, current map (из RCON — например `Jensens_Range_v1`)
17. **Тестер** на другой машине: Squad game client → Server Browser → Community → find "Main" by name → Connect → **подключился**
18. На owner'овом экране в `/servers/main` секция Live players через ≤ 30 сек показывает тестера: SteamID64, nickname, EOS ID, duration "5s" → "1m" → "2m"
19. Owner открывает `/players` → новая запись тестера; click → видит `player_name_history` с одной записью
20. Тестер disconnects → через ≤ 60 сек пропадает из Live list, но `/players/{id}` показывает `last_seen_at` = 2 minutes ago
21. Owner: Stop → confirm → AdminBroadcast visible in game → AdminEndMatch → server shutting down → status `stopped` через ≤ 60 сек
22. Owner: `/audit` → видит все свои actions от setup до stop в chronological order

**Time budget:** ≤ 15 минут до шага 14 (начало SteamCMD). ≤ 2 часов итого с учётом SteamCMD download. Всё после SteamCMD — минуты.

### UC-02. Пригласить второго админа

*В Phase 0 этот flow частично: создание пользователя через API / psql, но полноценного invite UI нет. Отмечаю что в P0 допустим manual workaround, полноценный invite flow — Phase 1.*

**Phase 0 fallback:** Owner через `psql` или API creates user + role assignment; передаёт credentials out-of-band. Acceptance: роли работают (Admin может Start/Stop сервер, Viewer — нет).

### UC-03. Сервер упал — диагностика

1. Squad server crashed (например OOM если нет лимитов и RAM закончился)
2. systemd Restart=on-failure перезапускает автоматически через 10 сек
3. В `/servers/{id}` history показывает `server.crashed` event + `server.restarted` (via systemd)
4. В `/audit` — эти события с `actor_kind=system`
5. Owner может посмотреть последние логи через UI (базовый log viewer из events table)

*Полноценный log viewer с фильтрами и tail — Phase 1. В P0 события + audit достаточны для понимания что было.*

### UC-04. Обновление Squad-сервера

1. Offworld releases Squad v10.4
2. Owner: `/servers/{id}` → "Update server" button → `steamcmd_run +app_update 403240 validate`
3. WebSocket progress stream показывает download
4. После завершения — server restart (если был running)
5. Audit: `server.updated` entry с before/after version

### UC-05. Бэкап и восстановление (автоматический)

1. Daily cron 3:00 AM: restic sidecar runs
2. pg_dump дампит PostgreSQL → restic → S3/local
3. Redis BGSAVE → dump copy → restic
4. Keeps: 7 daily / 4 weekly / 6 monthly, prunes старые
5. Если диск кончился / S3 unreachable → alert в GlitchTip

*Restore UI — Phase 1 (в P0 restore делается вручную через `restic restore` CLI).*

### UC-06. Viewer-only experience

1. Owner через psql / minimal API создаёт Viewer user
2. Viewer заходит → видит `/dashboard`, `/servers` (read-only), `/players` (без IP — permission `player:view_ips` gated), `/audit`
3. Все write buttons отсутствуют или disabled
4. Попытка `POST /api/v1/servers` через curl → 403
5. Попытка `DELETE /api/v1/servers/{id}` → 403

---

## 1D. Желаемый функционал (functional requirements)

### 1D.1 Must-have в P0

**Установка и setup**
- [x] One-command bootstrap (git clone → docker compose → wizard)
- [x] Detect неподдерживаемый дистрибутив и дать понятную ошибку
- [x] Setup wizard с checkpoint'ами (если упал посередине — можно продолжить)
- [x] Генерация APP_ENCRYPTION_KEY с инструкцией куда сохранить

**Auth**
- [x] Email+password registration (только owner на setup — в P0 нет self-service signup)
- [x] Login с rate-limit
- [x] 2FA TOTP с backup codes
- [x] Steam OpenID 2.0 — stub endpoints (возвращают 501), scaffolding готов
- [x] Discord OAuth — stub endpoints, scaffolding готов
- [x] Session management (logout везде, rotate on privilege change)
- [x] Password change в `/settings/account`

**RBAC**
- [x] 4 system roles: Owner, Senior Admin, Admin, Viewer с правильными permissions
- [x] Permission keys registry на backend и frontend
- [x] UI отражает permissions: disabled buttons если no permission, hidden sections

**Host management**
- [x] Dashboard host info (OS, CPU, RAM, disk, network)
- [x] Live metrics (refresh 5-10s)
- [x] Bridge status + version

**Server management — CRUD**
- [x] Install new server wizard
- [x] View server details (status, config, settings)
- [x] Edit server settings (name, description, tags, resource limits)
- [x] Delete server (с confirmation, удаляет files + systemd unit)
- [x] Server list с filtering, sorting

**Server lifecycle**
- [x] Start / Stop / Restart с WebSocket status updates
- [x] Graceful stop через RCON AdminBroadcast
- [x] Force-stop option (kill -9)
- [x] Auto-restart on crash (systemd)

**Server monitoring**
- [x] Real-time player list (RCON poll 30s)
- [x] Current map (RCON ShowCurrentMap)
- [x] Player count
- [x] Uptime
- [x] A2S query для Steam Browser presence check

**Players**
- [x] List all players (searchable by nickname, SteamID)
- [x] Individual player page (history of names, IPs — permission-gated, first/last seen, time played)
- [x] Auto-tracking (new player appears when first joins)

**Events**
- [x] Парсинг SquadGame.log (5 critical patterns)
- [x] RCON polling events
- [x] Storage в events table (partitioned)
- [x] Basic viewer в `/servers/{id}` (last 50 events)

**Audit**
- [x] Automatic audit для всех mutation endpoints
- [x] Hash-chain через DB triggers
- [x] UI viewer с фильтрами
- [x] CI тест на audit coverage всех routes

**Operations**
- [x] Docker compose с healthchecks
- [x] Automatic backups через restic
- [x] Error tracking через GlitchTip (optional profile)
- [x] Structured JSON logs
- [x] Prometheus metrics

### 1D.2 Nice-to-have (если есть бюджет)

- [ ] Dark mode toggle (Tailwind / next-themes позволяют легко)
- [ ] Export audit log в CSV
- [ ] Простой search bar в header (global jump-to-page)
- [ ] Keyboard shortcuts (Ctrl+K jump-to)
- [ ] Desktop notifications при server crash (Web Push API)

### 1D.3 Explicitly out-of-scope в P0

- ❌ Monaco config editor (Phase 1)
- ❌ Git-versioned config history (Phase 1)
- ❌ Drift detection (Phase 1)
- ❌ Moderation UI (kick/warn/ban buttons) — (Phase 1)
- ❌ Whitelist / Admins.cfg sync (Phase 1)
- ❌ Live chat viewer (Phase 1)
- ❌ Manual backup trigger / restore UI (Phase 1)
- ❌ i18n EN/RU switcher (Phase 1)
- ❌ User invite flow с email (Phase 1)
- ❌ Public stats portal (Phase 2)
- ❌ Discord bot (Phase 2)
- ❌ Player flags, counters (Phase 2)
- ❌ Triggers, scheduler, alerts (Phase 2)
- ❌ Map voting, team balancer (Phase 3)
- ❌ Cheater detection (Phase 4 🔮)

---

## 1E. Non-functional requirements (количественные)

### 1E.1 Performance

- **Page load (TTFB):** ≤ 500ms для `/dashboard`, `/servers`, `/audit` (с сетью localhost)
- **Server install total time:** ≤ 60 минут (95GB SteamCMD depot на 200Mbps канале)
- **Server start time:** ≤ 60 сек от "click Start" до status=`running` с loaded map
- **Player appearance latency:** ≤ 30 сек от real connection в Squad до visible в UI panel player list
- **RCON poll interval:** 30 сек (hard-coded в P0, настраиваемо в Phase 1)
- **Log ingest latency:** ≤ 2 сек от log line в SquadGame.log до event в Redis Stream

### 1E.2 Reliability

- **Uptime target** (в рамках P0 acceptance testing): > 99% на одной VM за 7 дней непрерывной работы
- **Crash recovery:** все сервисы auto-restart (Docker `restart: unless-stopped`, systemd `Restart=on-failure`)
- **Data durability:**
  - PostgreSQL dump каждые 24 часа
  - Redis BGSAVE каждый backup run
  - Squad server files на volume (не ephemeral в контейнерах)
  - restic encrypted backups с 7/4/6 retention
- **Graceful shutdown:** все services обрабатывают SIGTERM, flush'ат pending writes, closing connections корректно

### 1E.3 Security

- **TLS:** обязательно (Caddy automatic Let's Encrypt в prod, internal CA в dev)
- **Password hashing:** Argon2id, OWASP 2024 params (memory 64MB, time 3, parallelism 1)
- **2FA:** доступно, рекомендовано для Owner
- **Session tokens:** opaque в PostgreSQL (не JWT), rotate on privilege change
- **CSRF:** Origin/Referer check на mutating methods + `__Host-sid` cookie prefix
- **Rate limit:** 5 login attempts / 15 min per IP, 300 API req / min per user
- **RBAC:** granular permissions, clearance levels
- **Audit:** append-only через DB triggers, hash-chain
- **Encryption at rest:** RCON passwords + license keys через AES-256-GCM app-level
- **Bridge:** socket activation + SO_PEERCRED + whitelist validation + systemd hardening
- **Secrets в env:** `.env.example` с комментариями; SOPS+age documented upgrade path

### 1E.4 Resource footprint

На idle (0 Squad servers) весь panel stack:
- **RAM:** ≤ 2 GB (PostgreSQL ~200MB, Redis ~50MB, API ~150MB, Web ~150MB, Workers ~50MB each, Caddy ~30MB, bridge ~15MB)
- **CPU:** ≤ 5% idle single core (only healthchecks and background polls)
- **Disk:** ≤ 500MB для Docker images + ~200MB для logs over a week

На 1 running Squad server + 100 players:
- Squad server: ~10-12 GB RAM, 2-4 cores 80-100% utilization (не наш компонент, но учесть)
- Panel overhead: +50MB RAM (worker-log-ingest active, worker-rcon + 1 TCP connection), +~2% CPU

### 1E.5 Compatibility

- **OS:** Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Debian 12 (testing matrix)
- **Arch:** x86_64 only в P0 (ARM — Phase 2+ возможно)
- **Docker:** ≥ 24.x (Compose v2)
- **Browser** (для UI): current Chrome, Firefox, Safari, Edge. IE не поддерживается.
- **Squad version:** v10.x (протестировано с baseline v10.3 март 2026). UE5-migration-related квирки учтены в log patterns.

### 1E.6 Developer experience

- **Время локального запуска dev environment:** ≤ 5 минут от clone до "работающий `pnpm dev` с hot reload"
- **CI pipeline time:** ≤ 10 минут для full check (typecheck + lint + tests + build)
- **Unit test coverage:** ≥ 80% на `apps/bridge/internal/validate/` (security-critical), ≥ 60% overall
- **Integration tests:** бегут на каждом PR, используют mock SteamCMD depot (pre-seeded fixture)

---

## 1F. Finalities (чётко измеримые конечные состояния)

После завершения Phase 0 **должно быть истинно** каждое из следующих утверждений. Если хоть одно не выполнено — P0 не готов.

### 1F.1 Система существует и устанавливается

- [ ] Репозиторий публично доступен на GitHub (или на том хостинге который выберет owner)
- [ ] README.md содержит рабочий quickstart для всех трёх distros
- [ ] `CONTRIBUTING.md` описывает dev workflow
- [ ] LICENSE file присутствует (MIT или другая выбранная)
- [ ] Есть скрипт `scripts/install-host-bridge.sh` который идемпотентен
- [ ] Есть скрипт `scripts/uninstall.sh`
- [ ] CI GitHub Actions зелёный на main
- [ ] Docker images собраны и опубликованы в ghcr.io с тегом `v0.1.0-p0` и `latest`

### 1F.2 Пользователь может использовать

- [ ] Одна команда `docker compose up -d` поднимает весь stack
- [ ] Через 2 минуты — setup wizard доступен в браузере
- [ ] Setup wizard завершается за ≤ 5 минут активных действий
- [ ] Owner login работает
- [ ] 2FA включается и работает
- [ ] Install new server wizard работает end-to-end
- [ ] SteamCMD download виден как progress в UI
- [ ] Сервер запускается и виден в Steam Server Browser
- [ ] Игрок подключается и появляется в UI ≤ 30 сек

### 1F.3 Фундамент готов для Phase 1

- [ ] PostgreSQL schema финальная — все FK ссылаются на `players.steam_id64` (bigint PK)
- [ ] Event envelope schema финализирована, версионирование через upcast-on-read
- [ ] Redis Streams consumer pattern с XAUTOCLAIM + DLQ + dual-layer idempotency работает
- [ ] Все 14 bridge RPC methods функциональны и покрыты тестами
- [ ] Audit trail hash-chain валидируется скриптом
- [ ] RBAC permission keys registry готов — новые permissions добавляются через INSERT, не миграции
- [ ] Route metadata pattern для audit + permissions применён везде
- [ ] CI тест "все mutations имеют config.audit" passes

### 1F.4 Quality gates

- [ ] 3 × clean VM test passed (3 runs × 3 distros = 9 clean installs всё ок)
- [ ] Real player end-to-end test passed (тестер в Squad client → виден в UI)
- [ ] All 13 acceptance блоков §17 have all items checked
- [ ] Unit test coverage ≥ 80% на security-critical code
- [ ] Integration test suite passes in ≤ 5 минут
- [ ] Zero critical/high security issues в `pnpm audit`
- [ ] Zero critical Go vulnerabilities в `govulncheck ./...`
- [ ] `systemd-analyze security panel-host-bridge` → score < 3.0 (exposure: safe/exposed)

### 1F.5 Documentation готова

- [ ] `README.md` с quickstart
- [ ] `docs/architecture.md` с диаграммой + объяснением components
- [ ] `docs/bridge-protocol.md` — полный wire format, все 14 methods
- [ ] `docs/event-envelope.md` — envelope shape, versioning rules
- [ ] `docs/rbac.md` — permission keys, clearance levels
- [ ] `docs/development.md` — как setup local dev, run tests
- [ ] `docs/security.md` — threat model, attack surface, hardening details
- [ ] `docs/troubleshooting.md` — common issues (SteamCMD fails, bridge not connecting, etc.)
- [ ] API `OpenAPI 3.1` spec auto-generated, доступен на `/api/docs` (Swagger UI)
- [ ] `PHASE_0_COMPLETION_REPORT.md` committed в repo с полным чеклистом + screenshots

### 1F.6 "Smell test" — признаки что P0 настоящий, а не Potemkin

- [ ] На running Squad server можно **действительно** играть (не симуляция, реальный game build)
- [ ] Подключение реального игрока **реально** видно в panel UI (не stub event)
- [ ] Панель можно оставить running 7 дней без вмешательства — не падает, метрики корректные, бэкапы идут
- [ ] Second VM с другим distro — всё повторяется без правок кода (только `.env` значения меняются)
- [ ] Кто-то извне (не разработчик) может поднять панель по README за разумное время — feedback сессия с 1-2 тестерами до release

---

## 1G. Что будет нельзя / что сломается если не учесть

Эти пункты — "chekhov's guns": если их не реализовать в P0, они выстрелят в Phase 1-2 и потребуют рефакторинга ядра.

### 1G.1 Identity model
Если `players` таблица без `steam_id64 PRIMARY KEY` (например UUID + steam_id column) — в Phase 1 при добавлении bans/warns/notes все FK будут через UUID, придётся либо переделывать на bigint (огромная миграция с даунтаймом), либо жить с лишним join'ом. **Сейчас дёшево, позже дорого.**

### 1G.2 Audit enforcement
Если audit добавить как application-level middleware без DB triggers — появится первая miss (где кто-то забыл обернуть route в audit wrapper). В Phase 2 при расследовании инцидента обнаружится что недостаёт записей. Восстановить их невозможно. **DB triggers + CI test делают это невозможным с P0.**

### 1G.3 Event envelope
Если envelope начать сразу с flat structure (без version/correlation_id) — в Phase 2 при добавлении alert engine потребуется backfill/breaking change. **Envelope финализирован в P0 — последующие фазы только добавляют типы.**

### 1G.4 Bridge scope
Если в P0 реализовать только 4-5 методов bridge (ping, host_info, host_metrics, bridge_status) — при старте Phase 1 "давайте добавим установку серверов" выяснится что steamcmd_run, apt_install, systemctl_write_unit нужны все сразу, а валидация whitelist не отработана. **В P0 все 14 — в тесте пусть 10 не используется, но infrastructure готова.**

### 1G.5 RBAC granularity
Если начать с enum ролей ("owner", "admin", "viewer") — первый раз когда понадобится особая роль "Moderator которая может kick но не ban" потребует миграции и переписывания permission checks везде. **С permission keys как строк — новый permission это строчка в seed.**

### 1G.6 Next.js middleware
Если положить auth check в middleware.ts — CVE-2025-29927 показала что это fundamentally broken pattern. Исправление требует редизайна auth flow. **Сразу делаем layout-based DAL.**

### 1G.7 No-default resource limits
Если в main systemd unit template прописать MemoryMax по умолчанию — первый же пользователь с powerful VM получит "сервер тупит с 40 игроками" потому что OOM killer бьёт. Диагностика непонятная. **Default no limits, opt-in через UI.**

### 1G.8 RNSquadJS coupling
Если "интегрироваться через их плагин" или subtree — (а) не можем двигаться самостоятельно, (б) их breaking changes ломают нас, (в) пользователь вынужден ставить оба. **Полная независимость в P0 = навсегда самодостаточная панель.**

---

## 1H. Экран за экраном (screens specification)

Описание всех UI-экранов P0 на уровне "что видит пользователь" (не implementation detail). Порядок — как пользователь их встречает.

### Screen 1: `/setup` (first-run wizard)

**Route group:** public (no auth required)
**Visible only when:** БД пустая (нет organizations)
**После completion:** 410 Gone на всех `/api/v1/setup/*` endpoints

**Шаг 1: Welcome**
- Logo + заголовок "Добро пожаловать в Squad Admin Panel"
- 2-3 предложения о том что сейчас произойдёт
- Кнопка "Начать установку"

**Шаг 2: Environment check**
- Автоматически вызывает `GET /api/v1/setup/check-env`
- Показывает:
  - OS distro + version — ✅ или ❌ with explanation
  - Kernel version — informational
  - Available disk space на /opt — ✅ / ⚠️ (< 150GB warning)
  - Docker version — ✅ или ❌
  - Bridge status — ✅ connected / ❌ not found
- Если все ✅ — кнопка "Далее"
- Если ❌ — объяснение как починить + кнопка "Проверить снова"

**Шаг 3: Создание организации**
- Поле: "Название сообщества" (пример: "My Squad Community")
- Поле: "Slug" (auto-generated from name, editable, lower-case kebab)
- Кнопка "Далее"

**Шаг 4: Создание owner-аккаунта**
- Поле: Email (валидация формата)
- Поле: Display name
- Поле: Password (min 12 chars, strength meter)
- Поле: Confirm password
- Кнопка "Создать аккаунт"

**Шаг 5: Encryption key**
- Показывает сгенерированный ключ: `APP_ENCRYPTION_KEY=...`
- Инструкция: "Сохраните этот ключ в ваш .env файл. Без него вы не сможете расшифровать сохранённые пароли RCON-серверов после перезапуска."
- Copy button
- Checkbox "Я сохранил ключ в .env"
- Кнопка "Далее" (disabled пока checkbox не отмечен)

**Шаг 6: Setup complete**
- "Установка завершена!"
- Summary: организация X, user Y создан с Owner role
- Кнопка "Перейти ко входу" → redirect `/login`

### Screen 2: `/login`

- Email field
- Password field
- "Запомнить меня" checkbox (extends session)
- Кнопка "Войти"
- Links: "Войти через Steam" (disabled, tooltip "Доступно в Phase 1"), "Войти через Discord" (disabled)
- Forgot password link (в P0 — "Обратитесь к администратору"; Phase 1 — email reset flow)

**После login (если 2FA включён):**
- Новый экран: "Введите код из Authenticator app"
- 6-digit input с auto-advance
- Link "Использовать backup code" → textarea для 8-digit code
- Кнопка "Подтвердить"

**После успешного login:** redirect на next URL (из query) или `/dashboard`

### Screen 3: `/dashboard`

Header: logo, hamburger menu (nav), user menu (avatar, display name, logout)
Left sidebar: Dashboard / Servers / Players / Audit / Settings

**Main area:**
- Row 1: Four stat cards — "Servers: 3 (2 running)", "Players online: 47", "Bridge: connected", "Alerts: 0"
- Row 2: Host info card (hostname, OS, CPU, RAM used%, disk used%, network rates)
- Row 3: Recent events feed (last 10) — timestamp, event type icon, short description
- Row 4: Servers quick-view (mini-cards, клик → `/servers/{id}`)

### Screen 4: `/servers`

- Header: "Серверы" + кнопка "+ Установить новый"
- Table columns: Status indicator (coloured dot), Name, Players (current/max), Current Map, Uptime, Actions (start/stop/restart/⋮)
- Filter bar: search by name, filter by status
- Pagination если > 10 серверов
- Пустое состояние: "У вас нет серверов. Нажмите 'Установить новый' для начала"

### Screen 5: `/servers/new` (install wizard)

**Шаг 1: Базовая информация**
- Name
- Slug (auto-generated)
- Description (optional)

**Шаг 2: Network**
- Game port (default 7787, auto-suggest next available)
- Query port (default 27165)
- Beacon port (default 15000)
- RCON port (default 21114)
- Multihome (default 0.0.0.0)

**Шаг 3: Настройки сервера**
- Max players (default 100, slider 1-100)
- Tickrate (default 50, options: 30/40/50)

**Шаг 4: Дополнительно (collapsed)**
- Extra launch args (textarea)
- Launch args override (textarea, advanced)
- Resource limits section (collapsed):
  - CPU Affinity (optional)
  - CPU Weight (optional, default empty)
  - Nice (optional)
  - Memory High (optional, GB input)
  - Memory Max (optional, GB input)
  - IO Weight (optional)

**Шаг 5: Review + Install**
- Summary всех настроек
- Warning: "Установка займёт 30-60 минут в зависимости от канала"
- Кнопка "Установить"

**After click Install:**
- Redirect на `/servers/{uuid}` со статусом `installing`
- Модальное окно с live progress log (WebSocket stream)
- Cancel button (confirm dialog)

### Screen 6: `/servers/{id}`

**Header:** server name + status indicator + actions menu (Edit settings, Update, Delete)

**Top row cards:**
- Status card: status, uptime, player count, current map, tickrate
- RCON card: connected/disconnected, latency, last poll time
- Resource usage card: CPU%, RAM used from process_info

**Controls row:** Start / Stop / Restart buttons (с confirmation dialogs)

**Tabs:**
- **Overview** — live player list (table: nickname, SteamID64 link, EOS ID, team/squad if available, duration)
- **Events** — last 50 events for this server
- **Settings** — read-only view of current settings, link to "Edit"
- **Console** (Phase 1) — link placeholder

### Screen 7: `/players`

- Search bar (by nickname, by SteamID64)
- Table: Current/last nickname, SteamID64 (with Steam profile link), EOS ID, Last seen, Total time played, Online status (green dot if currently online)
- Pagination
- Click row → `/players/{steam_id64}`

### Screen 8: `/players/{steam_id64}`

- Top card: current nickname (canonical_name), SteamID64, EOS ID, first/last seen
- Tabs:
  - **Nickname history** — table of all known names, first/last seen, observation count
  - **IP history** — permission-gated (only visible if user has `player:view_ips`)
  - **Sessions** (Phase 1) — placeholder "Available in Phase 1"
  - **Notes** (Phase 1) — placeholder

### Screen 9: `/audit`

- Filters: actor, action_type, target_type, time range
- Table: Timestamp, Actor, Action, Target, Status, Duration
- Click row → modal with full details (before/after snapshots, context, request_id)
- Export CSV button (nice-to-have)
- "Verify chain integrity" button (manual trigger for hash-chain check)

### Screen 10: `/settings/account`

- Profile section: email (read-only in P0), display name (editable), change password form
- 2FA section: status (enabled/disabled), enable flow (QR), manage backup codes, disable flow (requires current TOTP)
- Sessions section: list of active sessions (device, IP, last seen), logout-all button

### Screen 11: Error / empty states

- 404: "Страница не найдена"
- 401: auto-redirect на `/login`
- 403: "У вас нет прав для этого действия"
- 500: "Что-то сломалось. Мы уже получили отчёт" (+ link на GlitchTip issue)
- Empty server list: "У вас нет серверов. Install new server?"
- No audit events: "История действий пуста"
- No players: "Ни один игрок ещё не подключался"

---

## 2. Границы скоупа

### 2.1 Внутри скоупа (делаем в P0)

#### Foundation / инфраструктура
- Monorepo (pnpm workspaces + Turborepo 2.x) с TS project references, Biome 2.x, Lefthook
- PostgreSQL 16 со **всеми** таблицами (финальная схема — дальнейшие фазы только добавляют данные, не переделывают структуру)
- Drizzle ORM 0.45.x с forward-only миграциями через `drizzle-kit`
- Redis 7 Streams с consumer groups, XAUTOCLAIM reclaimer, DLQ, dual-layer idempotency
- Docker Compose с healthchecks на каждом сервисе, Caddy 2 с dual-mode TLS (internal в dev, Let's Encrypt в prod)
- Observability — Pino JSON logs с redaction, Prometheus `/metrics`, health/ready endpoints, GlitchTip 6 для error tracking
- restic sidecar для backup'ов (cron 3:00 AM)

#### Auth & access
- Oslo (`@oslojs/*`) + Arctic (не Lucia — deprecated с марта 2025, не Better Auth — Next.js-shaped)
- Email+password с Argon2id через `@node-rs/argon2` (OWASP 2024 params)
- 2FA TOTP через `@oslojs/otp` + backup codes
- Steam OpenID 2.0 (custom verifier ~40 строк — native auth libs не умеют OpenID 2.0)
- Discord OAuth 2.0 через Arctic (в P0 — scaffolding, stub endpoints 501; full flow в Phase 1)
- Granular RBAC с `clearance_level 0-1000` + permission keys как строки (не enum)
- Setup wizard (first-run создаёт первую организацию + owner user)
- Sessions — opaque ID в PostgreSQL + Redis write-through cache (НЕ JWT — нужна revocation), cookie `__Host-sid`, rotate на login/2FA/role change

#### `panel-host-bridge` (Go 1.22+ daemon)
Все 14 методов **работают реально** (не stubs). systemd socket activation, SO_PEERCRED + panel group check, hand-rolled length-prefixed JSON-RPC (4-byte BE uint32 + JSON payload, MaxFrame 1 MiB).

Методы:
1. `ping()`
2. `host_info()` — hostname, OS, kernel, CPU, RAM total
3. `host_metrics()` — CPU%, RAM used/total, disk, network rates
4. `systemctl_action(unit, action)` — start/stop/restart/status/enable/disable для pattern `^squad-server-[a-f0-9-]{36}\.service$` или `panel-host-bridge`
5. `systemctl_write_unit(name, content)` — pattern `squad-server-*.service` only, path `/etc/systemd/system/`
6. `systemctl_read_unit(name)`
7. `systemctl_daemon_reload()`
8. `steamcmd_run(args)` — whitelist: только `+login anonymous`, `+force_install_dir` под `/opt/squad-servers/`, `+app_update 403240` с/без validate, `+quit`, `+@ShutdownOnFailedCommand 1`, `+@NoPromptForPassword 1`, `+@sSteamCmdForcePlatformType linux`. Streaming stdout через отдельный RPC channel.
9. `apt_install(packages)` — whitelist 14 пакетов: `lib32gcc-s1`, `lib32stdc++6`, `libc6-i386`, `libsdl2-2.0-0:i386`, `curl`, `wget`, `ca-certificates`, `tar`, `locales`, `file`, `bsdmainutils`, `python3`, `tmux`, `screen`. Regex имя пакета `^[a-z0-9][a-z0-9+\-.]{1,63}$`. `apt-get -y -o DPkg::Lock::Timeout=120 install` + `DEBIAN_FRONTEND=noninteractive`.
10. `file_read(path)` — `filepath.Clean` + allowlist roots `/opt/squad-servers/`, `/etc/systemd/system/squad-server-*.service`. Reject `..`, non-absolute, или outside allowlist.
11. `file_write(path, content, mode)` — те же правила
12. `file_atomic_write(path, content, mode)` — `.new → rename(2)` с backup `.bak`
13. `process_info(pid)` — `/proc/{pid}/*` read (проверяем что pid принадлежит squad-server unit)
14. `journalctl_follow(unit, since?)` — streaming subscription для squad-server-* units
15. `ufw_rule(action, port, proto, comment)` — add/remove

systemd unit hardening bundle (полный `NoNewPrivileges=yes`, `ProtectSystem=strict`, `SystemCallFilter=@system-service ~@debug @mount @swap @reboot @obsolete @cpu-emulation`, trimmed `CapabilityBoundingSet`, `MemoryDenyWriteExecute=yes`, etc.). Target: `systemd-analyze security` < 3.0.

Static build: `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"` → 6-10 MB binary.

#### Server lifecycle — реальная установка
- `POST /api/v1/servers` + install flow через UI wizard:
  - валидация портов (auto-suggest свободных через bridge)
  - auto-gen RCON пароль (32 random chars)
  - `apt_install(dependencies)` через bridge
  - `steamcmd_run(+force_install_dir /opt/squad-servers/{uuid}/ +app_update 403240 validate)` с streaming WebSocket progress в UI
  - Generate minimal `ServerConfig/Server.cfg` + `ServerConfig/Rcon.cfg`
  - Generate `squad-server-{uuid}.service` из template (Appendix A PDD)
  - `systemctl_daemon_reload` + `systemctl enable squad-server-{uuid}`
  - `ufw_rule add` для game/query/beacon/RCON портов
- Lifecycle actions (Start/Stop/Restart) через UI кнопки → bridge systemctl_action
- Graceful shutdown: RCON AdminBroadcast "Server shutting down" → AdminEndMatch → systemctl stop → TimeoutStopSec=60

#### Discovery & health
- `GET /api/v1/servers/{id}/status` — A2S query (port=query_port, 28ms timeout) + process_info через bridge
- **Сервер появляется в Steam Server Browser → Community Servers** (проверяется руками)
- Health card в UI: status, uptime, player count (из A2S), current map (из RCON `ShowCurrentMap`), tickrate

#### Log ingestion — реальный парсинг
`worker-log-ingest` парсит `SquadGame.log` через `journalctl_follow` + file tail. Минимум 5 critical patterns:

```
LogInit: Engine is initialized                              → server.ready
LogNet: Join succeeded: {name}                              \
LogEOS: [EOS Connection] ... {eos_id} Steam:{steam_id64}    } → player.connected (correlation)
LogNet: UChannel::Close: ...UniqueId: EOS:{eos}|STEAM:{sid} → player.disconnected
LogGameMode: Match State Changed from ... to InProgress     → match.started
LogGameMode: Match State Changed from InProgress to Waiting → match.ended
```

Каждый event → `EventEnvelope` (UUIDv7 event_id, version=1, type, server_id, ts UTC, payload) → `XADD events:server:{uuid}`.

#### RCON integration — реальный TCP
`worker-rcon` держит TCP connection к каждому running серверу на `127.0.0.1:{rcon_port}`. Source RCON protocol: AUTH → EXECCOMMAND → multi-packet response через empty-ping trick. Keepalive каждые 90 сек (< default SecondsBeforeTimeoutCheck=120). Reconnect с exponential backoff (1s→60s).

Poll loop каждые 30 сек:
- `ListPlayers` → parse regex → UPSERT players + player_name_history
- EOS ID correlation с Steam
- Publish `rcon.players_polled` event

#### Player identity
`players.steam_id64` — **PRIMARY KEY bigint** (не UUID). EOS ID, battle_eye_guid, last_known_ip — колонки. Username history в `player_name_history` (FK на steam_id64). IP history в `player_ip_history`.

При каждом ListPlayers poll:
```sql
INSERT INTO players (steam_id64, canonical_name, eos_id, first_seen_at, last_seen_at)
VALUES (...) ON CONFLICT (steam_id64) DO UPDATE SET
  last_seen_at = now(),
  canonical_name = EXCLUDED.canonical_name,
  eos_id = COALESCE(EXCLUDED.eos_id, players.eos_id)
WHERE players.canonical_name != EXCLUDED.canonical_name OR players.eos_id IS DISTINCT FROM EXCLUDED.eos_id;

INSERT INTO player_name_history (steam_id64, name, name_normalized, ...)
VALUES (...) ON CONFLICT (steam_id64, name_normalized) DO UPDATE SET
  last_seen_at = now(), observation_count = player_name_history.observation_count + 1;
```

#### Audit log — append-only с hash-chain
DB triggers enforce:
- `BEFORE INSERT` вычисляет `prev_hash` через LAG и `row_hash = sha256(prev_hash || canonicalized(row))`
- `BEFORE UPDATE/DELETE` raises exception `audit_log is append-only`
- Serialize inserts через `pg_advisory_xact_lock(hashtextextended('audit_log',0))`

Audit как **route config metadata**:
```ts
app.route({
  method: 'POST', url: '/servers',
  config: {
    permissions: ['server:create'],
    audit: { action: 'server.create', resource: 'server' },
  },
  handler: async (req) => { /* ... */ },
});
```

**Unit test в CI сканирует все routes** и assert'ит что каждый POST/PATCH/PUT/DELETE имеет `config.audit` (или explicitly `audit: false`). Забыть невозможно — тест падает.

#### Event envelope + Redis Streams
```ts
const EventEnvelope = z.object({
  event_id: z.string().uuid(),       // UUIDv7
  version: z.number().int().positive(),
  type: z.string(),                  // 'player.connected', 'server.ready', ...
  server_id: z.string().uuid().nullable(),
  ts: z.string().datetime(),
  actor: z.object({ kind: z.enum(['user','system','external']), id: z.string().nullable() }).nullable(),
  correlation_id: z.string().uuid().nullable(),
  payload: z.unknown(),
});
```

Dual-layer idempotency (**обязательно для всех consumers**):
1. Redis: `SET dedup:${group}:${event_id} 1 EX 86400 NX` (fast, in-memory)
2. PG: `INSERT INTO processed_events (event_id, group_name) ON CONFLICT DO NOTHING` (durable)

XACK только на success. DEL dedup при failure → retry разрешён.
XAUTOCLAIM reclaimer — 30s tick, 120s idle threshold.
DLQ — после 5 deliveries move в `events:dlq` stream.

Consumer group naming: `<service>:v<schema-version>` (например `players-projector:v1`). При breaking change handler — bump до v2, новая group с нуля.

#### Web UI — Next.js 15 App Router
- Stack: Next.js 15, App Router, TypeScript strict, Tailwind v4.1.x, shadcn/ui (new-york, OKLCH), next-themes, TanStack Query v5, react-hook-form, next-intl v4
- **CRITICAL: middleware НЕ auth gate** (CVE-2025-29927). Middleware только для cookie-presence redirect. Real check в `layout.tsx` через DAL `requireSession()` с `react.cache()` dedup.
- Typed API client через `@hey-api/openapi-ts` с `@tanstack/react-query` plugin (options-based helpers)

Страницы P0:
- `/setup` — first-run wizard (welcome → check Linux distro/deps → create first org → create owner user → verify bridge → generate APP_ENCRYPTION_KEY → success)
- `/login` — email + password + TOTP (если включён) + backup code fallback
- `/dashboard` — host info card (hostname, OS, kernel, CPU, RAM, disk) + bridge status + список серверов с их статусом + last 10 events
- `/servers` — таблица с колонками (name, status, players, map, uptime, actions)
- `/servers/new` — install wizard с WebSocket progress stream
- `/servers/{id}` — детали: health card, live player list (обновляется каждые 30 сек), last 50 events, controls (Start/Stop/Restart), optional resource limits section (default off)
- `/audit` — paginated audit log (actor, action, target, timestamp, before/after)
- `/settings/account` — профиль + 2FA management

#### Firewall
При install — `panel-host-bridge.ufw_rule add` для game/query/beacon портов. RCON порт — только для 127.0.0.1 (RCON доступен только через worker-rcon внутри compose сети).

### 2.2 Вне скоупа (Phase 1+)

**Phase 1** (7-9 недель после P0):
- Monaco config editor с git-versioning (history, diff, rollback)
- Config drift detection (сравнение git HEAD с filesystem)
- License Management UI (LicenseId/LicenseKey ввод, валидация)
- Server Groups & Tags UI
- Moderation actions через RCON (Kick/Warn/Ban с evidence, UI buttons на карточке игрока)
- Whitelist / Admin Groups UI + генерация Admins.cfg + atomic push через bridge
- Live chat viewer (парсинг chat lines из SquadGame.log → WebSocket stream в UI)
- Manual Backup UI (trigger backup, browse, restore flow)
- i18n EN/RU

**Phase 2+:**
- Player queries / alt detection, flags, counters
- Triggers, scheduler, alerts
- Discord integration, analytics, public portal

**НИКОГДА:**
- Модификации / форки RNSquadJS. Он остаётся опциональным внешним контейнером. Панель работает **без** него. Если админ хочет использовать RNSquadJS параллельно — они работают независимо, каждый со своим RCON connection на один Squad-сервер (помни про limit "1 RCON per source IP" — на локальном хосте это работает).

---

## 3. Архитектура

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Linux host (Ubuntu/Debian)                        │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                     Docker Compose stack                     │       │
│  │                                                              │       │
│  │  ┌─────────┐    ┌─────────┐    ┌──────────┐                 │       │
│  │  │  Caddy  │───▶│   Web   │    │   API    │                 │       │
│  │  │  (TLS)  │    │ Next.js │    │ Fastify  │                 │       │
│  │  └─────────┘    └─────────┘    └────┬─────┘                 │       │
│  │                                      │                       │       │
│  │                                 ┌────▼────┐                  │       │
│  │                                 │  Redis  │                  │       │
│  │                                 │ Streams │                  │       │
│  │                                 └──┬───┬──┘                  │       │
│  │                                    │   │                     │       │
│  │            ┌───────────────────────┤   ├─────────────┐       │       │
│  │            │                       │   │             │       │       │
│  │      ┌─────▼───────┐      ┌───────▼───▼───┐   ┌─────▼─────┐ │       │
│  │      │worker-log-  │      │    Workers    │   │ Postgres  │ │       │
│  │      │ingest       │      │ audit-arch,   │   │  (all     │ │       │
│  │      │worker-rcon  │      │ event-part,   │   │  panel    │ │       │
│  │      │             │      │ stubs others  │   │  data)    │ │       │
│  │      └─────┬───────┘      └─────┬─────────┘   └───────────┘ │       │
│  │            │                     │                           │       │
│  │            │              ┌──────┴──────┐                    │       │
│  │            │              │ unix socket │                    │       │
│  │            │              │ /run/panel- │                    │       │
│  │            │              │ host-bridge │                    │       │
│  │            │              └──────┬──────┘                    │       │
│  └────────────┼─────────────────────┼───────────────────────────┘       │
│               │ RCON+logs           │ bind-mount                         │
│               │ (127.0.0.1)         │ + peer credentials                 │
│               │                     │                                    │
│               │             ┌───────▼────────────────┐                   │
│               │             │  panel-host-bridge     │ (native systemd)  │
│               │             │  - Go 1.22, 6-10MB    │                   │
│               │             │  - JSON-RPC framed     │                   │
│               │             │  - Systemd ops         │                   │
│               │             │  - steamcmd, apt, ufw  │                   │
│               │             │  - SO_PEERCRED auth    │                   │
│               │             └───────┬────────────────┘                   │
│               │                     │ systemctl                          │
│               │                     │                                    │
│               │             ┌───────▼────────────────────────┐           │
│               └────────────▶│  Squad servers (native systemd) │          │
│                             │  squad-server-{uuid}.service   │           │
│                             │  /opt/squad-servers/{uuid}/    │           │
│                             └────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Ключевые принципы:**
1. Panel в Docker, Squad-сервера нативно (не Docker). Связь через bridge.
2. RNSquadJS **не** в этой диаграмме — внешний опциональный проект.
3. `panel-host-bridge` — единственный компонент с privileged операциями (root). Все остальные non-root.

---

## 4. Стек технологий (точные версии)

| Слой | Технология | Версия |
|---|---|---|
| Package manager | pnpm | 9.x |
| Task runner | Turborepo | 2.x |
| Lint/format | Biome | 2.x |
| Git hooks | Lefthook | latest |
| Node | Node.js LTS | 22.x |
| Go | Go | 1.22+ |
| Web framework | Next.js | 15.x App Router |
| UI | Tailwind + shadcn/ui | v4.1.x + new-york |
| Forms | react-hook-form + Zod | latest + v4 |
| Client state | TanStack Query | v5 |
| i18n (P1) | next-intl | v4 |
| API framework | Fastify | 4.x |
| OpenAPI | fastify-type-provider-zod | latest (turkerdev) |
| Auth | Oslo (`@oslojs/*`) + Arctic | latest |
| Password hash | `@node-rs/argon2` | latest |
| TOTP | `@oslojs/otp` | latest |
| ORM | Drizzle | 0.45.x |
| DB | PostgreSQL | 16 |
| Cache/Bus | Redis | 7 |
| Redis client | ioredis | 5.10+ |
| Worker queue (опц.) | BullMQ | latest |
| Logging | Pino | 9.x |
| Metrics | prom-client | 15+ |
| Reverse proxy | Caddy | 2.8+ |
| Error tracking | GlitchTip | 6 |
| Backup | restic (через mazzolino/restic) | latest |
| UUID | `uuid` | v11 (UUIDv7) |

**Запрещено:**
- Lucia v3 (deprecated март 2025)
- Better Auth / Auth.js как primary (Next.js-shaped, Steam не поддерживается)
- pgcrypto для encryption at rest (используем app-level AES-256-GCM)
- Husky + lint-staged (используем Lefthook)
- ESLint + Prettier (используем Biome)
- citext (используем functional `lower(email)` unique index)
- bcrypt (используем Argon2id)
- speakeasy (unmaintained с 2017; используем @oslojs/otp)

---

## 5. Структура монорепо

```
squad-admin-panel/
├── apps/
│   ├── api/                           # Fastify REST API
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── auth/              # login, logout, 2fa, steam, discord
│   │   │   │   ├── setup/
│   │   │   │   ├── servers/           # CRUD + install/start/stop + status
│   │   │   │   ├── players/
│   │   │   │   ├── audit/
│   │   │   │   ├── host/              # bridge proxy endpoints
│   │   │   │   └── _ws/               # WebSocket endpoints
│   │   │   ├── plugins/               # fastify plugins (auth, audit, rate-limit)
│   │   │   ├── middleware/
│   │   │   ├── lib/
│   │   │   │   ├── bridge-client.ts
│   │   │   │   ├── crypto.ts          # AES-256-GCM
│   │   │   │   ├── rcon-client.ts     # Source RCON protocol
│   │   │   │   └── steam-openid.ts    # Steam OpenID 2.0 verifier
│   │   │   └── index.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── web/                           # Next.js 15 App Router
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (auth)/            # login, setup routes
│   │   │   │   ├── (dashboard)/       # protected routes с requireSession()
│   │   │   │   │   ├── layout.tsx     # real auth gate
│   │   │   │   │   ├── dashboard/
│   │   │   │   │   ├── servers/
│   │   │   │   │   ├── audit/
│   │   │   │   │   └── settings/
│   │   │   │   └── layout.tsx
│   │   │   ├── components/ui/         # shadcn/ui
│   │   │   ├── lib/
│   │   │   │   ├── dal.ts             # server-only, requireSession()
│   │   │   │   ├── api-client.ts      # @hey-api/openapi-ts generated
│   │   │   │   └── query-client.ts
│   │   │   ├── middleware.ts          # cookie-presence only
│   │   │   └── styles/
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── bridge/                        # Go panel-host-bridge
│   │   ├── cmd/panel-host-bridge/
│   │   │   └── main.go
│   │   ├── internal/
│   │   │   ├── rpc/                   # framing + dispatch + method enum
│   │   │   ├── auth/                  # SO_PEERCRED + group check
│   │   │   ├── sysd/                  # go-systemd dbus wrapper
│   │   │   ├── pkgmgr/                # apt
│   │   │   ├── runner/                # exec.Runner interface
│   │   │   ├── fsx/                   # whitelisted fs ops
│   │   │   └── validate/              # request validators
│   │   ├── deploy/
│   │   │   ├── panel-host-bridge.service
│   │   │   └── panel-host-bridge.socket
│   │   ├── Makefile
│   │   └── go.mod
│   └── workers/
│       ├── log-ingest/                # FUNCTIONAL в P0
│       ├── rcon/                      # FUNCTIONAL в P0
│       ├── audit-archiver/            # functional
│       ├── event-partition/           # functional (cron monthly)
│       ├── stats/                     # stub
│       ├── automation/                # stub
│       ├── discord/                   # stub
│       ├── scheduler/                 # stub
│       ├── backup/                    # stub (restic в отдельном sidecar)
│       └── config-sync/               # stub
├── packages/
│   ├── shared-types/                  # Zod schemas (events, API models)
│   ├── shared-config/                 # permission keys registry, constants
│   ├── db/                            # Drizzle schema + migrations
│   │   ├── src/schema/
│   │   ├── drizzle/                   # generated migrations
│   │   └── drizzle.config.ts
│   └── bridge-client/                 # TS client for Go bridge
├── scripts/
│   ├── install-host-bridge.sh         # идемпотентный installer
│   ├── verify-bridge.sh               # manual test through nc
│   └── verify-audit-chain.ts          # validate hash-chain
├── docker/
│   ├── api.Dockerfile
│   ├── web.Dockerfile
│   └── worker.Dockerfile
├── docs/
│   ├── architecture.md
│   ├── bridge-protocol.md
│   ├── event-envelope.md
│   ├── rbac.md
│   └── development.md
├── docker-compose.yml
├── docker-compose.dev.yml
├── .env.example
├── turbo.json
├── pnpm-workspace.yaml
├── biome.json
├── lefthook.yml
├── tsconfig.base.json
└── README.md
```

**Нет** `apps/connector/`. Нет плагинов RNSquadJS.

---

## 6. Database schema (финальная)

### 6.1 Drizzle schema organization

```
packages/db/src/schema/
├── users.ts
├── sessions.ts
├── user-identities.ts
├── user-api-tokens.ts
├── organizations.ts
├── organization-members.ts
├── roles.ts
├── role-permissions.ts
├── role-server-scopes.ts
├── user-role-assignments.ts
├── servers.ts
├── server-credentials.ts
├── server-settings.ts
├── players.ts
├── player-name-history.ts
├── player-ip-history.ts
├── events.ts
├── processed-events.ts
├── audit-log.ts
├── index.ts                           # re-exports
└── relations.ts
```

`drizzle.config.ts` → `schema: "./src/schema/*.ts"`.

### 6.2 Ключевые таблицы (SQL)

```sql
-- ==========================================================================
-- IDENTITY & AUTH
-- ==========================================================================
users (
  id uuid primary key default uuidv7(),       -- app-side через uuid@^11
  email text not null,
  password_hash text not null,                -- Argon2id
  display_name text,
  totp_secret_encrypted bytea,                -- AES-256-GCM
  totp_key_version int default 1,
  totp_backup_codes_hash text[],              -- Argon2id on each
  totp_last_used_step int,                    -- prevent replay window
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
-- unique index: lower(email) — functional, не citext

sessions (
  id text primary key,                        -- opaque session ID (не JWT)
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
)
-- PG source-of-truth; Redis hot cache с TTL 10min (write-through)

user_identities (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('steam','discord','eos')),
  external_id text not null,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique(kind, external_id)
)

user_api_tokens (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null,                   -- sha256 (or argon2id)
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
)

-- ==========================================================================
-- ORGANIZATIONS / RBAC
-- ==========================================================================
organizations (
  id uuid primary key default uuidv7(),
  name text not null,
  slug text not null unique,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
)

organization_members (
  user_id uuid not null references users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  primary_role_id uuid references roles(id),
  joined_at timestamptz not null default now(),
  primary key (user_id, org_id)
)

roles (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  clearance_level int not null default 0 check (clearance_level between 0 and 1000),
  is_system_role boolean not null default false,
  created_at timestamptz not null default now(),
  unique(org_id, name)
)

role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_key text not null,               -- строка: "server:view", "ban:create", ...
  primary key (role_id, permission_key)
)

role_server_scopes (
  role_id uuid not null references roles(id) on delete cascade,
  server_id uuid references servers(id) on delete cascade,  -- null = applies to all
  primary key (role_id, coalesce(server_id, '00000000-0000-0000-0000-000000000000'))
)

user_role_assignments (
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  primary key (user_id, role_id)
)

-- ==========================================================================
-- SERVERS
-- ==========================================================================
servers (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations(id) on delete cascade,
  display_name text not null,
  slug text not null,
  description text,
  status text not null default 'pending'
    check (status in ('pending','installing','ready','running','stopped','failed')),
  tags text[] not null default '{}',
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, slug)
)

server_credentials (
  server_id uuid primary key references servers(id) on delete cascade,
  rcon_host text not null default '127.0.0.1',
  rcon_port int not null,
  rcon_password_encrypted bytea not null,     -- AES-256-GCM
  license_key_encrypted bytea,                -- AES-256-GCM, nullable до Phase 1
  key_version int not null default 1
)

server_settings (
  server_id uuid primary key references servers(id) on delete cascade,
  install_path text not null,                 -- /opt/squad-servers/{uuid}/
  game_port int not null,
  query_port int not null,
  beacon_port int not null,
  rcon_port int not null,
  max_players int not null default 100,
  tickrate int not null default 50,
  multihome inet,                             -- 0.0.0.0 default
  extra_args text not null default '',
  launch_args_override text,
  -- Resource limits — все nullable, default NULL = no limit.
  -- Panel генерирует drop-in limits.conf только с non-null полями.
  cpu_affinity text,                          -- '0 1 2 3' или '0-7'
  cpu_weight int,                             -- cgroup-v2 shares, 1-10000
  niceness int,                               -- -20 до 19
  memory_high_mb int,                         -- soft throttle
  memory_max_mb int,                          -- hard kill
  io_weight int                               -- cgroup-v2 I/O shares
)

-- ==========================================================================
-- PLAYERS — steam_id64 = PRIMARY KEY
-- ==========================================================================
players (
  steam_id64 bigint primary key,              -- 17-digit SteamID64 как int64
  canonical_name text not null,
  canonical_name_normalized text not null,
  eos_id text,                                -- 32-hex chars, nullable
  battle_eye_guid text,
  last_known_ip inet,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  total_time_played_seconds bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
-- unique(eos_id) where eos_id is not null  -- detect collisions → alert
-- btree(canonical_name_normalized)
-- btree(last_seen_at desc)

player_name_history (
  id bigserial primary key,
  steam_id64 bigint not null references players(steam_id64) on delete cascade,
  name text not null,
  name_normalized text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  observation_count int not null default 1,
  unique(steam_id64, name_normalized)
)
-- btree(name_normalized)
-- btree(last_seen_at desc)

player_ip_history (
  id bigserial primary key,
  steam_id64 bigint not null references players(steam_id64) on delete cascade,
  ip inet not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  observation_count int not null default 1,
  unique(steam_id64, ip)
)
-- btree(ip) — alt detection

-- ==========================================================================
-- EVENTS — partitioned by month
-- ==========================================================================
events (
  event_id uuid not null,
  server_id uuid references servers(id) on delete cascade,
  occurred_at timestamptz not null,
  kind text not null,                         -- 'player.connected', 'match.started', ...
  version int not null default 1,
  actor_kind text,
  actor_id text,
  correlation_id uuid,
  payload jsonb not null,
  primary key (event_id, occurred_at)
) partition by range (occurred_at);

-- Setup через миграцию:
-- CREATE EXTENSION pg_partman; CREATE EXTENSION pg_cron;
-- SELECT partman.create_parent(
--   p_parent_table := 'public.events', p_control := 'occurred_at',
--   p_type := 'native', p_interval := '1 month', p_premake := 4);
-- UPDATE partman.part_config SET retention='24 months', retention_keep_table=false
--   WHERE parent_table='public.events';
-- SELECT cron.schedule('partman-hourly','@hourly','CALL partman.run_maintenance_proc()');

-- Indexes on parent (propagate PG 11+):
-- BRIN on occurred_at (tiny, perfect для append-only)
-- B-tree (server_id, occurred_at desc)
-- Partial B-tree (kind, occurred_at desc) WHERE kind IN ('player.connected','player.disconnected','rcon.players_polled')

processed_events (                             -- durable idempotency
  event_id uuid primary key,
  group_name text not null,
  processed_at timestamptz not null default now()
)

-- ==========================================================================
-- AUDIT LOG — append-only via DB triggers, hash-chain
-- ==========================================================================
audit_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  actor_user_id uuid references users(id),
  actor_ip inet,
  actor_kind text not null default 'user',
  action_type text not null,                  -- 'server.create', 'user.login', ...
  target_type text,
  target_id text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  context jsonb not null default '{}',        -- reqId, correlation_id, duration, ...
  org_id uuid references organizations(id),
  prev_hash bytea,
  row_hash bytea not null
);

CREATE OR REPLACE FUNCTION audit_log_append() RETURNS trigger AS $$
DECLARE prev bytea;
BEGIN
  SELECT row_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.row_hash := digest(
    coalesce(prev,''::bytea) ||
    convert_to(NEW.action_type||'|'||coalesce(NEW.target_type,'')||'|'||
               coalesce(NEW.target_id,'')||'|'||NEW.context::text||'|'||
               NEW.created_at::text, 'UTF8'),
    'sha256');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_ins BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append();

CREATE OR REPLACE FUNCTION audit_log_deny() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_no_upd BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_deny();
CREATE TRIGGER trg_audit_no_del BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_deny();
```

### 6.3 Seed migration
- System roles: `Owner` (clearance 1000), `Senior Admin` (750), `Admin` (500), `Viewer` (100) — все `is_system_role=true`
- Permission keys registry (см. `packages/shared-config/permissions.ts`):
  - `server:view`, `server:create`, `server:edit`, `server:delete`, `server:start`, `server:stop`, `server:restart`, `server:install`
  - `player:view`, `player:view_ips` (permission-gated), `player:view_eos_id`, `player:view_steam_id`
  - `audit:view`
  - `user:view`, `user:create`, `user:edit`, `user:delete`, `role:manage`, `permission:manage`
  - `host:view`, `host:metrics`
- Owner role получает все permissions; Viewer — только `*:view`

---

## 7. Bridge protocol (wire format)

### 7.1 Framing

Каждое сообщение: `4-byte big-endian uint32 length` + `JSON payload`.
`MaxFrame = 1 MiB`. Больше — connection dropped.

### 7.2 Request/Response schema

```json
// Request
{
  "id": "req-uuid-v7",
  "method": "systemctl_action",
  "params": {
    "unit": "squad-server-abc123.service",
    "action": "start"
  }
}

// Response (success)
{
  "id": "req-uuid-v7",
  "ok": true,
  "result": { "status": "done" }
}

// Response (error)
{
  "id": "req-uuid-v7",
  "ok": false,
  "error": {
    "code": "forbidden",        // forbidden | invalid_args | runtime_error | timeout | internal
    "message": "unit name does not match allowed pattern",
    "detail": { ... }           // optional
  }
}
```

### 7.3 Streaming methods

`steamcmd_run`, `journalctl_follow` — возвращают stream. Request запускает; сервер периодически эмитит frame'ы типа:
```json
{ "id": "req-uuid-v7", "stream": "stdout", "data": "Download progress: 23%" }
```
Завершается финальным `{ "id": "...", "ok": true, "result": { "exit_code": 0 } }`.

### 7.4 Method-specific params

**Все methods** — см. PDD Appendix A и Часть III §3. Ключевые:

- `steamcmd_run(args: string[])` — args проходят через whitelist validator. Разрешены только:
  - `+login anonymous`
  - `+force_install_dir /opt/squad-servers/{uuid}/` (regex `^\+force_install_dir /opt/squad-servers/[a-f0-9\-]{36}/$`)
  - `+app_update 403240` (optional `validate`)
  - `+@ShutdownOnFailedCommand 1`, `+@NoPromptForPassword 1`
  - `+@sSteamCmdForcePlatformType linux`
  - `+quit`
- `apt_install(packages: string[])` — strict whitelist (см. §2.1)
- `systemctl_action(unit: string, action: "start"|"stop"|"restart"|"status"|"enable"|"disable")` — unit regex `^squad-server-[a-f0-9\-]{36}\.service$` или `^panel-host-bridge$`

### 7.5 SO_PEERCRED check

Каждый новый connection → `getsockopt(SOL_SOCKET, SO_PEERCRED)` → проверка что caller UID принадлежит группе `panel` (через `user.LookupId` + `GroupIds`). Если нет — connection dropped, log WARN.

### 7.6 systemd unit (`panel-host-bridge.service`)

```ini
[Unit]
Description=panel-host-bridge privileged daemon
Requires=panel-host-bridge.socket
After=panel-host-bridge.socket network.target

[Service]
Type=notify
ExecStart=/usr/local/bin/panel-host-bridge
User=root
Restart=on-failure
RestartSec=2s
StartLimitIntervalSec=120
StartLimitBurst=5

NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
ReadWritePaths=/opt/squad-servers /var/log/panel-host-bridge /var/lib/apt /var/cache/apt /var/lib/dpkg /etc/systemd/system
RestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_INET6
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER CAP_FSETID CAP_KILL CAP_SETUID CAP_SETGID CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@debug @mount @swap @reboot @obsolete @cpu-emulation
SystemCallErrorNumber=EPERM
WatchdogSec=30s

[Install]
WantedBy=multi-user.target
```

```ini
# panel-host-bridge.socket
[Unit]
Description=panel-host-bridge control socket

[Socket]
ListenStream=/run/panel-host-bridge.sock
SocketMode=0660
SocketUser=root
SocketGroup=panel
RemoveOnStop=yes
PassCredentials=yes
Accept=no

[Install]
WantedBy=sockets.target
```

---

## 8. Squad server systemd template

`/etc/systemd/system/squad-server-{uuid}.service`:

```ini
[Unit]
Description=Squad Dedicated Server (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=squad
Group=squad
WorkingDirectory=/opt/squad-servers/%i
EnvironmentFile=/etc/squad-server/instance-%i.env

ExecStart=/opt/squad-servers/%i/SquadGameServer.sh \
  Port=${PORT} \
  QueryPort=${QUERY_PORT} \
  BeaconPort=${BEACON_PORT} \
  FIXEDMAXPLAYERS=${MAX_PLAYERS} \
  FIXEDMAXTICKRATE=${TICKRATE} \
  MULTIHOME=${MULTIHOME} \
  RANDOM=ALWAYS \
  -log

Restart=on-failure
RestartSec=10s
TimeoutStartSec=300s
TimeoutStopSec=60s

# Graceful shutdown order:
# - panel вызывает RCON AdminBroadcast "Shutting down in 60s" → AdminEndMatch
# - потом systemctl stop → SIGTERM → 60s grace period → SIGKILL если не успел

NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service

ReadWritePaths=/opt/squad-servers/%i

# UE5 не использует JIT; dlopen .so через file-backed PROT_EXEC → MDWE безопасен
MemoryDenyWriteExecute=true

# TasksMax=infinity — UE spawns 150-300 threads. Distro default 512 недостаточен.
TasksMax=infinity

# ПО УМОЛЧАНИЮ лимитов ресурсов НЕТ. Squad использует все ресурсы хоста.
# Если пользователь хочет ограничить — panel генерирует drop-in limits.conf с non-null полями.

StandardOutput=journal
StandardError=journal
SyslogIdentifier=squad-%i

[Install]
WantedBy=multi-user.target
```

Per-instance env `/etc/squad-server/instance-{uuid}.env`:
```
MULTIHOME=0.0.0.0
PORT=7787
QUERY_PORT=27165
BEACON_PORT=15000
RCON_PORT=21114
MAX_PLAYERS=100
TICKRATE=50
```

Optional drop-in `/etc/systemd/system/squad-server-{uuid}.service.d/limits.conf` (только если пользователь задал):
```ini
[Service]
CPUAffinity=0 1 2 3 4 5 6 7
CPUWeight=500
MemoryHigh=9G
MemoryMax=12G
Nice=-5
IOWeight=500
```

---

## 9. Log parser patterns (минимум для P0)

Полный inventory в PDD Appendix A. Для P0 обязательно:

```ts
// src/parsers/squad-log.ts
import { z } from 'zod';

const SQUAD_LOG_PATTERNS = {
  serverReady: /LogInit: Engine is initialized/,
  playerConnectJoin: /LogNet: Join succeeded: (?<name>.+)$/,
  playerConnectEOS: /LogEOS: \[EOS Connection\].*EOS:(?<eosId>[a-f0-9]{32}).*Steam:(?<steamId>\d{17})/,
  playerDisconnect: /LogNet: UChannel::Close: .*UniqueId: (?:EOS:(?<eosId>[a-f0-9]{32})\|STEAM:)?(?<steamId>\d{17})/,
  matchStart: /LogGameMode: Match State Changed from \S+ to InProgress/,
  matchEnd: /LogGameMode: Match State Changed from InProgress to WaitingPostMatch/,
};

export function parseLogLine(line: string, serverId: string): EventEnvelope | null {
  // ... pattern matching → envelope
}
```

Correlation player.connected: `LogNet: Join succeeded` и `LogEOS: [EOS Connection]` — соседние строки (< 100ms). Буфер в worker-log-ingest correlates их по short window → single `player.connected` event с полным identity.

---

## 10. RCON client (Source Engine protocol)

```ts
// apps/workers/rcon/src/client.ts
import net from 'node:net';

enum PacketType {
  SERVERDATA_AUTH = 3,
  SERVERDATA_AUTH_RESPONSE = 2,    // Note: same value as EXECCOMMAND_RESPONSE
  SERVERDATA_EXECCOMMAND = 2,
  SERVERDATA_RESPONSE_VALUE = 0,
}

class RconClient {
  async connect(host: string, port: number, password: string) {
    this.socket = net.createConnection(port, host);
    await this.authenticate(password);
    this.startKeepalive();  // every 90s
  }

  async execute(command: string): Promise<string> {
    // Multi-packet response через empty-ping trick:
    // 1. Send EXECCOMMAND с command, id=X
    // 2. Send пустой EXECCOMMAND id=Y сразу после
    // 3. Server echo'ит пакеты для X в порядке
    // 4. Когда видим response для Y — все chunks для X получены
  }

  async listPlayers(): Promise<Player[]> {
    const raw = await this.execute('ListPlayers');
    return parseListPlayers(raw);
  }

  // ...
}
```

Parse `ListPlayers` response:
```
----- Active Players -----
ID: 0 | Online IDs: EOS: abc123...def Steam: 76561198012345678 | Name: PlayerOne | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01
...
```

Regex: `/^ID: (?<id>\d+) \| Online IDs: EOS: (?<eosId>[a-f0-9]{32}) Steam: (?<steamId>\d{17}) \| Name: (?<name>.+?) \| Team ID: (?<teamId>\d+) \| Squad ID: (?<squadId>(?:\d+|N\/A))/m`

---

## 11. Fastify patterns

### 11.1 Route с audit + RBAC

```ts
declare module 'fastify' {
  interface FastifyContextConfig {
    permissions?: readonly Permission[];
    audit?: { action: string; resource: string } | false;
    rateLimit?: { max: number; timeWindow: string };
  }
  interface FastifyRequest {
    user?: { id: string; roles: string[]; permissions: Set<string> };
    session?: { id: string; userId: string };
  }
}

app.route({
  method: 'POST', url: '/api/v1/servers/:id/start',
  config: {
    permissions: ['server:start'],
    audit: { action: 'server.start', resource: 'server' },
  },
  schema: {
    params: z.object({ id: z.string().uuid() }),
  },
  handler: async (req, reply) => {
    const server = await db.query.servers.findFirst({ where: eq(servers.id, req.params.id) });
    if (!server) return reply.code(404).send({ error: 'not_found' });

    await bridgeClient.systemctl_action({
      unit: `squad-server-${server.id}.service`,
      action: 'start',
    });

    return reply.send({ status: 'starting' });
  },
});
```

### 11.2 Hook order

```ts
// onRequest: request ID injection
app.addHook('onRequest', (req, reply, done) => {
  const reqId = req.headers['x-request-id'] ?? uuidv7();
  reply.header('x-request-id', reqId);
  als.run({ reqId, correlationId: reqId, userId: undefined }, done);
});

// preValidation: auth resolution (401 beats 400)
app.addHook('preValidation', async (req, reply) => {
  const sid = req.cookies?.['__Host-sid'];
  if (!sid) return;
  const session = await resolveSession(sid);  // Redis → PG fallback
  if (session) req.session = session;
  if (session) req.user = await loadUser(session.userId);
});

// preHandler: RBAC
app.addHook('preHandler', async (req, reply) => {
  const perms = req.routeOptions.config.permissions;
  if (!perms?.length) return;
  if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
  if (!perms.every(p => req.user!.permissions.has(p)))
    return reply.code(403).send({ error: 'forbidden' });
});

// onResponse: audit write (inside transaction if mutation handler is transactional)
app.addHook('onResponse', async (req, reply) => {
  const a = req.routeOptions.config.audit;
  if (!a) return;
  // write to audit_log with reqId, userId, action, target, before/after snapshots, status
});
```

### 11.3 CI test — no route without audit

```ts
// tests/no-audit-bypass.test.ts
it('every mutation route has config.audit', () => {
  const routes = app.printRoutes({ commonPrefix: false });
  const mutations = routes.filter(r => ['POST','PATCH','PUT','DELETE'].includes(r.method));
  const withoutAudit = mutations.filter(r => r.config?.audit === undefined);
  expect(withoutAudit).toEqual([]);  // must be empty
});
```

---

## 12. Next.js 15 auth pattern

```ts
// src/middleware.ts — ТОЛЬКО cookie-presence redirect
import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has('__Host-sid');
  const { pathname } = req.nextUrl;

  if (!hasSession && pathname.startsWith('/dashboard')) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  if (hasSession && pathname === '/login') {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/dashboard/:path*', '/login'] };
```

```ts
// src/lib/dal.ts — REAL auth gate
import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const getSession = cache(async () => {
  const sid = (await cookies()).get('__Host-sid')?.value;
  if (!sid) return null;
  const res = await fetch(`${process.env.API_URL}/api/v1/me`, {
    headers: { cookie: `__Host-sid=${sid}` },
    cache: 'no-store',
  });
  return res.ok ? res.json() : null;
});

export async function requireSession() {
  const s = await getSession();
  if (!s) redirect('/login');
  return s;
}
```

```tsx
// src/app/(dashboard)/layout.tsx — gate
import { requireSession } from '@/lib/dal';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  return <Shell user={user}>{children}</Shell>;
}
```

---

## 13. Docker Compose

```yaml
# docker-compose.yml
services:
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:2019/config/"]

  web:
    build: { context: ., dockerfile: docker/web.Dockerfile }
    environment:
      API_URL: http://api:3000
      NEXT_PUBLIC_APP_DOMAIN: ${APP_DOMAIN}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]

  api:
    build: { context: ., dockerfile: docker/api.Dockerfile }
    environment:
      DATABASE_URL: postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin
      REDIS_URL: redis://redis:6379
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}
      BRIDGE_SOCKET: /run/panel-host-bridge.sock
    volumes:
      - /run/panel-host-bridge.sock:/run/panel-host-bridge.sock
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]

  worker-log-ingest:
    build: { context: ., dockerfile: docker/worker.Dockerfile, args: { WORKER: log-ingest } }
    environment:
      DATABASE_URL: postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin
      REDIS_URL: redis://redis:6379
      BRIDGE_SOCKET: /run/panel-host-bridge.sock
    volumes:
      - /run/panel-host-bridge.sock:/run/panel-host-bridge.sock
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }

  worker-rcon:
    build: { context: ., dockerfile: docker/worker.Dockerfile, args: { WORKER: rcon } }
    environment:
      DATABASE_URL: postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin
      REDIS_URL: redis://redis:6379
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}
    network_mode: host                  # чтобы коннектиться на 127.0.0.1:{rcon_port}
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }

  # ... прочие workers (stubs): audit-archiver, event-partition,
  #     stats, automation, discord, scheduler, backup, config-sync

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: admin
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U admin -d admin"]
      interval: 10s
      start_period: 30s

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--save", "60", "1000"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s

  backup:
    image: mazzolino/restic:latest
    environment:
      RESTIC_REPOSITORY: ${RESTIC_REPOSITORY}
      RESTIC_PASSWORD_FILE: /run/secrets/restic_password
      BACKUP_CRON: "0 3 * * *"
      RESTIC_FORGET_ARGS: "--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune"
      PRE_COMMANDS: |-
        docker exec postgres pg_dump -U admin -Fc admin > /backup/pg.dump
        docker exec redis redis-cli BGSAVE && sleep 3 && cp /var/lib/docker/volumes/admin_redis_data/_data/dump.rdb /backup/redis.rdb

  glitchtip:
    image: glitchtip/glitchtip:latest
    profiles: ["observability"]
    environment:
      DATABASE_URL: postgres://glitchtip:${GLITCHTIP_DB_PASSWORD}@postgres:5432/glitchtip
      SECRET_KEY: ${GLITCHTIP_SECRET_KEY}
      DEFAULT_FROM_EMAIL: noreply@${APP_DOMAIN}
    # ...

volumes:
  postgres_data:
  redis_data:
  caddy_data:
  evidence:
  backups:
  config_git:

# Logging driver для всех services:
# logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
```

```
# Caddyfile
{ email {$ACME_EMAIL:admin@example.com} }

{$APP_DOMAIN} {
    encode zstd gzip
    tls { issuer {$TLS_ISSUER:acme} }

    @api path /api/* /health /ready /metrics
    handle @api {
        reverse_proxy api:3000 {
            header_up X-Request-Id {http.request.header.X-Request-Id}
            health_uri /health
            health_interval 10s
        }
    }
    handle { reverse_proxy web:3000 }
    log { output stdout; format json }
}
```

Dev: `TLS_ISSUER=internal`, `APP_DOMAIN=admin.localhost`. Prod: `TLS_ISSUER=acme`, `APP_DOMAIN=admin.example.com`, `ACME_EMAIL=...`.

---

## 14. Setup wizard flow

```
1. GET / → redirect to /setup (если БД пустая)
2. /setup welcome page: "Welcome to Squad Admin Panel"
   Check Linux distro through /api/v1/setup/check-env
   → response { distro: "Ubuntu 22.04", deps_missing: [] }
3. /setup/org: create organization
   Input: name "My Community"
   POST /api/v1/setup/org → returns { orgId }
4. /setup/owner: create first user
   Input: email, password, display_name
   POST /api/v1/setup/owner → creates user, assigns Owner role
5. /setup/bridge: verify connection
   GET /api/v1/host/bridge-status → { connected: true, version: "1.0.0" }
   Also GET /api/v1/host → { hostname, os, kernel, cpu, ram }
6. /setup/encryption: generate APP_ENCRYPTION_KEY
   Backend generates 32-byte random key
   UI shows "Save this to your .env file: APP_ENCRYPTION_KEY=..."
   Checkbox "I saved it" → enable Next
7. /setup/complete: "Setup complete!"
   POST /api/v1/setup/finalize → marks org settings.setup_complete=true
   Redirect to /login
```

Вторая попытка `POST /api/v1/setup/*` → 410 Gone.

---

## 15. Env vars

```bash
# .env.example
APP_DOMAIN=admin.localhost
TLS_ISSUER=internal
ACME_EMAIL=admin@example.com

POSTGRES_PASSWORD=             # generate: openssl rand -base64 32
APP_ENCRYPTION_KEY=            # generate: openssl rand -base64 32 (32 bytes)
SESSION_SECRET=                # generate: openssl rand -base64 32

REDIS_URL=redis://redis:6379
DATABASE_URL=postgres://admin:${POSTGRES_PASSWORD}@postgres:5432/admin

BRIDGE_SOCKET=/run/panel-host-bridge.sock

# OAuth (optional, fill for Phase 1 real flow)
STEAM_API_KEY=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=

# Observability (optional)
GLITCHTIP_DSN=
GLITCHTIP_SECRET_KEY=

# Backup (optional)
RESTIC_REPOSITORY=s3:s3.amazonaws.com/my-admin-backups
RESTIC_PASSWORD=               # encryption password for restic
```

---

## 16. Scripts

### 16.1 `scripts/install-host-bridge.sh` (идемпотентный, from root)

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Check Linux distro
if ! grep -qE 'Ubuntu (22\.04|24\.04)|Debian GNU/Linux 1[2-9]' /etc/os-release; then
  echo "Unsupported distro" >&2; exit 1
fi

# 2. Create panel group (idempotent)
getent group panel >/dev/null || groupadd --system panel

# 3. Create squad user for running Squad servers
id -u squad >/dev/null 2>&1 || useradd --system --home-dir /opt/squad-servers --shell /usr/sbin/nologin squad

# 4. Build and install binary
go build -trimpath -ldflags="-s -w" -o /usr/local/bin/panel-host-bridge ./apps/bridge/cmd/panel-host-bridge
chmod 755 /usr/local/bin/panel-host-bridge

# 5. Install systemd units
install -m 644 apps/bridge/deploy/panel-host-bridge.service /etc/systemd/system/
install -m 644 apps/bridge/deploy/panel-host-bridge.socket /etc/systemd/system/

# 6. Reload + enable + start
systemctl daemon-reload
systemctl enable --now panel-host-bridge.socket

# 7. Add current invoking user's docker group to panel (for compose bind-mount)
DOCKER_USER="${SUDO_USER:-$USER}"
usermod -aG panel "$DOCKER_USER" || true

echo "panel-host-bridge installed. Re-login for group change to take effect."
```

### 16.2 `scripts/verify-bridge.sh`

Manual integration test — отправляет length-prefixed JSON в socket, проверяет whitelist rejection + positive cases. Подробности в `docs/bridge-protocol.md`.

### 16.3 `scripts/verify-audit-chain.ts`

```ts
// Validate every audit_log row hash matches sha256(prev_hash || canonicalized(row))
// Run: pnpm tsx scripts/verify-audit-chain.ts
```

---

## 17. Acceptance criteria (exit criteria для M0)

Каждый пункт — проверяется **руками**, на **трёх чистых VM** (Ubuntu 22.04, Ubuntu 24.04, Debian 12), **три раза подряд** с `docker compose down -v` между прогонами.

### 17.1 Infrastructure
- [ ] `git clone` → `pnpm install` → `sudo ./scripts/install-host-bridge.sh` → `docker compose up -d` → все containers `healthy` в ≤ 120 сек
- [ ] `systemctl is-active panel-host-bridge` → `active`
- [ ] `ls -la /run/panel-host-bridge.sock` → `srw-rw---- root panel`
- [ ] `docker compose ps` — все `healthy`
- [ ] `curl -k https://localhost/health` → 200
- [ ] `curl -k https://localhost/ready` → 200
- [ ] `curl -k https://localhost/metrics` → Prometheus format

### 17.2 Setup & auth
- [ ] `/setup` wizard успешно завершается
- [ ] Повторный `POST /api/v1/setup/*` → 410 Gone
- [ ] Login с неправильным паролем 6 раз → 6-я попытка → 429
- [ ] Enable TOTP → logout → login требует TOTP → успех
- [ ] Backup code работает один раз (второй раз — rejected)
- [ ] Viewer user пытается `POST /api/v1/servers` → 403
- [ ] `GET /api/v1/permissions` возвращает полный список permission keys

### 17.3 Bridge direct tests (через `scripts/verify-bridge.sh`)
- [ ] `ping` → ok
- [ ] `host_info` → real hostname, OS, CPU, RAM
- [ ] `host_metrics` — два вызова показывают меняющиеся значения
- [ ] `systemctl_action {unit: "nginx.service", action: "start"}` → `forbidden`
- [ ] `apt_install {packages: ["bash"]}` → `forbidden`
- [ ] `apt_install {packages: ["curl"]}` → ok (idempotent)
- [ ] `file_read {path: "/etc/shadow"}` → `forbidden`
- [ ] `file_atomic_write {path: "/opt/squad-servers/test.txt", ...}` → ok → file exists
- [ ] `steamcmd_run {args: ["+login", "admin123", "pass"]}` → `forbidden`
- [ ] `steamcmd_run {args: ["+login", "anonymous", "+quit"]}` → runs, exit 0

### 17.4 Database
- [ ] `\d players` → `steam_id64 bigint NOT NULL PRIMARY KEY`, нет `id uuid`
- [ ] `\d events` — partitioned; партиции для текущего + следующего месяцев существуют
- [ ] `UPDATE audit_log SET action_type='x' WHERE id=1` → exception
- [ ] `DELETE FROM audit_log WHERE id=1` → exception
- [ ] `pnpm db:migrate` (повторный) → "no changes"

### 17.5 Event envelope
- [ ] Envelope schema (Zod) rejects payload без event_id/version/type
- [ ] UUIDv7 sortable — unit test проходит
- [ ] Publish один event_id дважды → `processed_events` имеет одну строку
- [ ] Handler throws → после 5 retry message в `events:dlq`
- [ ] Consumer не acks → через 120 сек XAUTOCLAIM клеймит

### 17.6 Server install end-to-end

**ВАЖНО:** Squad create `SquadGame/ServerConfig/*.cfg` **только при первом запуске сервера**, не сразу после SteamCMD install. Поэтому "Install" flow состоит из:
1. `apt_install` зависимостей
2. `steamcmd_run` — скачивает depot
3. **Initial boot** — первый запуск сервера в bootstrap mode (`systemctl start` → wait for `LogInit: Engine is initialized` → `systemctl stop`) чтобы Squad создал стандартные `.cfg` файлы
4. Панель **читает** созданные Squad'ом configs, подставляет в `Rcon.cfg` свой auto-generated password, подставляет в `Server.cfg` server name, оставляет остальное без изменений
5. `systemctl enable` + write systemd unit
6. ufw rules

Это соответствует принципу "Squad is source of truth" — мы **не генерируем** configs, мы получаем их от Squad и правим только нужные поля.

- [ ] UI `/servers/new` → install wizard показывает progress stream
- [ ] WebSocket stream показывает **все шаги**: apt_install → steamcmd download % → initial boot (wait for ready) → read created configs → update RCON password + server name → stop initial boot → systemd unit generated → ufw rules
- [ ] По завершении: server status = `ready` (не `running`)
- [ ] `ls /opt/squad-servers/{uuid}/SquadGameServer.sh` — executable
- [ ] `ls /opt/squad-servers/{uuid}/SquadGame/ServerConfig/*.cfg` — все дефолтные configs присутствуют (созданы Squad'ом на initial boot). Конкретный список — из `docs/experiment/EXPERIMENT_REPORT.md`.
- [ ] `/opt/squad-servers/{uuid}/SquadGame/ServerConfig/Rcon.cfg` содержит RCON password сгенерированный панелью (encrypted-at-rest reference в `server_credentials.rcon_password_encrypted`)
- [ ] `/opt/squad-servers/{uuid}/SquadGame/ServerConfig/Server.cfg` содержит server name указанный в wizard
- [ ] Остальные configs (MapRotation, Admins, Bans, и т.д.) — **не трогались** панелью, остались как Squad их создал
- [ ] `systemctl cat squad-server-{uuid}` — соответствует template из обновлённого §8 TZ (после §0A.7 experiment)
- [ ] `systemd-analyze verify squad-server-{uuid}` → OK
- [ ] `ufw status | grep {game_port}` → ALLOW

### 17.7 Server lifecycle
- [ ] UI "Start" → status `running`
- [ ] `systemctl is-active squad-server-{uuid}` → active
- [ ] `ss -ulnp | grep {game_port}` — LISTEN udp
- [ ] `ss -tlnp | grep {rcon_port}` — LISTEN tcp
- [ ] **В Squad game client на другой машине**: открыть Server Browser → Community → **найти сервер по имени**
- [ ] UI "Stop" → graceful (AdminBroadcast → AdminEndMatch → systemctl stop) → status `stopped` в ≤ 60 сек
- [ ] UI "Restart" → stop+start

### 17.8 Player end-to-end (CRITICAL)
- [ ] Тестер с другой машины / второго Steam account подключается в Squad к серверу
- [ ] В UI `/servers/{id}` в player list через ≤ 30 сек появляется: SteamID64, никнейм, EOS ID
- [ ] `/players` показывает нового игрока с `player_name_history` (одна запись)
- [ ] Тестер выходит → `last_seen_at` обновляется, пропадает из live list
- [ ] Тестер заходит под другим никнеймом → `player_name_history` получает вторую запись
- [ ] `SELECT * FROM events WHERE server_id=...` показывает `player.connected`, `player.disconnected`
- [ ] `XRANGE events:server:{uuid} - + COUNT 20` в redis-cli — те же события

### 17.9 RCON
- [ ] В `/servers/{id}` RCON status = "connected"
- [ ] Stop server → через секунды "disconnected"
- [ ] Start server → через 15-30 сек "connected" (exponential backoff)
- [ ] worker-rcon логи: AUTH success, keepalive каждые ~90 сек, ListPlayers poll каждые 30 сек

### 17.10 Audit
- [ ] `/audit` показывает все actions chronologically: setup.complete, user.login (success + failed), user.2fa.enabled, server.create, server.install.started/completed, server.start/stop/restart
- [ ] `scripts/verify-audit-chain.ts` passes — все row_hash соответствуют

### 17.11 Negative tests
- [ ] Viewer `POST /api/v1/servers/{id}/start` → 403
- [ ] Unauthenticated `GET /api/v1/servers` → 401
- [ ] `systemctl stop panel-host-bridge` → UI показывает "Bridge: disconnected" через 10 сек
- [ ] `docker stop redis` → `/ready` → 503
- [ ] `kill -9 {squad-server-pid}` → через 15 сек systemd рестартит → status корректный в UI

### 17.12 CI
- [ ] GitHub Actions `ci.yml` green на PR
- [ ] Unit tests: ≥80% coverage на `apps/bridge/internal/validate/`
- [ ] Integration test: full install flow с pre-seeded mock SteamCMD depot → < 2 мин
- [ ] CI route audit coverage test passes (no mutation without `config.audit`)
- [ ] README quickstart работает на fresh VM для всех трёх distros

### 17.13 Final sign-off
Агент создаёт `PHASE_0_COMPLETION_REPORT.md` с:
- Дата завершения
- OS matrix tested (VM versions)
- Весь чеклист выше с `[x]` + one-line verification note per item
- Commit hash
- Screenshots или recordings §17.8 (player visible in UI)

Commit файл в repo. Это single artifact который читает user чтобы знать что Phase 0 готов.

---

## 18. Definition of Done — железобетонные правила для агента

### 18.0 Основной императив

**Результат твоей работы передаётся финальному пользователю — реальному администратору который поставит панель на свой production-сервер и будет ей пользоваться.** Это не демка, не PoC, не "первая итерация которую потом доделают". Это готовый продукт.

**КРИТИЧНО: пользователю должен быть передан ПОЛНОСТЬЮ РАБОЧИЙ, ПОЛНОСТЬЮ СООТВЕТСТВУЮЩИЙ ТРЕБОВАНИЯМ, ЦЕЛИКОМ ФУНКЦИОНИРУЮЩИЙ, ПОЛНОСТЬЮ ОТТЕСТИРОВАННЫЙ ПРОДУКТ.**

Из этого следуют **непреложные правила**:

### 18.1 Агент не останавливается пока работа не выполнена идеально

**ТЫ НИКОГДА НЕ ЗАКАНЧИВАЕШЬ РАБОТУ ДО МОМЕНТА КОГДА:**
- Все 13 блоков §17 Acceptance criteria = ✅ на трёх distros
- Все 10 quality fronts §18C = ✅
- Все верификационные gate'ы §18B = passed
- `PHASE_0_COMPLETION_REPORT.md` сгенерирован и показан пользователю

**Если упираешься в препятствие — ты не останавливаешься, ты разбираешься.** Упал тест — разбираешься почему. Не компилируется — разбираешься. SteamCMD ругается — разбираешься. Никаких "я сделал что смог, дальше пусть пользователь сам".

**Единственные случаи когда ты можешь остановиться и задать вопрос пользователю:**
1. **Блокер извне**: нужен внешний ресурс (API key, access к репозиторию, VPS с доступом в Steam CDN), который ты не можешь получить самостоятельно
2. **Решение влияющее на scope**: ты обнаружил что требование в TZ логически противоречит другому требованию, либо объективно невыполнимо (например Squad выпустил breaking change в protocol)
3. **Destructive action на чужие данные**: перед `rm -rf`, `git push --force`, `docker volume rm` с непустым volume спроси

**Всё остальное решаешь сам.** Ошибка компиляции → читаешь, чинишь. Тест упал → читаешь, чинишь. Flaky test → расследуешь root cause, не retry'ишь слепо. Сервис не стартует → смотришь логи, чинишь.

### 18.2 TDD + SDD — обязательны, не опция

**Тесты пишутся ДО имплементации, не ПОСЛЕ.** Для каждого endpoint / worker / bridge method / UI flow:

1. **Read spec** (acceptance criteria из §17 + feature description из §1B-1C)
2. **Write failing test** (unit + integration + E2E где применимо)
3. **Run test** → должен failиться по правильной причине ("function not defined", "endpoint not found")
4. **Write simplest code to make it pass**
5. **Run test** → должен pass'ить
6. **Refactor** если нужно
7. **Run full test suite** → ничего не сломалось
8. **Commit** (conventional commit message)

Это **red-green-refactor** цикл Kent Beck'а. Не пропускается.

**Почему обязательно:**
- Тесты это executable specification. Если ты написал код без теста, нет proof что он делает что требуется.
- AI agents (то есть ты) особенно подвержены "написал код который выглядит правильно но не работает на edge cases". Тест ловит это.
- Тесты переживают рефакторинг. Код без тестов = страх менять.

**Покрытие:**
- **Unit tests** — каждая функция с нетривиальной логикой (валидация, парсинг, crypto, RCON protocol). Минимум 80% line coverage на `apps/bridge/internal/validate/`, 60% overall.
- **Integration tests** — каждый API endpoint с mock'ами bridge, DB, Redis. Проверяют auth, RBAC, audit write, error handling.
- **Contract tests** — Zod envelope schemas валидируются на consumer boundary. Breaking change envelope → CI падает.
- **E2E tests** — Playwright на critical user flows: setup wizard completes, login + 2FA, install server (с mock SteamCMD), start/stop, player appears в UI после RCON mock poll.
- **Security tests** — bridge rejects malicious inputs (path traversal, command injection, non-whitelisted packages). Каждый whitelist имеет negative test.
- **Migration tests** — каждая миграция runs forward on empty DB + on seeded DB. CI test что `drizzle-kit check` passes.

**Spec-driven linking:** каждый тест имеет комментарий со ссылкой на user story / acceptance item:
```ts
// Tests §17.8: player end-to-end, US-07: admin sees live players
describe('worker-rcon ListPlayers integration', () => { ... });
```

### 18.3 Continuous verification loop — build-test-verify каждый commit

После каждого feature-коммита ты запускаешь полный цикл:

```bash
pnpm install --frozen-lockfile
pnpm turbo run typecheck                 # must pass
pnpm turbo run lint                      # must pass
pnpm turbo run test                      # must pass
pnpm turbo run build                     # must succeed
cd apps/bridge && go vet ./... && go test ./... -race -count=1 && govulncheck ./...
docker compose build                     # must succeed
docker compose up -d && sleep 90 && ./scripts/verify-healthchecks.sh
```

**Если что-то из этого fails — НЕ коммитишь.** Чинишь в текущем состоянии.

### 18.4 Никаких shortcuts, никаких хаков

Запрещено:
- **Hard-code values** чтобы тест прошёл (TDD — код должен решать задачу generally, не проходить конкретный тест)
- `@ts-ignore`, `@ts-expect-error` без комментария c причиной и issue reference
- `any` type в TS (кроме abs. необходимости с `biome-ignore` комментарием)
- `eslint-disable` / `biome-ignore` без причины в комментарии
- `// TODO: implement later` на фичах из P0 scope — либо делаешь, либо считаешь работу не завершённой
- `// XXX`, `// HACK`, `// FIXME` comments без matching issue в `docs/known-issues.md`
- `git commit --no-verify` — pre-commit hooks не обходятся
- `npm audit --force`, `pnpm audit --force` — vulnerabilities либо fixes либо documented exception
- Skip flaky tests через `.skip` / `it.skip` — flaky test это bug, расследуется
- `retry` counts в тестах чтобы замаскировать race condition
- `setTimeout` в тестах чтобы дождаться async (используется polling с clear exit condition)
- Копипаст одного и того же кода (DRY — extract function/component)
- Mock'ать то что должно работать реально. RCON client в integration test должен коннектиться к реальному Squad-серверу (или high-fidelity RCON mock server который реализует Source protocol, не `return 'OK'`)

### 18.5 Не урезай scope, не додумывай

**Scope closed.** Все требования §17 и §1B-1D обязательны. Если находишь требование которое кажется избыточным — спроси пользователя. Если находишь конфликт между двумя требованиями — спроси. Не решай сам.

**Не додумывай фичи.** Если TZ не требует dark mode — не делай. Если не требует notifications — не делай. Add scope только после явного подтверждения.

**Не делай half-assed.** Если фича в scope — делаешь её целиком с тестами и docs. Если полностью не успеваешь — останавливаешься и уточняешь с пользователем что приоритетнее.

### 18.6 Другие правила

1. **Не лезь в Phase 1+ секции PDD.** Там могут быть устаревшие ссылки на старую модель — они будут приведены в порядок когда начнётся Phase 1. Твой источник истины — этот TZ (§1-20) и Часть III PDD.

2. **Commit discipline.** Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`). Один commit = один logical change. PR pattern: feature branch → self-review → CI green → merge to main. Никогда не работай напрямую на main.

3. **RNSquadJS — не твоя забота.** Если встретишь референс — ignore. Если пользователь спрашивает — "не модифицируется, внешний опциональный проект, работает параллельно при желании".

4. **Resource limits (CPU/memory) default OFF.** Не добавляй в main systemd template. Только через UI → drop-in.

5. **В commit message не пиши "by Claude" / "AI-generated"** — обычный authored commit.

6. **Whitelist расширяется только с подтверждения пользователя.** apt packages, steamcmd args, file paths — если хочется добавить что-то — спроси.

7. **Documentation обновляется вместе с кодом.** Новый bridge method → `docs/bridge-protocol.md` updated в том же PR. Новый envelope type → `docs/event-envelope.md`. README updated когда flow меняется.

8. **Research before speculation.** Не опирай решения на догадки. Если не уверен как работает Source RCON protocol — читаешь spec / reference implementations (Valve wiki, mcrcon, rcon-cli). Документируешь источник в коде/PR.

9. **Errors never swallowed.** `catch (e) { /* ignore */ }` запрещён. Либо re-throw, либо log + user-facing error, либо comment почему это safe.

10. **Secrets не в коде.** Никаких API keys, passwords, tokens в git. `.env.example` только с placeholders. CI проверяет gitleaks.

## 18A. Definition of Done — acceptance matrix

Task считается **DONE** когда ВСЕ пункты = ✅:

| Уровень | Критерий |
|---|---|
| Functional | Feature работает согласно user story из §1B |
| Functional | Реальная проверка на живом окружении прошла |
| Tests | Unit tests написаны, покрытие ≥ целевого |
| Tests | Integration tests написаны, passing |
| Tests | E2E test (если применимо к user-facing flow) passing |
| Tests | Negative tests (invalid input, rate limits, auth failures) passing |
| Quality | `typecheck` passes |
| Quality | `lint` passes (0 warnings) |
| Quality | `build` succeeds без warnings |
| Quality | `go vet`, `go test -race`, `govulncheck` pass |
| Security | Route имеет `config.audit` если mutation |
| Security | Route имеет `config.permissions` если protected |
| Security | Input validated через Zod |
| Security | Secrets в env vars, не в коде |
| Docs | Code comments на нетривиальной логике |
| Docs | Markdown docs updated в том же PR если нужно |
| Docs | OpenAPI spec regenerated committed |
| Observability | Pino structured logs на важных paths |
| Observability | Prometheus metrics incremented |
| Observability | Error → logged + GlitchTip reported (в prod profile) |
| Audit trail | Mutation → audit_log entry с before/after |
| Git | Conventional commit message |
| Git | CI green на PR (all checks) |
| Git | Reviewed self-review completed (diff re-read) |
| Deployment | `docker compose up -d` builds and starts healthy |
| Deployment | Healthchecks pass на всех сервисах |

**Если какой-то пункт не применим к конкретному task** (например pure docs change не требует Prometheus metrics) — пишется в commit message "N/A because X" и пропускается. Иначе — обязателен.

## 18B. Verification loop — что делает агент перед тем как сказать "готово"

```
1. Self-review diff
   git diff main...HEAD
   Re-read every changed line, ask "would a senior engineer approve this?"
   If doubt — revise.

2. Lint + typecheck + test
   pnpm turbo run typecheck lint test
   All must be green.

3. Build
   pnpm turbo run build
   docker compose build
   Both must succeed without warnings.

4. Bridge checks (Go)
   cd apps/bridge
   go vet ./...
   go test ./... -race -count=1        # race detector
   govulncheck ./...                    # no high/critical vulns
   staticcheck ./...                    # no warnings

5. Security
   pnpm audit --audit-level=high        # zero high+critical
   gitleaks detect --no-banner          # zero secrets

6. Fresh-install test (on 3 distros)
   On clean VM (Ubuntu 22.04, 24.04, Debian 12):
     git clone [repo]
     cp .env.example .env && configure
     sudo ./scripts/install-host-bridge.sh
     docker compose up -d
     wait ≤ 120s
     all containers healthy
     browse to https://admin.local → setup wizard works
     go through §17.1-17.13 manually
     record PASS/FAIL per item

7. Real player E2E (§17.8)
   On separate machine, run Squad game client
   Connect to configured server
   Verify player appears in UI panel ≤30s
   Verify name_history, last_seen_at update
   Disconnect, verify pops out of live list

8. Soak test
   Leave panel running 24h+ with at least 1 active Squad server
   Verify: no memory leaks (Prometheus), no crashed containers, backup ran at 3AM
   Kill squad process, verify systemd restart detected in UI within 15s

9. Documentation check
   README quickstart followed literally — works?
   OpenAPI at /api/docs matches actual routes
   docs/bridge-protocol.md matches real wire format (run verify-bridge.sh)
   docs/event-envelope.md matches Zod schemas

10. Generate PHASE_0_COMPLETION_REPORT.md
    See §20 for format.
    Include screenshots of §17.8 (player in UI).
    Commit to repo.
```

**Если ЛЮБОЙ шаг failed — возвращаешься к шагу 1 после фикса.** Не "ну 9 из 10 passed, norм". Все 10.

## 18C. Quality fronts — что verified должно быть

Продукт не готов пока **все 10 фронтов** одновременно не ✅:

### 1. Functional correctness
Каждая user story из §1B реализована и working. Каждый use case из §1C проходится end-to-end на живой системе.

### 2. Test coverage
- Unit tests: ≥80% на security-critical (bridge validation, crypto, RCON protocol), ≥60% overall
- Integration tests: каждый API endpoint покрыт
- E2E tests: каждый critical user flow (Playwright)
- Contract tests: Zod schemas validated at boundaries
- Negative tests: каждый error path покрыт

### 3. Code quality
- TypeScript strict mode везде, zero `any` без justification
- Biome 2.x: zero warnings
- Go: `go vet`, `staticcheck`, `go test -race` pass, `govulncheck` zero critical
- Zero `TODO`/`FIXME`/`HACK` без matching issue
- DRY: no copy-paste
- SOLID: дискретные responsibilities per module

### 4. Security
- All inputs validated (Zod boundary)
- Secrets в env, not code
- RBAC enforced на каждом mutation
- Audit log immutable (DB triggers)
- Password Argon2id OWASP params
- TLS enforced
- Rate limits configured
- CSRF protection active
- Bridge SO_PEERCRED + whitelist + hardening
- `systemd-analyze security panel-host-bridge` < 3.0
- `pnpm audit --audit-level=high`: zero
- `gitleaks`: zero secrets

### 5. Performance
- Page load ≤ 500ms TTFB на localhost
- RCON poll every 30s adds negligible CPU (<1% on modern server)
- Log ingest latency ≤2s от log line до event в Redis
- Full API round-trip ≤100ms on localhost
- Install flow with mock SteamCMD ≤2min

### 6. Reliability
- 7-day soak test passed на single VM
- Crash recovery: each service `restart: unless-stopped`
- Graceful shutdown on SIGTERM (all services drain работу)
- Backup ran at scheduled time, verified restorable
- No memory leaks over 24h (Prometheus RSS flat)

### 7. Observability
- Pino JSON logs с redaction (no secrets leak)
- Prometheus metrics: HTTP histogram + consumer counters + business counters
- Health/ready endpoints
- GlitchTip integration (optional profile works)
- Correlation ID propagated через Redis Streams

### 8. Deployment
- `docker compose up -d` from clean clone works на всех 3 distros
- No manual steps после install-host-bridge.sh + env file config
- Healthchecks на каждом сервисе
- Volumes persist через `docker compose down` / `up`
- `docker compose down -v` cleanly removes everything

### 9. Documentation
- README quickstart работает literally (проверен на fresh VM)
- `docs/architecture.md` — diagram + component descriptions
- `docs/bridge-protocol.md` — wire format, все 14 methods, examples
- `docs/event-envelope.md` — schema, versioning, upcasting
- `docs/rbac.md` — permission keys, clearance model
- `docs/development.md` — local dev setup
- `docs/security.md` — threat model, hardening
- `docs/troubleshooting.md` — common issues
- `OpenAPI 3.1` auto-generated, served at `/api/docs`
- Code comments на нетривиальной логике (regex patterns, crypto, protocol handlers)

### 10. User experience
- Setup wizard проходится за ≤5 минут
- Install wizard показывает progress в реальном времени (не "спиннер 30 минут")
- Error messages понятные, actionable, на русском
- Empty states имеют CTA ("No servers yet. Install new?")
- Disabled buttons имеют tooltip объясняющий почему
- Forms валидируются inline (не только на submit)
- Loading states везде где async
- 404/401/403/500 страницы dignified

---

## 19. Критичные нюансы — повторить в голове перед тем как начать кодить

1. **players.steam_id64 = PRIMARY KEY (bigint)**, не UUID. Все FK на игрока → `players(steam_id64)`. EOS/BE/IP — колонки или history-таблицы.

2. **Event envelope финализирован.** Новые обязательные поля к существующим events → version bump + upcast-on-read.

3. **Audit append-only через DB triggers** — не через application logic. Unit test что нельзя UPDATE/DELETE.

4. **Route `config.audit` обязателен для всех mutations.** CI тест падает если забыл.

5. **Next.js middleware НЕ auth gate** (CVE-2025-29927). Real gate — `requireSession()` в layout.tsx с `react.cache()`.

6. **Dual-layer idempotency для consumers** — Redis `SET NX EX` + PG `processed_events`. XACK только on success.

7. **UUIDv7 app-side** через `uuid@^11` (PG 16 не имеет native). Для `players.steam_id64` — bigint, не UUID.

8. **AES-256-GCM app-level**, не pgcrypto. `key_version` column для rotation.

9. **Oslo + Arctic**, не Lucia, не Better Auth, не Auth.js. Steam — custom OpenID 2.0 verifier ~40 строк.

10. **Bridge — 14 методов, все работают, все validated** в P0. Не stubs.

11. **Workers log-ingest и rcon — functional в P0**, не stubs. Реальный TCP к Squad, реальный log tail.

12. **RNSquadJS — внешний чёрный ящик.** Нет subtree, нет плагина, нет Node 22 bump.

13. **Default no resource limits** для Squad-сервера. Через UI — drop-in `.service.d/limits.conf` только с non-null fields.

14. **Тест на реальном игроке обязателен** (§17.8) — ядро P0 acceptance.

15. **TDD не опциональна.** Тест первым, код вторым.

16. **Squad — source of truth.** Configs, log format, RCON protocol, directory structure — от Squad, не от предположений в PDD. Experimental phase §0A обязательна до имплементации.

17. **Configs создаются Squad'ом на first boot, не на install.** Install flow содержит bootstrap boot (start → wait for ready → stop) чтобы получить `SquadGame/ServerConfig/*.cfg`. Панель затем правит только нужные поля (RCON password, server name), остальные configs оставляет нетронутыми.

18. **Credentials для эксперимента и работы:** `sudo user=squad, password=squad`. Permissions на apt install / systemd / filesystem в рамках TZ whitelist — даны.

19. **EXPERIMENT_REPORT.md** — обязательный deliverable §0A ДО начала main implementation. Commit'ится в `docs/experiment/`.

20. **Если Appendix A в PDD расходится с actual Squad behavior** — реальность побеждает, PDD обновляется под неё с комментарием `<!-- Updated per experiment YYYY-MM-DD -->`.

---

## 20. Финальный deliverable — PHASE_0_COMPLETION_REPORT.md

Это единственный документ который ты отдаёшь пользователю в конце работы. Он commit'ится в корень репозитория как `PHASE_0_COMPLETION_REPORT.md`.

**Формат:**

```markdown
# Phase 0 — Completion Report

**Дата завершения:** YYYY-MM-DD
**Commit hash на котором всё verified:** [git SHA]
**Git tag:** `v0.1.0-p0`
**Docker image tags:** `ghcr.io/org/squad-admin-panel:v0.1.0-p0`, `:latest`

## Prerequisite: Experiment phase

- [x] `docs/experiment/EXPERIMENT_REPORT.md` committed (§0A выполнена полностью)
- [x] Все 8 experimental steps документированы в `docs/experiment/01-install.md` ... `08-discovery.md`
- [x] Default Squad configs saved as-is в `docs/experiment/configs-default/`
- [x] PDD Appendix A updated where reality differed (commit: [SHA])
- [x] TZ §8/§9/§10 updated where reality differed (commit: [SHA])
- [x] All regex patterns validated against actual Squad log output
- [x] Systemd unit template validated on test VM
- [x] RCON protocol verified with hex dump of actual responses

## Testing matrix

Verified на 3 чистых VM, 3 прогона на каждой (9 прогонов итого):

| OS | Run 1 | Run 2 | Run 3 | Notes |
|---|---|---|---|---|
| Ubuntu 22.04 LTS | ✅ | ✅ | ✅ | — |
| Ubuntu 24.04 LTS | ✅ | ✅ | ✅ | — |
| Debian 12 | ✅ | ✅ | ✅ | — |

VM specs: [4 vCPU, 8GB RAM, 150GB disk, network 200 Mbps]

## §17 Acceptance checklist

### §17.1 Infrastructure
- [x] `git clone` → `pnpm install` → `sudo ./scripts/install-host-bridge.sh` → `docker compose up -d` → healthy ≤120s
  **Verified:** [specific note, e.g. "Ubuntu 22.04 run 3: healthy at 108s, all containers green"]
- [x] `systemctl is-active panel-host-bridge` → active
  **Verified:** ...
[... все items ...]

### §17.2 Setup & auth
[...]

### §17.3 Bridge direct tests
[...]

[... все 13 блоков ...]

## §18C Quality fronts

- [x] Functional correctness — all 12 user stories working, all 6 use cases passed
- [x] Test coverage — bridge 87% (target 80%), overall 68% (target 60%)
  - Unit tests: 142 passing
  - Integration tests: 58 passing
  - E2E (Playwright): 14 passing
  - Negative tests: 31 passing
- [x] Code quality — Biome 0 warnings, go vet clean, staticcheck clean, govulncheck 0 critical
- [x] Security — systemd-analyze score: 2.4 (target <3.0), pnpm audit: 0 high, gitleaks: 0
- [x] Performance — TTFB 320ms avg, log ingest p95 1.7s, 24h soak: RSS stable
- [x] Reliability — 7-day soak passed, crash recovery verified, backup verified restorable
- [x] Observability — Pino redaction tested, Prometheus metrics all exposed, GlitchTip verified
- [x] Deployment — fresh install verified on all 3 distros × 3 runs
- [x] Documentation — all 8 docs/ files updated, OpenAPI auto-generated, README works literally
- [x] UX — wizard ≤5min, all error states user-friendly on русском

## Real player E2E test

**Date/time:** YYYY-MM-DD HH:MM UTC
**Tester:** [name or pseudonym]
**Machine:** [OS, distance from server in network latency]
**Server installed:** Test Server, ports 7787/27165/15000/21114

Recording: [link or `docs/recordings/p0-e2e-player.mp4`]

Screenshots:
- `docs/screenshots/p0-01-setup-wizard.png`
- `docs/screenshots/p0-02-dashboard.png`
- `docs/screenshots/p0-03-install-wizard-progress.png`
- `docs/screenshots/p0-04-server-running-in-steam-browser.png`
- `docs/screenshots/p0-05-player-visible-in-ui.png` ← **это главное доказательство что P0 работает**
- `docs/screenshots/p0-06-player-name-history.png`

## Metrics snapshot

После 24h soak с 1 running Squad server:
- Panel RAM: XMB (idle) / YMB (Squad running)
- Panel CPU: X% average
- Squad server RAM: 8.4 GB (100-player match)
- RCON poll success rate: 100% (N polls)
- Log ingest events processed: X events in 24h
- Events persisted in PG: Y (partitioned by month)
- Backup ran at 03:00:00 ± 10s, took Z seconds, restic snapshot verified

## Known issues / scope decisions

[Если во время реализации что-то изменилось относительно TZ — документировать здесь. Пустая секция если ничего не изменилось. Примеры:]

- None.

[ИЛИ:]

- **Steam OpenID 2.0 in P0** — implemented but endpoints return 501 per scope. Full login flow deferred to Phase 1 (matches TZ §2.1).
- **Manual backup restore** — scope decision confirmed with user 2026-MM-DD, automatic backups work, restore flow UI deferred to Phase 1.

## Repository state

- Main branch: commit [SHA]
- CI: green on main (last run [link])
- Open PRs: 0
- Open issues: 0 critical, N nice-to-have (tagged phase-1-backlog)

## How to use this report

Этот документ — proof что P0 готов. Следующие шаги:

1. **User** (вы): берёте fresh VM, проходите quickstart из README.md, проверяете что acceptance §17 items действительно работают. Это независимая проверка.

2. **После sign-off** — создаётся tag `v0.1.0-p0`, публикуется Docker image, проект готов к Phase 1.

3. **Phase 1 start** — новый TZ для Phase 1 будет создан вами; агент читает его + обновлённую Часть IV PDD.

---

**Agent sign-off:** Вся работа выполнена согласно TZ. Definition of Done (§18A) и Quality fronts (§18C) удовлетворены. Продукт готов к передаче пользователю.

**Agent:** [agent identifier]
**Final commit:** [SHA]
**Completed at:** [ISO timestamp]
```

### 20.1 Когда коммитится этот документ

**Только когда всё в нём действительно ✅.** Если хоть один checkbox остался `[ ]` — ты не пишешь этот документ, ты продолжаешь работать.

Report это не "план" и не "декларация намерений". Report это **proof**. Каждый `[x]` должен быть real verification с notes что именно проверено и на чём.

### 20.2 Что делать если что-то действительно невозможно

Если находится требование которое физически невыполнимо (Squad изменил protocol несовместимо, библиотека удалена из npm registry, etc) — **ты не отмечаешь checkbox `[x]` и не пишешь report**. Вместо этого:

1. Документируешь в `docs/blockers.md` что именно невозможно + почему + evidence
2. Предлагаешь 2-3 альтернативных подхода (с trade-off каждого)
3. Останавливаешься и спрашиваешь пользователя какой путь выбрать
4. После выбора — возвращаешься к работе

**Частичная работа недопустима.** Лучше спросить и уточнить, чем закончить с "ну почти всё работает".

---

**Конец документа. Начинай работу.**
