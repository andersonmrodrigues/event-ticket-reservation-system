# Event Ticket Reservation System

**Status:** design draft for review

**Audience:** portfolio reviewers and contributors

## Purpose

Build a backend API that demonstrates how a ticketing service can handle a popular event without assigning the same seat twice. The project is intended for a personal portfolio: its important decisions should be visible in the code, tests, API documentation, and a reproducible local environment.

The first release covers assigned seats, temporary holds, confirmation, idempotent requests, expiry, and a high-demand waiting room. It does not integrate a payment provider or build a customer-facing website.

## Approved direction

- Node.js with TypeScript.
- A modular monolith, deployed as an API process and a worker process from the same codebase and container image.
- PostgreSQL is authoritative for event inventory and reservation state.
- Redis handles the FIFO waiting room and admission throttling. Redis never decides whether a seat is owned or available.
- Docker Compose provides the local PostgreSQL and Redis services.
- The waiting room admits users temporarily to try selecting seats; it does not allocate seats automatically.
- A multi-seat hold is all-or-nothing and lasts five minutes by default, configurable per event.
- Confirmation must win before expiry. In a race, only one state transition may succeed.
- A retry with the same idempotency key and request returns the original result. Reusing a key with a different request returns a conflict.
- No real payment processing is included. Confirmation represents the booking being accepted by this service.

## Proposed implementation stack

- Node.js 24 LTS and TypeScript.
- Fastify for the HTTP API and generated OpenAPI documentation.
- PostgreSQL accessed through `pg` and explicit SQL migrations. Critical locking and state transitions remain visible in SQL.
- Redis sorted sets for FIFO waiting-room order, with admission records and short-lived tokens.
- Pino structured logs and Prometheus-compatible metrics. Tracing can use OpenTelemetry with an optional local collector.
- Vitest for unit tests and Testcontainers for integration tests that exercise real PostgreSQL and Redis behavior.
- Docker Compose for local dependencies and separate API and worker processes.

Fastify's TypeScript documentation supports plugin-based composition and schema-typed routes. PostgreSQL row locks provide a database-enforced path for serializing conflicting seat updates. Redis sorted sets provide score ordering for the waiting room.

## Modules and responsibilities

The codebase is one deployable application with explicit module boundaries:

1. **Events and inventory** — event lifecycle, assigned seats, and seat availability queries.
2. **Reservations** — hold creation, confirmation, cancellation, idempotency, and expiry transitions.
3. **Waiting room** — queue entry, position, admission windows, and token validation.
4. **Outbox and worker** — reliable publication of committed domain events and background expiry work.
5. **HTTP and platform** — request validation, error mapping, configuration, health checks, logging, and metrics.

HTTP handlers validate input and call application services. Application services coordinate transactions and module interfaces. Domain rules do not depend on Fastify, Redis, or transport schemas.

## Reservation invariants

These properties are more important than any particular implementation detail:

1. A seat for an event has at most one active hold or confirmed reservation.
2. A request for multiple seats commits all requested seats or none.
3. A hold cannot be confirmed after its database expiry time.
4. Expiry and confirmation are idempotent state transitions; repeated worker delivery cannot release a confirmed seat.
5. An idempotency key is persisted with the operation result in the same PostgreSQL transaction as the hold.
6. A Redis outage or restart cannot create duplicate seat ownership or erase confirmed reservations.
7. When the waiting room is enabled and Redis is unavailable, new hold requests fail closed with a retryable service error. Existing reservations can still be read or confirmed through PostgreSQL.

The reservation transaction locks the relevant event-seat rows in a stable order, validates that every requested seat is available, writes the hold and its items, updates inventory, and stores the idempotency result. Database constraints remain the final guard against duplicate active ownership. Lock acquisition order is stable to reduce deadlocks. Deadlock or serialization failures are retried only a small bounded number of times; callers may safely retry with the same idempotency key.

## Reservation lifecycle and HTTP surface

The initial API exposes:

- `GET /v1/events` and `GET /v1/events/:eventId/seats` for event and inventory discovery.
- `POST /v1/events/:eventId/waiting-room` and `GET /v1/waiting-room/:entryId` to join and poll the FIFO room.
- `POST /v1/events/:eventId/reservations` to create an all-or-nothing hold. It requires an `Idempotency-Key` and, when enabled, a valid admission token.
- `GET /v1/reservations/:reservationId` to inspect the reservation.
- `POST /v1/reservations/:reservationId/confirm` to confirm an unexpired hold.

Because accounts and an identity provider are outside this project's focus, a successful hold returns an opaque, high-entropy reservation capability. The API stores only a hash of that capability and requires it for reading or confirming the reservation. Waiting-room entries use the same capability pattern. Tokens must not appear in logs.

The reservation lifecycle is `HELD -> CONFIRMED`, `HELD -> EXPIRED`, or `HELD -> CANCELLED`. Terminal states cannot transition back to `HELD`. The worker scans due holds in bounded batches and uses row locking with `SKIP LOCKED` so multiple worker instances can cooperate. A request path also treats a hold whose `expires_at` is in the past as expired, so correctness does not depend on worker punctuality.

## Waiting-room behavior

Redis maintains FIFO order with an event-scoped monotonic sequence and a sorted set. A worker admits users in bounded batches and issues short-lived admission tokens. An admission token allows a bounded reservation attempt window; it does not guarantee an available seat. Tokens are event-scoped, have a short TTL, and retries use the reservation idempotency key.

The queue is a traffic-control mechanism, not the inventory ledger. Queue state may be rebuilt or restarted after Redis loss; reservation data remains intact in PostgreSQL. Queue admission is closed when Redis is unavailable rather than allowing a high-demand event to bypass its waiting room.

## Failure handling and event delivery

The same database transaction that changes reservation state inserts an outbox event. A worker claims outbox rows in batches, publishes them, and marks them delivered. Delivery is at least once; consumers and handlers deduplicate by event ID. A crash before marking delivery may republish an event, so handlers must be safe to repeat.

Expiry workers are also safe to run more than once and in parallel. Time comparisons use PostgreSQL's clock. Queue token validation may fail temporarily during Redis outages, but it cannot change reservation ownership. API shutdown stops accepting new work, drains in-flight requests, and closes database and Redis pools.

Errors use a stable JSON shape with a machine-readable code, safe message, and request ID. Expected conflicts (seat unavailable, expired hold, idempotency mismatch, invalid admission token) are distinct from retryable infrastructure errors.

## Security and privacy

- Validate every request at the HTTP boundary and reject unknown fields on write operations.
- Hash opaque reservation and waiting-room capabilities before storage; compare them without exposing their values in logs.
- Apply request-size limits, rate limits, security headers, and bounded database/Redis timeouts.
- Keep secrets in environment variables; provide only non-secret local defaults.
- Use least-privilege database roles in the deployment guidance.
- Do not store payment details or unnecessary personal data.

## Portfolio and operability requirements

- An English README explains the domain, key invariants, module map, tradeoffs, local startup, API examples, and known limits. The wording should describe this implementation specifically rather than make generic production-readiness claims.
- OpenAPI is generated from route schemas and includes success, conflict, validation, and retryable-error responses.
- Structured logs include request and reservation IDs but never capability tokens.
- Metrics include reservation outcomes, conflict rate, hold-expiry lag, waiting-room depth/admission rate, outbox backlog, and dependency health.
- Health endpoints distinguish process liveness from readiness of required dependencies.
- A load-test scenario demonstrates simultaneous attempts for one seat and records throughput, latency, and the no-oversell invariant.
- CI runs formatting/lint, type checking, unit tests, database-backed integration tests, and build. A profile only enables checks that exist and have been reviewed.

## Out of scope for the first release

- Customer accounts, password management, and third-party identity integration.
- Payment capture, refunds, and payment-provider callbacks.
- A web frontend, mobile applications, venue seating-plan editor, and ticket scanning.
- Microservices, Kafka, Kubernetes, and multi-region active-active writes.
- A claim of strict FIFO across Redis data loss or independent waiting rooms. The implemented guarantee is FIFO while the event queue state is intact.

## Review notes

The following scope choices are deliberate and should be reviewed before implementation: guest reservations use opaque capabilities instead of accounts; the waiting room is FIFO while Redis state is intact; and the first version simulates confirmation without charging a customer. The project's primary correctness claim is that concurrent requests cannot oversell assigned seats.

## References

- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [Fastify TypeScript guide](https://fastify.dev/docs/latest/Reference/TypeScript/)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [Redis sorted-set commands](https://redis.io/docs/latest/commands/zadd/)
