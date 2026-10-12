import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../../config/env.js';

export function createCapability(reservationId: string, keyId: string, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(`reservation:${reservationId}`)
    .digest('base64url');
  return `${keyId}.${signature}`;
}

export function hashCapability(capability: string): Buffer {
  return createHash('sha256').update(capability).digest();
}

export function isValidCapability(
  reservationId: string,
  capability: string,
  config: AppConfig,
): boolean {
  const separator = capability.indexOf('.');
  if (separator < 1) return false;
  const keyId = capability.slice(0, separator);
  const secret = config.capabilityKeys.get(keyId);
  if (!secret) return false;
  const expected = createCapability(reservationId, keyId, secret);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(capability);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
