CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  venue text NOT NULL,
  starts_at timestamptz NOT NULL,
  sales_open boolean NOT NULL DEFAULT true,
  waiting_room_enabled boolean NOT NULL DEFAULT false,
  hold_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (hold_ttl_seconds BETWEEN 30 AND 1800),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  status text NOT NULL CHECK (status IN ('HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED')),
  capability_hash bytea NOT NULL,
  capability_key_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS reservations_due_idx ON reservations (expires_at, id) WHERE status = 'HELD';
CREATE INDEX IF NOT EXISTS reservations_event_idx ON reservations (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section text NOT NULL,
  row_label text NOT NULL,
  seat_label text NOT NULL,
  state text NOT NULL DEFAULT 'AVAILABLE' CHECK (state IN ('AVAILABLE', 'HELD', 'SOLD')),
  current_reservation_id uuid REFERENCES reservations(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, section, row_label, seat_label),
  CHECK ((state = 'AVAILABLE') = (current_reservation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS event_seats_event_state_idx ON event_seats (event_id, state, section, row_label, seat_label);

CREATE TABLE IF NOT EXISTS reservation_items (
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id),
  seat_id uuid NOT NULL REFERENCES event_seats(id),
  state text NOT NULL CHECK (state IN ('HELD', 'SOLD', 'RELEASED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (reservation_id, seat_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_items_active_seat_idx
  ON reservation_items (event_id, seat_id) WHERE state IN ('HELD', 'SOLD');
CREATE INDEX IF NOT EXISTS reservation_items_reservation_idx ON reservation_items (reservation_id, state);

CREATE TABLE IF NOT EXISTS idempotency_records (
  event_id uuid NOT NULL REFERENCES events(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_hash bytea NOT NULL,
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events (occurred_at, id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS waiting_room_events (
  event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  admission_capacity integer NOT NULL DEFAULT 50 CHECK (admission_capacity > 0),
  admission_ttl_seconds integer NOT NULL DEFAULT 120 CHECK (admission_ttl_seconds BETWEEN 10 AND 900)
);
