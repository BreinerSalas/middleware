# Design: Toolkit readiness — couplings #1, #2, #4

## Technical Approach

Three file-disjoint slices. **#1** turns a silent vendor default into a constructor precondition on
`ProcessSyncJobUseCase`. **#2** is a pure file move. **#4** extracts `createTickJobModule` into
`src/core/application/` and collapses the four `*SyncJobModule.js` files into thin wrappers that keep
their historical named exports. No config, schema, env-var, or persisted-data change.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|----------|----------------------|-----------|
| 1 | Guard `retryPolicy.buildWriteBackPayload` in the **constructor**, plain `Error`, message `ProcessSyncJobUseCase requires retryPolicy.buildWriteBackPayload` | (a) `AppError` with `code: 'WRITEBACK_BUILDER_MISSING'` thrown from `buildWriteBackPayload`; (b) `transient:false` error → straight dead-letter | The constructor already has 5 identical `requires x` guards — this is the file's own pattern. Throwing at call time fails *after* the Odoo sale order and mapping are already committed, dead-lettering a real webhook deal; the constructor fails at boot, before any job is consumed |
| 2 | `buildWriteBackPayload(mapping)` method body reduces to `return this.retryPolicy.buildWriteBackPayload(mapping)` (no `typeof` branch) | Keep the branch and throw in the `else` | The constructor guarantees the function exists; a second check would be unreachable code |
| 3 | Per-flow success logging via injected `buildTickLogDetail(result)`, **default `(result) => result`** | Always log the full result object (exploration's suggestion) | Pass-through *is* `manufacturingOrderRetry`'s current behavior, so the default is a real flow's contract, not a fallback. The other three inject explicit field projections, so no flow's log shape drifts |
| 4 | Dependency guards stay in each **wrapper**, not threaded into the factory | `createTickJobModule({ factoryName, requires: {...} })` | Existing suites assert `.toThrow(/jobRepository/)` and `.toThrow(/productSyncModule/)` on messages naming the *wrapper* factory. Local guards keep those bytes exact with zero naming metadata in core |
| 5 | Wrapper re-aliases explicitly (`processProductSyncJob: tick.processTickJob`), never spreads the factory result | `return { ...tick, processProductSyncJob: tick.processTickJob }` | Spreading leaks `processTickJob` into four public surfaces and makes the surface implicit |
| 6 | Factory takes `kind` as a **parameter** and must not `require('../../config/constants')` | Import `JOB_KIND` in core and select by key | `JOB_KIND` holds this integration's vendor kinds; importing it would recreate the coupling the slice removes |
| 7 | `config` stays a pass-through param; factory keeps `(config.worker && config.worker.pollIntervalMs) \|\| 5000` and `(config.retry && config.retry.maxDelayMs) \|\| 300000` verbatim | Explode into `pollIntervalMs` / `retryMaxDelayMs` params | Behaviour-preserving is the hard constraint; identical expressions are trivially reviewable against the four originals |
| 8 | `_internals: { jobPoller }` preserved on all four wrappers although no test or consumer reads it | Drop it | Out-of-scope surface reduction; `src/app.js` reads `dealSyncModule._internals`, so the idiom is live in the repo |

## Factory Signature

`src/core/application/createTickJobModule.js`:

```js
function createTickJobModule({
  kind,                                  // required — opaque string, no JOB_KIND import
  seedSourceId,                          // required — exact live sourceId string
  run,                                   // required — async () => result
  config = {},
  logger = null,
  jobRepository,                         // required
  jobPoller = null,
  logPrefix,                             // required — e.g. 'product-sync-job'
  buildTickLogDetail = (result) => result,
  tickIntervalMs = 60 * 1000,
  orphanWatchdogMs = 30 * 60 * 1000,
  clock = () => Date.now()
} = {})
// -> { processTickJob, ensureSeeded, startWorker, stopWorker, _internals: { jobPoller } }
```

Body is the four modules' shared body verbatim: `scheduleNextTick` (create with `status:
RETRY_PENDING`, `attempts: 0`, `maxAttempts: Number.MAX_SAFE_INTEGER`, `nextRetryAt: new Date(now +
tickIntervalMs)`), `processTickJob` (`markCompleted` + `log('info', \`${logPrefix}.tick.completed\`,
buildTickLogDetail(result))`; on throw `shouldDeadLetter`/`calculateNextRetry(baseMs: 5000)` +
`markFailed`; `finally` always `scheduleNextTick(now)`), `ensureSeeded` (`existsActive({ kind })`),
and the `JobPoller` construction (`concurrency: 1`, `recoverOrphansOnStart: true`).

## Per-Flow Parameter Matrix (byte-identical to production today)

| Wrapper | `kind` | `seedSourceId` | `logPrefix` | `run` | `buildTickLogDetail` |
|---|---|---|---|---|---|
| `productSyncJobModule` | `JOB_KIND.PRODUCT_SYNC` (`'product_sync'`) | `'product-sync-loop'` | `'product-sync-job'` | `() => productSyncModule.runIncremental({ includeNoSku })` | `created, updated, failed, skipped, archived, cursorAdvanced` |
| `saleOrderStatusSyncJobModule` | `SALE_ORDER_STATUS_SYNC` (`'sale_order_status_sync'`) | `'sale-order-status-sync-loop'` | `'sale-order-status-sync-job'` | `() => saleOrderStatusSyncModule.runIncremental({})` | `updated, unmapped, failed, cursorAdvanced` |
| `manufacturingOrderRetrySyncJobModule` | `MANUFACTURING_ORDER_RETRY_SYNC` | `'manufacturing-order-retry-sync-loop'` | `'manufacturing-order-retry-sync-job'` | `() => manufacturingOrderRetrySyncModule.runOnce({})` | *default pass-through* |
| `partnerSyncJobModule` | `JOB_KIND.PARTNER_SYNC` (`'partner_sync'`) | `'partner-sync-loop'` | `'partner-sync-job'` | `() => partnerSyncModule.runIncremental()` | `created, updated, failed, skipped, archived, cursorAdvanced` |

`run` call shapes are reproduced literally (`({})` vs `()` vs `({ includeNoSku })`) — not normalised.
`kind` + `seedSourceId` are the **no-migration contract**: in-flight Mongo jobs keep matching
`existsActive({ kind })` and the seeded `sourceId`. Each of the four suites MUST gain one assertion
pinning both literals from `jobRepository.create.mock.calls[0][0]` (`kind` and `sourceId`), so a
typo is a red test, not a stalled live loop.

## Wrapper Shape (all four identical apart from the matrix row)

```js
function createProductSyncJobModule({ config = {}, logger = null, jobRepository, productSyncModule,
  jobPoller = null, includeNoSku = false, tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  orphanWatchdogMs = DEFAULT_ORPHAN_WATCHDOG_MS, clock = () => Date.now() } = {}) {
  if (!jobRepository) throw new Error('createProductSyncJobModule requires jobRepository')
  if (!productSyncModule) throw new Error('createProductSyncJobModule requires productSyncModule')
  const tick = createTickJobModule({
    kind: JOB_KIND.PRODUCT_SYNC, seedSourceId: SEED_SOURCE_ID, logPrefix: 'product-sync-job',
    run: () => productSyncModule.runIncremental({ includeNoSku }),
    buildTickLogDetail: (r) => ({ created: r.created, updated: r.updated, failed: r.failed,
      skipped: r.skipped, archived: r.archived, cursorAdvanced: r.cursorAdvanced }),
    config, logger, jobRepository, jobPoller, tickIntervalMs, orphanWatchdogMs, clock
  })
  return {
    processProductSyncJob: tick.processTickJob,
    ensureSeeded: tick.ensureSeeded,
    startWorker: tick.startWorker,
    stopWorker: tick.stopWorker,
    _internals: tick._internals
  }
}
```

Signature, guard messages, defaults, and export name are unchanged, so `src/server.js:87,129,157,185`
and all four suites compile untouched.

## `ProcessSyncJobUseCase` Contract Change

Injection point is unchanged — `dealSyncModule.js:114-127` already passes
`retryPolicy.buildWriteBackPayload` (defined at `dealSyncModule.js:27-36`, sole owner of
`id_presupuesto_odoo` and `numero_orden_fabricacion`). What changes is that omission is now fatal:

```js
if (typeof retryPolicy.buildWriteBackPayload !== 'function') {
  throw new Error('ProcessSyncJobUseCase requires retryPolicy.buildWriteBackPayload')
}
```

**Blast radius the exploration missed**: 12 test constructions omit the builder
(`test/application/use-cases.test.js` ×11, `test/core/application/ProcessSyncJobUseCase.test.js:66` ×1 —
its sibling construction at line 47 already supplies `buildWriteBackPayload` and needs no change), and
5 of them reach `writeBack` (`use-cases.test.js:170,185,199,224` plus
`ProcessSyncJobUseCase.test.js:66`, which runs `execute()` to full success on default mocks). Each of
the 12 needs `buildWriteBackPayload: (m) => ({ ref: m.targetRef })` (or similar vendor-free stub) added
to its `retryPolicy`. This is a contract change, not test-fixing-to-pass, so it is written RED first.

## Data Flow

    JobPoller(kind)  ──→  tick.processTickJob(job)
                                │  run()  ──→  <flow>SyncModule.run{Incremental,Once}
                                │
                        markCompleted ──→ log(`${logPrefix}.tick.completed`, buildTickLogDetail(result))
                                │   └─ throw ──→ shouldDeadLetter/calculateNextRetry ──→ markFailed
                                ▼
                        finally → scheduleNextTick(now)  ──→ jobRepository.create({ seedSourceId, kind })

## File Changes

| File | Action | Slice |
|------|--------|-------|
| `src/core/application/use-cases/ProcessSyncJobUseCase.js` | Modify — add guard, drop default branch (`:111-116`) | #1 |
| `test/application/use-cases.test.js`, `test/core/application/ProcessSyncJobUseCase.test.js` | Modify — inject builder in 13 constructions; add missing-builder RED test | #1 |
| `src/core/shared/odooDate.js` → `src/adapters/outbound/odoo/odooDate.js` | Move | #2 |
| `test/core/shared/odooDate.test.js` → `test/adapters/outbound/odoo/odooDate.test.js` | Move (+ require path) | #2 |
| `src/composition/{product,saleOrderStatus,partner}SyncModule.js` | Modify — one require line each | #2 |
| `src/core/application/createTickJobModule.js` | Create | #4 |
| `test/core/application/createTickJobModule.test.js` | Create | #4 |
| `src/composition/{product,saleOrderStatus,manufacturingOrderRetry,partner}SyncJobModule.js` | Modify — thin wrappers | #4 |
| `test/composition/*JobModule.test.js` (4) | Modify — add `kind`/`sourceId` seed pins | #4 |
| `ARQUITECTURA.md` §11.2 (+ rows `:212`, `:214`, `:128`) | Modify | all |

## TDD Sequencing

**Slice #1** (independent, no dependency on #2/#4)
1. RED: new test — `new ProcessSyncJobUseCase({...no buildWriteBackPayload})` throws
   `/requires retryPolicy.buildWriteBackPayload/`. Fails: today it constructs fine.
2. RED: pin the default first — assert `writeBack` receives `{ id_presupuesto_odoo: 'S00001' }` with
   no builder injected (green today, documents what is being removed).
3. GREEN: add the constructor guard; simplify `buildWriteBackPayload`; delete the pinning test from
   step 2 in the same commit (it asserts the removed behaviour — record the inversion in the message).
4. GREEN: add `buildWriteBackPayload` to the 13 test constructions until `npm test` is green.

**Slice #2** (independent)
1. RED: move `test/core/shared/odooDate.test.js` → `test/adapters/outbound/odoo/odooDate.test.js`
   pointing at `../../../../src/adapters/outbound/odoo/odooDate.js`. Fails: module not found.
2. GREEN: `git mv` the source file; update the three `composition/*SyncModule.js` requires.
3. Verify `rg 'core/shared/odooDate'` returns zero hits.

**Slice #4** (factory first, then one caller at a time)
1. RED: `test/core/application/createTickJobModule.test.js` — required-param guards, seed doc shape
   (`kind`/`sourceId`/`status`/`nextRetryAt`/`maxAttempts`), `ensureSeeded` both branches,
   `buildTickLogDetail` default pass-through **and** projection, failure → retry vs dead-letter,
   `finally`-always-reschedule, and no `config/constants` import.
2. GREEN: create `createTickJobModule.js`.
3. Then, **once per flow in this order** — `product`, `saleOrderStatus`,
   `manufacturingOrderRetry`, `partner` — RED: add the `kind`/`sourceId` seed pin to that flow's
   suite; GREEN: rewrite that one wrapper onto the factory; full `npm test` green before the next
   flow. Four independently revertable commits.

## Rollback Boundary

Verified file-disjoint: #1 touches only `ProcessSyncJobUseCase.js` + 2 test files; #2 touches
`odooDate` + the three `*SyncModule.js` (**not** the `*SyncJobModule.js`); #4 touches the factory +
the four `*SyncJobModule.js` + their suites. No file appears in two slices, and the factory never
imports `odooDate`, so `git revert` of any one slice leaves the other two intact. Within #4, each
wrapper commit is also independently revertable while the factory stays. The proposal's Rollback Plan
holds unmodified.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | `createTickJobModule` | Fake `jobRepository`/`jobPoller`/`clock`; assert seed doc fields, both `ensureSeeded` branches, log detail projection vs pass-through, retry/dead-letter, `finally` reschedule |
| Unit | `ProcessSyncJobUseCase` constructor | Missing-builder throw; injected builder still reaches `writeBack` unchanged |
| Unit | `odooDate` | Existing 4 cases pass verbatim from the new path |
| Regression | 4 job-module suites | Unchanged assertions must pass; **plus** new exact `kind`/`sourceId` pins |
| Regression | Whole suite | `npm test` green after every commit; zero test deleted except step #1.3's deliberate inversion |
| Grep gate | Core neutrality | `rg 'id_presupuesto_odoo\|odooDate\|JOB_KIND' src/core/` returns zero hits |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. Pure in-process refactor; no new I/O.

## Migration / Rollout

No migration. In-flight Mongo jobs are unaffected because `kind` and `seedSourceId` are reproduced
literally and pinned by test (see the parameter matrix). No env var, no schema, no feature flag.

## Open Questions

- [ ] None blocking. `saleOrderStatusSyncModule.runIncremental({})` vs `partnerSyncModule
      .runIncremental()` is preserved literally rather than normalised — worth a follow-up cleanup
      once both modules' default params are confirmed equivalent, out of scope here.
