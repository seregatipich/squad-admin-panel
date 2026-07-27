/** MIME types the panel accepts for evidence uploads, mirroring the API allowlist. */
export const ACCEPTED_UPLOAD_TYPES = [
  'video/mp4',
  'video/webm',
  'image/png',
  'image/jpeg',
] as const;

const BYTES_PER_MB = 1024 * 1024;

export interface UploadProgress {
  /** Whole percent, clamped to 0..100. */
  percent: number;
  loaded: string;
  total: string;
  speed: string;
}

/** Renders a byte count as megabytes with one decimal; negative input reads as zero. */
export function formatMegabytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return `${(safe / BYTES_PER_MB).toFixed(1)} МБ`;
}

/** Renders a transfer rate; an unmeasurable rate reads as an em dash rather than `0.0`. */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${(bytesPerSecond / BYTES_PER_MB).toFixed(1)} МБ/с`;
}

/** Turns one XHR progress tick into the numbers rendered next to the progress bar. */
export function computeProgress(loaded: number, total: number, elapsedMs: number): UploadProgress {
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((loaded / total) * 100))) : 0;
  return {
    percent,
    loaded: formatMegabytes(loaded),
    total: formatMegabytes(total),
    speed: formatSpeed(elapsedMs > 0 ? (loaded / elapsedMs) * 1000 : 0),
  };
}

export function isAcceptedUploadType(mimeType: string): boolean {
  return (ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(mimeType);
}

/** Maps a public-upload HTTP status onto the message shown to an anonymous uploader. */
export function uploadErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Файл не прошёл проверку — не удалось распознать его содержимое.';
    case 410:
      return 'Эта ссылка уже использована или истекла. Попросите новую ссылку у администратора.';
    case 413:
      return 'Файл слишком большой для этой ссылки.';
    case 415:
      return 'Такой формат файла не поддерживается.';
    case 429:
      return 'Слишком много загрузок с этого адреса. Попробуйте позже.';
    default:
      return `Не удалось загрузить файл (код ${status}).`;
  }
}
