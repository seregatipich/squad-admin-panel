import { describe, expect, it } from 'vitest';
import type { AlertEventDraft } from '../src/alerts/engine.js';
import { type AlertSinkDeps, deliverAlert, sinkDepsFromEnv } from '../src/alerts/sink.js';

const alert: AlertEventDraft = {
  ruleId: 'rule-1',
  ruleName: 'Server crashed',
  severity: 'critical',
  payload: { eventType: 'server.crashed' },
};

describe('deliverAlert — unconfigured sink', () => {
  it('records email as undelivered without throwing when no transport is set', async () => {
    const outcome = await deliverAlert(alert, ['email']);
    expect(outcome.delivered).toBe(false);
    expect(outcome.results[0]).toEqual({
      channel: 'email',
      delivered: false,
      reason: 'email_unconfigured',
    });
  });

  it('records webpush as undelivered without throwing when no transport is set', async () => {
    const outcome = await deliverAlert(alert, ['webpush']);
    expect(outcome.delivered).toBe(false);
    expect(outcome.results[0]?.reason).toBe('webpush_unconfigured');
  });

  it('treats an empty recipient list as unconfigured', async () => {
    const deps: AlertSinkDeps = {
      emailConfig: { smtpUrl: 'smtp://localhost', from: 'a@b.c', to: [] },
      sendEmail: async () => undefined,
    };
    const outcome = await deliverAlert(alert, ['email'], deps);
    expect(outcome.delivered).toBe(false);
  });
});

describe('deliverAlert — configured sink', () => {
  it('delivers over email when a transport is injected', async () => {
    const sent: unknown[] = [];
    const deps: AlertSinkDeps = {
      emailConfig: {
        smtpUrl: 'smtp://localhost',
        from: 'alerts@panel.local',
        to: ['ops@panel.local'],
      },
      sendEmail: async (message) => {
        sent.push(message);
      },
    };
    const outcome = await deliverAlert(alert, ['email'], deps);
    expect(outcome.delivered).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('delivers over webpush when a transport is injected', async () => {
    const deps: AlertSinkDeps = {
      webpushConfig: { vapidPublicKey: 'pub', vapidPrivateKey: 'priv', subscriptions: ['sub-a'] },
      sendWebPush: async () => undefined,
    };
    const outcome = await deliverAlert(alert, ['webpush'], deps);
    expect(outcome.delivered).toBe(true);
  });

  it('records a transport failure as undelivered without throwing', async () => {
    const deps: AlertSinkDeps = {
      emailConfig: { smtpUrl: 'smtp://localhost', from: 'a@b.c', to: ['ops@panel.local'] },
      sendEmail: async () => {
        throw new Error('smtp connection refused');
      },
    };
    const outcome = await deliverAlert(alert, ['email'], deps);
    expect(outcome.delivered).toBe(false);
    expect(outcome.results[0]?.reason).toBe('smtp connection refused');
  });

  it('records a webpush transport failure as undelivered', async () => {
    const deps: AlertSinkDeps = {
      webpushConfig: { vapidPublicKey: 'pub', vapidPrivateKey: 'priv', subscriptions: ['sub-a'] },
      sendWebPush: async () => {
        throw new Error('push service unavailable');
      },
    };
    const outcome = await deliverAlert(alert, ['webpush'], deps);
    expect(outcome.delivered).toBe(false);
    expect(outcome.results[0]?.reason).toBe('push service unavailable');
  });

  it('reports delivered=true when any channel succeeds', async () => {
    const deps: AlertSinkDeps = {
      emailConfig: { smtpUrl: 'smtp://localhost', from: 'a@b.c', to: ['ops@panel.local'] },
      sendEmail: async () => undefined,
    };
    const outcome = await deliverAlert(alert, ['email', 'webpush'], deps);
    expect(outcome.delivered).toBe(true);
    expect(outcome.results).toHaveLength(2);
  });
});

describe('sinkDepsFromEnv', () => {
  it('returns null configs and null transports when the env is empty', () => {
    const deps = sinkDepsFromEnv({});
    expect(deps.emailConfig).toBeNull();
    expect(deps.webpushConfig).toBeNull();
    expect(deps.sendEmail).toBeNull();
    expect(deps.sendWebPush).toBeNull();
  });

  it('parses email config from the environment', () => {
    const deps = sinkDepsFromEnv({
      ALERT_SMTP_URL: 'smtp://mail.local',
      ALERT_EMAIL_FROM: 'alerts@panel.local',
      ALERT_EMAIL_TO: 'ops@panel.local, oncall@panel.local',
    } as NodeJS.ProcessEnv);
    expect(deps.emailConfig).toEqual({
      smtpUrl: 'smtp://mail.local',
      from: 'alerts@panel.local',
      to: ['ops@panel.local', 'oncall@panel.local'],
    });
    expect(deps.sendEmail).toBeNull();
  });

  it('parses webpush config from the environment', () => {
    const deps = sinkDepsFromEnv({
      ALERT_VAPID_PUBLIC_KEY: 'pub-key',
      ALERT_VAPID_PRIVATE_KEY: 'priv-key',
    } as NodeJS.ProcessEnv);
    expect(deps.webpushConfig).toEqual({
      vapidPublicKey: 'pub-key',
      vapidPrivateKey: 'priv-key',
      subscriptions: [],
    });
  });
});
