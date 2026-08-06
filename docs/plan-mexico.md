# Plan — Caso México: facturación vía entidad intermediaria + visibilidad en HubSpot

> **⚠️ INVALIDADO (2026-08-05).** En la reunión de esa fecha, Andrea Fuentes aclaró que la
> filial de México (**Displays**) no tiene entidad ni ERP: solo hace CRM/cotización en HubSpot
> y el flujo debe cortarse en "presupuesto aprobado" **sin llegar a Odoo**. Esto invalida la
> premisa completa de este documento (facturar a una "visual México" intermediaria) — y explica
> por qué la probe X2 de abajo falló: ese `res.partner` no existe porque no debe existir. Ver
> [plan-cambios-2026-08-05.md § Fase 5](plan-cambios-2026-08-05.md#fase-5--excluir-a-displays-méxico--resuelto-sin-escribir-código)
> para el reemplazo: excluir a Displays por **pipeline** de HubSpot, no por país, y sin cambios
> de código. Se conserva este documento como referencia histórica; no ejecutar sus pasos.

## Context (histórico — ver nota de archivado arriba)

El fan-out por cotización ya funciona en staging: un deal con N cotizaciones publicadas, cada una
con su ISO-2 en `pais_de_destino`, produce N `sale.order` en Odoo con su `country_expense` correcto
(verificado: S06618 Honduras + S06619 Costa Rica desde un solo deal, cada uno escribiendo su
`id_presupuesto_odoo` de vuelta). Queda un solo pendiente del plan anterior:

> **México** (`visual → visual México` en vez de al cliente final, y moneda distinta) sigue
> pendiente. Es un cambio de **partner**, no de país. Deal aparte por la moneda (decisión E).
> — `docs/plan-cotizaciones-por-pais.md:279-281`

Para México la venta no se factura al cliente final sino a una entidad intermediaria (**visual
México**), y la moneda difiere. Hoy el middleware **no tiene ninguna superficie** para eso: el
partner sale de una sola propiedad del deal, y el sistema es **completamente ciego a la moneda** —
el `sale.order` solo lleva `origin`, `partner_id`, `order_line`, `note` y `country_expense`
([dealToSaleOrderMapper.js:59-64](../src/adapters/outbound/odoo/dealToSaleOrderMapper.js#L59-L64)),
nunca `currency_id` ni `pricelist_id`. Los precios van como números pelados y **Odoo decide la
moneda desde el pricelist del partner**: si HubSpot dice USD 5,000 y el pricelist de visual México
está en MXN, Odoo registra 5,000 **pesos** (≈$290). Error de ~17x, sin una sola advertencia, que
alguien aprueba y se convierte en factura.

Resultado buscado: un deal de México produce un presupuesto facturado a visual México, con la moneda
correcta o con un rechazo **visible para Andrea y ventas en HubSpot** — no enterrado en el panel
técnico. Y como efecto colateral, esa misma visibilidad cubre **todos** los motivos de skip que hoy
son invisibles.

## Decisiones (ya tomadas — no re-litigar)

| # | Decisión |
|---|---|
| **F** | México va en **deal aparte**. Multi-moneda dentro de un mismo deal sigue sin soportarse (decisión E vigente). |
| **G** | Trigger **automático por país**: si la cotización tiene `pais_de_destino = MX`, el middleware sustituye el partner por visual México. |
| **H** | Los motivos de rechazo se escriben en **propiedades nuevas del objeto cotización** en HubSpot, en español, donde ventas ya mira. El panel `/api/panel` no es visible para los usuarios finales. |
| **I** | Ni la naturaleza de visual México (`res.partner` vs `res.company`) ni la moneda están confirmadas. **Se resuelven con sonda de solo lectura antes de escribir código** (metodología de la casa: compuerta de sondas). |

---

## Lo que encontré revisando el código

Cuatro hallazgos que cambian el plan. Los tres primeros son bugs latentes; el cuarto es la idea
central del diseño.

**1. La validación mata el caso México antes de que llegue al código que lo resuelve.**
`createMustHaveOdooCustomerId` ([validators.js:17-30](../src/composition/validators.js#L17-L30)) corre
en `ProcessSyncJobUseCase` **antes** de `targetGateway.upsert`. Para una cotización de México,
`record.properties.id_cliente_odoo` está vacío — *eso es la definición del caso México*: el cliente
final mexicano puede no existir en Odoo, y por eso se factura vía intermediaria. El validador lanza
un error **transitorio** → 8 reintentos con backoff → `job.dead_letter`. **La cotización nunca llega
a `upsert`, así que la configuración del partner de México nunca se lee.** La feature saldría
completamente muerta justo en el caso para el que se construyó, y el síntoma (dead-letter por
"falta cliente Odoo") señala la causa equivocada.
Peor: queda **enmascarado si `ODOO_DEFAULT_CUSTOMER_ID` está seteado** — entonces el validador pasa
y todo funciona. Pasa en un entorno y falla en el otro.

**2. `HS_PROPERTY_QUOTE_COUNTRY` se ignora en silencio en el fan-out.**
`QUOTE_PROPERTIES` ([hubspotApiClient.js:8-15](../src/adapters/outbound/hubspot/hubspotApiClient.js#L8-L15))
tiene `pais_de_destino` hardcodeado, y `listEligibleQuotes` llama `getDealQuotes(dealId)` **sin
argumento de propiedades**. Si alguien setea esa env var a un nombre custom, `props[countryProp]`
es `undefined` para toda cotización → todas `missing_country` → **todo deal cae al camino legacy**.
Misma familia que el literal `id_cliente_odoo` hardcodeado en
[OdooTargetGateway.js:201](../src/adapters/outbound/odoo/OdooTargetGateway.js#L201) y
[validators.js:21](../src/composition/validators.js#L21), un nivel peor.

**3. Un deal sin ninguna cotización elegible no registra los motivos en ningún lado.**
`PlanDealSyncUseCase` retorna `{mode:'fallback'}` en
[:89-91](../src/core/application/use-cases/PlanDealSyncUseCase.js#L89-L91) **antes** del audit
`deal.expanded`. Ni en el audit trail queda por qué se descartó cada cotización. Es el peor caso
para visibilidad. (Aparte: `listEligibleQuotes` hace `q.id` sin guardia — un `null` en el batch read
tira `TypeError` y **mata el fan-out completo** del deal.)

**4. La idea central: `odooCustomerId` son dos variables con un solo nombre.**
En [OdooTargetGateway.js:199-213](../src/adapters/outbound/odoo/OdooTargetGateway.js#L199-L213) esa
única variable cumple dos roles sin relación:

- **Partner de facturación** → `mapDealToSaleOrder` → `saleOrder.partner_id`
- **Oráculo de país** → `resolveCountryExpenseFromQuote(quote, odooCustomerId)` → el walk de
  `parent_id` cuando el ISO no resuelve

Para México deben divergir. **No hay que sobreescribir `odooCustomerId`: hay que partirlo en
`billingPartnerId` y `countryOraclePartnerId`, y dejar el oráculo siempre en el cliente final.**

Por qué importa: si se sobreescribe la variable única y el lookup del ISO falla (hay tres caminos
reales que lo producen), el walk consulta a **visual México**. Si visual México está registrada con
dirección de Costa Rica por razones fiscales, o su `parent_id` sube a la holding costarricense, el
walk devuelve **Costa Rica** — y `pickCountryExpenseRecord` **resuelve con éxito** (CR tiene
`operation.costs`), así que `status:'resolved'`, **sin `SMARTFLOW_MARKER` en la nota**, y una orden
de México sale con gastos de destino de Costa Rica y **cero señal en ninguna parte**. Es una versión
estrictamente peor del bug que estamos arreglando.

---

## Fase 0 — Sonda (compuerta: no escribir código antes)

Nueva `scripts/probes/mexico-readiness.js`, al estilo de
[hubspot-quote-readiness.js](../scripts/probes/hubspot-quote-readiness.js) — mismo `{id, status,
summary, data}`, pares `[id, thunk]` secuenciales, crashes convertidos en `status:'fail'`, reporte
JSON a `docs/testing/`, `exit 1` si algo falla. Importar `buildOdooRpc` / `buildHubspotHttpClient`
de ese archivo (ya los exporta) en vez de re-implementar una tercera copia del JSON-RPC.

| # | Sonda | Por qué bloquea |
|---|---|---|
| **X1** | HubSpot `GET /account-info/v3/details` (`companyCurrency`) + las opciones de la propiedad `hs_currency` + los valores reales por cotización | **La de mayor palanca.** Si el portal es **mono-moneda**, `hs_currency` es un artefacto y **no lleva intención de facturación por cotización** — entonces el diseño "comparar HubSpot vs Odoo" es el equivocado y hay que reemplazarlo por config `país ⇒ moneda esperada`. Correr esta primero. |
| **X2** | `res.partner.search_read(name ilike 'visual%m%xico')` → `id, name, is_company, parent_id, country_id, company_id, property_product_pricelist, customer_rank` | El **`res.partner.id` exacto**. Si se mete un id de `res.company` en `partner_id`, o da 400 o apunta silenciosamente al `res.partner` que casualmente comparta ese entero — exactamente la corrupción que advierte el comentario de [OdooTargetGateway.js:194-197](../src/adapters/outbound/odoo/OdooTargetGateway.js#L194-L197). |
| **X3** | `res.company.search_read` + `res.users.read([uid], ['company_id','company_ids'])` | ¿visual México es compañía aparte? Si sí, el lever es `company_id`, cambian secuencias/ACLs y **el alcance crece mucho** — hay que replanear, no seguir. |
| **X4** | `res.country` con `code='MX'` + `operation.costs` de ese país + el `parent_id` chain de visual México y su `country_id` | Confirma que MX resuelve por ISO, y **cuantifica exactamente cuán mal habría salido** el override naive del hallazgo 4. |
| **X5** | `product.pricelist.search_read([], ['id','name','currency_id','company_id','active'])` con `context:{active_test:false}` | ¿Existe un pricelist en la moneda que queremos? ¿Están scopeados por compañía? (Un pricelist cross-company hace fallar `check_company`.) |
| **X6** | `res.currency` de `['USD','CRC','GTQ','HNL','NIO','MXN','PAB']` con `context:{active_test:false}`, leyendo `active` y `rounding` | **Trampa real:** la mayoría de filas de `res.currency` vienen archivadas; un `search` sin `active_test:false` devuelve `[]` y se diagnostica "no existe" en vez de "está archivada". Y un `rounding: 1.0` redondea cada línea en silencio. |
| **X7** | `sale.order.search_read([['origin','like','hs:']], [...,'pricelist_id','currency_id','amount_total'])` cruzado con el `hs_currency` de cada cotización | **¿El bug latente ya se disparó?** Sobre las órdenes vivas. Si alguna quedó mal denominada esto es un incidente, no una hipótesis, y cambian las prioridades. Barata y de alto valor. |
| **X8** | `sale.order.fields_get(['pricelist_id','currency_id','company_id'])` + `sale.order.line.fields_get(['price_unit'])` + `common/version` | La forma real de los campos en **esta** instancia, en vez de asumir la de Odoo 16/17 de memoria. Decide si `pricelist_id` es `required`. |
| **X9** | **Experimento de escritura** (detalle abajo) | El voto decisivo de la Fase 3, igual que Q3 lo fue para el writeback. |
| **X10** | HubSpot: `PATCH` de una propiedad **`enumeration`** custom sobre una cotización **publicada**, con valor válido e inválido; y `GET /crm/v3/properties/quotes/estado_sync_odoo` → esperar 404 | Q3 validó el PATCH de un `string`. Un `enumeration` puede comportarse distinto y un valor de opción inválido es 400. El 404 confirma que la propiedad no preexiste con opciones equivocadas (ver Riesgos). |

**X9 en detalle** — una escritura angosta sobre objetos desechables, leer de vuelta, limpiar:

1. **A (control, lo que hace producción hoy):** `create` con `origin:'probe:mx:<ts>:A'`,
   `partner_id` = cliente final, una línea con `price_unit: 1234.56`, **sin** `pricelist_id`. Leer
   `pricelist_id`/`currency_id`. Prueba qué da la resolución implícita, y si contradice a X5 nuestro
   modelo de lectura está mal.
2. **B (el lever):** igual + `pricelist_id: L` (uno cuya moneda difiera). Verificar
   `currency_id == pricelist(L).currency_id` **y** `price_unit === 1234.56` exacto **y**
   `discount === 0`.
3. **C (camino de update):** `write({pricelist_id: <otro>})` sobre B; re-leer `price_unit` y
   **reportar `show_update_pricelist`**. Un `True` ahí es la base empírica de "nunca mandar
   pricelist en update".
4. **D (detector de alcance):** repetir A con el cliente final vs. con visual México y **diffear
   `order_line.tax_id` / `amount_tax` / `fiscal_position_id`**. Sustituir el partner **cambia los
   impuestos de cada línea** (la posición fiscal se computa del partner y nuestras líneas no llevan
   `tax_id`). Está fuera del alcance de este plan, pero tiene que **salir a la luz acá**, no en
   producción.
5. **Limpieza:** `unlink` de los ids creados (draft se puede borrar), confirmar con `search_read`.
   Guardar toda escritura tras `origin.startsWith('probe:')` y tocar solo ids devueltos por esta
   corrida. Nunca confirmar, nunca facturar. **Quema 3-4 números de la secuencia S06xxx** (un
   hueco) — aceptable, pero se avisa antes.

**Compuerta:** X1, X2, X3, X7, X9 tienen que pasar. Un `warn` en X5/X6 se tolera pero un humano lo
lee antes de la Fase 1. **X3 en "es compañía aparte" ⇒ parar y replanear**, no seguir.

---

## Fase 1 — Ruteo de partner por país *(entrega independiente)*

### 1.1 Función pura

Nuevo `src/adapters/outbound/odoo/partnerRouting.js`, hermano de `operationCostsResolver.js` —
mismo idioma "pura + exportada + testeada sin mocks".

```js
resolvePartnerRouting({
  quoteCountry,              // record.quote.properties[countryProp], ISO-2 o null
  customerIdFromReferences,  // references.odooCustomerId
  customerIdFromProperties,  // record.properties[cfg.hubspot.propertyOdooCustomerId]
  defaultCustomerId,         // cfg.odoo.defaultCustomerId
  countryPartnerOverrides,   // { MX: '1234' }
  countriesRequiringOverride // ['MX'] desde constants.js
}) => ({
  billingPartnerId,       // → mapper partner_id
  countryOraclePartnerId, // → resolveCountryExpense*  (=== endCustomerId, SIEMPRE)
  endCustomerId,          // la resolución sin override, para el audit
  overrideApplied, overrideCountry, overrideMissing,
  source // 'override' | 'references' | 'properties' | 'default' | 'none'
})
```

Precedencia:
1. `endCustomerId` = primer no-vacío de `references` → `properties` → `defaultCustomerId` → `null`.
   **Idéntico al `||` de hoy**, así el camino sin override queda bit-por-bit igual.
2. `countryOraclePartnerId = endCustomerId`. **Incondicional. Ningún override lo toca nunca.**
3. Normalizar el ISO (`trim` + `uppercase`).
4. Si `countryPartnerOverrides[iso]` no vacío → `billingPartnerId` = ese, `overrideApplied`.
5. Si no, y `countriesRequiringOverride.includes(iso)` → `billingPartnerId = null`,
   `overrideMissing = true`.
6. Si no → `billingPartnerId = endCustomerId`.

`references.odooCustomerId` (hoy código muerto) **se conserva como slot #1**: `resolveReferences` ya
trae las asociaciones `['contact','company']` y las descarta para partner; "resolver el partner de
Odoo desde la asociación de compañía en vez de una propiedad tipeada a mano" es la feature obvia
siguiente y aterriza ahí. Cuesta una línea; borrarlo y re-agregarlo cuesta más.

### 1.2 Config

`src/config/index.js`, a `OPTIONAL_KEYS`:

```
ODOO_COUNTRY_PARTNER_OVERRIDES=MX:1234   → cfg.odoo.countryPartnerOverrides = { MX: '1234' }
```

**Mapa, no `ODOO_MX_CUSTOMER_ID`.** La premisa entera del fan-out es que partner y país se
desacoplaron; una segunda entidad intermediaria es cuestión de cuándo, no de si. El parseo CSV ya es
idiomático acá (`HS_QUOTE_ELIGIBLE_STATUSES`, `HS_ALLOWED_STAGE_IDS`).

`src/config/constants.js`, el invariante de negocio **en código, no en env**:

```js
const COUNTRIES_REQUIRING_PARTNER_OVERRIDE = Object.freeze(['MX'])
```

Deliberado: si se derivara del mapa de env, **desetear la variable re-habilitaría en silencio la
facturación directa a clientes mexicanos** — el bug exacto. La constante es lo que hace que "sin
configurar" sea ruidoso.

### 1.3 Wiring en `OdooTargetGateway`

Constructor gana **tres opciones con default** — el default es la decisión de compatibilidad más
importante de la fase, porque ~26 tests hacen `new OdooTargetGateway({...})`:
`propertyOdooCustomerId = 'id_cliente_odoo'`, `countryPartnerOverrides = {}` (⇒ cero cambio de
comportamiento), `countriesRequiringOverride = COUNTRIES_REQUIRING_PARTNER_OVERRIDE`.

`upsert` reemplaza `:199-213`: llama `resolvePartnerRouting`, y

```js
if (routing.overrideMissing) throw new SkipSyncError(
  `Las ventas a ${routing.overrideCountry} deben facturarse a una empresa intermediaria que no está configurada`,
  { detail: { code: 'MISSING_COUNTRY_PARTNER_OVERRIDE', country: routing.overrideCountry } }
)
const countryExpense = record.quote
  ? await this.resolveCountryExpenseFromQuote(record.quote, routing.countryOraclePartnerId, correlationId)
  : await this.resolveCountryExpense(routing.countryOraclePartnerId, correlationId)
payload = mapDealToSaleOrder({ ..., odooCustomerId: routing.billingPartnerId, ... })
```

`routing` va al `metadata` retornado, **como hermano de `countryExpense`** (hay un `toEqual` sobre
ese objeto exacto en los tests). Es la única forma de responder después "¿a qué entidad se facturó?".

**Rechazar, no degradar.** Todo rechazo en este código sigue una regla: *degradar solo cuando la
degradación es visible en el artefacto*. `country_expense` degrada porque el `SMARTFLOW_MARKER`
aterriza en la nota que lee quien confirma. `partner_id` no tiene ese marcador — **y es el campo que
se está confirmando**. Facturar en silencio al cliente final produce un presupuesto confirmable, con
apariencia correcta, con la entidad legal y los impuestos equivocados. `SkipSyncError` y no
transitorio: ningún reintento arregla una env var sin setear, y gracias al fan-out las cotizaciones
de CR/HN/GT del mismo deal siguen generando su presupuesto.

### 1.4 Arreglar la trampa del validador (hallazgo 1) y los literales hardcodeados (hallazgo 2)

`createMustHaveOdooCustomerId` llama **a la misma función pura** y deja pasar `overrideMissing`
(`return`), porque `upsert` es el único que produce ese rechazo — un mensaje, un lugar. Con eso el
validador y el gateway **no pueden discrepar** sobre quién es el partner.

Tres sitios de literal hardcodeado, y **no es scope creep**: `resolvePartnerRouting` es pura y recibe
`customerIdFromProperties` como parámetro, así que *no puede* leer `record.properties.id_cliente_odoo`.
Eso fuerza al llamador a conocer el nombre de la propiedad — que `OdooTargetGateway` ya sostiene para
`propertyQuoteCountry`. Declinarlo significaría hardcodear un literal **dentro de una función pura
nueva**, peor que el status quo.

1. `OdooTargetGateway` → nueva opción, cableada de `config.hubspot.propertyOdooCustomerId`.
2. `createMustHaveOdooCustomerId` → nueva opción `customerProperty`.
3. `listEligibleQuotes` pasa `buildQuotePropertiesToFetch({...})` a `getDealQuotes` (dos líneas), y
   se agrega `q && q.id` en `:75`. La Fase 2 necesita esa llamada igual para traer las propiedades
   nuevas.

---

## Fase 2 — Visibilidad en HubSpot *(lo que hace útil a la Fase 1)*

### 2.1 Dos propiedades, no una

A `src/composition/quotePropertyDefinitions.js` (ya corre en boot para `quotes` vía
[server.js](../src/server.js) — **cero wiring nuevo**):

| nombre interno | tipo | label |
|---|---|---|
| `estado_sync_odoo` | `enumeration`/`select` — opciones `ok` / `requiere_accion` / `error` | Estado sincronización Odoo |
| `detalle_sync_odoo` | `string`/`textarea` | Detalle sincronización Odoo |

**Valores de opción no vacíos**, por el bug ya conocido de HubSpot ("cannot have options with blank
values").

El argumento decisivo para dos: lo que Andrea realmente va a pedir es una **vista/lista de HubSpot**
de "cotizaciones que no generaron presupuesto". Sobre texto libre eso es un filtro `contains` sobre
prosa en español que se rompe en cuanto reformulemos un string; sobre un enum es
`estado_sync_odoo = requiere_accion`, y se ve como chip de color al lado del selector de país. El
texto libre sigue existiendo porque el contenido **accionable** ("estos productos no existen en
Odoo: X, Y") no puede ser un enum. `textarea` y no `text` porque los mensajes son largos.

Config: `HS_PROPERTY_QUOTE_SYNC_STATUS`, `HS_PROPERTY_QUOTE_SYNC_DETAIL`,
`HS_QUOTE_STATUS_WRITEBACK_ENABLED` (default `true`). El kill switch se gana su lugar: esto escribe
en **registros visibles al cliente** en cada fallo; si un string en español sale mal, ops tiene que
poder frenarlo sin deploy.

### 2.2 Mensajes: función pura

Nuevo `src/core/domain/quoteSyncStatus.js` (precedente de builder puro en español:
`describeUnresolved` en `OdooTargetGateway.js:60-70`):

```js
describeQuoteSyncStatus({ reason, detail, message, targetRef }) → { status, detail } | null
// null ⇒ este motivo NO se publica en la cotización (lista silenciosa)
shouldSurfaceReason(reason) → boolean
```

`reason` es un token normalizado: en plan-time el `reason` de `isEligibleQuote`; en procesamiento
`err.detail.code`; más `'ok'` y `'dead_letter'`. **Prerequisito:** darle `detail.code` a los
`SkipSyncError` existentes (`NO_LINE_ITEMS`, `MISSING_QUOTE_COUNTRY`, `ODOO_PRODUCT_NOT_FOUND`…) para
que nada tenga que olfatear mensajes.

Sufijo compartido, para que la instrucción de reintento viva en un solo lugar:
`' Después de corregirlo, saque el negocio de Cierre Ganado y vuelva a ponerlo para reintentar.'`

| motivo | estado | detalle (resumido) |
|---|---|---|
| `ok` | `ok` | `Sincronizado. Presupuesto ${targetRef} creado en Odoo.` |
| `missing_country` / `MISSING_QUOTE_COUNTRY` | `requiere_accion` | Falta el país de destino… elija el país en el campo "País de destino". |
| `ODOO_PRODUCT_NOT_FOUND` | `requiere_accion` | Estos productos no existen en Odoo: ${lista}. Pida a inventario que los cree, o corrija el SKU. |
| `ODOO_PRODUCT_NAME_AMBIGUOUS` | `requiere_accion` | Hay productos con nombre repetido en Odoo: ${lista}. Complete el SKU (hs_sku). |
| `NO_LINE_ITEMS` | `requiere_accion` | Esta cotización no tiene productos… agregue al menos uno. |
| `CURRENCY_MISALIGNED` | `requiere_accion` | La moneda de la cotización (${a}) no coincide con la del cliente en Odoo (${b}). No se generó el presupuesto para no facturar precios mal convertidos… |
| `MISSING_COUNTRY_PARTNER_OVERRIDE` | `error` | Las ventas a ${país} se facturan vía una empresa intermediaria que no está configurada… avise a soporte; no se corrige desde HubSpot. |
| `dead_letter` | `error` | No se pudo sincronizar después de varios intentos. Es falla técnica… |
| **desconocido** | `error` | No se generó el presupuesto. Motivo: ${message}. Si no sabe cómo resolverlo, avise a soporte. |

Cada string accionable dice **quién hace qué y dónde**, y nunca lleva un código de error ni un id
interno. Ningún mensaje habla del panel.

### 2.3 Dónde se escribe

Un método nuevo en `HubspotSourceGateway`:
`writeSyncStatus(sourceId, { status, detail, current })` → `{written, reason}`.
Internamente `parseSourceId`; **si no hay `quoteId`, no-op** (el estado nunca va al deal). Echo guard
con namespace propio (`syncstatus:…`) para que una escritura de estado no suprima un writeback
legítimo de `id_presupuesto_odoo`. `current` (que los llamadores ya tienen en memoria) corta la
escritura si el valor no cambió — idempotencia gratis, sin churn en el historial de la propiedad.

Wrapper defensivo en el core, calcado del helper `audit()` de `ProcessSyncJobUseCase:38-44` — es lo
que mantiene verdes los ~631 tests, porque los dobles hechos a mano no tienen el método:

```js
if (typeof gw.writeSyncStatus !== 'function') return
try { await gw.writeSyncStatus(...) } catch (err) { warn + audit('quote.status.write_failed') }
```

**Audita el fallo** en vez de tragárselo: una propiedad que da 400 en cada escritura es el fallo
invisible #1 de esta feature.

| camino | ¿escribe? |
|---|---|
| **Éxito** | Sí, `ok` — **en el MISMO PATCH que `id_presupuesto_odoo`**, extendiendo `buildWriteBackPayload` en `dealSyncModule`. Un request, un echo key, cero costo extra de rate limit, y **atómico**: es estructuralmente imposible que una cotización muestre `S06618` junto a un error viejo. Sin esto, toda escritura de fallo es un tatuaje permanente y la feature se podre en una semana. |
| **`SkipSyncError`** | Sí, en la rama de `handleError` que hoy no escribe nada. |
| **Reintento en curso** | **No.** La mayoría de transitorios se resuelven en segundos; "error, reintentando" seguido de "sincronizado" 8s después es churn permanente en un registro visible al cliente, hasta 8 reescrituras — y los reintentos son justo cuando **HubSpot mismo** puede ser la dependencia que falla (429). Ventas no puede accionar sobre "reintentando". |
| **Dead-letter** | Sí, `error`. Es el momento terminal, lleva información real, y es una escritura por vida del job. |
| **Plan-time (`isEligibleQuote`)** | Sí para `missing_country` — el caso que el plan anterior señaló explícitamente como que debe ser visible. `PlanDealSyncUseCase` gana un `annotateSkipped` que corre **en las dos ramas**, incluida la de `eligible.length === 0` (hallazgo 3), más un audit `deal.no_eligible_quotes`. Cada llamada en su propio try/catch: un 429 anotando una cotización descartada no puede tumbar un fan-out que ya encoló tres jobs buenos. |

**Control de ruido: lista de negación, no de permiso.** `shouldSurfaceReason` devuelve `false` solo
para un conjunto explícito y silencioso, así **cualquier modo de fallo nuevo es visible por
default** — una lista de permiso recrearía la invisibilidad de hoy para todo motivo que alguien
olvide registrar. Quedan silenciosos: `status_not_eligible` (un borrador en un deal ganado es un
estado normal e intencional; escribirle da a entender que *debía* sincronizar),
`missing_status`/`missing_quote`/`missing_properties` (anomalías de API, no acciones de usuario), y
`DEAL_STAGE_NOT_ALLOWED`/`PIPELINE_NOT_ALLOWED` (disparan en el job del deal, cuando todavía no hay
cotización que anotar).

**Loops:** imposibles por código. `src/app.js:65-77` filtra duro
`subscriptionType === 'deal.propertyChange'` **y** `propertyName === 'dealstage'` **y** el valor en
la allowlist — un PATCH a una propiedad de cotización no puede re-entrar al pipeline. El único vector
es un *workflow* de HubSpot que toque `dealstage`; va al runbook.

---

## Fase 3 — Seguridad de moneda *(la forma final depende de X1)*

**Si X1 dice que el portal es mono-moneda**, `hs_currency` no lleva intención y esta fase cambia de
raíz: se vuelve config `país ⇒ moneda esperada` en vez de comparación. La maquinaria de abajo
sobrevive; solo cambia de dónde sale `expectedCurrency`.

### 3.1 Mecánica de Odoo — lo que ya es seguro afirmar

- **Nunca mandar `currency_id`.** En `sale.order` es un campo *related/computed* derivado de
  `pricelist_id`. En la forma "related stored" de Odoo 16, el inverso de la ORM **escribe hacia el
  registro destino**: `write({'currency_id': X})` puede reescribir
  `product.pricelist.currency_id` y **corromper la moneda de todas las órdenes de ese pricelist**.
  Es lo más peligroso de esta fase; X9 lo verifica en vez de asumirlo benigno.
- **El único lever seguro es `pricelist_id`** (y `company_id` si X3 dice compañía aparte).
- **`create()` por JSON-RPC no corre `@api.onchange`.** Tres mecanismos independientes protegen
  nuestro `price_unit` en create: no hay onchange por RPC; pasar `price_unit` en los vals suprime el
  precompute; y `pricelist_id` no está en el `@api.depends` de `_compute_price_unit`. Por eso el
  código de hoy funciona. **Igual hay que confirmarlo en esta instancia**, porque el módulo custom
  `country_expense` es desconocido y podría agregar su propio onchange.
- **`pricelist_id` solo en CREATE, nunca en update.** En `write()`, cambiar el pricelist (i)
  re-denomina las líneas existentes sin convertir — el bug que arreglamos, invertido; (ii) prende
  `show_update_pricelist`, que pinta un banner invitando a un humano a apretar "Update Prices" y
  destruir todos los `price_unit` que vienen de HubSpot, un cambio que el middleware no puede ver;
  (iii) en una orden no-draft puede desincronizar `amount_*` de asientos ya posteados. En el camino
  de update solo **leer** `pricelist_id`/`currency_id`, comparar, y anotar.

### 3.2 Implementación

- **Cliente Odoo**, tres métodos nuevos en **las dos ramas** (stub y http), cada uno con guardia
  `typeof` en el gateway: `searchCurrencyIdsByCodes` (idioma de cache por-código de
  `searchCountryIdsByCodes`, **con `context:{active_test:false}`**), `listPricelists` (idioma
  single-slot+TTL de `listOperationCosts`), y `readPartnerPricelists` — **este sin cache**: la
  asignación de pricelist es mutable y es justo el campo que un humano va a arreglar en respuesta a
  nuestra advertencia; cachearlo 10 minutos hace que el arreglo parezca no funcionar en el peor
  momento. Reusar `operationCostsTtlMs` como TTL compartido de datos de referencia (ya se hace en
  `:165`); un tercer knob no compra nada.
  `res.currency.name` **es** el código ISO-4217, así que el mapeo desde `hs_currency` es directo.
- **`src/adapters/outbound/odoo/currencyPolicy.js`** puro: `compareCurrencies` → `match` /
  `mismatch` / `indeterminate`, y `decideCurrencyAction`. La tabla de verdad completa se vuelve
  tests unitarios **sin un solo mock** — la razón entera de separarlo.
- **`OdooTargetGateway#resolveCurrency`**, espejo estructural de `resolveCountryExpenseFromQuote`:
  nunca lanza, todo fallo de RPC degrada a `{status:'unresolved', reason}`. `metadata.currency` va
  como **hermano** de `metadata.countryExpense`.
- **Mapper**: parámetro `pricelistId = null` → `saleOrder.pricelist_id` solo si no es null, calcado
  del patrón de `countryExpenseId`. Los tests existentes no se tocan (default `null` ⇒ salida
  idéntica).

### 3.3 Política — asimétrica, y con config de rollout

`ODOO_CURRENCY_MODE = off | warn | enforce` (se **entrega en `warn`**) +
`ODOO_CURRENCY_STRICT_COUNTRIES` (CSV, default `MX`).

| veredicto | país normal | país estricto (MX) |
|---|---|---|
| **match** | proceder **idéntico a hoy, sin mandar nada nuevo** | igual |
| **mismatch** con pricelist configurado | mandar `pricelist_id` en create + nota + metadata | igual |
| **mismatch** sin pricelist configurado | `enforce`: SkipSyncError · `warn`: warn + marcador en nota | SkipSyncError siempre |
| **indeterminate** | warn + metadata, **proceder** | SkipSyncError |

La asimetría se justifica por **evidencia**, no por cobardía: para CR/GT/HN/NI hay órdenes vivas con
montos correctos aprobados por humanos, así que un fallo de RPC que impide re-verificar un hecho ya
verificado no agrega riesgo. Para MX no hay evidencia y **sí hay divergencia esperada conocida**, así
que "no sé" es genuinamente inseguro. Dos veredictos más que sí ocurren: `hs_currency` vacío ⇒
`indeterminate`; moneda que existe en Odoo pero **archivada** ⇒ `indeterminate` con motivo
`odoo_currency_archived` (no "no existe" — "MXN existe pero está archivada, nadie puede denominar en
ella hasta que alguien la active" es accionable; "no existe" no).

**Nada de auto-seleccionar un pricelist por moneda.** Varios pricelists comparten moneda
rutinariamente (Público USD, Distribuidor USD…) y elegir uno es arbitrario, aterriza en un campo
visible de un documento que se vuelve factura, y tapa el defecto real: si el
`property_product_pricelist` de visual México está mal, está mal también para las órdenes manuales.
Va explícito por config (`ODOO_COUNTRY_PRICELIST_OVERRIDES=MX:5`, mismo shape que el mapa de
partners), descubierto por la sonda y seteado por un humano. **El trabajo del middleware es
verificar, no adivinar.**

Además: un `ValidationError` de `check_company` de Odoo llega como **HTTP 200** con código JSON-RPC,
que `isRetryableError` no matchea ⇒ **dead-letter en el primer intento** con un traceback opaco como
único diagnóstico. Mitigación: **validación en boot** de que el pricelist configurado existe, está
activo y su `company_id` es compatible — logueada fuerte, no fatal.

**Forzar `warn` en modo stub** (junto a la línea `requireProductMatch: config.odoo.mode === 'http'`
de `dealSyncModule.js:84`): en stub los tres métodos devuelven vacío ⇒ todo `indeterminate` ⇒
`enforce` saltaría todas las corridas locales.

**`ODOO_CURRENCY_MODE=enforce` no se prende hasta que la Fase 2 esté entregada** y una semana de
logs en `warn` esté limpia. Es una traba de dependencia, no paranoia: bloquear sin visibilidad en
HubSpot es otro fallo silencioso, exactamente la objeción que motivó este diseño. En el interín, el
canal es el marcador en la `note` que sí lee quien confirma la orden:
`[smartflow] Moneda: la cotización dice USD y la orden quedaría en MXN — revisar antes de facturar.`

---

## Tests

~631 `it()` hoy. Esperado ~700. Lo que **no** debería moverse: `RetryPolicy`, `SyncJob`,
`MongoJobRepository`, `MongoMappingRepository`, el panel.

- **Puros, sin mocks** — `partnerRouting` (matriz de precedencia completa, y el centinela de
  regresión: `countryOraclePartnerId === endCustomerId` **en todos los casos, incluido el
  override**), `currencyPolicy` (tabla de verdad veredicto × modo × estricto), `quoteSyncStatus`
  (un caso por motivo con el string exacto; motivo desconocido ⇒ `error` con el mensaje crudo,
  **nunca `null`**; motivos silenciosos ⇒ `null`).
- **`OdooTargetGateway.mx.test.js`** — el test clave: **MX + override + lookup de ISO fallando ⇒
  `readPartnerCountries` se llama con el cliente final, jamás con el override**. Más: MX + override
  ⇒ `partner_id` correcto y `searchCountryIdsByCodes(['MX'])`; MX sin override ⇒ `SkipSyncError` con
  `detail.code` y **`createSalesOrder` nunca llamado**; `countryPartnerOverrides` ausente ⇒ los
  tests existentes intactos.
- **Validadores** — el test más importante que se agrega: **MX + sin `id_cliente_odoo` + override
  configurado ⇒ el validador NO lanza** (hallazgo 1). Y `customerProperty:'foo'` lee
  `properties.foo`.
- **Retrocompat de moneda** — "un gateway cuyo apiClient no tiene ninguno de los tres métodos nuevos
  produce un payload de create **byte-idéntico** al de hoy". Tests nuevos en archivo aparte
  (`OdooTargetGateway.currency.test.js`) con su propio `makeApi` que sí los implementa, dejando los
  dos `makeApi` existentes ejercitando las guardias.
- **Visibilidad** — skip ⇒ una escritura con `requiere_accion`; gateway **sin** el método ⇒ no
  lanza; gateway que **lanza** ⇒ el job sigue `SKIPPED` + audit `quote.status.write_failed`;
  reintento ⇒ **no** escribe; dead-letter ⇒ escribe `error`; `status_not_eligible` ⇒ **cero**
  escrituras; deal todo-inelegible ⇒ sigue `{mode:'fallback'}`, `markCompleted` **no** llamado, pero
  estados escritos; `writeBack` en cotización manda las 3 propiedades en **un** PATCH y en deal no
  manda ninguna de estado.
- **e2e** — el caso existente de deal sin cotizaciones sigue pasando **sin modificarse**.

### Trampas de compatibilidad (verificadas)

`quotePropertyDefinitions.test.js` hace `toHaveLength(2)` e indexa `defs[0]`/`defs[1]` (agregar al
final y actualizar). `HubspotSourceGateway.quote.test.js:135` hace `toEqual([{quoteId,reason}])` (se
rompe al agregar `detail`). `hubspotApiClient.quote.test.js:100` hace `toEqual(QUOTE_PROPERTIES)`.
`OdooTargetGateway.test.js:517` hace `toEqual` sobre `metadata.countryExpense` — de ahí que
`currency` y `routing` sean **hermanos**, nunca claves adentro. `PlanDealSyncUseCase.test.js` afirma
que `markCompleted` **no** se llama en la rama de fallback. `full-flow.test.js:272` usa
`toHaveProperty`, así que claves extra de writeback son seguras. Las nuevas keys van solo a
`OPTIONAL_KEYS`, nunca a `REQUIRED_KEYS`, para que un `ODOO_COUNTRY_*` ausente no pueda tumbar el
boot.

---

## Verificación end-to-end

1. `npm test` verde.
2. `node scripts/probes/mexico-readiness.js` — X1-X10 sin `fail`; un humano lee X5/X6/X9-D.
3. Actualizar la nota "México sigue pendiente" de
   [plan-cotizaciones-por-pais.md](plan-cotizaciones-por-pais.md).
4. Bootear una vez y confirmar que las dos propiedades nuevas existen en el objeto cotización.
5. En HubSpot: un deal de prueba **de México** con 3 cotizaciones — una MX publicada con país, una
   publicada **sin** país, y una en borrador. Pasar a Cierre Ganado.
   Esperado: **1** `sale.order` con `partner_id` = visual México **y** `country_expense` = México;
   la cotización sin país mostrando `Requiere acción` + el mensaje en español; el borrador
   **intacto**; la sincronizada mostrando `Sincronizado` + su `S066xx`.
6. Desetear `ODOO_COUNTRY_PARTNER_OVERRIDES` y re-disparar: la cotización MX queda `SKIPPED` con
   `error` + el mensaje de "avise a soporte", y **no** se crea presupuesto. Volver a setear.
7. Corregir el país de la cotización sin país, re-ganar, y confirmar que el mensaje **cambia a
   `Sincronizado`** — la prueba de que el estado no se queda viejo.
8. Verificar en Odoo que la moneda del presupuesto de México es la esperada, y comparar `amount_tax`
   contra un presupuesto de CR del mismo inventario (el delta de posición fiscal de X9-D).
9. Re-disparar el deal y confirmar con `inspect-quote.js` que **no se duplican líneas ni
   presupuestos** (el `origin` compuesto los encuentra).

---

## Riesgos y fuera de alcance

- **X3 es la sonda que puede volar el alcance.** Si visual México es un `res.company` y no un
  `res.partner`, el lever pasa a ser `company_id`, entran secuencias/plan de cuentas/ACLs distintos,
  y hay que **replanear la Fase 3** — no empujar el plan actual.
- **La sustitución de partner cambia los impuestos de cada línea.** `fiscal_position_id` se computa
  del partner y nuestras líneas no llevan `tax_id`, así que Odoo los deriva de producto + posición
  fiscal. Es presumiblemente **lo deseado** (es el punto de facturar vía una entidad mexicana), pero
  **nadie lo ha verificado**. X9-D lo mide; si el delta no tiene sentido, merece su propia decisión
  antes de que México salga a producción. Esto puede importarle más al negocio que la moneda.
- **`ensureCustomProperty` solo crea, nunca reconcilia.** Si `estado_sync_odoo` ya existiera creada a
  mano con otras opciones, devuelve `{created:false}` y **cada escritura da 400 para siempre**. X10
  lo detecta; el arreglo es un script de reconciliación al estilo de
  `scripts/sync-quote-country-options.js`, **no** reconciliar en boot (el boot no debe pelear con
  ediciones manuales).
- **Las cotizaciones son documentos que ve el cliente.** Si `detalle_sync_odoo` se agregara a una
  *plantilla* de cotización, prosa de error en español se renderizaría en un PDF que lee un cliente.
  Va al runbook: nunca poner estas dos propiedades en una plantilla, y nunca construir un workflow de
  HubSpot sobre ellas.
- **Cambia la distribución de alertas**: una mala config de México ahora produce `SKIPPED` en vez de
  `DEAD_LETTER`. Cualquier tablero que cuente dead-letters se queda callado ante un hueco de
  configuración real.
- **El camino de fallback (deal sin cotizaciones) sigue invisible en HubSpot** por diseño: no hay
  objeto cotización que anotar. Un deal de México que caiga ahí factura al cliente final, porque el
  país sale del walk del partner y no hay señal de país. La regla de negocio ("México va en deal
  aparte, con cotización") lo vuelve error de operador; guardia opcional documentada para después.
- **Multi-moneda dentro de un mismo deal sigue sin soportarse** (decisión E). Los cambios de line
  items posteriores al primer sync siguen sin propagarse (limitación heredada de
  `buildSaleOrderUpdatePayload`). La factura de Odoo no se toca.
- **X9 quema 3-4 números de la secuencia S06xxx** creando y borrando órdenes draft de prueba.

---

## Orden de entrega

Cada fase entrega valor por sí sola y se puede parar en medio.

| Fase | Qué | Sin ella |
|---|---|---|
| **0** | Sonda. **Compuerta: nada de código antes.** | Se estaría codeando contra supuestos, y X1/X3 pueden cambiar el diseño. |
| **1** | Ruteo de partner por país + los 3 bugs de "config que miente". | México factura a la entidad equivocada, o el job muere en dead-letter sin llegar al código nuevo. |
| **2** | Las dos propiedades de estado en HubSpot. | Los rechazos de la Fase 1 (y **todos** los skips que ya existen hoy) siguen invisibles para Andrea y ventas. |
| **3** | Seguridad de moneda, entregada en `warn`. | El error silencioso de ~17x sigue vivo. `enforce` solo después de la Fase 2. |
