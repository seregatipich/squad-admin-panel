# §0A.0 — Setup репозитория и рабочей директории

**Дата:** 2026-04-23
**Исполнитель:** AI-агент (автономный режим)

## Состояние репозитория

| Параметр | Значение |
|---|---|
| URL | `git@github.com:breaking-squad/squad-admin-panel.git` |
| Путь клонирования | `/home/squad/squad-admin-panel/` |
| Branch | `master` |
| Commit HEAD | `0de76813505461e12342a6ed1ace9be80483dbf9` (Initial commit) |
| Working tree | clean |
| SSH push access | verified (`Hi seregatipich! You've successfully authenticated`) |

На момент старта репо содержит только `LICENSE` и `README.md` (одна строка). Вся остальная структура будет построена в рамках Phase 0.

## Рабочие директории

| Директория | Назначение |
|---|---|
| `/home/squad/squad-admin-panel/` | Репозиторий. Весь код, docs, scripts коммитятся сюда. |
| `/home/squad/squad-admin-panel/docs/experiment/` | Документация §0A. Коммитится. |
| `/home/squad/squad-admin-panel/docs/experiment/configs-default/` | Default `.cfg` файлы Squad (dumps). Коммитится. |
| `/home/squad/squad-experiment/` | Временная: сюда устанавливается Squad-сервер (95GB depot) для эксперимента. **НЕ** коммитится. |

## Окружение (host)

| Параметр | Значение |
|---|---|
| OS | Ubuntu 24.04.4 LTS (Noble Numbat) |
| Kernel | `6.8.0-110-generic` |
| Arch | x86_64 |
| CPU | 10 cores |
| RAM | 11 GiB total, ~10 GiB available |
| Swap | 4 GiB |
| Disk | 244 GB / (root), 226 GB available |
| User | `squad` (UID/GID обычный, sudo через password) |
| Sudo | `squad:squad` (per TZ §0A.0) |
| Дата/время хоста | 2026-04-23 |

## Предстоящая работа

После документирования §0A.0 последовательно выполняются:

- **§0A.1** — `steamcmd` + `app_update 403240 validate` → скачать Squad dedicated server
- **§0A.2** — первый запуск → observe создание `SquadGame/ServerConfig/*.cfg`
- **§0A.3** — shutdown + повторный запуск
- **§0A.4** — RCON connection (`mcrcon`, hex dump протокола)
- **§0A.5** — log parsing reality check (сравнить actual vs PDD Appendix A regex)
- **§0A.6** — launch arguments experimentation
- **§0A.7** — systemd unit test + `systemd-analyze security`
- **§0A.8** — A2S query + Steam Server Browser discovery
- **§0A.9** — `EXPERIMENT_REPORT.md` consolidation
- **§0A.10** — corrections к PDD Appendix A / TZ на основе findings

Только после этого — main implementation.

## Готовность

- [x] Репозиторий склонирован и на чистом master commit
- [x] SSH push verified
- [x] Экспериментальные директории созданы
- [x] Основные параметры host задокументированы
- [x] Sudo проверен
