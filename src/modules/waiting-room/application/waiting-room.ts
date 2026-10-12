import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../../config/env.js';
import { AppError } from '../../../shared/http/errors.js';

const queueKey = (eventId: string) => `waiting-room:${eventId}:queue`;
const sequenceKey = (eventId: string) => `waiting-room:${eventId}:sequence`;
const entryKey = (entryId: string) => `waiting-room:entry:${entryId}`;
const ENTRY_TTL_SECONDS = 86_400;

function signAdmission(
  eventId: string,
  entryId: string,
  expiresAt: number,
  config: AppConfig,
): string {
  const keyId = config.activeCapabilityKeyId;
  const secret = config.capabilityKeys.get(keyId);
  if (!secret) throw new Error('Active capability key is not configured');
  const payload = `${eventId}:${entryId}:${expiresAt}`;
  const signature = createHmac('sha256', secret).update(`admission:${payload}`).digest('base64url');
  return `${keyId}.${entryId}.${expiresAt}.${signature}`;
}

export async function joinWaitingRoom(redis: Redis, eventId: string) {
  const entryId = crypto.randomUUID();
  const capability = randomBytes(32).toString('base64url');
  const capabilityHash = createHash('sha256').update(capability).digest('hex');
  const script = `
    local seq = redis.call('INCR', KEYS[2])
    redis.call('ZADD', KEYS[1], seq, ARGV[1])
    redis.call('HSET', KEYS[3], 'eventId', ARGV[2], 'capabilityHash', ARGV[3], 'status', 'WAITING', 'sequence', seq)
    redis.call('EXPIRE', KEYS[3], ARGV[4])
    return redis.call('ZRANK', KEYS[1], ARGV[1]) + 1
  `;
  try {
    const position = await redis.eval(
      script,
      3,
      queueKey(eventId),
      sequenceKey(eventId),
      entryKey(entryId),
      entryId,
      eventId,
      capabilityHash,
      ENTRY_TTL_SECONDS,
    );
    return { entryId, capability, status: 'WAITING' as const, position: Number(position) };
  } catch {
    throw new AppError('WAITING_ROOM_UNAVAILABLE', 'Waiting room is temporarily unavailable.', 503);
  }
}

export async function getWaitingRoomEntry(
  redis: Redis,
  entryId: string,
  capability: string | undefined,
) {
  if (!capability)
    throw new AppError(
      'INVALID_WAITING_ROOM_CAPABILITY',
      'Waiting-room capability is required.',
      403,
    );
  try {
    const key = entryKey(entryId);
    const entry = await redis.hgetall(key);
    const suppliedHash = createHash('sha256').update(capability).digest('hex');
    const expected = Buffer.from(entry['capabilityHash'] ?? '');
    const actual = Buffer.from(suppliedHash);
    if (
      !entry['eventId'] ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new AppError(
        'INVALID_WAITING_ROOM_CAPABILITY',
        'Waiting-room capability is invalid.',
        403,
      );
    }
    if (entry['status'] === 'ADMITTED') {
      const expiresAt = Number(entry['admissionExpiresAt']);
      if (expiresAt <= Date.now()) return { entryId, status: 'EXPIRED' as const };
      return {
        entryId,
        status: 'ADMITTED' as const,
        admissionToken: entry['admissionToken'],
        expiresAt: new Date(expiresAt).toISOString(),
      };
    }
    const rank = await redis.zrank(queueKey(entry['eventId']), entryId);
    if (rank === null) return { entryId, status: 'EXPIRED' as const };
    return { entryId, status: 'WAITING' as const, position: rank + 1 };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('WAITING_ROOM_UNAVAILABLE', 'Waiting room is temporarily unavailable.', 503);
  }
}

export async function validateAdmissionToken(
  redis: Redis,
  eventId: string,
  token: string | undefined,
  config: AppConfig,
): Promise<boolean> {
  if (!token) return false;
  const [keyId, entryId, expiration, signature] = token.split('.');
  if (!keyId || !entryId || !expiration || !signature || !/^\d+$/.test(expiration)) return false;
  const secret = config.capabilityKeys.get(keyId);
  const expiresAt = Number(expiration);
  if (!secret || expiresAt <= Date.now()) return false;
  const payload = `${eventId}:${entryId}:${expiresAt}`;
  const expectedSignature = createHmac('sha256', secret)
    .update(`admission:${payload}`)
    .digest('base64url');
  const expected = Buffer.from(expectedSignature);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const entry = await redis.hgetall(entryKey(entryId));
    return (
      entry['eventId'] === eventId &&
      entry['status'] === 'ADMITTED' &&
      entry['admissionToken'] === token &&
      Number(entry['admissionExpiresAt']) === expiresAt
    );
  } catch {
    throw new AppError('WAITING_ROOM_UNAVAILABLE', 'Waiting room is temporarily unavailable.', 503);
  }
}

export async function admitWaitingRoomBatch(
  redis: Redis,
  eventId: string,
  capacity: number,
  ttlSeconds: number,
  config: AppConfig,
): Promise<number> {
  try {
    // A hash can expire while its sorted-set member remains. Scan a bounded window and
    // remove stale members atomically so abandoned entries cannot occupy admission slots.
    const scanLimit = Math.min(4_000, Math.max(capacity * 4, capacity + 20));
    const ids = await redis.zrange(queueKey(eventId), 0, scanLimit - 1);
    if (ids.length === 0) return 0;
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const admissions = ids.map((entryId) => ({
      entryId,
      token: signAdmission(eventId, entryId, expiresAt, config),
    }));
    const args = admissions.flatMap(({ entryId, token }) => [entryId, token]);
    args.push(String(expiresAt), String(ENTRY_TTL_SECONDS));
    const ttlScript = `
      local claimed = 0
      local pairs = (#ARGV - 3) / 2
      for index = 1, pairs do
        if claimed >= tonumber(ARGV[#ARGV]) then break end
        local offset = (index - 1) * 2 + 1
        local entryId = ARGV[offset]
        local key = 'waiting-room:entry:' .. entryId
        if redis.call('EXISTS', key) == 0 then
          redis.call('ZREM', KEYS[1], entryId)
        elseif redis.call('ZREM', KEYS[1], entryId) == 1 then
          redis.call('HSET', key, 'status', 'ADMITTED', 'admissionToken', ARGV[offset + 1], 'admissionExpiresAt', ARGV[#ARGV - 2])
          redis.call('EXPIRE', key, ARGV[#ARGV - 1])
          claimed = claimed + 1
        end
      end
      return claimed
    `;
    args.push(String(capacity));
    return Number(await redis.eval(ttlScript, 1, queueKey(eventId), ...args));
  } catch {
    throw new AppError('WAITING_ROOM_UNAVAILABLE', 'Waiting room is temporarily unavailable.', 503);
  }
}
