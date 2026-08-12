# Proposal: Odoo → HubSpot scheduled contact sync (res.partner)

## Intent

Odoo is the system of record for customers/vendors, but HubSpot contacts are maintained by hand.
Sales works from stale or missing records, and duplicates accumulate because there is no shared key.
Product sync (Odoo → HubSpot) already exists and works; contacts are the remaining master-data gap.
Success: every active `res.partner` appears in HubSpot within one tick interval, keyed idempotently, with no manual re-entry.

## Scope

### In Scope
- Scheduled `res.partner` → HubSpot **Contact** sync (full backfill `runOnce` + incremental `runIncremental` by `write_date` cursor).
- New idempotency key: a HubSpot custom **contact** property holding the Odoo partner id, auto-provisioned at boot like `id_presupuesto_odoo`.
- New isolated flow: `JOB_KIND.PARTNER_SYNC`, own sync cursor key, own Mongo mapping collection.
- Odoo client partner listing (`countPartners` / `searchPartnersAll` / `searchPartnersChangedSince`) in **both** `stub` and `http` modes.
- HubSpot contact CRUD + batch upsert through the existing `requestWithRateLimit`.
- Config block + env vars, conditional wiring in `server.js`, readiness/panel visibility, tests, docs.

### Out of Scope
- Routing `is_company` partners to HubSpot **Companies** — every partner becomes a Contact (fixed decision).
- Merging contacts and products into one combined job/`kind` — one flow per kind stays.
- Refactoring the duplicated `*SyncJobModule.js` into `createTickJobModule` — pre-existing debt, separate future change.
- HubSpot → Odoo write-back; deal/company associations; email-based dedupe/merge of pre-existing HubSpot contacts.

## Capabilities

### New Capabilities
- `partner-sync`: scheduled one-way Odoo `res.partner` → HubSpot Contact synchronization, idempotent by Odoo partner id.

### Modified Capabilities
- None.

## Approach

Mirror `productSyncModule` / `productSyncJobModule` per the ARQUITECTURA §11.3 new-integration checklist, as an isolated fourth tick flow. Reuse the generic engine untouched: `RetryPolicy`, `SyncJob`, `JobPoller`, `MongoSyncCursorRepository` (new key, 60s overlap, watermark advances only when `failed === 0`), the HubSpot token-bucket limiter, and the `SkipSyncError` / `TransientSyncError` taxonomy. No existing production tick flow is modified. Batch upsert uses the new Odoo-partner-id property as `idProperty`, exactly as products use `hs_sku`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/adapters/outbound/odoo/OdooPartnerSource.js` | New | Paginated `listAll`/`count`, async-generator `listChangedSince` |
| `src/adapters/outbound/odoo/odooApiClient.js` | Modified | Partner search/count in `stub` + `http` |
| `src/adapters/outbound/hubspot/HubspotContactGateway.js` | New | Contact upsert by Odoo-id property |
| `src/adapters/outbound/hubspot/hubspotApiClient.js` | Modified | Contact CRUD + batch upsert via `requestWithRateLimit` |
| `src/core/domain/PartnerMapping.js` | New | `odooId <-> hubspotId` entity |
| `src/adapters/outbound/mongo/MongoPartnerMappingRepository.js`, `schemas/partnerMapping.schema.js` | New | Mapping persistence |
| `src/composition/partnerSyncModule.js`, `partnerSyncJobModule.js` | New | Sync logic + self-rescheduling tick |
| `src/composition/contactPropertyDefinitions.js`, `provisionProperties.js` | New / Modified | Boot-time custom-property provisioning |
| `src/config/constants.js`, `src/config/index.js`, `src/server.js` | Modified | `JOB_KIND.PARTNER_SYNC`, `partnerSync` config, wiring |
| `test/**` (module, job, adapters, domain) | New | ~5–7 test files mirroring product-sync tests |
| `ARQUITECTURA.md`, `README.md`, `docs/plan-*.md` | Modified / New | Convention requires docs stay current |

**Size estimate (review workload)**: ~9 new source files, ~6 modified source files, ~5–7 new test files. Estimated authored additions+deletions well above the 400-line budget → **400-line budget risk: High**. Recommend chained PR slices, e.g. (1) Odoo partner source + client, (2) HubSpot contact gateway + property provisioning, (3) domain/Mongo mapping, (4) sync module + tick job + wiring + docs.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `res.partner` volume far exceeds products; first backfill is slow / rate-limited | High | Throttled backfill script (like `scripts/sync-products.js`) run before enabling the tick; batch upsert 100/req |
| Child/address sub-partners (`parent_id` set, `type != contact`) flood HubSpot | High | Explicit Odoo domain filter: `active = true`, exclude non-main address types; filter rule specified in spec phase |
| Duplicates against contacts HubSpot already holds by email | Medium | Idempotency is Odoo-id only in v1; email dedupe/merge explicitly deferred and documented |
| Custom property provisioning fails at boot | Low | Reuse existing provisioning path with fail-fast readiness probe |
| Fourth `*SyncJobModule.js` copy grows documented debt | Certain | Accepted and deferred; refactor tracked as a separate change |

## Rollback Plan

Flow is off by default. Set `PARTNER_SYNC_JOB_ENABLED=false` and restart — no other flow is touched. Full revert: drop the `partnerSync` wiring block in `src/server.js`, delete the `partnermappings` collection and the `partner-sync` cursor document. The provisioned HubSpot contact property is additive and inert if left in place.

## Dependencies

- HubSpot API scope to create contact properties and read/write contacts.
- Odoo RPC access to `res.partner` search_read.
- Agreement on the exact custom property name (proposed `id_contacto_odoo`).

## Confirmed Decisions (post-proposal question round)

- **Scope filter**: top-level partners (`parent_id = false`) plus child partners of contact type (individual people), excluding billing/delivery address-only children. Matches the domain filter already assumed in Risks above.
- **Archive semantics**: when `res.partner.active` becomes `false` in Odoo, the corresponding HubSpot contact is left untouched (no delete/archive/flag). Accepted tradeoff: HubSpot will accumulate contacts Odoo no longer considers live; revisit only if it becomes an operational problem.
- **Field ownership**: Odoo is authoritative on every tick — each sync run overwrites mapped HubSpot contact fields unconditionally, even if a user edited them manually in HubSpot between ticks. No last-write-wins/merge logic in v1.
- **Duplicate handling**: v1 does not reconcile against pre-existing HubSpot contacts with the same email. A second, Odoo-id-keyed record is created even if a matching contact already exists by email. Explicitly deferred.
- **Custom property name**: `id_contacto_odoo` (default from the proposal), unless the user requests a different internal name during spec/design.

## Success Criteria

- [x] A new/updated active `res.partner` appears or updates in HubSpot within one tick interval. (`partnerSyncModule.runIncremental`, verified by unit tests; live-instance validation is the pre-enable checklist item below.)
- [x] Re-running the sync creates zero duplicate contacts (idempotent on the Odoo-id property). (`HubspotContactGateway.upsertByOdooId` / `batchUpsertByOdooIds` keyed on `id_contacto_odoo`.)
- [x] Cursor watermark advances only when the page loop had zero failures; a partial failure re-processes next tick. (`partnerSyncModule.runIncremental`, covered by dedicated tests.)
- [x] Product, sale-order-status, and MO-retry flows show no behavior change. (Zero lines changed in `productSyncModule.js`, `productSyncJobModule.js`, `saleOrderStatusSyncJobModule.js`, `manufacturingOrderRetrySyncJobModule.js`; full suite green, no regressions.)
- [x] Sync run history/readiness visible for the partner flow like the product flow. (`MongoPartnerSyncRunRepository`, `partnerSyncJobModule` returned from `server.js` alongside the other tick modules.)

## Implementation Complete (PR1–PR4)

All four planned PRs are implemented and merged into this working tree: PR1 (Odoo partner
source + client), PR2 (HubSpot contact gateway + property provisioning), PR3 (domain
entity + Mongo mapping/run repos), PR4 (sync module + tick job + config/server wiring +
probe + docs). Full suite: 92 test files / 957 tests passing, zero regressions against the
pre-existing baseline. The flow is off by default (`PARTNER_SYNC_JOB_ENABLED=false`).

**Before enabling `PARTNER_SYNC_JOB_ENABLED=true` in production**, complete this checklist
(carried forward from the Risks table and PR1's open question):

1. Run `node scripts/probes/partner-sync.probe.js --dry-run --limit=N` against the live
   Odoo instance and inspect the printed `countPartners()` to size the real backfill —
   partner volume can far exceed product volume.
2. Verify `res.partner.type` on the live instance. The domain filter assumes contact-type
   children use `type = 'contact'` (constant `PARTNER_CONTACT_TYPE` in `odooApiClient.js`,
   deliberately isolated for this adjustment); some Odoo versions/module sets use
   `'private'` instead. If so, change that one constant to
   `['type', 'in', ['contact', 'private']]` before backfilling.
3. Run a throttled `runOnce({ limit, dryRun: false })` backfill (via the probe, without
   `--dry-run`) before turning on the recurring tick, mirroring how `sync-products.js` is
   used for the product flow.
