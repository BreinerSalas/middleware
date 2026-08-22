# Exploration: HubSpot `pais_de_destino` dropdown → explicit `operation.costs` (Incoterm+country) catalog

## Problem

Today the HubSpot Quote property `pais_de_destino` is a dropdown with one option per country (ISO-2 code as value), which the middleware resolves to an Odoo `res.country` and then always picks the `operation.costs` record matching `"DDP <country>"` — defaulting to DDP regardless of what the actual shipment needs. The client needs to choose a different Incoterm (DDP/CIP/EXW/etc.) per quote, because a different Incoterm means a different `operation.costs` record and therefore different shipping charges on the resulting Odoo sale order.

## Current State

1. `scripts/sync-quote-country-options.js` (`planOptions`/`buildOptions`/`applyOptions`) publishes ONE HubSpot option per **country** (value=ISO code) by pivoting `operation.costs` records through `countryId`, then resolving ISO via a separate `readCountriesByIds` call. `applyOptions` **fully overwrites** the options array every run — no merge/preserve logic for old values.
2. `src/composition/quotePropertyDefinitions.js` declares the schema with only a placeholder option; description text says "Código ISO-2 del país."
3. `src/composition/validators.js` `createMustHaveQuoteCountry` (line 32) — presence-only `SkipSyncError` gate, no-op when `record.quoteId` is absent (legacy deal path). Does not validate format/resolvability. Notably, today `'sin_definir'` already passes this check silently and reaches the resolver as an unresolvable "ISO".
4. `OdooTargetGateway.resolveCountryExpenseFromQuote` (line 432) reads the ISO from `quote.properties[pais_de_destino]`, resolves via `resolveCountryIdFromIsoCode` → `pickCountryExpenseRecord` → `operationCostsResolver.pickOperationCostForCountry` (exact `"DDP <Country>"` match, else lowest-id fallback marked `ambiguous`). On ISO miss or absence it falls through to `resolveCountryIdFromPartner` (partner-country walk, climbing `parent_id`) via `resolveCountryExpense`.
5. `upsert()` (line 232) appends a `[smartflow]` note marker on the Odoo sale order when resolution is `unresolved` or `ambiguous` — ambiguous picks are already flagged today, not silent.
6. `dealToSaleOrderMapper.mapDealToSaleOrder` is agnostic to how `countryExpenseId`/`shippingExpenseCharges` were resolved — no changes anticipated there.
7. `odooApiClient.listOperationCosts()` (line 232) already returns `countryName` per record for free — so a redesigned sync script may no longer need the separate `readCountriesByIds` round-trip.
8. `operationCostsResolver.normalizeForMatch` (ASCII-fold + lowercase + non-alnum-collapse) is a reusable slug-generation primitive if a slug-based value is chosen.

## Affected Areas

- `scripts/sync-quote-country-options.js` — shape change from per-country to per-`operation.costs`-record; `test/scripts/sync-quote-country-options.test.js` needs a parallel rewrite (ISO-shaped assertions throughout).
- `src/composition/quotePropertyDefinitions.js` — label/description text becomes stale.
- `src/adapters/outbound/odoo/OdooTargetGateway.js` — `resolveCountryExpenseFromQuote`/`resolveCountryIdFromIsoCode`/`pickCountryExpenseRecord` need a new direct-pick branch; `resolveCountryIdFromPartner`/`resolveCountryExpense` are candidates to keep or gate per Q4.
- `src/adapters/outbound/odoo/operationCostsResolver.js` — DDP-default/ambiguity logic becomes irrelevant to the new direct-pick path; minimal-diff design should avoid touching it.
- `src/composition/validators.js` `createMustHaveQuoteCountry` — Q4 decision affects whether format/resolvability validation is added (would need live-catalog access, an architecture gap today).
- Test files needing updates: `test/adapters/odoo/operationCostsResolver.test.js`, `test/adapters/odoo/OdooTargetGateway.countryCode.test.js`, `test/adapters/odoo/OdooTargetGateway.test.js`, `test/scripts/sync-quote-country-options.test.js`, `test/composition/quotePropertyDefinitions.test.js`, `test/composition/validators.quote.test.js`.

## Approaches (options, not decisions)

1. **Numeric `operation.costs.id` as HubSpot option value** — direct lookup, zero ambiguity. Pros: matches Odoo's own stable primary key; trivial exact match. Cons: opaque value in raw HubSpot data; unverified whether Odoo ever deletes+recreates records. Effort: Low.
2. **Slug of `operation.costs.name` as value** — reuses `normalizeForMatch`. Pros: human-readable; independent of Odoo's internal id lifecycle. Cons: breaks silently on any Odoo-side rename; no verified uniqueness guarantee; unverified HubSpot option-value length/character limits. Effort: Low-Medium.
3. **New standalone `resolveOperationCostDirect(value, {apiClient})`** bypassing `resolveCountryIdFromIsoCode`/`pickOperationCostForCountry` entirely, reusing the existing `{status, id, countryId, countryName, reason, matches, ambiguous, charges}` result shape so `upsert()`'s smartflow-note logic and `mapDealToSaleOrder` need no changes. Pros: minimal diff; isolates new logic from heavily-tested legacy code. Cons: two resolver code paths coexist. Effort: Low.
4. **Dual-path ISO detection for back-compat (Q3)** — branch on `/^[A-Z]{2}$/` shape (legacy ISO is always exactly 2 uppercase letters, never colliding with a numeric id or multi-word slug) vs. new-format value, kept permanently. Pros: zero migration risk, cheap. Cons: two resolver paths live forever; no existing tooling counts how many in-flight quotes still hold ISO values. Effort: Low (additive).
5. **One-time backfill + retire legacy ISO path (Q3 alternative)**. Pros: cleaner single code path eventually. Cons: needs a new bulk HubSpot quote-property update script (no precedent — only product backfills exist); riskier one-time live operation. Effort: Medium.
6. **Hard validation error when nothing is picked (Q4)** — reuse the `createMustHaveQuoteCountry`/`SkipSyncError` pattern, explicitly treating `sin_definir`/empty as "not chosen." Pros: matches the client's stated need to remove the implicit DDP default. Cons: no partner-walk safety net for partially-filled quotes. Effort: Low.
7. **Keep partner-walk fallback even for the new format (Q4 alternative)** — extend the existing "no ISO" branch to treat `sin_definir` the same way. Pros: no regression risk for partial data. Cons: contradicts the client's stated need to avoid a silent default. Effort: Low.

## Pre-work items to flag for sdd-propose/sdd-design (not blockers, but should be called out explicitly)

(a) Verify with the client/live Odoo whether `operation.costs` ids/names are ever renumbered or renamed.
(b) Write a probe/script to count in-flight quotes still holding a legacy ISO value.
(c) Extend `probeP3_AmbiguityCheck` (or write a new probe) to check for literal duplicate `operation.costs.name` within a country — the existing probe checks numeric-param/generic-record equality, not name uniqueness.
(d) Confirm HubSpot's enumeration option value length/character limits against live behavior or current API docs before locking in a slug-based scheme.

## Risks

- Odoo `operation.costs` id/name stability over time is unverified from this codebase (affects Q1 directly).
- No existing tooling counts ISO-coded quotes already in flight (Q3 unanswerable without new tooling).
- No existing check for duplicate `operation.costs.name` within a country (only a related-but-different numeric-param/generic check exists).
- HubSpot's enumeration option value length/character constraints are unverified in this repo.
- `sin_definir` already silently passes today's presence-only validator and reaches the resolver as an unresolvable value — a pre-existing minor gap independent of this change.
- `buildOptions`/`planOptions` shape change requires a non-trivial parallel rewrite of `test/scripts/sync-quote-country-options.test.js`.

## Key Learnings

1. `sync-quote-country-options.js`'s `applyOptions` fully overwrites HubSpot's options array every run with no historical merge, a pre-existing behavior independent of this change.
2. `operation.costs` records already carry `countryName` from `listOperationCosts()`, making the sync script's separate `readCountriesByIds` call unnecessary for a per-record option design.
3. `createMustHaveQuoteCountry` only checks presence today, so the `sin_definir` placeholder silently passes validation and reaches the Odoo resolver as an unresolvable ISO code.
4. `probeP3_AmbiguityCheck` checks numeric-charge-field equality and generic-record presence per country, not literal duplicate `operation.costs.name` values.
5. Legacy ISO values are always exactly 2 uppercase letters, so shape-based dual-path detection against a numeric id or multi-word slug is unambiguous and cheap.

## Ready for Proposal

Yes — all 4 open questions have concrete, evidence-backed options with tradeoffs. Remaining unknowns are live-data/external-API verification steps, not architectural blockers.
