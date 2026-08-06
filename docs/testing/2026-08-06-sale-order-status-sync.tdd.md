# TDD Evidence — Fase 6 (núcleo): estado del presupuesto Odoo → HubSpot

**Source plan**: plan de sesión aprobado en plan mode, `/home/breiner/.claude/plans/pregunta-rapidisima-con-la-frolicking-blossom.md`
(deriva de [docs/plan-cambios-2026-08-05.md § Fase 6](../plan-cambios-2026-08-05.md)).

Implementado en cinco ciclos RED/GREEN encadenados: gaps de infraestructura → listado
incremental de `sale.order` → propiedades y write-back → módulo de sync + job loop + wiring →
retroceso de etapa por cancelación.

## User journeys / guarantees covered

1. Como Andrea, quiero ver el estado real del presupuesto en Odoo (`state`, `invoice_status`)
   reflejado en la cotización de HubSpot, sin que el comercial tenga que entrar a Odoo.
2. Como el middleware, quiero detectar estos cambios por polling (`write_date`), reutilizando
   la misma maquinaria de cursor/generador que la Fase 3 construyó para productos, ya que este
   Odoo no soporta webhook saliente nativo (confirmado por el spike de Fase 6).
3. Como comercial, si un presupuesto ya cerrado se cancela en Odoo para corregirse (mala
   digitación, el cliente cambió de planes), quiero que el deal regrese automáticamente a la
   etapa en la que estaba antes de cerrar como ganado, en vez de quedarse marcado como ganado
   mientras se corrige.

## Task report

| Ciclo | Resumen de ejecución | RED | GREEN |
|---|---|---|---|
| 1. Infraestructura | `JOB_KIND.SALE_ORDER_STATUS_SYNC`; `MongoMappingRepository.findByTargetId`; índice en `targetId` | `62ed3ac` (2/2 fallando) | `70f7392` (744/744 suite completa) |
| 2. Listado incremental | `odooApiClient.searchSalesOrdersChangedSince`; `OdooSaleOrderSource.listChangedSince` | `63307a4` (2 + módulo sin cargar) | `0769f95` (750/750 suite completa) |
| 3. Propiedades + write-back | `estado_presupuesto_odoo`/`estado_facturacion_odoo` en `quotePropertyDefinitions`, `QUOTE_PROPERTIES`, `HubspotSourceGateway.writeBack`, `cfg.hubspot.propertyQuoteState/propertyQuoteInvoiceStatus` | `a8194e5` (7/7 fallando) | `c661d7d` (756/756 suite completa) |
| 4. Módulo de sync + job loop + wiring | `saleOrderStatusSyncModule.runIncremental`; `saleOrderStatusSyncJobModule`; `cfg.saleOrderStatusSync`; wiring condicional en `server.js` | `d10684d` (3 módulos sin cargar) | `061b3e8` (772/772 suite completa) |
| 5. Retroceso de etapa | `hubspotApiClient.getDealStageHistory`; `resolvePreviousDealStage`; `HubspotSourceGateway.revertDealStage`; disparo en `runIncremental` cuando `state==='cancel'` | `8a4157d` (8/8 fallando) | `92536d3` (781/781 suite completa) |

## Decisiones de diseño

**Por qué no hace falta un "gateway inverso" nuevo.** El spike de Fase 6 había identificado
como brecha la falta de un par gateway Odoo→HubSpot. En la práctica, `HubspotSourceGateway`
ya tenía todo lo necesario: `writeBack(sourceId, payload)` resuelve deal/quote, aplica
`echoGuard` y llama `updateQuote`/`updateDeal`. La Fase 4 (número de MO) ya había probado que
alcanza con agregar una rama más al payload. Este build sigue el mismo patrón para
`estado_presupuesto_odoo`/`estado_facturacion_odoo`, sin construir una clase nueva.

**Por qué no hay riesgo nuevo de bucle.** `state`/`invoice_status` son datos que solo Odoo
produce; HubSpot nunca los escribe de vuelta a Odoo, así que el dedup genérico de `echoGuard`
(por `sourceId:JSON.stringify(properties)`) alcanza sin necesitar lógica bidireccional nueva.
Para el retroceso de etapa, mover el deal *fuera* de cierre-ganado tampoco puede re-disparar el
fan-out hacia Odoo: `createMustHaveDealStage`/`createMustBeInPipeline` (Fase 5, en producción)
exigen que el deal esté en cierre-ganado para encolar un sync — un webhook sobre este cambio de
etapa quedaría filtrado en `plan.preflight`, igual que hoy con cualquier deal fuera de esa
etapa.

**Por qué la etapa "anterior" se resuelve vía historial, no un valor fijo.** El usuario
confirmó que no hay un valor conocido de antemano — depende de en qué etapa estaba cada deal
específico antes de cerrar. `resolvePreviousDealStage(history, currentStage)` es una función
pura (sin red) que toma el historial ya ordenado cronológicamente en reversa que devuelve
HubSpot (`propertiesWithHistory.dealstage`) y busca el primer valor distinto al actual. Si no
hay ninguno (nunca tuvo otra etapa), `revertDealStage` hace soft-fail: solo loguea una
advertencia, nunca lanza.

**Alcance deliberadamente NO cubierto en este build** (ver plan): facturación electrónica
granular (pendiente un probe de `account.move`, no explorado por el spike), reintento de
búsqueda de MO vía polling de `mrp.production` (mejora la brecha conocida de Fase 4, no
solicitada aquí), y el rechazo síncrono de auto-confirmación de Fase 4 como disparador del
retroceso de etapa (el usuario confirmó que el caso real es solo la cancelación posterior del
`sale.order`, no ese camino).

## Test specification

| # | Qué garantiza | Test | Tipo | Resultado |
|---|---|---|---|---|
| 1 | `MongoMappingRepository.findByTargetId` encuentra el mapping por el id de Odoo guardado en `targetId` | `MongoMappingRepository.test.js:findByTargetId (...)` (2 casos) | unit | PASS |
| 2 | `searchSalesOrdersChangedSince` busca `sale.order` por `write_date` (stub + http) | `odooApiClient.test.js:searchSalesOrdersChangedSince (...)` (2 casos) | unit | PASS |
| 3 | `OdooSaleOrderSource.listChangedSince` pagina correctamente hasta una página corta | `OdooSaleOrderSource.test.js` (4 casos) | unit | PASS |
| 4 | `buildQuotePropertyDefinitions` provisiona las 2 propiedades nuevas con defaults seguros | `quotePropertyDefinitions.test.js` (2 casos nuevos) | unit | PASS |
| 5 | `QUOTE_PROPERTIES` incluye las 2 propiedades — la trampa que el plan marcó | `hubspotApiClient.quote.test.js:includes the sale.order state...` | unit | PASS |
| 6 | `HubspotSourceGateway.writeBack` mapea ambas propiedades a las configuradas, con defaults | `HubspotSourceGateway.test.js` (2 casos nuevos) | unit | PASS |
| 7 | `cfg.hubspot.propertyQuoteState/propertyQuoteInvoiceStatus` con defaults y override por env var | `config.test.js` (2 casos nuevos) | unit | PASS |
| 8 | `saleOrderStatusSyncModule.runIncremental`: busca mapping por `targetId`, escribe si existe, cuenta `unmapped` si no | `saleOrderStatusSyncModule.test.js` (2 casos) | unit | PASS |
| 9 | El cursor avanza a `(max write_date visto - overlapMs)` solo con cero fallos | `saleOrderStatusSyncModule.test.js:advances the cursor...` / `...does NOT advance...` | unit | PASS |
| 10 | `saleOrderStatusSyncJobModule`: corre el tick, marca completado/fallido, siempre reprograma el siguiente | `saleOrderStatusSyncJobModule.test.js` (7 casos, mirror de `productSyncJobModule.test.js`) | unit | PASS |
| 11 | `cfg.saleOrderStatusSync` con defaults (deshabilitado, tick 60s, watchdog 30min) y overrides | `config.test.js:saleOrderStatusSync (...)` (3 casos) | unit | PASS |
| 12 | `getDealStageHistory` pide `propertiesWithHistory=dealstage` y devuelve el arreglo | `hubspotApiClient.test.js:getDealStageHistory (...)` (2 casos) | unit | PASS |
| 13 | `resolvePreviousDealStage` encuentra el primer valor distinto al actual; `null` si no hay ninguno | `HubspotSourceGateway.test.js:resolvePreviousDealStage (...)` (2 casos) | unit | PASS |
| 14 | `revertDealStage` resuelve el deal desde `sourceId`, escribe la etapa anterior, soft-fail sin historial distinto, y no repite la escritura por `echoGuard` | `HubspotSourceGateway.test.js:revertDealStage (...)` (3 casos) | unit | PASS |
| 15 | `runIncremental` llama `revertDealStage` solo cuando `state === 'cancel'` | `saleOrderStatusSyncModule.test.js:calls revertDealStage...` / `...does NOT call...` | unit | PASS |

## Coverage y brechas conocidas

`npx vitest run --coverage <archivos de esta fase>`:

| Archivo | Líneas | Ramas | Funciones |
|---|---|---|---|
| `MongoMappingRepository.js` | 100% | 78.57% | 100% |
| `odooApiClient.js` | 83.62% | 77.64% | 73.07% |
| `OdooSaleOrderSource.js` | 100% | 90% | 100% |
| `quotePropertyDefinitions.js` | 100% | 100% | 100% |
| `HubspotSourceGateway.js` | 74.9% | 58.46% | 72.72% |
| `hubspotApiClient.js` | 60.51% | 49.27% | 40% |
| `saleOrderStatusSyncModule.js` | 100% | 85.71% | 100% |
| `saleOrderStatusSyncJobModule.js` | 97.87% | 76.19% | 100% |

El umbral global (80%) no se cumple corriendo solo estos archivos — el cálculo es sobre todo
`src/`, igual que en las evidencias de Fases 2-4. La corrida completa sin `--coverage`
confirma **781/781 pasando en 77 archivos**, sin regresiones.

**Fuera de alcance de este ciclo, no implementado** (documentado también en el plan):

- Facturación electrónica granular (`account.move`) — pendiente un probe nuevo.
- Reintento de búsqueda de MO vía polling de `mrp.production` — mejora la brecha conocida de
  Fase 4, no construida aquí.
- Rechazo síncrono de auto-confirmación (Fase 4) como segundo disparador del retroceso de
  etapa — confirmado con el usuario que no es el caso real a cubrir.
- Verificación manual contra Odoo/HubSpot reales en staging — pendiente, requiere activar
  `SALE_ORDER_STATUS_SYNC_JOB_ENABLED=true` y cancelar un presupuesto ya sincronizado.

## Merge evidence

Checkpoints en la rama `main`, en orden:

- `62ed3ac` — RED findByTargetId (2/2 fallando)
- `70f7392` — GREEN infraestructura (744/744 suite completa)
- `63307a4` — RED listado incremental sale.order
- `0769f95` — GREEN listado incremental (750/750 suite completa)
- `a8194e5` — RED propiedades + write-back (7/7 fallando)
- `c661d7d` — GREEN propiedades + write-back (756/756 suite completa)
- `d10684d` — RED módulo de sync + job loop
- `061b3e8` — GREEN módulo de sync + job loop + wiring (772/772 suite completa)
- `8a4157d` — RED retroceso de etapa (8/8 fallando)
- `92536d3` — GREEN retroceso de etapa (781/781 suite completa)
