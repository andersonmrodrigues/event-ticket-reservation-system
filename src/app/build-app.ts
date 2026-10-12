import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config/env.js';
import { registerEventRoutes } from '../modules/events/http/routes.js';
import { registerReservationRoutes } from '../modules/reservations/http/routes.js';
import { registerWaitingRoomRoutes } from '../modules/waiting-room/http/routes.js';
import { AppError } from '../shared/http/errors.js';
import { metricsRegistry, outboxPending } from '../shared/observability/metrics.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly db: pg.Pool;
  readonly redis: Redis;
  readonly logger?: boolean;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      dependencies.logger === false
        ? false
        : {
            level: dependencies.config.logLevel,
            redact: [
              'req.headers.authorization',
              'req.headers.idempotency-key',
              'req.headers.x-admission-token',
            ],
          },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 16_384,
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Event Ticket Reservation API',
        version: '1.0.0',
        description: 'Assigned-seat holds, FIFO admission, idempotent retries, and confirmation.',
      },
      components: {
        securitySchemes: {
          reservationCapability: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'opaque capability',
          },
          waitingRoomCapability: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'opaque capability',
          },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message }, requestId: request.id });
    }
    if (error instanceof Error && 'validation' in error && error.validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' },
        requestId: request.id,
      });
    }
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      (error.code.startsWith('08') ||
        ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '53300', '57P01'].includes(error.code))
    ) {
      return reply.status(503).send({
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'A required dependency is temporarily unavailable.',
        },
        requestId: request.id,
      });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      requestId: request.id,
    });
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await dependencies.db.query('SELECT 1');
      return { status: 'ok', dependencies: { postgres: 'ok', redis: dependencies.redis.status } };
    } catch {
      return reply.status(503).send({
        status: 'unavailable',
        dependencies: { postgres: 'error', redis: dependencies.redis.status },
      });
    }
  });
  app.get('/metrics', async (_request, reply) => {
    try {
      const pending = await dependencies.db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM outbox_events WHERE published_at IS NULL',
      );
      outboxPending.set(Number(pending.rows[0]?.count ?? 0));
    } catch {
      // Keep the last observed gauge value when PostgreSQL is unavailable.
    }
    reply.type(metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
  await registerEventRoutes(app, dependencies);
  await registerReservationRoutes(app, dependencies);
  await registerWaitingRoomRoutes(app, dependencies);
  return app;
}
