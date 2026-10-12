import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  CAPABILITY_KEYS: z
    .string()
    .default('local-v1:replace-this-local-key-with-at-least-32-characters'),
  DEFAULT_HOLD_TTL_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
  ADMISSION_TTL_SECONDS: z.coerce.number().int().min(10).max(900).default(120),
  QUEUE_ADMISSION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly capabilityKeys: ReadonlyMap<string, string>;
  readonly activeCapabilityKeyId: string;
  readonly defaultHoldTtlSeconds: number;
  readonly admissionTtlSeconds: number;
  readonly queueAdmissionBatchSize: number;
  readonly otelEndpoint?: string;
}

export function loadConfig(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const keyEntries = parsed.data.CAPABILITY_KEYS.split(',').map((entry) => {
    const separator = entry.indexOf(':');
    if (separator < 1) throw new Error('CAPABILITY_KEYS entries must use key-id:secret format');
    const id = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error(
        'Capability key IDs may contain only letters, numbers, underscores, and hyphens',
      );
    if (id.length === 0 || secret.length < 32)
      throw new Error('Capability secrets must be at least 32 characters');
    return [id, secret] as const;
  });
  const capabilityKeys = new Map(keyEntries);
  if (capabilityKeys.size !== keyEntries.length)
    throw new Error('CAPABILITY_KEYS contains duplicate key IDs');
  const firstKey = keyEntries[0];
  if (!firstKey) throw new Error('At least one capability key is required');
  if (parsed.data.NODE_ENV === 'production' && firstKey[1].startsWith('replace-this-')) {
    throw new Error('A production CAPABILITY_KEYS secret must be configured');
  }
  const { OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint } = parsed.data;
  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: parsed.data.DATABASE_URL,
    redisUrl: parsed.data.REDIS_URL,
    capabilityKeys,
    activeCapabilityKeyId: firstKey[0],
    defaultHoldTtlSeconds: parsed.data.DEFAULT_HOLD_TTL_SECONDS,
    admissionTtlSeconds: parsed.data.ADMISSION_TTL_SECONDS,
    queueAdmissionBatchSize: parsed.data.QUEUE_ADMISSION_BATCH_SIZE,
    ...(otelEndpoint ? { otelEndpoint } : {}),
  };
}
