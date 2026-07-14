'use client';
import { useEffect, useId, useState } from 'react';
import {
  type AltDetectionSettingsForm,
  isValidIpOrCidr,
  validateAltDetectionSettingsForm,
} from './helpers';

interface IgnoredIp {
  id: string;
  cidr: string;
  note: string | null;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
}

interface AltDetectionSettingsView extends AltDetectionSettingsForm {
  updated_at: string | null;
  updated_by_player_id: string | null;
}

type Banner = { kind: 'ok' | 'err'; text: string } | null;

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(`HTTP ${res.status}: ${body.error ?? 'unknown'}`);
  }
  return (await res.json()) as T;
}

export default function AltDetectionPage() {
  const [settings, setSettings] = useState<AltDetectionSettingsView | null>(null);
  const [ignoredIps, setIgnoredIps] = useState<IgnoredIp[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const [newCidr, setNewCidr] = useState('');
  const [newNote, setNewNote] = useState('');
  const [addingIp, setAddingIp] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const cidrInputId = useId();
  const noteInputId = useId();

  async function load() {
    const res = await fetch('/api/v1/settings/alt-detection', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) {
      setForbidden(true);
      return;
    }
    const body = await readJson<{ settings: AltDetectionSettingsView; ignored_ips: IgnoredIp[] }>(
      res,
    );
    setSettings(body.settings);
    setIgnoredIps(body.ignored_ips);
  }

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        await load();
      } catch (e) {
        if (!cancelled) setBanner({ kind: 'err', text: (e as Error).message });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  async function addIgnoredIp(e: React.FormEvent) {
    e.preventDefault();
    const cidr = newCidr.trim();
    if (!isValidIpOrCidr(cidr)) {
      setBanner({ kind: 'err', text: 'Некорректный IP-адрес или CIDR-блок.' });
      return;
    }
    setAddingIp(true);
    setBanner(null);
    try {
      const res = await fetch('/api/v1/settings/alt-detection/ignored-ips', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cidr, note: newNote.trim() || undefined }),
      });
      if (res.status === 409) {
        setBanner({ kind: 'err', text: 'Этот адрес уже добавлен в исключения.' });
        return;
      }
      await readJson(res);
      setNewCidr('');
      setNewNote('');
      await load();
      setBanner({ kind: 'ok', text: 'Исключение добавлено.' });
    } catch (e) {
      setBanner({ kind: 'err', text: (e as Error).message });
    } finally {
      setAddingIp(false);
    }
  }

  async function deleteIgnoredIp(row: IgnoredIp) {
    if (!confirm(`Удалить исключение «${row.cidr}»?`)) return;
    setBanner(null);
    try {
      const res = await fetch(`/api/v1/settings/alt-detection/ignored-ips/${row.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await readJson(res);
      await load();
      setBanner({ kind: 'ok', text: 'Исключение удалено.' });
    } catch (e) {
      setBanner({ kind: 'err', text: (e as Error).message });
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const validationError = validateAltDetectionSettingsForm(settings);
    if (validationError) {
      setBanner({ kind: 'err', text: validationError });
      return;
    }
    setSavingSettings(true);
    setBanner(null);
    try {
      const res = await fetch('/api/v1/settings/alt-detection', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          weight_shared_ip: settings.weight_shared_ip,
          weight_shared_name: settings.weight_shared_name,
          weight_young_account: settings.weight_young_account,
          weight_steamid_proximity: settings.weight_steamid_proximity,
          steamid_delta_threshold: settings.steamid_delta_threshold,
          medium_threshold: settings.medium_threshold,
          high_threshold: settings.high_threshold,
        }),
      });
      const updated = await readJson<AltDetectionSettingsView>(res);
      setSettings(updated);
      setBanner({ kind: 'ok', text: 'Параметры сохранены.' });
    } catch (e) {
      setBanner({ kind: 'err', text: (e as Error).message });
    } finally {
      setSavingSettings(false);
    }
  }

  function updateField(field: keyof AltDetectionSettingsForm, value: string) {
    setSettings((prev) => (prev ? { ...prev, [field]: Number(value) || 0 } : prev));
  }

  if (forbidden) {
    return (
      <div className="max-w-2xl rounded border border-red-900 bg-red-950 p-4 text-sm text-red-200">
        Недостаточно прав. Для просмотра детектора альтов нужен доступ «История IP».
      </div>
    );
  }

  if (loading || !settings) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Детектор альтов</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Настройки движка поиска кандидатов в альты по общим IP (см. карточку игрока → «Возможные
          альты»): исключения адресов из подсчёта очков и веса эвристик.
        </p>
      </div>

      {banner ? (
        <div
          className={`rounded border p-3 text-sm ${
            banner.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Игнорируемые IP и подсети
        </h2>
        <p className="text-xs text-neutral-500">
          Совпадения по этим адресам (VPN, CGNAT, интернет-кафе…) видны в списке кандидатов, но не
          увеличивают счёт.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-2">CIDR</th>
                <th className="py-2 pr-2">Заметка</th>
                <th className="py-2 pr-2">Автор</th>
                <th className="py-2 pr-2">Дата</th>
                <th className="py-2 pr-2" />
              </tr>
            </thead>
            <tbody>
              {ignoredIps.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-center text-xs text-neutral-500">
                    Исключений пока нет.
                  </td>
                </tr>
              ) : (
                ignoredIps.map((row) => (
                  <tr key={row.id} className="border-t border-neutral-900 align-top">
                    <td className="py-2 pr-2 font-mono text-[12px] text-neutral-200">{row.cidr}</td>
                    <td className="py-2 pr-2 text-neutral-400">{row.note ?? '—'}</td>
                    <td className="py-2 pr-2 text-neutral-500">{row.author_name ?? 'Система'}</td>
                    <td className="py-2 pr-2 text-neutral-500">
                      {new Date(row.created_at).toLocaleString('ru-RU')}
                    </td>
                    <td className="py-2 pr-2 text-right">
                      <button
                        type="button"
                        onClick={() => deleteIgnoredIp(row)}
                        className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-400 hover:border-red-700"
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <form onSubmit={addIgnoredIp} className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-neutral-500" htmlFor={cidrInputId}>
              IP или CIDR
            </label>
            <input
              id={cidrInputId}
              type="text"
              value={newCidr}
              onChange={(e) => setNewCidr(e.target.value)}
              placeholder="10.0.0.0/24"
              className="w-48 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-500" htmlFor={noteInputId}>
              Заметка (VPN, CGNAT, интернет-кафе…)
            </label>
            <input
              id={noteInputId}
              type="text"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              maxLength={500}
              className="w-64 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={addingIp || newCidr.trim() === ''}
            className="rounded border border-sky-900 px-4 py-1.5 text-sm text-sky-300 hover:border-sky-700 disabled:opacity-40"
          >
            Добавить
          </button>
        </form>
      </section>

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Параметры оценки</h2>
        <p className="text-xs text-neutral-500">
          Вес каждого сигнала прибавляется к счёту кандидата один раз, если сигнал сработал.
          Итоговый счёт определяет уровень доверия: low ниже «medium», medium — между порогами, high
          — на «high» и выше.
        </p>
        <form onSubmit={saveSettings} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <NumberField
            label="Вес: общий IP"
            value={settings.weight_shared_ip}
            onChange={(v) => updateField('weight_shared_ip', v)}
          />
          <NumberField
            label="Вес: общий ник"
            value={settings.weight_shared_name}
            onChange={(v) => updateField('weight_shared_name', v)}
          />
          <NumberField
            label="Вес: молодой аккаунт"
            value={settings.weight_young_account}
            onChange={(v) => updateField('weight_young_account', v)}
          />
          <NumberField
            label="Вес: близкий SteamID64"
            value={settings.weight_steamid_proximity}
            onChange={(v) => updateField('weight_steamid_proximity', v)}
          />
          <NumberField
            label="Порог дельты SteamID64"
            value={settings.steamid_delta_threshold}
            onChange={(v) => updateField('steamid_delta_threshold', v)}
          />
          <div />
          <NumberField
            label="Порог confidence: medium"
            value={settings.medium_threshold}
            onChange={(v) => updateField('medium_threshold', v)}
          />
          <NumberField
            label="Порог confidence: high"
            value={settings.high_threshold}
            onChange={(v) => updateField('high_threshold', v)}
          />
          <div className="flex items-end">
            <button
              type="submit"
              disabled={savingSettings}
              className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
            >
              Сохранить
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function NumberField(props: { label: string; value: number; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div>
      <label className="mb-1 block text-xs text-neutral-500" htmlFor={id}>
        {props.label}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
      />
    </div>
  );
}
