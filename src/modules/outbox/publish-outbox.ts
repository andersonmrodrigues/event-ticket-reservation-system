import type pg from 'pg';
import type { Redis } from 'ioredis';

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: unknown;
}

export async function publishOutboxBatch(
  db: pg.Pool,
  redis: Redis,
  batchSize = 100,
): Promise<number> {
  const client = await db.connect();
  let rows: OutboxRow[] = [];
  try {
    await client.query('BEGIN');
    const pending = await client.query<OutboxRow>(
      `SELECT id, event_type, aggregate_id, payload FROM outbox_events
       WHERE published_at IS NULL ORDER BY occurred_at, id
       LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    rows = pending.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  let published = 0;
  for (const row of rows) {
    try {
      await redis.xadd(
        'reservation-events',
        'MAXLEN',
        '~',
        '100000',
        '*',
        'eventId',
        row.id,
        'type',
        row.event_type,
        'aggregateId',
        row.aggregate_id,
        'payload',
        JSON.stringify(row.payload),
      );
      const marked = await db.query(
        `UPDATE outbox_events SET published_at = clock_timestamp(), attempts = attempts + 1
         WHERE id = $1 AND published_at IS NULL`,
        [row.id],
      );
      if (marked.rowCount === 1) published += 1;
    } catch (error) {
      await db
        .query('UPDATE outbox_events SET attempts = attempts + 1 WHERE id = $1', [row.id])
        .catch(() => undefined);
      throw error;
    }
  }
  return published;
}
