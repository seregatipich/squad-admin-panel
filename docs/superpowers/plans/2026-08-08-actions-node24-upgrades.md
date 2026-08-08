# План приёмки обновлений GitHub Actions

**Цель:** принять PR №262, №264, №265, №274 и №275 одной совместимой волной,
не нарушая маршрут `work branch -> dev -> master`.

## Ограничения

- Рабочая база — свежий `origin/dev`; напрямую `dev` и `master` не изменяются.
- Исходные commit SHA из Dependabot сохраняются в истории, чтобы GitHub мог
  распознать PR как поглощённые после продвижения.
- Все ссылки `uses:` остаются закреплены на полных SHA.
- Версии с Node 24 требуют self-hosted runner не старше 2.327.1; совместимость
  окончательно подтверждает CI на `dev`.
- `master` продвигается только fast-forward от проверенного `dev`.

## Изменения

1. Влить в рабочую ветку головы пяти PR:
   - `actions/checkout` 7.0.1;
   - `actions/setup-node` 7.0.0;
   - `docker/setup-buildx-action` 4.2.0;
   - `actions/upload-artifact` 7.0.1;
   - `pnpm/action-setup` 6.0.10.
2. Проверить объединённый diff: только `.github/workflows/ci.yml` и
   `.github/workflows/deploy-tk104.yml`, без ослабления условий или прав.
3. Выполнить `actionlint`, `pnpm turbo run typecheck`, `pnpm exec biome check .`,
   применимые тесты и `bash scripts/verify-done.sh --feature`.
4. После независимой приёмки влить ветку в `dev`, отправить `origin/dev` и
   дождаться зелёного CI текущего SHA.
5. Выполнить `bash scripts/verify-done.sh`; только затем fast-forward
   `origin/dev:master` и проверить CI/развёртывание.

## Условие остановки

Если версия runner или зелёный CI текущего `dev` недоступны для проверки,
обновления остаются в `dev`, а продвижение в production `master` блокируется.
