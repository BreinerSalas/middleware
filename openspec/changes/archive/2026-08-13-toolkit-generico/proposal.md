# Proposal: Toolkit readiness — resolve couplings #1, #2, #4

## Intent

`src/core/` must be vendor-neutral to extract as a toolkit. `ARQUITECTURA.md` §11.2 lists five
couplings blocking that; three are mechanical, need no production-config change, and fit strict TDD.
Success: core leaks no vendor field name or Odoo date helper, the four scheduled tick flows share one
factory instead of copy-paste, and every live flow behaves identically.

## Scope

### In Scope
- **#1** `ProcessSyncJobUseCase.buildWriteBackPayload` (`:111-116`): drop the `{ id_presupuesto_odoo }`
  default; payload becomes caller-supplied. Dead in prod (`dealSyncModule.js:27-36` always injects) and untested today.
- **#2** Move `src/core/shared/odooDate.js` + test to `src/adapters/outbound/odoo/`. Consumers are only
  `composition/` (`product`, `partner`, `saleOrderStatus` sync modules).
- **#4** Extract `createTickJobModule({ kind, seedSourceId, run, tickIntervalMs, orphanWatchdogMs, logPrefix })`
  into `core/application/`; refactor **all four** `*SyncJobModule.js` onto it — `product`,
  `saleOrderStatus`, `manufacturingOrderRetry`, **and `partner`** (4th sibling added after §11.2;
  excluding it leaves the extraction inconsistent).

### Out of Scope
- **#3** `config/constants.js` stage/pipeline literals — 3 copies + 2 call sites bypassing `config.deals`;
  removal can silently break the live Deal→Sale Order flow. Own change, gated on prod env-var verification.
- **#5** `PlanDealSyncUseCase` → `ExpandParentIntoChildrenUseCase` — the one real dependency-rule
  violation, highest blast radius. Own change with `design.md` and parity plan.
- Mongoose per-file model singleton (9 schemas): known debt, not urgent.
- Any feature, config, env-var, or persisted-data change.

## Capabilities

### New Capabilities
- `tick-job-scheduling`: the shared self-rescheduling tick contract (kind isolation, seed source id,
  tick interval, orphan watchdog, retry/dead-letter, per-flow log prefix) all four flows MUST obtain
  from one parameterized factory.
- `core-vendor-neutrality`: `src/core/` MUST NOT hold vendor field names or vendor date formatting;
  write-back payload shape MUST be caller-supplied.

### Modified Capabilities
- None. `specs/partner-sync/spec.md` is unchanged — this is behavior-preserving.

## Approach

Three independent slices, each red→green→refactor via `npm test`.

#1: add the missing test pinning today's default first, then invert it, leaving `dealSyncModule` the
sole owner of `id_presupuesto_odoo`.

#2: pure move plus three import-path updates; no logic edit.

#4: the factory absorbs the identical body (`scheduleNextTick`, `process*Job`, `ensureSeeded`,
`JobPoller` construction, `startWorker`/`stopWorker`/`_internals`). Each module collapses to a thin
wrapper supplying its `kind`, `seedSourceId`, `run` shape (`runIncremental({includeNoSku})` /
`runIncremental({})` / `runOnce({})` / `runIncremental()`), and log prefix — and **re-aliasing its
historical named export** (`processProductSyncJob`, …), which `src/server.js` and the existing suites
depend on.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `core/application/use-cases/ProcessSyncJobUseCase.js` | Modified | Vendor default removed |
| `core/shared/odooDate.js` → `adapters/outbound/odoo/` | Moved | Out of core |
| `composition/{product,partner,saleOrderStatus}SyncModule.js` | Modified | Import path only |
| `core/application/createTickJobModule.js` | New | Tick-job factory |
| `composition/*SyncJobModule.js` (4) | Modified | Thin wrappers; names preserved |
| `test/core/shared/odooDate.test.js` → `test/adapters/outbound/odoo/` | Moved | Follows source |
| `test/core/application/createTickJobModule.test.js` | New | Direct factory coverage |
| `ProcessSyncJobUseCase.test.js`, `test/composition/*SyncJobModule.test.js` (4) | Modified | Stay green; pin names/log fields |
| `ARQUITECTURA.md` §11.2 | Modified | #1/#2/#4 resolved; #4 is four files |

**Size (review workload)**: 1 new source file, ~8 modified, 2 moved, 1 new test. Against the agreed
**800-line** budget: **risk Medium** — sliceable into three chained PRs (#1, #2, #4).

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Named-export drift breaks `server.js` + 4 suites | Medium | Wrappers re-alias; existing suites gate |
| Log prefix / logged-field drift hurts ops visibility | Medium | Explicit factory params, asserted per flow |
| Tick interval or watchdog default silently shifts | Medium | Re-assert 60s / 30min per flow before refactor |
| Write-back default removal breaks an unknown caller | Low | Zero coverage today → pin, then invert |
| `odooDate` move exposes a hidden `core/` consumer | Low | Consumer set grep-verified; suite confirms |

## Rollback Plan

Pure refactor: no schema, config, env-var, or data change; nothing to migrate. `git revert` of the
merge restores prior behavior with zero operational steps. Slices are independent, so reverting the
factory alone returns the four modules to copy-paste form while #1/#2 stay resolved. Work is on
`feature/toolkit-generico`; `main` untouched.

## Dependencies

None external. No prod env-var or infra check required — that is precisely why #3 is deferred.

## Success Criteria

- [ ] No `src/core/` file references `id_presupuesto_odoo` or any vendor-specific field/date helper.
- [ ] All four `*SyncJobModule.js` delegate to `createTickJobModule`; no duplicated
      `scheduleNextTick`/`ensureSeeded`/`JobPoller` block remains.
- [ ] `createTickJobModule` has direct unit tests: kind isolation, tick scheduling, watchdog,
      failure→dead-letter, `finally`-always-reschedule.
- [ ] `npm test` green with no test deleted to pass; every change arrived red→green.
- [ ] Job kinds, seed source ids, 60s interval, 30min watchdog, retry/backoff, and logged fields
      unchanged per flow.
- [ ] `ARQUITECTURA.md` §11.2 updated: #1/#2/#4 resolved, #3/#5 open with deferral reasons.
