import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/shared/db/pool.js';

const config = loadConfig(process.env);
const db = createPool(config.databaseUrl);
const eventId = '11111111-1111-4111-8111-111111111111';
try {
  await db.query(
    `INSERT INTO events (id, name, venue, starts_at, sales_open, waiting_room_enabled)
     VALUES ($1, 'Demo: The Midnight Echoes', 'Arena Central', now() + interval '30 days', true, true)
     ON CONFLICT (id) DO NOTHING`,
    [eventId],
  );
  await db.query(
    `INSERT INTO waiting_room_events (event_id, admission_capacity, admission_ttl_seconds)
     VALUES ($1, 50, 120) ON CONFLICT (event_id) DO NOTHING`,
    [eventId],
  );
  for (let index = 1; index <= 100; index += 1) {
    const seatId = `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
    await db.query(
      `INSERT INTO event_seats (id, event_id, section, row_label, seat_label)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [
        seatId,
        eventId,
        index <= 50 ? 'FLOOR' : 'BALCONY',
        `R${Math.ceil(index / 10)}`,
        `S${index}`,
      ],
    );
  }
  console.info(`Seeded demo event ${eventId} with 100 assigned seats.`);
} finally {
  await db.end();
}
