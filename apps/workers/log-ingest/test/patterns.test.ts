import { describe, expect, it } from 'vitest';
import { LogIngestor } from '../src/parser/ingest.js';
import { isBenignNoise, parseLine } from '../src/parser/patterns.js';

const SERVER_ID = '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c5';

describe('log line prefix parser', () => {
  it('parses a Display-verbosity LogGameMode line', () => {
    const raw =
      '[2026.04.23-11.30.20:485][  0]LogGameMode: Display: Match State Changed from EnteringMap to WaitingToStart';
    const parsed = parseLine(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.category).toBe('LogGameMode');
    expect(parsed?.verbosity).toBe('Display');
    expect(parsed?.message).toBe('Match State Changed from EnteringMap to WaitingToStart');
  });

  it('parses a no-verbosity LogGameState line', () => {
    const raw = '[2026.04.23-11.30.20:497][  0]LogGameState: Match State Changed from X to Y';
    const parsed = parseLine(raw);
    expect(parsed?.verbosity).toBeNull();
    expect(parsed?.message).toBe('Match State Changed from X to Y');
  });

  it('filters the audio-export noise', () => {
    expect(
      isBenignNoise('LogStreaming: Error: CreateExport: /Game/Vehicles/Foo EngineFailedStartAudio'),
    ).toBe(true);
    expect(isBenignNoise('LogSquad: Error: Failed to spawn EquipableItem')).toBe(true);
    expect(isBenignNoise('LogGameMode: Display: Match State Changed')).toBe(false);
  });
});

describe('LogIngestor event extraction', () => {
  it('emits server.ready only on the configured beacon port', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const wrong = ing.ingest(
      '[2026.04.23-11.30.37:617][742]LogNet: Created socket for bind address: 0.0.0.0:15001',
    );
    expect(wrong).toHaveLength(0);
    const right = ing.ingest(
      '[2026.04.23-11.30.37:617][742]LogNet: Created socket for bind address: 0.0.0.0:15000',
    );
    expect(right).toHaveLength(1);
    expect(right[0]?.type).toBe('server.ready');
  });

  it('emits match.started only on WaitingToStart -> InProgress', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const noop = ing.ingest(
      '[2026.04.23-11.30.20:485][  0]LogGameMode: Display: Match State Changed from EnteringMap to WaitingToStart',
    );
    expect(noop).toHaveLength(0);
    const started = ing.ingest(
      '[2026.04.23-11.30.20:485][  0]LogGameMode: Display: Match State Changed from WaitingToStart to InProgress',
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.type).toBe('match.started');
  });

  it('emits match.ended only on InProgress -> WaitingPostMatch', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const ended = ing.ingest(
      '[2026.04.23-11.30.20:485][  0]LogGameMode: Display: Match State Changed from InProgress to WaitingPostMatch',
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]?.type).toBe('match.ended');
  });

  it('emits server.stopped on exit code 143 (clean SIGTERM)', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const ev = ing.ingest(
      '[2026.04.23-11.36.27:300][366]LogCore: FUnixPlatformMisc::RequestExit(bForce=false, ReturnCode=143)',
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]?.type).toBe('server.stopped');
  });

  it('emits server.crashed on non-143 non-zero exit', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    const ev = ing.ingest(
      '[2026.04.23-11.36.27:300][366]LogCore: FUnixPlatformMisc::RequestExit(bForce=true, ReturnCode=134)',
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]?.type).toBe('server.crashed');
  });

  it('drops benign audio-export noise before parsing', () => {
    const ing = new LogIngestor({ serverId: SERVER_ID, beaconPort: 15000 });
    expect(
      ing.ingest(
        '[2026.04.23-11.24.41:079][141]LogStreaming: Error: CreateExport: /Game/Vehicles/RHIB/BP_RHIB_Logistics - Could not find template object for EngineFailedStartAudio',
      ),
    ).toHaveLength(0);
  });
});
