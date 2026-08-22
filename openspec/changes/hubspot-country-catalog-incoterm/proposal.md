# Proposal: HubSpot country dropdown → explicit `operation.costs` catalog

## Intent

`pais_de_destino` offers one option per country and the middleware always resolves `"DDP <country>"`, silently forcing DDP. A different Incoterm means a different `operation.costs` record and different shipping charges on the Odoo sale order. Salespeople must pick the exact Incoterm+country record per quote.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Option value | Numeric `operation.costs.id`; label = literal record name | Survives Odoo renames (a slug does not); immune to unverified HubSpot value length/charset limits; exact match, no name-uniqueness dependency |
| 2 | Resolver shape | New direct-pick branch inside `resolveCountryExpenseFromQuote`, reusing the existing result shape; `operationCostsResolver.js` untouched | Minimal diff; `upsert()` notes and `mapDealToSaleOrder` unchanged; DDP heuristic still serves the legacy path |
| 3 | Back-compat | Shape dispatch (`/^[A-Z]{2}$/` = legacy ISO, digits = new); legacy tagged `reason: 'legacy_iso_value'` | Disjoint shapes, zero migration risk; the tag is the data that later sizes a backfill |
| 4 | Unset / unresolvable | `sin_definir` or empty → `SkipSyncError`; unknown id → `unresolved` + existing `[smartflow]` note, no partner walk; legacy path unchanged | Kills the silent default the client rejected; failure stays visible instead of shipping a wrong Incoterm |

## Scope

**In:** `scripts/sync-quote-country-options.js` (one option per record, drop `readCountriesByIds`, deterministic sort, keep `sin_definir` at order 0 plus both refuse-to-write guards); `OdooTargetGateway.resolveCountryExpenseFromQuote` (shape dispatch + id pick off cached `listOperationCosts()`); `validators.createMustHaveQuoteCountry` (`sin_definir` counts as absent); `quotePropertyDefinitions` (drop "ISO-2" wording); `probeP3_AmbiguityCheck` (duplicate-`name` detection); tests written first (Strict TDD) across the six affected test files.

**Out / non-goals:** backfilling ISO-valued quotes; deleting the legacy branch; touching `operationCostsResolver.js`, `dealToSaleOrderMapper`, or the Gastos de Envío charge-copy fix (fad9abf); the no-quote deal path; a separate Incoterm field; cascading dropdowns; tooling that counts in-flight ISO quotes.

## Capabilities

**New:** `quote-operation-cost-selection` — how a quote selects the `operation.costs` record driving `country_expense` and shipping charges.
**Modified:** None.

## Dependencies (live-Odoo preconditions, unavailable to SDD phases)

1. **Blocking implementation:** confirm admins edit `operation.costs` in place, not delete+recreate (validates Decision 1).
2. **Blocking rollout:** catalog size — a flat dropdown is wrong UX at hundreds of records.
3. **Non-blocking:** duplicate literal `name` values would render identical labels.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Record deleted in Odoo → stale quote id | Low | Yields `unresolved` + note, never a wrong Incoterm |
| Republish drops an in-use option | Med | `--dry-run` diff before every apply |
| `sync-quote-country-options.test.js` rewrite churn | High | Tests first; its own PR slice |

## Rollback

Revert the script commit and re-run it — `applyOptions` fully overwrites, restoring the ISO options. Revert the gateway/validator commits; the legacy branch is untouched, so behavior returns to today's. No Odoo data is migrated.

## Success Criteria

- [ ] Dropdown lists every live `operation.costs` record by its literal name.
- [ ] A "CIP México" quote yields `country_expense` = that record, with its charges on Gastos de Envío.
- [ ] `sin_definir` skips via `SkipSyncError`, never DDP-defaults.
- [ ] Existing ISO quotes sync unchanged; `npm test` green.
