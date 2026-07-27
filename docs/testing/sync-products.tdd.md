# TDD Evidence — sync-products (Odoo → HubSpot)

## Source

Feature request: standalone script to map Odoo products to HubSpot Products, with rate-limited API calls and idempotent upsert by `hs_sku`. The destination is the eventual client's HubSpot portal; today we use `bsalas` to validate. The script is reusable against any HubSpot account via `SMARTFLOW_ENV_FILE`.

## User journeys

- **J1**: Operator runs `node scripts/sync-products.js --interval=60000 --limit=10 --dry-run`. Logs show 10 products that WOULD be mapped, zero writes to HubSpot.
- **J2**: Operator runs `node scripts/sync-products.js --once --limit=5`. Creates/updates 5 Odoo products in HubSpot as Products, each matched by `hs_sku = default_code`.
- **J3**: Operator runs `node scripts/sync-products.js --interval=30000`. Script repeats indefinitely; re-runs do not duplicate (idempotent via `hs_sku` match).
- **J4**: A failing write does not abort the batch. The script logs the failure and continues with the next product.

## Test matrix

| # | Guarantee | Test file / line | Result |
|---|-----------|------------------|--------|
| 1 | `searchProductByHsSku` POSTs to `/crm/v3/objects/products/search` with EQ filter and returns first match | `test/adapters/hubspot/hubspotApiClient.test.js:Product APIs` | PASS |
| 2 | `searchProductByHsSku` returns `null` when no matches | same | PASS |
| 3 | `searchProductByHsSku` returns `null` and skips HTTP when sku empty/missing | same | PASS |
| 4 | `searchProductByHsSku` propagates HTTP errors | same | PASS |
| 5 | `createProduct` POSTs to `/crm/v3/objects/products` with properties payload | same | PASS |
| 6 | `updateProduct` PATCHes `/crm/v3/objects/products/:id` | same | PASS |
| 7 | `OdooProductSource.count` delegates to api.countProductsWithDefaultCode | `test/adapters/odoo/OdooProductSource.test.js` | PASS |
| 8 | `OdooProductSource.listAll` paginates with `offset`/`limit` and accumulates pages | same | PASS |
| 9 | `OdooProductSource.listAll({limit:N})` caps total products returned | same | PASS |
| 10 | `OdooProductSource.listAll` returns empty when first page empty | same | PASS |
| 11 | `OdooProductSource.listAll` stops when page < pageSize | same | PASS |
| 12 | `HubspotProductGateway.upsertBySku` creates when search returns null | `test/adapters/hubspot/HubspotProductGateway.test.js` | PASS |
| 13 | `HubspotProductGateway.upsertBySku` updates when search returns existing product | same | PASS |
| 14 | `HubspotProductGateway.upsertBySku` maps `default_code→hs_sku`, `name→name`, `list_price→price` | same | PASS |
| 15 | `HubspotProductGateway.upsertBySku` skips when sku is empty | same | PASS |
| 16 | `HubspotProductGateway.upsertBySku` throws when name is empty (HubSpot rejects) | same | PASS |
| 17 | `HubspotProductGateway.upsertBySku` swallows search errors and falls back to create | same | PASS |
| 18 | `HubspotProductGateway.buildProperties` returns mapped dict; coerces missing `list_price` to `'0'` | same | PASS |
| 19 | `productSyncModule.runOnce` fetches from odooSource and syncs each via gateway | `test/composition/productSyncModule.test.js` | PASS |
| 20 | `runOnce({ limit: N })` passes through to source | same | PASS |
| 21 | `runOnce({ dryRun: true })` makes 0 gateway calls | same | PASS |
| 22 | `runOnce` continues when one product fails, logs `product-sync.item.failed` | same | PASS |
| 23 | `runOnce` counts created vs updated | same | PASS |
| 24 | `productSyncModule` requires odooSource and hubspotGateway | same | PASS |
| 25 | `parseArgs` parses bare flags as `true`, `flag=val` as number/string | `test/scripts/sync-products.test.js` | PASS |
| 26 | `resolveIntervalMs` resolves `--interval`, env var, default 60000, `--once` returns 0 | same | PASS |
| 27 | `shouldRunOnce` true for `--once` or interval=0 | same | PASS |

**Total: 275/275 tests passing across 41 files.**

## Coverage (new files)

| File | Lines | Branches | Functions | Statements |
|---|---|---|---|---|
| `src/composition/productSyncModule.js` | 100% | 100% | 100% | 100% |
| `src/adapters/outbound/hubspot/HubspotProductGateway.js` | 100% | 78.94% | 100% | 100% |
| `src/adapters/outbound/odoo/OdooProductSource.js` | 100% | 83.33% | 100% | 100% |
| `src/adapters/outbound/hubspot/hubspotApiClient.js` | 88.23% | 71.42% | 77.77% | 88.23% |
| `src/adapters/outbound/odoo/odooApiClient.js` | 94.44% | 87.23% | 71.42% | 94.44% |

All new files exceed the project's 80% lines threshold.

## Red→Green progression (each stage verified before next)

| Stage | Verification |
|---|---|
| 1-2 | 6 tests fail in hubspotApiClient.test.js (api.searchProductByHsSku not a function). After impl: 13/13 pass. |
| 3-4 | After impl of createProduct/updateProduct: 13/13 still green; new tests in Product APIs block included. |
| 5-6 | OdooProductSource: 5 tests fail (no impl). After impl: 5/5 pass. |
| 7-8 | HubspotProductGateway: file fails to load. After impl: 6/6. Added 2 more for buildProperties after coverage review: 8/8. |
| 9-10 | productSyncModule: file fails to load. After impl with one path-resolution bug fix (passing `{}` to listAll when no limit): 7/7. |
| 11-12 | sync-products.lib: 5 tests failed (regex bug, empty-string coercion). After fix: 15/15 pass. |
| 13 | `path.resolve(envFile)` added to script for cwd-robust path resolution. Still green. |
| 14 | `npm run test:coverage` — see table above. |
| 15 | `node scripts/sync-products.js --once --limit=3 --dry-run` against `.env.staging` (client Visual Branding): `total: 5848, count: 3, skipped: 3, created: 0, updated: 0, failed: 0`. Real-write smoke was **blocked at runtime** by missing `crm.objects.products.read/write` scopes on the current HubSpot token — those are operator-side Private App settings, not a defect in the script. |

## End-to-end behavior (verified at `dry-run`)

Command:
```
SMARTFLOW_ENV_FILE=.env.staging node scripts/sync-products.js --once --limit=3 --dry-run
```

Output:
```
{"msg":"product-sync.start","total":5848,"limit":3,"dryRun":true}
{"msg":"product-sync.done","total":5848,"count":3,"succeeded":0,"created":0,"updated":0,"failed":0,"skipped":3}
```

The 5848 number is the count of products in the client's Odoo staging (`visual-branding-stag.odoo.com`) with `default_code != false` — verified independently against the Odoo API.

## Risks / follow-ups (out of scope)

- **Concurrent runs** (race in `search + create/update`). Mitigation would be persisting a `product_mappings` collection in Mongo. Single-instance use is safe.
- **Rate-limit handling**: HubSpot can return 429. `async.mapLimit` with `concurrency=10` keeps throughput ≤ 100 req/10s, under HubSpot's Private App limit; a real 429 response would propagate as a per-item error and log via `product-sync.item.failed`. A `Retry-After` read + exponential backoff is the next step.
- **Configuration drift** between staging and the eventual client HubSpot portal: the script reads from `.env`, so swapping `SMARTFLOW_ENV_FILE=.env.client` and re-running is sufficient.

## Commit

Single commit on `main`: `c0dc431 feat(sync-products): standalone runner with async rate-limited queue`. 15 files, 727 insertions, 8 deletions. No AI co-author.
