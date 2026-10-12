import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const reservationOutcomes = new Counter({
  name: 'reservation_requests_total',
  help: 'Reservation hold outcomes by bounded result category.',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

export const queueAdmissions = new Counter({
  name: 'waiting_room_admissions_total',
  help: 'Number of waiting-room entries admitted.',
  registers: [metricsRegistry],
});

export const outboxPending = new Gauge({
  name: 'outbox_pending_events',
  help: 'Number of unpublished outbox events.',
  registers: [metricsRegistry],
});
