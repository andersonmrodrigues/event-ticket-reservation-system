import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../../../app/build-app.js';

export async function registerEventRoutes(
  app: FastifyInstance,
  { db }: AppDependencies,
): Promise<void> {
  app.get('/v1/events', async () => {
    const result = await db.query(
      `SELECT id, name, venue, starts_at, sales_open, waiting_room_enabled
       FROM events WHERE starts_at > now() ORDER BY starts_at LIMIT 100`,
    );
    return { data: result.rows };
  });
  app.get<{ Params: { eventId: string } }>('/v1/events/:eventId/seats', async (request, reply) => {
    if (!isUuid(request.params.eventId))
      return reply.status(400).send({ error: { code: 'INVALID_EVENT_ID' }, requestId: request.id });
    const result = await db.query(
      `SELECT id, section, row_label AS "row", seat_label AS "seat", state
       FROM event_seats WHERE event_id = $1 ORDER BY section, row_label, seat_label`,
      [request.params.eventId],
    );
    const exists = await db.query('SELECT 1 FROM events WHERE id = $1', [request.params.eventId]);
    if (exists.rowCount === 0)
      return reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND' }, requestId: request.id });
    return { data: result.rows };
  });
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
