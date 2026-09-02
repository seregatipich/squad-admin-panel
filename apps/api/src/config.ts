import { z } from 'zod';

/**
 * An optional secret that compose may pass as a blank string.
 *
 * Both compose files write `SOME_SECRET: ${SOME_SECRET:-}`, so an unconfigured
 * secret arrives as `''`, not as `undefined`. Plain `.optional()` permits only
 * `undefined`, so `.min()` rejected the blank value and the API exited 1 in a
 * restart loop — the 2026-07-28 production outage. Treat blank as absent, which
 * is what an operator who left the variable unset means, while still rejecting a
 * short-but-non-empty secret that is a genuine misconfiguration.
 */
function optionalSecret(min: number) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(min).optional(),
  );
}

function optionalText() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional(),
  );
}

function optionalUrl() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional(),
  );
}

function optionalSsoSecret() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .min(32)
      .max(512)
      .refine((value) => !/\s/u.test(value), 'BSS SSO secrets must not contain whitespace')
      .optional(),
  );
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    APP_ENCRYPTION_KEY: z
      .string()
      .min(32, 'APP_ENCRYPTION_KEY must be at least 32 bytes (base64 of 32 random bytes)'),
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
    SESSION_TOUCH_THROTTLE_SECONDS: z.coerce.number().int().positive().default(60),
    BRIDGE_SOCKET: z.string().default('/run/panel-host-bridge/bridge.sock'),
    COOKIE_SECURE: z.coerce.boolean().default(true),
    APP_DOMAIN: z.string().default('admin.localhost'),
    PANEL_PUBLIC_URL: z.string().url(),
    STEAM_API_KEY: z.string().optional(),
    BSS_SITE_URL: optionalUrl(),
    BSS_SSO_CLIENT_ID: optionalText(),
    BSS_SSO_CLIENT_SECRET: optionalSsoSecret(),
    BSS_SSO_CLIENT_SECRET_NEXT: optionalSsoSecret(),
    DISCORD_CLIENT_ID: z.string().optional(),
    DISCORD_CLIENT_SECRET: z.string().optional(),
    DISCORD_PUBLIC_KEY: z.string().optional(),
    GLITCHTIP_DSN: z.string().optional(),
    VIP_LIFECYCLE_WEBHOOK_SECRET: optionalSecret(32),
    VIP_LIFECYCLE_REQUIRE_REVISION: z.preprocess(
      (value) => (value === undefined || value === '' ? 'false' : value),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ),
    BALANCER_WEBHOOK_SECRET: optionalSecret(32),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    MEDIA_STORAGE_DIR: z.string().default('./media'),
    // VIDEO-4 (#160) media publishing. Optional on both sides: the API only ever
    // reports whether a destination is configured, and `worker-media-publisher`
    // defers publications for a destination whose credentials are missing instead
    // of failing them. Blank values therefore disable a destination cleanly.
    YOUTUBE_CLIENT_ID: z.string().optional(),
    YOUTUBE_CLIENT_SECRET: z.string().optional(),
    YOUTUBE_REFRESH_TOKEN: z.string().optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    const required = [
      ['BSS_SITE_URL', config.BSS_SITE_URL],
      ['BSS_SSO_CLIENT_ID', config.BSS_SSO_CLIENT_ID],
      ['BSS_SSO_CLIENT_SECRET', config.BSS_SSO_CLIENT_SECRET],
    ] as const;
    const configured =
      required.some(([, value]) => Boolean(value)) || Boolean(config.BSS_SSO_CLIENT_SECRET_NEXT);
    if (configured) {
      for (const [name, value] of required) {
        if (!value) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: 'BSS SSO settings must be configured together',
          });
        }
      }
    }
    if (
      config.BSS_SSO_CLIENT_SECRET_NEXT &&
      config.BSS_SSO_CLIENT_SECRET_NEXT === config.BSS_SSO_CLIENT_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BSS_SSO_CLIENT_SECRET_NEXT'],
        message: 'BSS SSO current and next secrets must differ',
      });
    }
    if (config.NODE_ENV !== 'production' || !config.BSS_SITE_URL) return;
    if (config.BSS_SSO_CLIENT_ID && config.BSS_SSO_CLIENT_ID.trim() !== config.BSS_SSO_CLIENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BSS_SSO_CLIENT_ID'],
        message: 'BSS_SSO_CLIENT_ID must not contain surrounding whitespace',
      });
    }
    try {
      const url = new URL(config.BSS_SITE_URL);
      if (
        url.protocol !== 'https:' ||
        (url.pathname !== '' && url.pathname !== '/') ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      ) {
        throw new Error('unsafe origin');
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BSS_SITE_URL'],
        message: 'BSS_SITE_URL must be an HTTPS origin in production',
      });
    }
    try {
      const url = new URL(config.PANEL_PUBLIC_URL);
      if (
        url.protocol !== 'https:' ||
        (url.pathname !== '' && url.pathname !== '/') ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      ) {
        throw new Error('unsafe origin');
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PANEL_PUBLIC_URL'],
        message: 'PANEL_PUBLIC_URL must be an HTTPS origin when BSS SSO is enabled',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
