import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../../../app/build-app.js';
import { AppError } from '../../../shared/http/errors.js';
import { getWaitingRoomEntry, joinWaitingRoom } from '../application/waiting-room.js';
import { isUuid } from '../../events/http/routes.js';

export async function registerWaitingRoomRoutes(
  app: FastifyInstance,
  { db, redis }: AppDependencies,
): Promise<void> {
  app.post<{ Params: { eventId: string } }>(
    '/v1/events/:eventId/waiting-room',
    async (request, reply) => {
      const { eventId } = request.params;
      if (!isUuid(eventId)) throw new AppError('INVALID_EVENT_ID', 'Event ID must be a UUID.', 400);
      const event = await db.query('SELECT waiting_room_enabled FROM events WHERE id = $1', [
        eventId,
      ]);
      if (event.rowCount === 0) throw new AppError('EVENT_NOT_FOUND', 'Event not found.', 404);
      if (!event.rows[0]?.waiting_room_enabled)
        throw new AppError(
          'WAITING_ROOM_DISABLED',
          'Waiting room is not enabled for this event.',
          409,
        );
      return reply.status(201).send(await joinWaitingRoom(redis, eventId));
    },
  );
  app.get<{ Params: { entryId: string } }>('/v1/waiting-room/:entryId', async (request) => {
    if (!isUuid(request.params.entryId))
      throw new AppError('INVALID_ENTRY_ID', 'Entry ID must be a UUID.', 400);
    const header = request.headers.authorization;
    const capability = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    return getWaitingRoomEntry(redis, request.params.entryId, capability);
  });
}
