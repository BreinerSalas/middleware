# Plan — Cambios post-reunión 2026-08-05 (Visual Branding / Smarteam)

## Context

En la reunión del 2026-08-05 (presentación de cambios Odoo/HubSpot con Andrea Fuentes,
Gabriela Rodas, Lorena Osorio y Juan Carlos Armijos) se demostró la integración actual —un deal
con multicotizaciones que al pasar a *cierre ganado* dispara N presupuestos hacia Odoo— y
surgieron requerimientos nuevos, dos de ellos de peso arquitectónico.

El mayor: **la integración se construyó unidireccional (HubSpot → Odoo) y el cliente requiere
bidireccionalidad**. Lorena confirmó en la misma llamada que la propuesta comercial firmada sí
la contemplaba. El equipo comercial **no toca Odoo en absoluto**, así que toda corrección debe
poder hacerse en HubSpot y regresar.

Además el sync de productos deja de ser una utilidad manual: pasa a ser **continuo** sobre
~11,400 productos que siguen creciendo, y ahora tiene que cargar también la URL de la imagen.
Andrea puso dos condiciones explícitas: **seguridad** y que sea **"sostenible por el peso en el
tiempo"**.

## Decisiones (ya tomadas — no re-litigar)

| Tema | Decisión |
|---|---|
| **A. Prioridad** | Imágenes de producto primero (es lo único con fecha comprometida) |
| **B. Bidireccionalidad** | Spike de viabilidad antes de comprometer diseño o fechas |
| **C. Auto-confirmación** | Todas las cotizaciones, con bitácora y manejo explícito de rechazo |
| **D. Gate de México** | ~~Por país~~ → **por pipeline**: el allowlist que ya existe lo resuelve sin código |
| **E. Sync continuo** | Vía incrementalidad por `write_date` + pasada completa programada aparte |
| **F. Productos sin SKU** | **Fuera de este plan** — se acuerda con el cliente antes de tocar datos |

## Estado actual verificado

- **Dirección**: HubSpot es siempre *source port*, Odoo siempre *target port*. No existe
  `SOURCES.ODOO`, ni endpoint inbound desde Odoo, ni polling de Odoo, ni búsqueda inversa de
  mapping por `targetId`. `JOB_KIND` solo tiene `deal` y `quote`.
- **Entrada única**: `POST /webhooks/hubspot` ([src/app.js:49](../src/app.js#L49)). El servidor
  es **Fastify**, no Express.
- **Único camino Odoo → HubSpot existente**: el sync de productos
  ([productSyncModule.js](../src/composition/productSyncModule.js)), disparado por CLI manual,
  fuera del pipeline de jobs. Es el molde para ampliar esa dirección.
- **`mrp.production` create/write existe pero está muerto**
  ([odooApiClient.js:388-392](../src/adapters/outbound/odoo/odooApiClient.js#L388-L392)): la MO
  la crea **Odoo mismo** al confirmar el presupuesto. El middleware no debe crearla.
- **Utilidades reutilizables ya presentes**: `createRateLimiter`
  ([rateLimiter.js](../src/core/shared/rateLimiter.js), genérico, con reloj inyectable),
  `RetryPolicy.calculateNextRetry` (exponencial + jitter), `runSequentially`
  ([mutex.js](../src/core/shared/mutex.js)), `JobPoller` con claim atómico y watchdog de
  huérfanos, y el `provisionProperties` genérico.

---

## Fase 1 — Imágenes: probe + muestra  *(prioridad alta; compromiso viernes 2026-08-07)*

Esta fase **no toca el sync completo**, así que puede entregarse sin esperar el trabajo de
escala de las Fases 2–3.

### Los dos desconocidos que mandan

**(a) ¿Es alcanzable la URL sin credenciales?** `image_1920` es binario base64 y la URL sigue
`/web/image/product.template/<id>/image_1920`. Hoy todo el acceso a Odoo es JSON-RPC autenticado
([odooApiClient.js:110-128](../src/adapters/outbound/odoo/odooApiClient.js#L110-L128)). HubSpot
—y el navegador que renderiza la cotización— deben traerla sin credenciales. `ODOO_BASE_URL` ya
existe ([config/index.js:22](../src/config/index.js#L22)).

**(b) ¿Una propiedad custom de texto con la URL realmente pinta la imagen?** Probablemente
**no**. HubSpot tiene propiedad nativa de imagen en productos (`hs_images`); si la plantilla solo
renderiza esa, "extraer la URL" es necesario pero **no suficiente**. Este es el verdadero pivote
y hay que resolverlo antes de escribir código de sync.

### Paso 1.1 — Probe `scripts/probes/product-image-readiness.js`

Copiar convenciones de [mexico-readiness.js](../scripts/probes/mexico-readiness.js) y
**reutilizar** `buildOdooRpc` / `buildHubspotHttpClient` que ya exporta
[hubspot-quote-readiness.js](../scripts/probes/hubspot-quote-readiness.js). Checks `I1..I9`, gate
`I1,I3,I5,I6`, salida a `docs/testing/<fecha>-product-image-readiness.json`, cada función
exportada para poder testearla.

| ID | Qué verifica |
|---|---|
| **I1** | `fields_get` sobre `product.product` y `product.template` filtrado a `/^image_/`. Resuelve **cuál es el segundo campo** que mencionó Andrea (probablemente `image_1920` en template + `image_variant_1920` en la variante). |
| **I2** | Cobertura vía `search_count` con `[('image_1920','!=',False)]`, sin traer binarios. |
| **I3** | **(decisivo)** GET **sin credenciales**, `validateStatus: () => true`, `maxRedirects: 0`. Registrar status, content-type, bytes, `location` en 3xx. |
| **I4** | `website_published` / ACL, para explicar un fallo de I3. |
| **I5** | Scopes de producto del token; **faltaban en la última prueba** ([sync-products.tdd.md:72](testing/sync-products.tdd.md#L72)). |
| **I6** | **(pivote)** `GET /crm/v3/properties/products`: ¿existe `hs_images`?, ¿de qué tipo?, ¿hay propiedades `type: 'file'`? |
| **I7** | Si `url_imagen_odoo` ya existe (creación solo detrás de `--provision`). |
| **I8** | Peso: leer `image_1920` de **solo 10 ids** → p50/máx y proyección; medir también `image_512` para cotizar la variante barata. |
| **I9** | Disponibilidad de `write_date`, para dimensionar la Fase 3. |

> **Cuidado con el falso positivo en I3**: Odoo devuelve un PNG placeholder con status 200 cuando
> el producto no tiene imagen. Detectarlo por tamaño y marcarlo `warn`, **no** `pass`.

### Paso 1.2 — Regla de decisión → **resuelto con datos reales de staging (2026-08-05)**

| Resultado de I3 | Vía |
|---|---|
| 200 + `image/*` y no es el placeholder | **A. URL directa de Odoo** |
| 401/403/404 o redirect a login | **B. Proxy en el middleware** |
| Odoo no alcanzable desde internet | **C. Drive/CDN**, último recurso |

**Corrida real** ([docs/testing/2026-08-05-product-image-readiness.json](testing/2026-08-05-product-image-readiness.json)):
I3 dio **FAIL**, pero no por 401/403/404 — Odoo devuelve **200** con `content-type: image/png`
tanto para productos con imagen real como para el producto sin imagen usado de línea base,
**y ambos pesan exactamente 20,039 bytes**. Confirmado además contra una lectura autenticada por
RPC: la imagen real del mismo producto pesa **85,389 bytes**. Conclusión inequívoca: el acceso
anónimo a `/web/image/...` en este Odoo siempre sirve el placeholder genérico, nunca el binario
real — el 200 es un falso positivo. **Vía A queda descartada. Se construye la Vía B.**

**Forma de B**: `src/adapters/inbound/http/media.routes.js` como **plugin de Fastify**, siguiendo
[panel.routes.js](../src/adapters/inbound/http/panel.routes.js).
`GET /media/products/:signedId/image` → lee `image_512` autenticado vía `odooApiClient`, sirve el
buffer con `Cache-Control` y `ETag` derivado de `write_date` (304 gratis). El **"parámetro de
seguridad"** de Andrea: no autenticar (el renderer de HubSpot es anónimo) sino firmar el segmento
de ruta con HMAC sobre `odooId` + un `MEDIA_URL_SECRET` nuevo, para que no sea enumerable, más
`createRateLimiter` en la ruta. Usar `image_512`, no `image_1920`: mismo contenido visual, ~3x
menos bytes de por medio — **pesos reales medidos (I8)**: `image_1920` p50 ≈194KB/máx ≈334KB,
`image_512` p50 ≈62KB. Sobre ~11,400 productos, servir por `image_512` bajo demanda (sin
almacenar nada, la Vía B no cachea en disco) mantiene el ancho de banda manejable.

### Paso 1.3 — Propiedad: usar `hs_images` nativa, no crear una custom

**Hallazgo real (I6)**: `hs_images` **ya existe** en el esquema de productos de este portal, tipo
`string`/`text` — es la propiedad nativa de HubSpot para imagen de producto, que en su API se
expone como texto (URL, o lista de URLs separadas por `;`), no como un objeto de archivo. **No
hace falta crear `url_imagen_odoo` ni ninguna propiedad custom.**

Hoy las propiedades de producto están **hardcodeadas** en
[HubspotProductGateway.js:19-31](../src/adapters/outbound/hubspot/HubspotProductGateway.js#L19-L31).
Extender `buildProperties` para que reciba un **`imageUrlBuilder` inyectado** por constructor
(default `null`) y, cuando devuelve un string no vacío, lo escriba en `props.hs_images` — la URL
firmada del proxy de la Vía B. El gateway queda puro y la decisión de qué URL construir vive
enteramente en el módulo de composición.

> ⚠️ **Pendiente de verificar antes de la muestra del viernes**: que la plantilla de cotización
> efectivamente *renderiza* `hs_images` visualmente. Es la propiedad nativa correcta, pero
> "existe y acepta texto" no es lo mismo que "se dibuja en el PDF" — probarlo con un producto real
> antes de dar la Fase 1 por cerrada.

### Paso 1.4 — Muestra de ~10 productos ✅ ENTREGADO (2026-08-05, adelantado)

Implementado y verificado de punta a punta contra el Odoo/HubSpot reales:

- `src/core/shared/mediaSignature.js` — firma/verifica tokens HMAC-SHA256 sobre el id de Odoo.
- `odooApiClient.readProductImage(odooId)` — lee `image_512`/`write_date` autenticado.
- `odooApiClient.searchProductIdsWithImage()` — usa el dominio `product_tmpl_id.image_1920 != false`
  (verificado contra staging: 6487 resultados, coincide exacto con el conteo esperado).
- `src/adapters/inbound/http/media.routes.js` — plugin Fastify `GET /media/products/:token/image`,
  con detección de content-type por firma de bytes (PNG/JPEG/GIF/BMP/WEBP), `Cache-Control`,
  `ETag` por `write_date` (304), y rate limiter reutilizado.
- `HubspotProductGateway` gana `imageUrlBuilder` inyectado; escribe en **`hs_images`** (nativa,
  no custom) cuando el builder devuelve una URL no vacía.
- `scripts/sync-products.js` — refresca el set de ids-con-imagen una vez por tick
  (`refreshImageIds`), y agrega `--sample=N` como alias de `--limit`.

**Verificación real (2026-08-05)**: 10 productos con SKU e imagen reales, elegidos vía
`product_tmpl_id.image_1920 != false`, actualizados en el HubSpot activo (confirmado con el
usuario que el token activo era el correcto) con `hs_images` apuntando al proxy. Servidor
expuesto por túnel ngrok del usuario; verificado con `curl` que la URL pública devuelve la
imagen real (JPEG, ~24–46 KB según el producto) con status 200 — no el placeholder de Odoo.

**Hallazgo colateral, sin tocar**: dos productos de Odoo (`id 14107` y `14231`) comparten el
mismo `default_code` `AP250433-0` — problema de datos preexistente en Odoo, no del código.

**Pendiente para producción**: `MEDIA_PUBLIC_BASE_URL` debe apuntar al dominio público real del
middleware desplegado, no al túnel ngrok de esta sesión (que es efímero).

---

## Fase 2 — Robustez del cliente de Odoo  ✅ ENTREGADO (2026-08-05, vía TDD)

Implementado con ciclo RED/GREEN completo — ver evidencia en
[docs/testing/2026-08-05-odoo-client-hardening.tdd.md](testing/2026-08-05-odoo-client-hardening.tdd.md).
Los dos bugs confirmados quedaron corregidos, más rate limiter y timeouts por operación:

El cliente de HubSpot está protegido (token bucket `rps:9/burst:15`, retry de 429 honrando
`Retry-After`). **El de Odoo no tiene nada**: ni rate limiter, ni retry, ni backoff — solo timeout
de 10s ([odooApiClient.js:12](../src/adapters/outbound/odoo/odooApiClient.js#L12)).

### Bug confirmado 1 — la caché de auth se envenena

`ensureUid` guarda `uidPromise` y **nunca la invalida si falla**
([odooApiClient.js:110-124](../src/adapters/outbound/odoo/odooApiClient.js#L110-L124)). Como una
promesa rechazada queda cacheada, **un solo fallo transitorio de autenticación deja el cliente
muerto hasta reiniciar el proceso** — fatal para un loop continuo. Limpiar en el `catch` y
reintentar.

### Bug confirmado 2 — nada es reintentable hoy

Los errores JSON-RPC llegan **dentro de un cuerpo HTTP 200**, y `rpcCall` fija `e.httpStatus = 200`
([odooApiClient.js:96-108](../src/adapters/outbound/odoo/odooApiClient.js#L96-L108)), así que
cualquier `isRetryableError` basado en status devuelve `false` para **todo**. La retryabilidad
tiene que salir del *payload*, no del status:

- `err.transient = true` → `SessionExpiredException`, `SerializationFailure`, `DeadlockDetected`,
  `TimeoutError`
- `err.transient = false` → `ValidationError`, `IntegrityError`, `AccessError`

`RetryPolicy.isRetryableError` ya honra `err.transient` primero — ese es el gancho, no hace falta
utilidad nueva.

### Resto

- **Reutilizar** `createRateLimiter` (arrancar en `rps: 5, burst: 10`; Odoo self-hosted no publica
  límite, el cuello es Postgres) y `RetryPolicy.calculateNextRetry` para el backoff.
- **Timeouts por operación**: página de catálogo 30s, `write` puntual 10s.

---

## Fase 3 — Sync incremental y dueño del loop  ✅ ENTREGADO (2026-08-05, vía TDD)

Implementado con cinco ciclos RED/GREEN encadenados — ver evidencia completa en
[docs/testing/2026-08-05-incremental-sync.tdd.md](testing/2026-08-05-incremental-sync.tdd.md).
Resumen de lo entregado:

- **Aislamiento de kind entre pollers**: `findClaimable`/`recoverOrphans` ahora filtran por
  `kind` (string o array); el poller de deals/quotes quedó explícitamente acotado a
  `[JOB_KIND.DEAL, JOB_KIND.QUOTE]`.
- **Listado incremental**: `OdooProductSource.listChangedSince()` (async generator) sobre
  `odooApiClient.searchProductsChangedSince()`, con el dominio OR-contra-plantilla exacto que
  describe esta fase. De paso se corrigió el bug de `limit` tras `break` en `listAll`.
- **Cursor persistente**: `MongoSyncCursorRepository` + `productSyncModule.runIncremental()` —
  avanza el watermark a `maxWriteDateVisto - overlapMs` **solo si `failed === 0`**; arranca
  desde época 1970 si el cursor nunca se sembró.
- **Dueño del loop**: `productSyncJobModule` — cada tick corre `runIncremental`, marca el job
  completado o reintentado/dead-letter, y **siempre** siembra el siguiente tick
  (`RETRY_PENDING`, pautado `tickIntervalMs` después de terminar). Cableado en `server.js`
  detrás de `PRODUCT_SYNC_JOB_ENABLED` (por defecto `false` — no cambia el comportamiento de
  ningún entorno existente hasta activarlo a propósito).

**Deliberadamente fuera de este ciclo** (documentado, no implementado):
archivar en HubSpot los productos con `active=false` (hoy solo se excluyen del sync y se
cuentan, ver known gap en la evidencia), la extensión del esquema de `ProductSyncRun` con
`mode`/`batchCalls`/`durationMs`/etc., y el job de reconciliación completa programado
(semanal). `scripts/sync-products.js --once` sigue siendo el escape manual para una pasada
completa mientras tanto.

> **Nota de alcance**: el "SKU sintético" (publicar `String(odooId)` como `hs_sku` para los
> productos sin `default_code`, documentado en [todo-sku-sintetico.md](todo-sku-sintetico.md))
> **queda fuera de este plan** — cambia datos en HubSpot y hay que acordarlo con el cliente
> primero. Ver *Pendiente con el cliente* más abajo. Esta fase está diseñada para funcionar
> **sin** él.

### Por qué la incrementalidad basta por sí sola

El cuello de botella actual son los ~5,300 productos **sin** SKU, que van de a uno con concurrencia
clamped a 3 ([productSyncModule.js:18-22](../src/composition/productSyncModule.js#L18-L22)),
mientras los que sí tienen SKU van en lotes de 100.

| Escenario | Llamadas a HubSpot | A 9 rps |
|---|---|---|
| Pasada completa (hoy, cada tick) | 62 batch + 2×5,348 ≈ **10,700** | ~20 min — **más que el intervalo de 60s: los ticks se solapan indefinidamente** |
| Pasada completa (programada, fuera de hora) | igual ≈ 10,700 | ~20 min, pero **una vez por semana**, no cada minuto |
| Delta incremental (régimen normal) | proporcional a lo que cambió | segundos |

La conclusión que importa: **el problema no es el costo de la pasada completa, es correrla cada 60
segundos.** Al pasar a deltas, el camino lento de los sin-SKU deja de ser el costo dominante porque
solo se recorre para los productos que realmente cambiaron. La pasada completa se conserva como
reconciliación programada, no como el modo normal de operación.

Esto hace la incrementalidad **más** necesaria, no menos, ahora que el SKU sintético no está
disponible como atajo.

### Incrementalidad

- **`write_date` de `product.product` no alcanza**: `name` y `list_price` viven en
  `product.template`. Editarlos mueve el `write_date` **de la plantilla**, no el de la variante, y
  el delta se perdería en silencio. El dominio tiene que ser
  `['|', ['write_date','>',wm], ['product_tmpl_id.write_date','>',wm]]`.
- Cursor propio (`syncCursor`, clave `product-sync`) alimentado del `write_date` **que devolvió
  Odoo** — no de `max(lastSyncedAt)`, que es nuestro reloj.
- `nuevoWatermark = maxWriteDateVisto - OVERLAP_MS` (default 60,000) para cubrir desfase de reloj y
  escrituras en el mismo segundo; el batch upsert es idempotente, el solape sale gratis.
- **Avanzar el cursor solo si `failed === 0`**; si no, dejarlo y que el próximo tick relea.
- `OdooProductSource.listChangedSince()` como **async generator**, para que las páginas fluyan a
  lotes de 100 en vez de bufferear 11.4k filas. Corregir de paso el bug de `limit` tras `break`
  ([OdooProductSource.js:29-31](../src/adapters/outbound/odoo/OdooProductSource.js#L29-L31)).
- **Nunca pedir `image_1920` en el listado** — es base64 y devolvería del orden de GB. La URL se
  construye desde el `id`.
- **Archivados**: `active === false` → `batch/archive` en HubSpot. Los borrados duros son
  invisibles a `write_date`; solo los caza una pasada completa periódica (semanal) que diffee la
  tabla de mappings contra los ids de Odoo.

### Dueño del loop

[todo-sku-sintetico.md](todo-sku-sintetico.md) ya decidió **no** cablearlo en `src/server.js` ni
exponer un endpoint HTTP. La opción que respeta esa decisión es un **`JOB_KIND.PRODUCT_SYNC`** en
el pipeline de jobs que ya existe, aprovechando el claim atómico y el watchdog del `JobPoller`.
Dos correcciones obligatorias antes:

- **`findClaimable` no filtra por `kind`**
  ([MongoJobRepository.js:59-80](../src/adapters/outbound/mongo/MongoJobRepository.js#L59-L80)): un
  segundo poller **le robaría jobs de deals al primero**. Hay que agregar el filtro.
- **`recoverOrphans` usa un watchdog fijo de 5 min**
  ([MongoJobRepository.js:127](../src/adapters/outbound/mongo/MongoJobRepository.js#L127)): una
  reconciliación completa de 11.4k productos lo excede y el watchdog **resucitaría un job todavía
  corriendo**, duplicando trabajo. Hace falta un heartbeat (`touch(id)`) o un watchdog por kind.

`scripts/sync-products.js` se conserva como escape manual para `--full`.

**La pasada completa necesita su propio calendario**: ~20 min de trabajo no puede vivir en el tick
de 60s. Programarla semanal / fuera de horario, como job aparte del delta continuo.

### Observabilidad

Extender el esquema de runs con `mode`, `watermarkFrom/To`, `odooFetched`, `batchCalls`,
`durationMs`, `archived`, `failuresByReason`, `cursorAdvanced`. El panel ya renderiza runs.
Registrar aparte el tiempo gastado en el camino sin-SKU: es el dato que sustenta la conversación
pendiente con el cliente.

---

## Pendiente con el cliente — productos sin SKU

Los ~5,300 productos sin `default_code` obligan hoy a un camino de a uno con concurrencia 3. Hay un
puente ya en producción desde el 2026-07-30 (match por nombre normalizado, y `SkipSyncError` con
motivo legible cuando el nombre es ambiguo o no aparece), así que **nada se pierde en silencio** —
pero el costo de rendimiento persiste.

Opciones a plantear a Andrea, para decidir con ella y no por ella:

1. **Que Odoo asigne referencia interna** a los productos que no la tienen — es el arreglo de raíz,
   del lado del dato.
2. **SKU sintético** = id de Odoo publicado como `hs_sku`, aprovechando que `resolveProductId`
   ([dealToSaleOrderMapper.js:3-8](../src/adapters/outbound/odoo/dealToSaleOrderMapper.js#L3-L8)) ya
   acepta un `hs_sku` numérico. Riesgo documentado: un `default_code` numérico que choque con el
   `id` de otro producto; exige auditoría de colisión previa y un paso de adopción, sin el cual se
   crearían ~5,300 duplicados.
3. **Dejarlo como está** y absorber el costo en la pasada completa programada.

Llevar a esa conversación **conteos re-medidos**: el doc dice 11,529 / 6,181 con `default_code`;
[sync-products.js:67](../scripts/sync-products.js#L67) dice 5,848 / 11,132. **No citar cifras al
cliente sin verificarlas.**

---

## Fase 4 — Auto-confirmación → orden de fabricación  ✅ ENTREGADO (2026-08-05, vía TDD)

Implementado en tres ciclos RED/GREEN — ver evidencia en
[docs/testing/2026-08-05-auto-confirm.tdd.md](testing/2026-08-05-auto-confirm.tdd.md).

**Desviación deliberada del diseño original**: el rechazo de `action_confirm` (stock, crédito,
reglas de fabricación) **no** se modela como `SkipSyncError` — el `sale.order` ya se creó/
actualizó correctamente en ese punto, así que marcar el job entero como `SKIPPED` habría sido
incorrecto (el upsert sí tuvo éxito). En su lugar, el rechazo queda registrado en
`result.metadata.confirmation = {status:'rejected', reason}`, se loguea como warning, y el job
se completa normalmente. Es visible (no falla en silencio) sin tergiversar el resultado real
del sync.

Tras el `upsertSalesOrder` exitoso
([OdooTargetGateway.js:394](../src/adapters/outbound/odoo/OdooTargetGateway.js#L394)), invocar
`action_confirm` sobre el `sale.order` con el `execute_kw` que ya existe.

- **Detrás de un flag de entorno**, para volver a modo manual sin desplegar.
- **Manejo de rechazo explícito**: si Odoo rechaza la transición (stock, crédito, reglas de
  fabricación) no puede fallar en silencio — registrar con motivo legible, siguiendo el patrón
  `SkipSyncError` / `skipDetail` que ya usa el flujo de productos sin SKU.
- **Bidireccionalidad barata de regalo**: ya confirmado, buscar la `mrp.production` cuyo `origin`
  corresponde al presupuesto y escribir su `name` de vuelta en la cotización. Esto cubre el
  "número de MO" que pidió Andrea **sin necesitar canal inbound**, reutilizando el write-back
  existente
  ([HubspotSourceGateway.js:185-206](../src/adapters/outbound/hubspot/HubspotSourceGateway.js#L185-L206)).

> ⚠️ Requiere agregar la propiedad a la lista hardcodeada `QUOTE_PROPERTIES` (ver nota al final de
> la Fase 5), o se ignorará en silencio.

---

## Fase 5 — Excluir a Displays (México)  *— resuelto sin escribir código*

**El mecanismo ya existe y es más preciso que gatear por país.** `createMustBeInPipeline`
([validators.js:70-90](../src/composition/validators.js#L70-L90)) lee `record.properties.pipeline`
y lanza `SkipSyncError` si no está en `config.deals.allowedPipelineIds`, que por defecto contiene
**solo** el pipeline Comercial Visual Branding
([config/index.js:99-100](../src/config/index.js#L99-L100)), con `HS_REJECT_UNKNOWN_PIPELINE` en
`true`. Corre en *plan-time*
([PlanDealSyncUseCase.js:55-79](../src/core/application/use-cases/PlanDealSyncUseCase.js#L55-L79)),
**antes** del fan-out y de cualquier llamada a Odoo.

**Consecuencia**: si Displays vive en su propio pipeline, sus deals **ya quedan bloqueados hoy** —
job `SKIPPED`, `phase: 'plan.preflight'`. Y la exportación de Visual Branding hacia Displays, que
sí debe ir a Odoo, permanece en CVB y sincroniza normal. **Cero código.**

- **Acción requerida, del lado HubSpot**: crear el pipeline "Displays" con sus etapas terminando en
  "presupuesto aprobado" y mover ahí los deals de México. Coordinar con Juan Carlos / Andrea.
- **Por qué es mejor que el país**: `pais_de_destino = MX` es estructuralmente ambiguo — no
  distingue "venta interna de Displays" de "exportación de Visual Branding a México". Además el
  modo de fallo es seguro: un deal mal archivado se bloquea, no se sincroniza de más.
- **Plan B si no quieren tocar pipelines**: propiedad enum de deal ("entidad emisora") + denylist
  por entorno, validada junto a `createMustBeInPipeline`. Cuesta una entrada en
  `buildDealPropertiesToFetch` (sin HTTP extra) más un validador; el costo real es el backfill.
- **Descartado**: `hubspot_owner_id` (proxy frágil: un owner compartido o reasignado desvía en
  silencio) y bandera a nivel de empresa (fetch extra por deal, y el cliente de la exportación *es*
  Displays, así que es ambiguo igual).

[plan-mexico.md](plan-mexico.md) queda **invalidado** — asumía facturar a "visual México" vía
`COUNTRIES_REQUIRING_PARTNER_OVERRIDE` y nunca consideró el ángulo de pipeline. Su probe X2 falló
porque ese `res.partner` no existe; ahora sabemos que no existe **porque no debe existir**.

**Latente, a corregir al tocar el tema**: `listEligibleQuotes` llama `getDealQuotes(dealId)` **sin**
pasar propiedades
([HubspotSourceGateway.js:62](../src/adapters/outbound/hubspot/HubspotSourceGateway.js#L62)), así
que usa en silencio la lista hardcodeada `QUOTE_PROPERTIES`
([hubspotApiClient.js:8-15](../src/adapters/outbound/hubspot/hubspotApiClient.js#L8-L15)).
Cualquier propiedad nueva de cotización exige editar también esa lista.

---

## Fase 6 — Spike de bidireccionalidad — ✅ SPIKE + NÚCLEO ENTREGADO (2026-08-06, vía TDD)

> **Spike (ejecutado contra Odoo real)**: confirmado que **no existe webhook saliente nativo**
> en esta instancia (`ir.actions.server` no tiene `state='webhook'`; ver
> `docs/testing/2026-08-06-bidirectional-readiness.json`). La vía viable es **polling por
> `write_date`**, reutilizando la maquinaria de Fase 3.
>
> **Núcleo construido** (estado del presupuesto + retroceso de etapa por cancelación): ver
> [docs/testing/2026-08-06-sale-order-status-sync.tdd.md](testing/2026-08-06-sale-order-status-sync.tdd.md).
> Cubre `sale.order.state`/`invoice_status` → propiedades de la cotización de HubSpot, y el
> retroceso automático del deal a su etapa anterior cuando el presupuesto se cancela para
> editarse. **No cubierto todavía**: facturación electrónica granular (pendiente probe de
> `account.move`), retry de búsqueda de MO vía `mrp.production`, productos/contactos (no se
> identificó brecha real).

Objetivo: **decidir con datos, no diseñar todavía.**

1. ¿Puede este Odoo hacer un POST saliente (automated action / `base_automation`) al cambiar el
   estado de un `sale.order`?
2. Si no, ¿es viable polling por `write_date`? (la Fase 3 ya construye esa maquinaria para
   productos — se reutiliza).
3. ¿Qué campos exactamente deben regresar? Andrea pidió: estado del presupuesto, número de MO,
   productos, contactos y campos de facturación electrónica. Los países con impuestos **no**
   requieren bidireccionalidad.

Brechas ya identificadas: falta `SOURCES.ODOO`, falta el par gateway inverso, falta lookup de
mapping por `targetId`, y `echoGuard` solo cubre el sentido actual.

---

## Riesgos

- **El gate de México depende de una acción en HubSpot, no del código.** Si Displays no se mueve a
  su propio pipeline, sus deals seguirán entrando por CVB y sincronizando a Odoo.
- **Los conteos de productos no concuerdan** entre `docs/todo-sku-sintetico.md` y
  `scripts/sync-products.js:67`. Re-medir antes de citar cifras al cliente.
- **Una propiedad nueva de cotización se ignora en silencio** si no se agrega a `QUOTE_PROPERTIES`.
  Trampa fácil de pisar al implementar el número de MO.
- **Bidireccionalidad = riesgo de bucle.** `echoGuard` cubre un solo sentido hoy.
- **Hoy los ticks del sync ya se solapan** (~20 min de trabajo con intervalo de 60s). No subir la
  frecuencia antes de que la Fase 3 separe el delta de la pasada completa.
- **Sin resolver los productos sin SKU, la pasada completa sigue costando ~20 min.** Es tolerable
  como job semanal, pero limita cuán seguido se puede reconciliar de verdad. Queda supeditado a la
  conversación con el cliente.

## Verificación

1. **Probe de imágenes**: `node scripts/probes/product-image-readiness.js` → JSON en
   `docs/testing/` con el gate en verde y respuesta explícita sobre I3 (URL anónima) e I6
   (`hs_images`).
2. **Muestra**: 10 productos en HubSpot con la imagen visible en una cotización real, abierta **sin
   sesión de Odoo**.
3. **Cliente de Odoo**: test con `transport` y `clock` inyectados que demuestre que un fallo de auth
   **no** deja el cliente muerto, y que un error JSON-RPC transitorio en cuerpo 200 **sí** se
   reintenta mientras uno de validación no.
4. **Sync incremental**: editar `name` en una **plantilla** de Odoo y verificar que el delta lo capta
   (es el caso que el dominio ingenuo perdería); y que el cursor **no** avanza cuando hay fallos.
   Medir el delta en régimen y confirmar que cierra muy por debajo del intervalo.
5. **Aislamiento de jobs**: con ambos pollers corriendo, verificar que el de productos no reclama
   jobs de deals.
6. **Auto-confirmación**: deal de prueba a cierre ganado → `sale.order` confirmado, MO generada,
   número visible en la cotización. Probar también el camino de rechazo.
7. **Gate México**: un deal en el pipeline de Displays queda `SKIPPED` con `phase: 'plan.preflight'`
   **sin** producir `sale.order`; y en contraste, un deal en CVB con `pais_de_destino = MX` **sí**
   sincroniza — ese es el caso de exportación que no se puede romper.
8. **Regresión**: `npm test` y una corrida `--once` sin cambios inesperados en `productmappings`.

## Fechas comprometidas

| Fecha | Compromiso | Dueño |
|---|---|---|
| 2026-08-07 (vie) | Muestra de ~10 imágenes de producto | Smarteam + Visual Branding |
| 2026-08-07 (vie) | Base de datos / plantillas actualizadas | Gabriela |
| ~2026-08-06 (jue) | Confirmación de sesión para revisar el brief | Juan Carlos |
| — | Correo con homologación de cronograma | Lorena |

## Fuera del alcance de este repo (Juan Carlos)

- Plantillas de cotización: ~5 formatos según cliente (costos prorrateados dentro de la línea de
  producto vs. desglose detallado). Mismo cálculo, distinta presentación.
- Cálculo de costos en destino: vía propiedades en la cotización, basado en el Excel del cliente.
- Brief por producto desde transcripción: en pruebas, sesión pendiente de agendar.
