import { describe, expect, it } from 'vitest';
import { LogIngestor } from '../src/parser/ingest.js';
import { type ParsedReport, parseReportFromChat, parseReportLine } from '../src/parser/report.js';

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

  it('returns null for a chat line with an empty message body', () => {
    const raw = `[2026.04.23-11.34.00:000][10]LogSquad: ChatMessage: ${SENDER} : ChatAll : `;
    expect(parseReportLine(raw)).toBeNull();
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

describe('parseReportFromChat (RCON chat, #2)', () => {
  const chat = (message: string) => ({
    ts: '2026-10-02T12:00:00.000Z',
    channel: 'ChatTeam' as const,
    eosId: REPORTER_EOS,
    steamId64: REPORTER_STEAM,
    playerName: 'Reporter One',
    message,
  });

  it('reads the reporter, target and text from an RCON chat line', () => {
    expect(parseReportFromChat(chat('!report BadGuy is team killing at main'))).toEqual({
      ts: '2026-10-02T12:00:00.000Z',
      tick: 0,
      channel: 'ChatTeam',
      reporterEos: REPORTER_EOS,
      reporterSteam: REPORTER_STEAM,
      reporterName: 'Reporter One',
      targetRaw: 'BadGuy',
      body: 'is team killing at main',
    });
  });

  it('uses the target as the text when nothing follows it', () => {
    expect(parseReportFromChat(chat('!REPORT Cheater'))).toMatchObject({
      targetRaw: 'Cheater',
      body: 'Cheater',
    });
  });

  it('returns null for other chat and for a report with no target', () => {
    expect(parseReportFromChat(chat('hello team'))).toBeNull();
    expect(parseReportFromChat(chat('!report'))).toBeNull();
    expect(parseReportFromChat(chat('!reporting someone'))).toBeNull();
  });

  it('produces the same report as the log line for the same words', () => {
    const fromLog = parseReportLine(
      `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatAll : !report BadGuy hacking`,
    ) as ParsedReport;
    const fromChat = parseReportFromChat({
      ts: fromLog.ts,
      channel: 'ChatAll',
      eosId: REPORTER_EOS,
      steamId64: REPORTER_STEAM,
      playerName: 'Reporter One',
      message: '!report BadGuy hacking',
    }) as ParsedReport;
    expect({ ...fromChat, tick: fromLog.tick }).toEqual(fromLog);
  });
});
