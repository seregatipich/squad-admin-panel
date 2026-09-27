import fp from 'fastify-plugin';
import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/**
 * `route` label recorded for a request that matched no registered route
 * (Fastify's 404 context has no `routeOptions.url`). Every such request shares
 * this one label so arbitrary client-chosen URLs can never mint new series.
 */
export const UNMATCHED_ROUTE_LABEL = '__unmatched__';

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

  // The `route` label must only ever come from the finite set of registered
  // route templates. prom-client never evicts a label combination, so labelling
  // by the raw `req.url` (as this hook once did for unmatched requests) let any
  // anonymous client grow the registry — and the API's memory — without bound
  // and leaked query strings into the scrape output (#9).
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? UNMATCHED_ROUTE_LABEL;
    const method = req.method;
    const status = String(reply.statusCode);
    httpRequests.inc({ route, method, status });
    httpDuration.observe({ route, method, status }, reply.elapsedTime / 1000);
  });

  // Operator-only: the registry exposes the route map, traffic volume and
  // process internals, so it is gated like the other host metrics and is not
  // routed by Caddy (#9). Nothing in the stack scrapes it.
  app.get('/metrics', {
    config: { permissions: ['host:metrics'], audit: false },
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
