'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  FieldRow,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
  Switch,
  TextInput,
} from '@/components/ui';
import { type ClanGuardSettings, formatUpdatedAt, validateGracePeriod } from './helpers';

interface Me {
  can_manage_clans: boolean;
}

export default function ClanGuardSettingsPage() {
  const [settings, setSettings] = useState<ClanGuardSettings | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [gracePeriodInput, setGracePeriodInput] = useState('300');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [globalErr, setGlobalErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const graceId = useId();

  const refresh = useCallback(async () => {
    const [settingsRes, meRes] = await Promise.all([
      fetch('/api/v1/settings/clan-guard', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (settingsRes.ok) {
      const loaded = (await settingsRes.json()) as ClanGuardSettings;
      setSettings(loaded);
      setEnabled(loaded.enabled);
      setGracePeriodInput(String(loaded.grace_period_seconds));
      setGlobalErr(null);
    } else {
      setGlobalErr(`Не удалось загрузить настройки: ${settingsRes.status}`);
    }
    if (meRes.ok) setMe((await meRes.json()) as Me);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canManage = me?.can_manage_clans ?? false;

  async function save() {
    if (!settings || !canManage) return;
    const validation = validateGracePeriod(gracePeriodInput);
    if (!validation.ok) {
      setFieldError(validation.error);
      setGlobalErr('Исправьте выделенное поле.');
      return;
    }
    setFieldError(null);
    setGlobalErr(null);
    setSaving(true);
    try {
      const res = await fetch('/api/v1/settings/clan-guard', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, grace_period_seconds: validation.value }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setGlobalErr(`Ошибка сохранения: ${err.error ?? res.status}`);
        return;
      }
      const fresh = (await res.json()) as ClanGuardSettings;
      setSettings(fresh);
      setEnabled(fresh.enabled);
      setGracePeriodInput(String(fresh.grace_period_seconds));
      setNotice('Настройки защиты клан-тегов сохранены.');
    } catch (err) {
      setGlobalErr(`Ошибка сети: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageContainer width="reading">
      <PageHeader
        title="Защита клан-тегов"
        subtitle="Механизм предупреждает и кикает игроков, которые носят тег клана с включённой защитой тега, но не состоят в его ростере. Настройки конкретного клана — на его странице."
      />

      {globalErr ? (
        <InlineBanner
          tone="crit"
          title="Не удалось выполнить запрос"
          description={globalErr}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {notice ? (
        <InlineBanner
          tone="good"
          title={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}
      {settings && me && !canManage ? (
        <InlineBanner
          tone="info"
          title="Только просмотр"
          description="Для изменения настроек нужно право «Управление кланами»."
        />
      ) : null}

      {!settings || !me ? (
        <Card>
          <Skeleton variant="block" count={2} label="Загрузка настроек" />
        </Card>
      ) : (
        <>
          <GroupedList footnote={`Последнее изменение: ${formatUpdatedAt(settings.updated_at)}`}>
            <GroupedRow
              label="Механизм защиты клан-тегов"
              description="Глобальный выключатель. Выключение мгновенно останавливает все предупреждения и кики."
              control={
                <>
                  <Badge tone={enabled ? 'good' : 'neutral'}>
                    {enabled ? 'Механизм активен' : 'Механизм выключен'}
                  </Badge>
                  <Switch
                    label="Механизм защиты клан-тегов"
                    checked={enabled}
                    disabled={!canManage}
                    onChange={(next) => {
                      setEnabled(next);
                      setNotice(null);
                    }}
                  />
                </>
              }
            />
          </GroupedList>

          <Card padding="none">
            <CardBody>
              <FieldRow
                label="Грейс-период (сек.)"
                htmlFor={graceId}
                hint="Время между предупреждением и киком, если игрок не сменил ник."
                error={fieldError}
              >
                <TextInput
                  id={graceId}
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min={0}
                  max={3600}
                  invalid={fieldError !== null}
                  value={gracePeriodInput}
                  disabled={!canManage}
                  onChange={(e) => {
                    setGracePeriodInput(e.target.value);
                    setFieldError(null);
                    setNotice(null);
                  }}
                />
              </FieldRow>
            </CardBody>
            {canManage ? (
              <CardFooter>
                <Button variant="primary" loading={saving} onClick={() => void save()}>
                  Сохранить
                </Button>
              </CardFooter>
            ) : null}
          </Card>
        </>
      )}
    </PageContainer>
  );
}
