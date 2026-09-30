# `shared-config` — changelog

## 2026-09-30 — Проверка формы шаблона Discord (#78)

### Added

- `isDiscordEmbedTemplate(value)` в `discord-template.ts`: структурная проверка jsonb-значения шаблона для потребителей без zod (воркер discord). Тест: `test/discord-template.test.ts`.

## 2026-09-27 — Аудит маршрутов API (#38)

### Added

- `outbound-url.ts`: `checkOutboundUrl()` и `isPublicUnicastAddress()` — политика исходящих запросов для URL источников банов (аудит #100). API проверяет URL при записи, `worker-ban-sync` — перед каждым запросом, каждым редиректом и при каждом подключении.
- Право `ban_source:view` (категория `moderation`) для чтения `/api/v1/ban-sources`.
- `isSafeBannedNameRegex()` и `BANNED_NAME_NICK_MAX = 64` (аудит #115): `validateBannedNamePattern` отклоняет regex с повторяемой группой, внутри которой есть квантификатор или `|`, и с обратными ссылками (`pattern_unsafe_regex`); `matchBannedName` и матчер `worker-log-ingest` не исполняют такие правила, даже если они сохранены раньше.

### Changed

- `trigger:view` больше не помечено `unimplemented`: им защищены `GET /api/v1/automation-rules` и `GET /api/v1/automation-runs`.


## 2026-09-28

### Fixed

- `selectNextLayer` сортирует кандидатов по слою перед взвешенным выбором: выбор при одном seed больше не зависит от порядка кандидатов, и предпросмотр совпадает с тиком scheduler (#301).

## 2026-09-28

### Removed

- `process_info`, `file_read_tail` and `file_write` from `BRIDGE_METHODS` (#45) — no production caller; `process_info` exposed any host process's command line. The allowlist now has 27 methods.

## 2026-09-28 (#52)

### Security

- Новый `regex-safety.ts`: `detectDangerousRegex(pattern)` отклоняет вложенные квантификаторы переменной длины (`(a+)+`, `(.*a){20}`, `(a{1,100}){1,100}`), повторяемую альтернацию с пересекающимися ветвями (`(a|aa)+`, `(\w|\d)+`; допускается только альтернация литералов без общих префиксов вроде `(bad|worse)+`) и повторы больше 100. Коды ошибок: `nested_quantifier`, `alternation_under_quantifier`, `repeat_too_large`.
- `validateBannedNamePattern` теперь проверяет regex-правила ников этим сканером (раньше — только компиляцию), `validateChatFlagPattern` использует общий сканер. `matchBannedName` и `compileChatFlagRule` не исполняют опасный шаблон, сохранённый до проверки.

### Fixed

- `renderDiscordTemplate`: значения берутся только из собственных строковых свойств контекста — `{constructor}`, `{__proto__}` и т. п. считаются отсутствующими и больше не роняют рендер. Пустые имя или значение поля заменяются на `—` (`DISCORD_EMPTY_FIELD_VALUE`), текст обрезается до лимитов Discord (`DISCORD_EMBED_LIMITS`, суммарно 6000 символов), чтобы Discord не отвечал 400.

## 2026-07-27

### Added

- `createGracefulShutdownController()` для работников: ранний сигнал сохраняется до завершения запуска, повторный сигнал присоединяется к уже начатой очистке, ошибка очистки приводит к коду `1`.
- Регрессионные тесты раннего и повторного сигнала, а также ошибки очистки.

## 2026-07-07

### Added

- `squad_log_retention_sweep` appended to `BRIDGE_METHODS` before `host_agent_restart`. Backs LOG-1 raw Squad log retention through the host bridge.

### Changed

- `BRIDGE_METHODS` length is now 25. `BridgeMethod` union is correspondingly wider.

## 2026-04-29

### Added
- `file_read_tail` inserted into `BRIDGE_METHODS` (between `file_read` and `file_write`) — 20th allowed RPC method. Backs the diagnostic-bundle builder's bounded tail-read of `SquadGame.log`.

### Changed
- `BRIDGE_METHODS` length is now 20 (was 19). `BridgeMethod` union is correspondingly wider.

## 2026-04-28

### Added
- `panel_disk_usage` appended to `BRIDGE_METHODS` (between `depot_update` and `host_agent_restart`). Backs the host-disk-breakdown UI.

## 2026-04-26

### Added
- `packages/shared-config/test/property/registry.test.ts` — property-based tests (3 properties, 100 runs each) for `isPermissionKey` and `PERMISSION_KEYS` registry consistency.

## 2026-04-25

### Added
- `host:manage` permission key (category `host`, dangerous) for bridge restart capability.
- Full 8/8 component documentation (api, data-model, flows, configuration, testing, troubleshooting, changelog).

### Changed
- `PERMISSIONS` registry refactored to `satisfies readonly PermissionDef[]` for stricter TypeScript inference.
- `ROLE_COLORS` palette finalized to 16 Tailwind color names; `ROLE_COLOR_SET` added for O(1) guard; `isRoleColor` added.
- Sub-path exports `./role-colors` and `./permissions` added to `package.json` for browser-safe imports.

## 2025-11-15

### Added
- `log-stream-sink.ts` — pino multistream sink that writes to `panel:logs` Redis Stream.
- `metrics-pack.ts` — `packHostMetrics`/`unpackHostMetrics` for compact Redis Stream storage; `HOST_METRICS_STREAM`, `HOST_METRICS_MAXLEN` constants.
- `rcon-host.ts` — `resolveRconHost` for environment-aware RCON host resolution.
- Docker/container-related constants: `SERVER_IMAGE`, `DEPOT_INIT_IMAGE`, `DEPOT_VOLUME_NAME`, `SERVER_CONTAINER_PREFIX`, `SERVER_CONTAINER_REGEX`.
- Config file classification: `ALLOWED_CONFIG_FILES`, `HOT_RELOAD_FILES`, `ROTATION_FILES`, `configFileClass()`.
- `BRIDGE_STREAMING_METHODS` to distinguish streaming RPC from unary.

### Changed
- `BRIDGE_METHODS` updated to replace pre-container methods with Docker-based ones (`container_run`, `container_start`, etc.).

## 2025-09-01

### Added
- Initial package: `bridge-methods.ts` (method allowlist, socket/frame constants), `heartbeat.ts` (worker heartbeat helper), `log-stream.ts` (encode/decode, source/level codes), `permissions.ts` (PERMISSIONS registry, 44 initial keys).
