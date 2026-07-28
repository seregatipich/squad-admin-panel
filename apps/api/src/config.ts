import { z } from 'zod';

const envSchema = z.object({
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
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DISCORD_PUBLIC_KEY: z.string().optional(),
  GLITCHTIP_DSN: z.string().optional(),
  VIP_LIFECYCLE_WEBHOOK_SECRET: z.string().min(32).optional(),
  BALANCER_WEBHOOK_SECRET: z.string().min(32).optional(),
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
