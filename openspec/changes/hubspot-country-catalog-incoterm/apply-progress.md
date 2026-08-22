# Apply Progress: hubspot-country-catalog-incoterm

## Mode
Strict TDD

## Completed Tasks (cumulative)

### Phase 1: Domain Classifier (Foundation) — Unit 1 of 4 chained PRs — COMPLETE
- [x] 1.1 RED — `test/core/domain/quoteCountryValue.test.js`: table test for `absent/unset/legacy_iso/operation_cost_id/unrecognized` incl. `'sin_definir'`, `' CR '`, `'cr'`, `'78'`, `'0'`, `'78abc'`, `null`
- [x] 1.2 GREEN — Created `src/core/domain/quoteCountryValue.js`: `QUOTE_COUNTRY_UNSET`, `isUnsetQuoteCountry`, `classifyQuoteCountryValue`
- [x] 1.3 REFACTOR — Confirmed no other module duplicates this logic (ripgrep for `sin_definir`/ISO regex found only unrelated property-name string literals and the untouched legacy `resolveCountryIdFromIsoCode` in `OdooTargetGateway.js`, out of scope for this unit)

### Phase 3: Eligibility & Validator Guards (D5) — Unit 3 of 4 chained PRs — COMPLETE (this branch)
- [x] 3.1 RED — Added `sin_definir` case to `HubspotSourceGateway.quote.test.js`: `isEligibleQuote` → `eligible:false, reason:'missing_country'`
- [x] 3.2 GREEN — `HubspotSourceGateway.js` `isEligibleQuote` now also checks `isUnsetQuoteCountry(country)` alongside the existing null/blank check
- [x] 3.3 RED — Added `sin_definir` → `SkipSyncError` case and an explicit no-quoteId + `sin_definir` no-op case to `validators.quote.test.js`
- [x] 3.4 GREEN — `validators.js` `createMustHaveQuoteCountry` now also checks `isUnsetQuoteCountry(country)`; the pre-existing `!record.quoteId` early return (legacy/deal path no-op) is untouched

Note: this branch was cut from `main` with only Unit 1 (`quoteCountryValue.js`) merged. Unit 2 (gateway numeric-id path in `OdooTargetGateway.js`) is a sibling PR not present here — Unit 3 depends only on Unit 1, per launch scope, so this is expected and not a regression.

## Remaining Tasks (not started — future units, tracked separately)
- [ ] Phase 2: Gateway Numeric-Id Resolution (D2–D4) — PR 2 (sibling branch, independent of Unit 3)
- [ ] Phase 4: Property Schema + Catalog Sync Script — PR 4, needs Units 1–2 shipped
- [ ] Phase 5 (optional, deferred): Probe Duplicate-Name Reporting

## Files Changed (Unit 1 batch)
| File | Action | What Was Done |
|------|--------|----------------|
| `src/core/domain/quoteCountryValue.js` | Created | Pure classifier: `QUOTE_COUNTRY_UNSET` sentinel, `isUnsetQuoteCountry(raw)`, `classifyQuoteCountryValue(raw)` returning `{kind, value, operationCostId}` per design.md's dispatch table |
| `test/core/domain/quoteCountryValue.test.js` | Created | 23 unit tests covering all 5 `kind` values incl. edge cases from design/tasks table (`'sin_definir'`, `' CR '`, `'cr'`, `'78'`, `'0'`, `'78abc'`, `null`, `undefined`, whitespace-only, case-insensitivity, never-throws) |
| `openspec/changes/hubspot-country-catalog-incoterm/tasks.md` | Modified | Marked 1.1–1.3 `[x]` |

No existing files were touched — this PR is self-contained (new file + new test file only), matching the design's "zero existing callers yet" scope for Unit 1.

## Files Changed (Unit 3 batch)
| File | Action | What Was Done |
|------|--------|----------------|
| `src/adapters/outbound/hubspot/HubspotSourceGateway.js` | Modified | Added `require` of `isUnsetQuoteCountry` from `core/domain/quoteCountryValue`; `isEligibleQuote`'s country check now also treats the `sin_definir` sentinel as missing (`reason:'missing_country'` unchanged) |
| `src/composition/validators.js` | Modified | Added `require` of `isUnsetQuoteCountry`; `createMustHaveQuoteCountry` now also treats `sin_definir` as missing; the `!record.quoteId` early-return no-op is untouched |
| `test/adapters/hubspot/HubspotSourceGateway.quote.test.js` | Modified | Added 1 test: `sin_definir` → `isEligibleQuote` `{eligible:false, reason:'missing_country'}` |
| `test/composition/validators.quote.test.js` | Modified | Added 2 tests: `sin_definir` on a quote job → `SkipSyncError`; `sin_definir` on a no-`quoteId` (legacy deal) record → still no-op |
| `openspec/changes/hubspot-country-catalog-incoterm/tasks.md` | Modified | Marked 3.1–3.4 `[x]` |

Only additive one-line guard changes alongside existing presence checks in both production files — no rewrites, matching the launch's design constraint.

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1 | `test/core/domain/quoteCountryValue.test.js` | Unit | N/A (new file) | ✅ Written — referenced `src/core/domain/quoteCountryValue.js` before it existed; confirmed failure: `Cannot find module '../../../src/core/domain/quoteCountryValue.js'` | ✅ Passed after 1.2 | ✅ 23 cases across all 5 `kind`s + `isUnsetQuoteCountry` boolean helper (2+ cases per behavior) | N/A — task is the test itself |
| 1.2 | `src/core/domain/quoteCountryValue.js` | Unit | N/A (new file) | ✅ (from 1.1) | ✅ `npx vitest run test/core/domain/quoteCountryValue.test.js` → 23/23 passed | ✅ Covered by 1.1's table | ✅ Clean — no duplication, single-purpose pure functions, no magic numbers beyond the two named regex constants |
| 1.3 | N/A (audit task) | N/A | N/A | N/A | N/A | N/A | ✅ Confirmed via `rg` — no other module reimplements the ISO/id classification logic; legacy `resolveCountryIdFromIsoCode` in `OdooTargetGateway.js` is untouched, out-of-scope, and will be dispatched to (not duplicated) in Phase 2 |
| 3.1 | `test/adapters/hubspot/HubspotSourceGateway.quote.test.js` | Unit | ✅ 23/23 (baseline before edit) | ✅ Written — `sin_definir` case failed against pre-3.2 code (`expected true to be false`) | ✅ 24/24 after 3.2 | ➖ Single new case; existing null/empty-string cases already triangulate the presence branch | ➖ None needed — one-line guard addition |
| 3.2 | `src/adapters/outbound/hubspot/HubspotSourceGateway.js` | Unit | ✅ (from 3.1) | ✅ (from 3.1) | ✅ `npx vitest run test/adapters/hubspot/HubspotSourceGateway.quote.test.js` → 24/24 passed | ✅ Covered by 3.1 | ➖ None needed |
| 3.3 | `test/composition/validators.quote.test.js` | Unit | ✅ 6/6 (baseline before edit) | ✅ Written — `sin_definir` SkipSyncError case failed against pre-3.4 code (`expected function to throw, but it didn't`); companion no-quoteId no-op case passed trivially (pre-existing early-return already covers it) | ✅ 8/8 after 3.4 | ✅ 2 cases (throws case + no-op-preserved case) | ➖ None needed |
| 3.4 | `src/composition/validators.js` | Unit | ✅ (from 3.3) | ✅ (from 3.3) | ✅ `npx vitest run test/composition/validators.quote.test.js` → 8/8 passed | ✅ Covered by 3.3 | ➖ None needed — one-line guard addition, early-return order preserved |

### Test Summary
- Total tests written: 26 (23 Unit 1 + 3 Unit 3: 1 in HubspotSourceGateway.quote.test.js, 2 in validators.quote.test.js)
- Total tests passing: 26
- Layers used: Unit (26)
- Approval tests (refactoring): None — no refactoring tasks
- Pure functions created: 2 (`isUnsetQuoteCountry`, `classifyQuoteCountryValue`, both from Unit 1; Unit 3 only calls `isUnsetQuoteCountry`)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result (Unit 1) | `npx vitest run test/core/domain/quoteCountryValue.test.js` → 1 file, 23 tests, all passed |
| Focused test command and exact result (Unit 3) | `npx vitest run test/adapters/hubspot/HubspotSourceGateway.quote.test.js test/composition/validators.quote.test.js` → 2 files, 32 tests, all passed (baseline 29/29) |
| Runtime harness command/scenario and exact result | N/A — pure classifier + unit-mocked gateway/validator, no I/O, no runtime boundary (per tasks.md Unit 1 and Unit 3 rows) |
| Rollback boundary (Unit 1) | Delete `src/core/domain/quoteCountryValue.js` and `test/core/domain/quoteCountryValue.test.js`; no other file depends on either yet |
| Rollback boundary (Unit 3) | Revert the 2 one-line guard additions in `HubspotSourceGateway.js` (`isEligibleQuote`) and `validators.js` (`createMustHaveQuoteCountry`) plus their test additions; defense-in-depth only, no other caller depends on the new checks |

## Full-Suite Regression Check
Unit 1: `npx vitest run` (full suite) → 101 files, 1108 tests, all passed.

Unit 3 (this batch): `npx vitest run` (full suite) → 101 files, 1111 tests, all passed (was 1108 before this batch, +3 new tests). This branch was cut from `main` with only Unit 1 merged, so Unit 2's `OdooTargetGateway.js` additions (+8 tests, sibling PR) are correctly absent here — not a regression.

## Deviations from Design
None — implementation matches design.md's D5 decision exactly (`isEligibleQuote` reuses the existing `missing_country` reason; `createMustHaveQuoteCountry`'s no-quoteId early return preserved verbatim).

## Issues Found
None.

## Workload / PR Boundary
- Mode: stacked-to-main, chained PR slice (auto-chain, resolved 2026-08-22)
- Current work unit: Unit 3 of 4 — Eligibility & Validator Guards (D5)
- Boundary: `HubspotSourceGateway.js` + `validators.js` + their 2 test files only; depends only on Unit 1's merged `quoteCountryValue.js` (Unit 2 is an independent sibling, not a dependency)
- Estimated review budget impact: ~30 lines net, well under the 400-line guard

## Status
12/12 tasks across Units 1 and 3 complete on this branch (Phases 1 and 3 of 5). Ready for verify (Unit 3 scope) or for sdd-apply to continue with Phase 4 (needs Units 1–2 shipped first).
