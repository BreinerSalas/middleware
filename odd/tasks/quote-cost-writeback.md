# Feature: quote-cost-writeback

Branch: `feature/quote-odoo-cost-fields-crosscheck` (continues the crosscheck work)
Mapping reference: `docs/mapeo-propiedades-cotizacion-hubspot-odoo.md`
Previous feature: `odd/tasks/quote-odoo-cost-crosscheck.md`

## Objective

When a deal reaches closed-won and the middleware creates the Odoo sale order, also write the cost values of the
quote's `operation.costs` record into the matching HubSpot quote properties, so the colleague's visual quote can
use them.

## Why this trigger

A `quote.propertyChange` webhook is impossible: the HubSpot private app webhook UI does not offer Quotes as an
object type (user screenshot, 2026-10-14). The user chose to reuse the closed-won flow "for agility" and to move
the trigger later if needed. Consequence accepted: values appear after closed-won, not while the salesperson is
still preparing the quote.

## Scope (authorized)

- Reuse the existing closed-won write-back (`HubspotSourceGateway.js` around lines 243-261, `updateQuote`).
- Write these 10 HubSpot quote properties from the resolved `operation.costs` record (`charges`):
  `cargos_extra_aduana`, `gastos_duca_escaner`, `honorarios_agencia`, `costo_envio_doctos`, `costo_trsf_enviada`,
  `costo_trsf_recibida`, `porcentaje_financiamiento`, `porcentaje_iva`, `porcentaje_seguro`, `porcentaje_dai`.
- Values are sent as strings of the raw Odoo number (HubSpot accepts a string for text and number properties);
  percentages stay as Odoo fractions (0.13 = 13 %). Property type/scale in HubSpot is still unconfirmed.
- Property names configurable with the names above as defaults.

## Out of scope

- `otros_cargos` (ambiguous with `cargos_extra_aduana`), `flete_monto`, `prod_monto`, `comercial`,
  `fecha_entrega_estimada`, `forma_pago`, `unidad_medida`: need the colleague's decisions.
- Writing Odoo-computed totals (`iva_totals`, `dai_totals`): possible follow-up.
- New webhooks, new job kinds, new modules.

## Constraints

- Safety: gated by `QUOTE_COST_WRITEBACK_ENABLED` (default false). The cost write is a separate best-effort
  `updateQuote` call wrapped in try/catch with a warn log, so a missing HubSpot property can never break the
  existing write-back of `id_presupuesto_odoo`, state and manufacturing order number.
- Skip silently when the country expense is unresolved or has no `charges`.
- Strict TDD (Vitest). Run only touched test files. Commit messages: max 2 lines, no co-author footer.

## Tasks

- [x] T1 Config: `QUOTE_COST_WRITEBACK_ENABLED` flag and property-name config with defaults (env whitelist too).
- [x] T2 Make the resolved `charges` reach the HubSpot write-back (target result metadata) without changing the
      sale-order payload.
- [x] T3 In the closed-won write-back, build the 10-property map from `charges` and send it as a separate
      best-effort `updateQuote`, flag-gated, with tests (flag off, unresolved, success, HubSpot failure swallowed).

## Route declaration

One delegated writer: reading the gateway/config/tests prepares the write and 2+ non-trivial files change.
Parent verifies with the touched tests and a read-only look at the diff. No remote calls by the writer.

## Acceptance criteria

- Touched tests pass; no regression in HubspotSourceGateway, OdooTargetGateway, config and dealSync tests.
- With the flag off, behavior is identical to today. With it on, the second PATCH carries exactly the 10 properties.

## Delivery

Forecast ~200-350 authored changed lines; single slice. Assessed review tier: pending.

## Progress / evidence

- 2026-10-14 T1-T3 done by one delegated writer, RED observed per task, GREEN. Writer ran
  `npx vitest run test/adapters/hubspot test/adapters/odoo test/config test/config.test.js test/composition`:
  66 files, 864 tests passed. Parent spot check: 4 files (3 new + dealSyncModule), 38 tests passed; read the
  `HubspotSourceGateway.js` diff: flag off returns before any call, cost PATCH is separate and swallows errors.
- Design: charges travel in `metadata.costCharges` (sibling of `countryExpense`, an existing test does `toEqual` on
  that one); `dealSyncModule.buildWriteBackPayload` adds `quote_costs` only when charges exist. Env overrides
  `HS_PROPERTY_QUOTE_COST_*`. No echo guard on the cost call (no quote webhook is listened to).
- Known: the cost PATCH runs on every closed-won write-back including retries (idempotent, one extra PATCH).
- Not done: real run against HubSpot/Odoo; flag stays off until the colleague confirms the HubSpot properties
  exist and their type/scale. Review tier: not assessed.

## Next step

Confirm HubSpot property types/scale with the colleague, then enable `QUOTE_COST_WRITEBACK_ENABLED` on staging
and verify one closed-won deal end to end.
