# TDD evidence — plan-odoo-default-customer

**Date**: 2026-07-28
**Source plan**: conversación con el operador; decisión "single-tenant demo → todos los deals al mismo partner de Odoo".
**Branch**: `main` (1 checkpoint commit)

## User journey

1. **Como operador en demo single-tenant**, quiero configurar el partner de Odoo en `.env` (`ODOO_DEFAULT_CUSTOMER_ID`) y no tener que crear la propiedad `id_cliente_odoo` por cada deal en HubSpot, para validar el flujo end-to-end más rápido.

## Checkpoint commits

| # | SHA | Subject | Tests at this commit |
|---|---|---|---|
| 1 | `d16dde7` | feat(odoo): env-based default customer ID for single-tenant demos | +9 tests; suite 381/381 |

## Task report

### Config — ODOO_DEFAULT_CUSTOMER_ID

- **RED**: extended `test/config.test.js` with two cases — `cfg.odoo.defaultCustomerId` returns the env value when set, and `''` when missing. Initial run: 2/15 FAIL (RED gate confirmed).
- **GREEN**: `src/config/index.js`:
  - Added `ODOO_DEFAULT_CUSTOMER_ID` to `OPTIONAL_KEYS`.
  - `cfg.odoo.defaultCustomerId = env.ODOO_DEFAULT_CUSTOMER_ID || ''`.
- **Validation**: 15/15 config tests PASS.

### Validator factory — createMustHaveOdooCustomerId

- **RED**: rewrote `test/composition/validators.test.js` to import `createMustHaveOdooCustomerId` (the new factory) instead of `mustHaveOdooCustomerId`. 7 new cases: factory returns a function, pass-through cases unchanged, default accepts missing property, default + property both valid, empty-string default still rejects, code+transient preserved.
- **GREEN**: `src/composition/validators.js`:
  - Replaced `mustHaveOdooCustomerId` (function) with `createMustHaveOdooCustomerId({ defaultCustomerId })` factory.
  - Closure captures `defaultCustomerId` once at creation; the returned function uses it as third fallback (after `references.odooCustomerId` and `record.properties.id_cliente_odoo`).
- **Validation**: 13/13 validator tests PASS.

### OdooTargetGateway default fallback

- **RED**: extended `test/adapters/odoo/OdooTargetGateway.test.js` with three cases — default used as final fallback, deal property wins over default, empty default still throws MISSING_ODOO_CUSTOMER_ID. Initial run: 1/11 FAIL (RED confirmed).
- **GREEN**: `src/adapters/outbound/odoo/OdooTargetGateway.js`:
  - Constructor accepts `defaultCustomerId = ''`.
  - `upsert()` resolves `odooCustomerId` from `references.odooCustomerId` → `record.properties.id_cliente_odoo` → `this.defaultCustomerId` → `null` (throws MISSING).
- **Validation**: 11/11 gateway tests PASS.

### Wiring

- **GREEN** (no new tests): `src/composition/dealSyncModule.js` wires `config.odoo.defaultCustomerId` into both the validator factory and the gateway constructor. Existing e2e tests in `test/composition/dealSyncModule.test.js` still pass — they use local stub validators, not the production factory.

## Test specification

| # | What is guaranteed | Test file | Test type | Result |
|---|---|---|---|---|
| 1 | `cfg.odoo.defaultCustomerId` reads `ODOO_DEFAULT_CUSTOMER_ID` env | `test/config.test.js` | unit | PASS |
| 2 | `cfg.odoo.defaultCustomerId` defaults to `''` | mismo | unit | PASS |
| 3 | `createMustHaveOdooCustomerId()` factory returns a function | `test/composition/validators.test.js` | unit | PASS |
| 4 | Pass-through behavior: deal property and `references.odooCustomerId` still satisfy the validator | mismo | unit | PASS |
| 5 | Validator accepts deal when only `defaultCustomerId` is set | mismo | unit | PASS |
| 6 | Validator still throws MISSING when neither property, reference, nor default is set | mismo | unit | PASS |
| 7 | Validator throws MISSING when default is empty string | mismo | unit | PASS |
| 8 | OdooTargetGateway uses `defaultCustomerId` as final fallback in `partner_id` | `test/adapters/odoo/OdooTargetGateway.test.js` | unit | PASS |
| 9 | Deal property wins over `defaultCustomerId` | mismo | unit | PASS |

## Files touched

```
src/config/index.js                                              [M]
src/composition/validators.js                                     [M]
src/composition/dealSyncModule.js                                 [M]
src/adapters/outbound/odoo/OdooTargetGateway.js                   [M]
test/config.test.js                                               [M]
test/composition/validators.test.js                               [M]
test/adapters/odoo/OdooTargetGateway.test.js                      [M]
.env.example                                                      [M]
README.md                                                         [M]
```

## Known follow-ups

- **Multi-tenant**: if a single HubSpot portal needs to sync deals to multiple Odoo partners, the deal property `id_cliente_odoo` still works (it has higher priority than the env default). Operator can later build a HubSpot workflow that resolves the partner ID by deal pipeline or by associated company and writes it to `id_cliente_odoo`.
- **Type safety**: `cfg.odoo.defaultCustomerId` is a string (matches how `id_cliente_odoo` is read from HubSpot — HubSpot returns properties as strings). The mapper does `Number(odooCustomerId) || odooCustomerId` (`src/adapters/outbound/odoo/dealToManufacturingOrderMapper.js:35`), so a numeric string like `"42"` becomes `42`, while non-numeric strings pass through.