# ADR 0001: PostgreSQL owns seat inventory

- **Status:** Accepted
- **Date:** 2026-10-12

## Context

Many clients can request the same assigned seat at once. The system must prevent two active holds or a hold and a sale from owning one seat. Inventory also needs to remain correct through Redis restarts and worker outages.

## Decision

PostgreSQL is the authority for seat state. The hold transaction sorts seat IDs, locks all matching inventory rows with `FOR UPDATE`, checks the complete request, and writes the reservation, items, inventory, idempotency record, and outbox event before commit. Partial requests roll back. A partial unique index on active reservation items and a seat ownership constraint provide additional guards.

## Consequences

Every ownership decision goes through PostgreSQL transactions, so Redis loss cannot oversell seats. Contention for the same seat queues on a row lock. The application must bound database pools and request timeouts and measure lock wait under load. The waiting room controls admission volume but is never an inventory ledger.
