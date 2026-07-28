import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPlayerCardContent,
  buildStatusContent,
  rawEd25519PublicKeyHex,
  verifyInteractionSignature,
} from '../src/lib/discord-interactions.js';

/**
 * Discord signs every interaction with the application's Ed25519 key and
 * rejects an endpoint that does not verify it, so this suite exercises the
 * verification against real keys produced by `node:crypto` — no Discord
 * library and no network.
 */
function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyHex: rawEd25519PublicKeyHex(publicKey), privateKey };
}

function signBody(privateKey: ReturnType<typeof makeKeypair>['privateKey'], msg: string): string {
  return sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}

describe('verifyInteractionSignature', () => {
  it('accepts a signature produced over timestamp + body by the matching key', () => {
    const { publicKeyHex, privateKey } = makeKeypair();
    const timestamp = '1700000000';
    const rawBody = JSON.stringify({ type: 1 });

    const ok = verifyInteractionSignature({
      publicKeyHex,
      signatureHex: signBody(privateKey, timestamp + rawBody),
      timestamp,
      rawBody,
    });

    expect(ok).toBe(true);
  });

  it('rejects a body that was tampered with after signing', () => {
    const { publicKeyHex, privateKey } = makeKeypair();
    const timestamp = '1700000000';
    const signatureHex = signBody(privateKey, timestamp + JSON.stringify({ type: 1 }));

    const ok = verifyInteractionSignature({
      publicKeyHex,
      signatureHex,
      timestamp,
      rawBody: JSON.stringify({ type: 2 }),
    });

    expect(ok).toBe(false);
  });

  it('rejects a replay under a different timestamp', () => {
    const { publicKeyHex, privateKey } = makeKeypair();
    const rawBody = JSON.stringify({ type: 1 });
    const signatureHex = signBody(privateKey, `1700000000${rawBody}`);

    const ok = verifyInteractionSignature({
      publicKeyHex,
      signatureHex,
      timestamp: '1700000999',
      rawBody,
    });

    expect(ok).toBe(false);
  });

  it('rejects a signature made by a different application key', () => {
    const { publicKeyHex } = makeKeypair();
    const other = makeKeypair();
    const timestamp = '1700000000';
    const rawBody = JSON.stringify({ type: 1 });

    const ok = verifyInteractionSignature({
      publicKeyHex,
      signatureHex: signBody(other.privateKey, timestamp + rawBody),
      timestamp,
      rawBody,
    });

    expect(ok).toBe(false);
  });

  it('returns false rather than throwing on malformed hex input', () => {
    const { publicKeyHex } = makeKeypair();
    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex: 'not-hex',
        timestamp: '1700000000',
        rawBody: '{}',
      }),
    ).toBe(false);
    expect(
      verifyInteractionSignature({
        publicKeyHex: 'zz',
        signatureHex: '00'.repeat(64),
        timestamp: '1700000000',
        rawBody: '{}',
      }),
    ).toBe(false);
  });
});

describe('buildStatusContent', () => {
  it('reports map, players and queue from a connected status snapshot', () => {
    const text = buildStatusContent([
      {
        displayName: 'Main #1',
        status: {
          state: 'connected',
          current_map: 'Gorodok_RAAS_v1',
          player_count: 78,
          public_queue: 4,
        },
      },
    ]);
    expect(text).toContain('Main #1');
    expect(text).toContain('Gorodok_RAAS_v1');
    expect(text).toContain('78');
    expect(text).toContain('4');
  });

  it('says the server is offline when no status is cached', () => {
    const text = buildStatusContent([{ displayName: 'Main #1', status: null }]);
    expect(text).toContain('Main #1');
    expect(text).toContain('офлайн');
  });
});

describe('buildPlayerCardContent', () => {
  it('includes the panel link built from the public URL and the player uuid', () => {
    const text = buildPlayerCardContent(
      {
        id: '11111111-1111-1111-1111-111111111111',
        canonical_name: 'SomePlayer',
        steam_id64: '76561197999992001',
      },
      'https://panel.test',
    );
    expect(text).toContain('SomePlayer');
    expect(text).toContain('76561197999992001');
    expect(text).toContain('https://panel.test/players/11111111-1111-1111-1111-111111111111');
  });
});
