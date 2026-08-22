# Quote Operation Cost Selection Specification

## Purpose

Deterministic selection of the exact `operation.costs` record (country + Incoterm) that drives a quote's `country_expense` and shipping charges, keyed by the HubSpot `pais_de_destino` dropdown value, replacing the current single ISO-per-country dropdown that always resolves to a DDP default.

## Requirements

### Requirement: Dropdown Mirrors the `operation.costs` Catalog

The system MUST publish one `pais_de_destino` HubSpot dropdown option per live `operation.costs` record, using that record's numeric `id` (as a string) as the option value and the record's literal `name` as the option label. The `sin_definir` option MUST remain present at order 0 alongside the catalog-derived options.

#### Scenario: Catalog republish produces one option per record

- GIVEN N live `operation.costs` records
- WHEN `sync-quote-country-options.js` runs
- THEN N options are published, each with value = record id (string) and label = record name
- AND a `sin_definir` option is present at order 0

#### Scenario: Duplicate names are flagged, not blocked

- GIVEN two or more live `operation.costs` records share the same literal `name`
- WHEN the sync's ambiguity check runs
- THEN it reports the duplicate names as a non-blocking warning
- AND publishing proceeds with both options rendering identical labels

### Requirement: Numeric-Id Resolution Path

The system MUST resolve a quote's `pais_de_destino` value that does not match exactly two uppercase letters by treating it as an `operation.costs` id and selecting that record directly, without invoking the ISO/DDP-default resolution logic.

#### Scenario: Known numeric id resolves directly

- GIVEN a quote's `pais_de_destino` is a numeric id matching a live `operation.costs` record
- WHEN country-expense resolution runs
- THEN `country_expense` is set to that exact record
- AND the DDP-default/ambiguity heuristic is never invoked

#### Scenario: Unknown numeric id yields unresolved, not a fallback walk

- GIVEN a quote's `pais_de_destino` is a numeric id with no matching `operation.costs` record
- WHEN resolution runs
- THEN the result is `unresolved`, tagged with the existing `[smartflow]` note pattern
- AND no partner-country fallback walk executes

### Requirement: Legacy ISO-Code Path Preserved

The system MUST continue resolving values matching exactly two uppercase letters via the existing ISO-code/DDP-default resolution path, tagging the result `reason: 'legacy_iso_value'`.

#### Scenario: Legacy ISO value still DDP-defaults

- GIVEN a quote's `pais_de_destino` is `"MX"`
- WHEN resolution runs
- THEN the existing ISO/DDP-default logic executes unchanged
- AND the result is tagged `reason: 'legacy_iso_value'`

### Requirement: Missing Country Hard-Skips Sync (Behavior Change)

The system MUST raise `SkipSyncError` (via `createMustHaveQuoteCountry`) and MUST NOT create a sale order when a quote job's `pais_de_destino` is `sin_definir`, empty, or missing.

(Previously: the same missing/`sin_definir` value silently fell through to the ISO/DDP-default partner-country walk, producing a sale order with a guessed Incoterm and no error.)

#### Scenario: Unset country skips sync entirely

- GIVEN a quote job's `pais_de_destino` is `sin_definir` (or empty/missing)
- WHEN sale-order sync validation runs
- THEN `SkipSyncError` is raised
- AND no sale order is created for that quote

#### Scenario: No prior silent default remains reachable

- GIVEN the same `sin_definir`/empty/missing input that previously resolved via the DDP-default partner-country walk
- WHEN validation runs under the new behavior
- THEN that walk is never invoked and no Incoterm is guessed

#### Scenario: Skip stays silent in HubSpot

- GIVEN a quote is skipped due to a missing country
- WHEN the sync completes
- THEN no note or visible feedback is written to HubSpot, matching existing `SkipSyncError` behavior for other missing-required-field cases
