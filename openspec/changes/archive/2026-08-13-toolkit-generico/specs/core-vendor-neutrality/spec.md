# Delta for Core Vendor Neutrality

## ADDED Requirements

### Requirement: Caller-Supplied Write-Back Payload, No Vendor Default

`ProcessSyncJobUseCase.buildWriteBackPayload` MUST NOT default to any vendor-specific field name. The payload builder MUST be supplied by the caller via `retryPolicy.buildWriteBackPayload`; when it is absent, `buildWriteBackPayload` MUST throw an explicit error rather than returning a silent no-op payload (e.g. `{}`) or a hardcoded vendor field.

#### Scenario: Injected builder is used

- GIVEN `retryPolicy.buildWriteBackPayload` is a function supplied by the caller
- WHEN `execute` calls `buildWriteBackPayload(mapping)`
- THEN the injected function's return value is written back, unchanged by any core default

#### Scenario: Missing builder throws, never silently no-ops

- GIVEN `retryPolicy.buildWriteBackPayload` is not a function (not supplied)
- WHEN `ProcessSyncJobUseCase` is constructed
- THEN construction throws an explicit error instead of allowing an instance to exist that would later return `{}` or any implicit default, and no write-back call ever proceeds with a silently empty payload

#### Scenario: dealSyncModule remains the sole owner of the Odoo field

- GIVEN `dealSyncModule.js` continues to inject `{ id_presupuesto_odoo }` explicitly as its `buildWriteBackPayload`
- WHEN a deal sync job executes
- THEN write-back behavior for that flow is identical to before the refactor

### Requirement: No Vendor-Specific Date Formatting in Core

`src/core/` MUST NOT contain vendor-specific date formatting logic. Odoo-specific date helpers MUST live under `src/adapters/outbound/odoo/`, and no file under `src/core/` may import from that adapter path.

#### Scenario: odooDate helper lives outside core

- GIVEN the codebase after the refactor
- WHEN `src/core/` is searched for Odoo-specific date-formatting code
- THEN none is found; the helper (formerly `core/shared/odooDate.js`) resides at `src/adapters/outbound/odoo/odooDate.js`

#### Scenario: No core file imports the moved helper

- GIVEN any file under `src/core/`
- WHEN its `require`/`import` statements are inspected
- THEN none references `adapters/outbound/odoo/odooDate` or any path under `adapters/outbound/odoo/`

#### Scenario: Existing consumers still resolve after the move

- GIVEN `product`, `partner`, and `saleOrderStatus` sync modules under `composition/` previously imported `core/shared/odooDate.js`
- WHEN they are updated to import from `adapters/outbound/odoo/odooDate.js`
- THEN date formatting behavior for all three flows is unchanged
