# Delta for Tick Job Scheduling

## ADDED Requirements

### Requirement: Shared Self-Rescheduling Tick-Job Factory

The system MUST provide one parameterized factory, `createTickJobModule`, in `core/application/`. Each of the four scheduled sync flows (product, sale-order-status, manufacturing-order-retry, partner) MUST obtain its tick-job behavior (scheduling, seeding, worker lifecycle) from that single factory instead of duplicating the logic per flow.

#### Scenario: Flow module delegates to the factory

- GIVEN any of the four `*SyncJobModule.js` composition files
- WHEN its module is inspected
- THEN it contains no duplicated `scheduleNextTick`/`ensureSeeded`/`JobPoller` construction block, and instead composes `createTickJobModule` with its own `kind`, `seedSourceId`, `run`, `tickIntervalMs`, `orphanWatchdogMs`, and `logPrefix`

### Requirement: Kind and Cursor Isolation Per Flow

The system MUST scope job kind, cursor, and watchdog recovery independently per flow, so that one flow's failures never affect another flow's scheduling or seeding.

| Flow | `kind` |
|---|---|
| product | `JOB_KIND.PRODUCT_SYNC` |
| sale-order-status | `JOB_KIND.SALE_ORDER_STATUS_SYNC` |
| manufacturing-order-retry | `JOB_KIND.MANUFACTURING_ORDER_RETRY_SYNC` |
| partner | `JOB_KIND.PARTNER_SYNC` |

#### Scenario: Independent kinds preserved

- GIVEN two or more of the four flows are enabled concurrently
- WHEN one flow's job fails or dead-letters
- THEN the other flows' cursors, seeded jobs, and orphan watchdogs are unaffected

### Requirement: Seed-Source-Id Based Job Seeding

`ensureSeeded` MUST check for an existing active job of the flow's `kind` before seeding, and MUST create a new job keyed by the flow's own seed source id when none is active, so in-flight Mongo jobs already seeded under today's ids are picked up untouched — no re-seed step, no orphan sweep, no migration task.

| Flow | Seed `sourceId` |
|---|---|
| product | `product-sync-loop` |
| sale-order-status | `sale-order-status-sync-loop` |
| manufacturing-order-retry | `manufacturing-order-retry-sync-loop` |
| partner | `partner-sync-loop` |

#### Scenario: Seed source ids preserved unchanged

- GIVEN a flow already has an active job of its `kind` in Mongo, seeded before the refactor
- WHEN `ensureSeeded` runs after the refactor
- THEN it returns `false`, creates no duplicate job, and picks up the existing job untouched

#### Scenario: No active job triggers seeding

- GIVEN no active job exists for a flow's `kind`
- WHEN `ensureSeeded` runs
- THEN a new job is created with that flow's exact seed `sourceId` and `kind`, and `ensureSeeded` returns `true`

### Requirement: Configurable Tick Interval and Orphan Watchdog

Tick interval and orphan watchdog MUST be configurable parameters of the factory, and each flow's effective default MUST remain identical to its pre-refactor value.

#### Scenario: Defaults unchanged for all four flows

- GIVEN no override is supplied by a flow
- WHEN the factory computes effective `tickIntervalMs` and `orphanWatchdogMs`
- THEN both resolve to 60000ms (60s) and 1800000ms (30min) respectively, for all four flows

### Requirement: Finally-Always-Reschedule Semantics

The job handler MUST reschedule the next tick in a `finally` block, so the next tick is always scheduled whether the run succeeds, fails, or dead-letters.

#### Scenario: Reschedule survives a failed run

- GIVEN a flow's `run` rejects with an error
- WHEN the job handler finishes processing
- THEN `scheduleNextTick` still executes before the handler returns, and a new job is queued

#### Scenario: Reschedule survives a restart

- GIVEN the process restarts between ticks
- WHEN the worker starts again
- THEN `ensureSeeded` finds the still-active scheduled job and does not orphan the schedule

### Requirement: Per-Flow Logged Result Fields Preserved

On a successful run, the job handler MUST log the exact same result fields that flow logged before the refactor. No flow may be simplified to always logging the full raw result object unless that was already its pre-refactor behavior.

| Flow | Logged fields on success |
|---|---|
| product | `created, updated, failed, skipped, archived, cursorAdvanced` |
| partner | `created, updated, failed, skipped, archived, cursorAdvanced` |
| sale-order-status | `updated, unmapped, failed, cursorAdvanced` |
| manufacturing-order-retry | entire `result` object, unmodified |

#### Scenario: Product, partner, and sale-order-status log destructured fields

- GIVEN one of these three flows completes a run successfully
- WHEN it logs its `tick.completed` event
- THEN only its listed fields appear in the log payload, nothing added or removed

#### Scenario: Manufacturing-order-retry logs the full result object

- GIVEN the manufacturing-order-retry flow completes `runOnce` successfully
- WHEN it logs `manufacturing-order-retry-sync-job.tick.completed`
- THEN the entire `result` object returned by `runOnce` is logged unchanged, matching pre-refactor behavior

### Requirement: Exported Handler Names Preserved

Each flow module MUST continue to export its handler function under its existing name, unchanged by the refactor, since `src/server.js` and each flow's dedicated test suite import by that exact name.

| Flow | Exported name |
|---|---|
| product | `processProductSyncJob` |
| sale-order-status | `processSaleOrderStatusSyncJob` |
| manufacturing-order-retry | `processManufacturingOrderRetrySyncJob` |
| partner | `processPartnerSyncJob` |

#### Scenario: Handler names match server.js and test imports

- GIVEN `src/server.js` or a flow's dedicated test suite imports a handler by its historical name
- WHEN the refactored module is loaded
- THEN the same name resolves to the equivalent function, with no import path or name change required
