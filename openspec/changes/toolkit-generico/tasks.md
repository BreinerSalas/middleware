# Tasks: Toolkit readiness — resolve couplings #1, #2, #4

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~550-750 (Slice #1 ~90-120, Slice #2 ~40-60, Slice #4 ~420-560) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (#1 write-back guard) → PR 2 (#2 odooDate move) → PR 3 (#4 tick job factory) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Fail-fast `buildWriteBackPayload` guard, 12 stub injections | PR 1 | `npx vitest test/application/use-cases.test.js test/core/application/ProcessSyncJobUseCase.test.js` | N/A — pure in-process unit tests, no live scenario | `ProcessSyncJobUseCase.js` + 2 test files; `git revert` isolated |
| 2 | Move `odooDate.js` out of `core/` | PR 2 | `npx vitest test/adapters/outbound/odoo/odooDate.test.js` | N/A — pure file move, no I/O change | `odooDate.js`/test + 3 `*SyncModule.js` import lines; `git revert` isolated |
| 3 | `createTickJobModule` factory + 4 wrapper migrations | PR 3 | `npx vitest test/core/application/createTickJobModule.test.js test/composition/*SyncJobModule.test.js` | N/A — factory covered by direct unit tests; no external Odoo/Mongo call in test suite | Factory file + 4 `*SyncJobModule.js` + 4 suites; each wrapper commit independently revertable, factory stays |

Estimated changed lines are additions+deletions per the design's File Changes table (1 new source file ~140 lines, 1 new test file ~150-200 lines, 4 wrappers ~40 lines each rewritten, 4 suites +1 assertion each, 1 guard, 12 stub injections, 1 file move, 3 import lines, docs update). Above the 400-line single-PR budget in aggregate; each slice individually stays comfortably under it. Ask the user for chain strategy (stacked-to-main vs feature-branch-chain) before `sdd-apply` starts Slice #1.

## Slice #1 — Write-Back Fail-Fast Guard (`core-vendor-neutrality`)

- [ ] 1.1 RED: add test in `test/core/application/ProcessSyncJobUseCase.test.js` — `new ProcessSyncJobUseCase({...no retryPolicy.buildWriteBackPayload})` throws `/requires retryPolicy.buildWriteBackPayload/`. Confirm it fails (constructs fine today).
- [ ] 1.2 GREEN: add the constructor guard in `src/core/application/use-cases/ProcessSyncJobUseCase.js` (`:111-116`) — throw plain `Error('ProcessSyncJobUseCase requires retryPolicy.buildWriteBackPayload')` when `typeof retryPolicy.buildWriteBackPayload !== 'function'`; simplify `buildWriteBackPayload(mapping)` body to `return this.retryPolicy.buildWriteBackPayload(mapping)` (drop the `typeof` branch and the `{ id_presupuesto_odoo }` default).
- [ ] 1.3 GREEN: inject `buildWriteBackPayload: (m) => ({ ref: m.targetRef })` (or equivalent vendor-free stub) into all 11 `new ProcessSyncJobUseCase({...})` constructions in `test/application/use-cases.test.js` that currently omit it.
- [ ] 1.4 GREEN: inject the same vendor-free stub into the one construction at `test/core/application/ProcessSyncJobUseCase.test.js:66` (the `retryPolicy.hashPayload` test). Do NOT touch the construction at `:47` — it already supplies `buildWriteBackPayload`.
- [ ] 1.5 REFACTOR: run full `npm test`; confirm `dealSyncModule.js:27-36` still owns `id_presupuesto_odoo`/`numero_orden_fabricacion` and its own suite is untouched and green.
- [ ] 1.6 Verify: `rg 'id_presupuesto_odoo' src/core/` returns zero hits.

## Slice #2 — Move `odooDate` Out of Core (`core-vendor-neutrality`)

- [ ] 2.1 RED: `git mv test/core/shared/odooDate.test.js test/adapters/outbound/odoo/odooDate.test.js`; update its require path to `../../../../src/adapters/outbound/odoo/odooDate.js`. Confirm it fails (module not found).
- [ ] 2.2 GREEN: `git mv src/core/shared/odooDate.js src/adapters/outbound/odoo/odooDate.js`. Run the moved test; confirm green with no logic change.
- [ ] 2.3 GREEN: update the `odooDate` import path in `src/composition/productSyncModule.js`, `src/composition/partnerSyncModule.js`, and `src/composition/saleOrderStatusSyncModule.js` (one require line each).
- [ ] 2.4 Verify: `rg 'core/shared/odooDate'` returns zero hits; `rg 'id_presupuesto_odoo|odooDate|JOB_KIND' src/core/` returns zero hits; run full `npm test`.

## Slice #4 — Shared Tick-Job Factory (`tick-job-scheduling`)

- [x] 4.1 RED: create `test/core/application/createTickJobModule.test.js` covering: required-param guards (`kind`, `seedSourceId`, `run`, `jobRepository`, `logPrefix`); seed doc shape (`kind`/`sourceId`/`status: RETRY_PENDING`/`attempts: 0`/`maxAttempts: Number.MAX_SAFE_INTEGER`/`nextRetryAt`); `ensureSeeded` both branches (`existsActive` true → `false` no duplicate, false → `true` + create); `tickIntervalMs`/`orphanWatchdogMs` defaults (60000/1800000) when unset; `buildTickLogDetail` default pass-through and a custom projection; success path logs `${logPrefix}.tick.completed` with the detail; failure path routes through `shouldDeadLetter`/`calculateNextRetry(baseMs: 5000)` → `markFailed`; `finally` always calls `scheduleNextTick` on success, failure, and dead-letter; no `require('../../config/constants')` in the factory module.
- [x] 4.2 GREEN: create `src/core/application/createTickJobModule.js` implementing the signature and body from `design.md` (Factory Signature + body section) until 4.1 is fully green.
- [x] 4.3 RED: in `test/composition/productSyncJobModule.test.js`, add an assertion pinning `jobRepository.create.mock.calls[0][0].kind === JOB_KIND.PRODUCT_SYNC` and `.sourceId === 'product-sync-loop'`. Confirm it still passes against the current implementation (documents the literal before rewrite).
- [x] 4.4 GREEN: rewrite `src/composition/productSyncJobModule.js` as a thin wrapper over `createTickJobModule`, preserving guard messages (`createProductSyncJobModule requires jobRepository` / `requires productSyncModule`), the `processProductSyncJob` export name, `_internals.jobPoller`, and the `buildTickLogDetail` projection (`created, updated, failed, skipped, archived, cursorAdvanced`). Run its suite + full `npm test` green before continuing.
- [x] 4.5 RED: same pin in `test/composition/saleOrderStatusSyncJobModule.test.js` (`kind: SALE_ORDER_STATUS_SYNC`, `sourceId: 'sale-order-status-sync-loop'`).
- [x] 4.6 GREEN: rewrite `src/composition/saleOrderStatusSyncJobModule.js` onto the factory, preserving `processSaleOrderStatusSyncJob` export, `run: () => saleOrderStatusSyncModule.runIncremental({})` call shape, and `updated, unmapped, failed, cursorAdvanced` log projection. Full `npm test` green.
- [x] 4.7 RED: same pin in `test/composition/manufacturingOrderRetrySyncJobModule.test.js` (`kind: MANUFACTURING_ORDER_RETRY_SYNC`, `sourceId: 'manufacturing-order-retry-sync-loop'`).
- [x] 4.8 GREEN: rewrite `src/composition/manufacturingOrderRetrySyncJobModule.js` onto the factory, preserving `processManufacturingOrderRetrySyncJob` export, `run: () => manufacturingOrderRetrySyncModule.runOnce({})` call shape, and default pass-through `buildTickLogDetail` (logs the entire `result`). Full `npm test` green.
- [x] 4.9 RED: same pin in `test/composition/partnerSyncJobModule.test.js` (`kind: JOB_KIND.PARTNER_SYNC`, `sourceId: 'partner-sync-loop'`).
- [x] 4.10 GREEN: rewrite `src/composition/partnerSyncJobModule.js` onto the factory, preserving `processPartnerSyncJob` export, `run: () => partnerSyncModule.runIncremental()` call shape (no-arg, not `({})`), and `created, updated, failed, skipped, archived, cursorAdvanced` log projection. Full `npm test` green.
- [x] 4.11 Verify: `rg 'scheduleNextTick|JobPoller\(' src/composition/*SyncJobModule.js` shows no duplicated block outside the factory; `src/server.js:87,129,157,185` still resolves all four historical export names unchanged.

## Final — Documentation

- [ ] 5.1 Update `ARQUITECTURA.md` §11.2: mark #1, #2, #4 resolved (with one-line pointer to the resolving file/commit each); note #3 (`config/constants.js` stage/pipeline literals) and #5 (`PlanDealSyncUseCase` → `ExpandParentIntoChildrenUseCase`) remain open/deferred per the proposal's Success Criteria.
