import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { loadConfig } from '../../src/config/env.js';
import { runMigrations } from '../../src/shared/db/migrate.js';
import { createPool } from '../../src/shared/db/pool.js';
import { createRedisClient } from '../../src/shared/redis/client.js';

export async function startIntegrationDependencies(withRedis = false) {
  const postgresContainer: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:18-alpine',
  ).start();
  const databaseUrl = postgresContainer.getConnectionUri();
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    CAPABILITY_KEYS: 'test-v1:integration-test-secret-that-is-over-thirty-two-chars',
  });
  const db = createPool(databaseUrl);
  await runMigrations(db);
  let redisContainer: StartedTestContainer | undefined;
  let redis: ReturnType<typeof createRedisClient> | undefined;
  if (withRedis) {
    redisContainer = await new GenericContainer('redis:8-alpine').withExposedPorts(6379).start();
    redis = createRedisClient(
      `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`,
    );
    await redis.connect();
  }
  return {
    config,
    db,
    redis,
    postgresContainer,
    redisContainer,
    async stop() {
      if (redis?.status === 'ready') await redis.quit();
      else redis?.disconnect();
      await db.end();
      if (redisContainer) await redisContainer.stop();
      await postgresContainer.stop();
    },
  };
}

export async function createEvent(
  db: ReturnType<typeof createPool>,
  options: { waitingRoom?: boolean; holdTtl?: number } = {},
) {
  const event = await db.query<{ id: string }>(
    `INSERT INTO events (name, venue, starts_at, sales_open, waiting_room_enabled, hold_ttl_seconds)
     VALUES ('Integration Event', 'Test Arena', now() + interval '30 days', true, $1, $2) RETURNING id`,
    [options.waitingRoom ?? false, options.holdTtl ?? 300],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error('Could not create test event');
  const seat = await db.query<{ id: string }>(
    `INSERT INTO event_seats (event_id, section, row_label, seat_label)
     VALUES ($1, 'A', '1', '1'), ($1, 'A', '1', '2'), ($1, 'A', '1', '3') RETURNING id`,
    [eventId],
  );
  if (options.waitingRoom) {
    await db.query('INSERT INTO waiting_room_events (event_id) VALUES ($1)', [eventId]);
  }
  return { eventId, seatIds: seat.rows.map(({ id }) => id) };
}
