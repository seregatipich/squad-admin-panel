import type { BridgeErrorCode } from './types.js';

/**
 * Error raised for every failed bridge call: an application error returned by
 * the bridge (`forbidden`, `invalid_args`, …), a malformed response
 * (`internal`), a call timeout (`timeout`) or a socket failure (`transport`).
 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly detail?: unknown;

  /**
   * @param code - Machine-readable failure class.
   * @param message - Human-readable description, usually the bridge's own message.
   * @param detail - Optional structured context returned by the bridge.
   */
  constructor(code: BridgeErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.detail = detail;
  }
}
