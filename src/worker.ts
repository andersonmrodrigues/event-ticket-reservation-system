import './shared/observability/tracing.js';
import { loadConfig } from './config/env.js';
import { createPool } from './shared/db/pool.js';
import { createRedisClient } from './shared/redis/client.js';
import { runMigrations } from './shared/db/migrate.js';
import { expireReservations } from './modules/reservations/application/expire-reservations.js';
import { publishOutboxBatch } from './modules/outbox/publish-outbox.js';
import { admitWaitingRoomBatch } from './modules/waiting-room/application/waiting-room.js';
import { shutdownTracing } from './shared/observability/tracing.js';

const config = loadConfig(process.env);
const db = createPool(config.databaseUrl);
const redis = createRedisClient(config.redisUrl);
let stopping = false;
process.once('SIGINT', () => {
  stopping = true;
});
process.once('SIGTERM', () => {
  stopping = true;
});

try {
  await runMigrations(db);
  try {
    await redis.connect();
  } catch (error) {
    console.error('Redis is not available yet; worker will retry.', error);
  }
  while (!stopping) {
    try {
      await expireReservations(db);
      if (redis.status === 'ready') {
        await publishOutboxBatch(db, redis);
        const events = await db.query<{
          event_id: string;
          admission_capacity: number;
          admission_ttl_seconds: number;
        }>(
          `SELECT w.event_id, w.admission_capacity, w.admission_ttl_seconds FROM waiting_room_events w
           JOIN events e ON e.id = w.event_id WHERE e.sales_open = true`,
        );
        for (const event of events.rows)
          await admitWaitingRoomBatch(
            redis,
            event.event_id,
            event.admission_capacity,
            event.admission_ttl_seconds,
            config,
          );
      }
    } catch (error) {
      console.error('Worker batch failed; it will retry.', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
} finally {
  await redis.quit().catch(() => undefined);
  await db.end();
  await shutdownTracing();
}
