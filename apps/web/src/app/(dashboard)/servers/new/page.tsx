'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LogConsole } from '@/components/LogConsole';
import {
  Button,
  Card,
  FieldRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  TextInput,
} from '@/components/ui';
import { nameToSlug, sanitizeSlug } from './_slug';

interface ProgressLine {
  ts: string;
  step: string;
  stream?: 'stdout' | 'stderr';
  message: string;
}

interface CreateResponse {
  id: string;
  status: string;
}

const DEFAULT_PORTS = {
  game_port: 7787,
  query_port: 27165,
  beacon_port: 15000,
  rcon_port: 21114,
};

/** Заголовок шага установки. Порядок ключей — порядок шагов мастера. */
const STAGE_TITLE = {
  installing: 'Установка…',
  done: 'Готово',
  error: 'Ошибка установки',
} as const;

export default function NewServerWizard() {
  const router = useRouter();
  const [step, setStep] = useState<'form' | 'installing' | 'done' | 'error'>('form');
  const [form, setForm] = useState({
    display_name: '',
    slug: '',
    slug_touched: false,
    ...DEFAULT_PORTS,
    max_players: 20,
  });
  const [serverId, setServerId] = useState<string | null>(null);
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { slug_touched: _slugTouched, ...payload } = form;
    const res = await fetch('/api/v1/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      const msg = body?.message ?? '';
      const human = msg.includes('body/slug')
        ? 'Идентификатор должен начинаться с латинской буквы или цифры (a-z, 0-9, дефис).'
        : msg.includes('body/display_name')
          ? 'Название обязательно.'
          : msg || `HTTP ${res.status}`;
      setError(`Не удалось создать сервер: ${human}`);
      setSubmitting(false);
      return;
    }
    const created = (await res.json()) as CreateResponse;
    setServerId(created.id);
    setStep('installing');
    setSubmitting(false);
    const install = await fetch(`/api/v1/servers/${created.id}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({}),
    });
    if (!install.ok) {
      setError(`Не удалось запустить установку (HTTP ${install.status})`);
      setStep('error');
      return;
    }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${window.location.host}/api/v1/servers/${created.id}/install/ws`,
    );
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data);
        if (frame.done) {
          setStep(frame.final === 'done' ? 'done' : 'error');
          ws.close();
          return;
        }
        if (frame.error) {
          setError(String(frame.error));
          setStep('error');
          ws.close();
          return;
        }
        setLines((prev) => [...prev, frame as ProgressLine]);
      } catch {
        // ignore bad frame
      }
    };
    ws.onerror = () => {
      setError('Потеряно соединение с API');
      setStep('error');
    };
  }

  if (step === 'form') {
    return (
      <PageContainer width="form">
        <PageHeader
          title="Установка нового Squad-сервера"
          backHref="/servers"
          backLabel="К списку серверов"
        />
        {error && <InlineBanner tone="crit" title="Установка не начата" description={error} />}
        <Card as="section">
          <form onSubmit={submit} className="space-y-4">
            <FieldRow label="Название" required>
              <TextInput
                value={form.display_name}
                onChange={(e) => {
                  const v = e.target.value;
                  const next: typeof form = { ...form, display_name: v };
                  if (!form.slug_touched) next.slug = nameToSlug(v);
                  setForm(next);
                }}
                placeholder="My Squad Server"
                required
              />
            </FieldRow>

            <FieldRow
              label="Идентификатор"
              hint="Только латиница, цифры и дефисы; первым символом — буква или цифра."
              required
            >
              <TextInput
                value={form.slug}
                onChange={(e) =>
                  setForm({ ...form, slug: sanitizeSlug(e.target.value), slug_touched: true })
                }
                placeholder="my-squad"
                pattern="^[a-z0-9][a-z0-9-]{0,63}$"
                required
              />
            </FieldRow>

            <div className="grid grid-cols-2 gap-4">
              <PortField
                label="Game (UDP)"
                value={form.game_port}
                onChange={(v) => setForm({ ...form, game_port: v })}
              />
              <PortField
                label="Query (UDP)"
                value={form.query_port}
                onChange={(v) => setForm({ ...form, query_port: v })}
              />
              <PortField
                label="Beacon (UDP)"
                value={form.beacon_port}
                onChange={(v) => setForm({ ...form, beacon_port: v })}
              />
              <PortField
                label="RCON (TCP)"
                value={form.rcon_port}
                onChange={(v) => setForm({ ...form, rcon_port: v })}
              />
            </div>

            <PortField
              label="Макс. игроков"
              value={form.max_players}
              onChange={(v) => setForm({ ...form, max_players: v })}
            />

            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={submitting}>
                Установить
              </Button>
            </div>
          </form>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      <PageHeader
        title={STAGE_TITLE[step]}
        backHref="/servers"
        backLabel="К списку серверов"
        meta={serverId ? <span className="font-mono">ID сервера: {serverId}</span> : undefined}
      />
      {error && <InlineBanner tone="crit" title="Ошибка установки" description={error} />}
      <LogConsole
        lines={lines}
        height="24rem"
        live={step === 'installing'}
        showStep
        emptyText="Ожидание первого сообщения…"
      />
      {step === 'done' && serverId ? (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => router.push(`/servers/${serverId}`)}>
            Открыть сервер
          </Button>
        </div>
      ) : null}
    </PageContainer>
  );
}

/**
 * Числовое поле мастера: порт или предел игроков.
 *
 * Отдельный компонент остаётся ради пяти одинаковых полей подряд — вместе они
 * держат один формат ввода, и разъехаться им нельзя.
 */
function PortField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <FieldRow label={label}>
      <TextInput type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </FieldRow>
  );
}
