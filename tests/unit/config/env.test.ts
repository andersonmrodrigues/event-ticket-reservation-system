import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';

describe('loadConfig', () => {
  it('requires a database URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects an invalid port', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://localhost/tickets', PORT: '90000' }),
    ).toThrow(/PORT/);
  });

  it('applies local defaults without reading process.env', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost/tickets' });
    expect(config.port).toBe(3000);
    expect(config.defaultHoldTtlSeconds).toBe(300);
    expect(config.activeCapabilityKeyId).toBe('local-v1');
  });

  it('rejects placeholder capability secrets in production', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://localhost/tickets', NODE_ENV: 'production' }),
    ).toThrow(/production CAPABILITY_KEYS/);
  });
});
