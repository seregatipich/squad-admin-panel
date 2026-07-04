import { describe, expect, it } from 'vitest';
import { LogIngestor } from '../src/parser/ingest.js';
import { type ParsedReport, parseReportLine } from '../src/parser/report.js';

const SERVER_ID = '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c5';
const REPORTER_EOS = 'abcdef0123456789abcdef0123456789';
const REPORTER_STEAM = '76561198012345678';

const SENDER = `76561198012345678 [Online IDs: EOS: ${REPORTER_EOS} steam: ${REPORTER_STEAM}] Reporter One`;

describe('parseReportLine', () => {
  it('extracts reporter identity, target and body from a modern chat line', () => {
    const raw = `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatAll : !report BadGuy is team killing at main`;
    const parsed = parseReportLine(raw) as ParsedReport;
    expect(parsed).not.toBeNull();
    expect(parsed.reporterEos).toBe(REPORTER_EOS);
    expect(parsed.reporterSteam).toBe(REPORTER_STEAM);
    expect(parsed.reporterName).toBe('Reporter One');
    expect(parsed.channel).toBe('ChatAll');
    expect(parsed.targetRaw).toBe('BadGuy');
    expect(parsed.body).toBe('is team killing at main');
    expect(parsed.ts).toBe('2026-04-23T11:30:20.485Z');
  });

  it('supports an EOS-only sender with no steam id in the Online IDs block', () => {
    const raw = `[2026.04.23-11.31.00:000][10]LogSquad: ChatMessage: [Online IDs: EOS: ${REPORTER_EOS}] SoloEos : ChatTeam : !report Cheater aimbot`;
    const parsed = parseReportLine(raw) as ParsedReport;
    expect(parsed.reporterEos).toBe(REPORTER_EOS);
    expect(parsed.reporterSteam).toBeNull();
    expect(parsed.reporterName).toBe('SoloEos');
    expect(parsed.channel).toBe('ChatTeam');
    expect(parsed.targetRaw).toBe('Cheater');
    expect(parsed.body).toBe('aimbot');
  });

  it('parses a legacy name-only chat line without online ids', () => {
    const raw =
      '[2026.04.23-11.32.00:000][10]LogChat: ChatMessage: PlainName : ChatSquad : !report Grief blocking vehicle';
    const parsed = parseReportLine(raw) as ParsedReport;
    expect(parsed.reporterEos).toBeNull();
    expect(parsed.reporterSteam).toBeNull();
    expect(parsed.reporterName).toBe('PlainName');
    expect(parsed.targetRaw).toBe('Grief');
    expect(parsed.body).toBe('blocking vehicle');
  });

  it('is case-insensitive on the command and preserves a single-token report', () => {
    const raw = `[2026.04.23-11.33.00:000][10]LogSquad: ChatMessage: ${SENDER} : ChatAll : !REPORT SuspiciousGuy`;
    const parsed = parseReportLine(raw) as ParsedReport;
    expect(parsed.targetRaw).toBe('SuspiciousGuy');
    expect(parsed.body).toBe('SuspiciousGuy');
  });

  it('returns null for chat that is not a report command', () => {
    const raw = `[2026.04.23-11.34.00:000][10]LogSquad: ChatMessage: ${SENDER} : ChatAll : hello everyone`;
    expect(parseReportLine(raw)).toBeNull();
  });

  it('returns null for an empty report command', () => {
    const raw = `[2026.04.23-11.35.00:000][10]LogSquad: ChatMessage: ${SENDER} : ChatAll : !report`;
    expect(parseReportLine(raw)).toBeNull();
  });

  it('returns null for a non-chat log line', () => {
    const raw =
      '[2026.04.23-11.30.37:617][742]LogNet: Created socket for bind address: 0.0.0.0:15000';
    expect(parseReportLine(raw)).toBeNull();
  });
});

describe('LogIngestor onReport wiring', () => {
  it('routes a report line to the onReport callback and emits no envelope', () => {
    const captured: ParsedReport[] = [];
    const ing = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      onReport: (report) => captured.push(report),
    });
    const raw = `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatAll : !report BadGuy is team killing`;
    const envelopes = ing.ingest(raw);
    expect(envelopes).toHaveLength(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.targetRaw).toBe('BadGuy');
  });

  it('does not treat a normal chat line as a report', () => {
    const captured: ParsedReport[] = [];
    const ing = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      onReport: (report) => captured.push(report),
    });
    ing.ingest(`[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatAll : gg wp`);
    expect(captured).toHaveLength(0);
  });
});
