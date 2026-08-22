# Tasks: HubSpot country dropdown → explicit `operation.costs` catalog

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~830–870 (additions+deletions) |
| 400-line budget risk (vs 800 actual budget) | High |
| Chained PRs recommended | Yes |
| Suggested split | 4 work units below (feature-branch-chain or stacked-to-main) |
| Delivery strategy | single-pr |
| Chain strategy | pending — flagged back to orchestrator |

Decision needed before apply: Resolved 2026-08-22
Chained PRs recommended: Yes
Chain strategy: **stacked-to-main** (each unit merges to main before the next opens, matching this repo's existing PR #4–#8 precedent)
Delivery strategy: **auto-chain** (supersedes the initial `single-pr` preflight choice, per user decision)
400-line budget risk: High (per-unit, all under the 800-line budget)

**Resolved**: user confirmed proceeding as 4 sequential PRs to `main` in the order below (Unit 1 → 2/3 in either order → 4 → optional 5), instead of `size:exception` on one large PR.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Domain classifier `quoteCountryValue.js` | PR 1 | `npx vitest test/core/domain/quoteCountryValue.test.js` | N/A — pure function, no I/O | Delete new file + test; no other file depends on it yet |
| 2 | Gateway numeric-id path + D4 reason tag | PR 2 (needs Unit 1) | `npx vitest test/adapters/odoo/OdooTargetGateway.countryCode.test.js` | N/A — mocked `apiClient` fixture | Revert `resolveCountryExpenseFromQuote`/`pickCountryExpenseById`; legacy ISO path untouched |
| 3 | Eligibility + validator `sin_definir` guards (D5) | PR 3 (needs Unit 1) | `npx vitest test/adapters/hubspot/HubspotSourceGateway.quote.test.js test/composition/validators.quote.test.js` | N/A — unit-mocked | Revert 2 one-line guard changes; defense-in-depth only |
| 4 | Property schema + catalog sync script rewrite | PR 4 (needs Units 1–2 shipped first, per Migration/Rollout) | `npx vitest test/composition/quotePropertyDefinitions.test.js test/scripts/sync-quote-country-options.test.js` | `node scripts/sync-quote-country-options.js --dry-run` against live Odoo | Revert script + property def; re-run script to restore prior options |
| 5 (optional) | Probe duplicate-name reporting | Deferred/separate | N/A — no existing test harness for probe script | `node scripts/probes/odoo-quote-readiness.js` (read-only) | Drop the probe edit; zero production impact |

## Phase 1: Domain Classifier (Foundation)

- [x] 1.1 RED — `test/core/domain/quoteCountryValue.test.js`: table test for `absent/unset/legacy_iso/operation_cost_id/unrecognized` incl. `'sin_definir'`, `' CR '`, `'cr'`, `'78'`, `'0'`, `'78abc'`, `null`
- [x] 1.2 GREEN — Create `src/core/domain/quoteCountryValue.js`: `QUOTE_COUNTRY_UNSET`, `isUnsetQuoteCountry`, `classifyQuoteCountryValue`
- [x] 1.3 REFACTOR — Confirm no other module duplicates this logic

## Phase 2: Gateway Numeric-Id Resolution (D2–D4)

- [x] 2.1 RED — `OdooTargetGateway.countryCode.test.js`: `pickCountryExpenseById` hit + 4 error rows (invalid id, `listOperationCosts` unsupported, lookup throws, id not found); assert `searchCountryIdsByCodes`/`readPartnerCountries` never called
- [x] 2.2 GREEN — Add + export `pickCountryExpenseById` in `OdooTargetGateway.js` per design error table
- [x] 2.3 RED — Same file: `unset` kind → `reason:'quote_country_unset'` no walk; `unrecognized` → `reason:'quote_country_value_unrecognized'` + `logger.warn`, no walk; `operation_cost_id` → delegates to `pickCountryExpenseById`
- [x] 2.4 RED — Update existing successful-ISO-pick assertion to `reason:'legacy_iso_value'` (D4); leave `partner_walk_after_iso_miss`/`quote_country_iso_not_found` assertions untouched
- [x] 2.5 GREEN — Rewrite `resolveCountryExpenseFromQuote` dispatch head using `classifyQuoteCountryValue`; keep legacy ISO block verbatim except the D4 reason tag
- [x] 2.6 REFACTOR — Confirm all pre-existing ISO tests stay green except the D4 reason assertion

## Phase 3: Eligibility & Validator Guards (D5)

- [x] 3.1 RED — `HubspotSourceGateway.quote.test.js`: `pais_de_destino:'sin_definir'` → `isEligibleQuote` false, `reason:'missing_country'`
- [x] 3.2 GREEN — `HubspotSourceGateway.js:52` `isEligibleQuote` uses `isUnsetQuoteCountry` alongside presence check
- [x] 3.3 RED — `validators.quote.test.js`: quote `pais_de_destino:'sin_definir'` → `SkipSyncError`; no-`quoteId` record still no-op
- [x] 3.4 GREEN — `validators.js` `createMustHaveQuoteCountry` treats `isUnsetQuoteCountry` as missing too

## Phase 4: Property Schema + Catalog Sync Script

- [ ] 4.1 RED — `quotePropertyDefinitions.test.js`: assert label/description drop "(ISO-2)"
- [ ] 4.2 GREEN — `quotePropertyDefinitions.js` label/description text update
- [ ] 4.3 RED — Rewrite `sync-quote-country-options.test.js` `buildOptions` block: per-record options, placeholder first, dedupe by id, blank-name fallback, codepoint sort + id tiebreak, `displayOrder`
- [ ] 4.4 RED — Rewrite `planOptions` block: `EMPTY_OPERATION_COSTS`/`EMPTY_OPERATION_COSTS_OPTIONS` guards, `duplicateLabels` warning; drop `readCountriesByIds` fixtures
- [ ] 4.5 GREEN — Rewrite `buildOptions({records})`/`planOptions(...)` in `sync-quote-country-options.js`; drop `readCountriesByIds`; update `main()` output (`recordCount`/`duplicateLabels`)
- [ ] 4.6 REFACTOR — Confirm `applyOptions`/`resolveDryRun` tests stay green except the dead fallback label string

## Phase 5 (optional, deferred): Probe Duplicate-Name Reporting

- [ ] 5.1 Extend `scripts/probes/odoo-quote-readiness.js` `probeP3_AmbiguityCheck` to also report duplicate literal `name`s; verify via read-only live-Odoo dry run (no unit-test harness exists for this script)
