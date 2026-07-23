import { cookies } from 'next/headers';
import { LOCALE_COOKIE, type Locale, resolveLocale } from './config';
import { createTranslatorForLocale, type Translator } from './translate';

/**
 * Server-only i18n helpers. Read the `locale` cookie so Server Components and
 * the root layout can localize their first render before hydration.
 */

/** Resolves the viewer's {@link Locale} from the `locale` cookie. */
export async function getLocale(): Promise<Locale> {
  const jar = await cookies();
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value);
}

/** A {@link Translator} bound to the viewer's server-resolved locale. */
export async function getTranslator(): Promise<Translator> {
  return createTranslatorForLocale(await getLocale());
}
