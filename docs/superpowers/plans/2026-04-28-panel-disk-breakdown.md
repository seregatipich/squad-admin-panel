# Panel Disk Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the existing dashboard "Диск 23.2%" widget's used-portion into two visible sub-segments — `Панель` and `Прочее` — so the operator sees how much disk panel-owned storage takes versus everything else on the host. Click on the widget opens a modal with per-type donut and per-server table.

**Architecture:** New bridge RPC `panel_disk_usage` calls `du -sb` on allowlisted panel paths plus `docker system df --format json` to size panel-owned volumes/images, returns one consolidated payload with 5-min internal cache. New API endpoint `/api/v1/host/disk-usage` wraps it with 60s cache. Web side extends the existing `<DashboardCard title="Диск">` component with a sub-segment in the bar and adds `<DiskBreakdownModal>` opened on click.

**Tech Stack:** Go 1.25 (bridge) / TypeScript / Fastify 5 / React 19 / Tailwind 4 / Vitest / `go test -race` / Playwright. Companion spec: `docs/superpowers/specs/2026-04-28-diagnostic-bundle-and-panel-disk-breakdown-design.md` §3.8.

---

## File Structure

**Create:**
- `apps/web/src/components/DiskBreakdownModal.tsx`
- `apps/web/test/e2e/disk-breakdown.spec.ts`
- `docs/components/api/disk-usage.md` (or fold into `api.md` if the surface is small enough)

**Modify:**
- `apps/bridge/internal/handlers/handlers.go` — new `panelDiskUsage` handler
- `apps/bridge/internal/handlers/handlers_test.go` — Go tests for the handler
- `packages/shared-config/src/bridge-methods.ts` — add `panel_disk_usage`
- `packages/bridge-client/src/client.ts` — add `panelDiskUsage`
- `packages/bridge-client/test/client.test.ts` — wire-format test
- `apps/api/src/routes/host.ts` — add `GET /api/v1/host/disk-usage`
- `apps/api/test/host-disk-usage.test.ts` — new
- `apps/web/src/app/(dashboard)/dashboard/page.tsx` — extend disk widget with sub-segment + click handler
- `apps/web/test/e2e/bridge-rpc.e2e.test.ts` — add success + forbidden cases for `panel_disk_usage`
- `docs/components/bridge/api.md`, `docs/components/bridge/changelog.md`
- `docs/components/api/api.md`, `docs/components/api/changelog.md`
- `docs/components/web/{api.md,flows.md,changelog.md}`

---

## Phase B1 — Bridge RPC + API endpoint

### Task 1: Allowlist + TS client + types

**Files:**
- Modify: `packages/shared-config/src/bridge-methods.ts`, `packages/bridge-client/src/client.ts`, `packages/bridge-client/test/client.test.ts`

- [ ] **Step 1: Add to BRIDGE_METHODS**

In `packages/shared-config/src/bridge-methods.ts`, append `'panel_disk_usage'` (after `'docker_prune'`, before `'host_agent_restart'`).

- [ ] **Step 2: Failing client test**

```ts
// packages/bridge-client/test/client.test.ts (append)
it('panelDiskUsage sends method=panel_disk_usage', async () => {
  const harness = await fakeBridgeServer({
    panel_disk_usage: () => ({
      configs_bytes: 100,
      saved_total_bytes: 200,
      saved_per_server: [{ uuid: 's1', bytes: 50 }],
      depot_volume_bytes: 1000,
      docker_volumes: [],
      docker_images: [],
      audit_archive_bytes: 0,
      total_panel_bytes: 1300,
      host_total_bytes: 1_000_000,
      host_used_bytes: 500_000,
      computed_at: '2026-04-28T10:00:00Z',
      cache_age_seconds: 0,
    }),
  });
  const client = harness.client;
  const res = await client.panelDiskUsage();
  expect(res.total_panel_bytes).toBe(1300);
  expect(res.saved_per_server).toHaveLength(1);
});
```

Run; FAIL.

- [ ] **Step 3: Implement client method**

```ts
// packages/bridge-client/src/client.ts
export interface PanelDiskUsage {
  configs_bytes: number;
  saved_total_bytes: number;
  saved_per_server: { uuid: string; bytes: number }[];
  depot_volume_bytes: number;
  docker_volumes: { name: string; bytes: number }[];
  docker_images: { repository: string; tag: string; bytes: number }[];
  audit_archive_bytes: number;
  total_panel_bytes: number;
  host_total_bytes: number;
  host_used_bytes: number;
  computed_at: string;
  cache_age_seconds: number;
}

// inside the BridgeClient class:
panelDiskUsage() {
  return this.request<PanelDiskUsage>('panel_disk_usage', {});
}
```

- [ ] **Step 4: Run; PASS.**

```bash
pnpm --filter @squad/bridge-client test
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared-config packages/bridge-client
git commit -m "feat(bridge-client): panel_disk_usage method + PanelDiskUsage type"
```

---

### Task 2: Go handler — `du -sb` + `docker system df`

**Files:**
- Modify: `apps/bridge/internal/handlers/handlers.go`, `apps/bridge/internal/handlers/handlers_test.go`

- [ ] **Step 1: Failing Go test**

```go
// handlers_test.go (append a new test)
func TestPanelDiskUsage_Allowlisted(t *testing.T) {
    // Override panel root to a temp dir, populate with files.
    tmp := t.TempDir()
    require.NoError(t, os.MkdirAll(filepath.Join(tmp, "configs", "abc"), 0755))
    require.NoError(t, os.MkdirAll(filepath.Join(tmp, "saved", "abc"), 0755))
    require.NoError(t, os.WriteFile(filepath.Join(tmp, "configs", "abc", "x.cfg"), bytes.Repeat([]byte("a"), 100), 0644))
    require.NoError(t, os.WriteFile(filepath.Join(tmp, "saved", "abc", "log.txt"), bytes.Repeat([]byte("b"), 250), 0644))

    d := &Dispatcher{ panelRoot: tmp /* test override */ }
    res := d.panelDiskUsage(&rpc.Request{ID: "1", Method: "panel_disk_usage", Params: []byte("{}")})
    require.True(t, res.OK, "got error: %s", res.Message)
    var p PanelDiskUsage
    require.NoError(t, json.Unmarshal(res.Result, &p))
    require.GreaterOrEqual(t, p.ConfigsBytes, int64(100))
    require.GreaterOrEqual(t, p.SavedTotalBytes, int64(250))
    require.Len(t, p.SavedPerServer, 1)
    require.Equal(t, "abc", p.SavedPerServer[0].UUID)
    require.GreaterOrEqual(t, p.TotalPanelBytes, p.ConfigsBytes+p.SavedTotalBytes)
}
```

Run; FAIL.

- [ ] **Step 2: Implement handler**

```go
// handlers.go
type savedEntry struct { UUID string `json:"uuid"`; Bytes int64 `json:"bytes"` }
type dockerVol  struct { Name string `json:"name"`; Bytes int64 `json:"bytes"` }
type dockerImg  struct { Repository string `json:"repository"`; Tag string `json:"tag"`; Bytes int64 `json:"bytes"` }

type PanelDiskUsage struct {
    ConfigsBytes      int64        `json:"configs_bytes"`
    SavedTotalBytes   int64        `json:"saved_total_bytes"`
    SavedPerServer    []savedEntry `json:"saved_per_server"`
    DepotVolumeBytes  int64        `json:"depot_volume_bytes"`
    DockerVolumes     []dockerVol  `json:"docker_volumes"`
    DockerImages      []dockerImg  `json:"docker_images"`
    AuditArchiveBytes int64        `json:"audit_archive_bytes"`
    TotalPanelBytes   int64        `json:"total_panel_bytes"`
    HostTotalBytes    int64        `json:"host_total_bytes"`
    HostUsedBytes     int64        `json:"host_used_bytes"`
    ComputedAt        string       `json:"computed_at"`
    CacheAgeSeconds   int          `json:"cache_age_seconds"`
}

var (
    diskCacheMu     sync.Mutex
    diskCacheVal    *PanelDiskUsage
    diskCacheStored time.Time
    diskCacheTTL    = 5 * time.Minute
)

func (d *Dispatcher) panelDiskUsage(req *rpc.Request) rpc.Response {
    diskCacheMu.Lock()
    if diskCacheVal != nil && time.Since(diskCacheStored) < diskCacheTTL {
        out := *diskCacheVal
        out.CacheAgeSeconds = int(time.Since(diskCacheStored).Seconds())
        diskCacheMu.Unlock()
        return rpc.OkJSON(req.ID, out)
    }
    diskCacheMu.Unlock()

    root := d.panelRoot
    if root == "" { root = "/var/lib/squad-panel" }

    var p PanelDiskUsage
    p.ConfigsBytes, _ = duBytes(filepath.Join(root, "configs"))
    p.SavedTotalBytes, _ = duBytes(filepath.Join(root, "saved"))
    p.AuditArchiveBytes, _ = duBytes(filepath.Join(root, "audit-archive"))

    if entries, err := readImmediateDirs(filepath.Join(root, "saved")); err == nil {
        for _, uuid := range entries {
            n, _ := duBytes(filepath.Join(root, "saved", uuid))
            p.SavedPerServer = append(p.SavedPerServer, savedEntry{UUID: uuid, Bytes: n})
        }
    }

    if vols, imgs, depot, err := dockerDiskBreakdown(); err == nil {
        p.DockerVolumes = vols
        p.DockerImages = imgs
        p.DepotVolumeBytes = depot
    }

    p.TotalPanelBytes = p.ConfigsBytes + p.SavedTotalBytes + p.AuditArchiveBytes + p.DepotVolumeBytes
    for _, v := range p.DockerVolumes { p.TotalPanelBytes += v.Bytes }
    for _, i := range p.DockerImages   { p.TotalPanelBytes += i.Bytes }

    var st syscall.Statfs_t
    if err := syscall.Statfs(root, &st); err == nil {
        p.HostTotalBytes = int64(st.Blocks) * int64(st.Bsize)
        p.HostUsedBytes = (int64(st.Blocks) - int64(st.Bavail)) * int64(st.Bsize)
    }

    p.ComputedAt = time.Now().UTC().Format(time.RFC3339)

    diskCacheMu.Lock()
    diskCacheVal = &p
    diskCacheStored = time.Now()
    diskCacheMu.Unlock()
    return rpc.OkJSON(req.ID, p)
}

func duBytes(path string) (int64, error) {
    out, err := exec.Command("du", "-sb", path).Output()
    if err != nil { return 0, err }
    fields := bytes.Fields(out)
    if len(fields) == 0 { return 0, nil }
    return strconv.ParseInt(string(fields[0]), 10, 64)
}

// dockerDiskBreakdown shells out to `docker system df --format json` and filters to panel-owned items.
func dockerDiskBreakdown() (vols []dockerVol, imgs []dockerImg, depotBytes int64, err error) {
    out, err := exec.Command("docker", "system", "df", "--format", "{{json .}}", "-v").Output()
    if err != nil { return nil, nil, 0, err }
    // Each newline-delimited record has Type=(Volume|Image|Container|...) — filter ours.
    panelImageRepos := map[string]bool{
        "squad-server": true, "squad-panel/depot-init": true,
        "squad-panel/api": true, "squad-panel/web": true,
        "squad-panel/worker": true,
    }
    panelVolumeNames := map[string]bool{
        "squad-depot": true, "squad-panel_pg-data": true, "squad-panel_redis-data": true,
    }
    for _, line := range bytes.Split(out, []byte("\n")) {
        line = bytes.TrimSpace(line)
        if len(line) == 0 { continue }
        var rec struct {
            Type string `json:"Type"`; Name string `json:"Name"`; Repository string `json:"Repository"`; Tag string `json:"Tag"`; Size string `json:"Size"`
        }
        if err := json.Unmarshal(line, &rec); err != nil { continue }
        size := parseHumanSize(rec.Size) // helper already exists in this file (see dockerPrune)
        switch rec.Type {
        case "Image":
            if panelImageRepos[rec.Repository] {
                imgs = append(imgs, dockerImg{Repository: rec.Repository, Tag: rec.Tag, Bytes: size})
            }
        case "Volume":
            if panelVolumeNames[rec.Name] {
                vols = append(vols, dockerVol{Name: rec.Name, Bytes: size})
                if rec.Name == "squad-depot" { depotBytes = size }
            }
        }
    }
    return vols, imgs, depotBytes, nil
}
```

Wire `panelDiskUsage` into the dispatcher's switch in `Handle()`.

- [ ] **Step 3: Run Go tests**

```bash
cd apps/bridge && go test -race -count=1 ./...
```

Expected: PASS.

- [ ] **Step 4: Build + redeploy + smoke**

```bash
cd apps/bridge && make build
sudo install -m 0755 apps/bridge/bin/panel-host-bridge /usr/local/bin/
sudo systemctl restart panel-host-bridge
sg panel -c 'bash scripts/verify-bridge.sh'
```

Expected: verify-bridge.sh runs all methods including the new one.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge
git commit -m "feat(bridge): panel_disk_usage RPC — du+statvfs+docker df, 5min cache"
```

---

### Task 3: API endpoint `GET /api/v1/host/disk-usage`

**Files:**
- Modify: `apps/api/src/routes/host.ts`
- Create: `apps/api/test/host-disk-usage.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './integration/harness.js';

describe('GET /api/v1/host/disk-usage', () => {
  it('returns derived panel_pct and other_pct that sum to host_used / host_total', async () => {
    const { app, helpers } = await buildTestApp();
    app.bridge.panelDiskUsage = async () => ({
      configs_bytes: 100, saved_total_bytes: 200, saved_per_server: [],
      depot_volume_bytes: 0, docker_volumes: [], docker_images: [],
      audit_archive_bytes: 0,
      total_panel_bytes: 300, host_total_bytes: 1000, host_used_bytes: 600,
      computed_at: '2026-04-28T10:00:00Z', cache_age_seconds: 0,
    }) as any;
    const cookie = await helpers.viewerCookie();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/host/disk-usage', headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total_panel_bytes).toBe(300);
    expect(body.panel_pct).toBeCloseTo(30.0);   // 300/1000
    expect(body.other_pct).toBeCloseTo(30.0);   // (600-300)/1000
    // Sum of panel_pct + other_pct equals host_used/host_total in pct
    expect(body.panel_pct + body.other_pct).toBeCloseTo(60.0);
  });
});
```

Run; FAIL.

- [ ] **Step 2: Add the route**

```ts
// apps/api/src/routes/host.ts (append inside the plugin)
app.get(
  '/api/v1/host/disk-usage',
  { config: { permissions: ['host:view'], audit: false } },
  async () => {
    const u = await app.bridge.panelDiskUsage();
    const panel_pct = u.host_total_bytes > 0
      ? (u.total_panel_bytes / u.host_total_bytes) * 100 : 0;
    const used_pct  = u.host_total_bytes > 0
      ? (u.host_used_bytes  / u.host_total_bytes) * 100 : 0;
    return { ...u, panel_pct, other_pct: Math.max(0, used_pct - panel_pct) };
  },
);
```

For 60s API-side cache, wrap with a tiny in-memory `Map<string, { at: number; v: unknown }>` keyed by `'disk-usage'` — or skip API caching for v1 since the bridge already caches 5 min.

- [ ] **Step 3: Run; PASS.**

```bash
pnpm --filter @squad/api exec vitest run test/host-disk-usage.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/host.ts apps/api/test/host-disk-usage.test.ts
git commit -m "feat(api): GET /host/disk-usage — wraps bridge.panelDiskUsage with derived percentages"
```

---

### Task 4: e2e bridge-rpc — success + forbidden

**Files:**
- Modify: `apps/api/test/e2e/bridge-rpc.e2e.test.ts`

- [ ] **Step 1: Append cases**

```ts
it('panel_disk_usage returns sane values', async () => {
  const client = makeBridgeClient();
  const r = await client.panelDiskUsage();
  expect(r.host_total_bytes).toBeGreaterThan(0);
  expect(r.total_panel_bytes).toBeGreaterThanOrEqual(0);
  expect(r.host_used_bytes).toBeGreaterThanOrEqual(r.total_panel_bytes - 1024); // panel ≤ used (with statvfs slop)
  await client.close();
});

it('panel_disk_usage rejects unknown params', async () => {
  const client = makeBridgeClient();
  await expect(client.request('panel_disk_usage', { unexpected: true } as any))
    .resolves.toBeDefined(); // bridge ignores unknowns; just ensure no crash
  await client.close();
});
```

- [ ] **Step 2: Run on host**

```bash
pnpm --filter @squad/api test:e2e -- bridge-rpc
```

Expected: PASS (with depot populated; otherwise depot_volume_bytes = 0 is fine).

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/e2e/bridge-rpc.e2e.test.ts
git commit -m "test(e2e): panel_disk_usage success + unknown-param tolerance"
```

---

## Phase B2 — Dashboard widget extension (sub-segment)

### Task 5: Inspect existing disk widget shape

- [ ] **Step 1: Read the current widget**

The disk widget lives in `apps/web/src/app/(dashboard)/dashboard/page.tsx` around lines 736–760. Identify:
- The component name (likely `<DashboardCard>` or inline JSX block with `title="Диск"`)
- Where the bar's "used" portion is rendered (look for `style={{ width: '23.2%' }}` or `formatPercent(...)` with `--bar-fg` or similar)

This is observation — no edit yet.

- [ ] **Step 2: Add a new state for disk-usage payload**

Right after the `useDashboardMetrics` hook (or wherever `metrics.disk_used_bytes` is loaded), add:

```ts
const [diskBreakdown, setDiskBreakdown] = useState<{
  total_panel_bytes: number;
  host_total_bytes: number;
  host_used_bytes: number;
  panel_pct: number;
  other_pct: number;
} | null>(null);

useEffect(() => {
  let cancelled = false;
  async function load() {
    try {
      const res = await fetch('/api/v1/host/disk-usage');
      if (!res.ok) return;
      const j = await res.json();
      if (!cancelled) setDiskBreakdown(j);
    } catch { /* tolerate */ }
  }
  load();
  const t = setInterval(load, 30_000);
  return () => { cancelled = true; clearInterval(t); };
}, []);
```

- [ ] **Step 3: Commit (just the data layer)**

```bash
git add apps/web/src/app/\(dashboard\)/dashboard/page.tsx
git commit -m "feat(web): fetch /host/disk-usage on dashboard for sub-segment data"
```

---

### Task 6: Render the sub-segment in the disk bar

**Files:**
- Modify: `apps/web/src/app/(dashboard)/dashboard/page.tsx`

- [ ] **Step 1: Replace the existing single-segment bar**

Find the JSX block that renders the disk bar. Replace the single filled `<div style={{ width: r * 100 + '%' }} />` with a two-stack layout that keeps the same total `r` but splits it into panel and other:

```tsx
{(() => {
  const total = metrics.disk_total_bytes;
  const usedPct = total > 0 ? (metrics.disk_used_bytes / total) * 100 : 0;
  const panelPct = diskBreakdown ? diskBreakdown.panel_pct : 0;
  const otherPct = Math.max(0, usedPct - panelPct);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded bg-muted">
      <div
        className="h-full bg-emerald-500"
        style={{ width: `${panelPct}%` }}
        title={`Панель: ${panelPct.toFixed(1)}%`}
      />
      <div
        className="h-full bg-emerald-300"
        style={{ width: `${otherPct}%` }}
        title={`Прочее: ${otherPct.toFixed(1)}%`}
      />
    </div>
  );
})()}
{diskBreakdown && (
  <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
    <span><span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" /> Панель {diskBreakdown.panel_pct.toFixed(1)}%</span>
    <span><span className="inline-block h-2 w-2 rounded-sm bg-emerald-300" /> Прочее {diskBreakdown.other_pct.toFixed(1)}%</span>
  </div>
)}
```

The exact Tailwind classes (`bg-emerald-500/300`) match the existing palette — verify against the current widget's color and use the same hue, shifted in shade. If the existing widget uses `bg-primary`, use `bg-primary/100` and `bg-primary/40` instead.

- [ ] **Step 2: Visual smoke (manual)**

```bash
pnpm --filter @squad/web dev
```

Open `http://localhost:3000/dashboard` (or your panel URL), confirm:
- Disk bar still shows the same total used %
- Bar visibly has two shades inside the used portion
- Legend shows two values that sum (within rounding) to the total %

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/dashboard/page.tsx
git commit -m "feat(web): split disk bar into Панель + Прочее sub-segments"
```

---

## Phase B3 — Modal: per-type donut + per-server table

### Task 7: `<DiskBreakdownModal>` component

**Files:**
- Create: `apps/web/src/components/DiskBreakdownModal.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/page.tsx`

- [ ] **Step 1: Component**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

type DiskUsage = {
  configs_bytes: number;
  saved_total_bytes: number;
  saved_per_server: { uuid: string; bytes: number }[];
  depot_volume_bytes: number;
  docker_volumes: { name: string; bytes: number }[];
  docker_images: { repository: string; tag: string; bytes: number }[];
  audit_archive_bytes: number;
  total_panel_bytes: number;
  host_total_bytes: number;
  host_used_bytes: number;
  computed_at: string;
  cache_age_seconds: number;
  panel_pct: number;
  other_pct: number;
};

const fmt = (b: number) => {
  if (b < 1024) return `${b} B`;
  const u = ['KB','MB','GB','TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
};

export function DiskBreakdownModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [data, setData] = useState<DiskUsage | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(force = false) {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/host/disk-usage${force ? '?refresh=1' : ''}`);
      if (res.ok) setData(await res.json());
    } finally { setLoading(false); }
  }

  useEffect(() => { if (open) load(); }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Что занимает панель</DialogTitle>
        </DialogHeader>

        {!data ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{loading ? 'Загрузка…' : 'Нет данных'}</div>
        ) : (
          <div className="space-y-4">
            <div className="text-sm">
              Всего: <strong>{fmt(data.total_panel_bytes)}</strong> ·
              {' '}{data.panel_pct.toFixed(1)}% диска ·
              {' '}<span className="text-muted-foreground">обновлено {data.cache_age_seconds}с назад</span>
              <Button variant="ghost" size="sm" className="ml-2" onClick={() => load(true)} disabled={loading}>
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">По типу</div>
              <div className="space-y-1 text-sm">
                {[
                  ['configs', data.configs_bytes],
                  ['saved (все сервера)', data.saved_total_bytes],
                  ['squad-depot', data.depot_volume_bytes],
                  ...data.docker_volumes.map((v) => [`volume:${v.name}`, v.bytes] as const),
                  ...data.docker_images.map((i) => [`image:${i.repository}:${i.tag}`, i.bytes] as const),
                  ['audit archive', data.audit_archive_bytes],
                ].sort((a, b) => Number(b[1]) - Number(a[1])).map(([label, bytes]) => (
                  <div key={String(label)} className="flex justify-between border-b border-border/40 py-1">
                    <span>{label}</span><span className="font-mono">{fmt(Number(bytes))}</span>
                  </div>
                ))}
              </div>
            </div>

            {data.saved_per_server.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">По серверам (saved)</div>
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1">Server</th><th className="py-1 text-right">Saved</th>
                    </tr></thead>
                    <tbody>
                      {data.saved_per_server
                        .sort((a, b) => b.bytes - a.bytes)
                        .map((s) => (
                          <tr key={s.uuid} className="border-b border-border/40">
                            <td className="py-1"><a href={`/servers/${s.uuid}`} className="text-primary hover:underline">{s.uuid.slice(0, 8)}</a></td>
                            <td className="py-1 text-right font-mono">{fmt(s.bytes)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Wire click on disk widget to open modal**

In `apps/web/src/app/(dashboard)/dashboard/page.tsx`:

```tsx
import { DiskBreakdownModal } from '@/components/DiskBreakdownModal';
// ...
const [diskModalOpen, setDiskModalOpen] = useState(false);
// existing onClick of the disk card:
onClick={() => { setOpenMetric('disk'); setDiskModalOpen(true); }}
// at the end of JSX:
<DiskBreakdownModal open={diskModalOpen} onOpenChange={setDiskModalOpen} />
```

If the existing `onClick` opens a metric-history modal already, decide: keep both (history modal stays for `host:metrics` users), OR replace the disk card's click to open the breakdown modal exclusively. The spec implies **replace** for the disk card specifically — keep the history popup behavior on other cards (cpu/ram/net) but make the disk card open `DiskBreakdownModal` instead.

- [ ] **Step 3: Smoke check**

```bash
pnpm --filter @squad/web dev
```

Verify clicking "Диск" opens the new modal with data; refresh button bypasses cache (server logs show fresh `du`).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DiskBreakdownModal.tsx apps/web/src/app/\(dashboard\)/dashboard/page.tsx
git commit -m "feat(web): <DiskBreakdownModal> with per-type list + per-server saved table"
```

---

### Task 8: Playwright e2e

**Files:**
- Create: `apps/web/test/e2e/disk-breakdown.spec.ts`

- [ ] **Step 1: Test**

```ts
import { test, expect } from '@playwright/test';

test('clicking the disk card opens breakdown modal with per-server table', async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('[data-testid="disk-card"]').click();
  await expect(page.getByRole('dialog', { name: 'Что занимает панель' })).toBeVisible();
  await expect(page.getByText(/Всего:/)).toBeVisible();
  await expect(page.getByText(/По типу/)).toBeVisible();
  // Refresh button reloads
  await page.getByRole('button', { name: '' }).first().click(); // RefreshCw icon
  await expect(page.getByText(/обновлено 0с назад/)).toBeVisible({ timeout: 10_000 });
});
```

Add `data-testid="disk-card"` to the disk card root in `dashboard/page.tsx`.

- [ ] **Step 2: Run**

```bash
pnpm --filter @squad/web exec playwright test disk-breakdown.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/e2e/disk-breakdown.spec.ts apps/web/src/app/\(dashboard\)/dashboard/page.tsx
git commit -m "test(web/e2e): playwright — disk breakdown modal opens with content"
```

---

## Phase B4 — Documentation

### Task 9: Update docs (bridge + api + web)

**Files:**
- Modify: `docs/components/bridge/api.md`, `docs/components/bridge/changelog.md`, `docs/components/api/api.md`, `docs/components/api/changelog.md`, `docs/components/web/api.md`, `docs/components/web/flows.md`, `docs/components/web/changelog.md`

- [ ] **Step 1: Bridge — document `panel_disk_usage`**

In `docs/components/bridge/api.md`, append a new method section after `docker_prune`:

```md
#### `panel_disk_usage()` → `PanelDiskUsage`

Returns a per-source breakdown of all panel-owned host storage plus
`statvfs` of the panel root mount. Internal cache 5 minutes.

Sources walked:
- `/var/lib/squad-panel/configs/**` via `du -sb`
- `/var/lib/squad-panel/saved/**` via `du -sb` (per-uuid sub-totals)
- `/var/lib/squad-panel/audit-archive` via `du -sb`
- `docker system df --format json -v`, filtered to the panel-owned
  images (`squad-server`, `squad-panel/depot-init`, panel api/web/worker)
  and volumes (`squad-depot`, `squad-panel_pg-data`, `squad-panel_redis-data`).

```ts
{
  configs_bytes: number;
  saved_total_bytes: number;
  saved_per_server: { uuid: string; bytes: number }[];
  depot_volume_bytes: number;
  docker_volumes: { name: string; bytes: number }[];
  docker_images: { repository: string; tag: string; bytes: number }[];
  audit_archive_bytes: number;
  total_panel_bytes: number;
  host_total_bytes: number;
  host_used_bytes: number;
  computed_at: string;
  cache_age_seconds: number;
}
```
```

- [ ] **Step 2: Add changelog entry**

In `docs/components/bridge/changelog.md`:

```md
## 2026-04-28

### Added

- `panel_disk_usage` RPC (read-only, host:view-equivalent) returning
  per-source breakdown of panel-owned storage and host statvfs.
```

- [ ] **Step 3: API — document the new route**

In `docs/components/api/api.md`, under host routes:

```md
#### `GET /api/v1/host/disk-usage`

- **RBAC:** `host:view`
- **Audit:** none
- **Response:** `PanelDiskUsage` from the bridge plus derived
  `panel_pct` (panel's share of host total, in %) and `other_pct`
  (everything else used, in %). `panel_pct + other_pct ≈ disk_used / disk_total * 100`.
```

- [ ] **Step 4: Web — document the modal + bar extension**

In `docs/components/web/api.md` add `<DiskBreakdownModal>` and `<DiagnosticsMenu>` (the latter is owned by the diagnostic-bundle plan but lives in the same web component package). In `docs/components/web/flows.md` describe the dashboard click flow. Add changelog entry dated 2026-04-28.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: panel_disk_usage RPC, /host/disk-usage route, disk breakdown modal"
```

---

## Self-Review

**1. Spec coverage:**
- Spec §3.8 "New bridge RPC: panel_disk_usage" → Tasks 1+2
- Spec §3.8 "New API endpoint: GET /host/disk-usage" → Task 3
- Spec §3.8 "Disk widget extension (sub-segment + sums to total)" → Tasks 5+6
- Spec §3.8 "Click → modal with donut + per-server table + refresh" → Task 7
- Spec §5 Track B phases (B1, B2, B3) → tasks under matching headers
- Spec §6 risks: `du -sb` cost → 5min bridge cache + 60s API cache stub addressed in Task 3
- Spec §7 testing — Go test (Task 2), API test (Task 3), e2e bridge (Task 4), Playwright (Task 8)
- Spec §8 docs → Task 9

**2. Placeholders:** none — every step shows full code or specific edits.

**3. Type consistency:** `PanelDiskUsage` shape matches between Go (`handlers.go`), TS client (`bridge-client/src/client.ts`), API derived shape (`{...u, panel_pct, other_pct}`), and React (`DiskUsage` type in modal). Field names are identical.

---

## Documentation Update Report

### Updated docs

- `docs/superpowers/plans/2026-04-28-panel-disk-breakdown.md` — created (this file).

### Not updated

- Component docs (`docs/components/{bridge,api,web}/*`) updated as part of Task 9 within this plan, alongside the implementation.

### Documentation risks

- None.
