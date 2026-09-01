const CANONICAL_SITE_URL = 'https://bss.games';

/** Возвращает только точный origin сайта, пригодный для серверной передачи в UI. */
export function getBssSiteUrl(
  configured = process.env.BSS_SITE_URL,
  environment = process.env.NODE_ENV,
): string {
  const value = configured?.trim() || CANONICAL_SITE_URL;
  try {
    const url = new URL(value);
    const protocolAllowed =
      url.protocol === 'https:' || (environment !== 'production' && url.protocol === 'http:');
    if (
      !protocolAllowed ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error('unsafe origin');
    }
    return url.origin;
  } catch {
    throw new Error('BSS_SITE_URL должен быть точным безопасным origin');
  }
}
