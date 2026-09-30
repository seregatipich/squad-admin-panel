import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { panelGuard } from '../src/lib/panel-guard.js';

function fakeReply() {
  const reply = {
    statusCode: 200,
    code(statusCode: number) {
      reply.statusCode = statusCode;
      return reply;
    },
  };
  return reply;
}

function request(user: unknown): FastifyRequest {
  return { user } as unknown as FastifyRequest;
}

describe('panelGuard', () => {
  it('denies an anonymous request with 401', () => {
    const reply = fakeReply();
    expect(panelGuard(request(undefined), reply as unknown as FastifyReply)).toEqual({
      error: 'unauthenticated',
    });
    expect(reply.statusCode).toBe(401);
  });

  it('denies a session without panel access with 403', () => {
    const reply = fakeReply();
    const user = { permissions: { panelAccess: false } };
    expect(panelGuard(request(user), reply as unknown as FastifyReply)).toEqual({
      error: 'forbidden',
    });
    expect(reply.statusCode).toBe(403);
  });

  it('lets a panel user through', () => {
    const reply = fakeReply();
    const user = { permissions: { panelAccess: true } };
    expect(panelGuard(request(user), reply as unknown as FastifyReply)).toBeNull();
    expect(reply.statusCode).toBe(200);
  });
});
