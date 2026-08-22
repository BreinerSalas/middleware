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

### Phase 4: Property Schema + Catalog Sync Script — Unit 4 of 4 chained PRs — COMPLETE
- [x] 4.1 RED — Added a `quotePropertyDefinitions.test.js` case asserting `defs[0].label`/`defs[0].description` no longer match `/ISO-2/` (or `/Código ISO/`); confirmed it failed against the still-ISO-2 text
- [x] 4.2 GREEN — `quotePropertyDefinitions.js`: `pais_de_destino` label changed from `'País de destino (ISO-2)'` to `'País de destino'`; description changed to reference the `operation.costs` catalog instead of ISO codes
- [x] 4.3 RED — Rewrote the `buildOptions` describe block in `sync-quote-country-options.test.js`: per-record options keyed by `{records}` (dropped the old `{countries, countriesWithOpCosts, usedIsos}` ISO-shaped signature entirely), placeholder-first, dedupe-by-id, blank/null-name fallback (`operation.costs #<id>`), codepoint-vs-locale sort case (`'DDP...' ` before `'ddp...'`), id-ascending tiebreak on equal labels, positive-integer-id filtering, `countryId` no longer required
- [x] 4.4 RED — Rewrote the `planOptions` describe block: per-record `plan.records`/`plan.options` assertions, uncapped-record-count case (35 records → 36 options), new `duplicateLabels` non-blocking-warning case + its empty-case counterpart, `EMPTY_OPERATION_COSTS` (zero records) and new `EMPTY_OPERATION_COSTS_OPTIONS` (records exist but none survive id filtering) guard cases, `propertyLookupFailed` case kept; all `readCountriesByIds`/ISO fixtures and the old `makeApiClient({countriesById})` helper param dropped. Ran the full rewritten test file against the still-unmodified script and confirmed 14/25 failing (RED) before touching production code.
- [x] 4.5 GREEN — Rewrote `scripts/sync-quote-country-options.js`: `buildOptions({records})` now filters to positive-integer ids, dedupes by id, derives `label` from the record's trimmed `name` (or `operation.costs #<id>` fallback), sorts via a raw-codepoint `compareOptionRecords` comparator (id-ascending tiebreak) — explicitly not `localeCompare`; `planOptions(...)` drops the `readCountriesByIds` round-trip entirely (its only remaining data source is `listOperationCosts()`), throws `EMPTY_OPERATION_COSTS` on zero records, throws new `EMPTY_OPERATION_COSTS_OPTIONS` when `buildOptions` output is placeholder-only, computes non-blocking `duplicateLabels` (`logger.warn` + returned in the plan) via a label-frequency count over the same id/name derivation as `buildOptions`; `applyOptions`'s dead fallback label string updated from `'País de destino (ISO-2)'` to `'País de destino'`; `main()`'s output swapped `usedIsos`/`resolvedCountries` for `recordCount`/`duplicateLabels`; help text updated to describe the catalog-mirroring behavior instead of the ISO country list
- [x] 4.6 REFACTOR — Confirmed `applyOptions`/`resolveDryRun` describe blocks needed zero test changes beyond the one dead fallback label string; verified no leftover `readCountriesByIds`/`usedIsos`/`resolvedCountries`/`countryMap` references remain anywhere in the script (`rg` clean); full suite re-run green (see below)

## Remaining Tasks (not started)
- [ ] Phase 5 (optional, deferred, out of scope for chained-PR delivery): Probe Duplicate-Name Reporting — live-Odoo-only, no unit-test harness, explicitly deferred per the task list

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

### Unit 4 batch
| File | Action | What Was Done |
|------|--------|----------------|
| `src/composition/quotePropertyDefinitions.js` | Modified | `pais_de_destino` label `'País de destino (ISO-2)'` → `'País de destino'`; description rewritten to describe the `operation.costs` catalog instead of ISO codes; `options`/placeholder untouched |
| `test/composition/quotePropertyDefinitions.test.js` | Modified | Added 1 test asserting label/description no longer mention ISO-2/Código ISO |
| `scripts/sync-quote-country-options.js` | Rewritten (near-total, per design's own risk note) | `buildOptions({records})` replaces `buildOptions({countries, countriesWithOpCosts, usedIsos})`; new `compareOptionRecords` codepoint+id-tiebreak comparator; `planOptions` drops `readCountriesByIds` entirely, adds `EMPTY_OPERATION_COSTS_OPTIONS` guard and `duplicateLabels` computation/warning, returns `{options, records, duplicateLabels, currentProperty, propertyLookupFailed}` (no more `usedIsos`/`countryMap`); `applyOptions`'s dead fallback label updated; `main()` output/help text updated |
| `test/scripts/sync-quote-country-options.test.js` | Rewritten (near-total) | All ISO-shaped fixtures (`countries`, `countriesWithOpCosts`, `usedIsos`, `readCountriesByIds`) removed; `buildOptions` describe block rewritten for `{records}` input (8 cases: placeholder-first, per-record, blank-name fallback, dedupe-by-id, id-filtering, codepoint-vs-locale sort, id-tiebreak, no-countryId-required); `planOptions` describe block rewritten (6 cases: per-record build, uncapped record count, duplicateLabels present/absent, `EMPTY_OPERATION_COSTS`, `EMPTY_OPERATION_COSTS_OPTIONS`, `propertyLookupFailed`); `applyOptions`/`resolveDryRun` describe blocks kept verbatim (options fixtures updated from ISO values like `'GT — Guatemala'`/`'GT'` to id-based `'DDP Guatemala'`/`'90'`, no behavioral assertion changes) |

## TDD Cycle Evidence

| Task | Test File | Layer | RED | GREEN | TRIANGULATE |
|------|-----------|-------|-----|-------|-------------|
| 1.1–1.3 | `quoteCountryValue.test.js` | Unit | ✅ | ✅ 23/23 | ✅ 23 cases across all 5 kinds |
| 2.1–2.6 | `OdooTargetGateway.countryCode.test.js` | Unit | ✅ | ✅ 25/25 | ✅ 5+3 cases + 4 reason-tag assertions |
| 3.1–3.4 | `HubspotSourceGateway.quote.test.js` + `validators.quote.test.js` | Unit | ✅ | ✅ 24/24 + 8/8 | ✅ throw case + no-op-preserved case |
| 4.1–4.2 | `quotePropertyDefinitions.test.js` | Unit | ✅ (1 failed, confirmed against pre-change text) | ✅ 7/7 | ✅ label + description both asserted |
| 4.3–4.6 | `sync-quote-country-options.test.js` | Unit | ✅ (14/25 failed, confirmed against pre-rewrite script) | ✅ 25/25 | ✅ dedupe, blank-name fallback, sort determinism, both empty guards, duplicate-label warning |

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

### Summary of the Unit 4 sync-script test rewrite
The old test file's fixtures modeled a "resolve ISO codes present in operation.costs, then look up
res.country rows for those ids" pivot (`makeApiClient({operationCosts, countriesById})`,
`buildOptions({countries, countriesWithOpCosts, usedIsos})`). That pivot no longer exists: the new
design publishes one dropdown option per raw `operation.costs` record directly, so every ISO-shaped
fixture, the `readCountriesByIds` mock, and the `usedIsos`/`countryMap` assertions were dead weight.
The rewrite kept the `applyOptions`/`resolveDryRun` describe blocks structurally identical (only
their option-value fixtures were changed from ISO values to numeric-id strings) since design.md
called out those two functions as out of scope for behavior changes.

## Full-Suite Regression Check
- Unit 1 alone: 101 files, 1108 tests, all passed.
- Unit 2 alone (branched from Unit 1): 101 files, 1116 tests, all passed (+8).
- Unit 3 alone (branched from Unit 1, sibling of Unit 2): 101 files, 1111 tests, all passed (+3 vs. Unit-1-only baseline; Unit 2's +8 correctly absent on that branch, not a regression).
- After merging Units 1+2 to `main`: verified 1116/1116 by the orchestrator before commit.
- Unit 4 (this launch, branched fresh off `main` with Units 1–3 merged): full suite 101 files, 1126 tests, all passed (+10 net over the 1116 Units-1-2 baseline: +1 property-definitions test, +9 net in the rewritten sync-script test file — 25 new cases replacing what were originally fewer ISO-shaped cases).

## Deviations from Design
None across all four units — each matches design.md's decisions (D2–D6 and the Unit 4 interface/
testing-strategy sections) exactly. `operationCostsResolver.js` and the no-quote `resolveCountryExpense`
legacy path were not touched, per the explicit non-goal. `EMPTY_OPERATION_COSTS_OPTIONS`'s exact code
name was taken verbatim from design.md's File Changes section wording ("new `EMPTY_OPERATION_COSTS_OPTIONS`").

## Issues Found
None.

## Workload / PR Boundary
- Mode: stacked-to-main, chained PR slice (auto-chain, resolved 2026-08-22)
- Unit 1: `src/core/domain/quoteCountryValue.js` + test only. Merged as PR #9.
- Unit 2: `OdooTargetGateway.js` + its countryCode test only, ~150 net lines. Merged as PR #10.
- Unit 3: `HubspotSourceGateway.js` + `validators.js` + their 2 test files, ~30 net lines. PR #11, open.
- Unit 4 (this launch): `quotePropertyDefinitions.js` + `sync-quote-country-options.js` + their 2 test files (the latter a near-total rewrite). Not committed by this agent — orchestrator to review/commit/open PR.

## Status
All 4 units of the chained-PR plan are implementation-complete (20/20 core tasks across Phases 1–4).
Units 1–2 merged to `main`. Unit 3 open as PR #11 (pending merge). Unit 4 (this launch) is implemented
and fully green on a branch cut from `main` with Units 1–3 present, but not yet committed — awaiting
orchestrator review/commit/PR. Phase 5 (probe duplicate-name reporting) remains explicitly deferred:
live-Odoo-only, no unit-test harness, out of scope for this chained-PR delivery.
