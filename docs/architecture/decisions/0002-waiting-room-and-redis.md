# ADR 0002: Redis provides FIFO admission, not booking state

- **Status:** Accepted
- **Date:** 2026-10-12

## Context

Popular event drops need to smooth bursts and offer an understandable queue order. Queue traffic must not become a second source of truth for seat ownership, and temporary admission must not promise a seat.

## Decision

Redis stores an event-scoped monotonic sequence, sorted queue, and short-lived entry/admission metadata. Lua scripts make enqueue and batch admission atomic. Admission tokens are signed, event-scoped, and expire. The API validates them before creating a new hold. Redis failures reject new queue-enabled holds with a retryable service error.

## Consequences

While Redis data survives, queue order follows its sequence. A Redis restart can lose positions and admissions, so the waiting room is best-effort traffic control rather than a durable fairness guarantee. PostgreSQL holds and confirmations remain available because they do not depend on Redis. Operations must monitor queue depth and Redis availability.
