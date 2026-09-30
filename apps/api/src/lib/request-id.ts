import { v7 as uuidv7 } from 'uuid';

/**
 * Maximum length accepted for a caller-supplied `X-Request-Id` header before
 * it is truncated and re-validated. Matches the shape request-context.ts
 * expects, so the two never disagree about what counts as a valid id.
 */
const MAX_HEADER_LENGTH = 128;

/** A caller-supplied request id must look like this to be trusted as-is. */
const REQUEST_ID_RE = /^[\w-]+$/;

/**
 * Resolves the request id Fastify should use for a given `X-Request-Id`
 * header value, for `genReqId` in server.ts.
 *
 * Caddy forwards the client's header as-is (see docker/Caddyfile), and the
 * id ends up in application logs, `context.requestId` in the append-only
 * `audit_log` hash chain, and outbox event payloads. An unvalidated pass-
 * through would let any caller — including through public routes — write an
 * arbitrary string up to ~16 KiB, or another request's id, into that
 * immutable log (findings #379, #1309). Only a header that already matches
 * the shape request-context.ts accepts is reused; anything else, including a
 * missing header, gets a fresh `uuidv7()`.
 */
export function resolveRequestId(headerValue: string | undefined): string {
  const truncated = headerValue?.slice(0, MAX_HEADER_LENGTH);
  return truncated && REQUEST_ID_RE.test(truncated) ? truncated : uuidv7();
}
