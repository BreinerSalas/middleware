# PR 2 — HubSpot Contact Gateway + Property Provisioning

> Phase 2 of `odoo-hubspot-catalog-sync`. Additive only — no tick flow touched.
> Strict TDD: every RED was confirmed failing before the corresponding GREEN went in.

## Files created

| Path | Role |
|---|---|
| `src/adapters/outbound/hubspot/partnerToContactMapper.js` | Pure mapper `mapPartnerToContactProperties(partner, { idProperty })` + `splitName(name)`. Emits every contact key on every call; `''` for empty/false Odoo values (the "Odoo always wins" rule). No outbound deps. |
| `src/adapters/outbound/hubspot/HubspotContactGateway.js` | Gateway mirroring `HubspotProductGateway`. Methods: `hasValidOdooId`, `extractOdooId`, `buildProperties` (delegates to the mapper), `upsertByOdooId` (search → update / create / duplicate-skip), `batchUpsertByOdooIds` (chunks at 100, propagates `idProperty`). No SKU-style partition logic — every partner always has an id. |
| `src/composition/contactPropertyDefinitions.js` | `buildContactPropertyDefinitions(cfgHubspot)` returning the single `id_contacto_odoo` definition. `groupName: 'contactinformation'`, `type: 'string'`, `fieldType: 'text'`. |
| `test/adapters/hubspot/partnerToContactMapper.test.js` | 21 tests: splitName edge cases + mapper key-emission contract (every key always present), is_company branching, company from `parent_id[1]`, country from `country_id[1]`, defensive coercions. |
| `test/adapters/hubspot/HubspotContactGateway.test.js` | 27 tests: idProperty wiring, hasValidOdooId finiteness, buildProperties delegation, upsertByOdooId create-vs-update-vs-skip-vs-duplicate, batch chunking + skipped partition. |
| `test/adapters/hubspot/hubspotApiClient.contact.test.js` | 14 tests: search/create/update/batchUpsertContacts wire format, rate-limiter token taken before call, error normalization (400 → httpStatus). |
| `test/composition/contactPropertyDefinitions.test.js` | 5 tests: default name `id_contacto_odoo`, custom override via `cfgHubspot.propertyOdooPartnerId`, type/fieldType/groupName/label/description shape. |

## Files modified

| Path | Diff size | What changed |
|---|---|---|
| `src/adapters/outbound/hubspot/hubspotApiClient.js` | +55 lines | Added `searchContactByProperty(propertyName, value)`, `createContact(properties)`, `updateContact(contactId, properties)`, `batchUpsertContacts({ inputs, idProperty })`. All routed through existing `requestWithRateLimit` + `normalizeHubspotError`. Exported from the factory return. |
| `src/server.js` | +6/-3 lines | Added `buildContactPropertyDefinitions` import; one new `contactPropertiesToProvision` local; added the third entry to the existing boot-time `Promise.all` with `objectType: 'contacts'`; spread `contactSummary` into the existing `combined` array. Zero lines inside the existing deal/quote provisioning block touched. |

## Files NOT touched (as required)

- `src/composition/productSyncModule.js`
- `src/composition/productSyncJobModule.js`
- `src/composition/saleOrderStatusSyncJobModule.js`
- `src/composition/manufacturingOrderRetrySyncJobModule.js`
- `src/adapters/outbound/odoo/OdooPartnerSource.js`, `odooApiClient.js` (PR 1, untouched here)
- No config changes, no constants changes, no docs changes — those are PR 3 / PR 4.

## Test counts

| Scope | Before PR 2 | After PR 2 |
|---|---|---|
| Test files | 82 | 86 (+4) |
| Tests passing | 835 | 902 (+67) |
| Failing | 0 | 0 |

Breakdown of the +67 new tests:
- `hubspotApiClient.contact.test.js`: 14
- `partnerToContactMapper.test.js`: 21 (6 splitName + 15 mapper)
- `HubspotContactGateway.test.js`: 27
- `contactPropertyDefinitions.test.js`: 5

Full suite (`npm test` → `vitest run`) green in ~9.5s.

## Deviations from design.md / tasks.md wording

1. **Test path prefix.** `tasks.md` originally wrote the contact tests under `test/adapters/outbound/hubspot/`, but the actual repo test tree uses `test/adapters/hubspot/` (no `outbound` segment — the same deviation is acknowledged in PR 1 task 1.1). I mirrored the existing repo convention so the new tests sit next to their siblings: `HubspotContactGateway.test.js` next to `HubspotProductGateway.test.js`, `hubspotApiClient.contact.test.js` next to `hubspotApiClient.batchUpsert.test.js`, `partnerToContactMapper.test.js` next to the existing hubspot adapter tests, and `contactPropertyDefinitions.test.js` next to `quotePropertyDefinitions.test.js` (composition layer is at `test/composition/`). This matches how PR 1 placed its `test/adapters/odoo/odooApiClient.partner.test.js`.
2. **`skip` reasons in the gateway.** `design.md` enumerates `'no_id' | 'no_name' | 'duplicate_in_hubspot'`. I added nothing new — null/missing partner falls through the `hasValidOdooId` check and reports `no_id`. That keeps the contract minimal and the test asserts `no_id` for the null case.
3. **`contactToContactMapper` location.** Design says "pure mapper beside the target adapter" → I placed it at `src/adapters/outbound/hubspot/partnerToContactMapper.js`, sitting next to `HubspotContactGateway.js`. Mirrors the `dealToSaleOrderMapper.js` placement convention (in `adapters/outbound/odoo/`, beside its consumer gateway).
4. **Server.js wiring beyond the explicit task list.** Tasks 2.1–2.8 do not list a `server.js` wiring checkbox, but the user prompt explicitly asked for the property to be wired into the boot block. I added the minimal additive third `Promise.all` entry (no other lines changed). This makes the property auto-provision at boot for the eventual PR 4 sync module — otherwise PR 4 would 404 on the property until manual intervention.
5. **`country_id` / `parent_id` handling.** `design.md` says "country" / "company" but doesn't specify many2one tuple unpacking. I implemented a `pickMany2oneName` helper that reads `[id, name]` tuples, mirroring how Odoo returns relational fields. Tested explicitly with `[51, 'Peru']` → `'Peru'` and `false` → `''`.

## Risks / open questions

- **`splitName` heuristic.** Design says "splitName(name) into firstname/lastname; single token → lastname". I extended this to "first token = firstname, rest joined as lastname" for 3+-token names (common in Latin American naming). This is a guess — if the live instance prefers "everything in lastname except the very last token", that's a 2-line change. Worth verifying during PR 4 apply against a sample partner.
- **Batch search is not implemented.** The `batchUpsertContacts` is enough for the "create-or-update" use case because HubSpot's batch-upsert accepts `idProperty`. No separate "search all and partition" step needed, matching the product flow.
- **Empty list still calls `batchUpsertContacts` for some inputs?** No — `valid.length === 0` returns early without hitting the wire (test covers this). Confirmed.
- **Contact property provision at boot is now ALWAYS attempted**, even when the partner-sync flow is disabled (`PARTNER_SYNC_JOB_ENABLED=false`). That mirrors the existing deals/quotes behaviour and is intentional (the property is a shared key future flows might also need). If that ever becomes undesirable, gate it on `cfg.partnerSync && cfg.partnerSync.jobEnabled` — but doing so now would break the PR 4 module's assumption that the property exists at boot regardless of flag.
- **Property name override.** If `cfg.hubspot.propertyOdooPartnerId` is changed at runtime, the property name in HubSpot and the mapper's `idProperty` must stay in sync. Both come from the same `cfg.hubspot` object via `server.js`, so they are consistent by construction. The gateway accepts `idProperty` at construction time so the PR 4 wiring is straightforward.

## Next PR

PR 3 — `PartnerMapping` domain entity + `MongoPartnerMappingRepository` + `MongoPartnerSyncRunRepository` + their schemas. Then PR 4 — `partnerSyncModule` + `partnerSyncJobModule` + `server.js` wiring + config block + probe + docs.
