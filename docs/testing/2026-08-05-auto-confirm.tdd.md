# TDD Evidence — Fase 4: Auto-confirmación → orden de fabricación

**Source plan**: [docs/plan-cambios-2026-08-05.md § Fase 4](../plan-cambios-2026-08-05.md#fase-4--auto-confirmación--orden-de-fabricación--entregado-2026-08-05-vía-tdd)

Implementado en tres ciclos RED/GREEN encadenados, en el orden del plan: confirmar → buscar la
MO → escribirla de vuelta.

## User journeys / guarantees covered

1. Como operador, quiero poder activar/desactivar la auto-confirmación de presupuestos con un
   flag de entorno, sin desplegar código.
2. Como el middleware, quiero que un rechazo de Odoo al confirmar (stock, crédito, reglas de
   fabricación) quede registrado y visible, **sin** marcar como fallido un upsert que en
   realidad sí tuvo éxito.
3. Como Andrea, quiero ver el número de la orden de fabricación en la cotización de HubSpot,
   sin que el equipo comercial tenga que entrar a Odoo.

## Task report

| Ciclo | Resumen de ejecución | RED | GREEN |
|---|---|---|---|
| 1. Auto-confirm + rechazo | `odooApiClient.confirmSalesOrder`; `OdooTargetGateway.autoConfirm` + `confirmSalesOrder()` (soft-fail, no throw); `cfg.odoo.autoConfirmQuotes`; wiring en `dealSyncModule` | `7eb23ec` (7/7 fallando) + `881e7f8` (config, 4/4 fallando) | `444e4b6` (728/728 suite completa) |
| 2. Búsqueda de la MO | `odooApiClient.findManufacturingOrderBySaleOrderName`; `OdooTargetGateway.findManufacturingOrder()`, solo tras confirmación exitosa, soft-fail | `d703dd3` (8/8 fallando) | `ec81681` (736/736 suite completa) |
| 3. Write-back | Propiedad `numero_orden_fabricacion` en `quotePropertyDefinitions`, `QUOTE_PROPERTIES`, `HubspotSourceGateway.writeBack`, `buildWriteBackPayload` | `05ac912` (7/7 fallando) | `0b57c84` (742/742 suite completa) |

## Decisión de diseño — por qué el rechazo no es un `SkipSyncError`

El plan original sugería seguir el patrón `SkipSyncError`/`skipDetail` para el rechazo de
`action_confirm`. Al implementar, esa opción resultó **incorrecta**: cuando Odoo rechaza la
confirmación, el `sale.order` **ya se creó o actualizó con éxito** — es un paso posterior,
opcional, que falló. Lanzar `SkipSyncError` en ese punto habría marcado todo el job como
`SKIPPED`, perdiendo el mapping recién creado y tergiversando un upsert exitoso como si no
hubiera pasado nada.

En su lugar: `OdooTargetGateway.confirmSalesOrder()` atrapa el error, lo loguea como
`odoo.upsert.salesOrder.confirm_rejected`, y lo registra en
`result.metadata.confirmation = {status:'rejected', reason: err.message}` — visible en el
mapping persistido y en los logs, sin alterar el resultado del upsert. Esto sigue cumpliendo
"no puede fallar en silencio" (el requisito real del plan) sin el efecto secundario incorrecto
de `SkipSyncError`.

## Test specification

| # | Qué garantiza | Test | Tipo | Resultado |
|---|---|---|---|---|
| 1 | `confirmSalesOrder(id)` llama `action_confirm` sobre `sale.order` (stub + http) | `odooApiClient.test.js:confirmSalesOrder (...)` (3 casos) | unit | PASS |
| 2 | Sin `autoConfirm`, `upsert()` nunca llama a confirmar y `metadata.confirmation` es `null` | `OdooTargetGateway.test.js:does not call confirmSalesOrder when autoConfirm is off` | unit | PASS |
| 3 | Con `autoConfirm`, se confirma tanto el SO recién creado como uno actualizado | `OdooTargetGateway.test.js:confirms a newly-created...` / `...confirms an updated...` | unit | PASS |
| 4 | Un rechazo de Odoo se registra en `metadata.confirmation` sin lanzar, y el upsert se completa igual | `OdooTargetGateway.test.js:records a rejection without throwing...` | unit | PASS |
| 5 | `findManufacturingOrderBySaleOrderName` busca `mrp.production` por `origin=soName` (stub + http) | `odooApiClient.test.js:findManufacturingOrderBySaleOrderName (...)` (3 casos) | unit | PASS |
| 6 | La búsqueda de MO solo corre tras una confirmación exitosa — no con `autoConfirm` apagado, no si el rechazo ocurrió | `OdooTargetGateway.test.js:does not look up the MO when...` (2 casos) | unit | PASS |
| 7 | Que la MO no exista aún (`null`) o que la búsqueda falle no rompe el upsert (soft failure) | `OdooTargetGateway.test.js:the MO not existing yet...` / `...a failed MO lookup...` | unit | PASS |
| 8 | `buildQuotePropertyDefinitions` provisiona la tercera propiedad `numero_orden_fabricacion` | `quotePropertyDefinitions.test.js` (2 casos) | unit | PASS |
| 9 | `QUOTE_PROPERTIES` incluye `numero_orden_fabricacion` — la trampa que el propio plan marcó para esta fase | `hubspotApiClient.quote.test.js:includes the MO number property` | unit | PASS |
| 10 | `HubspotSourceGateway.writeBack` mapea `numero_orden_fabricacion` a la propiedad configurada | `HubspotSourceGateway.test.js:writeBack writes numero_orden_fabricacion...` (2 casos) | unit | PASS |
| 11 | `buildWriteBackPayload` incluye el número de MO solo cuando `mapping.metadata.manufacturingOrder` existe; sin esa metadata, el payload queda idéntico al de antes | `dealSyncModule.test.js:includes numero_orden_fabricacion...` / `...omits...` | unit | PASS |
| 12 | `cfg.odoo.autoConfirmQuotes` y `cfg.hubspot.propertyManufacturingOrder` vienen con defaults seguros y se sobreescriben por env var | `config.test.js:auto-confirm + MO write-back (...)` (4 casos) | unit | PASS |

## Coverage y brechas conocidas

`npx vitest run --coverage <archivos de esta fase>`:

| Archivo | Líneas | Ramas | Funciones |
|---|---|---|---|
| `odooApiClient.js` | 83.36% | 77.38% | 72% |
| `OdooTargetGateway.js` | 74.3% | 80.93% | 80.95% |
| `HubspotSourceGateway.js` | 85.26% | 46.03% | 88.88% |
| `quotePropertyDefinitions.js` | 100% | 100% | 100% |
| `dealSyncModule.js` | 93.33% | 93.1% | 71.42% |

El umbral global (80%) no se cumple corriendo solo estos archivos — el cálculo es sobre todo
`src/`, igual que en las evidencias de Fase 2 y 3. La corrida completa sin `--coverage`
confirma **742/742 pasando en 74 archivos**, sin regresiones.

**Fuera de alcance de este ciclo, no implementado**:

- La bidireccionalidad completa (estado del presupuesto, productos, contactos, facturación
  electrónica) que pidió Andrea sigue pendiente de la Fase 6 (spike). Este ciclo solo cubre el
  número de MO, que el plan identificó como "bidireccionalidad barata de regalo" reutilizando
  el write-back existente.
- No se agregó un mecanismo de reintento específico para la búsqueda de la MO cuando Odoo
  todavía no la generó (carrera entre `action_confirm` y la creación async de la
  `mrp.production` dentro de Odoo). Hoy, si la MO no existe en el instante de la búsqueda,
  `manufacturingOrder` queda `null` y no se reintenta en un tick posterior — quedaría capturada
  recién si ese presupuesto se reprocesa por otra razón. Vale la pena revisar con datos reales
  de producción si esto es un problema práctico antes de invertir en un reintento dedicado.

## Merge evidence

Checkpoints en la rama `main`, en orden:

- `7eb23ec` — RED auto-confirm (7/7 fallando)
- `881e7f8` — RED config auto-confirm/MO property (4/4 fallando)
- `444e4b6` — GREEN auto-confirm (728/728 suite completa)
- `d703dd3` — RED búsqueda de MO (8/8 fallando)
- `ec81681` — GREEN búsqueda de MO (736/736 suite completa)
- `05ac912` — RED write-back de MO (7/7 fallando)
- `0b57c84` — GREEN write-back de MO (742/742 suite completa)
