# TDD Evidence — Fase 3: Sync incremental y dueño del loop

**Source plan**: [docs/plan-cambios-2026-08-05.md § Fase 3](../plan-cambios-2026-08-05.md#fase-3--sync-incremental-y-dueño-del-loop--entregado-2026-08-05-vía-tdd)

Implementado como cinco ciclos RED/GREEN encadenados, cada uno con su propio par de commits en
`main`, en el orden que el usuario confirmó ("las tres piezas completas, en orden": aislamiento
de jobs → incrementalidad → dueño del loop — la incrementalidad terminó dividida en dos
sub-ciclos, listado + cursor, por tamaño).

## User journeys / guarantees covered

1. Como el middleware, quiero que un poller de productos y el poller de deals/quotes convivan
   en el mismo pipeline de jobs sin robarse trabajo entre sí, ni resucitar un job todavía
   corriendo bajo la ventana de watchdog equivocada.
2. Como el middleware, quiero listar solo los productos de Odoo que cambiaron desde la última
   corrida, incluyendo los que cambiaron por edición de la plantilla (`name`/`list_price`), no
   solo por edición de la variante.
3. Como el middleware, quiero que el cursor de sincronización avance únicamente cuando la
   pasada completó sin fallos, para que un fallo parcial no pierda productos en silencio.
4. Como operador, quiero que el sync continuo tenga un dueño (un job) que se auto-perpetúe sin
   necesitar un proceso externo, un endpoint HTTP nuevo, ni cablearlo directamente en
   `server.js` de forma incondicional.

## Task report

| Ciclo | Resumen de ejecución | RED | GREEN |
|---|---|---|---|
| 1. Aislamiento de kind | `findClaimable`/`recoverOrphans` ganan filtro por `kind`; `JobPoller` lo threadea; poller de deals/quotes acotado a `[DEAL, QUOTE]` | `8506f99` (5/5 fallando) | `bfdac52` (17/17 pasando) |
| 2. Listado incremental | `odooApiClient.searchProductsChangedSince` + `OdooProductSource.listChangedSince` (async generator); fix del bug de `limit` tras `break` | `972a28d` (7/7 fallando) | `971d3a1` (61/61 pasando) |
| 3. Cursor persistente | `MongoSyncCursorRepository`, helper `odooDate`, `productSyncModule.runIncremental` | `51cfbfe` (9/9 fallando — 2 archivos no cargaban) | `9e613fd` (703/703 suite completa) |
| 4. Dueño del loop | `MongoJobRepository.existsActive`, `cfg.productSync`, `productSyncJobModule` | `1a18386` (módulo inexistente) | `e4ddf25` (717/717 suite completa) |
| 5. Wiring en server.js | Construcción condicional detrás de `PRODUCT_SYNC_JOB_ENABLED` (default `false`) | — (glue de composición, sin test dedicado, igual que el resto de `server.js`) | `7faa9a1` (717/717 suite completa, `node -e "require('./src/server.js')"` confirma que carga sin errores de sintaxis) |

Cada ciclo confirmó la suite completa del repo sin regresiones antes del commit GREEN
correspondiente (671 → 673 → 679 → 686 → 703 → 717 tests, subiendo monótonamente).

## Test specification

| # | Qué garantiza | Test | Tipo | Resultado |
|---|---|---|---|---|
| 1 | `findClaimable({kind})` solo devuelve jobs de ese kind (string o array) | `MongoJobRepository.test.js:findClaimable only returns jobs matching a single kind filter` / `...accepts an array of kinds` | integración (Mongo real vía `mongodb-memory-server`) | PASS |
| 2 | Sin `kind`, el comportamiento es idéntico al de antes (retrocompatible) | `MongoJobRepository.test.js:findClaimable with no kind filter behaves as before` | integración | PASS |
| 3 | `recoverOrphans(now, watchdogMs, kind)` solo recupera huérfanos del kind dado | `MongoJobRepository.test.js:recoverOrphans only recovers jobs matching the given kind` | integración | PASS |
| 4 | `existsActive({kind})` distingue "hay un job activo de ese kind" sin reclamarlo | `MongoJobRepository.test.js:existsActive returns false/true...` (3 casos) | integración | PASS |
| 5 | `JobPoller` threadea `kind`/`orphanWatchdogMs` hacia el repo en cada tick y en `start()` | `JobPoller.test.js:passes its configured kind...` / `...orphanWatchdogMs...` | unit | PASS |
| 6 | `searchProductsChangedSince` construye `['&', default_code!=false, '|', write_date, tmpl.write_date]`, y omite el AND cuando `includeNoSku=true` | `odooApiClient.test.js:searchProductsChangedSince (...)` (3 casos) | unit | PASS |
| 7 | `listAll({limit})` respeta el límite incluso cuando la página final es más corta que `pageSize` (bug de `limit` tras `break`) | `OdooProductSource.test.js:listAll({limit:N}) still caps the result when the terminal page is shorter...` | unit | PASS |
| 8 | `listChangedSince` exige `writeDateGte`, pagina hasta una página corta/vacía, y pasa `includeNoSku` a través | `OdooProductSource.test.js:listChangedSince (...)` (3 casos) | unit | PASS |
| 9 | `MongoSyncCursorRepository.get/set` hacen upsert por `key`, sin colisión entre keys distintas | `MongoSyncCursorRepository.test.js` (4 casos) | integración (Mongo real) | PASS |
| 10 | `parseOdooDateUtc`/`formatOdooDateUtc` interpretan/emiten el string naive de Odoo como UTC, con padding correcto, y son inversos entre sí | `odooDate.test.js` (4 casos) | unit | PASS |
| 11 | `runIncremental` exige `cursorRepo`; arranca desde época 1970 si no hay cursor sembrado; pasa el watermark existente tal cual | `productSyncModule.incremental.test.js` (3 casos) | unit | PASS |
| 12 | `runIncremental` despacha con-SKU por batch y sin-SKU por single a través de múltiples páginas, igual que `runOnce` | `productSyncModule.incremental.test.js:dispatches with-SKU rows via batch...` | unit | PASS |
| 13 | El cursor avanza a `maxWriteDateVisto - overlapMs` **solo si `failed === 0`**; con algún fallo, no avanza | `productSyncModule.incremental.test.js:advances the cursor...` / `...does NOT advance...` | unit | PASS |
| 14 | Los productos con `active=false` se excluyen del sync y se cuentan aparte (`archived`) | `productSyncModule.incremental.test.js:excludes archived...` | unit | PASS |
| 15 | `runIncremental` persiste mappings y registra el run igual que `runOnce` (paridad, vía los helpers extraídos `persistMappings`/`syncSingleItems`) | `productSyncModule.incremental.test.js:persists mappings...` / `...starts and completes a run...` | unit | PASS |
| 16 | `cfg.productSync` viene deshabilitado por defecto (`jobEnabled=false`, tick 60s, watchdog 30min); las env vars lo sobreescriben | `config.test.js:productSync (...)` (3 casos) | unit | PASS |
| 17 | `processProductSyncJob` corre `runIncremental`, marca el job completado/fallido, y **siempre** siembra el siguiente tick (incluso tras un fallo catastrófico) | `productSyncJobModule.test.js` (7 casos, incluye dead-letter tras agotar `maxAttempts`) | unit | PASS |
| 18 | `ensureSeeded` solo siembra un job si no hay uno activo ya (evita loops paralelos duplicados) | `productSyncJobModule.test.js:ensureSeeded...` (2 casos) | unit | PASS |

## Coverage y brechas conocidas

`npx vitest run --coverage <archivos de esta fase>` sobre los archivos de producción tocados:

| Archivo | Líneas | Ramas | Funciones |
|---|---|---|---|
| `MongoJobRepository.js` | 100% | 63.88% | 100% |
| `MongoSyncCursorRepository.js` / `syncCursor.schema.js` | 100% | 100% | 100% |
| `OdooProductSource.js` | 100% | 88.88% | 100% |
| `odooApiClient.js` | 82.36% | 75.81% | 69.56% |
| `productSyncModule.js` | 93.56% | 81.01% | 91.66% |
| `productSyncJobModule.js` | 97.93% | 82.6% | 100% |
| `JobPoller.js` | 84.11% | 52% | 100% |
| `odooDate.js` | 100% | 85.71% | 100% |

El umbral global del proyecto (80%) no se cumple al correr solo estos archivos porque el
cálculo es sobre todo `src/`, igual que en la evidencia de Fase 2 — la corrida completa sin
`--coverage` (`npx vitest run`) confirma **717/717 pasando en 74 archivos**, sin regresiones.

**Fuera de alcance de este ciclo, documentado en el plan pero no implementado aquí**:

- Archivar en HubSpot los productos con `active=false` (hoy solo se excluyen del sync y se
  cuentan en `archived`; el borrado real en HubSpot requeriría `batch/archive` en
  `HubspotProductGateway`, no construido).
- La extensión del esquema de `ProductSyncRun` con `mode`/`watermarkFrom`/`watermarkTo`/
  `batchCalls`/`durationMs`/`failuresByReason` (sección "Observabilidad" del plan) — `runRepo`
  recibe hoy los mismos campos que `runOnce` (`created`/`updated`/`skipped`/`failed`/`status`).
- El job de reconciliación completa programado (semanal) que cace borrados duros — sigue
  siendo `scripts/sync-products.js --once` manual.
- `server.js` no tiene un test dedicado (no lo tenía tampoco antes de este cambio); la
  verificación de esa pieza fue `node -e "require('./src/server.js')"` (carga sin errores de
  sintaxis) más lectura manual, igual que el resto del composition root del archivo.
- Se detectó (no se corrigió, fuera de alcance) que `scripts/sync-products.js` y el nuevo
  wiring en `server.js` duplican la construcción de `OdooProductSource`/`HubspotProductGateway`;
  valdría la pena extraer un `buildProductSyncClients` compartido a `composition/` en una
  pasada de refactor futura.

## Merge evidence

Checkpoints en la rama `main`, en orden:

- `8506f99` — RED aislamiento de kind (5/5 fallando)
- `bfdac52` — GREEN aislamiento de kind (17/17 + regresión completa)
- `972a28d` — RED listado incremental (7/7 fallando)
- `971d3a1` — GREEN listado incremental (61/61 + regresión completa)
- `51cfbfe` — RED cursor persistente (9/9 fallando)
- `9e613fd` — GREEN cursor persistente (703/703 suite completa)
- `1a18386` — RED dueño del loop (módulo/config/método inexistentes)
- `e4ddf25` — GREEN dueño del loop (717/717 suite completa)
- `7faa9a1` — wiring en `server.js` detrás de `PRODUCT_SYNC_JOB_ENABLED=false` por defecto
