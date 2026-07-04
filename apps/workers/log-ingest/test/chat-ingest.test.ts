import { describe, expect, it, vi } from 'vitest';
import type { ParsedChat } from '../src/parser/chat.js';
import { LogIngestor } from '../src/parser/ingest.js';
import type { ParsedReport } from '../src/parser/report.js';

const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';
const EOS = '0002a10186d9414496bf20d22d3860ba';
const STEAM = '76561198012345678';
const SENDER = `${STEAM} [Online IDs: EOS: ${EOS} steam: ${STEAM}] Alpha Player`;

function makeIngestor(onChat: (c: ParsedChat) => void, onReport?: (r: ParsedReport) => void) {
  return new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000, onChat, onReport });
}

describe('LogIngestor onChat', () => {
  it('fires onChat with a structured message for a chat line', () => {
    const onChat = vi.fn();
    const ing = makeIngestor(onChat);
    ing.ingest(`[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatAll : gg wp`);
    expect(onChat).toHaveBeenCalledTimes(1);
    const chat = onChat.mock.calls[0][0] as ParsedChat;
    expect(chat.channel).toBe('ChatAll');
    expect(chat.message).toBe('gg wp');
    expect(chat.playerName).toBe('Alpha Player');
    expect(chat.steamId64).toBe(STEAM);
  });

  it('does not fire onChat for a non-chat log line', () => {
    const onChat = vi.fn();
    const ing = makeIngestor(onChat);
    ing.ingest('[2026.04.23-11.30.20:485][123]LogNet: Join succeeded: SomePlayer');
    expect(onChat).not.toHaveBeenCalled();
  });

  it('fires both onChat and onReport for an in-game !report chat line', () => {
    const onChat = vi.fn();
    const onReport = vi.fn();
    const ing = makeIngestor(onChat, onReport);
    ing.ingest(
      `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatAll : !report BadGuy team killing`,
    );
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledTimes(1);
    expect((onChat.mock.calls[0][0] as ParsedChat).message).toBe('!report BadGuy team killing');
  });

  it('does not emit event envelopes for chat lines', () => {
    const onChat = vi.fn();
    const ing = makeIngestor(onChat);
    const events = ing.ingest(
      `[2026.04.23-11.30.20:485][123]LogSquad: ChatMessage: ${SENDER} : ChatTeam : need ammo`,
    );
    expect(events).toEqual([]);
  });
});
