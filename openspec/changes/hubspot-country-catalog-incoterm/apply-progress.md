# Apply Progress: hubspot-country-catalog-incoterm

## Mode
Strict TDD

## Completed Tasks (cumulative)

### Phase 1: Domain Classifier (Foundation) — Unit 1 of 4 chained PRs — COMPLETE (merged, PR #9)
- [x] 1.1 RED — `test/core/domain/quoteCountryValue.test.js`: table test for `absent/unset/legacy_iso/operation_cost_id/unrecognized` incl. `'sin_definir'`, `' CR '`, `'cr'`, `'78'`, `'0'`, `'78abc'`, `null`
- [x] 1.2 GREEN — Created `src/core/domain/quoteCountryValue.js`: `QUOTE_COUNTRY_UNSET`, `isUnsetQuoteCountry`, `classifyQuoteCountryValue`
- [x] 1.3 REFACTOR — Confirmed no other module duplicates this logic (ripgrep for `sin_definir`/ISO regex found only unrelated property-name string literals and the untouched legacy `resolveCountryIdFromIsoCode` in `OdooTargetGateway.js`, out of scope for this unit)

### Phase 2: Gateway Numeric-Id Resolution (D2–D4) — Unit 2 of 4 chained PRs — COMPLETE (merged, PR #10)
- [x] 2.1 RED — Added `pickCountryExpenseById` hit + 4 error-row tests (invalid id, `listOperationCosts` unsupported, lookup throws, id not found) to `test/adapters/odoo/OdooTargetGateway.countryCode.test.js`; each asserts `searchCountryIdsByCodes`/`readPartnerCountries` never called
- [x] 2.2 GREEN — Added + exported `pickCountryExpenseById` in `OdooTargetGateway.js`, matching the design's error table and the existing `pickCountryExpenseRecord` result shape/conventions (try/catch + `logger.warn`, `empty` template)
- [x] 2.3 RED — Added 3 dispatch tests in the same file: `unset` kind → `reason:'quote_country_unset'`, no walk; `unrecognized` → `reason:'quote_country_value_unrecognized'` + `logger.warn`, no walk; `operation_cost_id` → delegates to `pickCountryExpenseById` (asserts `searchCountryIdsByCodes`/`readPartnerCountries` never called)
- [x] 2.4 RED — Added `reason:'legacy_iso_value'` (D4) assertions to the 4 existing successful-ISO-pick tests; left `partner_walk_after_iso_miss` (2 tests) and `quote_country_iso_not_found` (1 test) assertions untouched
- [x] 2.5 GREEN — Rewrote `resolveCountryExpenseFromQuote`'s dispatch head in `OdooTargetGateway.js` to classify `quote.properties[this.propertyQuoteCountry]` via `classifyQuoteCountryValue` first, then branch by `kind`; legacy ISO block kept verbatim except the successful-pick branch now returns `{ ...picked, reason: 'legacy_iso_value' }`
- [x] 2.6 REFACTOR — Focused file 25/25 green, then full suite 1116/1116 green (up from 1108 by exactly the 8 new tests)

### Phase 3: Eligibility & Validator Guards (D5) — Unit 3 of 4 chained PRs — COMPLETE (PR #11, open)
- [x] 3.1 RED — Added `sin_definir` case to `HubspotSourceGateway.quote.test.js`: `isEligibleQuote` → `eligible:false, reason:'missing_country'`
- [x] 3.2 GREEN — `HubspotSourceGateway.js` `isEligibleQuote` now also checks `isUnsetQuoteCountry(country)` alongside the existing null/blank check
- [x] 3.3 RED — Added `sin_definir` → `SkipSyncError` case and an explicit no-quoteId + `sin_definir` no-op case to `validators.quote.test.js`
- [x] 3.4 GREEN — `validators.js` `createMustHaveQuoteCountry` now also checks `isUnsetQuoteCountry(country)`; the pre-existing `!record.quoteId` early return (legacy/deal path no-op) is untouched

## Remaining Tasks (not started)
- [ ] Phase 4: Property Schema + Catalog Sync Script — PR 4, needs Units 1–2 shipped (both merged)
- [ ] Phase 5 (optional, deferred): Probe Duplicate-Name Reporting

## Files Changed

### Unit 1 batch
| File | Action | What Was Done |
|------|--------|----------------|
| `src/core/domain/quoteCountryValue.js` | Created | Pure classifier: `QUOTE_COUNTRY_UNSET`, `isUnsetQuoteCountry`, `classifyQuoteCountryValue` |
| `test/core/domain/quoteCountryValue.test.js` | Created | 23 table-driven unit tests |

### Unit 2 batch
| File | Action | What Was Done |
|------|--------|----------------|
| `src/adapters/outbound/odoo/OdooTargetGateway.js` | Modified | Added `require('../../../core/domain/quoteCountryValue')`; added module-level exported `pickCountryExpenseById(operationCostId, {apiClient, logger, correlationId})`; rewrote `resolveCountryExpenseFromQuote`'s dispatch head to branch on `classifyQuoteCountryValue(raw).kind`; tagged the legacy-ISO successful pick with `reason:'legacy_iso_value'`; exported `pickCountryExpenseById` |
| `test/adapters/odoo/OdooTargetGateway.countryCode.test.js` | Modified | Added `pickCountryExpenseById` import; added 5 hit/error tests + 3 dispatch tests; added `reason:'legacy_iso_value'` assertions to 4 pre-existing tests |

No changes to `HubspotSourceGateway.js`, `validators.js`, `quotePropertyDefinitions.js`, or `sync-quote-country-options.js` in Unit 2 — out of scope for that unit.

### Unit 3 batch
| File | Action | What Was Done |
|------|--------|----------------|
| `src/adapters/outbound/hubspot/HubspotSourceGateway.js` | Modified | Added `require` of `isUnsetQuoteCountry`; `isEligibleQuote`'s country check now also treats `sin_definir` as missing (`reason:'missing_country'` unchanged) |
| `src/composition/validators.js` | Modified | Added `require` of `isUnsetQuoteCountry`; `createMustHaveQuoteCountry` now also treats `sin_definir` as missing; the `!record.quoteId` early-return no-op is untouched |
| `test/adapters/hubspot/HubspotSourceGateway.quote.test.js` | Modified | Added 1 test |
| `test/composition/validators.quote.test.js` | Modified | Added 2 tests |

Only additive one-line guard changes in both Unit 3 production files — no rewrites.

## TDD Cycle Evidence

| Task | Test File | Layer | RED | GREEN | TRIANGULATE |
|------|-----------|-------|-----|-------|-------------|
| 1.1–1.3 | `quoteCountryValue.test.js` | Unit | ✅ | ✅ 23/23 | ✅ 23 cases across all 5 kinds |
| 2.1–2.6 | `OdooTargetGateway.countryCode.test.js` | Unit | ✅ | ✅ 25/25 | ✅ 5+3 cases + 4 reason-tag assertions |
| 3.1–3.4 | `HubspotSourceGateway.quote.test.js` + `validators.quote.test.js` | Unit | ✅ | ✅ 24/24 + 8/8 | ✅ throw case + no-op-preserved case |

### Exact diff of D4 reason-string assertion changes (Unit 2)
```diff
@@ prefers ISO from record.quote over the partner walk
     expect(result.metadata.countryExpense.countryId).toBe(50)
+    expect(result.metadata.countryExpense.reason).toBe('legacy_iso_value')
     expect(api.readPartnerCountries).not.toHaveBeenCalled()

@@ wires origin/note from record.dealId+quoteId+quote explicitly, not derived from record.id
-    await gw.upsert({ record, references: { lineItems: [...] } })
+    const result = await gw.upsert({ record, references: { lineItems: [...] } })
     const soPayload = api.createSalesOrder.mock.calls[0][0]
     expect(soPayload.origin).toBe('hs:D-9:qQ-9')
     expect(soPayload.note).toBe('Deal: Fan-Out Demo\nCotización: Cotiz GT (GT)')
+    expect(result.metadata.countryExpense.reason).toBe('legacy_iso_value')

@@ adds a distinct ambiguous-note marker when the country resolves but operation.costs has no exact DDP match
     expect(result.metadata.countryExpense.ambiguous).toBe(true)
+    expect(result.metadata.countryExpense.reason).toBe('legacy_iso_value')
     const soPayload = api.createSalesOrder.mock.calls[0][0]

@@ adds no smartflow marker when the country resolves to an exact DDP match (unambiguous)
     expect(result.metadata.countryExpense.ambiguous).toBe(false)
+    expect(result.metadata.countryExpense.reason).toBe('legacy_iso_value')
     const soPayload = api.createSalesOrder.mock.calls[0][0]
```
No assertions on `partner_walk_after_iso_miss` or `quote_country_iso_not_found` were touched.

## Full-Suite Regression Check
- Unit 1 alone: 101 files, 1108 tests, all passed.
- Unit 2 alone (branched from Unit 1): 101 files, 1116 tests, all passed (+8).
- Unit 3 alone (branched from Unit 1, sibling of Unit 2): 101 files, 1111 tests, all passed (+3 vs. Unit-1-only baseline; Unit 2's +8 correctly absent on that branch, not a regression).
- After merging Units 1+2 to `main`: verified 1116/1116 by the orchestrator before commit.

## Deviations from Design
None across all three units — each matches design.md's decisions (D2–D5) exactly. `operationCostsResolver.js` and the no-quote `resolveCountryExpense` legacy path were not touched, per the explicit non-goal.

## Issues Found
None.

## Workload / PR Boundary
- Mode: stacked-to-main, chained PR slice (auto-chain, resolved 2026-08-22)
- Unit 1: `src/core/domain/quoteCountryValue.js` + test only. Merged as PR #9.
- Unit 2: `OdooTargetGateway.js` + its countryCode test only, ~150 net lines. Merged as PR #10.
- Unit 3: `HubspotSourceGateway.js` + `validators.js` + their 2 test files, ~30 net lines. PR #11, open.
- Unit 4 (next): Property schema + catalog sync script rewrite — needs Units 1–2 (both merged now).

## Status
Units 1–3 complete (16/20 tasks, Phases 1–3 of 5). Unit 1 and Unit 2 merged to `main`. Unit 3 open as PR #11. Ready for `sdd-apply` to continue with Phase 4 (Unit 4) on a fresh branch off updated `main`.
