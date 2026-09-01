'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  FieldRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
  TextInput,
} from '@/components/ui';

interface SetupStatus {
  setup_completed: boolean;
  first_owner_claimed: boolean;
}

/**
 * Ссылка входа — обычный `<a>`, а не `ButtonLink`: `/api/v1/auth/bss/login`
 * начинает SSO-обмен и обязан получить полную навигацию документа, тогда как
 * `next/link` перехватил бы клик маршрутизатором и предзагрузил бы адрес.
 */
const SSO_LINK_CLASS =
  'inline-flex h-11 w-full items-center justify-center rounded-ctl bg-accent px-3 text-xs font-medium text-bg no-underline transition-colors duration-150 hover:brightness-110';

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [orgName, setOrgName] = useState('');
  const [busy, setBusy] = useState(false);
  /* Две разные ошибки и два разных выхода из них: статус перечитывают кнопкой
     «Повторить», а неудачную отправку — самой кнопкой «Завершить настройку». */
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    setStatusErr(null);
    fetch('/api/v1/setup/status', { credentials: 'include', cache: 'no-store' })
      .then((r) => r.json())
      .then((s: SetupStatus) => {
        if (s.setup_completed) {
          window.location.href = '/';
          return;
        }
        setStatus(s);
      })
      .catch(() => setStatusErr('Не удалось загрузить статус.'));
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function complete() {
    if (!orgName.trim()) return;
    setBusy(true);
    setSubmitErr(null);
    try {
      const r = await fetch('/api/v1/setup/complete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_name: orgName.trim() }),
      });
      if (r.status === 410) {
        window.location.href = '/';
        return;
      }
      if (r.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      window.location.href = '/';
    } catch (e) {
      setSubmitErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const statusBanner = statusErr ? (
    <InlineBanner
      tone="crit"
      title={statusErr}
      action={
        <Button size="sm" onClick={loadStatus}>
          Повторить
        </Button>
      }
    />
  ) : null;

  if (!status && !statusErr) {
    return (
      <main className="min-h-screen bg-bg px-6 py-16 text-ink">
        <PageContainer width="form">
          <PageHeader title="Настройка панели" />
          <Skeleton variant="card" label="Проверяем состояние панели" />
        </PageContainer>
      </main>
    );
  }

  if (!status?.first_owner_claimed) {
    return (
      <main className="min-h-screen bg-bg px-6 py-16 text-ink">
        <PageContainer width="form">
          <PageHeader
            title="Настройка панели"
            subtitle="Для начала работы войдите через BSS. Первая подтверждённая учётная запись автоматически станет Owner."
          />
          {statusBanner}
          <Card>
            <a href="/api/v1/auth/bss/login" className={SSO_LINK_CLASS}>
              Войти через BSS
            </a>
          </Card>
        </PageContainer>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg px-6 py-16 text-ink">
      <PageContainer width="form">
        <PageHeader
          title="Настройка панели"
          subtitle="Укажите название вашего сообщества или организации."
        />
        {statusBanner}
        {submitErr ? <InlineBanner tone="crit" title={submitErr} /> : null}

        <Card padding="none">
          <CardBody className="space-y-4">
            <FieldRow label="Название организации" required>
              <TextInput
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Мой Squad-сервер"
                maxLength={100}
              />
            </FieldRow>
            <Button
              variant="primary"
              fullWidth
              onClick={complete}
              disabled={!orgName.trim()}
              loading={busy}
            >
              Завершить настройку
            </Button>
          </CardBody>
        </Card>
      </PageContainer>
    </main>
  );
}
