import { describe, expect, it } from 'vitest';
import { buildReportPayload, mapUploadError, validateEvidenceUrl } from './report-player';

describe('buildReportPayload', () => {
  it('trims the body and passes through server/target ids', () => {
    const payload = buildReportPayload('server-1', 'target-1', '  Teamkilling on purpose  ', []);
    expect(payload).toEqual({
      server_id: 'server-1',
      target_player_id: 'target-1',
      body: 'Teamkilling on purpose',
      evidence_media_ids: [],
    });
  });

  it('includes only the attached evidence ids, de-duplicated', () => {
    const payload = buildReportPayload('server-1', 'target-1', 'body', ['m1', 'm2', 'm1']);
    expect(payload.evidence_media_ids).toEqual(['m1', 'm2']);
  });
});

describe('validateEvidenceUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(validateEvidenceUrl('https://youtu.be/abc123')).toEqual({ ok: true });
    expect(validateEvidenceUrl('http://example.com/clip.mp4')).toEqual({ ok: true });
  });

  it('rejects an empty value', () => {
    const result = validateEvidenceUrl('   ');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-URL string', () => {
    const result = validateEvidenceUrl('not a url');
    expect(result.ok).toBe(false);
  });

  it('rejects non-http(s) protocols', () => {
    const result = validateEvidenceUrl('ftp://example.com/file');
    expect(result.ok).toBe(false);
  });
});

describe('mapUploadError', () => {
  it('maps 413 to a file-too-large message', () => {
    expect(mapUploadError(413)).toBe('Файл слишком большой');
  });

  it('maps 415 to an unsupported-format message', () => {
    expect(mapUploadError(415)).toBe('Неподдерживаемый формат');
  });

  it('maps a 400 magic_byte_mismatch to a content-mismatch message', () => {
    expect(mapUploadError(400, 'magic_byte_mismatch')).toBe(
      'Содержимое файла не соответствует формату',
    );
  });

  it('maps 401/403 to auth messages', () => {
    expect(mapUploadError(401)).toContain('Сессия');
    expect(mapUploadError(403)).toContain('доступа');
  });

  it('falls back to a generic message with the status code', () => {
    expect(mapUploadError(500)).toBe('Ошибка загрузки (HTTP 500)');
  });
});
