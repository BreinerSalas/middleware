# Arquitectura

> **Para qué sirve este documento.** Es el mapa de navegación del repo para agentes y
> personas nuevas: qué capa hace qué, dónde vive cada decisión, y **qué parte es motor
> reutilizable vs. qué parte es este caso concreto (HubSpot ↔ Odoo)**.
>
> Esa última distinción es el eje del documento, porque la intención declarada del
> proyecto es que el motor termine siendo un **toolkit** para arrancar integraciones
> similares (webhook → cola → transformación → upsert → write-back → reconciliación),
> no solo esta integración.
>
> Complementa al `README.md`, no lo repite: el README explica **cómo operar** (instalar,
> variables, endpoints, configurar HubSpot/Odoo). Este archivo explica **cómo está
> construido y dónde intervenir**. Donde ambos se contradigan, manda este: las secciones
> `## Arquitectura` y `## Estructura del proyecto` del README quedaron desactualizadas
> (describen `SyncDealUseCase.js`, `webhook.routes.js` y `HubspotApiClient`, que ya no
> existen).

---

## 1. El sistema en una frase

Un servicio Node/Fastify que mantiene sincronizados dos SaaS de terceros —
**HubSpot** (CRM, sistema de registro comercial) y **Odoo** (ERP, sistema de registro
productivo) — mediante una **cola persistente en MongoDB** con reintentos, dedupe,
auditoría y cursores incrementales.

Cuatro flujos conviven en el mismo proceso:

| Flujo | Disparo | Dirección | Entrada del código |
|---|---|---|---|
| **Deal → Sale Order** | Webhook de HubSpot (`deal.propertyChange` sobre `dealstage`) | HS → Odoo | `composition/dealSyncModule.js` |
| **Product sync** | Tick periódico | Odoo → HS | `composition/productSyncModule.js` |
| **Sale order status** | Tick periódico | Odoo → HS | `composition/saleOrderStatusSyncModule.js` |
| **MO retry** | Tick periódico | Odoo → HS | `composition/manufacturingOrderRetrySyncModule.js` |

Más dos superficies HTTP auxiliares: **panel** de administración (`/api/panel/*` +
estáticos) y **proxy firmado de imágenes** (`/media/products/:token/image`).

---

## 2. Capas y regla de dependencias

Arquitectura hexagonal (puertos y adaptadores) con una capa explícita de
**composición** que es donde se cablea todo.

```
                    ┌──────────────────────────────────────────┐
   HubSpot webhook  │  src/adapters/inbound/http/              │   ← entra el mundo
   Panel / Media  ──┤    routes + middlewares (Fastify)        │
                    └───────────────────┬──────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
                    │  src/composition/                        │   ← ensamblado + reglas
                    │    *Module.js, validators, provisioning  │      de negocio del caso
                    └───────────────────┬──────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
                    │  src/core/                               │   ← motor genérico
                    │    application/  (use-cases, JobPoller)  │      (sin HTTP, sin Mongo,
                    │    application/ports/  (contratos)       │       sin SDKs de terceros)
                    │    domain/       (entidades, políticas)  │
                    │    shared/       (utilidades puras)      │
                    └───────────────────┬──────────────────────┘
                                        │  (implementa los ports)
                    ┌───────────────────▼──────────────────────┐
                    │  src/adapters/outbound/                  │   ← sale al mundo
                    │    hubspot/  odoo/  mongo/               │
                    └──────────────────────────────────────────┘
```

**Regla de dependencias:** `core` no debe importar de `adapters` ni de `composition`.
Todo lo que `core` necesita del exterior llega **inyectado por constructor** y está
descrito en `src/core/application/ports/*.js`.

> ⚠️ Hoy hay **dos violaciones reales** de esa regla, documentadas en §11. No son
> accidentes invisibles: si vas a extraer el toolkit, son el primer trabajo.

**Estilo transversal:** CommonJS (`require`), `'use strict'`, sin TypeScript, sin
clases donde una *factory function* alcanza. La inyección de dependencias es manual y
explícita: cada `createXModule({...})` recibe sus colaboradores y expone
`_internals` para que los tests observen sin monkey-patching.

---

## 3. Índice de archivos

### 3.1 Arranque y configuración

| Archivo | Responsabilidad |
|---|---|
| `src/server.js` | **Punto de entrada.** Conecta Mongo, aprovisiona propiedades en HubSpot, construye los 4 módulos según flags, arranca los workers, levanta Fastify, maneja `SIGINT`/`SIGTERM`. Es el único lugar donde se decide *qué* corre. |
| `src/app.js` | Construye la instancia Fastify: content-type parser que preserva `rawBody` (necesario para el HMAC), middleware de correlación, ruta del webhook con su filtro de eventos, y registro condicional de panel/media/estáticos. |
| `src/config/index.js` | Carga `.env` y **normaliza todo el entorno a un objeto de config tipado por convención**. Falla rápido si faltan `MONGODB_URI`, `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_CLIENT_SECRET`. Todos los defaults viven aquí. |
| `src/config/constants.js` | Enums (`JOB_STATUS`, `JOB_KIND`, `SOURCES`, `ENTITIES`) **+ dos IDs literales del portal de HubSpot** (`DEAL_STAGE_CLOSED_WON_ID`, `DEAL_PIPELINE_COMMERCIAL_VISUAL_BRANDING`). |
| `src/lib/logger.js` | Winston con salida JSON de una línea. Los mensajes son claves punteadas y estables (`sale-order-status-sync.incremental.done`) — se usan para grepear logs en producción, **trátalos como contrato**. |

### 3.2 `src/core/domain/` — entidades y políticas puras

| Archivo | Contenido |
|---|---|
| `SyncJob.js` | Entidad de trabajo y su máquina de estados: `PENDING → PROCESSING → {COMPLETED, SKIPPED, RETRY_PENDING, DEAD_LETTER}`. Exporta `JOB_STATUS` y `TERMINAL_STATUSES`. |
| `SyncMapping.js` | Correspondencia `sourceId ↔ targetId/targetRef` + `payloadHash` + `metadata` libre. |
| `SyncAuditEntry.js` | Entrada de auditoría append-only. |
| `ProductMapping.js` | Correspondencia de productos (`odooId ↔ hsSku ↔ hubspotId`) con su propio ciclo de vida. |
| `RetryPolicy.js` | `isRetryableError`, `isPermanentHttpError`, `calculateNextRetry` (backoff exponencial con jitter), `shouldDeadLetter`. **Toda la política de reintentos está aquí, en funciones puras.** |
| `errors.js` | `AppError`, **`SkipSyncError`** (descarta el job sin reintentar → `SKIPPED`), **`TransientSyncError`** (reintentable). La distinción skip/transient/permanente es la decisión de diseño más importante del motor. |

### 3.3 `src/core/application/` — orquestación

| Archivo | Responsabilidad |
|---|---|
| `JobPoller.js` | Bucle genérico de trabajo: `setInterval` → reclama hasta `concurrency` jobs → los ejecuta serializados **por `sourceId`** vía mutex → recupera huérfanos al arrancar. Filtra por `kind`, así que un poller por flujo comparte la misma colección. Todo inyectable (`clock`, `setIntervalFn`) para tests deterministas. |
| `use-cases/EnqueueSyncJobUseCase.js` | Dedupe (fail-open: si el guard falla, encola igual) → crea el `SyncJob` → marca visto. |
| `use-cases/ProcessSyncJobUseCase.js` | **El pipeline central.** `fetchRecord → resolveReferences → validators → findBySourceId → target.upsert → mapping.upsert → writeBack → markCompleted`, con auditoría en cada paso y `handleError` que enruta hacia skip / retry / dead-letter. |
| `use-cases/PlanDealSyncUseCase.js` | Expande un deal en N jobs hijos (uno por cotización elegible, `sourceId = "<dealId>:q<quoteId>"`), o devuelve `mode: 'fallback'` para que el deal se procese como un único registro. |
| `ports/*.js` | **Los seis contratos del motor**, documentados en JSDoc y con las invariantes escritas: `JobRepositoryPort`, `MappingRepositoryPort`, `SourceGatewayPort`, `TargetGatewayPort`, `AuditTrailPort`, `DedupeGuardPort`. Empieza a leer por aquí si quieres entender el motor sin leer implementaciones. |

### 3.4 `src/core/shared/` — utilidades

| Archivo | Uso |
|---|---|
| `hash.js` | `buildDedupeKey({sourceId, rawPayload})`, `hashPayload` (detección de cambios). |
| `mutex.js` | `runSequentially(key, fn)` — serializa por clave en memoria. Evita dos jobs del mismo deal a la vez. |
| `rateLimiter.js` | Token bucket (`rps`, `burst`). Compartido por el cliente de Odoo y la ruta de media. |
| `echoGuard.js` | TTL cache que **suprime write-backs idénticos** para no crear bucles HubSpot↔Odoo. Cada flujo instancia el suyo con un TTL propio. |
| `mediaSignature.js` | Firma/verifica tokens HMAC de URLs de imagen. |
| `odooDate.js` | Parseo/formateo del formato de fecha de Odoo (`YYYY-MM-DD HH:mm:ss`, UTC). *Específico de Odoo pese a vivir en `shared`.* |

### 3.5 `src/adapters/inbound/http/`

| Archivo | Ruta / hook |
|---|---|
| `hubspotSignature.middleware.js` | Valida HMAC v3 de HubSpot (`method + url + rawBody + timestamp`) con ventana de tolerancia. En no-producción se relaja. |
| `correlation.middleware.js` | Propaga/genera `x-correlation-id`. |
| `health.routes.js` | `GET /health` — comprueba `readyState` de Mongo + ping real; 503 si está caído. |
| `panel.routes.js` | `GET/DELETE/POST /api/panel/*` (status, mappings, product-mappings, product-runs, logs, clear con `confirm` + cooldown de 30 s). |
| `panel.auth.middleware.js` | Token por header (`x-panel-token`). |
| `media.routes.js` | `GET /media/products/:token/image` — verifica token, rate-limita, lee de Odoo, hace sniffing de content-type por *magic bytes*, responde con `ETag`/`304`. Existe porque Odoo solo sirve el binario a peticiones autenticadas. |
| `src/panel/` | Frontend del panel: `index.html` + `static/panel.{js,css}`. Vanilla JS, sin build step. |

### 3.6 `src/adapters/outbound/hubspot/`

| Archivo | Responsabilidad |
|---|---|
| `hubspotApiClient.js` | Cliente HTTP crudo. **Aquí vive el manejo de 429** (`Retry-After` + reintentos) y el batch upsert de productos. Métodos por objeto: deals, quotes, line items, products, custom properties. |
| `HubspotSourceGateway.js` | Implementa `SourceGatewayPort`. `parseSourceId` (desdobla `"dealId:qQuoteId"`), `fetchRecord`, `resolveReferences` (asociaciones + line items, degradando a `[]` ante fallo), `writeBack` (traduce claves canónicas → nombres de propiedad configurables, con echo guard), `revertDealStage`, `isEligibleQuote` / `listEligibleQuotes`. |
| `HubspotProductGateway.js` | Upsert de productos por `hs_sku`, individual y en batch, con construcción de URL de imagen. |
| `hubspotHealthCheck.js` | Ping para el panel. |

### 3.7 `src/adapters/outbound/odoo/`

| Archivo | Responsabilidad |
|---|---|
| `odooApiClient.js` | JSON-RPC contra Odoo (`execute_kw`). **Dos modos: `stub` y `http`** — `stub` devuelve respuestas sintéticas para desarrollo local sin ERP. Clasifica errores por *nombre de excepción de Odoo* (`SessionExpiredException` → transitorio, `ValidationError` → fatal) porque Odoo devuelve errores RPC dentro de HTTP 200. Rate limiter propio, timeouts separados de lectura/escritura. |
| `OdooTargetGateway.js` | Implementa `TargetGatewayPort`. El archivo más grande del repo: resuelve `product_id` por SKU y luego por nombre, resuelve UoM, resuelve `country_expense` (desde la cotización o desde el país del partner), construye el payload, hace upsert de `sale.order`, confirma opcionalmente y busca la `mrp.production` resultante. |
| `dealToSaleOrderMapper.js` | **Función pura** deal/quote/line-items → payload de `sale.order`. Si quieres saber qué campo de HubSpot acaba en qué campo de Odoo, es aquí. |
| `operationCostsResolver.js` | Elige el `operation.costs` correcto para un país (match exacto DDP, fallback al id más bajo). |
| `productNameKey.js` | Normalización de nombres para el match por nombre. |
| `OdooProductSource.js` / `OdooSaleOrderSource.js` | Lectura paginada; `listChangedSince` es un **async generator** que pagina por `write_date`. |
| `odooHealthCheck.js` | Ping para el panel. |

### 3.8 `src/adapters/outbound/mongo/`

`connection.js` + un repositorio por agregado (`MongoJobRepository`,
`MongoMappingRepository`, `MongoDedupeGuard`, `MongoAuditTrail`,
`MongoProductMappingRepository`, `MongoProductSyncRunRepository`,
`MongoSyncCursorRepository`, `MongoPanelRepository`, `MongoProductPanelRepository`) +
`schemas/*.schema.js`.

Cada repositorio recibe su `model` por constructor (`{ model = JobModel }`), lo que
permite testear con modelos alternativos. Los repos convierten documentos Mongoose a
objetos planos vía un `toDomain(doc)` local — **el dominio nunca ve un documento
Mongoose**.

### 3.9 `src/composition/` — donde se cablea el caso concreto

| Archivo | Responsabilidad |
|---|---|
| `dealSyncModule.js` | Ensambla el flujo principal: repos + gateways + validators + los tres use cases + un `JobPoller` cuyo `processFn` decide entre plan (deal) y process (quote), con captura del fallo no-Skip para que ningún job se quede colgado en `PROCESSING`. |
| `validators.js` | Las reglas de negocio como funciones/factories: `createMustHaveDealStage`, `createMustBeInPipeline`, `mustHaveLineItems`, `createMustHaveOdooCustomerId`, `createMustHaveQuoteCountry`. Lanzan `SkipSyncError` (descartar) o `Error` con `transient: true` (reintentar). |
| `productSyncModule.js` | `runOnce` (full) y `runIncremental` (por cursor). Particiona con/sin SKU, batch para los que tienen SKU, individual para el resto, persiste mappings y registra el run. |
| `saleOrderStatusSyncModule.js` | `runIncremental`: recorre `sale.order` cambiadas, busca el mapping por `targetId`, escribe estado/facturación en HubSpot, y si `state === 'cancel'` limpia el número de MO y revierte la etapa del deal. |
| `manufacturingOrderRetrySyncModule.js` | `runOnce`: para mappings sin MO todavía, reintenta la búsqueda en Odoo y escribe el número cuando aparece. |
| `productSyncJobModule.js`<br>`saleOrderStatusSyncJobModule.js`<br>`manufacturingOrderRetrySyncJobModule.js` | **Los tres son el mismo patrón** de tick auto-reagendado: `ensureSeeded` → job semilla en `RETRY_PENDING` con `nextRetryAt = now + tick` → al procesar, ejecuta el módulo y en `finally` reagenda el siguiente. Un `JobPoller` con `concurrency: 1` y `kind` propio. |
| `provisionProperties.js` + `dealPropertyDefinitions.js` + `quotePropertyDefinitions.js` | **Auto-provisioning declarativo:** al arrancar, crea/actualiza las propiedades custom que el sistema necesita en HubSpot. Un despliegue nuevo no requiere configuración manual del portal. |

### 3.10 Alrededores

| Ruta | Qué es |
|---|---|
| `scripts/*.js` | Operaciones de una sola vez y backfills (`sync-products`, `sync-quote-country-options`, `backfill-product-no-sku`, `cancel-stale-mos`). Reutilizan `src/`, no duplican lógica. |
| `scripts/probes/*.js` | **Sondas de readiness** contra los sistemas reales; escriben JSON a `docs/testing/*.json`. Es cómo se verifica que un entorno está listo antes de tocar producción. |
| `docs/plan-*.md` | Planes de diseño por feature. Varios comentarios del código los citan por sección (`docs/plan-cambios-2026-08-05.md § Fase 3`) — **si cambias uno, revisa el otro**. |
| `docs/testing/*.tdd.md` | Evidencia TDD por feature (rojo → verde). |
| `test/` | Espeja la estructura de `src/`. Ver §9. |

---

## 4. Motor genérico vs. caso concreto

**Esta es la tabla que importa para el objetivo de toolkit.** Al abrir un archivo,
sitúalo aquí antes de editarlo.

| Zona | Estado | Contenido |
|---|---|---|
| `core/domain/{SyncJob, SyncMapping, SyncAuditEntry, RetryPolicy, errors}` | ✅ **Genérico** | Ni una mención a HubSpot u Odoo. Reutilizable tal cual. |
| `core/application/ports/*` | ✅ **Genérico** | Los contratos son la API del toolkit. |
| `core/application/JobPoller` | ✅ **Genérico** | Cola + concurrencia + mutex + watchdog. Reutilizable tal cual. |
| `core/application/use-cases/EnqueueSyncJobUseCase` | ✅ **Genérico** | — |
| `core/shared/{hash, mutex, rateLimiter, echoGuard}` | ✅ **Genérico** | — |
| `core/application/use-cases/ProcessSyncJobUseCase` | ⚠️ **Casi** | El pipeline es genérico; el `buildWriteBackPayload` **por defecto** devuelve `{ id_presupuesto_odoo }`. |
| `core/application/use-cases/PlanDealSyncUseCase` | ⚠️ **Acoplado** | Importa de `adapters/outbound/hubspot/` y de `composition/validators`. Modela "un deal se expande en N cotizaciones" — patrón general, implementación específica. |
| `core/shared/odooDate` | ⚠️ **Específico** | Formato de fecha de Odoo dentro de `shared`. |
| `config/constants` | ⚠️ **Mixto** | Enums genéricos + dos IDs literales de *este* portal de HubSpot. |
| `adapters/inbound/http/*` | 🔶 **Específico, patrón reutilizable** | El middleware de firma es de HubSpot, pero "verificar HMAC preservando rawBody" es el patrón. |
| `adapters/outbound/{hubspot,odoo}/*` | 🔶 **Específico por diseño** | Es lo que se reescribe por integración. El `stub`/`http` mode y el rate limiting son patrones a copiar. |
| `adapters/outbound/mongo/*` | 🔶 **Genérico en forma** | Los repos de Job/Mapping/Audit/Dedupe/Cursor sirven a cualquier integración; `ProductMapping`/`ProductSyncRun` son de este caso. |
| `composition/*` | 🔴 **Específico** | Es exactamente su función: es el archivo que escribes por integración. |

**Cómo leerlo:** hoy el toolkit *ya existe de hecho* en `core/` — con dos fugas
concretas. Y `composition/` es la prueba de que el motor se deja cablear: cuatro flujos
muy distintos (uno por webhook, tres por tick; uno bidireccional, tres unidireccionales)
se montan sobre las mismas piezas.

---

## 5. Flujo 1 — Deal → Sale Order (el principal)

```
HubSpot: deal pasa a "Cierre ganado"
   │
   ▼  POST /webhooks/hubspot  (array de eventos)
app.js
   ├─ hubspotSignature.middleware  → HMAC v3 + tolerancia de timestamp
   ├─ filtro estricto:  subscriptionType === 'deal.propertyChange'
   │                    && propertyName === 'dealstage'
   │                    && propertyValue ∈ config.deals.allowedStageIds
   └─ dealSyncModule.enqueueWebhook({ objectId, ... })
          │
          ▼  EnqueueSyncJobUseCase
        dedupeKey = hash(sourceId + rawPayload)
        ¿duplicado? → { deduped: true }        (fail-open si el guard falla)
        no          → SyncJob{ kind:'deal', status:PENDING }  →  Mongo
                                                            (202 Accepted)
──────────────────────── asíncrono, otro proceso lógico ────────────────────────
JobPoller (kind ∈ [deal, quote], concurrency = WORKER_CONCURRENCY)
   findClaimable  → findOneAndUpdate atómico: PENDING|RETRY_PENDING → PROCESSING, attempts++
   runSequentially(job.sourceId, …)   ← nunca dos jobs del mismo deal a la vez
   │
   ├── kind === 'deal'  →  PlanDealSyncUseCase
   │      fetchRecord(deal) → validators de etapa/pipeline
   │      listEligibleQuotes(deal)        (status elegible + país presente)
   │      ├─ eligible > 0 → encola un job 'quote' por cotización
   │      │                 sourceId = "<dealId>:q<quoteId>"
   │      │                 audita 'deal.expanded', markCompleted del padre
   │      └─ eligible = 0 → mode:'fallback'  →  sigue como si fuera un quote job
   │
   └── kind === 'quote'  →  ProcessSyncJobUseCase
          fetchRecord         → deal + quote desde HubSpot
          resolveReferences   → line items (+ asociaciones si es deal)
          validators          → SkipSyncError ⇒ SKIPPED (sin reintento)
          mappingRepository.findBySourceId
          OdooTargetGateway.upsert
             ├─ resolveProductIds: por default_code, luego por nombre normalizado
             ├─ resolveProductUoms
             ├─ resolveCountryExpense: desde el país de la cotización,
             │    o fallback al país del partner de Odoo
             ├─ mapDealToSaleOrder → payload (origin = "hs:<dealId>:q<quoteId>")
             ├─ upsertSalesOrder   (busca por `origin`; revive con action_draft
             │                      si el sale.order estaba cancelado)
             ├─ confirmSalesOrder  (si ODOO_AUTO_CONFIRM_QUOTES)
             └─ findManufacturingOrder (Odoo genera la MO al confirmar)
          mappingRepository.upsert  ← guarda targetId/targetRef/hash/metadata
          sourceGateway.writeBack   ← id_presupuesto_odoo + numero_orden_fabricacion
                                      (suprimido por echoGuard si es idéntico)
          markCompleted
```

**Ante error** → `ProcessSyncJobUseCase.handleError`:

| Error | Resultado |
|---|---|
| `SkipSyncError` | `SKIPPED`. Terminal, sin reintento. Es "esto no aplica", no "esto falló". |
| Reintentable (`RetryPolicy.isRetryableError`) y quedan intentos | `RETRY_PENDING` con `nextRetryAt` = backoff exponencial + jitter |
| No reintentable, o agotó `maxAttempts` | `DEAD_LETTER` |

`origin` en el `sale.order` es la clave de idempotencia del lado de Odoo: hace que el
upsert sea seguro aunque el mismo job corra dos veces.

---

## 6. Flujos 2–4 — los ticks

Los tres comparten forma. **Auto-reagendado en lugar de cron**: el propio job programa
el siguiente en su `finally`, así que un fallo no rompe la cadena y el estado del
scheduler vive en Mongo, no en memoria.

```
startWorker()
  └─ ensureSeeded(): ¿existe job activo de este kind? → si no, siembra uno
       job{ kind, sourceId: '<flujo>-loop', status: RETRY_PENDING,
            nextRetryAt: now + tickIntervalMs, maxAttempts: MAX_SAFE_INTEGER }
  └─ JobPoller.start()  (concurrency: 1, kind propio, orphanWatchdogMs propio)
        │
        ▼ cuando vence nextRetryAt
      try    → módulo.runIncremental() / runOnce()  → markCompleted
      catch  → markFailed (backoff, o dead-letter)
      finally→ scheduleNextTick()        ← la cadena nunca se corta
```

### Patrón de cursor incremental (flujos 2 y 3)

```
watermark = cursorRepo.get(key) ?? '1970-01-01 00:00:00'
for await (page of source.listChangedSince({ writeDateGte: watermark }))
     procesa cada fila; lleva maxSeenMs
si failed === 0:
     cursorRepo.set(key, format(maxSeenMs - overlapMs))    ← solapamiento deliberado
```

Dos decisiones que hay que respetar al modificar esto:

1. **El cursor solo avanza si `failed === 0`.** Un fallo transitorio reprocesa la
   ventana entera en el siguiente tick en lugar de perder registros.
2. **Se resta `overlapMs` (60 s por defecto).** Cubre el desfase de reloj y las
   escrituras concurrentes en el borde de la ventana. El reproceso es seguro porque
   todo el pipeline es idempotente.

### Particularidades por flujo

- **Product sync** (`productSyncModule`): particiona por SKU. Con SKU → batch upsert de
  HubSpot (100/chunk). Sin SKU → individual con `async.mapLimit`. Registra cada corrida
  en `ProductSyncRun` para el panel. Los productos `active: false` se cuentan como
  archivados y se omiten. Ojo: `name`/`list_price` viven en `product.template`, así que
  el filtro por `write_date` incluye un `OR` sobre `product_tmpl_id.write_date` — sin
  eso se pierden cambios silenciosamente.
- **Sale order status** (`saleOrderStatusSyncModule`): la única **bidireccionalidad
  real**. Escribe `state`/`invoice_status` en HubSpot y, cuando `state === 'cancel'`,
  limpia el número de MO y llama a `revertDealStage`. Ese revert tiene un corte
  anti-ping-pong: si la etapa actual ya no es "cierre ganado", no hace nada — sin ese
  corte cada tick reempujaría el deal a cierre ganado indefinidamente.
- **MO retry** (`manufacturingOrderRetrySyncModule`): Odoo crea la `mrp.production` de
  forma asíncrona al confirmar, así que el flujo principal a veces no la encuentra.
  Este tick reintenta sobre los mappings pendientes.

---

## 7. Modelo de datos (MongoDB)

| Colección | Schema | Rol |
|---|---|---|
| `jobs` | `job.schema.js` | Cola. Índices en `status`, `kind`, `nextRetryAt`, `dedupeKey`, compuesto `{status, nextRetryAt}`. **TTL de 30 días con `partialFilterExpression` sobre estados terminales** — la cola se autolimpia sin borrar trabajo vivo. |
| `mappings` | `mapping.schema.js` | `sourceId` único ↔ `targetId`/`targetRef`, `payloadHash`, `metadata` (Mixed: `countryExpense`, `confirmation`, `manufacturingOrder`, `lastJobId`). |
| `audits` | `audit.schema.js` | Auditoría append-only. Alimenta la pestaña de logs del panel. |
| `dedupes` | `dedupe.schema.js` | Claves de idempotencia con TTL corto. |
| `productmappings` | `productMapping.schema.js` | `odooId ↔ hsSku ↔ hubspotId`. |
| `productsyncruns` | `productSyncRun.schema.js` | Historial de corridas para el panel. |
| `synccursors` | `syncCursor.schema.js` | `key` único → `watermark` (string, formato de fecha de Odoo `YYYY-MM-DD HH:mm:ss` en UTC; valor inicial `1970-01-01 00:00:00`). |

`metadata` como `Schema.Types.Mixed` es intencional: permite que cada adaptador de
destino adjunte lo que necesite sin migraciones. La contrapartida es que su forma solo
está documentada en el JSDoc de `TargetGatewayPort`.

---

## 8. Configuración

`config/index.js` es la **única** puerta al entorno. Ningún otro archivo debe leer
`process.env`.

- **Requeridas:** `MONGODB_URI`, `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_CLIENT_SECRET`.
  Faltar alguna lanza `CONFIG_MISSING` en el arranque.
- **Nombres de propiedad de HubSpot** son todos configurables con default en español
  (`HS_PROPERTY_ODOO_CUSTOMER_ID` → `id_cliente_odoo`, etc.). Ese es el mecanismo que
  hace portable el gateway entre portales.
- **Flags de flujo:** cada tick se enciende con su `*_JOB_ENABLED` + su
  `*_TICK_INTERVAL_MS` + su `*_ORPHAN_WATCHDOG_MS`. Apagados por defecto: `server.js`
  no construye el módulo si el flag está en `false`.
- **`ODOO_CLIENT_MODE`**: `stub` (default) o `http`. En `stub` el cliente devuelve
  respuestas sintéticas, lo que permite correr el sistema completo sin ERP. Nota de
  diseño ya resuelta: en modo `stub` todo lookup de producto devuelve `{}`, así que
  `requireProductMatch` se activa **solo** en modo `http` — si no, cada corrida local
  terminaría en `SKIPPED`.

---

## 9. Tests

`npm test` (Vitest). `test/` espeja `src/`; `test/e2e/` usa `mongodb-memory-server` +
`supertest` contra la app real.

Umbrales de cobertura configurados en `vitest.config.js`: **líneas 80 %, statements
80 %, funciones 70 %, ramas 70 %.** Excluidos: `server.js`, `config/**`, `ports/**`,
`panel/static/**`, `mongo/connection.js`.

Cómo están escritos, y cómo escribir los nuevos:

- **Fakes en memoria, no mocks del framework.** Los ports existen precisamente para
  poder pasar un objeto literal con los métodos que hagan falta.
- **Tiempo inyectado.** `clock`, `setIntervalFn`, `now` son parámetros. Ningún test
  depende del reloj real.
- **`_internals`** en los módulos de composición permite afirmar sobre el cableado sin
  parchear `require`.
- Los archivos `*.hardening.test.js` / `*.branches.test.js` / `*.extra.test.js` cubren
  específicamente rutas de error y ramas raras.
- El flujo del repo es **TDD con evidencia**: el reproductor rojo se commitea antes del
  fix (ver el historial de git y `docs/testing/*.tdd.md`).

---

## 10. Dónde tocar qué

| Quiero… | Archivo(s) |
|---|---|
| Añadir una regla que descarte deals | `composition/validators.js` (lanza `SkipSyncError`), registrarla en `dealSyncModule.js` |
| Cambiar qué campo de HubSpot va a qué campo de Odoo | `adapters/outbound/odoo/dealToSaleOrderMapper.js` |
| Cambiar qué se escribe de vuelta en HubSpot | `composition/dealSyncModule.js` → `buildWriteBackPayload` + `HubspotSourceGateway.writeBack` |
| Añadir una propiedad custom de HubSpot | `composition/{deal,quote}PropertyDefinitions.js` (se aprovisiona sola al arrancar) |
| Añadir una llamada nueva a Odoo | `adapters/outbound/odoo/odooApiClient.js` — **impleméntala en los dos modos**, `stub` y `http` |
| Cambiar reintentos / backoff / dead-letter | `core/domain/RetryPolicy.js` |
| Cambiar la máquina de estados del job | `core/domain/SyncJob.js` + `schemas/job.schema.js` (el `enum` está en `config/constants.js`) |
| Añadir un flujo periódico nuevo | Copia un `*SyncJobModule.js`, añade el `kind` a `config/constants.js`, cablea en `server.js` |
| Añadir un endpoint | `adapters/inbound/http/`, registrar en `app.js` |
| Añadir un endpoint al panel | `panel.routes.js` + `MongoPanelRepository` + `src/panel/static/panel.js` |
| Añadir una variable de entorno | `config/index.js` (+ `.env.example`, + `docker-compose.yml` si aplica) |
| Verificar un entorno antes de tocar producción | `scripts/probes/*.js` |

---

## 11. Camino a toolkit

### 11.1 Lo que ya está bien

- Los **seis ports** con sus invariantes escritas son la API del toolkit. Están
  redactados en lenguaje neutral y sirven tal cual.
- `JobPoller` + `RetryPolicy` + `SyncJob` + `EnqueueSyncJobUseCase` forman una cola
  persistente con reintentos que no menciona a ningún proveedor.
- La **taxonomía de errores** (`SkipSyncError` / `TransientSyncError` / permanente) es
  la abstracción más valiosa del repo: separar "no aplica" de "falló temporalmente" de
  "falló para siempre" es lo que hace que la cola converja.
- **Modo `stub`** en el cliente del sistema destino: patrón a exigir en toda integración
  nueva.
- **Auto-provisioning declarativo** del esquema en el SaaS remoto: un despliegue nuevo
  no requiere clicks manuales.
- **Cursores con solapamiento y avance condicional** en `synccursors`: at-least-once sin
  perder registros.
- **`echoGuard`** por flujo: sin él, dos integraciones bidireccionales se retroalimentan.

### 11.2 Los cinco acoplamientos que hay que romper

Ordenados por lo que cuesta arreglarlos:

1. **`ProcessSyncJobUseCase.buildWriteBackPayload`** — el default (línea ~115) devuelve
   `{ id_presupuesto_odoo: … }`. `dealSyncModule` ya inyecta el suyo, así que el default
   es solo un fósil: hacerlo obligatorio (o devolver `{}`) saca la última mención al
   dominio del core. *Cambio de una línea.*
2. **`core/shared/odooDate.js`** — mover a `adapters/outbound/odoo/`. Nada más en `core`
   lo usa. *Mover archivo.*
3. **`config/constants.js`** — `DEAL_STAGE_CLOSED_WON_ID` y
   `DEAL_PIPELINE_COMMERCIAL_VISUAL_BRANDING` son IDs de un portal concreto quemados en
   el código. Ya existen como env (`HS_ALLOWED_STAGE_IDS`, `HS_ALLOWED_PIPELINE_IDS`)
   usando estos como fallback; el toolkit debería exigirlos y borrar los literales.
4. **Los tres `*SyncJobModule.js`** — ~90 líneas casi idénticas cada uno. Extraer
   `createTickJobModule({ kind, seedSourceId, run, tickIntervalMs, … })` los reduce a
   tres llamadas de cinco líneas, y ese factory pertenece a `core/application/`. *Es la
   pieza de toolkit más obvia que falta.*
5. **`PlanDealSyncUseCase`** — la violación real de la regla de dependencias: un use case
   de `core` importando `adapters/outbound/hubspot/HubspotSourceGateway` y
   `composition/validators`. El patrón que modela ("un registro padre se expande en N
   hijos") es general y merece existir en el toolkit como
   `ExpandParentIntoChildrenUseCase` con la partición inyectada. *Es el refactor más
   grande de los cinco.*

Además, en el terreno de la forma más que del acoplamiento: los modelos de Mongoose se
registran a nivel de módulo (`model('Job', JobSchema)`), un singleton global que obliga
a que los tests convivan con un registro compartido. Un toolkit querría factories de
modelo por conexión.

### 11.3 Checklist para una integración nueva

Reusar `core/` + `adapters/outbound/mongo/{Job,Mapping,Audit,Dedupe,SyncCursor}` y
escribir:

1. **Cliente del origen** y **cliente del destino** — HTTP crudo, rate limiting,
   clasificación de errores en transitorio/fatal, **y un modo `stub`**.
2. **`SourceGateway`** implementando `SourceGatewayPort`: `fetchRecord`,
   `resolveReferences`, `writeBack` (con echo guard y nombres de campo configurables).
3. **`TargetGateway`** implementando `TargetGatewayPort`: `upsert` con semántica
   create-o-update y una **clave de idempotencia en el lado remoto** (el equivalente al
   `origin` del `sale.order`).
4. **Mapper puro** registro-origen → payload-destino. Que sea una función pura es lo que
   hace testeable la parte que más cambia.
5. **Validators** que lancen `SkipSyncError` para "no aplica" y errores con
   `transient: true` para "reintenta".
6. **Definiciones de esquema remoto** para el auto-provisioning, si el SaaS lo permite.
7. **Un `xSyncModule.js`** que cablee todo lo anterior.
8. **Ruta inbound** (webhook con verificación de firma) y/o **tick job module**.
9. **Sondas de readiness** en `scripts/probes/` antes de apuntar a producción.
10. **Config** centralizada en `config/index.js`, sin `process.env` fuera de ahí.

**Caso de referencia — `partner-sync` (Odoo `res.partner` → HubSpot Contact):** cuarto
flujo de tick, construido siguiendo este checklist punto por punto sin tocar una sola
línea de los tres flujos existentes. `OdooPartnerSource` (1) + `HubspotContactGateway`
(3) + `partnerToContactMapper` puro (4) + `contactPropertyDefinitions` (6) +
`partnerSyncModule`/`partnerSyncJobModule` (7-8) + `scripts/probes/partner-sync.probe.js`
(9) + bloque `partnerSync` en `config/index.js` (10). Sin `SourceGateway`/`writeBack` (2):
es un flujo de una sola dirección, Odoo siempre gana. Apagado por defecto
(`PARTNER_SYNC_JOB_ENABLED=false`); antes de encenderlo en producción, correr la sonda con
`--dry-run --limit=N` y medir `countPartners()` (el volumen de partners puede superar
ampliamente al de productos). La duda sobre si `res.partner.type` usa `'contact'` o
`'private'` para las personas individuales (constante `PARTNER_CONTACT_TYPE` en
`odooApiClient.js`, aislada a propósito para ese ajuste) ya se confirmó en staging
(2026-08-12): de 400 partners escaneados, los 55 hijos (`parent_id` seteado) son todos
`'contact'`. Repetir el chequeo si producción corre otra versión/config de Odoo.

---

## 12. Trampas conocidas

Cosas que ya costaron una sesión de depuración y están resueltas — no las deshagas:

- **`rawBody`.** El content-type parser de `app.js` guarda el cuerpo crudo porque el HMAC
  de HubSpot se calcula sobre el string exacto. Reemplazar el parser rompe la firma.
- **`existingTargetId` se ignora deliberadamente** en `OdooTargetGateway.upsert`. Los
  mappings antiguos guardaban ids de `mrp.production`, no de `sale.order`; pasarlos a
  `updateSalesOrder` corrompería el sale order que casualmente comparta ese entero. El
  upsert resuelve por `origin`.
- **Errores RPC de Odoo llegan con HTTP 200.** Clasifica por nombre de excepción
  (`classifyOdooError`), no por status.
- **`product.template` vs `product.product`.** Filtrar por `write_date` solo en la
  variante pierde cambios de nombre y precio.
- **`revertDealStage` necesita su corte de "ya no está en cierre ganado"**, o entra en
  ping-pong infinito con el `sale.order` cancelado.
- **El cursor no avanza si hubo fallos.** No lo "optimices" a avanzar siempre.
- **Un `echoGuard` por flujo, con TTL propio** (ancho al intervalo del tick). Compartir
  uno entre flujos hace que un flujo suprima los write-backs de otro.
- **`PlanDealSyncUseCase` no re-lanza `SkipSyncError`** (ya llamó a `markSkipped`); el
  `catch` del `processFn` en `dealSyncModule` existe para que un fallo *no*-skip no deje
  el job colgado en `PROCESSING` para siempre — `findClaimable` solo reclama
  `PENDING`/`RETRY_PENDING`.
- **`productSyncModule.js` línea ~74** contiene un resto muerto
  (`sentMap.set(this ? null : null, p)`). No hace nada; si lo ves, es basura, no
  ingenio.
