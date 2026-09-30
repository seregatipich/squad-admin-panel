import { describe, expect, it } from 'vitest';
import { isAllowedWebSocketOrigin } from '../src/plugins/websocket.js';

describe('isAllowedWebSocketOrigin', () => {
  const panel = 'https://panel.example';

  it('allows a request without Origin (non-browser API-token clients)', () => {
    expect(isAllowedWebSocketOrigin(undefined, panel)).toBe(true);
  });

  it('allows the panel origin, ignoring a trailing path on the public URL', () => {
    expect(isAllowedWebSocketOrigin('https://panel.example', `${panel}/`)).toBe(true);
  });

  it('rejects sibling hosts, other schemes, other ports and opaque origins', () => {
    expect(isAllowedWebSocketOrigin('https://evil.panel.example', panel)).toBe(false);
    expect(isAllowedWebSocketOrigin('http://panel.example', panel)).toBe(false);
    expect(isAllowedWebSocketOrigin('https://panel.example:8443', panel)).toBe(false);
    expect(isAllowedWebSocketOrigin('null', panel)).toBe(false);
  });
});
