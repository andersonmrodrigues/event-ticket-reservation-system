import { Redis } from 'ioredis';

export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
  });
}
