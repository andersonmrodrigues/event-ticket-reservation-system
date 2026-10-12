import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  confirmReservation,
  createHold,
} from '../../../src/modules/reservations/application/reservation-service.js';
import { expireReservations } from '../../../src/modules/reservations/application/expire-reservations.js';
import { createEvent, startIntegrationDependencies } from '../helpers.js';

describe('confirmation and expiry transitions', () => {
  const environment = {
    current: undefined as Awaited<ReturnType<typeof startIntegrationDependencies>> | undefined,
  };
  beforeAll(async () => {
    environment.current = await startIntegrationDependencies();
  });
  afterAll(async () => {
    await environment.current?.stop();
  });

  it('allows only one terminal outcome when confirmation races an overdue expiry', async () => {
    const { db, config } = environment.current!;
    const { eventId, seatIds } = await createEvent(db);
    const hold = await createHold(db, config, {
      eventId,
      seatIds: [seatIds[0]!],
      idempotencyKey: 'race',
      admissionTokenValidator: async () => true,
    });
    await db.query(
      `UPDATE reservations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [hold.reservationId],
    );

    const outcomes = await Promise.allSettled([
      confirmReservation(db, config, hold.reservationId, hold.capability),
      expireReservations(db, 10),
    ]);
    const row = await db.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1',
      [hold.reservationId],
    );
    const seat = await db.query<{ state: string; current_reservation_id: string | null }>(
      'SELECT state, current_reservation_id FROM event_seats WHERE id = $1',
      [seatIds[0]],
    );
    expect(row.rows[0]?.status).toBe('EXPIRED');
    expect(seat.rows[0]).toMatchObject({ state: 'AVAILABLE', current_reservation_id: null });
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  });

  it('confirms an unexpired hold with its capability and refuses an incorrect one', async () => {
    const { db, config } = environment.current!;
    const { eventId, seatIds } = await createEvent(db);
    const hold = await createHold(db, config, {
      eventId,
      seatIds: [seatIds[0]!],
      idempotencyKey: 'confirm',
      admissionTokenValidator: async () => true,
    });
    await expect(
      confirmReservation(db, config, hold.reservationId, 'wrong-token'),
    ).rejects.toMatchObject({ code: 'INVALID_CAPABILITY' });
    expect(await confirmReservation(db, config, hold.reservationId, hold.capability)).toMatchObject(
      { status: 'CONFIRMED' },
    );
  });
});
