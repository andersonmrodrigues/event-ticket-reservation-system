# Event Ticket Reservation System Implementation Plan

**Goal:** Build a documented TypeScript API that safely holds, confirms, and releases assigned seats under contention, with an idempotent reservation flow and a FIFO high-demand waiting room.

**Architecture:** A modular monolith runs as an HTTP API process and a background worker from the same codebase. PostgreSQL is the authority for seat and reservation state; Redis manages FIFO admission and carries retryable outbox events. All user-visible state transitions are transactional in PostgreSQL.

**Tech Stack:** Node.js 24 LTS, TypeScript, Fastify, TypeBox, PostgreSQL 18 with `pg`, Redis with the official Node.js `redis` client, Pino, Prometheus metrics, OpenTelemetry, Vitest, Testcontainers, Docker Compose, and GitHub Actions.

**Spec:** [Approved design](../specs/intent-45f843573fea16fe93bb.md)

## Global Constraints

- Node.js 24 LTS and TypeScript.
- A modular monolith, deployed as an API process and a worker process from the same codebase and container image.
- PostgreSQL is authoritative for event inventory and reservation state.
- Redis handles the FIFO waiting room and admission throttling. Redis never decides whether a seat is owned or available.
- Docker Compose provides the local PostgreSQL and Redis services.
- The waiting room admits users temporarily to try selecting seats; it does not allocate seats automatically.
- A multi-seat hold is all-or-nothing and lasts five minutes by default, configurable per event.
- Confirmation must win before expiry. In a race, only one state transition may succeed.
- A retry with the same idempotency key and request returns the original result. Reusing a key with a different request returns a conflict.
- No real payment processing is included. Confirmation represents the booking being accepted by this service.

## Review Focus

1. **Concurrent attempts for the same event-seat:** one hold succeeds and every other attempt receives a seat conflict. Covered by the PostgreSQL integration test in Task 4.
2. **Idempotency retries after an uncertain response:** the same key and body return the same reservation ID, expiry, and capability; a different body with that key conflicts. Covered by Task 4, including replay after the hold has expired.
3. **Confirmation racing with expiry:** only one terminal transition wins and a confirmed seat is never released. Covered by Task 5 with concurrent database operations.
4. **Redis outage or restart:** new holds for a queue-enabled event fail closed while existing PostgreSQL reservations remain readable and confirmable. Covered by Task 6.
5. **Invalid or replayed capabilities and admission tokens:** a wrong secret, wrong event, expired token, or token for another reservation never grants access; secrets never appear in logs. Covered by Tasks 5–7.

## File Structure

```text
package.json                         project scripts and dependency metadata
package-lock.json                    reproducible npm dependency tree
tsconfig.json                        strict TypeScript compilation
eslint.config.js                     lint rules for TypeScript
.prettierrc.json                     stable formatting configuration
.env.example                         documented non-secret configuration
compose.yaml                         local PostgreSQL, Redis, API, and worker
Dockerfile                           one production image for API and worker
.github/workflows/ci.yml             repeatable CI checks
src/main.ts                          API process entry point
src/worker.ts                        background worker entry point
src/app/build-app.ts                 Fastify construction and plugin registration
src/config/env.ts                    validated runtime configuration
src/shared/db/pool.ts                PostgreSQL pool lifecycle
src/shared/redis/client.ts           Redis client lifecycle
src/shared/http/errors.ts            stable HTTP error mapping
src/shared/observability/            Pino, metrics, traces, request correlation
src/modules/events/                  event and seat discovery
src/modules/reservations/domain/     reservation states and transition rules
src/modules/reservations/application/hold-seat.ts
src/modules/reservations/application/confirm-reservation.ts
src/modules/reservations/application/expire-reservations.ts
src/modules/reservations/infrastructure/postgres/
src/modules/reservations/http/routes.ts
src/modules/waiting-room/             FIFO entry, admission, and token handling
src/modules/outbox/                   PostgreSQL outbox and Redis Stream publisher
migrations/                           ordered SQL schema migrations
scripts/seed-demo.ts                  deterministic demo event and assigned seats
tests/unit/                           domain, configuration, and token unit tests
tests/integration/                    real PostgreSQL and Redis boundary tests
performance/reservation-contention.js k6 concurrent-seat scenario
README.md                             portfolio-oriented system guide
docs/architecture/decisions/          concise records for key tradeoffs
```

The implementation should keep domain rules independent from Fastify, Redis, and SQL row shapes. Each module owns its routes, application services, and infrastructure adapters; shared code is limited to runtime concerns.

---

### Task 1: Establish the TypeScript project and repeatable local checks

**Files:**

- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.env.example`
- Create: `src/config/env.ts`, `src/main.ts`, `src/worker.ts`, `src/app/build-app.ts`
- Create: `tests/unit/config/env.test.ts`, `tests/unit/app/build-app.test.ts`
- Create: `Dockerfile`, `compose.yaml`, `.github/workflows/ci.yml`
- Update: `AGENTS.md` with human-owned project guidance outside the managed Paved block

**Interfaces:**

- `loadConfig(source: NodeJS.ProcessEnv): AppConfig` validates required settings and applies safe local defaults.
- `buildApp(dependencies: AppDependencies): FastifyInstance` constructs an app without opening network listeners.
- `src/main.ts` and `src/worker.ts` own process startup and graceful shutdown; they do not contain domain rules.

- [ ] **Step 1: Create a failing configuration test.** Cover missing `DATABASE_URL`, malformed `PORT`, and local defaults without reading the real process environment.

This step needs a test runner before the test source can execute. Start by creating only package metadata, scripts, compiler/linter/formatter configuration, and the Vitest setup. Do not create application modules yet.

- [ ] **Step 1a: Add project metadata and tooling dependencies.** Set ESM, `engines.node` to `>=24`, and scripts for build, typecheck, lint, formatting, unit tests, integration tests, migrations, and seeding. Add Fastify, TypeBox, Zod, `pg`, `redis`, Pino, `prom-client`, OpenTelemetry packages, Vitest, Testcontainers, TypeScript, ESLint, and Prettier.

- [ ] **Step 1b: Configure strict TypeScript, Vitest, ESLint, and Prettier.** Include `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and separate unit/integration test configurations. Verify the empty project can run `npm run typecheck` and `npm run lint`.

- [ ] **Step 2: Create the failing configuration test.** Cover missing `DATABASE_URL`, malformed `PORT`, and local defaults without reading the real process environment.

```ts
it('rejects a missing DATABASE_URL', () => {
  expect(() => loadConfig({ REDIS_URL: 'redis://localhost:6379' })).toThrow(/DATABASE_URL/);
});
```

- [ ] **Step 3: Run the test and verify it fails because `loadConfig` is not implemented.**

Run: `npm run test:unit -- tests/unit/config/env.test.ts`

Expected: the test runner reports the missing module or exported function.

- [ ] **Step 4: Implement `loadConfig` with Zod.** Parse database and Redis URLs, port, capability key ring, hold duration, queue admission TTL, and log level; reject invalid or missing production secrets.

- [ ] **Step 5: Add Fastify app construction and the liveness route.** Assert `GET /health/live` returns 200 without connecting to PostgreSQL or Redis.

- [ ] **Step 6: Add Docker Compose and the multi-process container commands.** Configure PostgreSQL and Redis health checks; expose API and worker as separate commands from the same image. Do not put secrets in `.env.example`.

- [ ] **Step 7: Run all foundation checks.**

Run: `npm run typecheck && npm run lint && npm run test:unit && npm run build`

Expected: all commands succeed with the new project skeleton.

- [ ] **Step 8: Review Paved-generated context and check proposals after repository sources exist.** Run `paved generate --json`, inspect every proposal, and adopt only reviewed artifacts. The current Paved state has no `.paved/project/`, `.paved/rules/`, or verification profile; do not edit those human-owned files by hand or claim a Paved verification check until its command binding exists.

- [ ] **Step 9: Commit the reviewed foundation.**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.js .prettierrc.json .env.example Dockerfile compose.yaml .github/workflows/ci.yml src tests AGENTS.md
git commit -m "chore: bootstrap TypeScript backend"
```

---

### Task 2: Create the event inventory model and database schema

**Files:**

- Create: `migrations/001_create_events_and_inventory.sql`
- Create: `src/modules/events/domain/event.ts`, `src/modules/events/domain/seat.ts`
- Create: `src/modules/events/infrastructure/postgres/event-repository.ts`
- Create: `src/shared/db/pool.ts`, `src/shared/db/migrate.ts`
- Create: `scripts/seed-demo.ts`
- Test: `tests/integration/events/inventory.test.ts`

**Interfaces:**

- `EventRepository.listUpcoming(): Promise<readonly EventSummary[]>`
- `EventRepository.listSeats(eventId: string): Promise<readonly SeatAvailability[]>`
- `SeatAvailability.state` is one of `AVAILABLE | HELD | SOLD`.

- [ ] **Step 1: Add a Testcontainers integration test** that applies migrations, seeds one event with three seats, and verifies the repository returns all seats as available.

- [ ] **Step 2: Run the focused integration test and verify it fails** because migration and repository files do not yet exist.

Run: `npm run test:integration -- tests/integration/events/inventory.test.ts`

- [ ] **Step 3: Write the initial SQL migration.** Create `events`, `event_seats`, `reservations`, `reservation_items`, `idempotency_records`, and `outbox_events`; add foreign keys, checks, uniqueness constraints, and indexes for event lookup, expiry scans, and outbox polling.

- [ ] **Step 4: Implement event and seat row mapping.** Keep SQL row types private to the PostgreSQL adapter and return domain values from repository methods.

- [ ] **Step 5: Add deterministic demo seed data.** Use stable event and seat IDs so README examples and the load test can target the same event without hard-coded production secrets.

- [ ] **Step 6: Re-run the focused integration test and the migration check.**

Run: `npm run test:integration -- tests/integration/events/inventory.test.ts && npm run db:migrate`

Expected: migration is idempotently tracked and the seeded inventory reads as available.

- [ ] **Step 7: Commit the database-backed event inventory.**

```bash
git add migrations src/modules/events src/shared/db scripts/seed-demo.ts tests/integration/events/inventory.test.ts
git commit -m "feat: add event inventory schema"
```

---

### Task 3: Expose event and seat discovery endpoints

**Files:**

- Create: `src/modules/events/application/list-events.ts`, `src/modules/events/application/list-seats.ts`
- Create: `src/modules/events/http/routes.ts`, `src/modules/events/http/schemas.ts`
- Modify: `src/app/build-app.ts`
- Test: `tests/integration/events/event-routes.test.ts`

**Interfaces:**

- `GET /v1/events` returns event IDs, names, start times, and booking state.
- `GET /v1/events/:eventId/seats` returns seat identifiers and availability without reservation capabilities.

- [ ] **Step 1: Add Fastify injection tests** for event listing, seat listing, unknown event `404`, and malformed UUID `400`.

- [ ] **Step 2: Run the focused route tests and verify the expected failures.**

Run: `npm run test:integration -- tests/integration/events/event-routes.test.ts`

- [ ] **Step 3: Implement routes with TypeBox request and response schemas.** Route handlers call application services and do not issue SQL directly.

- [ ] **Step 4: Verify that response schemas omit `capability_hash`, reservation IDs for another customer, and internal database fields.**

- [ ] **Step 5: Run the route tests and generated OpenAPI schema check.**

Run: `npm run test:integration -- tests/integration/events/event-routes.test.ts && npm run build`

- [ ] **Step 6: Commit the event discovery API.**

```bash
git add src/modules/events src/app/build-app.ts tests/integration/events/event-routes.test.ts
git commit -m "feat: expose event inventory API"
```

---

### Task 4: Implement atomic holds and idempotent retries

**Files:**

- Create: `src/modules/reservations/domain/reservation.ts`, `src/modules/reservations/domain/reservation-state.ts`
- Create: `src/modules/reservations/application/hold-seat.ts`, `src/modules/reservations/application/capability.ts`
- Create: `src/modules/reservations/infrastructure/postgres/reservation-repository.ts`
- Create: `src/modules/reservations/http/routes.ts`, `src/modules/reservations/http/schemas.ts`
- Test: `tests/unit/reservations/reservation-state.test.ts`, `tests/unit/reservations/capability.test.ts`
- Test: `tests/integration/reservations/create-hold.test.ts`, `tests/integration/reservations/concurrent-holds.test.ts`

**Interfaces:**

- `CreateHoldInput = { eventId: string; seatIds: readonly string[]; idempotencyKey: string }`.
- `CreateHoldResult = { reservationId: string; status: 'HELD'; expiresAt: string; capability: string }`.
- `HoldSeat.execute(input: CreateHoldInput): Promise<CreateHoldResult>`.
- `POST /v1/events/:eventId/reservations` accepts `Idempotency-Key` and returns `201` for a new hold, `200` for a replay, `409` for unavailable seats or key/body mismatch, and `503` if a required waiting room is unavailable.

- [ ] **Step 1: Write unit tests for legal reservation transitions and capability derivation.** Capabilities are deterministic HMAC-SHA-256 values derived from the reservation ID and a configured key version, so an idempotent replay can return the same capability without storing it in plaintext. Store a hash and key version; compare hashes with a constant-time comparison.

- [ ] **Step 2: Write an integration test** that requests two seats, repeats the same key/body, and asserts equal reservation ID, expiry, and capability. Reuse the key with a different seat list and assert `409 IDEMPOTENCY_KEY_REUSED`.

Also cover the uncertain-response case: inject a one-shot failure after the PostgreSQL commit but before the HTTP response, retry the same key/body, and assert the original reservation is returned without a second hold. After expiry, a retry inside the 24-hour idempotency retention window returns the original create result; `GET` reports the current `EXPIRED` state and the retry does not create a new hold.

- [ ] **Step 3: Run the focused reservation tests and verify they fail for missing service and route behavior.**

Run: `npm run test:unit -- tests/unit/reservations && npm run test:integration -- tests/integration/reservations/create-hold.test.ts`

- [ ] **Step 4: Implement the PostgreSQL transaction.** Sort requested seat IDs before locking rows with `SELECT ... FOR UPDATE`; validate the complete seat set; write reservation, items, capability hash, five-minute default expiry, idempotency result, and outbox event; then commit. A partial seat set must roll back completely.

- [ ] **Step 5: Add unique and check constraints as the final duplicate-ownership guard.** Persist the idempotency operation scope, request hash, result reference, and expiry. Retain idempotency records for 24 hours; a retry after record retention expires must still be unable to take an already held or sold seat.

- [ ] **Step 6: Add the same-seat contention integration test.** Launch 25 independent requests with unique idempotency keys for the same seat; assert exactly one `HELD`, 24 `409` responses, and exactly one active reservation item for that event-seat.

```ts
const results = await Promise.all(
  Array.from({ length: 25 }, (_, index) =>
    client.createHold({ eventId, seatIds: [seatId], idempotencyKey: `attempt-${index}` }),
  ),
);
expect(results.filter((result) => result.status === 'HELD')).toHaveLength(1);
expect(await repository.countActiveReservations(eventId, seatId)).toBe(1);
```

- [ ] **Step 7: Run reservation unit and integration tests repeatedly.**

Run: `npm run test:unit -- tests/unit/reservations && npm run test:integration -- tests/integration/reservations`

Expected: the race test remains green across repeated runs and no transaction leaves only part of a multi-seat request held.

- [ ] **Step 8: Commit atomic reservation creation.**

```bash
git add src/modules/reservations/domain src/modules/reservations/application/hold-seat.ts src/modules/reservations/application/capability.ts src/modules/reservations/infrastructure/postgres/reservation-repository.ts src/modules/reservations/http tests/unit/reservations tests/integration/reservations
git commit -m "feat: add idempotent seat holds"
```

---

### Task 5: Confirm holds, expire them safely, and publish outbox events

**Files:**

- Create: `src/modules/reservations/application/confirm-reservation.ts`, `src/modules/reservations/application/expire-reservations.ts`
- Create: `src/modules/reservations/infrastructure/postgres/outbox-repository.ts`
- Create: `src/modules/outbox/publish-outbox.ts`, `src/modules/outbox/redis-stream-publisher.ts`
- Modify: `src/worker.ts`, `src/modules/reservations/http/routes.ts`
- Test: `tests/integration/reservations/confirm-expire-race.test.ts`, `tests/integration/outbox/publish-outbox.test.ts`

**Interfaces:**

- `ConfirmReservation.execute(reservationId: string, capability: string): Promise<ConfirmedReservation>`.
- `ExpireReservations.runBatch(limit: number): Promise<number>`.
- `PublishOutbox.runBatch(limit: number): Promise<number>`.
- Confirmation uses `Authorization: Bearer <reservation-capability>` and does not call Redis.

- [ ] **Step 1: Add a failing integration test** that confirms an unexpired hold, rejects a wrong capability, and rejects a hold expired according to PostgreSQL time.

- [ ] **Step 2: Add the race test.** Start confirmation and expiry against the same due reservation; assert one terminal state, consistent seat inventory, and no path from a terminal state back to `HELD`.

- [ ] **Step 3: Implement conditional confirmation.** In a transaction, verify the capability hash, lock the reservation, update only `status = 'HELD' AND expires_at > clock_timestamp()`, and update all reservation seats to sold. Return distinct conflict codes for wrong capability, expired hold, and terminal reservation.

- [ ] **Step 4: Implement bounded expiry batches with `FOR UPDATE SKIP LOCKED`.** Lock due held reservations, transition each to `EXPIRED`, release only its own held seats, and add an outbox event in the same transaction. Make the transition safe to repeat and safe across multiple worker processes.

- [ ] **Step 5: Implement the transactional outbox publisher.** Claim undelivered rows in batches, publish to an event-scoped Redis Stream using the outbox UUID as the deduplication ID, and mark delivery only after Redis acknowledges. If Redis is down, leave rows pending for retry; consumers must deduplicate by event ID.

- [ ] **Step 6: Add worker backoff and graceful shutdown.** Use bounded polling intervals, bounded batch sizes, and separate error handling for expiry and outbox publication; close PostgreSQL and Redis pools after in-flight batches finish.

- [ ] **Step 7: Run confirmation, race, expiry, and outbox integration tests.**

Run: `npm run test:integration -- tests/integration/reservations tests/integration/outbox`

Expected: confirmed inventory is never released, and a failed publisher leaves an outbox row available for retry.

- [ ] **Step 8: Commit confirmation, expiry, and outbox delivery.**

```bash
git add src/modules/reservations/application/confirm-reservation.ts src/modules/reservations/application/expire-reservations.ts src/modules/reservations/infrastructure/postgres/outbox-repository.ts src/modules/outbox src/worker.ts tests/integration/reservations tests/integration/outbox
git commit -m "feat: confirm and expire reservations"
```

---

### Task 6: Implement the FIFO waiting room and admission tokens

**Files:**

- Create: `src/modules/waiting-room/domain/waiting-room-entry.ts`
- Create: `src/modules/waiting-room/application/join-waiting-room.ts`, `src/modules/waiting-room/application/admit-waiting-room.ts`
- Create: `src/modules/waiting-room/infrastructure/redis/waiting-room-repository.ts`
- Create: `src/modules/waiting-room/application/admission-token.ts`, `src/modules/waiting-room/http/routes.ts`
- Test: `tests/unit/waiting-room/admission-token.test.ts`
- Test: `tests/integration/waiting-room/fifo-order.test.ts`, `tests/integration/waiting-room/redis-failure.test.ts`

**Interfaces:**

- `JoinWaitingRoom.execute(eventId: string): Promise<WaitingRoomEntry>`.
- `AdmitWaitingRoom.runBatch(eventId: string, capacity: number): Promise<number>`.
- `POST /v1/events/:eventId/waiting-room` returns an opaque entry capability; `GET /v1/waiting-room/:entryId` reports `WAITING | ADMITTED | EXPIRED` and position when waiting.
- The hold endpoint requires a short-lived, event-scoped admission token when the event's waiting room is enabled.

- [ ] **Step 1: Add unit tests** for signed token validation, wrong-event rejection, tampering, and expiry.

- [ ] **Step 2: Add Redis integration tests** that enqueue three entries and verify admission preserves sequence order and respects the configured batch capacity.

- [ ] **Step 3: Implement queue ordering with an event-scoped Redis sequence and sorted set.** Make enqueue and batch admission atomic with a Lua script; store only the minimum entry metadata and apply explicit TTLs to entry and admission records.

- [ ] **Step 4: Issue short-lived HMAC admission tokens** tied to event ID and entry ID. Use key versions for rotation; never log the token. A Redis restart may reset queue position but cannot change PostgreSQL seat state.

- [ ] **Step 5: Enforce the admission token in `HoldSeat`.** When waiting-room mode is enabled, Redis timeout/unavailability returns retryable `503 WAITING_ROOM_UNAVAILABLE`; do not fall through and create a hold. When the waiting room is disabled for an event, direct reservation follows PostgreSQL rules.

- [ ] **Step 6: Add failure integration tests.** Stop or disconnect Redis and assert new queue-enabled holds fail closed, while a previously created PostgreSQL hold remains readable and confirmable. Verify tokens for another event and expired tokens are rejected.

- [ ] **Step 7: Run waiting-room and reservation suites together.**

Run: `npm run test:integration -- tests/integration/waiting-room tests/integration/reservations`

- [ ] **Step 8: Commit FIFO admission and fail-closed behavior.**

```bash
git add src/modules/waiting-room src/modules/reservations/application/hold-seat.ts tests/unit/waiting-room tests/integration/waiting-room tests/integration/reservations
git commit -m "feat: add FIFO waiting room"
```

---

### Task 7: Add API contracts, operational signals, and production container behavior

**Files:**

- Create: `src/shared/observability/logger.ts`, `src/shared/observability/metrics.ts`, `src/shared/observability/tracing.ts`
- Create: `src/shared/http/health-routes.ts`, `src/shared/http/error-handler.ts`
- Modify: `src/app/build-app.ts`, `src/main.ts`, `src/worker.ts`, `Dockerfile`, `compose.yaml`
- Create: `tests/integration/health/readiness.test.ts`, `tests/integration/security/capability-redaction.test.ts`

- [ ] **Step 1: Add request-correlation tests.** Every error response and structured log line has a request ID; the reservation and admission capability values never appear in captured logs.

- [ ] **Step 2: Register OpenAPI schemas and route documentation.** Document request headers, capability handling, all success responses, conflicts, validation failures, and retryable `503` responses.

- [ ] **Step 3: Add Pino structured logging and low-cardinality Prometheus metrics.** Include reservation outcomes, seat conflicts, expiry lag, queue depth/admission count, outbox backlog, and dependency health; do not use reservation IDs or tokens as metric labels.

- [ ] **Step 4: Add OpenTelemetry HTTP and database spans** behind an optional OTLP exporter. The service must still start with tracing disabled locally.

- [ ] **Step 5: Separate liveness from readiness.** Liveness returns `200` while the process is responsive; readiness returns `503` if PostgreSQL is unavailable and includes Redis state without falsely marking seat writes safe when a required queue is unavailable.

- [ ] **Step 6: Harden the container and shutdown path.** Use a non-root runtime user, pinned major base image, health checks, finite connection timeouts, and graceful termination for both processes.

- [ ] **Step 7: Run security, health, OpenAPI, and build checks.**

Run: `npm run test:integration -- tests/integration/health tests/integration/security && npm run typecheck && npm run build`

- [ ] **Step 8: Commit operational signals and container hardening.**

```bash
git add src/shared/observability src/shared/http src/app/build-app.ts src/main.ts src/worker.ts Dockerfile compose.yaml tests/integration/health tests/integration/security
git commit -m "feat: add service observability"
```

---

### Task 8: Make the system reproducible and reviewable as a portfolio project

**Files:**

- Create: `README.md`, `docs/architecture/decisions/0001-seat-ownership.md`, `docs/architecture/decisions/0002-waiting-room-and-redis.md`
- Create: `performance/reservation-contention.js`
- Create: `.github/workflows/ci.yml` if not already complete in Task 1
- Modify: `.env.example`, `compose.yaml`, `.paved/verification/profile.yaml` only through the supported Paved review flow after checks exist

- [ ] **Step 1: Write a README that explains this system specifically.** Include the no-oversell invariant, transaction boundary, idempotency and capability design, wait-room behavior and limitations, failure handling, local commands, API examples, architecture diagram, and a short known-limitations section.

- [ ] **Step 2: Add architecture decision records.** Record why PostgreSQL owns seat state, why the first release is a modular monolith, and what guarantees FIFO does and does not provide across Redis loss.

- [ ] **Step 3: Add a k6 scenario** that starts from the seeded event and submits unique idempotency keys for the same seat. Assert exactly one successful hold and report request rate, p95 latency, and conflict count. Document a bounded local run such as `k6 run performance/reservation-contention.js`.

Add an end-to-end API test in `tests/e2e/booking-flow.test.ts`: join the waiting room, receive admission, create a hold, retry idempotently, confirm with the reservation capability, and verify the seat is sold and cannot be held again.

- [ ] **Step 4: Configure CI** to use Node.js 24 and service containers for PostgreSQL and Redis; run format check, lint, typecheck, unit tests, integration tests, build, and dependency audit. Do not publish secrets or deployment credentials in repository settings.

- [ ] **Step 5: Generate and review Paved proposals** after scripts and CI are present. Create the verification profile only through the supported Paved flow and only for commands that actually exist. Record any remaining Paved verification gap instead of bypassing it.

- [ ] **Step 6: Run the complete local verification suite and inspect the final diff.**

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build && npm audit --omit=dev`

Expected: every configured check passes; the load test confirms no overselling; docs match observed behavior.

- [ ] **Step 7: Publish the finished repository to the authenticated GitHub account.** Create a public repository named `event-ticket-reservation-system`, push `main`, verify the remote and commit authorship, and confirm no `Co-authored-by` trailer is present. Do this only after the final review is clean.

```bash
git remote add origin https://github.com/andersonmrodrigues/event-ticket-reservation-system.git
git push -u origin main
```

---

## Self-Review

- Every approved spec behavior maps to a task: event/seat discovery (Task 3), atomic temporary holds and idempotency (Task 4), confirmation and expiry (Task 5), FIFO admission (Task 6), API errors and security (Tasks 3–7), operational evidence and portfolio documentation (Tasks 7–8).
- All five review-focus failure modes have named unit or integration tests in the owning task.
- The spec's no-payment, no-frontend, guest-capability, and FIFO-after-Redis-loss boundaries are preserved.
- The current repository has no project context, rule files, or verification profile. Task 1 records an explicit Paved context/proposal review step; no check is treated as authorized until a real binding exists.
- Capability replay is resolved without plaintext storage: the HMAC capability is deterministic per reservation ID and key version; the database stores only its hash and key version, allowing the original capability to be re-derived for idempotent replay.
- No placeholder or TODO remains in the steps. The plan assumes the approved spec and current empty repository, not an existing application structure.
