# Design: HubSpot country dropdown → explicit `operation.costs` catalog

## Technical Approach

One new pure domain classifier turns the raw `pais_de_destino` string into a `kind`. Three existing
call sites branch on that `kind` instead of re-implementing string checks: the fan-out eligibility
filter, the job validator, and `OdooTargetGateway.resolveCountryExpenseFromQuote`. The gateway gains
one additive resolver that picks an `operation.costs` record by id off the already-TTL-cached
`listOperationCosts()`, returning the *same* result shape, so `upsert()`'s `[smartflow]` note logic,
`metadata.countryExpense`, and `mapDealToSaleOrder` are byte-identical. `operationCostsResolver.js`
and `resolveCountryExpense` (no-quote legacy deal path) are not touched.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| D1 | New pure module `src/core/domain/quoteCountryValue.js` owns the sentinel + shape dispatch | Inline regex in each of the 3 call sites | `sin_definir` and the ISO/id shapes must agree across `src/adapters`, `src/composition`, and `scripts/`; `core/domain` has no deps so all three layers may import it without breaking hexagonal direction |
| D2 | New module-level `pickCountryExpenseById(...)` beside `pickCountryExpenseRecord` | Extending `pickCountryExpenseRecord` with an optional id | Keeps the DDP heuristic path unmodified and independently testable; exported like `resolveCountryIdFromIsoCode` so it gets direct unit tests |
| D3 | Numeric-id resolution sets `ambiguous: false`, `matches: 1` | Reusing `pickOperationCostForCountry`'s ambiguity flags | An explicit human pick is by definition unambiguous — the ambiguous `[smartflow]` note must not fire |
| D4 | `reason: 'legacy_iso_value'` replaces only the **successful** ISO pick's reason (`ddp_exact_match`/`no_ddp_exact_match`); the miss paths keep `partner_walk_after_iso_miss` / `quote_country_iso_not_found` | Clobbering `reason` on every legacy outcome (literal spec wording) | Those two strings are already ISO-exclusive, strictly more informative, and asserted by 3 green tests; `ambiguous` still carries the note signal, so nothing functional is lost. See Open Questions. |
| D5 | `sin_definir` is treated as absent in `isEligibleQuote` too, keeping the existing `missing_country` reason | Only guarding at the validator | Otherwise the quote still fans out into a job that dies later; same outcome, wasted work. Reusing the existing reason string means zero downstream change. The validator stays as defense-in-depth. |
| D6 | Gateway keeps falling back to `resolveCountryExpense` when the value is **absent**, but returns `unresolved` for `sin_definir` | Making absent also unresolved | Absent-fallback is existing behavior covered by green tests and by the untouched no-quote path; `sin_definir` is unreachable in today's tests, so hardening it is free |

## Data Flow

    quote.properties.pais_de_destino ─→ classifyQuoteCountryValue(raw)
                                              │
        ┌──────────┬────────────┬─────────────┴──────┬───────────────┐
     absent      unset      legacy_iso      operation_cost_id   unrecognized
        │          │            │                    │               │
        │       SkipSync    resolveCountryIdFromIso  pickCountry-     │
        │       (validator)  + pickCountryExpense-   ExpenseById      │
        │          │         Record / partner walk   (listOperation-  │
        │      (gateway:                │            Costs, find id)  │
        │       unresolved)             │                    │        │
    resolveCountryExpense               └────────┬───────────┴────────┘
    (partner walk, UNCHANGED) ───────────────────┤
                                                 ▼
                    { status, id, countryId, countryName, reason, matches, ambiguous, charges }
                                                 ▼
                    upsert() → [smartflow] note (unchanged) → mapDealToSaleOrder (unchanged)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/core/domain/quoteCountryValue.js` | Create | `QUOTE_COUNTRY_UNSET`, `isUnsetQuoteCountry`, `classifyQuoteCountryValue` |
| `src/adapters/outbound/odoo/OdooTargetGateway.js` | Modify | Add + export `pickCountryExpenseById`; rewrite the dispatch head of `resolveCountryExpenseFromQuote`; tag D4 reason |
| `src/adapters/outbound/hubspot/HubspotSourceGateway.js` | Modify | `isEligibleQuote` country check uses `isUnsetQuoteCountry` (line ~52) |
| `src/composition/validators.js` | Modify | `createMustHaveQuoteCountry` skips on unset as well as blank |
| `src/composition/quotePropertyDefinitions.js` | Modify | Drop "(ISO-2)" from label + description; keep the `sin_definir` option |
| `scripts/sync-quote-country-options.js` | Modify | One option per record; drop `readCountriesByIds`; duplicate-label warning |
| `scripts/probes/odoo-quote-readiness.js` | Modify (optional last slice) | `probeP3_AmbiguityCheck` also reports duplicate literal `name`s |
| `src/adapters/outbound/odoo/operationCostsResolver.js` | **Untouched** | Explicit non-goal |
| `test/core/domain/quoteCountryValue.test.js` | Create | Classifier table tests |
| `test/adapters/odoo/OdooTargetGateway.countryCode.test.js` | Modify | Add id-path + unrecognized cases; existing ISO cases stay green |
| `test/composition/validators.quote.test.js`, `test/adapters/hubspot/HubspotSourceGateway.quote.test.js`, `test/composition/quotePropertyDefinitions.test.js` | Modify | Unset-sentinel cases |
| `test/scripts/sync-quote-country-options.test.js` | Rewrite | Per-record options (own PR slice — highest churn) |

## Interfaces / Contracts

```js
// src/core/domain/quoteCountryValue.js
const QUOTE_COUNTRY_UNSET = 'sin_definir'
function isUnsetQuoteCountry(raw)        // true for null/undefined/''/whitespace/'sin_definir' (trim, case-insensitive)
function classifyQuoteCountryValue(raw)  // -> { kind, value, operationCostId }
//   kind: 'absent' | 'unset' | 'legacy_iso' | 'operation_cost_id' | 'unrecognized'
//   value: trimmed original ('' when absent)
//   operationCostId: Number when kind==='operation_cost_id', else null
//   legacy_iso  : /^[A-Za-z]{2}$/ on the trimmed value (case-insensitive keeps today's lowercase behavior)
//   operation_cost_id: /^\d+$/ AND Number(value) > 0
//   unrecognized: anything else — never throws
```

```js
// src/adapters/outbound/odoo/OdooTargetGateway.js  (module-level, exported)
async function pickCountryExpenseById(operationCostId, { apiClient, logger = null, correlationId = null } = {})
// -> { status, id, countryId, countryName, reason, matches, ambiguous, charges }
```

`pickCountryExpenseById` error table — every branch returns `status:'unresolved'` with
`id:null, countryId:null, countryName:null, matches:0, ambiguous:false, charges` absent:

| Condition | `reason` |
|---|---|
| id not a positive integer | `quote_operation_cost_id_invalid` |
| `typeof apiClient.listOperationCosts !== 'function'` | `listOperationCosts_not_supported` |
| `listOperationCosts()` throws (caught, `logger.warn`) | `operation_costs_lookup_failed` |
| no record with `Number(r.id) === id` | `operation_cost_id_not_found` |

On a hit: `{ status:'resolved', id: rec.id, countryId: rec.countryId ?? null, countryName: rec.countryName || null, reason: 'quote_operation_cost_id', matches: 1, ambiguous: false, charges: rec.charges || null }`.
No partner walk is ever attempted from this branch.

`resolveCountryExpenseFromQuote` dispatch (replaces the `if (iso)` head, everything below it kept verbatim):

| `kind` | Behavior |
|---|---|
| `absent` | `return this.resolveCountryExpense(odooCustomerId, correlationId)` — unchanged |
| `unset` | `{ ...empty, reason: 'quote_country_unset' }` — defense-in-depth, no walk |
| `legacy_iso` | Today's block verbatim; on the successful pick set `reason: 'legacy_iso_value'` (D4) |
| `operation_cost_id` | `return pickCountryExpenseById(operationCostId, {...})` |
| `unrecognized` | `{ ...empty, reason: 'quote_country_value_unrecognized' }` + `logger.warn` — no throw, no walk |

```js
// scripts/sync-quote-country-options.js
function buildOptions({ records })  // -> [{ label, value, displayOrder }]
async function planOptions({ apiClient, hubspot, propertyName, logger })
// -> { options, records, duplicateLabels, currentProperty, propertyLookupFailed }
```

`buildOptions` rules: placeholder `{ label:'Sin definir', value:'sin_definir', displayOrder:0 }` always
first; keep records with a positive integer `id`, dedupe by id; `label = String(name).trim()` or
`` `operation.costs #${id}` `` when blank; `value = String(id)`; sort by raw codepoint compare on
`label` (NOT `localeCompare` — locale-dependent, non-deterministic in CI), tie-break `id` ascending;
`displayOrder = index + 1`. `countryId` is no longer required, so records without one stay selectable.

Both refuse-to-write guards survive, re-pointed: `EMPTY_OPERATION_COSTS` when `listOperationCosts()`
returns zero records; new `EMPTY_OPERATION_COSTS_OPTIONS` when only the placeholder survives filtering.
`duplicateLabels` (labels occurring >1) is a `logger.warn` + a stdout JSON key — non-blocking.
`applyOptions` is unchanged apart from its dead fallback label string; `main()`'s output swaps
`usedIsos`/`resolvedCountries` for `recordCount`/`duplicateLabels`.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit — domain | Every `kind` incl. `'sin_definir'`, `' CR '`, `'cr'`, `'78'`, `'0'`, `'78abc'`, `null` | Table test, new file |
| Unit — gateway | `pickCountryExpenseById` hit + all 4 error rows; `listOperationCosts` called once | `makeApi` fixture from `OdooTargetGateway.countryCode.test.js` |
| Unit — gateway | Numeric id never calls `searchCountryIdsByCodes`/`readPartnerCountries`; unknown id yields `[smartflow]` note; `ambiguous` stays false | `vi.fn` not-called assertions, existing style |
| Unit — validators / source gateway | `sin_definir` → `SkipSyncError` / `missing_country`; no-`quoteId` record still a no-op | Mirror `mustHaveLineItems` tests |
| Unit — script | Per-record options, sort determinism, placeholder pinned, both guards, duplicate warning | Rewrite of `sync-quote-country-options.test.js` |
| Regression | All 5 existing ISO tests in `OdooTargetGateway.countryCode.test.js` green unmodified except the D4 reason | `npm test` |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The one privileged side effect (a live HubSpot property-schema PATCH)
keeps its existing `PROPERTY_LOOKUP_FAILED` refuse-to-write guard and `--dry-run` preview unchanged.

## Migration / Rollout

No data migration. Order matters: ship the gateway/validator (id path accepted but never sent) **before**
republishing the dropdown, so no quote can carry an id the middleware cannot yet resolve. Run the script
with `--dry-run` and diff before applying. In-flight ISO quotes keep working via the legacy branch.
Rollback: revert commits and re-run the script — `applyOptions` fully overwrites the options.

## Open Questions

- [ ] D4 narrows the spec's literal "tag the result `reason: 'legacy_iso_value'`" to the successful ISO
      pick only. Confirm, or accept updating the 3 assertions on `partner_walk_after_iso_miss` /
      `quote_country_iso_not_found`.
- [ ] D5 adds `HubspotSourceGateway.isEligibleQuote` to the proposal's file list. Confirm the scope add.
- [ ] Live-Odoo precondition from the proposal, still unresolved: admins must edit `operation.costs`
      in place rather than delete+recreate, and the catalog must be small enough for a flat dropdown.
