import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHold } from '../../../src/modules/reservations/application/reservation-service.js';
import { createEvent, startIntegrationDependencies } from '../helpers.js';

describe('atomic seat holds', () => {
  const environment = {
    current: undefined as Awaited<ReturnType<typeof startIntegrationDependencies>> | undefined,
  };
  beforeAll(async () => {
    environment.current = await startIntegrationDependencies();
  });
  afterAll(async () => {
    await environment.current?.stop();
  });

  it('replays the same request and rejects reuse of a key with a different body', async () => {
    const { db, config } = environment.current!;
    const { eventId, seatIds } = await createEvent(db);
    const input = {
      eventId,
      seatIds: [seatIds[0]!],
      idempotencyKey: 'same-request',
      admissionTokenValidator: async () => true,
    };
    const first = await createHold(db, config, input);
    const replay = await createHold(db, config, input);
    expect(replay).toMatchObject({
      reservationId: first.reservationId,
      expiresAt: first.expiresAt,
      capability: first.capability,
      replayed: true,
    });
    await expect(
      createHold(db, config, { ...input, seatIds: [seatIds[1]!] }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
  });

  it('allows exactly one independent hold when 25 requests contend for one seat', async () => {
    const { db, config } = environment.current!;
    const { eventId, seatIds } = await createEvent(db);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, index) =>
        createHold(db, config, {
          eventId,
          seatIds: [seatIds[0]!],
          idempotencyKey: `attempt-${index}`,
          admissionTokenValidator: async () => true,
        }),
      ),
    );
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const conflicts = results.filter(
      (result) => result.status === 'rejected' && result.reason?.code === 'SEAT_UNAVAILABLE',
    );
    expect(succeeded).toHaveLength(1);
    expect(conflicts).toHaveLength(24);
    const count = await db.query(
      `SELECT count(*)::int AS count FROM reservation_items WHERE event_id = $1 AND seat_id = $2 AND state IN ('HELD', 'SOLD')`,
      [eventId, seatIds[0]],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('releases an expired hold in the new reservation path', async () => {
    const { db, config } = environment.current!;
    const { eventId, seatIds } = await createEvent(db, { holdTtl: 30 });
    const original = await createHold(db, config, {
      eventId,
      seatIds: [seatIds[0]!],
      idempotencyKey: 'expired-old',
      admissionTokenValidator: async () => true,
    });
    await db.query(
      `UPDATE reservations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [original.reservationId],
    );
    const next = await createHold(db, config, {
      eventId,
      seatIds: [seatIds[0]!],
      idempotencyKey: 'expired-new',
      admissionTokenValidator: async () => true,
    });
    expect(next.reservationId).not.toBe(original.reservationId);
    const status = await db.query('SELECT status FROM reservations WHERE id = $1', [
      original.reservationId,
    ]);
    expect(status.rows[0]?.status).toBe('EXPIRED');
  });
});
