import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/build-app.js';
import { createEvent, startIntegrationDependencies } from '../integration/helpers.js';

describe('booking API flow', () => {
  const environment = {
    current: undefined as Awaited<ReturnType<typeof startIntegrationDependencies>> | undefined,
  };
  beforeAll(async () => {
    environment.current = await startIntegrationDependencies(true);
  });
  afterAll(async () => {
    await environment.current?.stop();
  });

  it('queues, holds idempotently, confirms, and prevents another hold on the sold seat', async () => {
    const { db, redis, config } = environment.current!;
    const app = await buildApp({ db, redis: redis!, config, logger: false });
    const { eventId, seatIds } = await createEvent(db, { waitingRoom: true });
    try {
      const joined = await app.inject({
        method: 'POST',
        url: `/v1/events/${eventId}/waiting-room`,
      });
      expect(joined.statusCode).toBe(201);
      const entry = joined.json<{ entryId: string; capability: string }>();
      const { admitWaitingRoomBatch } =
        await import('../../src/modules/waiting-room/application/waiting-room.js');
      await admitWaitingRoomBatch(redis!, eventId, 1, 120, config);
      const polled = await app.inject({
        method: 'GET',
        url: `/v1/waiting-room/${entry.entryId}`,
        headers: { authorization: `Bearer ${entry.capability}` },
      });
      const admission = polled.json<{ admissionToken: string }>();
      const holdRequest = {
        method: 'POST' as const,
        url: `/v1/events/${eventId}/reservations`,
        headers: {
          'idempotency-key': 'e2e-booking-001',
          'x-admission-token': admission.admissionToken,
        },
        payload: { seatIds: [seatIds[0]] },
      };
      const held = await app.inject(holdRequest);
      expect(held.statusCode).toBe(201);
      const reservation = held.json<{ reservationId: string; capability: string }>();
      const replayed = await app.inject(holdRequest);
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json()).toMatchObject({
        reservationId: reservation.reservationId,
        capability: reservation.capability,
      });
      const confirmed = await app.inject({
        method: 'POST',
        url: `/v1/reservations/${reservation.reservationId}/confirm`,
        headers: { authorization: `Bearer ${reservation.capability}` },
      });
      expect(confirmed.statusCode).toBe(200);
      const conflict = await app.inject({
        method: 'POST',
        url: `/v1/events/${eventId}/reservations`,
        headers: {
          'idempotency-key': 'e2e-booking-002',
          'x-admission-token': admission.admissionToken,
        },
        payload: { seatIds: [seatIds[0]] },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe('SEAT_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });
});
