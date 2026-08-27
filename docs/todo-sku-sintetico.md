# TODO — Fix de raíz: SKU sintético para productos sin `default_code`

> **SUPERSEDED by `openspec/changes/hubspot-product-odoo-id-key/`** (rev 2, 2026-08-14).
>
> The synthetic-SKU plan below is **rejected** as policy. Company rule: no customer-visible
> product data is ever mutated by middleware — a synthetic `hs_sku = String(odooId)` would
> stamp meaningless numeric SKUs onto ~5 348 real HubSpot products visible to the client.
>
> The change `hubspot-product-odoo-id-key` reaches the same goal (no-SKU products sync, deal
> line-item resolution works for them) via two decoupled mechanisms that NEVER touch a
> customer-visible field:
>
> 1. **Catalog identity** — a provisioned, unique custom property `id_producto_odoo`
>    (`HubspotProductGateway.buildProperties` writes it always; `batchUpsertProducts` uses
>    it as the sole `idProperty`). Replaces the old SKU-as-key pattern.
> 2. **Line-item resolution** — HubSpot's native `hs_product_id` on the line item is
>    resolved to `odooId` through `product_mapping.findByHubspotId`, inserted as a new
>    tier before the name-based fallback.
>
> **Do not re-propose synthetic `hs_sku` under any future proposal.** The plan below is
> kept only as historical context for anyone tracing why we don't use `hs_sku` as the
> product identity key.
>
> ---
>
> **Estado original: PENDIENTE.** Escrito el 2026-07-30 después de blindar la demo con un puente
> (fallback por nombre + fallo legible). El puente funciona, pero no es la solución
> definitiva. Este documento era el plan del fix real.

## El problema

El catálogo está partido casi por la mitad y esa mitad no puede sincronizar:

| Sistema | Total | Con clave de unión |
|---|---|---|
| Odoo `product.product` | 11 529 | 6 181 con `default_code` (**5 348 sin**) |
| HubSpot Products | 10 010 | 4 645 con `hs_sku` |

Cuando un line item de HubSpot llega sin `hs_sku`, `resolveProductId`
(`src/adapters/outbound/odoo/dealToManufacturingOrderMapper.js:3-8`) devuelve `null`, la
línea de venta sale con `product_id: null` y Odoo rechaza el INSERT por su constraint
`sale_order_line_accountable_required_fields` (exige `product_id` **y** `product_uom` no
nulos). El error RPC viaja con `httpStatus: 200` — JSON-RPC responde 200 aunque falle — que
`RetryPolicy.isRetryableError` clasifica como no-reintentable, así que el job muere en
`DEAD_LETTER` al primer intento.

## La palanca

**El flujo de deals ya acepta un `hs_sku` puramente numérico como id de producto de Odoo**
(`dealToManufacturingOrderMapper.js:6`, `/^\d+$/.test(hs_sku)` → `Number(hs_sku)`). Nadie
conectó ese camino con el product sync. Si el sync publicara `hs_sku = String(odooId)` para
los productos sin `default_code`, **el flujo de deals funcionaría sin tocar una línea**.

## ⛔ Antes de tocar nada: dos compuertas

**1. Auditoría de colisiones. No es opcional.**

Si un producto de Odoo tiene `default_code = "1234"` y otro tiene `id = 1234`, ambos
publican `hs_sku = "1234"`, HubSpot los colapsa en uno, y el flujo manda `product_id: 1234`
para los line items del primero — **el producto equivocado en una orden de manufactura real**.
Eso es peor que el fallo ruidoso de hoy.

Consulta: listar los `default_code` que matchean `/^\d+$/` e intersectarlos con el conjunto
de ids de `product.product`. Si hay intersección, resolver caso por caso (preferir conservar
el `default_code` real y excluir ese id de la asignación sintética) **antes** de seguir.

**2. Verificar que los line items heredan `hs_sku` del producto.**

A mano en la UI de HubSpot: crear un line item desde un producto que tenga `hs_sku` y
confirmar que el line item lo trae. Dos minutos, y todo el plan se apoya en eso. (Al
2026-07-30 el portal tenía 0 line items con SKU, así que no estaba probado. El deal
`63290949983` ya lo demostró indirectamente, pero conviene confirmarlo explícitamente.)

## ⛔ Nunca correr `sync-products.js --include-no-sku` como está hoy

`HubspotProductGateway.buildProperties` (`src/adapters/outbound/hubspot/HubspotProductGateway.js:19-31`)
omite `hs_sku` cuando falta `default_code`. Sin SKU no hay clave de deduplicación, así que
`upsertBySku` (líneas 42-48, guardado por `if (hasSku)`) **salta la búsqueda previa** y va
directo a `createProduct`.

Consecuencia: **~5 348 productos duplicados por invocación**, y encima
`productSyncModule.js:183` filtra los resultados sin SKU de la persistencia, así que no queda
registro en Mongo de lo que se creó. Ensucia el CRM del cliente de forma difícil de revertir.

## Pasos (TDD, RED antes de GREEN)

### 1. `src/core/domain/productSku.js` (nuevo)

Una sola función define "qué SKU publicamos para este producto de Odoo", usada por todos los
escritores. Va en dominio, al lado de `ProductMapping.js`.

- `hasRealSku(p)` — la lógica actual de `hasValidSku`, movida tal cual.
- `resolveSku(p)` — `default_code` trimmeado si es real; si no `String(id)` cuando `id` es
  entero positivo; si no `''`.
- `isSyntheticSku(p)` — `!hasRealSku && resolveSku !== ''`.

**El SKU sintético tiene que ser puramente numérico.** Un prefijo tipo `ODOO-123` rompe el
camino directo de `resolveProductId` y forzaría cambios en el flujo de deals, que es
exactamente lo que este diseño evita.

**Por qué `hs_sku` y no una propiedad custom tipo `odoo_product_id`:** `hs_sku` es una
propiedad estándar que HubSpot copia del producto al line item cuando se crea desde el
catálogo. Una propiedad custom **no se propaga** al line item, así que `getDealLineItems`
(`hubspotApiClient.js:106-121`, `LINE_ITEM_PROPERTIES`) nunca la vería. `hs_sku` es el único
vehículo disponible sin rediseñar el flujo de deals.

### 2. `HubspotProductGateway`

- `buildProperties` siempre setea `props.hs_sku = resolveSku(p)` (borrar el `if`).
- `upsertBySku`: quitar la guardia `if (hasSku)` de las líneas 42-48 — **eso es lo que lo
  vuelve idempotente**. Nuevo skip: `if (!sku) return { skipped: true, reason: 'no_sku_no_id' }`.
- `batchUpsertBySkus`: borrar la partición por `hasValidSku` (líneas 84-90); solo las filas
  genuinamente inservibles (sin id y sin código) van a `skipped`.

### 3. `productSyncModule`

- Borrar el predicado duplicado de `partition()` (líneas 39-41) y usar `resolveSku`.
- Arreglar `dryRunItem` (línea 27) para reportar el sku **resuelto** más `synthetic: true`;
  hoy el dry-run no te dice nada del cambio que estás por hacer.
- Quitar el filtro de la línea 183 (`filter((m) => m.hsSku && ...)`) dejando solo una guardia
  de truthiness; las comparaciones contra `'null'`/`'false'` solo existían para tapar el caso
  sin SKU.
- Borrar el código muerto de la línea 68 (`sentMap.set(this ? null : null, p)`).

### 4. Adopción de los ~5 348 productos que ya existen en HubSpot sin SKU

Sin esto, la primera corrida completa crea 5 348 productos **nuevos** al lado de los 5 348
existentes (~15 358 en total), y los productos que ya usa el negocio **no** serían los que
llevan el SKU. La demo se vería bien en los números y fallaría en la práctica.

**La adopción es una tarea de migración, no de régimen estable.** No poner un fallback por
nombre dentro de `upsertBySku`: serían +1 llamada de búsqueda × 11 529 productos en cada
corrida, para siempre, resolviendo un problema que ocurre una vez.

Arreglar `scripts/backfill-product-no-sku.js`, que ya tiene el 90% de la maquinaria (pagina
`hs_sku NOT_HAS_PROPERTY`, indexa por nombre exacto, matchea contra los productos sin SKU de
Odoo). Cuatro cambios:

1. **Que escriba en HubSpot de verdad.** Tras matchear, `updateProduct(candidate.id, { hs_sku: String(odooId) })`.
   Hoy solo escribe filas de Mongo que **nada en el flujo de deals lee**, o sea que el script
   no logra nada funcional.
2. **No adoptar ante ambigüedad.** La línea 105 hace `candidates.shift()` y toma el primero
   de N. Adoptar el gemelo equivocado estampa un `product_id` real sobre el producto
   equivocado y produce órdenes de manufactura silenciosamente incorrectas. Registrar
   `lastAction: 'no_sku_no_match'` con `metadata.reason = 'ambiguous_name'` y dejar que el
   sync cree un producto canónico limpio.
3. **Agregar `sorts` a la búsqueda paginada.** `fetchAllHubspotNoSkuInBatches` (líneas 28-45)
   pagina con `after` sin orden explícito; el deep-paging de HubSpot sin `sorts` puede saltear
   o repetir registros, así que algunos productos nunca se adoptan y después duplican. Agregar
   `sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }]` en `searchProducts`
   (`hubspotApiClient.js:195-201`).
4. **Agregar `--dry-run`, `--limit=N`, `--odoo-id=N`** (reutilizar `parseArgs` de
   `scripts/sync-products.lib.js`) y corregir el env por defecto de la línea 53: apunta a
   `.env.staging`, que **no existe**.

Extraer el matching puro a `scripts/adopt-no-sku.lib.js` (`indexByName`, `planAdoptions`)
espejando el split `sync-products.js` / `sync-products.lib.js`, para poder testearlo sin red.

Clave de match: `String(name).trim().replace(/\s+/g, ' ').toLowerCase()` — la misma que
`src/adapters/outbound/odoo/productNameKey.js`, que ya existe (la creó el puente). Reportar
matches exactos y normalizados por separado en el dry-run, para ver si la normalización
compra matches o compra ambigüedad antes de comprometerse.

Cada candidato de HubSpot debe consumirse a lo sumo una vez (el `shift()` actual ya lo logra
— preservar esa propiedad).

### 5. Transición cuando alguien agrega un `default_code` después

Con `resolveSku` prefiriendo el código real, la siguiente corrida calcula `"AB-123"`,
`searchProductByHsSku("AB-123")` no encuentra nada y **crea un segundo producto en HubSpot**,
dejando huérfano el original con SKU-id (que sigue resolviendo bien, así que no se rompe nada:
solo queda un catálogo sucio y dos productos para elegir).

Resolver con el registro que ya existe, indexado por el identificador estable:
`mappingRepo.findByOdooId(odooId)` (índice único en `odooId`). Si hay un mapping cuyo `hsSku`
difiere del recién resuelto, es un rename: reusar `mapping.hubspotId` y
`updateProduct(hubspotId, properties)` para re-estampar en el lugar. Sin cambios de esquema.

`batchUpsertBySkus` **no puede** hacer esto — `idProperty: 'hs_sku'` crea cuando no encuentra
el id. Los renames tienen que ir por el camino de a uno: `partition()` pasa a
`partitionForSync(products, mappingsByOdooId)` → `{ batch, renames, unusable }`.

**Prioridad:** implementar ya la **detección** más un log `product-sync.sku_changed` (barato,
y así te enterás en vez de duplicar en silencio). El `restampSku` en sí puede esperar.

### 6. Bugs menores a arreglar en el camino

Hacen que el canario y el loop no sean confiables:

- `src/adapters/outbound/odoo/OdooProductSource.js:29-31` — el chequeo de `limit` está
  **después** del `if (count < this.pageSize) break`, así que una página corta ignora
  `--limit` por completo, y una página llena sobre-trae hasta `pageSize` antes de cortar.
  Mover el chequeo arriba del break y cortar sin condición. Tres líneas.
- `scripts/sync-products.lib.js:17` — un `--interval` pelado devuelve `null`, `shouldRunOnce`
  da false, y `setInterval(fn, null)` dispara cada ~1ms, martillando HubSpot. Caer al default
  cuando `args.interval === true`, o guardar en `sync-products.js:78`.
- `src/adapters/outbound/mongo/MongoProductMappingRepository.js:37-56` — `bulkUpsertMany`
  nunca persiste `metadata`, así que todo lo que `backfill-product-no-sku.js` registra en las
  líneas 98 y 111 (nombre, precio, cantidad de candidatos, razón de ambigüedad) se evapora.
  Agregar `metadata` al `$set`, pero **solo cuando el llamador lo provee**, para que una
  corrida posterior no pise la procedencia del backfill con `{}`.
- `scripts/sync-products.js:58-75` — el camino de `--help` no llama `disconnectMongo`, así que
  cuelga el proceso.

### 7. Secuencia de migración

```bash
# 1. dry-run de adopción — esperar ~5348 sin sku en Odoo, N matcheados, A ambiguos
SMARTFLOW_ENV_FILE=.env node scripts/backfill-product-no-sku.js --dry-run

# 2. canario por id, y verificar en la UI de HubSpot
SMARTFLOW_ENV_FILE=.env node scripts/backfill-product-no-sku.js --odoo-id=<id1> --odoo-id=<id2>

# 3. adopción completa: ~5348 PATCHes a ~9 rps ≈ 10 min
SMARTFLOW_ENV_FILE=.env node scripts/backfill-product-no-sku.js

# 4. re-correr adopción — debería reportar ~0 matcheados (prueba el paso 3 + el fix de sorts)
SMARTFLOW_ENV_FILE=.env node scripts/backfill-product-no-sku.js --dry-run

# 5. sync: dry-run, canario, completo
SMARTFLOW_ENV_FILE=.env node scripts/sync-products.js --once --dry-run --include-no-sku
SMARTFLOW_ENV_FILE=.env node scripts/sync-products.js --once --include-no-sku --limit=200
SMARTFLOW_ENV_FILE=.env node scripts/sync-products.js --once --include-no-sku

# 6. LA prueba de aceptación: correrlo otra vez y verificar que el total de productos NO cambió
SMARTFLOW_ENV_FILE=.env node scripts/sync-products.js --once --include-no-sku
```

Pasar siempre `--once`. Números esperados: el total de HubSpot va de 10 010 a
10 010 + (productos de Odoo sin SKU y sin gemelo por nombre) — **enfáticamente no +5 348**.
Los productos con `hs_sku` deberían acercarse a 11 529 menos las filas inservibles. El conteo
de `productmappings` en Mongo debería quedar en ≈11 529.

## Tests

**Nuevos (RED antes de cualquier edición de producción):**

- `test/core/domain/productSku.test.js` — `hasRealSku` con `false`/`null`/`''`/`'  '`/`'AB-1'`;
  `resolveSku` prefiere el código real; devuelve `String(id)` en cada variante vacía; `''` sin
  id o con id 0/no-entero; **el SKU sintético siempre satisface `/^\d+$/`**.
- `test/adapters/hubspot/HubspotProductGateway.syntheticSku.test.js` — la guardia
  cross-módulo: importar `buildProperties` y `resolveProductId` y afirmar
  `resolveProductId({ hs_sku: buildProperties({ id: 7, name: 'X', default_code: false }).hs_sku }) === 7`.
  Es la mejor valla contra que alguien más adelante "mejore" el SKU con un prefijo.
- `test/scripts/adopt-no-sku.lib.test.js` — adopción por nombre exacto planifica
  `hs_sku === String(odooId)`; dos candidatos → `ambiguous`, **no** adoptado; cero → `notFound`;
  un candidato de HubSpot nunca adoptado por dos productos de Odoo; normalización que crea
  ambigüedad igual rechaza.
- Casos nuevos en `test/adapters/mongo/MongoProductMappings.test.js` (persiste `metadata`, y no
  la pisa al re-upsertar sin ella) y en `test/adapters/odoo/OdooProductSource.test.js`
  (`limit` respetado con una sola página).

**Existentes que codifican el contrato viejo y hay que invertir:**

- `test/adapters/hubspot/HubspotProductGateway.test.js` — `:29-36` y `:38-43` ("omits hs_sku…")
  pasan a "cae a `hs_sku = String(id)`". `:59-69` ("goes straight to create (no search)") pasa a
  "busca por el SKU sintético y después crea": `searchProductByHsSku` **sí** se llama con `'7'`
  y el payload de create **sí** trae `hs_sku`. `:110-119` y `:121-128` igual. Dejar los casos de
  nombre vacío (`:71-78`, `:130-146`). Agregar "sin id y sin `default_code` → `no_sku_no_id`" y
  "`default_code` real gana sobre el id".
- `test/adapters/hubspot/HubspotProductGateway.batch.test.js` — `:48-62` pasa a "incluye los
  productos sin SKU usando el id": `inputs` de largo 5, `r.skipped` vacío. Agregar un caso donde
  el `default_code` de un producto **iguala el id de otro**, afirmando que la deduplicación de
  las líneas 91-105 los colapsa y avisa — la colisión, codificada.
- `test/composition/productSyncModule.test.js` — `:35-56` ahora espera los 3 productos en
  `batchUpsertBySkus` y 0 llamadas a `upsertBySku`. `:71-86` espera el sku resuelto y
  `synthetic: true`.
- `test/composition/productSyncModule.persistence.test.js` — `:56-85` ahora espera 3 items.

## Decisiones ya tomadas (no re-litigar)

- **`productMapping` NO debe volverse caché de lectura del flujo de deals.** Agregar
  `findByHsSku` y cablearlo en `OdooTargetGateway` no aporta información: el `hs_sku` numérico
  **es** el id de Odoo, así que el viaje a Mongo devolvería un dato que ya tenés. Sumaría una
  dependencia en el camino caliente, un modo de falla por staleness y un índice único que hoy
  no tiene. Sirve para lo del paso 5 (`findByOdooId`) y nada más.
- **No cablear el product sync en `src/server.js` ni exponer un endpoint HTTP.** Sería una
  superficie de trabajo largo sin autenticar. CLI está bien por ahora.
  **Revisitada (no revertida en silencio) por `sdd/hubspot-product-reverse-discovery` (PR5,
  2026-08-27):** el motor de reconciliación de huérfanos (`productOrphanReconcileModule.js`)
  sí se cablea en `src/server.js` vía `createTickJobModule`, igual que `productSyncJobModule` —
  no como endpoint HTTP nuevo, sino como job interno flag-gated (`PRODUCT_ORPHAN_RECONCILE_JOB_ENABLED`,
  default `false`), reusando el mismo poller/locking/watchdog que ya corre en el proceso. El CLI
  (`scripts/backfill-product-odoo-id.js --reconcile-orphans`) sigue disponible para corridas
  manuales. Ver el design de ese change (decisión D9) para el detalle completo.
- **No borrar ni archivar los 5 348 productos sin SKU** en vez de adoptarlos: es destructivo en
  el CRM del cliente y deja huérfanos los line items existentes.
- **Conflar "SKU" con "id interno de Odoo" es aceptable**, con la advertencia de colisión de
  arriba resuelta. El costo blando es que el cliente ve ~5 348 SKUs numéricos sin significado
  en su CRM — eso es una decisión de producto, hay que pedir buy-in explícito.

## Contexto: el puente que ya está en producción

El fix de raíz **no reemplaza** lo que se hizo el 2026-07-30; las dos capas conviven:

1. `OdooTargetGateway.lookupByName` + `odooApiClient.searchProductIdsByNames` — fallback por
   `name` con `=ilike` cuando no hay `hs_sku` usable. Sigue siendo útil como última red para
   line items creados a mano.
2. `collectUnresolvedLines` + `assertProductsResolved` — corta con `SkipSyncError` y un motivo
   legible antes de escribir en Odoo, en vez de dejar pasar `product_id: null`. Permanente.
3. `ProcessSyncJobUseCase` expone `err.detail` como `skipDetail` en el audit `job.skipped`.
4. `dealToManufacturingOrderMapper` setea `product_uom` en la línea de venta (Odoo no lo
   autocompleta por RPC: el relleno vive en el `onchange` de la UI).

Una vez migrado el catálogo, el fallback por nombre casi nunca se va a disparar — que es
justamente el objetivo.
