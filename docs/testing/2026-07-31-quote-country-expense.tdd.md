# TDD Evidence Report — Quote + Country Expense + Odoo generates the MO

Date: 2026-07-31
Branch: `feat/quote-country-expense` (planned)
Source plan: [`docs/plan-presupuesto-pais-y-mo.md`](../../plan-presupuesto-pais-y-mo.md)
Staging probes: [`docs/testing/2026-07-31-probe-results.json`](2026-07-31-probe-results.json)

## 1. Source plan summary

The upstream plan (`docs/plan-presupuesto-pais-y-mo.md`) was approved on 2026-07-31 and
states (resumen ejecutivo):

- **A.** Setear `country_expense` desde el país del cliente (`res.partner.country_id`).
- **B.** Dejar de crear la `mrp.production`. El `sale.order` (presupuesto) pasa a ser el
  único target del middleware. Odoo genera la MO al confirmar el presupuesto.
- **C.** Si el país no resuelve, crear el presupuesto igual sin `country_expense`. No
  bloquear el job. Anexar marcador `[smartflow]` a la `note` del SO para visibilidad
  en Odoo.
- **D.** Update sin `order_line` (Decisión D): nunca pisar líneas humanas en Odoo, nunca
  pisar `country_expense` si ya está seteado, nunca pisar `note` si ya tiene contenido.
- **E.** Writeback a una propiedad nueva `id_presupuesto_odoo` con el nombre del
  presupuesto. `id_orden_odoo` queda reservado para un futuro backfill.

### Pre-implementation probes (P1-P7, against staging)

`scripts/probes/odoo-quote-readiness.js` ran against `visual-branding-stag.odoo.com` on
2026-07-31. Highlights from `docs/testing/2026-07-31-probe-results.json`:

| Probe | Result | Implication for the plan |
|---|---|---|
| P1 | `country_expense` is `readonly=false, compute=null, store=true, type=many2one, string="País"` | Settable via RPC. Plan valid. |
| P2 | 35 countries; **27** have >1 `operation.costs` record | Plan's expected "148 records / ~10 countries" was an under-estimate; design adapts |
| P3 | All 27 ambiguous countries have a record named exactly `DDP <Country>` | Policy refined: prefer exact `DDP <Country>` (case/accent-insensitive), ignore variants, fallback to lowest id |
| P4 | 0/3 recent-deal partners lack `country_id`; defensive parent walk still implemented | No regression today; future-proof |
| P5 | Every partner country has a matching `operation.costs` record | No unresolvable countries in the live data |
| P6 | 1 confirmed historical SO (`S06613`) has 1 line → 1 MO | Multi-line to be validated empirically on first multi-line deal |
| P7 | HubSpot property `id_presupuesto_odoo` does not exist (404) | Auto-resolved at server startup via `provisionDealProperties` → `ensureCustomProperty` (creates on 404) |

No probe failed in a blocking way. P7 is operational; everything else informed
implementations (not blockers).

### User-confirmed decisions

1. **Phase-by-phase Gate 1 reviews → continuous execution** (chat, 2026-07-31): the user
   approved Phase 3 in chat and asked to execute "todo lo que falta de corrido" from
   that point on.
2. **No Mongo footprint for line-item diff** (Limitation #4, chat): the HubSpot line-item
   change limitation is documented as a one-liner in the README. No
   `mapping.metadata.lastSyncedLineItemIds` audit field is added.
3. **Branch from `main`** as `feat/quote-country-expense` (chat). Working tree only;
   commits deferred to the user.

## 2. User journeys

1. **As a sales operator**, when a deal reaches *Cierre Ganado* in the Comercial Visual
   Branding pipeline, I want the middleware to create a complete and confirmable
   `sale.order` (presupuesto) in Odoo with the correct `country_expense`, so that
   confirming it in Odoo generates one `mrp.production` per line item linked to the
   sale.
2. **As an Odoo ops user**, I want the `country_expense` field pre-populated with the
   right DDP record for the customer's country, so I don't have to set it manually and
   `destination_taxes` lands non-zero.
3. **As an Odoo ops user**, if the deal has no resolvable country, I want the
   presupuesto to be created anyway with a `[smartflow] País no resuelto` marker in
   the note, so I can fix it before confirming — instead of the job silently
   dead-lettering.
4. **As an ops auditor**, I want `mapping.metadata.countryExpense` to carry the
   resolution status + chosen `operation.costs.id` for every synced deal, so I can
   query Mongo to see which deals landed with an unresolved country.
5. **As the on-call engineer**, when the gateway rebuilds after this change, I want
   any stale `mrp.production` rows still carrying `origin: "hs:<dealId>"` to be
   cancelable via a one-off script, so the 9 orphan MOs from the previous flow don't
   pollute reports.

## 3. Task report

| Phase | Summary | Validation | Result |
|---|---|---|---|
| 1 | Pure module `operationCostsResolver.js` + 9 tests (empty/single/exact-DDP/variants/lowest-id-fallback/case-accent/null) | `npx vitest run test/adapters/odoo/operationCostsResolver.test.js` | PASS — 9/9 |
| 2 | `odooApiClient.js`: add `readPartnerCountries`, `listOperationCosts` (memo + TTL + clock), change `searchSalesOrderByOrigin` to `search_read` returning objects, change `createSalesOrder` to read `name` post-create | `npx vitest run test/adapters/odoo/odooApiClient.test.js` | PASS — 41/41 |
| 3 | `git mv dealToManufacturingOrderMapper.js → dealToSaleOrderMapper.js`; drop MO block; add `countryExpenseId`; rename export | `npx vitest run test/adapters/odoo/dealToSaleOrderMapper.test.js` | PASS — 15/15 |
| 4 | `OdooTargetGateway.js` surgery: `resolveCountryExpense`, `resolveExistingSalesOrder` (absorbs legacy bare-id `soSearch`), `buildSaleOrderUpdatePayload` (Decision D), `upsertSalesOrder`. New return shape with `metadata.countryExpense`. Drop MO block. `existingTargetId` accepted but ignored (Risk 2). Explicit test: MO methods never called. | `npx vitest run test/adapters/odoo/OdooTargetGateway.test.js` | PASS — 53/53 |
| 5 | `ProcessSyncJobUseCase.js`: spread `upsertResult.metadata` into `mappingMetadata`; include `metadata` in `target.upserted` audit detail; update port JSDoc; fallback `buildWriteBackPayload` returns `id_presupuesto_odoo` from `targetRef` | `npx vitest run test/application/use-cases.test.js` | PASS — 15/15 |
| 6 | `config/index.js` (+HS_PROPERTY_ODOO_QUOTE_ID), new `dealPropertyDefinitions.js`, `server.js` uses the factory, `HubspotSourceGateway.js` accepts `propertyOdooQuoteId` + writes `id_presupuesto_odoo`, `dealSyncModule.buildWriteBackPayload` writes `id_presupuesto_odoo: targetRef` | `npx vitest run test/composition test/adapters/hubspot test/config.test.js` | PASS — all green |
| 7 | Docs: `.env.example`, `docker-compose.yml`, `README.md` flux + property table; this TDD doc | n/a (docs) | n/a |
| 8 | `scripts/cancel-stale-mos.js` — read-only by default, `--apply` to cancel | n/a (operational script) | n/a |
| Final | Full suite + re-run of probes | `npx vitest run` | PASS — 517/517 |

### RED → GREEN cycle (Phase 4, the surgery)

Pre-Phase-4: 484 passing (Phase 2 done). After editing `OdooTargetGateway.test.js` to the
new shape (drop MO assertions, add `country_expense` resolution tests), 41 failed /
12 passed (the 12 surviving are `collectUnresolvedLines` + tests that already worked
without MO references). After implementing the new gateway, 53/53 pass.

```
RUN v2.1.9
✓ test/adapters/odoo/OdooTargetGateway.test.js (53 tests) 49ms
Test Files  1 passed (1)
Tests       53 passed (53)
```

## 4. Test specification

| # | Guarantee | Test | Type | Result |
|---|---|---|---|---|
| 1 | `pickOperationCostForCountry` returns `null` for empty array | `operationCostsResolver.test.js > returns null for an empty array` | unit | PASS |
| 2 | Returns `null` for non-array input | `... > returns null for non-array input` | unit | PASS |
| 3 | Single record returned without ambiguity | `... > returns the single record without ambiguity when only one matches` | unit | PASS |
| 4 | Prefers exact `DDP <Country>` over other records | `... > prefers the exact DDP match when one exists among multiple records` | unit | PASS |
| 5 | Excludes variant suffixes (`0`, `Aereo`, `con Duca`, `sin Duca`, `Seguro + Impuestos`) | `... > ignores DDP variant suffixes (...)` | unit | PASS |
| 6 | Falls back to lowest id with `reason: 'no_ddp_exact_match'` | `... > falls back to the lowest id when no DDP-prefixed record matches the country` | unit | PASS |
| 7 | Case + accent-insensitive matching | `... > matches country name case-insensitively and ignoring diacritics` | unit | PASS |
| 8 | `countryName` null/empty + multiple records → lowest id, `reason: 'country_name_required'` | `... > falls back when countryName is null and multiple records exist` / `... > falls back when countryName is an empty string and multiple records exist` | unit | PASS |
| 9 | `createSalesOrder` http: 3 posts (auth + create + read), returns `{id, ref: name, state}` | `odooApiClient.test.js > http mode createSalesOrder uses execute_kw on sale.order.create and reads the name back` | unit | PASS |
| 10 | `createSalesOrder` http: surfaces error from read-after-create | `... > http mode createSalesOrder surfaces the read-after-create error` | unit | PASS |
| 11 | `searchSalesOrderByOrigin` http: uses `search_read` with `['id','name','state','country_expense']`, returns mapped objects | `... > http mode searchSalesOrderByOrigin uses execute_kw on sale.order.search_read` | unit | PASS |
| 12 | `readPartnerCountries` http: maps many2one + parent_id, dedupes ids, returns `{}` without RPC for empty input | `... > http mode reads partners and maps country_id and parent_id` / `... > http mode returns empty map for empty or non-numeric input without RPC` | unit | PASS |
| 13 | `readPartnerCountries` stub: returns `{}` | `... > stub mode returns empty map` | unit | PASS |
| 14 | `listOperationCosts` http: maps `search_read` result to `{id, name, countryId, countryName, productId}` | `... > http mode search_reads operation.costs and maps the result shape` | unit | PASS |
| 15 | `listOperationCosts` stub: returns `[]` | `... > stub mode returns empty array` | unit | PASS |
| 16 | Two concurrent calls share one RPC (in-flight memo) | `... > two concurrent calls share a single RPC` | unit | PASS |
| 17 | TTL cache: refetches after expiry | `... > caches within TTL and refetches after expiry` | unit | PASS |
| 18 | Failed call does not cache the error | `... > refetches immediately after a failed call (no stale error cached)` | unit | PASS |
| 19 | `mapDealToSaleOrder` returns only `{saleOrder}` (no MO block) | `dealToSaleOrderMapper.test.js > does not include a manufacturingOrder block` | unit | PASS |
| 20 | Includes `country_expense: Number(countryExpenseId)` when provided | `... > includes country_expense in saleOrder when countryExpenseId is provided` | unit | PASS |
| 21 | Coerces string `countryExpenseId` to number | `... > coerces string countryExpenseId to a number` | unit | PASS |
| 22 | Omits `country_expense` when null or undefined | `... > omits country_expense when countryExpenseId is null` / `... > omits country_expense when countryExpenseId is undefined (default)` | unit | PASS |
| 23 | `upsert` creates SO and returns `metadata.countryExpense` with resolved status | `OdooTargetGateway.test.js > upsert creates SO when no existing SO and returns country_expense in metadata` | unit | PASS |
| 24 | `upsert` reuses existing SO via search and updates it without `order_line` | `... > upsert reuses existing SO via search and updates it without order_line` | unit | PASS |
| 25 | Tolerates legacy `soSearch` returning bare ids | `... > upsert tolerates legacy soSearch returning bare ids (no name/state)` | unit | PASS |
| 26 | Ignores `existingTargetId` (Risk 2: stale MO id never reaches `updateSalesOrder`) | `... > ignores existingTargetId (Risk 2: stale MO id never reaches updateSalesOrder)` | unit | PASS |
| 27 | Never calls `createManufacturingOrder` or `updateManufacturingOrder`, even with `existingTargetId` set | `... > never calls createManufacturingOrder or updateManufacturingOrder, even with existingTargetId set` | unit | PASS |
| 28 | Walks `parent_id` chain to find a country | `OdooTargetGateway country_expense resolution > walks parent_id chain to find a country` | unit | PASS |
| 29 | Returns `no_operation_cost_for_country` when partner has country but no matching records | `... > returns no_operation_cost_for_country when partner has country but no matching records` | unit | PASS |
| 30 | Falls back to lowest id with `ambiguous: true, matches > 1` | `... > falls back to lowest id when ambiguous and reports matches > 1` | unit | PASS |
| 31 | Degrades when `readPartnerCountries` throws (does not block SO create) | `... > degrades when readPartnerCountries throws (does not block SO create)` | unit | PASS |
| 32 | Degrades when `listOperationCosts` throws | `... > degrades when listOperationCosts throws (does not block SO create)` | unit | PASS |
| 33 | Back-compat without `readPartnerCountries` (stub api) | `... > works without readPartnerCountries (back-compat stub api)` | unit | PASS |
| 34 | Back-compat without `listOperationCosts` (stub api) | `... > works without listOperationCosts (back-compat stub api)` | unit | PASS |
| 35 | Update payload omits `country_expense` when SO already has it | `... > omits country_expense from update payload when SO already has it` | unit | PASS |
| 36 | Update payload sends `country_expense` when SO has it empty | `... > sends country_expense in update payload when SO has it empty` | unit | PASS |
| 37 | Update payload omits `note` when existing SO has a note | `... > omits note from update payload when existing SO already has a note` | unit | PASS |
| 38 | Appends `[smartflow]` marker when unresolved on create | `... > appends [smartflow] marker to note when unresolved on create` | unit | PASS |
| 39 | `ProcessSyncJobUseCase` merges `upsertResult.metadata` into `mapping.metadata` | `use-cases.test.js > merges upsertResult.metadata into mapping.metadata` | unit | PASS |
| 40 | `ProcessSyncJobUseCase` includes `metadata` in `target.upserted` audit detail | `use-cases.test.js > includes metadata in the target.upserted audit detail` | unit | PASS |
| 41 | `buildDealPropertyDefinitions` returns three entries with names from config | `dealPropertyDefinitions.test.js > returns three entries with names sourced from config` | unit | PASS |
| 42 | All entries use `string`/`text`/`dealinformation` group | `... > every entry uses string + text + dealinformation group` | unit | PASS |
| 43 | `id_presupuesto_odoo` description mentions quote + MO generation flow | `... > id_presupuesto_odoo description mentions quote + MO generation flow` | unit | PASS |
| 44 | Config exposes `propertyOdooQuoteId` from env | `config.test.js > accepts HS_PROPERTY_ODOO_QUOTE_ID and defaults propertyOdooQuoteId to id_presupuesto_odoo` | unit | PASS |
| 45 | Config defaults `propertyOdooQuoteId` to `id_presupuesto_odoo` | `... > defaults propertyOdooQuoteId to id_presupuesto_odoo when env var missing` | unit | PASS |
| 46 | `HubspotSourceGateway.writeBack` writes `id_presupuesto_odoo` to the configured quote property | `HubspotSourceGateway.test.js > writeBack writes id_presupuesto_odoo to the configured quote property` | unit | PASS |
| 47 | `fetchRecord` requests the configured quote property | `... > fetchRecord requests the configured quote property` | unit | PASS |
| 48 | `buildWriteBackPayload` returns `id_presupuesto_odoo` from `targetRef`, drops `id_orden_odoo` | `dealSyncModule.test.js > buildWriteBackPayload (quote flow) > returns id_presupuesto_odoo from targetRef when mapping has one` | unit | PASS |
| 49 | `buildWriteBackPayload` returns `null` when `targetRef` missing | `... > returns null id_presupuesto_odoo when mapping has no targetRef` | unit | PASS |

## 5. Coverage and known gaps

Full suite: **57 test files / 517 tests passing** (was 466 → +51 net new/modified).

The exact coverage delta can be re-measured with `npm run test:coverage`. The new
modules ship with high unit-test density:

- `operationCostsResolver.js`: 9 tests covering all branches.
- `dealToSaleOrderMapper.js`: 15 tests including SO shape, country_expense on/off,
  numeric coercion.
- `OdooTargetGateway.js`: 53 tests covering SO creation/update, MO-explicit-absence,
  country resolution paths, parent walk, ambiguity, degradation, retrocompat.

### Intentional gaps / follow-ups

- **No live E2E against staging** in this TDD pass. Phase 8 of the upstream plan
  enumerates the staging E2E checklist (8 steps). To be run by the operator when
  this branch lands; the dealSyncModule e2e suite (CVB + sales pipeline paths)
  remains the closest available simulation.
- **`processSyncJob` writeback content for `id_presupuesto_odoo`** is covered at the
  unit level (`buildWriteBackPayload` tests) and at the gateway level (SO creation
  returns `targetRef`), but not at the integration level (Mongo mapping → HubSpot
  write). The dealSyncModule test passes a fake writeBack that doesn't assert
  content. Adding an integration assertion is low-value (each piece is tested) and
  left as a follow-up if the field flow ever regresses.
- **9 stale `mrp.production` rows in Odoo** from the old flow: covered by
  `scripts/cancel-stale-mos.js` (read-only by default). Operator runs with `--apply`
  once this branch is live in production.
- **Limitation #4 — HubSpot line-item changes after first sync are not propagated to
  the SO** is documented in the README's HubSpot property table as a one-liner. The
  diff-with-key implementation is deliberately out of scope (re-syncs after
  `closedwon` are rare and HubSpot itself restricts dealstage regression).
- **`country_expense` overwrite on update**: only sent when existing SO's
  `countryExpenseId` is falsy. A person who manually empties the field and re-syncs
  will have the gateway re-fill it. This is intentional (the gateway is the source
  of truth for the field), but documented so ops aren't surprised.

## 6. Suggested squash commit

```
feat: link sale.order with country_expense, drop mrp.production creation

Decisions A-E from docs/plan-presupuesto-pais-y-mo.md:
- (A) sale.order.country_expense is set from res.partner.country_id + operation.costs
      resolved via DDP <Country> match (case/accent-insensitive, fallback id-lowest).
- (B) sale.order is the only middleware target. Odoo generates the mrp.production
      on confirmation; the middleware no longer writes MO.
- (C) Unresolved country -> SO still created, [smartflow] marker appended to note.
- (D) Update path omits order_line, never overwrites country_expense if already set,
      never overwrites note if it has content.
- (E) Writeback writes the SO name (e.g. "S06613") to id_presupuesto_odoo.

Add: operationCostsResolver (pure), readPartnerCountries + listOperationCosts
(odooApiClient), resolveCountryExpense + upsertSalesOrder + buildSaleOrderUpdatePayload
(gateway), dealPropertyDefinitions factory, config knob HS_PROPERTY_ODOO_QUOTE_ID,
script scripts/cancel-stale-mos.js, TDD evidence doc.

Risk 2: existingTargetId is accepted (port signature) but ignored. Pre-existing
mapping rows carry mrp.production ids which would corrupt a sale.order that
coincidentally shares the integer. Test "ignores existingTargetId" locks this in.

Pre-implementation probes P1-P7 against staging: country_expense writable, every
partner country has operation.costs, the 27 ambiguous countries all have a generic
DDP record. Full results in docs/testing/2026-07-31-probe-results.json.

RED evidence (Phase 4 surgery): 41 failing tests in OdooTargetGateway.test.js
after dropping MO assertions and adding country_expense resolution tests.
GREEN: 517/517 pass.

Risks: see docs/plan-presupuesto-pais-y-mo.md section "Riesgos".
```
