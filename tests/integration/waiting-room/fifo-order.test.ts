import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admitWaitingRoomBatch,
  getWaitingRoomEntry,
  joinWaitingRoom,
  validateAdmissionToken,
} from '../../../src/modules/waiting-room/application/waiting-room.js';
import {
  confirmReservation,
  createHold,
} from '../../../src/modules/reservations/application/reservation-service.js';
import { createEvent, startIntegrationDependencies } from '../helpers.js';

describe('Redis FIFO waiting room', () => {
  const environment = {
    current: undefined as Awaited<ReturnType<typeof startIntegrationDependencies>> | undefined,
  };
  beforeAll(async () => {
    environment.current = await startIntegrationDependencies(true);
  });
  afterAll(async () => {
    await environment.current?.stop();
  });

  it('admits entries in FIFO order and issues event-scoped short-lived tokens', async () => {
    const { db, redis, config } = environment.current!;
    const { eventId } = await createEvent(db, { waitingRoom: true });
    const first = await joinWaitingRoom(redis!, eventId);
    const second = await joinWaitingRoom(redis!, eventId);
    const third = await joinWaitingRoom(redis!, eventId);
    expect(first.position).toBe(1);
    expect(second.position).toBe(2);
    expect(third.position).toBe(3);

    expect(await admitWaitingRoomBatch(redis!, eventId, 2, 120, config)).toBe(2);
    const firstStatus = await getWaitingRoomEntry(redis!, first.entryId, first.capability);
    const secondStatus = await getWaitingRoomEntry(redis!, second.entryId, second.capability);
    const thirdStatus = await getWaitingRoomEntry(redis!, third.entryId, third.capability);
    expect(firstStatus.status).toBe('ADMITTED');
    expect(secondStatus.status).toBe('ADMITTED');
    expect(thirdStatus).toMatchObject({ status: 'WAITING', position: 1 });
    if (firstStatus.status !== 'ADMITTED') throw new Error('First entry should be admitted');
    expect(await validateAdmissionToken(redis!, eventId, firstStatus.admissionToken, config)).toBe(
      true,
    );
    expect(
      await validateAdmissionToken(
        redis!,
        '99999999-9999-4999-8999-999999999999',
        firstStatus.admissionToken,
        config,
      ),
    ).toBe(false);
    await expect(
      getWaitingRoomEntry(redis!, first.entryId, 'wrong-capability'),
    ).rejects.toMatchObject({ code: 'INVALID_WAITING_ROOM_CAPABILITY' });
  });

  it('discards expired queue members without wasting an admission slot', async () => {
    const { db, redis, config } = environment.current!;
    const { eventId } = await createEvent(db, { waitingRoom: true });
    const expired = await joinWaitingRoom(redis!, eventId);
    const active = await joinWaitingRoom(redis!, eventId);
    await redis!.del(`waiting-room:entry:${expired.entryId}`);

    expect(await admitWaitingRoomBatch(redis!, eventId, 1, 120, config)).toBe(1);
    expect(await getWaitingRoomEntry(redis!, active.entryId, active.capability)).toMatchObject({
      status: 'ADMITTED',
    });
    expect(await redis!.zscore(`waiting-room:${eventId}:queue`, expired.entryId)).toBeNull();
  });

  it('fails closed for new queued holds during Redis outage but confirms an existing hold', async () => {
    const { db, redis, config } = environment.current!;
    const { eventId, seatIds } = await createEvent(db, { waitingRoom: true });
    const entry = await joinWaitingRoom(redis!, eventId);
    await admitWaitingRoomBatch(redis!, eventId, 1, 120, config);
    const admitted = await getWaitingRoomEntry(redis!, entry.entryId, entry.capability);
    if (admitted.status !== 'ADMITTED') throw new Error('Entry should be admitted');
    const admissionToken = admitted.admissionToken;
    if (!admissionToken) throw new Error('Admission token should be present');
    const existing = await createHold(db, config, {
      eventId,
      seatIds: [seatIds[0]!],
      idempotencyKey: 'existing-before-redis-outage',
      admissionToken,
      admissionTokenValidator: (id, token) => validateAdmissionToken(redis!, id, token, config),
    });

    redis!.disconnect();
    await expect(
      createHold(db, config, {
        eventId,
        seatIds: [seatIds[1]!],
        idempotencyKey: 'new-during-redis-outage',
        admissionToken,
        admissionTokenValidator: (id, token) => validateAdmissionToken(redis!, id, token, config),
      }),
    ).rejects.toMatchObject({
      code: 'WAITING_ROOM_UNAVAILABLE',
      statusCode: 503,
    });
    await expect(
      confirmReservation(db, config, existing.reservationId, existing.capability),
    ).resolves.toMatchObject({ status: 'CONFIRMED' });
  });
});
