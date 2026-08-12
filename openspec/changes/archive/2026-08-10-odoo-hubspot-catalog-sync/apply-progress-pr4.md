# PR 4 — Sync Module + Tick Job + Wiring + Docs (FINAL)

> Phase 4 of `odoo-hubspot-catalog-sync`. Strict TDD: RED tests for `partnerSyncModule`
> and `partnerSyncJobModule` were confirmed failing (module not found) before the
> corresponding GREEN implementation went in. All config/constants/server.js edits are
> pure additive insertions — no existing block for another flow was touched.

## TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR |
|---|---|---|---|
| 4.1/4.2 `partnerSyncModule` | `test/composition/partnerSyncModule.test.js` (9 tests) + `.incremental.test.js` (10 tests) written first; run failed with `Cannot find module '../../src/composition/partnerSyncModule.js'` | Created `src/composition/partnerSyncModule.js`; all 19 tests pass | None needed — matched `productSyncModule.js` shape on first pass |
| 4.3/4.4 `partnerSyncJobModule` | `test/composition/partnerSyncJobModule.test.js` (8 tests) written first; run failed with `Cannot find module '../../src/composition/partnerSyncJobModule.js'` | Created `src/composition/partnerSyncJobModule.js`; all 8 tests pass | None needed — byte-shape copy of `productSyncJobModule.js` |

Full RED confirmation command/output and GREEN confirmation command/output are in the
Work Unit Evidence table below.

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and result | `npx vitest run test/composition/partnerSyncModule.test.js test/composition/partnerSyncModule.incremental.test.js test/composition/partnerSyncJobModule.test.js` — RED: 3 files failed (module not found). GREEN (after implementation): 3 files passed, 27/27 tests. |
| Runtime harness command/scenario and result | `node scripts/probes/partner-sync.probe.js` wiring smoke-tested via an ad hoc script that spins up `mongodb-memory-server`, sets `ODOO_CLIENT_MODE=stub`, calls `buildClients()` then `source.count()` and `mod.runOnce({ dryRun: true, limit: 5 })`. Result: `countPartners (stub mode) = 0`, `runOnce dryRun result length = 0`, exits `SMOKE OK` — matches stub-mode contract (`0`/`[]`) from the design. Temporary smoke script was deleted after the run; the committed probe file itself is unchanged by this verification step. |
| Rollback boundary | `PARTNER_SYNC_JOB_ENABLED=false` (the shipped default) fully disables the tick with zero code changes. Full revert: delete `src/composition/partnerSyncModule.js`, `partnerSyncJobModule.js`, `scripts/probes/partner-sync.probe.js`; remove the `partnerSync` block from `config/index.js` and the `PARTNER_SYNC` member from `constants.js`; remove the one `if (cfg.partnerSync...)` block plus 3 additive one-line calls in `server.js`. No other flow's file needs touching. |

## Files created

| Path | Role |
|---|---|
| `src/composition/partnerSyncModule.js` | `createPartnerSyncModule({ config, odooSource, hubspotGateway, logger, concurrency, chunkSize, mappingRepo, runRepo, cursorRepo })` → `{ runOnce, runIncremental, syncOneItem }`. Simpler than `productSyncModule`: no `partition()` — every partner has an id, so `runOnce`/`runIncremental` always route through `hubspotGateway.batchUpsertByOdooIds`. `syncOneItem` is only exercised on the dry-run path (per design). Correlates batch results back to source partners via `item.properties[idProperty]` (mirrors product's `hs_sku` correlation via `skuToOdooIds`). `runIncremental`: `maxSeenMs` tracked from `write_date`, `active === false` rows counted as `archived` and excluded, mappings persisted only when `!batchFailed`, cursor advances only when `failed === 0 && !batchFailed` via `cursorRepo.set(key, formatOdooDateUtc(maxSeenMs - overlapMs))`. |
| `src/composition/partnerSyncJobModule.js` | `createPartnerSyncJobModule({ config, logger, jobRepository, partnerSyncModule, jobPoller, tickIntervalMs, orphanWatchdogMs, clock })` → `{ processPartnerSyncJob, ensureSeeded, startWorker, stopWorker, _internals }`. Byte-for-byte shape of `productSyncJobModule.js`: `SEED_SOURCE_ID = 'partner-sync-loop'`, `JOB_KIND.PARTNER_SYNC`, `maxAttempts: Number.MAX_SAFE_INTEGER`, poller `concurrency: 1`, `recoverOrphansOnStart: true`, self-rescheduling in `finally` on both success and throw. |
| `scripts/probes/partner-sync.probe.js` | Throttled-backfill probe mirroring `scripts/sync-products.js`'s CLI shape (`--limit`, `--dry-run`, `--interval`, `--once`, reuses `parseArgs`/`resolveIntervalMs`/`shouldRunOnce` from `scripts/sync-products.lib.js`). Prints `countPartners()` before running so an operator can size the backfill before removing `--limit`. `--help` output embeds the pre-production checklist (dry-run first, size the backfill, verify `res.partner.type`, only then flip `PARTNER_SYNC_JOB_ENABLED`). |
| `test/composition/partnerSyncModule.test.js` | 9 tests: constructor guards, `runOnce` batch dispatch (no partition), `limit` passthrough, `dryRun` (zero gateway calls, per-partner dry-run entries via `syncOneItem`), created/failed counting from batch results and errors, `syncOneItem` delegation both dry-run and real. |
| `test/composition/partnerSyncModule.incremental.test.js` | 10 tests: `cursorRepo` required, default far-past watermark, watermark passthrough, multi-page batch dispatch, cursor advances on zero failures (`overlapMs` subtracted), cursor holds on any failure, archived (`active:false`) rows excluded and counted, mapping persistence via `bulkUpsertMany`, mappings NOT persisted when the batch call throws, run start/complete via `runRepo` including the `archived` counter. |
| `test/composition/partnerSyncJobModule.test.js` | 8 tests: constructor guards, tick success → `markCompleted` + reschedule, tick throw → `markFailed` (retry) + reschedule, dead-letter path at `maxAttempts`, `ensureSeeded` (seeds vs. no-op when already active), `startWorker`/`stopWorker` lifecycle. |

## Files modified (all pure additive insertions)

| Path | Diff | What changed |
|---|---|---|
| `src/config/constants.js` | +1 line | Added `PARTNER_SYNC: 'partner_sync'` to the `JOB_KIND` enum. Zero existing members touched. |
| `src/config/index.js` | +11 lines | Added `PARTNER_SYNC_JOB_ENABLED`, `PARTNER_SYNC_TICK_INTERVAL_MS`, `PARTNER_SYNC_ORPHAN_WATCHDOG_MS`, `PARTNER_SYNC_PAGE_SIZE`, `HS_PROPERTY_ODOO_PARTNER_ID` to `OPTIONAL_KEYS`; added `hubspot.propertyOdooPartnerId` (default `id_contacto_odoo`); added the new `partnerSync` config block after `manufacturingOrderRetrySync`. Zero existing keys/blocks touched. |
| `src/server.js` | +33/-1 lines | Added 6 new `require`s (`OdooPartnerSource`, `HubspotContactGateway`, `createPartnerSyncModule`, `createPartnerSyncJobModule`, `MongoPartnerMappingRepository`, `MongoPartnerSyncRunRepository`); added a new `if (cfg.partnerSync && cfg.partnerSync.jobEnabled)` conditional block (mirrors the `productSync` block exactly) before `staticRoot`; added `if (partnerSyncJobModule) await partnerSyncJobModule.startWorker()` after the MO-retry line; added the mirrored `stopWorker()` line in `shutdown`; expanded the final `return {...}` to a multi-line object including `partnerSyncJobModule`. Zero lines inside the existing `productSync`/`saleOrderStatusSync`/`manufacturingOrderRetrySync` blocks touched — confirmed by re-reading each block after the edit. The `contactPropertyDefinitions` provisioning call was already wired in PR2 (this PR does not touch it again). |

## Files NOT touched (isolation confirmed via `git status`)

- `src/composition/productSyncModule.js`, `productSyncJobModule.js`
- `src/composition/saleOrderStatusSyncJobModule.js`, `saleOrderStatusSyncModule.js`
- `src/composition/manufacturingOrderRetrySyncJobModule.js`, `manufacturingOrderRetrySyncModule.js`
- `src/core/application/JobPoller.js`, `src/core/domain/{SyncJob,RetryPolicy}.js`
- `src/adapters/outbound/mongo/MongoSyncCursorRepository.js`, `MongoJobRepository.js`
- All PR1/PR2/PR3 files (`OdooPartnerSource.js`, `odooApiClient.js`'s partner methods,
  `HubspotContactGateway.js`, `partnerToContactMapper.js`, `hubspotApiClient.js`'s contact
  methods, `contactPropertyDefinitions.js`, `PartnerMapping.js`,
  `MongoPartnerMappingRepository.js`, `MongoPartnerSyncRunRepository.js`) — reused as-is,
  zero further edits in PR4.

## Docs updated

| Path | What changed |
|---|---|
| `ARQUITECTURA.md` §11.3 | Added a "Caso de referencia — `partner-sync`" paragraph after the 10-point checklist, mapping each checklist point to the concrete file that implements it, noting the flow has no `SourceGateway`/`writeBack` (one-directional, Odoo always wins), and repeating the pre-production checklist (dry-run + size backfill + verify `res.partner.type`). |
| `README.md` | Added 5 rows to the "Opcionales" env var table (`PARTNER_SYNC_JOB_ENABLED`, `PARTNER_SYNC_TICK_INTERVAL_MS`, `PARTNER_SYNC_ORPHAN_WATCHDOG_MS`, `PARTNER_SYNC_PAGE_SIZE`, `HS_PROPERTY_ODOO_PARTNER_ID`) plus a "Rollout de `partner-sync`" callout box with the same pre-production checklist. |
| `openspec/changes/odoo-hubspot-catalog-sync/proposal.md` | Checked off all 5 Success Criteria with a one-line pointer to the implementing code/tests; added an "Implementation Complete (PR1–PR4)" section with final test counts and the same 3-item pre-production checklist, cross-referenced from the Risks table. |
| `openspec/changes/odoo-hubspot-catalog-sync/tasks.md` | Marked tasks 4.1–4.11 `[x]`. All 4 phases (1–4) now fully complete. |

## Test counts

| Scope | Before PR 4 | After PR 4 |
|---|---|---|
| Test files | 89 | 92 (+3) |
| Tests passing | 930 | 957 (+27) |
| Failing | 0 | 0 |

Breakdown of the +27 new tests:
- `partnerSyncModule.test.js`: 9
- `partnerSyncModule.incremental.test.js`: 10
- `partnerSyncJobModule.test.js`: 8

Full suite (`npm test` → `vitest run`) green in ~10-11s, 92 test files total.

## Deviations from design.md / tasks.md wording

1. **Batch-result correlation uses `item.properties[idProperty]`, not a separate lookup call.** `design.md` doesn't spell out exactly how `runBatchForOdooItems`'s equivalent correlates HubSpot batch-upsert results back to source records. I mirrored `productSyncModule`'s `skuToOdooIds` pattern exactly, substituting the Odoo-id property (`id_contacto_odoo`) for `hs_sku`: build a `Map<String(partner.id), partner>`, then match each result/error by reading `item.properties[idProperty]` / `errItem.id`. This assumes HubSpot's batch-upsert response echoes back the `idProperty` value in `properties`, which is the same assumption the already-shipped, already-tested product flow makes for `hs_sku`.
2. **`persistMappings` drops the `hsSku`-equivalent field entirely** (there is no odoo-side unique-per-item string like a SKU to store beyond the id itself) — the mapping payload is just `{ odooId, hubspotId, action }`, letting `MongoPartnerMappingRepository.bulkUpsertMany` derive `odooPartnerId` internally (already implemented that way in PR3).
3. **No `includeNoSku`-equivalent flag anywhere** — confirmed no-op needed since partner-sync has no partition axis at all (every partner has an id by construction of the Odoo domain filter).
4. **`scripts/probes/partner-sync.probe.js` location/naming**: tasks.md explicitly names this path (`scripts/probes/partner-sync.probe.js`), which is a "runnable script" living in the `scripts/probes/` directory used for read-only staging diagnostics elsewhere in the repo (e.g. `product-image-readiness.js`). Functionally this probe is closer to `scripts/sync-products.js` (it performs write operations against HubSpot when `--dry-run` is omitted) than to the read-only probes in that directory. I kept it exactly where tasks.md/design.md specified and documented the write-capability prominently in its `--help` text and in both README.md and ARQUITECTURA.md, so no operator mistakes it for a read-only check.
5. **No dedicated automated test for the probe script itself** — matches the existing convention: `scripts/sync-products.js` (the pattern this probe mirrors) has no direct test file either; only its shared `.lib.js` helpers (`parseArgs`, `resolveIntervalMs`, `shouldRunOnce`) are unit-tested, and the probe reuses those exact helpers unmodified. Verified the probe's wiring instead via a one-off runtime smoke test (see Work Unit Evidence row 2) using `mongodb-memory-server` + Odoo `stub` mode, then deleted the temporary smoke script.

## Risks / open items carried into production rollout

- **`res.partner.type='contact'` filter constant** (open since PR1, still unresolved — no live Odoo access in this environment): isolated as `PARTNER_CONTACT_TYPE` in `odooApiClient.js` with an inline validation comment. If the live instance uses `type='private'` for individual child partners instead of `'contact'`, this is a 1-line fix (`['type', 'in', ['contact', 'private']]`). Documented in `proposal.md`'s new "Implementation Complete" checklist, `README.md`'s rollout callout, and `ARQUITECTURA.md` §11.3.
- **Backfill volume unknown** — `countPartners()` must be measured against the live instance before the first real `runOnce`; the probe script prints this automatically. No throttling safeguard beyond `--limit` exists yet inside the module itself (matches the equivalent product-sync operational practice — throttling is operator-driven via the script, not enforced in code).
- **`splitName` heuristic** (open since PR2) — untested against real Latin American name data; flagged again here as a live-instance verification item, not blocking.
- **Fourth `*SyncJobModule.js` near-duplicate** — accepted debt per design decision 6 and ARQUITECTURA §11.2 point 4; `partnerSyncJobModule.js` is now the fourth copy. A `createTickJobModule` extraction remains explicitly out of scope for this change.

## Next steps

None remaining for this change — all 4 phases / 11 Phase-4 tasks are complete. Recommended
next SDD phase: `sdd-verify`.
