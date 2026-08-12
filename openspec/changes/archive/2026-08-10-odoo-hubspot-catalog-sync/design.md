# Design: Odoo `res.partner` → HubSpot Contact sync (`partner-sync`)

## Technical Approach

Clone the product-sync flow as an isolated fourth tick flow per ARQUITECTURA §11.3. Reuse `RetryPolicy`,
`SyncJob`, `JobPoller`, `MongoSyncCursorRepository`, `MongoJobRepository`, the HubSpot token-bucket limiter
and `requestWithRateLimit` unchanged. New code is additive only; the three shipped tick flows are not edited.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|----------|----------------------|-----------|
| 1 | New `JOB_KIND.PARTNER_SYNC` + own cursor key `partner-sync` + own `partnermappings` collection | Share product kind/cursor | One-flow-per-kind convention (§6); a partner failure must not block the product watermark |
| 2 | Idempotency via HubSpot custom contact property `id_contacto_odoo` used as batch `idProperty` | `email` (not unique/required), HubSpot object id in Mongo only | Mirrors `hs_sku`; survives Mongo loss; email absent on many partners |
| 3 | "Odoo always wins" = mapper emits the **complete** property set every tick, `''` for cleared Odoo values, never merged with a fetched HubSpot record | Read-modify-write, last-write-wins by timestamp | Omitting a key leaves the HubSpot value intact — emitting `''` is the only way an unconditional overwrite actually clears a manual edit |
| 4 | Pure mapper in a standalone file (`partnerToContactMapper.js`), gateway only orchestrates HTTP | Inline `buildProperties` like `HubspotProductGateway` | §11.3 pt.4; field mapping is the part that changes most and must be unit-testable without a client |
| 5 | Scope filter lives in the Odoo domain (server-side), not in JS post-filtering | Fetch all, filter in module | Volume risk: filtering server-side avoids paging millions of address rows |
| 6 | Copy `productSyncJobModule` verbatim shape (4th near-duplicate) | Extract `createTickJobModule` first | §11.2 pt.4 debt is explicitly deferred by the proposal; extracting touches 3 production flows |
| 7 | Archived (`active=false`) partners excluded by the domain; module keeps a defensive `archived` counter | Delete/archive the HubSpot contact | Confirmed decision: HubSpot record left untouched |

## Data Flow

    JobPoller(kind=partner_sync) ──→ partnerSyncJobModule.processPartnerSyncJob
                                          │
                                          ▼
                       partnerSyncModule.runIncremental({ cursorKey:'partner-sync' })
                                          │
        cursorRepo.get ──→ OdooPartnerSource.listChangedSince (async gen, page=100)
                                          │
                       partnerToContactMapper (pure) ──→ HubspotContactGateway
                                          │                    │
                                          │        batchUpsertContacts(idProperty:'id_contacto_odoo')
                                          ▼                    ▼
                    MongoPartnerMappingRepository       HubSpot CRM v3
                                          │
              cursorRepo.set(max write_date − 60s)  ← only if failed === 0
                                          │
                              finally → scheduleNextTick(now + tickIntervalMs)

## File Changes

| File | Action |
|------|--------|
| `src/adapters/outbound/odoo/OdooPartnerSource.js` | Create |
| `src/adapters/outbound/odoo/odooApiClient.js` | Modify — 3 methods in `stub` + `http` |
| `src/adapters/outbound/hubspot/HubspotContactGateway.js` | Create |
| `src/adapters/outbound/hubspot/partnerToContactMapper.js` | Create — pure mapper |
| `src/adapters/outbound/hubspot/hubspotApiClient.js` | Modify — contact CRUD + batch upsert |
| `src/core/domain/PartnerMapping.js` | Create |
| `src/adapters/outbound/mongo/MongoPartnerMappingRepository.js` | Create |
| `src/adapters/outbound/mongo/schemas/partnerMapping.schema.js` | Create |
| `src/adapters/outbound/mongo/MongoPartnerSyncRunRepository.js` + `schemas/partnerSyncRun.schema.js` | Create — run history parity |
| `src/composition/partnerSyncModule.js` | Create |
| `src/composition/partnerSyncJobModule.js` | Create |
| `src/composition/contactPropertyDefinitions.js` | Create |
| `src/config/constants.js` | Modify — `PARTNER_SYNC: 'partner_sync'` |
| `src/config/index.js` | Modify — `partnerSync` block + `propertyOdooPartnerId` |
| `src/server.js` | Modify — provisioning array + wiring/start/stop/return |
| `scripts/probes/partner-sync.probe.js` | Create — §11.3 pt.9 |

## Interfaces / Contracts

**Odoo domain (the scope filter, polish notation):**

```js
// active AND (top-level OR contact-type child) — excludes invoice/delivery/other address rows
const PARTNER_DOMAIN = [['active', '=', true], '|', ['parent_id', '=', false], ['type', '=', 'contact']]
const PARTNER_FIELDS = ['id', 'name', 'email', 'phone', 'mobile', 'street', 'city', 'zip',
  'country_id', 'parent_id', 'is_company', 'function', 'type', 'write_date', 'active']
```

**`odooApiClient.js` (both modes; stub returns `0` / `[]`):**

```js
async countPartners()
async searchPartnersAll({ offset = 0, limit = 100 } = {})            // search_read(PARTNER_DOMAIN, PARTNER_FIELDS)
async searchPartnersChangedSince({ writeDateGte, offset = 0, limit = 100 } = {})
// domain: ['&', ...PARTNER_DOMAIN_AS_AND, ['write_date', '>', writeDateGte]]
```

No `product_tmpl_id`-style OR clause is needed: every mapped field is stored on `res.partner` itself.

**`OdooPartnerSource.js`** (identical control flow to `OdooProductSource`, no `includeNoSku` axis):

```js
class OdooPartnerSource {
  constructor({ apiClient, logger = null, pageSize = 100 } = {})
  async count()                                  // -> apiClient.countPartners()
  async listAll({ limit = null } = {})           // offset loop, stops on short page
  async *listChangedSince({ writeDateGte } = {}) // yields pages; throws if writeDateGte missing
}
```

**`partnerToContactMapper.js` (pure — Decision 3):**

```js
function mapPartnerToContactProperties(partner, { idProperty = 'id_contacto_odoo' } = {})
// returns EVERY key on every call, '' when the Odoo value is empty/false:
// { [idProperty], firstname, lastname, email, phone, mobilephone, address, city, zip,
//   country, jobtitle, company }
// is_company === true  -> firstname: '', lastname: name, company: name
// is_company !== true  -> splitName(name) into firstname/lastname; company = parent_id[1] || ''
function splitName(name)   // -> { firstname, lastname }; single token -> lastname
module.exports = { mapPartnerToContactProperties, splitName }
```

**`HubspotContactGateway.js`:**

```js
class HubspotContactGateway {
  constructor({ apiClient, logger = null, idProperty = 'id_contacto_odoo' } = {})
  hasValidOdooId(odooPartner)            // id != null && Number.isFinite
  extractOdooId(odooPartner)             // String(partner.id)
  buildProperties(odooPartner)           // delegates to mapPartnerToContactProperties
  async upsertByOdooId(odooPartner)      // search -> update | create; {…data, created}
                                         // { skipped:true, reason:'no_id'|'no_name'|'duplicate_in_hubspot' }
  isDuplicateError(err)                  // same 400/409 message probe as products
  async batchUpsertByOdooIds(odooPartners, { chunkSize = 100, idProperty } = {})
                                         // -> { results, errors, skipped }
}
```

**`hubspotApiClient.js` additions (all through `requestWithRateLimit` + `normalizeHubspotError`):**

```js
async function searchContactByProperty(propertyName, value)  // POST /crm/v3/objects/contacts/search, limit 1
async function createContact(properties)                     // POST /crm/v3/objects/contacts
async function updateContact(contactId, properties)          // PATCH /crm/v3/objects/contacts/{id}
async function batchUpsertContacts({ inputs = [], idProperty = 'id_contacto_odoo' } = {})
// POST /crm/v3/objects/contacts/batch/upsert; same results/errors/numErrors split as batchUpsertProducts
```

**`PartnerMapping.js`** — mirrors `ProductMapping`, `hsSku` replaced by `odooPartnerId` (the property value):

```js
class PartnerMapping { odooId, odooPartnerId, hubspotId, action, syncedAt, lastSyncedAt, createdAt }
function buildPartnerMapping({ odooId, hubspotId, action, now })  // throws on null odooId/hubspotId, invalid action
function recordSyncSuccess({ mapping, action, now })
const VALID_ACTIONS = new Set(['created', 'updated'])
```

**`partnerMapping.schema.js`** — `odooId` (Number, unique, index), `odooPartnerId` (String, index), `hubspotId`,
`lastAction` enum `['created','updated','backfilled','attempted']`, `lastSyncedAt`, `firstSyncedAt`, `metadata`,
timestamps, `versionKey: false`, model name `'PartnerMapping'`.

**`MongoPartnerMappingRepository.js`** — `upsert({odooId, hubspotId, action, now})`,
`bulkUpsertMany({items, now})`, `findByOdooId(odooId)`, `listAll()`, `listPaginated({page, limit})`, `clear()`.

**`partnerSyncModule.js`:**

```js
const DEFAULT_OVERLAP_MS = 60 * 1000
const EPOCH_WATERMARK = '1970-01-01 00:00:00'
const DEFAULT_CURSOR_KEY = 'partner-sync'
function createPartnerSyncModule({ config, odooSource, hubspotGateway, logger,
  concurrency = 10, chunkSize = 100, mappingRepo = null, runRepo = null, cursorRepo = null } = {})
// -> { runOnce({ limit = null, dryRun = false } = {}),
//      runIncremental({ overlapMs = DEFAULT_OVERLAP_MS, cursorKey = DEFAULT_CURSOR_KEY } = {}),
//      syncOneItem(partner, { dryRun }) }
```

Simpler than the product module: no `partition()` (there is no no-SKU branch — every partner has an id, so
everything goes through `batchUpsertByOdooIds`); single items only on the dry-run path. `runIncremental`
keeps the product semantics verbatim: `maxSeenMs` from `write_date`, skip+count `active === false`, persist
mappings only when `!batchFailed`, and `cursorRepo.set(key, formatOdooDateUtc(maxSeenMs - overlapMs))`
**only when `failed === 0 && !batchFailed`**.

**`partnerSyncJobModule.js`** — byte-for-byte shape of `productSyncJobModule` with
`SEED_SOURCE_ID = 'partner-sync-loop'`, `JOB_KIND.PARTNER_SYNC`, `createPartnerSyncJobModule({ config, logger,
jobRepository, partnerSyncModule, jobPoller = null, tickIntervalMs, orphanWatchdogMs, clock })` returning
`{ processPartnerSyncJob, ensureSeeded, startWorker, stopWorker, _internals }`. `maxAttempts:
Number.MAX_SAFE_INTEGER`, poller `concurrency: 1`, `recoverOrphansOnStart: true`, own `orphanWatchdogMs`.

**`contactPropertyDefinitions.js`** — same shape as `quotePropertyDefinitions.js`:

```js
function buildContactPropertyDefinitions(cfgHubspot = {}) {
  const partnerIdProperty = cfgHubspot.propertyOdooPartnerId || 'id_contacto_odoo'
  return [{ name: partnerIdProperty, label: 'ID Contacto Odoo', type: 'string',
            fieldType: 'text', groupName: 'contactinformation',
            description: 'res.partner.id de Odoo. Clave de idempotencia del partner-sync.' }]
}
```

Plugs into the existing boot block in `src/server.js` by adding a third entry to the existing
`Promise.all([...])`: `provisionProperties({ api: hubspotApi, objectType: 'contacts', properties:
buildContactPropertyDefinitions(cfg.hubspot), logger })`, then spreading `contactSummary` into `combined`.
`provisionProperties.js` itself needs no signature change — it is already objectType-generic.

**Config (`src/config/index.js`)** — new block after `productSync`, plus one HubSpot property key:

```js
partnerSync: {
  jobEnabled: String(env.PARTNER_SYNC_JOB_ENABLED || 'false').toLowerCase() === 'true',
  tickIntervalMs: Number(env.PARTNER_SYNC_TICK_INTERVAL_MS || 60000),
  orphanWatchdogMs: Number(env.PARTNER_SYNC_ORPHAN_WATCHDOG_MS || 30 * 60 * 1000),
  pageSize: Number(env.PARTNER_SYNC_PAGE_SIZE || 100)
},
// inside hubspot: propertyOdooPartnerId: env.HS_PROPERTY_ODOO_PARTNER_ID || 'id_contacto_odoo'
```

New env vars: `PARTNER_SYNC_JOB_ENABLED`, `PARTNER_SYNC_TICK_INTERVAL_MS`, `PARTNER_SYNC_ORPHAN_WATCHDOG_MS`,
`PARTNER_SYNC_PAGE_SIZE`, `HS_PROPERTY_ODOO_PARTNER_ID`. Default off.

**`src/server.js` wiring** — a new `if` block inserted after the `productSync` block (nothing inside the
existing block is touched):

```js
let partnerSyncJobModule = null
if (cfg.partnerSync && cfg.partnerSync.jobEnabled) {
  const partnerOdooApi = createOdooApiClient({ mode: cfg.odoo.mode, baseUrl: cfg.odoo.baseUrl,
    db: cfg.odoo.db, login: cfg.odoo.login, apiKey: cfg.odoo.apiKey })
  const partnerHubspotApi = createHubspotApiClient({ baseUrl: cfg.hubspot.apiBase,
    accessToken: cfg.hubspot.accessToken })
  const partnerSyncModule = createPartnerSyncModule({
    config: cfg,
    odooSource: new OdooPartnerSource({ apiClient: partnerOdooApi, logger, pageSize: cfg.partnerSync.pageSize }),
    hubspotGateway: new HubspotContactGateway({ apiClient: partnerHubspotApi, logger,
      idProperty: cfg.hubspot.propertyOdooPartnerId }),
    mappingRepo: new MongoPartnerMappingRepository({ logger }),
    runRepo: new MongoPartnerSyncRunRepository({ logger }),
    cursorRepo: new MongoSyncCursorRepository(),
    logger, concurrency: 10
  })
  partnerSyncJobModule = createPartnerSyncJobModule({ config: cfg, logger,
    jobRepository: new MongoJobRepository({ logger }), partnerSyncModule,
    tickIntervalMs: cfg.partnerSync.tickIntervalMs, orphanWatchdogMs: cfg.partnerSync.orphanWatchdogMs })
}
```

Plus three one-line additive edits: `if (partnerSyncJobModule) await partnerSyncJobModule.startWorker()`,
the mirrored `stopWorker()` line in `shutdown`, and `partnerSyncJobModule` appended to the returned object.

## Isolation Guarantee

This design touches **zero lines** inside `productSyncModule.js`, `productSyncJobModule.js`,
`saleOrderStatusSyncJobModule.js`, `manufacturingOrderRetrySyncJobModule.js`, `OdooProductSource.js`,
`HubspotProductGateway.js`, `ProductMapping.js`, `MongoProductMappingRepository.js`, `JobPoller.js`,
`SyncJob.js`, `RetryPolicy.js` or `MongoSyncCursorRepository.js`. Every edit to a shared file is a pure
insertion: a new enum member in `constants.js`, a new config block and one property key in `config/index.js`,
new methods appended to the two API-client return objects, and a new conditional block plus three additive
lines in `server.js`. `provisionProperties.js` gains one extra call site, not a changed signature.
`MongoSyncCursorRepository` is reused as-is with a new key, so the product watermark is untouched.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | `mapPartnerToContactProperties` / `splitName` | Pure fn: company vs individual, empty→`''` overwrite, all keys always present |
| Unit | `OdooPartnerSource` | Fake apiClient: paging, short-page stop, `limit`, generator termination, missing `writeDateGte` throws |
| Unit | `odooApiClient` http mode | Fake transport asserting the exact `PARTNER_DOMAIN` polish-notation array; stub mode returns `0`/`[]` |
| Unit | `HubspotContactGateway` | Fake apiClient: create vs update, duplicate 409, chunking at 100, `idProperty` propagation |
| Unit | `PartnerMapping` | Invariant throws |
| Integration | `MongoPartnerMappingRepository` | `mongodb-memory-server` as existing repo tests do |
| Integration | `partnerSyncModule.runIncremental` | Fakes: watermark advances only on `failed===0`, 60s overlap subtracted, archived skipped, mappings not persisted on batch failure |
| Integration | `partnerSyncJobModule` | Fake jobRepository/poller: seeding, `scheduleNextTick` in `finally` on both success and throw, dead-letter path |
| Regression | Isolation | Existing product/sale-order/MO suites must pass unmodified |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration
boundary. All new I/O is outbound HTTP through existing rate-limited clients.

## Migration / Rollout

No data migration. `PARTNER_SYNC_JOB_ENABLED=false` by default; the flow is inert until enabled. Recommended
order: deploy (property auto-provisions at boot) → run a throttled backfill (`runOnce`, mirroring
`scripts/sync-products.js`) → enable the tick. Rollback: set the flag false and restart; optionally drop
`partnermappings` and the `partner-sync` cursor document. The provisioned contact property is inert if left.

## Open Questions

- [ ] `res.partner.type` selection values vary by Odoo version/module set (`private` exists in 15+). If
      individual person children carry `type='private'` in this instance, the domain needs
      `['type','in',['contact','private']]`. Verify against the live instance during apply.
- [ ] Backfill volume: `countPartners()` should be measured before the first `runOnce` to size the throttle.
