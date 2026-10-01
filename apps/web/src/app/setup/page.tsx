'use client';
import { useCallback, useEffect, useState } from 'react';
import { SteamLoginLink } from '@/components/SteamLoginLink';
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
import { apiFetch, apiResult } from '@/lib/api';

interface SetupStatus {
  setup_completed: boolean;
  first_owner_claimed: boolean;
}

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
    apiFetch<SetupStatus>('/api/v1/setup/status')
      .then((s) => {
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
      const r = await apiResult<void>('/api/v1/setup/complete', {
        method: 'POST',
        json: { organization_name: orgName.trim() },
        discardBody: true,
      });
      if (!r.ok) {
        if (r.error.status === 410) {
          window.location.href = '/';
          return;
        }
        if (r.error.status === 401) {
          window.location.href = '/login';
          return;
        }
        const body = r.error.jsonBody<{ error?: string } | null>();
        throw new Error(body?.error ?? `HTTP ${r.error.status}`);
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
            subtitle="Для начала работы войдите через Steam. Первый вошедший автоматически станет Owner."
          />
          {statusBanner}
          <Card>
            <SteamLoginLink>Войти через Steam</SteamLoginLink>
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
