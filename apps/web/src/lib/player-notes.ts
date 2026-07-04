import type { PlayerNote } from './live-bus';

export function prependNote(notes: PlayerNote[], incoming: PlayerNote): PlayerNote[] {
  if (notes.some((note) => note.id === incoming.id)) return notes;
  return [incoming, ...notes];
}

export function replaceNote(notes: PlayerNote[], updated: PlayerNote): PlayerNote[] {
  return notes.map((note) => (note.id === updated.id ? updated : note));
}

export function removeNote(notes: PlayerNote[], noteId: string): PlayerNote[] {
  return notes.filter((note) => note.id !== noteId);
}

export function formatRelativeNote(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 45) return 'только что';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} ч назад`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay} дн назад`;
  return new Date(iso).toLocaleDateString('ru-RU');
}
