import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../../../app/build-app.js';
import { AppError } from '../../../shared/http/errors.js';
import { isUuid } from '../../events/http/routes.js';
import {
  confirmReservation,
  createHold,
  getReservation,
} from '../application/reservation-service.js';
import { validateAdmissionToken } from '../../waiting-room/application/waiting-room.js';
import { Type } from '@sinclair/typebox';
import { reservationOutcomes } from '../../../shared/observability/metrics.js';

const createHoldBody = Type.Object(
  {
    seatIds: Type.Array(Type.String({ format: 'uuid' }), {
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export async function registerReservationRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
): Promise<void> {
  const { db, redis, config } = dependencies;
  app.post<{ Params: { eventId: string }; Body: { seatIds: string[] } }>(
    '/v1/events/:eventId/reservations',
    {
      schema: {
        summary: 'Create an all-or-nothing temporary seat hold',
        description:
          'Requires an Idempotency-Key. Queue-enabled events also require an X-Admission-Token.',
        tags: ['reservations'],
        body: {
          ...createHoldBody,
        },
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 },
            'x-admission-token': { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      if (!isUuid(eventId)) throw new AppError('INVALID_EVENT_ID', 'Event ID must be a UUID.', 400);
      if (
        !Array.isArray(request.body?.seatIds) ||
        !request.body.seatIds.every((id) => typeof id === 'string' && isUuid(id))
      ) {
        throw new AppError('INVALID_SEAT_SELECTION', 'seatIds must be an array of UUIDs.', 400);
      }
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required.', 400);
      const admissionToken = request.headers['x-admission-token'];
      let result;
      try {
        result = await createHold(db, config, {
          eventId,
          seatIds: request.body.seatIds,
          idempotencyKey,
          ...(typeof admissionToken === 'string' ? { admissionToken } : {}),
          admissionTokenValidator: async (id, token) =>
            validateAdmissionToken(redis, id, token, config),
        });
      } catch (error) {
        const outcome =
          error instanceof AppError
            ? error.statusCode === 409
              ? 'conflict'
              : error.statusCode === 403
                ? 'denied'
                : error.statusCode === 503
                  ? 'dependency_error'
                  : 'rejected'
            : 'error';
        reservationOutcomes.inc({ outcome });
        throw error;
      }
      reservationOutcomes.inc({ outcome: result.replayed ? 'replayed' : 'held' });
      const { replayed, ...payload } = result;
      return reply
        .header('Idempotent-Replay', String(replayed))
        .status(replayed ? 200 : 201)
        .send(payload);
    },
  );

  app.get<{ Params: { reservationId: string } }>(
    '/v1/reservations/:reservationId',
    {
      schema: {
        summary: 'Read a reservation',
        tags: ['reservations'],
        security: [{ reservationCapability: [] }],
      },
    },
    async (request) => {
      if (!isUuid(request.params.reservationId))
        throw new AppError('INVALID_RESERVATION_ID', 'Reservation ID must be a UUID.', 400);
      const authorization = request.headers.authorization;
      const capability = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      return getReservation(db, config, request.params.reservationId, capability);
    },
  );

  app.post<{ Params: { reservationId: string } }>(
    '/v1/reservations/:reservationId/confirm',
    {
      schema: {
        summary: 'Confirm an unexpired hold',
        tags: ['reservations'],
        security: [{ reservationCapability: [] }],
      },
    },
    async (request) => {
      if (!isUuid(request.params.reservationId))
        throw new AppError('INVALID_RESERVATION_ID', 'Reservation ID must be a UUID.', 400);
      const authorization = request.headers.authorization;
      const capability = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      return confirmReservation(db, config, request.params.reservationId, capability);
    },
  );
}
