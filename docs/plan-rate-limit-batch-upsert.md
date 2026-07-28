# Plan: Rate-limit fix + Batch upsert en product-sync (con retrofit a deal-sync)

**Fecha:** 2026-07-28
**Estado:** En ejecución con OpenCode (TDD)
**Project root:** `/home/kadejo/smarteamProjects/smartflow-middleware`

## Goal

Reemplazar el patrón actual de `async.mapLimit(products, 10, p => upsertBySku(p))` — que dispara 2N requests sin pacing y propaga 429 como `failed` permanente — por:

1. Un **token bucket global** dentro de `hubspotApiClient` que respeta los 100 req / 10 s de HubSpot y honra `Retry-After` automáticamente.
2. Un **batch upsert** (`POST /crm/v3/objects/products/batch/upsert`) que reduce ~11 700 requests a ~59 para 5848 productos.

Ambos cambios se aplican automáticamente al `deal-sync` (porque el bucket vive en el cliente HTTP compartido).

## Contexto

| | |
|---|---|
| **Stack del proyecto** | Node ≥20, Fastify 5, Mongoose 8, vitest 2, axios 1.7 |
| **Arquitectura** | Hexagonal — puertos en `src/core/application/ports/`, adaptadores en `src/adapters/outbound/` |
| **Adaptador HubSpot** | `src/adapters/outbound/hubspot/hubspotApiClient.js` (112 líneas) + `HubspotProductGateway.js` |
| **Composición product-sync** | `src/composition/productSyncModule.js` + `scripts/sync-products.js` |
| **Límites HubSpot Private Apps** | 100 req / 10 s por portal (≈10 RPS sostenidos), 250 000 / día; batch endpoints cuentan 1 request por batch |
| **Estado actual** | `concurrency=10` solo limita paralelismo; sin pacing global; sin retry en 429; productos sin SKU van por single create |
| **Tests** | 288 passing en 41 archivos, coverage ≥ 80% (lines), branches ≥ 70% |
| **Cambios se aplican con** | OpenCode + TDD workflow, no directamente acá |

## Asunciones explícitas

1. **El límite 100/10s es el piso confirmado por HubSpot.** No intentamos negociar más quota; simplemente respetamos lo publicado dejando margen (`rps: 9`, `burst: 15`).
2. **`hs_sku` es el `idProperty` único** para el batch upsert en el portal del cliente. Los productos sin `hs_sku` quedan excluidos del batch porque HubSpot requiere que `idProperty` exista en el schema y sea único dentro de la cuenta.
3. **El bucket es global al proceso**, no por fuente. Decisión conscious: HubSpot rate limit es por portal (token), no por endpoint.
4. **El retrofit a deal-sync es intencional y aceptable** porque reduce la latencia por job (los primeros 15 tokens absorben el burst de un poll), y `JobPoller` con `concurrency=3` × 4 calls/job ≈ 12 nunca excede el burst.
5. **`name` no es un `idProperty` válido** porque la unicidad no está garantizada. Por eso los productos sin `default_code` van por single create con concurrencia baja (3) en vez de batch.
6. **Tests existentes de `hubspotApiClient.test.js` se actualizan** para pasar `rateLimiter: null` (modo bypass) cuando no se quiere testear el bucket — así no se rompe la suite actual.

## Diagnóstico (por qué el método actual rompe los rate limits)

```
products.map(limit=10, p => {
    search by hs_sku    → 1 request
    create OR update    → 1 request
})
```

| Causa | Archivo:línea | Detalle |
|---|---|---|
| Sin limitador global (solo concurrencia) | `src/composition/productSyncModule.js:25` | `async.mapLimit(products, 10, ...)` solo limita paralelismo en vuelo. Sin espera entre requests → burst > 10 RPS |
| Sin respeto a `Retry-After` en 429 | `src/composition/productSyncModule.js:29-34` | 429 → error → `failed:true` → se abandona |
| 2N requests por producto | `src/adapters/outbound/hubspot/HubspotProductGateway.js:30-60` | 5848 productos → ~11 696 calls |
| Sin caché/persistencia de mapeo | (ausente) | Cada corrida repite las 5848 búsquedas |

Confirmado con HubSpot: ninguna cuenta tiene un rate limit más bajo que `100/10s`. El problema es nuestro método, no el límite.

## Cambios concretos

### 1. `src/core/shared/rateLimiter.js` (NEW)

Token bucket reutilizable, sin dependencias, clock inyectable para tests.

```
createRateLimiter({ rps = 9, burst = 15, clock = Date.now, setTimeoutFn = setTimeout } = {})
  → { take(), pause(ms), get tokens(), _drain() }
```

- Refill: `floor(elapsed / (1000/rps))` tokens
- Cola FIFO de resolvers para `take()`
- `pause(ms)` desplaza `lastRefill` para detener el refill durante backoff
- `clock` y `setTimeoutFn` inyectables → tests con `vi.useFakeTimers()`

### 2. `src/adapters/outbound/hubspot/hubspotApiClient.js`

- Importar `createRateLimiter`
- Crear instancia con `{ rps: 9, burst: 15 }` cuando no se inyecta `rateLimiter: null`
- **Wrapper HTTP único** `requestWithRateLimit(httpVerb, url, opts)`:
  - `await rateLimiter.take()` antes de cada llamada
  - Si respuesta 429: leer `Retry-After` (segundos) o `X-HubSpot-RateLimit-Reset-Milliseconds` (epoch ms), `rateLimiter.pause(ms)`, reintentar (máx 3 veces)
  - Si respuesta no-429: igualar el comportamiento actual (incluyendo `normalizeHubspotError`)
- **Refactorizar** `getDeal`, `getDealAssociations`, `getDealLineItems`, `updateDeal`, `searchProductByHsSku`, `createProduct`, `updateProduct` para usar el wrapper
- **Nuevo método** `batchUpsertProducts({ inputs, idProperty = 'hs_sku' })`:
  - `POST /crm/v3/objects/products/batch/upsert`
  - Body: `{ inputs: [...], idProperty }`
  - Devuelve `{ results: [...], errors: [...] }` (parsea el shape de HubSpot)
  - Pasa por el wrapper → hereda bucket + retry-on-429
- **Inyección opcional** de `rateLimiter` para tests (o `null` para bypass)

### 3. `src/adapters/outbound/hubspot/HubspotProductGateway.js`

- **Mantener** `upsertBySku` para los productos sin `hs_sku` (single-create)
- **Nuevo** `batchUpsertBySkus(odooProducts, { chunkSize = 100 } = {})`:
  - Filtra los que tienen `hs_sku`
  - Agrupa inputs: `{ idProperty: 'hs_sku', id: sku, properties }`
  - Llama `apiClient.batchUpsertProducts` por chunk (secuencial entre chunks; el bucket ya pacea los retries intra-chunk)
  - Maneja per-item errors del array de respuesta (`status: 'error'` por item)
  - Devuelve `{ chunkResults: [...], chunkStats: { created, updated, errors } }`
- `extractSku` / `buildProperties` se reusan tal cual

### 4. `src/composition/productSyncModule.js`

- `runOnce` ahora:
  1. Lee todos los productos de Odoo (igual)
  2. **Split** en `withSku` y `withoutSku`
  3. `withSku`: chunks de 100 → `gateway.batchUpsertBySkus(chunk)` (secuencial entre chunks)
  4. `withoutSku`: `async.mapLimit(items, 3, p => gateway.upsertBySku(p))` (concurrencia baja)
  5. Stats unificados: `created`, `updated`, `failed`, `skipped`
- **Logging nuevo**: `product-sync.batch.started { chunkSize, chunks }`, `product-sync.batch.completed { ... }`

### 5. Retrofit deal-sync (automático)

- `JobPoller` con `concurrency=3` × ~4 calls por job = hasta 12 calls simultáneas — los primeros 15 tokens los absorben, los siguientes esperan. **Cero cambios** en `JobPoller.js` o `dealSyncModule.js`.

## Test specification (garantías verificables)

| # | Garantía | Archivo de test | Tipo |
|---|---|---|---|
| 1 | `createRateLimiter()` arranca con `burst` tokens disponibles | `test/core/shared/rateLimiter.test.js` | unit |
| 2 | `take()` resuelve inmediatamente cuando hay tokens | mismo | unit |
| 3 | `take()` bloquea (resolve en el futuro) cuando no hay tokens | mismo | unit |
| 4 | Refill progresivo devuelve tokens a velocidad `rps` | mismo | unit |
| 5 | `pause(ms)` retrasa el refill durante la ventana | mismo | unit |
| 6 | Cola FIFO: resolvers se ejecutan en orden de llegada | mismo | unit |
| 7 | Wrapper HTTP toma un token antes de cada call | `test/adapters/hubspot/hubspotApiClient.test.js` | unit |
| 8 | 429 con `Retry-After: 2` causa reintento después de ~2s | mismo | unit |
| 9 | 3 retries consecutivos → throws con último error | mismo | unit |
| 10 | `batchUpsertProducts` arma body con `inputs[]` y `idProperty` | mismo | unit |
| 11 | `batchUpsertProducts` parsea `results` array de HubSpot | mismo | unit |
| 12 | `batchUpsertProducts` parsea `errors` por item (`status: 'error'`) | mismo | unit |
| 13 | `batchUpsertBySkus` divide array en chunks de 100 | `test/adapters/hubspot/HubspotProductGateway.test.js` | unit |
| 14 | `batchUpsertBySkus` omite items sin `hs_sku` | mismo | unit |
| 15 | `batchUpsertBySkus` asigna per-item errors a items específicos | mismo | unit |
| 16 | `productSyncModule.runOnce` con 250 productos dispara 3 batch calls | `test/composition/productSyncModule.test.js` | composition |
| 17 | `productSyncModule.runOnce` con `dryRun: true` hace 0 calls | mismo | composition |
| 18 | `productSyncModule.runOnce` continua cuando un chunk falla (errores por item) | mismo | composition |
| 19 | `JobPoller` con 5 jobs consecutivos bajo bucket pequeño → latencia extra | `test/application/JobPoller.test.js` | unit |

## Archivos a tocar

```
src/core/shared/rateLimiter.js                          [NEW]
src/adapters/outbound/hubspot/hubspotApiClient.js       [EDIT]  wrapper + batchUpsertProducts
src/adapters/outbound/hubspot/HubspotProductGateway.js  [EDIT]  batchUpsertBySkus
src/composition/productSyncModule.js                    [EDIT]  orchestrator split
test/core/shared/rateLimiter.test.js                    [NEW]
test/adapters/hubspot/hubspotApiClient.test.js          [EDIT]  +batch + 429 retry + bucket
test/adapters/hubspot/HubspotProductGateway.test.js     [EDIT]  +batchUpsertBySkus
test/composition/productSyncModule.test.js              [EDIT]  +batch flow
test/application/JobPoller.test.js                      [EDIT]  +retrofit bucket waits
docs/testing/rate-limit-batch-upsert.tdd.md             [NEW]
```

Estimación: ~400 LoC productivos + ~350 LoC de tests + docs.

## Riesgos & mitigaciones

| Riesgo | Mitigación |
|---|---|
| `idProperty` solo acepta propiedades del schema de Products | Documentar que `hs_sku` es la propiedad canónica; verificar al boot del gateway |
| Bucket inicial burst puede acelerar el burst inicial | Ajustar `burst: 15` (no `10`) deja headroom; tests usan fake timers para determinismo |
| Retry de batch completo en 429 re-procesa items exitosos | Idempotente: batch upsert con misma `idProperty` + `id` es upsert, no falla por duplicado |
| Tests existentes del `productSyncModule` asumen `upsertBySku` por item | Actualizar test factory: `makeGateway()` expone `batchUpsertBySkus` además de `upsertBySku` |
| Deal-sync jobs en cola al deploy pueden encontrar bucket "frío" | No es problema: bucket arranca lleno (`tokens = burst`), refil progresivo |
| `Retry-After` puede venir como segundos o epoch ms | Wrapper acepta ambos formatos (`parseRetryAfterMs` helper) |

## Verificación (post-implementación)

1. `npm test` — todos los tests verdes, sin bajar coverage
2. `npm run test:coverage` — todos los archivos nuevos ≥ 80% lines
3. **Smoke staging** (con `.env.staging`, dry-run):
   ```
   SMARTFLOW_ENV_FILE=.env.staging node scripts/sync-products.js --once --limit=250 --dry-run
   ```
   Esperado: log `product-sync.batch.started { chunkSize: 100, chunks: 3 }`, 0 calls HTTP reales
4. **Smoke real** (portal del cliente, write):
   ```
   SMARTFLOW_ENV_FILE=.env.client node scripts/sync-products.js --once --limit=10
   ```
   Esperado: 1 sola llamada batch (no 20 calls de search+update), headers `X-HubSpot-RateLimit-Remaining` no bajan de 95
5. Comparar tiempo total: 5848 productos deberían pasar de ~25 min (2N calls) a ~3-4 min (59 calls batch)

## Rollback

El feature es backwards-compatible:
- `rateLimiter: null` en el factory bypass el bucket (sin 429 retry, pero la lógica sigue funcionando).
- `batchUpsertBySkus` es opt-in: si no se llama, el módulo sigue usando `upsertBySku` por item.
- Deploy incremental: se puede mergear el bucket sin mergear el batch, y viceversa.

## Tareas (bite-sized, 2-5 min c/u)

**Hito 1 — Token bucket**
1. RED: `test/core/shared/rateLimiter.test.js` (6 tests) → archivo no existe → fail
2. GREEN: `src/core/shared/rateLimiter.js`
3. RED: tests de wrapper en `test/adapters/hubspot/hubspotApiClient.test.js` (3 nuevos: take-before-call, 429 retry, max retries)
4. GREEN: wrapper `requestWithRateLimit` + aplicar a métodos actuales
5. Commit + coverage check

**Hito 2 — Batch upsert**
6. RED: tests de `batchUpsertProducts` en `test/adapters/hubspot/hubspotApiClient.test.js` (3 nuevos)
7. GREEN: `batchUpsertProducts` en `hubspotApiClient.js`
8. RED: tests de `batchUpsertBySkus` en `test/adapters/hubspot/HubspotProductGateway.test.js` (3 nuevos)
9. GREEN: `batchUpsertBySkus` en `HubspotProductGateway.js`
10. RED: tests de `runOnce` split en `test/composition/productSyncModule.test.js` (3 nuevos / actualizados)
11. GREEN: refactor de `productSyncModule.runOnce`
12. Commit + coverage check

**Hito 3 — Retrofit deal-sync**
13. Validar: `npm test` sin cambios en `JobPoller` ya pasa (porque los tests no usan `httpClient` real)
14. Agregar test: "5 deals consecutivos con bucket pequeño → latency observable"
15. TDD evidence report + commit final
