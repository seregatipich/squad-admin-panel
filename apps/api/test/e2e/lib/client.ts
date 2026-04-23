/**
 * HTTP + WebSocket client for e2e tests. Talks to a live panel stack
 * over HTTPS. The tests assume docker compose is up, the Go bridge is
 * running, and an Owner session cookie is exported via PANEL_TEST_COOKIE.
 */
import { Agent, fetch as undiciFetch } from 'undici';
import WebSocket from 'ws';

export interface ApiClient {
  url: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  json: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  ws: (path: string) => WebSocket;
  waitFor: <T>(fn: () => Promise<T>, pred: (v: T) => boolean, opts?: WaitOpts) => Promise<T>;
}

export interface WaitOpts {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

export function baseUrl(): string {
  return process.env.PANEL_TEST_URL ?? 'https://squad-panel.lan';
}

export function sessionCookie(): string {
  return process.env.PANEL_TEST_COOKIE ?? '';
}

export function shouldSkip(): { skip: boolean; reason: string } {
  if (!sessionCookie()) {
    return {
      skip: true,
      reason:
        'PANEL_TEST_COOKIE unset. To run: log into the panel UI, copy __Host-sid value from devtools > Application > Cookies, then `PANEL_TEST_COOKIE=s_xxx pnpm --filter @squad/api test:e2e`',
    };
  }
  return { skip: false, reason: '' };
}

export function newClient(): ApiClient {
  const url = baseUrl();
  // Self-signed certs on squad-panel.lan — Caddy's internal CA. Accept
  // them explicitly for the test client.
  const agent = new Agent({ connect: { rejectUnauthorized: false } });
  const cookie = `__Host-sid=${sessionCookie()}`;

  const doFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const merged: RequestInit = {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        cookie,
        'content-type':
          init.body && typeof init.body === 'string'
            ? 'application/json'
            : ((init.headers as Record<string, string>)?.['content-type'] ?? 'application/json'),
      },
    };
    return (await undiciFetch(`${url}${path}`, {
      ...merged,
      dispatcher: agent,
    } as never)) as unknown as Response;
  };

  const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const r = await doFetch(path, init);
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${path}: ${text.slice(0, 500)}`);
    }
    return (await r.json()) as T;
  };

  const ws = (path: string): WebSocket => {
    const wsUrl = url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    return new WebSocket(`${wsUrl}${path}`, {
      rejectUnauthorized: false,
      headers: { cookie },
    });
  };

  const waitFor = async <T>(
    fn: () => Promise<T>,
    pred: (v: T) => boolean,
    opts: WaitOpts = {},
  ): Promise<T> => {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 1500;
    const label = opts.label ?? 'waitFor';
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        last = await fn();
        if (pred(last)) return last;
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `${label} timed out after ${timeoutMs}ms. last=${JSON.stringify(last)?.slice(0, 300)} err=${(lastErr as Error | undefined)?.message}`,
    );
  };

  return { url, fetch: doFetch, json, ws, waitFor };
}

export function randomPorts(): {
  game_port: number;
  query_port: number;
  beacon_port: number;
  rcon_port: number;
} {
  // Stagger away from Squad defaults 7787/27165/15000/21114 so e2e runs
  // don't collide with a hand-created server on the same host.
  const base = 27700 + Math.floor(Math.random() * 100);
  return {
    game_port: base,
    query_port: base + 100,
    beacon_port: base + 200,
    rcon_port: base + 300,
  };
}
