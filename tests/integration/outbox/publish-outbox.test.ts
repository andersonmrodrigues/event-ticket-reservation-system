import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHold } from '../../../src/modules/reservations/application/reservation-service.js';
import { publishOutboxBatch } from '../../../src/modules/outbox/publish-outbox.js';
import { createEvent, startIntegrationDependencies } from '../helpers.js';

describe('transactional outbox publisher', () => {
  const environment = {
    current: undefined as Awaited<ReturnType<typeof startIntegrationDependencies>> | undefined,
  };
  beforeAll(async () => {
    environment.current = await startIntegrationDependencies(true);
  });
  afterAll(async () => {
    await environment.current?.stop();
  });

  it('publishes committed events to the Redis Stream and records acknowledgement', async () => {
    const { db, redis, config } = environment.current!;
    const { eventId, seatIds } = await createEvent(db);
    await createHold(db, config, {
      eventId,
      seatIds: [seatIds[0]!],
      idempotencyKey: 'outbox-event',
      admissionTokenValidator: async () => true,
    });
    expect(await publishOutboxBatch(db, redis!)).toBe(1);
    const pending = await db.query(
      `SELECT count(*)::int AS count FROM outbox_events WHERE published_at IS NULL`,
    );
    const stream = await redis!.xrange('reservation-events', '-', '+');
    expect(pending.rows[0]?.count).toBe(0);
    expect(stream).toHaveLength(1);
    expect(stream[0]?.[1]).toContain('reservation.held');
  });
});
