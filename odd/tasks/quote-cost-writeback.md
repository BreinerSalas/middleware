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

- [x] T4 (added 2026-10-14, user request) Write `fecha_entrega_estimada` (HubSpot type `date`, sent as YYYY-MM-DD)
      from the manufacturing order's `date_planned_start` ("Fecha prevista") in the same shared write-back. The MO
      only exists after release/confirmation, so the value appears on the release run. Read the field in
      `findManufacturingOrderBySaleOrderName`, carry it in `metadata.manufacturingOrder`, add it to
      `buildWriteBackPayload`, and write it as a separate best-effort `updateQuote` (same flag). Convert the Odoo UTC
      datetime to a local calendar date (default `America/Costa_Rica`) so a late-evening MO does not shift a day.
      Also cover the manufacturing-order retry path if it writes back the MO.

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

- 2026-10-14 HubSpot property definitions read (read-only, user-authorized, HubSpot connector, object `quotes`):
  all 14 requested properties exist (the 10 written ones plus `otros_cargos`, `flete_monto`, `prod_monto`,
  `base_cif_con_otros_cargos`) and all are type `number`, not text. The four percentage properties are documented
  "registrar como decimal" (e.g. 0.01375 = 1.375 %), which matches the raw Odoo fractions we send (0.13, 0.0125,
  0.085). Descriptions: `cargos_extra_aduana` = "Cargos extraordinarios de aduana"; `otros_cargos` = "Otros cargos que
  se incorporan a la base CIF", so `otros_cargos` looks like a different, manual input (still to confirm with the
  colleague). Limit: the connector does not expose whether a property is calculated/read-only.

- 2026-10-14 END-TO-END VERIFIED (user ran the local server with the flag on; parent read HubSpot read-only).
  Test deal 66012267098 ("test propieties") moved to closed-won (stage 1409249440 -> 1409249445); quote
  43956588404 ("test colombia", pais_de_destino=153 "DAP Colombia", status APPROVAL_NOT_NEEDED) had no cost values
  before and afterwards carried exactly the operation.costs 153 values read from Odoo staging: gastos_duca_escaner
  40, costo_envio_doctos 40, costo_trsf_enviada 35, costo_trsf_recibida 60, porcentaje_seguro 0.02, and 0 for
  cargos_extra_aduana, honorarios_agencia, porcentaje_financiamiento, porcentaje_iva, porcentaje_dai. The Odoo order
  S07089 id was written back to id_presupuesto_odoo. otros_cargos and flete_monto stayed empty by design.
  Not observed: estado_presupuesto_odoo (status sync job) and numero_orden_fabricacion (gated by the release card).
- Observation: the same quote has pais_de_destino=153 (DAP Colombia) and incoterm_cotizacion=6 (CIF): the costs
  follow the country record while the Odoo order takes the incoterm field.
- Side finding: the local server also ran product/contact sync against the real HubSpot portal (duplicate warnings);
  those jobs should be off for local tests.

- 2026-10-14 T4 done by one delegated writer, RED observed (12 failing tests before source changes), GREEN: writer ran
  `npx vitest run test/adapters/hubspot test/adapters/odoo test/config test/config.test.js test/composition`:
  67 files, 879 tests passed. Parent spot check: 6 files (new deliveryDate gateway test, costWriteback, odooApiClient,
  dealSyncModule, manufacturingOrderRetrySyncModule, quoteCostWriteback config), 120 tests passed; read the
  `HubspotSourceGateway.js` diff. HubSpot `fecha_entrega_estimada` is type `date` (read-only definition check), so
  the value is sent as YYYY-MM-DD, converted from Odoo UTC to `America/Costa_Rica` (configurable
  `QUOTE_DELIVERY_DATE_TIMEZONE`; property name via `HS_PROPERTY_QUOTE_DELIVERY_DATE`). Same flag as the costs.
- Not verified: no real release run yet; the date appears only on the release run (the MO exists after
  confirmation) and can go stale if someone edits the MO date later.

## Next step

Colleague answers the 7 open properties; then decide on the real trigger and enable `QUOTE_COST_WRITEBACK_ENABLED` on staging
and verify one closed-won deal end to end.
