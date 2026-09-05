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
  SegmentedControl,
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

/**
 * Два способа добавить сервер: развернуть контейнер на хосте панели или
 * подключить уже работающий сервер по RCON. У второго нет установки — панель
 * лишь сохраняет адрес и пароль, а worker-rcon начинает опрос сам.
 */
type Mode = 'install' | 'external';

const MODE_ITEMS = [
  { value: 'install', label: 'Установить на этом хосте' },
  { value: 'external', label: 'Подключить существующий' },
] as const;

const EXTERNAL_DEFAULTS = {
  rcon_host: '',
  rcon_port: 21114,
  rcon_password: '',
  query_port: 27165,
  game_port: 7787,
  max_players: 100,
};

export default function NewServerWizard() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('install');
  const [step, setStep] = useState<'form' | 'installing' | 'done' | 'error'>('form');
  const [external, setExternal] = useState({
    display_name: '',
    slug: '',
    slug_touched: false,
    ...EXTERNAL_DEFAULTS,
  });
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

  async function submitExternal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { slug_touched: _slugTouched, ...payload } = external;
    const res = await fetch('/api/v1/servers/external', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        message?: string;
        error?: string;
      } | null;
      const msg = body?.message ?? '';
      const human =
        body?.error === 'slug_in_use'
          ? 'Такой идентификатор уже занят другим сервером.'
          : msg.includes('body/slug')
            ? 'Идентификатор должен начинаться с латинской буквы или цифры (a-z, 0-9, дефис).'
            : msg.includes('body/rcon_host')
              ? 'Адрес RCON — имя хоста или IP без схемы и порта.'
              : msg || `HTTP ${res.status}`;
      setError(`Не удалось подключить сервер: ${human}`);
      setSubmitting(false);
      return;
    }
    const created = (await res.json()) as CreateResponse;
    router.push(`/servers/${created.id}`);
  }

  if (step === 'form') {
    return (
      <PageContainer width="form">
        <PageHeader
          title={
            mode === 'install'
              ? 'Установка нового Squad-сервера'
              : 'Подключение существующего сервера'
          }
          backHref="/servers"
          backLabel="К списку серверов"
        />
        {error && (
          <InlineBanner
            tone="crit"
            title={mode === 'install' ? 'Установка не начата' : 'Сервер не подключён'}
            description={error}
          />
        )}
        <SegmentedControl
          ariaLabel="Способ добавления сервера"
          items={[...MODE_ITEMS]}
          value={mode}
          onChange={(next) => {
            setMode(next as Mode);
            setError(null);
          }}
        />
        {mode === 'external' ? (
          <Card as="section">
            <form onSubmit={submitExternal} className="space-y-4">
              <p className="text-xs text-ink-3">
                Панель подключится к серверу по RCON и начнёт опрашивать игроков, отряды, карту и
                очередь; команды администрирования (кик, бан, предупреждение, смена карты,
                объявления) тоже пойдут через RCON. Хост сервера должен пропускать TCP-соединения с
                адреса панели на порт RCON.
              </p>
              <FieldRow label="Название" required>
                <TextInput
                  value={external.display_name}
                  onChange={(e) => {
                    const v = e.target.value;
                    const next: typeof external = { ...external, display_name: v };
                    if (!external.slug_touched) next.slug = nameToSlug(v);
                    setExternal(next);
                  }}
                  placeholder="RAAS/AAS #1"
                  required
                />
              </FieldRow>
              <FieldRow
                label="Идентификатор"
                hint="Только латиница, цифры и дефисы; первым символом — буква или цифра."
                required
              >
                <TextInput
                  value={external.slug}
                  onChange={(e) =>
                    setExternal({
                      ...external,
                      slug: sanitizeSlug(e.target.value),
                      slug_touched: true,
                    })
                  }
                  placeholder="raas-1"
                  pattern="^[a-z0-9][a-z0-9-]{0,63}$"
                  required
                />
              </FieldRow>
              <div className="grid grid-cols-2 gap-4">
                <FieldRow label="Адрес RCON" hint="Имя хоста или IP, без порта." required>
                  <TextInput
                    value={external.rcon_host}
                    onChange={(e) => setExternal({ ...external, rcon_host: e.target.value.trim() })}
                    placeholder="203.0.113.10"
                    autoComplete="off"
                    required
                  />
                </FieldRow>
                <PortField
                  label="Порт RCON (TCP)"
                  value={external.rcon_port}
                  onChange={(v) => setExternal({ ...external, rcon_port: v })}
                />
              </div>
              <FieldRow
                label="Пароль RCON"
                hint="Из Rcon.cfg сервера; хранится зашифрованным."
                required
              >
                <TextInput
                  type="password"
                  value={external.rcon_password}
                  onChange={(e) => setExternal({ ...external, rcon_password: e.target.value })}
                  autoComplete="new-password"
                  required
                />
              </FieldRow>
              <div className="grid grid-cols-2 gap-4">
                <PortField
                  label="Порт запросов (UDP, A2S)"
                  value={external.query_port}
                  onChange={(v) => setExternal({ ...external, query_port: v })}
                />
                <PortField
                  label="Игровой порт (UDP)"
                  value={external.game_port}
                  onChange={(v) => setExternal({ ...external, game_port: v })}
                />
              </div>
              <PortField
                label="Макс. игроков"
                value={external.max_players}
                onChange={(v) => setExternal({ ...external, max_players: v })}
              />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" loading={submitting}>
                  Подключить
                </Button>
              </div>
            </form>
          </Card>
        ) : (
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
        )}
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
