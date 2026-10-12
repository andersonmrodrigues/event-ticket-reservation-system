import type pg from 'pg';

export async function expireReservations(db: pg.Pool, batchSize = 100): Promise<number> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query<{ id: string }>(
      `SELECT id FROM reservations WHERE status = 'HELD' AND expires_at <= clock_timestamp()
       ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const { id } of due.rows) {
      const changed = await client.query(
        `UPDATE reservations SET status = 'EXPIRED' WHERE id = $1 AND status = 'HELD' RETURNING id`,
        [id],
      );
      if (changed.rowCount !== 1) continue;
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
    await client.query('DELETE FROM idempotency_records WHERE expires_at <= clock_timestamp()');
    await client.query('COMMIT');
    return due.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
