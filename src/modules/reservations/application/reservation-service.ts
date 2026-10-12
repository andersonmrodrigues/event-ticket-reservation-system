import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../../../config/env.js';
import { AppError } from '../../../shared/http/errors.js';
import { createCapability, hashCapability, isValidCapability } from './capability.js';

export interface CreateHoldInput {
  readonly eventId: string;
  readonly seatIds: readonly string[];
  readonly idempotencyKey: string;
  readonly admissionToken?: string;
  readonly admissionTokenValidator: (
    eventId: string,
    token: string | undefined,
  ) => Promise<boolean>;
}

export interface HoldResult {
  readonly reservationId: string;
  readonly status: 'HELD';
  readonly expiresAt: string;
  readonly capability: string;
  readonly replayed: boolean;
}

export async function createHold(
  db: pg.Pool,
  config: AppConfig,
  input: CreateHoldInput,
): Promise<HoldResult> {
  if (
    input.seatIds.length < 1 ||
    input.seatIds.length > 8 ||
    new Set(input.seatIds).size !== input.seatIds.length
  ) {
    throw new AppError('INVALID_SEAT_SELECTION', 'Select between one and eight unique seats.', 400);
  }
  if (!/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey)) {
    throw new AppError('INVALID_IDEMPOTENCY_KEY', 'A printable Idempotency-Key is required.', 400);
  }
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ eventId: input.eventId, seatIds: [...input.seatIds].sort() }))
    .digest();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.eventId}:${input.idempotencyKey}`,
    ]);
    const event = await client.query<{
      sales_open: boolean;
      waiting_room_enabled: boolean;
      hold_ttl_seconds: number;
    }>(
      'SELECT sales_open, waiting_room_enabled, hold_ttl_seconds FROM events WHERE id = $1 FOR SHARE',
      [input.eventId],
    );
    const eventInfo = event.rows[0];
    if (!eventInfo) throw new AppError('EVENT_NOT_FOUND', 'Event not found.', 404);
    if (!eventInfo.sales_open)
      throw new AppError('SALES_CLOSED', 'Ticket sales are closed for this event.', 409);
    const previous = await client.query<{
      request_hash: Buffer;
      reservation_id: string;
      expires_at: Date;
      capability_key_id: string;
    }>(
      `SELECT i.request_hash, r.id AS reservation_id, r.expires_at, r.capability_key_id
       FROM idempotency_records i JOIN reservations r ON r.id = i.reservation_id
       WHERE i.event_id = $1 AND i.idempotency_key = $2 AND i.expires_at > clock_timestamp()`,
      [input.eventId, input.idempotencyKey],
    );
    if (previous.rowCount) {
      const row = previous.rows[0];
      if (!row || !Buffer.from(row.request_hash).equals(requestHash)) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'The idempotency key was already used with a different request.',
          409,
        );
      }
      const secret = config.capabilityKeys.get(row.capability_key_id);
      if (!secret)
        throw new Error(`Capability key ${row.capability_key_id} is no longer configured`);
      await client.query('COMMIT');
      return {
        reservationId: row.reservation_id,
        status: 'HELD',
        expiresAt: row.expires_at.toISOString(),
        capability: createCapability(row.reservation_id, row.capability_key_id, secret),
        replayed: true,
      };
    }
    await client.query(
      `DELETE FROM idempotency_records WHERE event_id = $1 AND idempotency_key = $2 AND expires_at <= clock_timestamp()`,
      [input.eventId, input.idempotencyKey],
    );
    const sortedIds = [...input.seatIds].sort();
    if (
      eventInfo.waiting_room_enabled &&
      !(await input.admissionTokenValidator(input.eventId, input.admissionToken))
    ) {
      throw new AppError(
        'INVALID_ADMISSION_TOKEN',
        'A valid waiting-room admission token is required.',
        403,
      );
    }
    const expired = await client.query<{ id: string }>(
      `SELECT r.id FROM reservations r JOIN event_seats s ON s.current_reservation_id = r.id
       WHERE s.event_id = $1 AND s.id = ANY($2::uuid[]) AND r.status = 'HELD'
         AND r.expires_at <= clock_timestamp() ORDER BY r.id FOR UPDATE OF r`,
      [input.eventId, sortedIds],
    );
    for (const id of new Set(expired.rows.map((row) => row.id))) {
      await client.query(
        `UPDATE reservations SET status = 'EXPIRED' WHERE id = $1 AND status = 'HELD'`,
        [id],
      );
      await client.query(
        `UPDATE reservation_items SET state = 'RELEASED' WHERE reservation_id = $1 AND state = 'HELD'`,
        [id],
      );
      await client.query(
        `UPDATE event_seats SET state = 'AVAILABLE', current_reservation_id = NULL, updated_at = clock_timestamp()
         WHERE current_reservation_id = $1 AND state = 'HELD'`,
        [id],
      );
      await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('reservation', $1, 'reservation.expired', jsonb_build_object('reservationId', $1::uuid))`,
        [id],
      );
    }
    const locked = await client.query<{ id: string; state: string }>(
      `SELECT id, state FROM event_seats WHERE event_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
      [input.eventId, sortedIds],
    );
    if (locked.rowCount !== sortedIds.length)
      throw new AppError('SEAT_NOT_FOUND', 'One or more seats do not belong to this event.', 404);
    if (locked.rows.some((seat) => seat.state !== 'AVAILABLE'))
      throw new AppError('SEAT_UNAVAILABLE', 'One or more seats are no longer available.', 409);
    const reservationResult = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO reservations (event_id, status, capability_hash, capability_key_id, expires_at)
       VALUES ($1, 'HELD', decode(repeat('00', 32), 'hex'), $2, clock_timestamp() + ($3 * interval '1 second'))
       RETURNING id, expires_at`,
      [
        input.eventId,
        config.activeCapabilityKeyId,
        eventInfo.hold_ttl_seconds || config.defaultHoldTtlSeconds,
      ],
    );
    const reservation = reservationResult.rows[0];
    if (!reservation) throw new Error('Reservation insert returned no row');
    const secret = config.capabilityKeys.get(config.activeCapabilityKeyId);
    if (!secret) throw new Error('Active capability key is not configured');
    const capability = createCapability(reservation.id, config.activeCapabilityKeyId, secret);
    await client.query('UPDATE reservations SET capability_hash = $2 WHERE id = $1', [
      reservation.id,
      hashCapability(capability),
    ]);
    for (const seatId of sortedIds) {
      await client.query(
        `INSERT INTO reservation_items (reservation_id, event_id, seat_id, state) VALUES ($1, $2, $3, 'HELD')`,
        [reservation.id, input.eventId, seatId],
      );
    }
    await client.query(
      `UPDATE event_seats SET state = 'HELD', current_reservation_id = $2, updated_at = clock_timestamp()
       WHERE event_id = $1 AND id = ANY($3::uuid[])`,
      [input.eventId, reservation.id, sortedIds],
    );
    await client.query(
      `INSERT INTO idempotency_records (event_id, idempotency_key, request_hash, reservation_id, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + interval '24 hours')`,
      [input.eventId, input.idempotencyKey, requestHash, reservation.id],
    );
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('reservation', $1, 'reservation.held', jsonb_build_object('reservationId', $1::uuid, 'eventId', $2::uuid, 'seatIds', $3::jsonb))`,
      [reservation.id, input.eventId, JSON.stringify(sortedIds)],
    );
    await client.query('COMMIT');
    return {
      reservationId: reservation.id,
      status: 'HELD',
      expiresAt: reservation.expires_at.toISOString(),
      capability,
      replayed: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getReservation(
  db: pg.Pool,
  config: AppConfig,
  reservationId: string,
  capability: string | undefined,
) {
  if (!capability || !isValidCapability(reservationId, capability, config))
    throw new AppError('INVALID_CAPABILITY', 'Reservation capability is invalid.', 403);
  const result = await db.query(
    `SELECT r.id, r.event_id AS "eventId",
       CASE WHEN r.status = 'HELD' AND r.expires_at <= clock_timestamp() THEN 'EXPIRED' ELSE r.status END AS status,
       r.expires_at AS "expiresAt", r.created_at AS "createdAt",
       r.confirmed_at AS "confirmedAt", json_agg(json_build_object('id', s.id, 'section', s.section, 'row', s.row_label, 'seat', s.seat_label) ORDER BY s.section, s.row_label, s.seat_label) AS seats
     FROM reservations r JOIN reservation_items i ON i.reservation_id = r.id JOIN event_seats s ON s.id = i.seat_id
     WHERE r.id = $1 GROUP BY r.id`,
    [reservationId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('RESERVATION_NOT_FOUND', 'Reservation not found.', 404);
  const stored = await db.query<{ capability_hash: Buffer }>(
    'SELECT capability_hash FROM reservations WHERE id = $1',
    [reservationId],
  );
  if (!stored.rows[0] || !hashCapability(capability).equals(stored.rows[0].capability_hash))
    throw new AppError('INVALID_CAPABILITY', 'Reservation capability is invalid.', 403);
  return row;
}

export async function confirmReservation(
  db: pg.Pool,
  config: AppConfig,
  reservationId: string,
  capability: string | undefined,
) {
  if (!capability || !isValidCapability(reservationId, capability, config))
    throw new AppError('INVALID_CAPABILITY', 'Reservation capability is invalid.', 403);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ status: string; capability_hash: Buffer }>(
      'SELECT status, capability_hash FROM reservations WHERE id = $1 FOR UPDATE',
      [reservationId],
    );
    const reservation = result.rows[0];
    if (!reservation) throw new AppError('RESERVATION_NOT_FOUND', 'Reservation not found.', 404);
    if (!hashCapability(capability).equals(reservation.capability_hash))
      throw new AppError('INVALID_CAPABILITY', 'Reservation capability is invalid.', 403);
    const changed = await client.query(
      `UPDATE reservations SET status = 'CONFIRMED', confirmed_at = clock_timestamp()
       WHERE id = $1 AND status = 'HELD' AND expires_at > clock_timestamp() RETURNING id`,
      [reservationId],
    );
    if (changed.rowCount !== 1) {
      const state = await client.query<{ status: string }>(
        'SELECT status FROM reservations WHERE id = $1',
        [reservationId],
      );
      const status = state.rows[0]?.status;
      if (status === 'HELD')
        throw new AppError('HOLD_EXPIRED', 'The reservation hold has expired.', 409);
      throw new AppError('RESERVATION_NOT_HELD', 'The reservation is no longer confirmable.', 409);
    }
    await client.query(
      `UPDATE reservation_items SET state = 'SOLD' WHERE reservation_id = $1 AND state = 'HELD'`,
      [reservationId],
    );
    await client.query(
      `UPDATE event_seats SET state = 'SOLD', updated_at = clock_timestamp() WHERE current_reservation_id = $1`,
      [reservationId],
    );
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('reservation', $1, 'reservation.confirmed', jsonb_build_object('reservationId', $1::uuid))`,
      [reservationId],
    );
    await client.query('COMMIT');
    return { reservationId, status: 'CONFIRMED' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
