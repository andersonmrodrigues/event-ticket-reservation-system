import './shared/observability/tracing.js';
import { loadConfig } from './config/env.js';
import { buildApp } from './app/build-app.js';
import { createPool } from './shared/db/pool.js';
import { createRedisClient } from './shared/redis/client.js';
import { runMigrations } from './shared/db/migrate.js';
import { shutdownTracing } from './shared/observability/tracing.js';

const config = loadConfig(process.env);
const db = createPool(config.databaseUrl);
const redis = createRedisClient(config.redisUrl);
let closing = false;

try {
  await runMigrations(db);
  try {
    await redis.connect();
  } catch (error) {
    console.error('Redis is unavailable at startup; queue-enabled holds will fail closed.', error);
  }
  const app = await buildApp({ config, db, redis });
  await app.listen({ host: '0.0.0.0', port: config.port });
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'Shutting down gracefully');
    await app.close();
    await redis.quit().catch(() => undefined);
    await db.end();
    await shutdownTracing();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
} catch (error) {
  console.error('API startup failed.', error);
  await redis.quit().catch(() => undefined);
  await db.end();
  await shutdownTracing();
  process.exitCode = 1;
}
