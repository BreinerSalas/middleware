# Exploration: Odoo → HubSpot master data sync (products + contacts/partners), scheduled job

## Current State

Hexagonal architecture (`core` / `adapters` / `composition`), CommonJS, no TypeScript, four flows already coexisting in one process per `ARQUITECTURA.md`.

**Scheduling infrastructure already exists — it is not new work.** There is no cron library and no external queue. The existing pattern (`src/composition/productSyncJobModule.js`, `saleOrderStatusSyncJobModule.js`, `manufacturingOrderRetrySyncJobModule.js`) seeds one self-rescheduling MongoDB job per flow (`kind`, `RETRY_PENDING`, `maxAttempts: MAX_SAFE_INTEGER`) run through a `JobPoller` (concurrency 1, own `kind`, own orphan watchdog); each tick reschedules itself in `finally`, so the schedule survives restarts and lives in Mongo, not memory.

**Important finding: Product sync (Odoo → HubSpot) already exists.** The task framed "products and contacts" as new scope, but products are already implemented end to end:
- `src/adapters/outbound/odoo/OdooProductSource.js` — paginated `listAll`/`count` and an async-generator `listChangedSince({writeDateGte})` cursor pattern (OR'ing `product_tmpl_id.write_date` since name/price live on `product.template`).
- `src/adapters/outbound/hubspot/HubspotProductGateway.js` + `hubspotApiClient.js` — upsert by `hs_sku` (individual search+create/update, or `batchUpsertProducts` with `idProperty: hs_sku`, chunked 100/req).
- `src/composition/productSyncModule.js` (+ `productSyncJobModule.js`) + `MongoProductMappingRepository`/`ProductMapping` domain entity (`odooId <-> hsSku <-> hubspotId`) + `MongoSyncCursorRepository`.

**Contacts/partners (res.partner → HubSpot) sync does NOT exist.**
- `odooApiClient.js` has only `readPartnerCountries(ids)` — a targeted read by known ids (used for `country_expense` resolution in the deal flow). There is no `countPartners`/`searchPartnersAll`/`searchPartnersChangedSince` in either `stub` or `http` mode.
- `hubspotApiClient.js` has no contact or company object methods (no create/update/batch-upsert for `crm/v3/objects/contacts` or `.../companies`); `getDealAssociations` only enriches a specific deal, it doesn't list/sync contacts generally.
- No `PartnerMapping` domain, no partner Mongo repo/schema, no `partnerSyncModule.js`/`partnerSyncJobModule.js`, no `JOB_KIND.PARTNER_SYNC`.
- Every existing plan doc under `docs/*.md` references `res.partner` only for `country_expense` resolution, never a contacts-sync feature.

**Idempotency / error-handling patterns to reuse (generic, in `core/`):** `RetryPolicy.js` (pure backoff+jitter, `isRetryableError`, `shouldDeadLetter`), `SyncJob.js` state machine, and the `SkipSyncError`/`TransientSyncError` taxonomy in `errors.js` — described in ARQUITECTURA.md §11 as the most valuable abstraction in the repo. Odoo RPC errors arrive as HTTP 200 and are classified by exception name (`classifyOdooError` in `odooApiClient.js`), not HTTP status. HubSpot 429s are centrally handled in `hubspotApiClient.js`'s `requestWithRateLimit` (reads `Retry-After`, pauses a shared token-bucket limiter) — new contact/company calls should go through this same function. The cursor pattern only advances the watermark when `failed === 0` for the whole page loop, with a 60s overlap for clock-skew safety.

`ARQUITECTURA.md` §11.3 contains an explicit "checklist for a new integration" (source client + stub mode, SourceGateway, TargetGateway, pure mapper, validators, schema defs for auto-provisioning, `xSyncModule.js`, tick job module, readiness probes, centralized config) that maps directly onto what a partner sync needs.

**Pre-existing, documented toolkit debt** (ARQUITECTURA.md §11.2, not caused by this exploration): the three `*SyncJobModule.js` files are ~90 near-identical lines each; a `createTickJobModule({kind, run, tickIntervalMs, ...})` factory is flagged as the most obvious missing toolkit piece. A partner sync built the same way would be a 4th near-duplicate.

## Affected Areas
- `src/adapters/outbound/odoo/odooApiClient.js` — add `countPartners`/`searchPartnersAll`/`searchPartnersChangedSince` (stub + http, per repo convention both are mandatory).
- `src/adapters/outbound/odoo/OdooPartnerSource.js` (new) — mirrors `OdooProductSource.js`.
- `src/adapters/outbound/hubspot/hubspotApiClient.js` — add contacts/companies CRUD + batch upsert via `requestWithRateLimit`.
- `src/adapters/outbound/hubspot/HubspotContactGateway.js` (new) — mirrors `HubspotProductGateway.js`; must route contact vs company by `res.partner.is_company`.
- `src/core/domain/PartnerMapping.js` (new) — mirrors `ProductMapping.js`.
- `src/adapters/outbound/mongo/MongoPartnerMappingRepository.js` + `schemas/partnerMapping.schema.js` (new).
- `src/adapters/outbound/mongo/MongoSyncCursorRepository.js` — reused as-is, new cursor key.
- `src/composition/partnerSyncModule.js` + `partnerSyncJobModule.js` (new) — mirrors the product-sync pair.
- `src/config/constants.js` — new `JOB_KIND.PARTNER_SYNC`.
- `src/config/index.js` + `src/server.js` — new config block/env vars + conditional wiring, mirrors `productSync`.
- `src/composition/provisionProperties.js` + new `contactPropertyDefinitions.js` — provision the idempotency-key custom property on HubSpot at boot.
- `test/composition/partnerSyncModule*.test.js`, `partnerSyncJobModule.test.js` + new adapter unit tests.
- `ARQUITECTURA.md`, `README.md`, a new `docs/plan-*.md` + TDD evidence doc.

## Approaches

1. **Copy the existing product-sync pattern for partners** (own `OdooPartnerSource`, `HubspotContactGateway`, `PartnerMapping`, `partnerSyncModule`/`partnerSyncJobModule`, own `JOB_KIND`/cursor) per the ARQUITECTURA §11.3 checklist.
   - Pros: consistent with 3 existing flows, low regression risk, easy to review/test in isolation.
   - Cons: adds a 4th near-duplicate `*SyncJobModule.js`, worsening documented debt.
   - Effort: Medium.
2. **Extract `createTickJobModule` first, then build partner+product sync on it.**
   - Pros: fixes documented debt, cleanest long-term shape.
   - Cons: touches 3 already-shipped production tick modules — real regression risk; delays the actual feature; much bigger review surface.
   - Effort: High.
3. **One combined "catalog sync" job/kind for both products and contacts.**
   - Pros: fewer flags/moving parts.
   - Cons: violates the established one-flow-per-`kind`/one-cursor-per-entity convention; a contacts failure could block the products cursor (or vice versa); harder to observe independently in the panel.
   - Effort: Medium, worse long-term.

## Recommendation

Approach 1. Build `partnerSyncModule`/`partnerSyncJobModule` as an isolated new flow mirroring `productSyncModule`/`productSyncJobModule`, reusing 90%+ of the existing engine (RetryPolicy, JobPoller, SyncCursor, rate limiter, error taxonomy) without touching the three already-shipped production tick flows. Treat the `createTickJobModule` extraction (Approach 2) as a separate, later refactor.

Two product decisions should be resolved (or explicitly parked as assumptions) before `sdd-propose`:
- Does `res.partner` map to HubSpot **contacts**, **companies**, or both routed by `is_company`? Child/address sub-partners likely need explicit inclusion/exclusion rules (similar to how product sync excludes `active:false`).
- What is the HubSpot-side idempotency key? Products use `hs_sku`, sale orders use `origin`; `res.partner.email` is not guaranteed present/unique, so a new custom property holding the Odoo partner id (provisioned like `id_presupuesto_odoo`) is the safer analog.

## Risks
- `res.partner` volume is typically much larger than `product.product` (customers, vendors, individual sub-contacts) — a full backfill may need its own throttled script before enabling the recurring tick.
- Without a firm is_company/child-partner filtering rule, naive sync risks flooding HubSpot with address/child-contact records with no independent business meaning.
- Growing the `*SyncJobModule.js` duplication without addressing it may accumulate future reviewer friction — explicitly deferred, not blocking.

## Ready for Proposal
Yes, with the two open product decisions above flagged for `sdd-propose` to resolve with the user or record as explicit assumptions.
