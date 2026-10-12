import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const conflicts = new Counter('reservation_conflicts');
const successfulHolds = new Counter('reservation_holds_created');
const latency = new Trend('reservation_latency', true);
const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
const eventId = __ENV.EVENT_ID || '11111111-1111-4111-8111-111111111111';
const seatId = __ENV.SEAT_ID || '22222222-2222-4222-8222-000000000001';
const admissionToken = __ENV.ADMISSION_TOKEN || '';

export const options = {
  scenarios: {
    contention: { executor: 'shared-iterations', vus: 25, iterations: 25, maxDuration: '30s' },
  },
  thresholds: { reservation_holds_created: ['count==1'], reservation_conflicts: ['count==24'] },
};

export default function () {
  const response = http.post(
    `${baseUrl}/v1/events/${eventId}/reservations`,
    JSON.stringify({ seatIds: [seatId] }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `k6-${__VU}-${__ITER}`,
        ...(admissionToken ? { 'X-Admission-Token': admissionToken } : {}),
      },
    },
  );
  latency.add(response.timings.duration);
  if (response.status === 201) successfulHolds.add(1);
  else if (response.status === 409) conflicts.add(1);
  check(response, {
    'request is either the winner or a seat conflict': (result) =>
      result.status === 201 || result.status === 409,
  });
}
