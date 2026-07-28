import { createPublicKey, type KeyObject, verify } from 'node:crypto';

/**
 * Discord signs every interaction webhook with the application's Ed25519 key and
 * disables an endpoint that fails to verify it, so verification has to happen
 * against the raw body — re-serialising the parsed JSON changes the bytes and
 * breaks the signature.
 *
 * Discord publishes the key as 32 raw hex bytes while `node:crypto` speaks
 * SPKI DER, so the two helpers here convert in both directions. No Discord
 * library is involved: this repo talks to Discord over `fetch` only.
 */

/** SPKI DER prefix for an Ed25519 public key; the remaining 32 bytes are the key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Render a `KeyObject` as the 32-byte raw hex form Discord publishes. */
export function rawEd25519PublicKeyHex(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('hex');
}

function publicKeyFromRawHex(publicKeyHex: string): KeyObject | null {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) return null;
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]);
  try {
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

export interface VerifyInteractionSignatureInput {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  rawBody: string;
}

/**
 * True only when `signatureHex` is a valid Ed25519 signature over
 * `timestamp + rawBody` for `publicKeyHex`. Any malformed input answers false
 * rather than throwing, so a hostile caller cannot turn a bad signature into a 500.
 */
export function verifyInteractionSignature(input: VerifyInteractionSignatureInput): boolean {
  const key = publicKeyFromRawHex(input.publicKeyHex);
  if (!key) return false;
  if (!/^[0-9a-fA-F]+$/.test(input.signatureHex) || input.signatureHex.length % 2 !== 0) {
    return false;
  }
  try {
    return verify(
      null,
      Buffer.from(input.timestamp + input.rawBody, 'utf8'),
      key,
      Buffer.from(input.signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

export interface StatusSnapshot {
  state: string;
  current_map?: string | null;
  player_count?: number | null;
  public_queue?: number | null;
}

export interface StatusLine {
  displayName: string;
  status: StatusSnapshot | null;
}

/** Message body for the `/status` command: one line per server, Russian copy. */
export function buildStatusContent(servers: readonly StatusLine[]): string {
  if (servers.length === 0) return 'Серверов нет.';
  return servers
    .map((s) => {
      if (!s.status || s.status.state !== 'connected') {
        return `**${s.displayName}** — офлайн`;
      }
      const map = s.status.current_map ?? 'неизвестно';
      const players = s.status.player_count ?? 0;
      const queue = s.status.public_queue ?? 0;
      return `**${s.displayName}** — ${map} · игроков: ${players} · очередь: ${queue}`;
    })
    .join('\n');
}

export interface PlayerCardPlayer {
  id: string;
  canonical_name: string;
  steam_id64: string | null;
}

/** Message body for the `/player` command, linking back into the panel. */
export function buildPlayerCardContent(player: PlayerCardPlayer, panelPublicUrl: string): string {
  const base = panelPublicUrl.replace(/\/+$/, '');
  const steam = player.steam_id64 ?? 'нет SteamID';
  return `**${player.canonical_name}** · ${steam}\n${base}/players/${player.id}`;
}
