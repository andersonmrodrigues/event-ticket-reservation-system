import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';
import {
  createCapability,
  hashCapability,
  isValidCapability,
} from '../../../src/modules/reservations/application/capability.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/tickets',
  CAPABILITY_KEYS: 'test-v1:a-secret-that-is-at-least-thirty-two-characters-long',
});

describe('reservation capability', () => {
  it('derives a stable bearer value for idempotent replay', () => {
    const first = createCapability(
      'reservation-id',
      'test-v1',
      'a-secret-that-is-at-least-thirty-two-characters-long',
    );
    expect(
      createCapability(
        'reservation-id',
        'test-v1',
        'a-secret-that-is-at-least-thirty-two-characters-long',
      ),
    ).toBe(first);
    expect(isValidCapability('reservation-id', first, config)).toBe(true);
    expect(hashCapability(first)).toHaveLength(32);
  });

  it('rejects a token for a different reservation, altered token, or unknown key', () => {
    const capability = createCapability(
      'reservation-id',
      'test-v1',
      'a-secret-that-is-at-least-thirty-two-characters-long',
    );
    expect(isValidCapability('another-reservation', capability, config)).toBe(false);
    expect(isValidCapability('reservation-id', `${capability}tampered`, config)).toBe(false);
    expect(isValidCapability('reservation-id', `missing.${capability.split('.')[1]}`, config)).toBe(
      false,
    );
  });
});
