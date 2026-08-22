# Apply Progress: hubspot-country-catalog-incoterm

## Mode
Strict TDD

## Completed Tasks (cumulative)

### Phase 1: Domain Classifier (Foundation) — Unit 1 of 4 chained PRs — COMPLETE
- [x] 1.1 RED — `test/core/domain/quoteCountryValue.test.js`: table test for `absent/unset/legacy_iso/operation_cost_id/unrecognized` incl. `'sin_definir'`, `' CR '`, `'cr'`, `'78'`, `'0'`, `'78abc'`, `null`
- [x] 1.2 GREEN — Created `src/core/domain/quoteCountryValue.js`: `QUOTE_COUNTRY_UNSET`, `isUnsetQuoteCountry`, `classifyQuoteCountryValue`
- [x] 1.3 REFACTOR — Confirmed no other module duplicates this logic (ripgrep for `sin_definir`/ISO regex found only unrelated property-name string literals and the untouched legacy `resolveCountryIdFromIsoCode` in `OdooTargetGateway.js`, out of scope for this unit)

### Phase 2: Gateway Numeric-Id Resolution (D2–D4) — Unit 2 of 4 chained PRs — COMPLETE
- [x] 2.1 RED — Added `pickCountryExpenseById` hit + 4 error-row tests (invalid id, `listOperationCosts` unsupported, lookup throws, id not found) to `test/adapters/odoo/OdooTargetGateway.countryCode.test.js`; each asserts `searchCountryIdsByCodes`/`readPartnerCountries` never called
- [x] 2.2 GREEN — Added + exported `pickCountryExpenseById` in `OdooTargetGateway.js`, matching the design's error table and the existing `pickCountryExpenseRecord` result shape/conventions (try/catch + `logger.warn`, `empty` template)
- [x] 2.3 RED — Added 3 dispatch tests in the same file: `unset` kind → `reason:'quote_country_unset'`, no walk; `unrecognized` → `reason:'quote_country_value_unrecognized'` + `logger.warn`, no walk; `operation_cost_id` → delegates to `pickCountryExpenseById` (asserts `searchCountryIdsByCodes`/`readPartnerCountries` never called)
- [x] 2.4 RED — Added `reason:'legacy_iso_value'` (D4) assertions to the 4 existing successful-ISO-pick tests (`prefers ISO from record.quote...`, `wires origin/note...`, `adds a distinct ambiguous-note marker...`, `adds no smartflow marker...`); left `partner_walk_after_iso_miss` (2 tests) and `quote_country_iso_not_found` (1 test) assertions untouched, exactly as written before this batch
- [x] 2.5 GREEN — Rewrote `resolveCountryExpenseFromQuote`'s dispatch head in `OdooTargetGateway.js` to classify `quote.properties[this.propertyQuoteCountry]` via `classifyQuoteCountryValue` first, then branch by `kind`; the legacy ISO block is kept verbatim except the successful-pick branch now returns `{ ...picked, reason: 'legacy_iso_value' }` instead of `picked` as-is (D4); the `partner_walk_after_iso_miss` branch is untouched
- [x] 2.6 REFACTOR — Ran the focused test file (25/25 green) then the full suite (1116/1116 green, up from the 1108 baseline by exactly the 8 new tests); no other file changed

## Remaining Tasks (not started — future units)
- [ ] Phase 3: Eligibility & Validator Guards (D5) — PR 3, needs Unit 1 merged
- [ ] Phase 4: Property Schema + Catalog Sync Script — PR 4, needs Units 1–2 shipped
- [ ] Phase 5 (optional, deferred): Probe Duplicate-Name Reporting

## Files Changed (this batch — Unit 2)
| File | Action | What Was Done |
|------|--------|----------------|
| `src/adapters/outbound/odoo/OdooTargetGateway.js` | Modified | Added `require('../../../core/domain/quoteCountryValue')`; added module-level exported `pickCountryExpenseById(operationCostId, {apiClient, logger, correlationId})`; rewrote `resolveCountryExpenseFromQuote`'s dispatch head to branch on `classifyQuoteCountryValue(raw).kind` (`unset`/`unrecognized`/`operation_cost_id`/`legacy_iso`/`absent`); tagged the legacy-ISO successful pick with `reason:'legacy_iso_value'`; exported `pickCountryExpenseById` in `module.exports` |
| `test/adapters/odoo/OdooTargetGateway.countryCode.test.js` | Modified | Added `pickCountryExpenseById` import; added `describe('pickCountryExpenseById', ...)` (5 tests: hit + 4 error rows); added `describe('OdooTargetGateway.upsert — quote-country classifier dispatch', ...)` (3 tests: unset/unrecognized/operation_cost_id); added `reason:'legacy_iso_value'` assertions to the 4 pre-existing successful-ISO-pick tests |
| `openspec/changes/hubspot-country-catalog-incoterm/tasks.md` | Modified | Marked 2.1–2.6 `[x]` |

No changes to `HubspotSourceGateway.js`, `validators.js`, `quotePropertyDefinitions.js`, or `sync-quote-country-options.js` — out of scope for this unit per the launch instructions.

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.1 | `test/adapters/odoo/OdooTargetGateway.countryCode.test.js` | Unit | ✅ 17/17 (baseline before edits) | ✅ Written — referenced not-yet-exported `pickCountryExpenseById`; confirmed failure via `TypeError: pickCountryExpenseById is not a function` (import destructure resolves to `undefined`) | ✅ Passed after 2.2 | ✅ 5 cases (hit + 4 distinct error rows) | N/A — task is the test itself |
| 2.2 | `src/adapters/outbound/odoo/OdooTargetGateway.js` | Unit | ✅ (from 2.1's RED) | ✅ (from 2.1) | ✅ `npx vitest run test/adapters/odoo/OdooTargetGateway.countryCode.test.js` → 25/25 passed | ✅ Covered by 2.1's 5 cases | ✅ Clean — reused existing `empty` template pattern, try/catch + `logger.warn` convention |
| 2.3 | `test/adapters/odoo/OdooTargetGateway.countryCode.test.js` | Unit | ✅ (running total after 2.1/2.2) | ✅ Written — asserted `reason:'quote_country_unset'`/`quote_country_value_unrecognized'`/`quote_operation_cost_id'` against the pre-2.5 dispatch (still branching only on truthy ISO); confirmed failure: all 3 assertions returned the old ISO-branch/partner-walk results instead | ✅ Passed after 2.5 | ✅ 3 cases (unset, unrecognized, operation_cost_id), each also asserting no-walk via `not.toHaveBeenCalled()` | N/A — task is the test itself |
| 2.4 | `test/adapters/odoo/OdooTargetGateway.countryCode.test.js` | Unit | ✅ (running total) | ✅ Written — added `reason:'legacy_iso_value'` expectations to 4 tests still returning `'ddp_exact_match'`/`'no_ddp_exact_match'`; confirmed failure via 4 `AssertionError: expected 'ddp_exact_match' to be 'legacy_iso_value'`-style diffs | ✅ Passed after 2.5 | ➖ Single reason string per test — spec has one successful-tag outcome | N/A — task is the test itself |
| 2.5 | `src/adapters/outbound/odoo/OdooTargetGateway.js` | Unit | ✅ (from 2.1–2.4 RED, 12 failing total before this step) | ✅ (from 2.3/2.4) | ✅ `npx vitest run test/adapters/odoo/OdooTargetGateway.countryCode.test.js` → 25/25 passed (0 failing, up from 12 failing) | ✅ Covered by 2.3's 3 dispatch cases + 2.4's 4 reason-tag cases | ✅ Clean — dispatch reads as a flat if-chain matching the design's kind table; legacy ISO block body kept byte-identical apart from the one-line reason override |
| 2.6 | N/A (audit task) | N/A | N/A | N/A | N/A | N/A | ✅ Full suite: `npx vitest run` → 101 files, 1116 tests, all passed (was 1108 before this batch; net +8 = the 5 `pickCountryExpenseById` tests + 3 dispatch tests; the 4 reason-tag additions were new assertions inside already-existing tests, not new test cases) |

### Test Summary
- Total tests written this batch: 8 new test cases + 4 new assertions added to pre-existing tests
- Total tests passing (focused file): 25/25
- Total tests passing (full suite): 1116/1116
- Layers used: Unit (8 new)
- Approval tests (refactoring): None — this was additive dispatch-head rewrite, not a behavior-preserving refactor; the D4 reason-tag change is an intentional, spec-approved behavior change on the successful ISO branch only
- Pure functions created: 1 (`pickCountryExpenseById` — async but has no side effects beyond the injected `apiClient`/`logger`, mirrors `pickCountryExpenseRecord`'s existing style)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run test/adapters/odoo/OdooTargetGateway.countryCode.test.js` → 1 file, 25 tests, all passed (baseline was 17/17 before this batch) |
| Runtime harness command/scenario and exact result | N/A — mocked `apiClient` fixture only, no live I/O boundary in this unit (per tasks.md Unit 2 row) |
| Rollback boundary | Revert `resolveCountryExpenseFromQuote`/`pickCountryExpenseById` in `OdooTargetGateway.js` and the corresponding test additions in `OdooTargetGateway.countryCode.test.js`; the legacy ISO path body is untouched apart from the one-line reason override, and no other production file was touched |

## Full-Suite Regression Check
`npx vitest run` (full suite) → 101 files, 1116 tests, **all passed**. No test outside `OdooTargetGateway.countryCode.test.js` was modified. The only intentional behavior/assertion changes are the 4 `reason:'legacy_iso_value'` additions (D4); `partner_walk_after_iso_miss` and `quote_country_iso_not_found` assertions are verbatim-unchanged from before this batch.

### Exact diff of reason-string assertion changes (D4)
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
No assertions on `partner_walk_after_iso_miss` (lines asserting it in "falls back to partner walk when ISO does not resolve in Odoo" and "works without searchCountryIdsByCodes") or `quote_country_iso_not_found` (in "creates SO with status=unresolved...") were touched.

## Deviations from Design
None — implementation matches design.md's dispatch table, `pickCountryExpenseById` error table, and D2–D4 decisions exactly. `operationCostsResolver.js` and the no-quote `resolveCountryExpense` legacy path were not touched, per the explicit non-goal.

## Issues Found
None.

## Workload / PR Boundary
- Mode: stacked-to-main, chained PR slice (auto-chain, resolved 2026-08-22)
- Current work unit: Unit 2 of 4 — Gateway Numeric-Id Resolution
- Boundary: starts and ends with `src/adapters/outbound/odoo/OdooTargetGateway.js` + `test/adapters/odoo/OdooTargetGateway.countryCode.test.js`; depends on Unit 1's already-merged `src/core/domain/quoteCountryValue.js`; does not touch Phase 3/4/5 files
- Estimated review budget impact: well under the 400-line guard (~150 lines net across the two touched files)

## Status
9/9 tasks across Units 1–2 complete (Phases 1–2 of 5 phases). Ready for verify (Unit 2 scope) or for sdd-apply to continue with Phase 3 on the next branch.
