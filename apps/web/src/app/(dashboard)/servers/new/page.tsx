'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LogConsole } from '@/components/LogConsole';

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function nameToSlug(name: string): string {
  const transliterated = name
    .toLowerCase()
    .split('')
    .map((ch) => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join('');
  return transliterated
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64);
}

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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
        ? 'Slug должен начинаться с латинской буквы или цифры (a-z, 0-9, дефис).'
        : msg.includes('body/display_name')
          ? 'Название обязательно.'
          : msg || `HTTP ${res.status}`;
      setError(`Не удалось создать сервер: ${human}`);
      return;
    }
    const created = (await res.json()) as CreateResponse;
    setServerId(created.id);
    setStep('installing');
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
      <form onSubmit={submit} className="space-y-4 max-w-xl">
        <h1 className="text-2xl font-semibold">Установка нового Squad-сервера</h1>
        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{error}</div>
        ) : null}
        <FieldText
          label="Название"
          value={form.display_name}
          onChange={(v) => {
            const next: typeof form = { ...form, display_name: v };
            if (!form.slug_touched) next.slug = nameToSlug(v);
            setForm(next);
          }}
          placeholder="My Squad Server"
          required
        />
        <FieldText
          label="Slug (только латиница, цифры, дефисы)"
          value={form.slug}
          onChange={(v) =>
            setForm({
              ...form,
              slug: sanitizeSlug(v),
              slug_touched: true,
            })
          }
          placeholder="my-squad"
          pattern="^[a-z0-9][a-z0-9-]{0,63}$"
          required
        />
        <div className="grid grid-cols-2 gap-4">
          <FieldNumber
            label="Game (UDP)"
            value={form.game_port}
            onChange={(v) => setForm({ ...form, game_port: v })}
          />
          <FieldNumber
            label="Query (UDP)"
            value={form.query_port}
            onChange={(v) => setForm({ ...form, query_port: v })}
          />
          <FieldNumber
            label="Beacon (UDP)"
            value={form.beacon_port}
            onChange={(v) => setForm({ ...form, beacon_port: v })}
          />
          <FieldNumber
            label="RCON (TCP)"
            value={form.rcon_port}
            onChange={(v) => setForm({ ...form, rcon_port: v })}
          />
        </div>
        <FieldNumber
          label="Макс. игроков"
          value={form.max_players}
          onChange={(v) => setForm({ ...form, max_players: v })}
        />
        <button
          type="submit"
          className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500"
        >
          Установить
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">
        {step === 'installing' ? 'Установка…' : step === 'done' ? 'Готово ✓' : 'Ошибка установки'}
      </h1>
      {serverId ? (
        <div className="text-xs text-neutral-500 font-mono">server id: {serverId}</div>
      ) : null}
      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm">{error}</div>
      ) : null}
      <LogConsole
        lines={lines}
        height="24rem"
        live={step === 'installing'}
        showStep
        emptyText="Ожидание первого сообщения…"
      />
      {step === 'done' && serverId ? (
        <button
          type="button"
          className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500"
          onClick={() => router.push(`/servers/${serverId}`)}
        >
          Открыть сервер
        </button>
      ) : null}
    </div>
  );
}

function FieldText(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  pattern?: string;
  required?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-widest text-neutral-400">{props.label}</span>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        pattern={props.pattern}
        required={props.required}
        className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
      />
    </label>
  );
}

function FieldNumber(props: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-widest text-neutral-400">{props.label}</span>
      <input
        type="number"
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
      />
    </label>
  );
}
