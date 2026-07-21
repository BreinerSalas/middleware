# TDD Evidence — deal-sync end-to-end (line_items + sale_order + SKU lookup)

## Source
Bug surfaced during real webhook test against deal `62939072525` in the HubSpot portal `50564010` and Odoo `bsalas.odoo.com`.

Three independent defects were uncovered and fixed in a single cycle:

1. `validators.mustHaveLineItems` read a non-existent `props.line_items` (HubSpot line items live as associations, not properties).
2. `HubspotSourceGateway.resolveReferences` only fetched `contact,company` associations; no `line_item` lookup.
3. The Odoo mapper wrote `partner_id` / `date_planned` / `sale_order_id` to `mrp.production`, none of which exist in Odoo 17. The target schema is actually `sale.order` (with `partner_id`) → `mrp.production` linked via `origin` and `sale_line_id` (we use `origin` for traceability).

A supporting product-by-SKU lookup was added so HubSpot `hs_sku` strings resolve to Odoo `product.product.id`.

## User journeys

- J1: Deal closed-won with line items → MO in Odoo + writeback to HubSpot.
- J2: Deal without line items → job `skipped` with reason.
- J3: Idempotent re-runs of the same webhook update the same SO and MO (matched by `origin`).
- J4: HubSpot `hs_sku` strings resolve to Odoo product IDs via `default_code`.

## Test matrix

| # | Guarantee | Test | Result |
|---|---|---|---|
| 1 | `mustHaveLineItems` throws `SkipSyncError` when `references.lineItems` is missing | `test/composition/validators.test.js` | PASS |
| 2 | `mustHaveLineItems` throws when `references.lineItems` is `[]` | `test/composition/validators.test.js` | PASS |
| 3 | `mustHaveLineItems` passes when `references.lineItems` has ≥1 item | `test/composition/validators.test.js` | PASS |
| 4 | `getDealLineItems` returns `[]` when deal has no line_item associations | `test/adapters/hubspot/hubspotApiClient.test.js` | PASS |
| 5 | `getDealLineItems` returns `[]` when `dealId` is missing (no HTTP call) | `test/adapters/hubspot/hubspotApiClient.test.js` | PASS |
| 6 | `getDealLineItems` does 1 batch call with all IDs and maps response | `test/adapters/hubspot/hubspotApiClient.test.js` | PASS |
| 7 | `getDealLineItems` propagates errors from associations | `test/adapters/hubspot/hubspotApiClient.test.js` | PASS |
| 8 | `getDealLineItems` propagates errors from batch call | `test/adapters/hubspot/hubspotApiClient.test.js` | PASS |
| 9 | `resolveReferences` populates `lineItems` via `getDealLineItems` | `test/adapters/hubspot/HubspotSourceGateway.test.js` | PASS |
| 10 | `resolveReferences` keeps `associations` populated when line items fail | `test/adapters/hubspot/HubspotSourceGateway.test.js` | PASS |
| 11 | Mapper returns composite `{saleOrder, manufacturingOrder}` payload | `test/adapters/odoo/dealToManufacturingOrderMapper.test.js` | PASS |
| 12 | Mapper uses `productId` over `hs_sku` | `test/adapters/odoo/dealToManufacturingOrderMapper.test.js` | PASS |
| 13 | Mapper uses numeric `hs_sku` when `productId` absent | `test/adapters/odoo/dealToManufacturingOrderMapper.test.js` | PASS |
| 14 | Mapper returns `null` `product_id` when no resolvable identifier | `test/adapters/odoo/dealToManufacturingOrderMapper.test.js` | PASS |
| 15 | `createSalesOrder` uses `sale.order.create` | `test/adapters/odoo/odooApiClient.test.js` | PASS |
| 16 | `updateSalesOrder` uses `sale.order.write` with numeric ID | `test/adapters/odoo/odooApiClient.test.js` | PASS |
| 17 | `searchSalesOrderByOrigin` uses `sale.order.search` on `origin` field | `test/adapters/odoo/odooApiClient.test.js` | PASS |
| 18 | `searchProductIdsByDefaultCodes` returns map of `code→id` | `test/adapters/odoo/odooApiClient.test.js` | PASS |
| 19 | `searchProductIdsByDefaultCodes` returns `{}` for empty input | `test/adapters/odoo/odooApiClient.test.js` | PASS |
| 20 | Gateway creates SO then MO; persists `salesOrderId` in result | `test/adapters/odoo/OdooTargetGateway.test.js` | PASS |
| 21 | Gateway reuses existing SO via origin search | `test/adapters/odoo/OdooTargetGateway.test.js` | PASS |
| 22 | Gateway updates existing MO when `existingTargetId` provided | `test/adapters/odoo/OdooTargetGateway.test.js` | PASS |
| 23 | Gateway resolves SKUs to Odoo product IDs before mapping | `test/adapters/odoo/OdooTargetGateway.test.js` | PASS |
| 24 | Gateway skips SKU lookup when all items have numeric IDs | `test/adapters/odoo/OdooTargetGateway.test.js` | PASS |
| 25 | Gateway falls back gracefully when SKU lookup fails | `test/adapters/odoo/OdooTargetGateway.test.js` | PASS |
| 26 | `ProcessSyncJobUseCase` stores `salesOrderId` in mapping metadata | `test/application/use-cases.test.js` | PASS |
| 27 | E2E flow: webhook → job → upsert → writeback | `test/e2e/full-flow.test.js` | PASS |
| 28 | Writeback writes only `id_orden_odoo` (preserves customer ID) | `test/composition/dealSyncModule.test.js` | PASS |

**Total: 234/234 tests passing across 37 files.** One pre-existing test (`MongoAuditTrail > records entries`) is flaky due to `createdAt` resolution under load — unrelated to this fix.

## Coverage (key files)

| File | Lines | Branches |
|---|---|---|
| `src/composition/validators.js` | 100% | 83.33% |
| `src/adapters/outbound/odoo/dealToManufacturingOrderMapper.js` | 100% | 68.18% |
| `src/adapters/outbound/odoo/OdooTargetGateway.js` | 100% | 100% |
| `src/adapters/outbound/odoo/odooApiClient.js` | 100% | 91.42% |
| `src/adapters/outbound/hubspot/HubspotSourceGateway.js` | 95.65% | 50% |
| `src/adapters/outbound/hubspot/hubspotApiClient.js` | 83.33% | 65.38% |

## End-to-end real verification

Setup: deal `62939072525` ("prueba odoo", `closedwon`, `id_cliente_odoo=9`), with line item `hs_sku="4001/2905U"` ("ACEITE CAJA DE CADENA"). Odoo had no `mrp.production` model until the user installed the Manufacturing module. Then I created a `product.product` in Odoo via API with `default_code="4001/2905U"` (id=4) and `type=consu`.

Webhook fired: `POST /webhooks/hubspot` with `objectId=62939072525` and correct `x-smartflow-secret`.

Server log (final attempt):

```
"job.processing.start"
"odoo.upsert.salesOrder.update" salesOrderId="2"
"odoo.upsert.create" targetId="1" salesOrderId="2"
"hubspot.writeBack" sourceId="62939072525" properties={"id_orden_odoo":"1"}
```

Mongo state after:

```js
db.jobs.findOne({_id: ObjectId("6a5fcb1523e902bec1c8a2e0")})
// status: "COMPLETED", lastError: null, completedAt: ...

db.mappings.findOne({sourceId: "62939072525"})
// {
//   sourceId: "62939072525",
//   targetId: "1",                    // MO id in Odoo
//   metadata: { salesOrderId: "2", lastJobId: "6a5fcb1523e902bec1c8a2e0" }
// }
```

HubSpot after:

```json
{ "dealname": "prueba odoo", "dealstage": "closedwon",
  "id_cliente_odoo": "9", "id_orden_odoo": "1" }
```

Odoo after:

```json
// sale.order id=2
{ "name": "S00003", "origin": "hs:62939072525",
  "partner_id": [9, "Cliente Demo Smartflow"], "state": "draft" }

// mrp.production id=1
{ "name": "WH/MO/00005", "origin": "hs:62939072525",
  "product_id": [4, "[4001/2905U] ACEITE CAJA DE CADENA"],
  "product_qty": 1.0, "state": "draft" }
```

Audit trail (final run): `job.processing.start → source.fetched → source.references.resolved → validators.passed → target.upserted → mapping.upserted → source.writeback.done → job.completed` — all `success=true`.

## Known limitations / follow-ups

- `mrp.production.sale_line_id` programmatic link is not set; traceability is via the shared `origin` field (`hs:<DEAL_ID>`) and `mapping.metadata.salesOrderId`. To link explicitly, the gateway would need to fetch the created `sale.order.line` IDs and set `sale_line_id` on the MO. Out of scope for this iteration.
- `hubspot.resolveReferences.associations` still logs a 400 warning: the v4 association endpoint rejects comma-separated `toObjectType`. Fall-through is safe (returns `[]`), but a follow-up could split into separate calls.
- The flaky `MongoAuditTrail` test should be stabilized with explicit ordering or a higher-precision timestamp.

## Commit
Single commit on `main`: `fix(sync): line items + sale.order orchestration + SKU lookup`.
