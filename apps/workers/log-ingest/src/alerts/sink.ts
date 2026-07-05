import type { AlertChannel, AlertEventDraft } from './engine.js';

export interface EmailConfig {
  smtpUrl: string;
  from: string;
  to: string[];
}

export interface WebPushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  subscriptions: string[];
}

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  body: string;
}

export interface WebPushMessage {
  subscriptions: string[];
  title: string;
  body: string;
}

export type EmailTransport = (message: EmailMessage) => Promise<void>;
export type WebPushTransport = (message: WebPushMessage) => Promise<void>;

export interface AlertSinkDeps {
  emailConfig?: EmailConfig | null;
  webpushConfig?: WebPushConfig | null;
  sendEmail?: EmailTransport | null;
  sendWebPush?: WebPushTransport | null;
}

export interface ChannelDeliveryResult {
  channel: AlertChannel;
  delivered: boolean;
  reason?: string;
}

export interface DeliveryOutcome {
  delivered: boolean;
  results: ChannelDeliveryResult[];
}

function subjectFor(alert: AlertEventDraft): string {
  return `[${alert.severity}] ${alert.ruleName}`;
}

function bodyFor(alert: AlertEventDraft): string {
  return JSON.stringify(alert.payload);
}

async function deliverEmail(
  alert: AlertEventDraft,
  deps: AlertSinkDeps,
): Promise<ChannelDeliveryResult> {
  const config = deps.emailConfig;
  const transport = deps.sendEmail;
  if (!config || !transport || config.to.length === 0) {
    return { channel: 'email', delivered: false, reason: 'email_unconfigured' };
  }
  try {
    await transport({
      from: config.from,
      to: config.to,
      subject: subjectFor(alert),
      body: bodyFor(alert),
    });
    return { channel: 'email', delivered: true };
  } catch (err) {
    return { channel: 'email', delivered: false, reason: (err as Error).message };
  }
}

async function deliverWebPush(
  alert: AlertEventDraft,
  deps: AlertSinkDeps,
): Promise<ChannelDeliveryResult> {
  const config = deps.webpushConfig;
  const transport = deps.sendWebPush;
  if (!config || !transport || config.subscriptions.length === 0) {
    return { channel: 'webpush', delivered: false, reason: 'webpush_unconfigured' };
  }
  try {
    await transport({
      subscriptions: config.subscriptions,
      title: subjectFor(alert),
      body: bodyFor(alert),
    });
    return { channel: 'webpush', delivered: true };
  } catch (err) {
    return { channel: 'webpush', delivered: false, reason: (err as Error).message };
  }
}

export async function deliverAlert(
  alert: AlertEventDraft,
  channels: readonly AlertChannel[],
  deps: AlertSinkDeps = {},
): Promise<DeliveryOutcome> {
  const results: ChannelDeliveryResult[] = [];
  for (const channel of channels) {
    if (channel === 'email') {
      results.push(await deliverEmail(alert, deps));
    } else if (channel === 'webpush') {
      results.push(await deliverWebPush(alert, deps));
    }
  }
  return { delivered: results.some((result) => result.delivered), results };
}

export function sinkDepsFromEnv(env: NodeJS.ProcessEnv = process.env): AlertSinkDeps {
  const smtpUrl = env.ALERT_SMTP_URL;
  const emailFrom = env.ALERT_EMAIL_FROM;
  const emailTo = env.ALERT_EMAIL_TO;
  const emailConfig: EmailConfig | null =
    smtpUrl && emailFrom && emailTo
      ? {
          smtpUrl,
          from: emailFrom,
          to: emailTo
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        }
      : null;

  const vapidPublicKey = env.ALERT_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = env.ALERT_VAPID_PRIVATE_KEY;
  const webpushConfig: WebPushConfig | null =
    vapidPublicKey && vapidPrivateKey
      ? { vapidPublicKey, vapidPrivateKey, subscriptions: [] }
      : null;

  return { emailConfig, webpushConfig, sendEmail: null, sendWebPush: null };
}
