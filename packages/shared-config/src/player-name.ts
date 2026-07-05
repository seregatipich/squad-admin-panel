const LEADING_CLAN_TAG = /^\s*[[(<][^\])>]*[\])>]\s*/u;
const LEADING_NON_LETTERS = /^[^\p{L}[(<]+/u;

export function normalizePlayerName(rawName: string): string {
  let stripped = rawName;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(LEADING_CLAN_TAG, '').replace(LEADING_NON_LETTERS, '');
  } while (stripped !== previous && stripped.length > 0);

  const normalized = stripped.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length > 0) return normalized;
  return rawName.toLowerCase().replace(/\s+/g, ' ').trim();
}
