# Feature: quote-odoo-cost-crosscheck

Branch: `feature/quote-odoo-cost-fields-crosscheck` (from `main`)
Mapping reference: `docs/mapeo-propiedades-cotizacion-hubspot-odoo.md`

## Objective

Read from Odoo every cost datum the HubSpot quote needs, then print a list of what was fetched so unmatched HubSpot
properties can be reported to the colleague building the quote UI.

## Problem / why

The HubSpot quote properties (35, from `Propiedades cotización Visual Branding.xlsx`) must be homologated with Odoo
fields. The middleware only reads 7 of the 10 rate/charge fields of `operation.costs` and has no way to show which
HubSpot properties lack an Odoo counterpart.

## Scope (authorized)

- Read-only against Odoo (staging). No writes to Odoo. No writes to HubSpot in this feature.
- Extend `listOperationCosts` with `iva`, `insurance`, `dai` without changing the sale-order payload.
- Add a read-only probe script that prints the HubSpot property <-> Odoo field cross-check.

## Out of scope

- Writing the fetched values to HubSpot quote properties (next feature).
- Deciding the `otros_cargos` / `prod_monto` source (needs the colleague's answer).

## Constraints

- Strict TDD where a runnable test exists (`npm test`, Vitest). Run only the touched test files.
- Hexagonal layout: Odoo access stays in `src/adapters/outbound/odoo/`.
- Commit messages: max 2 lines, no co-author footer (project rule).

## Tasks

- [x] T1 `listOperationCosts` reads `iva`, `insurance`, `dai` and exposes them as `ivaRate`, `insuranceRate`,
      `daiRate` inside `charges`; `mapDealToSaleOrder` output is unchanged (test proves it).
- [x] T2 `scripts/probes/quote-odoo-crosscheck.js`: for one `operation.costs` id, prints HubSpot property, Odoo
      model.field, found in Odoo (yes/no), type, sample value; lists HubSpot properties with no match.

- [x] T3 `scripts/probes/discover-odoo-fields.js`: read-only `fields_get` dump of sale.order,
      sale.order.shipping.expense, sale.order.line, mrp.production, operation.costs (TSV via `--out`) plus ranked
      candidate Odoo fields for the 6 unmatched HubSpot properties. Added 2026-10-14 after the user saw more fields
      in the Odoo UI (Gastos de Envio tab, MO "Fecha prevista") than the crosscheck probe covers.

## Route declaration

Both tasks delegated to one writer: reading existing client/tests prepares the write, and 2+ non-trivial files change.
Parent runs the probe against staging itself (remote authorization stays with the parent).

## Acceptance criteria

- Touched test files pass; no regression in `odooApiClient`, `OdooTargetGateway`, `dealToSaleOrderMapper` tests.
- The probe runs against staging read-only and prints the full list.

## Delivery

Forecast ~150-250 authored changed lines; single slice, no chained PR. Assessed review tier: pending.

## Progress / evidence

- 2026-10-14 T1+T2 done by one delegated writer. RED observed for T1 (odooApiClient.test.js 1 failed/65 passed) and
  T2 (module missing). Writer GREEN: 5 files, 187 tests. Parent spot check: `npx vitest run
  test/adapters/odoo/odooApiClient.test.js test/scripts/quote-odoo-crosscheck.test.js`: 2 files, 72 tests passed.
- Parent ran the probe on Odoo staging (read-only): `node scripts/probes/quote-odoo-crosscheck.js 66 S06643` exit 0.
  Output saved in `docs/cruce-propiedades-cotizacion-staging-2026-10-14.txt` (staging is deleted 2026-10-28).
- Findings: operation.costs 66 returns iva 0.13, insurance 0.0125, financing 0.085 (fractions, not percent);
  sale.order.freight exists (monetary). No Odoo match: prod_monto, otros_cargos, comercial, fecha_entrega_estimada,
  forma_pago, unidad_medida.
- 2026-10-14 T3 done by one delegated writer (RED: module missing; GREEN 2 files/16 tests; parent re-ran: 16 passed).
  Parent ran `node scripts/probes/discover-odoo-fields.js --out ...` on staging (read-only, exit 0): sale.order 151
  fields, sale.order.shipping.expense 25, sale.order.line 87, mrp.production 178, operation.costs 20. Saved:
  `docs/campos-odoo-staging-2026-10-14.tsv`, `docs/descubrimiento-campos-odoo-staging-2026-10-14.txt`.
- Candidates found: comercial -> sale.order.user_id; forma_pago -> sale.order.payment_term_id; fecha_entrega_estimada
  -> mrp.production.date_planned_start (exists only after the MO) or sale.order.commitment_date (quote stage);
  unidad_medida -> sale.order.line.product_uom; prod_monto -> sale.order.amount_untaxed (unverified);
  otros_cargos -> same Odoo label as cargos_extra_aduana (extra_custom_charges), needs the colleague's decision.
- Review tier: not assessed; nothing committed yet (commit decision pending with the user).

## Next step

Report unmatched properties to the colleague; then a follow-up feature writes the fetched values to HubSpot quote
properties.
