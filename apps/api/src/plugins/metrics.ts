import fp from 'fastify-plugin';
import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export interface MetricsContext {
  registry: Registry;
  httpRequests: Counter<string>;
  httpDuration: Histogram<string>;
  consumerEvents: Counter<string>;
  bridgeCalls: Counter<string>;
}

export default fp(async (app) => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled by route/method/status',
    labelNames: ['route', 'method', 'status'],
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['route', 'method', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const consumerEvents = new Counter({
    name: 'events_consumer_total',
    help: 'Events consumed by worker group and outcome',
    labelNames: ['group', 'outcome'],
    registers: [registry],
  });
  const bridgeCalls = new Counter({
    name: 'bridge_calls_total',
    help: 'Calls to panel-host-bridge by method and outcome',
    labelNames: ['method', 'outcome'],
    registers: [registry],
  });

  const ctx: MetricsContext = { registry, httpRequests, httpDuration, consumerEvents, bridgeCalls };

  app.decorate('metrics', ctx);

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? req.url ?? 'unknown';
    const method = req.method;
    const status = String(reply.statusCode);
    httpRequests.inc({ route, method, status });
    httpDuration.observe({ route, method, status }, reply.elapsedTime / 1000);
  });

  app.get('/metrics', {
    config: { audit: false },
    schema: { hide: true },
    handler: async (_, reply) => {
      reply.header('Content-Type', registry.contentType);
      return registry.metrics();
    },
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    metrics: MetricsContext;
  }
}
