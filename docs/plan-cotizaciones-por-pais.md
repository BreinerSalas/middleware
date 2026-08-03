# Plan — Un presupuesto de Odoo por cotización de HubSpot (fan-out por país)

> **Estado: PROPUESTO, SIN IMPLEMENTAR.** Escrito el 2026-08-03 tras la demo con el cliente
> (2026-07-31) y la reunión interna donde se resolvió usar cotizaciones de HubSpot.
> Relacionado: [`plan-presupuesto-pais-y-mo.md`](plan-presupuesto-pais-y-mo.md) (implementado —
> este plan lo extiende), [`todo-sku-sintetico.md`](todo-sku-sintetico.md) (pendiente aparte).

## Contexto

Visual Branding vende **el mismo inventario a varios países dentro de un solo deal**. El
inventario no cambia; lo que cambia por país son los gastos de destino (DDP / incoterms), y por
eso cada país necesita su propio presupuesto en Odoo, que después se convierte en factura por país
(Andrea: *"el presupuesto después se convierte en la factura y ahí sí facturamos por países"*).

En la demo del 2026-07-31 se descartó la idea de un deal por país (*"le intensificaría el trabajo a
ventas"*) y en la reunión interna del 2026-08-03 se cerró la solución: **las cotizaciones
(quotes) de HubSpot son el vehículo**. Juan Carlos verificó en Construtecho que HubSpot sí permite
varias cotizaciones publicadas por negocio, cada una con su propia moneda y precios guardados
(*"aquí se queda en quetzales, en el otro se queda en dólares… la información sí se guarda"*). La
propiedad de país va **en la cotización**, no en el deal.

Estado del código hoy: un deal cerrado-ganado produce **exactamente un** `sale.order`, con
`origin: "hs:<dealId>"`, sus líneas tomadas de los line items del **deal**, y el `country_expense`
derivado del país del partner de Odoo. **No hay una sola línea de código que toque HubSpot Quotes.**

Resultado buscado: un deal ganado con N cotizaciones elegibles produce N presupuestos en Odoo, cada
uno con el `country_expense` de su país y sus propias líneas, y cada cotización de HubSpot queda
con el nombre de su presupuesto escrito de vuelta. El trigger no cambia: sigue siendo cerrado-ganado.

## Decisiones tomadas (no re-litigar)

| # | Decisión |
|---|---|
| **A** | Cotización elegible = `hs_status` publicado **Y** propiedad de país llena. Las publicadas sin país se saltan de forma visible sin bloquear las demás del deal. |
| **B** | Deal sin cotizaciones elegibles → **fallback al comportamiento actual**: un presupuesto desde los line items del deal, país desde el partner. Nada de lo que funciona hoy se rompe. |
| **C** | El país se identifica con un **dropdown ISO-2** (`CR`, `GT`, `MX`…) en la cotización. El middleware resuelve ISO → `res.country` → `operation.costs` reusando `pickOperationCostForCountry`. Inmune al idioma del usuario RPC de Odoo. |
| **D** | Writeback: **una propiedad nueva en el objeto quote** con el nombre del presupuesto (`S06613`). El deal ya no recibe writeback en el camino de fan-out (sí en el de fallback). |
| **E** | Multi-moneda dentro de un deal **no se soporta** (regla de negocio: México va en deal aparte). Se detecta y se reporta, no se bloquea. |

## La idea que hace el cambio pequeño: `sourceId` compuesto

El job hijo usa `sourceId = "<dealId>:q<quoteId>"`. Con eso, **toda la infraestructura existente
sigue funcionando sin tocarse**: `jobs`, `MongoDedupeGuard`, el índice `unique` de `sourceId` en
`src/adapters/outbound/mongo/schemas/mapping.schema.js` (un mapping 1:1 por cotización, cero
migración), `RetryPolicy`, el audit trail y el panel. Y el reintento y el skip pasan a ser **por
país**: si el producto de la cotización de Guatemala no resuelve, `assertProductsResolved` lanza
`SkipSyncError` para esa sola cotización y las otras cuatro se crean igual. Con un job único por
deal, un skip mataría las cinco.

Flujo:

```
webhook (sin cambios)
  └─ job kind:'deal'
       ├─ tiene cotizaciones elegibles → encola N jobs kind:'quote' → COMPLETED
       └─ no tiene                     → delega al flujo actual (fallback)

     job kind:'quote'  →  ProcessSyncJobUseCase SIN CAMBIOS ESTRUCTURALES
```

---

## Paso 0 — Sondas (compuerta: no escribir código antes)

Nuevo `scripts/probes/hubspot-quote-readiness.js`, siguiendo el patrón de
`scripts/probes/odoo-quote-readiness.js` (misma forma de reporte `{id, status, summary, data}` a
JSON en `docs/testing/`).

| # | Sonda | Por qué bloquea |
|---|---|---|
| **Q1** | Leer las quotes de un deal real con varias publicadas y volcar sus `hs_status` reales | Fija el default de `HS_QUOTE_ELIGIBLE_STATUSES`. "Publicada" en la UI no es un valor de `hs_status`; hay que ver qué manda *este* portal (`APPROVAL_NOT_NEEDED` vs `APPROVED` vs `PENDING_APPROVAL`). Adivinar acá hace que **ninguna** cotización califique. |
| **Q2** | `GET /crm/v3/properties/quotes` — confirmar que se pueden crear propiedades custom y ver `modificationMetadata.readOnlyValue` | Si el objeto quote no admite propiedades custom escribibles, la decisión D no existe y el writeback tiene que ir al deal. |
| **Q3** | `PATCH` de una propiedad custom sobre una quote **ya publicada** de prueba | **La sonda más importante.** HubSpot congela partes de una quote publicada. Si el PATCH da 4xx, el writeback de la decisión D es un no-op silencioso en producción. Única sonda que escribe; sobre una quote de prueba, en una propiedad nuestra. |
| **Q4** | `GET /crm/v3/objects/quotes/{id}/associations/line_items` en cada quote del deal de Q1 | Confirmar que cada cotización trae **sus** líneas y no las del deal. Si vinieran vacías o iguales para todas, el fan-out no aporta nada. |
| **Q5** | `res.country.search_read([['code','in',['CR','GT','HN','SV','NI','PA','MX']]], ['id','code','name'])` cruzado con `listOperationCosts()` | Qué ISO tienen gastos configurados. Es la lista que alimenta el dropdown y el conjunto de países irresolubles conocidos. |
| **Q6** | Scopes del token: `crm.objects.quotes.read/write`, `crm.schemas.quotes.read/write` | **Bloqueante operativo.** El token actual solo pide scopes de deals (ver `.env.example`). Sin esto todo da 403 y hay que re-emitir el token de la Private App. |

---

## Paso 1 — Cliente HubSpot (`src/adapters/outbound/hubspot/hubspotApiClient.js`)

Todo pasa por `requestWithRateLimit` (el rate limiter y el retry de 429 se heredan gratis).

- **Extraer** `getLineItemsFor(objectType, objectId)` del cuerpo actual de `getDealLineItems`
  (`:96-121`), que solo tiene `deals` hardcodeado en la URL de asociaciones. Dejar
  `getDealLineItems(dealId)` como wrapper de una línea — los tests existentes y el camino de
  fallback lo siguen usando. Agregar `getQuoteLineItems(quoteId)` como el segundo wrapper.
- **`getDealQuotes(dealId, properties)`** — `GET /crm/v3/objects/deals/{id}/associations/quotes`
  y después `POST /crm/v3/objects/quotes/batch/read`. Es la misma coreografía de
  `getDealLineItems`; extraer el helper de "asociaciones + batch read" si sale natural, no forzarlo.
- **`getQuote(quoteId, properties)`** y **`updateQuote(quoteId, properties)`** — espejo exacto de
  `getDeal` (`:82-88`) y `updateDeal` (`:123-127`).
- `ensureCustomProperty(objectType, ...)` (`:203-214`) **ya es genérico**: sirve para `'quotes'`
  sin tocarlo.
- `QUOTE_PROPERTIES`: `hs_status`, `hs_title`, `hs_currency`, `hs_quote_amount`, + los dos nombres
  configurables (país, id de presupuesto).

## Paso 2 — Gateway de origen (`src/adapters/outbound/hubspot/HubspotSourceGateway.js`)

- **`parseSourceId(sourceId)`** → `{ dealId, quoteId }`, pura y exportada. Separador `:q` para que
  sea inequívoco y legible en el panel.
- **`isEligibleQuote(quote, { countryProperty, allowedStatuses })`** → `{ eligible, reason }`,
  pura y exportada. Implementa la decisión A. Devolver el *motivo* del descarte, no un booleano:
  es lo que hace que "publicada pero sin país" sea visible en el audit.
- **`listEligibleQuotes(dealId)`** → `{ eligible: [...], skipped: [{quoteId, reason}] }`.
- **`fetchRecord(sourceId)`** bifurca por `parseSourceId`. Con `quoteId`: `getDeal` + `getQuote`,
  y devuelve `{ id: sourceId, dealId, quoteId, properties: <deal>, quote: { id, properties } }`.
  Sin `quoteId`: lo de hoy, más `dealId: data.id` para que el mapper no tenga que adivinar.
- **`resolveReferences(record)`**: `getQuoteLineItems(record.quoteId)` cuando hay cotización,
  `getDealLineItems` si no. El `catch` que degrada a `[]` (`:63-68`) se conserva tal cual.
- **`writeBack(sourceId, payload)`**: con `quoteId`, `updateQuote(quoteId, { <propQuoteOdooId>: ... })`;
  sin él, lo de hoy sobre el deal. El echo guard se mantiene, con el `sourceId` compuesto en la
  clave (ya lo es, por construcción).

## Paso 3 — Cliente Odoo (`src/adapters/outbound/odoo/odooApiClient.js`) — las dos ramas, stub y http

**`searchCountryIdsByCodes(codes)`** → `{ [ISO]: { id, name } }`. Memoizada por promesa con TTL,
copiando **literalmente** el idioma de `listOperationCosts` (`:128-153`) para que los 3 workers
concurrentes compartan un solo RPC en vuelo. `res.country` es estático; TTL largo.
- http: `res.country.search_read([['code','in',cleaned]], {fields:['id','code','name']})`
- stub: `{}`

## Paso 4 — Gateway de destino (`src/adapters/outbound/odoo/OdooTargetGateway.js`)

`resolveCountryExpense(odooCustomerId, correlationId)` (`:167-243`) hace hoy dos cosas pegadas:
averigua el `countryId` y después elige el `operation.costs`. **Partirlo en tres**, sin cambiar la
semántica de ninguna:

1. `resolveCountryIdFromPartner(odooCustomerId)` → el walk de `parent_id` que ya existe (`:187-206`), intacto.
2. `resolveCountryIdFromIsoCode(iso)` → `searchCountryIdsByCodes([iso])`.
3. `pickCountryExpense({ countryId, countryName })` → de `:215-242`, sin tocar.

`upsert` elige la fuente: `record.quote` con ISO → (2); si no → (1), que es exactamente el
comportamiento de hoy.

⚠️ **`searchCountryIdsByCodes` va con guardia `typeof this.apiClient.X === 'function'`**, igual
que `:183` y `:215`. Sin eso, los 26 tests que llaman `upsert()` rompen de golpe porque su
`makeApi` no define el método. Es la misma restricción que documentó el plan anterior y sigue
siendo la más importante del cambio.

Los fallos degradan a `status:'unresolved'` con `warn` — **nunca** `TransientSyncError` (decisión C
del plan anterior, sigue vigente): el presupuesto se crea igual y el `SMARTFLOW_MARKER` (`:85`) en
la `note` lo hace visible para quien lo confirma en Odoo. Agregar un `reason` nuevo:
`'quote_country_iso_not_found'`.

## Paso 5 — Mapper (`src/adapters/outbound/odoo/dealToSaleOrderMapper.js`)

- `origin`: `hs:${dealId}` o `hs:${dealId}:q${quoteId}`. Construirlo desde parámetros **explícitos**,
  no de `hsDeal.id` (`:17`) — que ahora es el sourceId compuesto y lo produciría por accidente.
- `note`: agregar el título de la cotización y el país cuando existan —
  `Deal: X\nCotización: <hs_title> (GT)`. Es lo que una persona ve en Odoo para saber qué
  presupuesto es de qué país, y cubre parcialmente lo que Andrea pidió sin agregar campos nuevos.
- La firma se mantiene retrocompatible: sin `quote`, el payload sale idéntico al de hoy.

## Paso 6 — Fan-out: nuevo caso de uso

**`src/core/application/use-cases/PlanDealSyncUseCase.js`**

```
execute({ job })
  1. fetchRecord(dealId)
  2. validators de stage/pipeline (barato, evita RPCs de quotes en deals que no aplican)
  3. listEligibleQuotes(dealId)
  4. eligible.length === 0  →  return { mode: 'fallback' }   // NO marca el job
  5. por cada elegible: enqueue { sourceId: `${dealId}:q${id}`, kind: 'quote' }
  6. audit 'deal.expanded' { total, eligible, skipped, currencies }
  7. markCompleted(job)  →  return { mode: 'expanded', ... }
```

- **No** aplicar `mustHaveLineItems` acá: con varias cotizaciones publicadas, los line items del
  deal son un dato que no gobierna nada, y exigirlos haría fallar deals válidos.
- El `rawPayload` de cada hijo deriva del `job.payload` del padre + el `quoteId`. Así dos entregas
  del mismo evento de HubSpot generan el mismo `dedupeKey` (suprimido, correcto), y un cierre-ganado
  nuevo genera uno distinto (re-procesa, correcto). La idempotencia real la sigue dando el `origin`
  en Odoo.
- **Decisión E, acá**: comparar `hs_currency` entre las elegibles. Si difieren, `warn` +
  `currencies` en el audit. Cero RPC extra: las cotizaciones ya están en memoria. No bloquear.

**`src/composition/dealSyncModule.js`** — el despacho, en el `processFn` que ya existe (`:118-120`):

```js
processFn: async (job) => {
  if (job.kind === JOB_KIND.QUOTE) return _processSyncJobUseCase.execute({ job })
  const plan = await _planDealSyncUseCase.execute({ job })
  if (plan.mode === 'fallback') return _processSyncJobUseCase.execute({ job })
  return plan
}
```

El fallback es literalmente *llamar al caso de uso de hoy*: cero riesgo de regresión en el camino
viejo. Cuesta un `getDeal` repetido; con el rate limiter a 9 rps, aceptable.

**`ProcessSyncJobUseCase.js` no se toca.** Ese es el punto del `sourceId` compuesto.

## Paso 7 — Schema, validadores, propiedades, config

- **`src/adapters/outbound/mongo/schemas/job.schema.js`**: `kind: { type: String, default: 'deal',
  index: true }`. El default cubre los documentos existentes sin migración. Constante `JOB_KIND` en
  `src/config/constants.js`, junto a `ENTITIES`.
- **`src/composition/validators.js`**: `createMustHaveQuoteCountry({ countryProperty })`, **no-op
  cuando no hay `record.quoteId`** (si no, mata el camino de fallback). Los otros cuatro
  validadores funcionan sin cambios: `mustHaveLineItems` ya lee `references.lineItems`, que para un
  job de cotización son los de la cotización.
- **`src/composition/provisionDealProperties.js`** hardcodea `'deals'` en `:15`. Generalizar a
  `provisionProperties({ api, objectType, properties })` y dejar `provisionDealProperties` como
  wrapper. Nuevo `src/composition/quotePropertyDefinitions.js` con las dos propiedades de quote
  (país como `enumeration`/`select`, id de presupuesto como `string`/`text`), al estilo de
  `src/composition/dealPropertyDefinitions.js`. Registrar la segunda llamada en `src/server.js:24-38`
  dentro del mismo `try`.
- **`src/config/index.js`** + `.env.example`: `HS_PROPERTY_QUOTE_COUNTRY` (default
  `pais_de_destino`), `HS_PROPERTY_QUOTE_ODOO_QUOTE_ID` (default `id_presupuesto_odoo`),
  `HS_QUOTE_ELIGIBLE_STATUSES` (CSV, default **según Q1**), todos a `OPTIONAL_KEYS`.
  Actualizar el bloque de scopes del `.env.example` con los cuatro de quotes (Q6).

## Paso 8 — Script: poblar el dropdown de países desde Odoo

`scripts/sync-quote-country-options.js`, al estilo de `scripts/sync-products.js` (mismo
`parseArgs`, mismo `--dry-run`).

Lee `listOperationCosts()` + `searchCountryIdsByCodes`, y hace upsert de las opciones del dropdown
en HubSpot con **exactamente los países que tienen gastos configurados en Odoo**. Eso elimina de
raíz la clase entera de fallos "el país elegido no tiene `operation.costs`" — el warn de la sonda
P5 del plan anterior. Que sea un script y no parte del arranque: el boot no debe depender de que
Odoo responda.

---

## Tests

533 `it()` hoy. Esperado ~600. Lo que **no** debería moverse: `ProcessSyncJobUseCase`,
`RetryPolicy`, `SyncJob`, `MongoMappingRepository`, `MongoJobRepository`, el panel.

- **Nuevos puros** (el estilo de la casa — `operationCostsResolver.test.js` es el molde):
  `parseSourceId` (deal pelado / compuesto / basura), `isEligibleQuote` (matriz estado × país,
  verificando el `reason`), `quotePropertyDefinitions`.
- **`hubspotApiClient`**: `getDealQuotes`, `getQuote`, `updateQuote`, `getQuoteLineItems`; y que
  `getDealLineItems` siga pegándole a la URL de `deals` tras la extracción.
- **`HubspotSourceGateway`**: `fetchRecord` en ambas formas; `resolveReferences` leyendo de la
  cotización; `writeBack` yendo a `updateQuote` y **no** a `updateDeal`.
- **`OdooTargetGateway`**: `country_expense` desde ISO; **retrocompat sin
  `searchCountryIdsByCodes` en el `apiClient`** (la guardia); ISO inexistente → `unresolved` +
  marcador en la nota, presupuesto creado igual; ruta de partner intacta.
- **`dealToSaleOrderMapper`**: `origin` compuesto vs pelado; nota con título y país.
- **Nuevo `PlanDealSyncUseCase.test.js`**: expande N; 0 elegibles → `{mode:'fallback'}` sin marcar
  el job; `dedupeKey` de los hijos derivado del padre; monedas mixtas → warn, no bloquea.
- **`test/e2e/full-flow.test.js`**: un caso nuevo de deal con 2 cotizaciones → 2 `sale.order` con
  `origin` distinto y 2 writebacks a quotes; y que el caso existente (deal sin cotizaciones) siga
  pasando **sin modificarlo** — es el test que prueba la decisión B.

## Verificación end-to-end

1. `npm test` — verde antes de tocar staging.
2. `node scripts/probes/hubspot-quote-readiness.js` — Q1-Q6 sin `fail`.
3. `node scripts/sync-quote-country-options.js --dry-run`, revisar, y sin el flag.
4. En HubSpot: un deal de prueba en el pipeline Comercial Visual Branding con 3 cotizaciones
   publicadas (Guatemala, Honduras, Costa Rica), una cuarta publicada **sin país**, y una quinta en
   borrador. Pasar a Cierre Ganado.
5. Panel (`/api/panel/jobs`): 1 job `kind:'deal'` COMPLETED + 3 `kind:'quote'` COMPLETED. La cuarta
   y la quinta **no** deben generar job; el motivo tiene que estar en el audit `deal.expanded`.
6. `node scripts/probes/inspect-quote.js <saleOrderId> <dealId>` por cada presupuesto:
   `country_expense` correcto y distinto entre ellos, `destination_taxes` ≠ 0, `origin` con el
   `:q<quoteId>`, y las líneas de esa cotización.
7. En HubSpot: cada cotización con su `id_presupuesto_odoo` (`S066xx` distintos).
8. Volver a pasar el deal a Cierre Ganado (re-sync) y confirmar con `inspect-quote.js` que **no se
   duplican líneas ni presupuestos** — el `origin` compuesto los encuentra y
   `buildSaleOrderUpdatePayload` omite `order_line`.
9. Confirmar **una** de las cotizaciones en Odoo a mano y verificar que se genera la MO vinculada
   (`origin` = nombre del presupuesto), que es el resultado que se buscaba desde el plan anterior.

## Riesgos y fuera de alcance

- **Q3 es la sonda que puede voltear la decisión D.** Si HubSpot rechaza el PATCH sobre una quote
  publicada, el writeback tiene que caer al deal (CSV en `id_presupuesto_odoo`) y Andrea pierde el
  vínculo 1:1 que pidió. Sondear antes de escribir el Paso 2.
- **Presupuestos huérfanos.** Los deals ya sincronizados tienen un `sale.order` con
  `origin:"hs:<dealId>"`. Al re-sincronizar con fan-out se crean presupuestos nuevos con `origin`
  compuesto y el viejo queda huérfano en draft. Son ~10 en staging. Cancelarlos a mano o con un
  script al estilo de `scripts/cancel-stale-mos.js`; no vale una migración.
- **México** (`visual → visual México` en vez de al cliente final, y moneda distinta) sigue
  pendiente. Es un cambio de **partner**, no de país, y por eso es ortogonal a este plan: el país
  ya quedó confirmado como independiente del partner. Deal aparte por la moneda (decisión E).
- Los cambios de line items en HubSpot posteriores al primer sync **siguen sin propagarse**
  (limitación heredada y documentada de `buildSaleOrderUpdatePayload`).
- La factura de Odoo no se toca. Andrea la genera al aprobar el presupuesto; el middleware entrega
  el presupuesto confirmable y ahí termina su alcance.
