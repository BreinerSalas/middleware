# Plan — Presupuesto completo con país, y que Odoo genere la orden de fabricación

> **Estado: APROBADO, SIN IMPLEMENTAR.** Escrito el 2026-07-31 tras la reunión donde se
> priorizó vincular la orden de fabricación con el presupuesto.
> Relacionado: [`todo-sku-sintetico.md`](todo-sku-sintetico.md) (pendiente aparte).

## Contexto

Hoy el middleware crea **dos** registros en Odoo al cerrarse un deal: un presupuesto
(`sale.order`, draft) y una orden de fabricación (`mrp.production`, draft). Eso trae tres
problemas medidos contra staging:

1. **La MO no está vinculada al presupuesto.** Solo comparten el string `origin: "hs:<dealId>"`.
   Odoo las ve como registros independientes: sin botones inteligentes, sin trazabilidad, sin
   relación de abastecimiento. Vincularlas fue el tema prioritario de la reunión.
2. **La MO solo cubre el primer line item.** El presupuesto lleva todas las líneas, la MO solo
   `hsLineItems[0]`. Un deal con 3 productos fabrica 1.
3. **El presupuesto llega comercialmente incompleto.** Le falta `country_expense` (etiquetado
   **"País"**, many2one a `operation.costs`), que aporta los costos DDP de importación del país
   destino. Sin él `destination_taxes` queda en 0.

Los números medidos: **6 523 de 6 534** presupuestos en Odoo tienen `country_expense`;
**3 211 de 3 214** confirmados lo tienen. De los 9 que creó nuestra integración, **ninguno** —
y el único que alguien logró confirmar (`S06613`) es el único donde lo llenaron a mano.

**El hallazgo que resuelve todo:** confirmar el presupuesto es lo que hace que Odoo genere la MO
correctamente vinculada. Verificado — al confirmar `S06613`, Odoo (`OdooBot`) creó
`BPT/MO/09465` con `origin: "S06613"` y `move_dest_ids: [249672]`, y el presupuesto ganó un
`procurement.group` con `sale_id`. No es un caso raro: **2 831** grupos de abastecimiento en esa
BD tienen `sale_id`. Las rutas están puestas (9 982 plantillas con `Manufacture`, 11 235 con
MTO). La ausencia de listas de materiales es normal acá (20 BoMs para 11 529 productos; 8 619 de
8 942 MOs sin BoM) y **no** bloquea la generación.

**Resultado buscado:** el middleware entrega un presupuesto completo y confirmable; una persona
lo confirma; Odoo genera las MOs bien vinculadas, una por línea.

## Decisiones tomadas (no re-litigar)

- **A.** Setear `country_expense` desde el país del cliente (`res.partner.country_id` → registro
  de `operation.costs`). Regla de negocio confirmada: **el país del gasto es el país del contacto.**
- **B.** **Dejar de crear la `mrp.production`.** El presupuesto pasa a ser el único target del
  middleware.
- **C.** Si el país no resuelve, **crear el presupuesto igual, sin el campo** — no bloquear el
  job. Pero tiene que ser visible.
- **D.** Arreglar el bug de duplicación de líneas: `order_line` usa tuplas `[0, 0, line]`
  (comando *crear*) y se manda por `write` en cada re-sync, **agregando líneas duplicadas** en
  vez de reemplazarlas.
- **E.** Writeback a una propiedad nueva `id_presupuesto_odoo` con el **nombre** del presupuesto
  (`"S06613"`). `id_orden_odoo` queda reservado para un futuro backfill de la MO.

---

## Paso 0 — Sondas de solo lectura (compuerta: no escribir código antes)

Script temporal contra staging siguiendo el patrón de construcción de clientes de
`scripts/sync-products.js:17-28`. En orden de prioridad:

| # | Sonda | Por qué bloquea |
|---|---|---|
| **P1** | `sale.order.fields_get(['country_expense'])` → ver `compute`, `related`, `store`, `readonly`. Y si hay un `onchange` de `partner_id` que lo resetee. | **Si es computado sin inverse, la feature es un no-op por RPC y todo el diseño cambia.** Sondear esto primero. |
| **P2** | `operation.costs.read_group([], ['country_id'], ['country_id'])` | ¿Es 1:1 país→registro? 148 registros para ~10 países dice que no. |
| **P3** | Para los países con varios: `search_read` con `['id','name','product_id','dai','iva','insurance','financing']` | (a) ¿hay exactamente uno con `product_id = false` (un "genérico" preferible)? (b) ¿los parámetros numéricos son **iguales** entre los registros de un país? Si (b) es sí, la elección da igual. Si (b) es no y (a) es no → **parar y preguntar**, ninguna heurística es defendible. |
| **P4** | `res.partner`: contar sin `country_id`; y leer `['country_id','parent_id','commercial_partner_id']` de los partners de nuestros 9 presupuestos | Si `id_cliente_odoo` apunta a un contacto hijo sin país, la cadena tiene que ser `partner.country_id ?? parent_id.country_id`. Trampa probable. |
| **P5** | Países distintos en `operation.costs` vs países distintos entre partners con ventas | El conjunto de países sin registro = casos irresolubles conocidos. |
| **P6** | Un presupuesto confirmado **multi-línea** histórico: contar sus MOs (`origin` contiene su nombre) vs su cantidad de `order_line` | Valida la premisa de la decisión B **para multi-línea**. `S06613` era de una sola línea. Si algunas líneas no generan MO, es una brecha de negocio que conviene saber antes. |
| **P7** | `GET /crm/v3/properties/deals/id_presupuesto_odoo` | Si no existe, crearla a mano antes de desplegar (ver Riesgo 4). |

---

## Paso 1 — Cliente Odoo (`src/adapters/outbound/odoo/odooApiClient.js`)

Todo método va en **las dos ramas**: stub (~`:19-59`) y http (~`:120-241`).

**`readPartnerCountries(ids)`** — clonar la forma de `readProductUoms` (`:200-215`): dedupe +
`Number.isFinite`, `{}` sin RPC si queda vacío.
- http: `res.partner.read([ids], {fields:['id','country_id','parent_id']})` →
  `{ [id]: { countryId, countryName, parentId } }`, con `country_id: false` → `null`.
- stub: `return {}`.

**`listOperationCosts()`** — memoizada **por promesa con TTL**, usando el idioma exacto de
`ensureUid` (`:99-113`) para que los 3 workers concurrentes compartan un solo RPC en vuelo:

```js
let ocPromise = null, ocAt = 0
const OC_TTL_MS = 600000
```

- http: `operation.costs.search_read([[]], {fields:['id','name','country_id','product_id']})` →
  array de `{ id, name, countryId, countryName, productId }`.
- stub: `return []`.

*Prefetch de tabla completa, no un RPC por deal:* 148 filas × 4 campos ≈ 10 KB, casi estático;
la política de ambigüedad necesita ver todos los registros de un país; y deja la elección como
**función pura** testeable a fondo, que es el estilo de la casa. El TTL importa: sin él, ops
agrega "DDP Panamá" y el worker no lo ve hasta reiniciar.

**`searchSalesOrderByOrigin(origin)`** (`:131-134`) — pasar de `search` a **`search_read`** con
`fields: ['id','name','state','country_expense']`, devolviendo
`[{ id, name, state, countryExpenseId }]`.
- Así obtenemos el **nombre** del presupuesto para el writeback y el `country_expense` existente
  para la regla de no-pisar, **en el RPC que ya hacíamos**. Cero viajes extra.
- Cambia una forma de retorno pública. El gateway absorbe ambas
  (`typeof found[0] === 'object' ? found[0].id : found[0]`), igual que el patrón de
  retrocompatibilidad ya presente en `OdooTargetGateway.js:11-18`, y así las fixtures
  `soSearch: ['SO-EXISTING']` de los tests que sobreviven siguen válidas. **No** crear un hermano
  `searchSalesOrdersByOrigin` — eso es una trampa de mantenimiento.

**`createSalesOrder`** (`:123-126`) — leer de vuelta el nombre: tras el `create`,
`sale.order.read([[id]], {fields:['name','state']})` y devolver `{ id, ref: name, state }`. Hoy
hardcodea `ref: null` mientras el stub (`:23`) sí devuelve un `ref` — el contrato ya prometía
`ref`, http nunca lo cumplió. Un RPC extra solo en la creación.

**Conservar `createManufacturingOrder` / `updateManufacturingOrder`.**
`test/adapters/odoo/odooApiClient.test.js:76-148` los usa como vehículo de la **única** cobertura
de la autenticación, la memoización del uid y los errores RPC (el test "authenticates only once"
en `:132-148`). Borrarlos obliga a reescribir esa cobertura sin ganar nada, y el futuro backfill
de MO los quiere. Comentario de una línea: sin uso en el flujo de deals.

## Paso 2 — Resolvedor puro (archivo nuevo)

`src/adapters/outbound/odoo/operationCostsResolver.js`, al estilo de `productNameKey.js`:

```js
pickOperationCostForCountry(records, countryId)
  → { id, name, matches, ids, ambiguous } | null
```

Política (pendiente de P3): 0 → `null`; 1 → ese; >1 → preferir el único con `productId == null`,
si no el `id` más bajo, reportando `matches`/`ids`/`ambiguous: true`.

**Esto es a propósito más permisivo que la política de nombres de producto**
(`OdooTargetGateway.js:28-36` se niega a adivinar). Un producto equivocado fabrica la cosa física
equivocada: caro e invisible. Un `operation.costs` equivocado son parámetros de costo levemente
distintos en **un presupuesto borrador que una persona revisa y confirma**. Distinto radio de
daño, distinta política — pero solo se sostiene si P3 muestra que los parámetros son parecidos.

## Paso 3 — Mapper: renombrar, agregar el campo, borrar la mitad de la MO

`git mv dealToManufacturingOrderMapper.js → dealToSaleOrderMapper.js`, exportar
`mapDealToSaleOrder` (+ mantener `resolveProductId`).

- Param nuevo opcional `countryExpenseId`; agregar `country_expense: Number(countryExpenseId)` al
  literal `saleOrder` (`:36-41`) **solo si no es null**, espejando el `product_uom` condicional
  de `:32`.
- **Borrar** el bloque `manufacturingOrder` (`:43-54`), el param `now` y `odooNow`. Devolver
  `{ saleOrder }` — conservar el objeto envoltorio, porque `payload.saleOrder` es lo que leen
  `OdooTargetGateway.js:242,248,252`.
- Actualizar el import de `OdooTargetGateway.js:3` y quitar `now: new Date()` de `:106`.

**Borrar el constructor de la MO, no conservarlo.** Está activamente mal (solo `hsLineItems[0]`,
`company_id: 1` hardcodeado, `date_deadline` = ahora). Dejar un constructor de payload roto pero
verosímil en el árbol es exactamente cómo vuelve el bug. La feature futura correcta es **leer de
vuelta** la MO que Odoo genera al confirmar — que es para lo que se reserva `id_orden_odoo` — no
este constructor.

## Paso 4 — Gateway (`src/adapters/outbound/odoo/OdooTargetGateway.js`)

**`async resolveCountryExpense(odooCustomerId, correlationId)`** →
`{ countryExpenseId, status, countryId, countryName, reason, matches }`.

⚠️ **Los dos métodos nuevos del cliente TIENEN que ir con guardia
`typeof this.apiClient.X === 'function'`**, igual que `:174` y `:212`. Sin eso, **los 26 tests que
llaman `upsert()` rompen de golpe**, porque `makeApi` no los define. Es la restricción más
importante del cambio.

Los fallos degradan con `warn` y `status: 'unresolved'` — **no** `TransientSyncError` (decisión
C), consistente con el `catch` de `resolveProductUoms` (`:224-229`). Una caída real de Odoo se
sigue notando: `createSalesOrder` falla enseguida y *eso* sí lanza.

**Partir `resolveSalesOrderId` (`:239-255`) en tres:**

1. `async resolveExistingSalesOrder({ payload, correlationId })` →
   `{ id, name, state, countryExpenseId } | null`, absorbiendo las dos formas de retorno.
2. **pura y exportada** `buildSaleOrderUpdatePayload({ saleOrder, existing })` — testeable como
   `collectUnresolvedLines`.
3. `async upsertSalesOrder(...)` → `{ id, name, state, created }`.

### Decisión D: la actualización **omite `order_line`**

Comparado con `[[5]]` (borrar todo y recrear): eso haría que un re-sync espeje HubSpot
exactamente, pero destruye ediciones humanas (líneas de descuento, precios ajustados, secciones)
y en una orden con `qty_delivered`/`qty_invoiced` Odoo **lanza excepción** — convirtiendo un
re-sync en error no-transitorio → dead-letter. Ya existen órdenes confirmadas tipo `S06613`, así
que el riesgo es real.

El punto de la decisión B es que el presupuesto es un **borrador de propiedad humana** desde que
nace. Un middleware que reescribe en silencio las líneas de un documento que una persona está
editando es peor que uno que sub-sincroniza, porque sub-sincronizar es observable (se loguea) y
sobreescribir no.

Payload de actualización, angosto y explícito: `{ origin, partner_id }`, más

- `country_expense` **solo si `existing.countryExpenseId` es falsy** — nunca pisar lo que puso una
  persona; ese campo es justamente lo que hizo funcionar `S06613`;
- `note` **solo si la nota existente está vacía**;
- **nunca `order_line`.**

**Limitación conocida a documentar:** los cambios de line items en HubSpot posteriores al primer
sync **no se propagan**. El arreglo correcto, si el negocio lo pide, es un diff con clave usando
comandos `[1, id, vals]` / `[2, id]` contra un mapa línea-Odoo ↔ line-item-HubSpot. Fuera de
alcance.

### Nuevo contrato de retorno de `upsert`

```js
{
  targetId:   String(soId),      // el sale.order ES el target ahora
  targetRef:  soName || null,    // 'S06613' — alimenta el writeback
  syncToken:  soState || null,
  raw:        saleOrderPayloadSent,
  payloadHash: this.hashPayload({ saleOrder }),
  salesOrderId: String(soId),    // duplicado a proposito, ver abajo
  metadata: { countryExpense: { status, id, countryId, reason, matches } }
}
```

`salesOrderId` duplicado con `targetId` es retrocompatibilidad intencional:
`ProcessSyncJobUseCase.js:83` y el test de `test/application/use-cases.test.js:185-197` siguen
funcionando y `mapping.metadata.salesOrderId` sigue poblado. Comentarlo.

### `existingTargetId` — la trampa más severa

**Ignorarlo por completo.** Las filas viejas de `mappings` tienen **ids de `mrp.production`** en
`targetId`. Si el código nuevo se lo pasara a `updateSalesOrder`, escribiría sobre el `sale.order`
que casualmente comparta ese entero — corrupción silenciosa entre registros. Mantener el
parámetro en la firma (el puerto y `ProcessSyncJobUseCase.js:70` lo siguen pasando), ignorarlo, y
**escribir un test explícito** de que un `existingTargetId: 'MO-EXISTING'` viejo nunca llega a
`updateSalesOrder`.

No hace falta migración: `mapping.metadata.salesOrderId` ya tiene el id correcto en las 9 filas
existentes, y el primer re-sync sobreescribe `targetId`. Pero la colección y el panel van a
mostrar una mezcla de ids de MO y de presupuesto hasta que cada deal re-sincronice.

## Paso 5 — Caso de uso (`ProcessSyncJobUseCase.js`)

Dos cambios chicos y genéricos; nada con forma de Odoo acá:

- `:82-83` → fusionar `upsertResult.metadata` en `mappingMetadata`.
- `:75-79` → incluir `metadata: upsertResult.metadata || null` en el detalle del audit
  `target.upserted`.

Documentar ambos en `src/core/application/ports/TargetGatewayPort.js`.

## Paso 6 — Propiedad de HubSpot + writeback

- `src/config/index.js`: `'HS_PROPERTY_ODOO_QUOTE_ID'` a `OPTIONAL_KEYS`;
  `propertyOdooQuoteId: env.HS_PROPERTY_ODOO_QUOTE_ID || 'id_presupuesto_odoo'`.
- **Extraer** el array de `src/server.js:22-39` a `src/composition/dealPropertyDefinitions.js`
  (`buildDealPropertyDefinitions(cfgHubspot)`). Sin eso la definición nueva es intesteable:
  `test/composition/provisionDealProperties.test.js` solo verifica el array que él mismo pasa.
- Tercera entrada:

```js
{
  name: cfg.hubspot.propertyOdooQuoteId,
  label: 'ID Presupuesto Odoo',
  type: 'string',
  fieldType: 'text',
  groupName: 'dealinformation',
  description: 'Nombre del presupuesto (sale.order.name, ej. S06613) creado en Odoo al cerrar el negocio. La orden de fabricación la genera Odoo al confirmar el presupuesto.'
}
```

  Y corregir la descripción de `id_orden_odoo` (`:29`) para decir que está reservado y que el
  middleware ya no lo escribe.
- `HubspotSourceGateway.js`: arg de ctor `propertyOdooQuoteId`; rama de mapeo junto a `:56`;
  agregar el nombre a `DEAL_PROPERTIES_TO_FETCH` (`:5-13`) para que el echo guard y el panel lo
  vean.
- `dealSyncModule.js`: pasarlo en `:58-59`; `buildWriteBackPayload` (`:24-28`) pasa a
  `{ id_presupuesto_odoo: mapping && mapping.targetRef ? mapping.targetRef : null }`. Quitar la
  clave `id_orden_odoo` alcanza para no tocar el valor que ya tenga en HubSpot, porque `writeBack`
  solo escribe claves no-null (`HubspotSourceGateway.js:56-58`).
- Si `targetRef` viene null (falló la lectura del nombre), el writeback no hace nada. Agregar un
  `warn`.

## Paso 7 — Observabilidad de la decisión C

Cuatro capas, todas con patrones ya existentes:

1. `logger.warn('odoo.upsert.countryExpense.unresolved', { sourceId, partnerId, countryId, countryName, reason, correlationId })`
   — espeja `odoo.upsert.productUnresolved` (`:198`).
2. `logger.info('odoo.upsert.countryExpense.resolved', { countryExpenseId, name, matches })`,
   incluido cuando `matches > 1` (una elección logueada).
3. `metadata.countryExpense` → persistido en `mapping.metadata` y reflejado en el audit vía Paso
   5. Deja rastro consultable: `db.mappings.find({'metadata.countryExpense.status':'unresolved'})`.
4. **Extra recomendado:** en la ruta de creación, cuando no resuelve, anexar un marcador a la
   `note` del presupuesto: `\n[smartflow] País no resuelto: revisar country_expense antes de
   confirmar.` Es el único canal que una persona trabajando en Odoo va a ver de verdad. No puede
   pisar nada porque la ruta de actualización ya omite `note` si tiene contenido.

**No** usar `SkipSyncError` acá — la decisión C prohíbe bloquear.

---

## Tests (RED primero) y radio de impacto

**`test/adapters/odoo/OdooTargetGateway.test.js`** — 35 `it(` hoy, 29 del gateway, 26 llaman
`upsert()`.

- **9 rompen duro** (verifican llamadas a la MO o `targetId === 'MO-NEW'`): `:65-86`, `:88-103`,
  `:105-120`, `:135-146`, `:161-175`, `:229-243`, `:398-407`, `:443-455`, `:457-467`. Reescribir
  con aserciones del presupuesto; `:105-120` pasa a ser el test de "`existingTargetId` viejo se
  ignora".
- **3 quedan vacíos pero pasan** (`.not.toHaveBeenCalled()` sobre métodos de MO): `:148-159`,
  `:310-323`, `:325-345`. Limpiarlos.
- **17 pasan sin tocar**, siempre que `salesOrderId` siga en el resultado y se absorba la forma de
  id pelado en `soSearch`.
- **`makeApi`** (`:7-20`): quitar `moCreate` y **quitar del fake
  `createManufacturingOrder`/`updateManufacturingOrder`** — dejarlos permite que una regresión que
  re-agregue la creación de MO pase en silencio. En su lugar, un test explícito que les enchufa un
  espía y verifica que nunca se llaman. Agregar `soName` (default `'S00001'`), `partnerCountry`,
  `operationCosts`, adjuntados **solo cuando el test los pide**, preservando la convención
  documentada en `:16-17`.
- **~14 nuevos**: país resuelto / sin `country_id` / sin registro / elección ambigua / lectura de
  partner falla → degrada / lectura de costos falla → degrada / retrocompat sin cada método nuevo
  / `country_expense` en el payload de creación / ausente si no resuelve / la actualización omite
  `order_line` / omite `country_expense` si ya está / lo manda si está vacío / omite `note` si hay
  contenido / ambas formas de `searchSalesOrderByOrigin` / `targetRef` es el nombre en creación y
  en actualización.

**`dealToSaleOrderMapper.test.js`** (13 hoy): borrar `:43-54`, `:86-93`, `:95-102`; recortar
aserciones de MO en `:7-27`, `:56-64`, `:66-74`, `:76-84`. El único `toEqual` de objeto completo
(`:39-40`) es sobre tuplas de `order_line`, no se afecta. Agregar 3 de `country_expense`. Neto ~10.

**`odooApiClient.test.js`**: modificar `:162-176` (`createSalesOrder` ahora hace 3 posts,
`r.ref === 'S06613'`) y `:193-208` (`search_read` + mapeo). Agregar ~14: `readPartnerCountries`
http/stub/vacío/`country_id: false`; `listOperationCosts` http/stub/vacío; **"lee
`operation.costs` una sola vez con dos llamadas concurrentes"** (la memo, espejando `:132-148`);
expiración del TTL provoca refetch.

**Nuevo `operationCostsResolver.test.js`**: ~7 puros.
**`use-cases.test.js`**: +2. **`dealSyncModule.test.js`**: +2 sobre `buildWriteBackPayload`.
**`HubspotSourceGateway.test.js`**: +2. **Nuevo `dealPropertyDefinitions.test.js`**: 3.
**`config.test.js`**: +2. **`e2e/full-flow.test.js`**: reforzar `:101-104` para verificar
`id_presupuesto_odoo`.

Esperado: **466 → ~500**.

---

## Verificación end-to-end contra staging

1. Arrancar con `ODOO_CLIENT_MODE=http` y confirmar `hubspot.provision.*.id_presupuesto_odoo` en
   el log **antes** de disparar nada.
2. Deal nuevo en Cierre Ganado, **multi-línea**, cliente con país conocido. Orden esperado:
   `odoo.upsert.countryExpense.resolved` → `odoo.upsert.salesOrder.create` → writeback con
   `id_presupuesto_odoo`. Verificar que **no** aparece `odoo.upsert.create`.
3. En Odoo: `country_expense` = "DDP \<país\>", `destination_taxes` > 0, **una `order_line` por
   line item**, `state: draft`, y `mrp.production.search_count([['origin','=','hs:<dealId>']]) === 0`.
4. Re-disparar el mismo webhook: mismo id de presupuesto, **cantidad de `order_line` sin cambios**
   (prueba de la decisión D), `country_expense` intacto.
5. Cambiar `country_expense` a mano en Odoo y re-disparar: verificar que no se sobreescribió.
6. **Confirmar el presupuesto en Odoo.** Verificar que Odoo crea MO(s) con `origin` = el nombre del
   presupuesto y que el presupuesto gana un `procurement.group` con `sale_id`. **Contar MOs vs
   line items** — acá se valida P6 de verdad.
7. Camino negativo: deal cuyo partner no tiene `country_id`. Presupuesto creado igual; `warn`
   emitido; `mapping.metadata.countryExpense.status === 'unresolved'`; job `COMPLETED`.
8. Contar `mrp.production` total antes y después de todo el ejercicio, para probar cero MOs
   sueltas del middleware.

Además: las **9 MOs sueltas** que ya creamos (draft, sin BoM, sin vínculo) conviene cancelarlas a
mano en Odoo para no dejar ruido.

## Riesgos

1. **`country_expense` podría ser computado** (P1). Si lo es, la feature es un no-op silencioso y
   el diseño cambia entero. Sondear antes de escribir una línea.
2. **`existingTargetId` viejo tiene ids de MO** → pasarlo a `updateSalesOrder` escribe sobre un
   `sale.order` ajeno. Ignorarlo, con test.
3. **Las guardias `typeof` en el gateway** o los 26 tests de `upsert` rompen de golpe.
4. **El provisioning es warn-only** (`server.js:52-54`). Si `id_presupuesto_odoo` no existe,
   `updateDeal` da 400 → el job reintenta → dead-letter **después de que Odoo ya tiene el
   presupuesto correcto**. Pre-crear la propiedad a mano (P7). Hacer que el fallo de writeback no
   sea fatal es una decisión aparte: señalarla, no colarla.
5. **La política de ambigüedad es a propósito más laxa** que la de productos. Si P3 muestra que
   los parámetros divergen materialmente entre registros de un país, escalar en vez de adivinar.
6. **Partners que son contactos hijos** pueden tener el país en `parent_id` (P4). Sin la caminata,
   contactos nicaragüenses de una matriz guatemalteca quedan sin país.
7. **Omitir `order_line` en la actualización** significa que los cambios de líneas en HubSpot no
   se propagan. Deliberado, pero hay que documentarlo como limitación, no dejarlo implícito.
8. **`mapping.targetId` cambia de semántica en caliente** → el panel muestra mezcla de ids de MO y
   presupuesto hasta que cada deal re-sincronice.
9. **No borrar los métodos de MO del cliente** — cargan la cobertura de auth/uid/errores RPC.

## Archivos críticos

- `src/adapters/outbound/odoo/odooApiClient.js` — 2 métodos nuevos, `searchSalesOrderByOrigin` a
  `search_read`, `createSalesOrder` lee el nombre
- `src/adapters/outbound/odoo/OdooTargetGateway.js` — resolución de país, split de create/update,
  nuevo contrato de retorno
- `src/adapters/outbound/odoo/dealToSaleOrderMapper.js` — **renombrado**, sin la mitad de MO, con
  `country_expense`
- `src/adapters/outbound/odoo/operationCostsResolver.js` — **nuevo**, elección pura
- `src/composition/dealPropertyDefinitions.js` — **nuevo**, extraído de `server.js`
- `src/composition/dealSyncModule.js`, `src/config/index.js`, `src/server.js`,
  `ProcessSyncJobUseCase.js`, `HubspotSourceGateway.js`
- `test/adapters/odoo/OdooTargetGateway.test.js` — el bulto del diff de tests

## Docs a actualizar en el mismo commit

`.claude/tdd/2026-07-31-quote-country-expense.tdd.md` (formato de la casa, ver
`.claude/tdd/fix-line-items-batch.tdd.md`), `README.md` (tablas de variables y la descripción del
flujo), `.env.example` (junto a `HS_PROPERTY_ODOO_ORDER_ID`), `docker-compose.yml`.
