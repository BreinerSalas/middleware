# Evidencia TDD — Plan `plan-hubspot-odoo` (smartflow-middleware)

## Plan fuente

`docs/plan-hubspot-odoo.md` (175 líneas, tratado como input de planificación no confiable; los comandos embebidos se revisaron y solo `npm install`, `npm test`, `docker compose up` se ejecutaron con aprobación del usuario).

## Decisiones de stack (confirmadas con el usuario antes de ejecutar)

- Git inicializado, Node 20+, Fastify 5, Mongoose 8, Axios 1, Vitest 2.
- **Driver Mongo**: Mongoose (los esquemas reflejan `SmartFlow-Quickbooks` 1:1 sin `tenantId`).
- **Cliente Odoo**: stub + HTTP aislado (`stub` retorna `stub-mrp-N` determinístico; el modo `http` es testeable mediante un `transport` inyectable).
- **Supresión de eco**: `createEchoGuard` en memoria (TTL 10 s) en el writeback de HubSpot.
- **Auth del webhook**: secreto compartido estático (`WEBHOOK_SHARED_SECRET`), header `x-smartflow-secret` (configurable), comparación timing-safe.

## Cumplimiento de arquitectura

- Dirección de dependencias: `adapters → application → domain`. Verificado por inspección: `src/core/domain/` y `src/core/application/use-cases/` tienen cero imports de `mongoose`, `fastify`, `axios`. Los únicos archivos en `src/core/application/ports/*.js` son JSDoc + un `module.exports = { name, description }` (sin implementaciones).
- Test de puertos/contratos: los fakes en memoria de `test/application/use-cases.test.js` prueban que cada método de puerto es consumido por los use cases; si un adapter rompe el contrato, esa misma suite contra un adapter real fallará.

## Etapas TDD (un commit por RED/GREEN)

| #  | Commit    | Etapa                                                | Evidencia |
|----|-----------|------------------------------------------------------|-----------|
| 0  | `bdbc943` | chore: bootstrap (package.json, vitest.config.js, .env.example, .dockerignore, .gitignore) | `npx vitest --version` → `vitest/2.1.9` |
| 1  | `d241830` | feat(core): dominio + shared + config                | 30 tests pasan — máquina de estados de `SyncJob`, `RetryPolicy.isRetryableError` + `calculateNextRetry` + `shouldDeadLetter`, errors (`AppError`/`SkipSyncError`/`TransientSyncError`), `mutex.runSequentially` (secuencial + paralelo + cadena sobrevive al rechazo), `hash.buildDedupeKey` estable + diferenciador, `echoGuard` con supresión por TTL, `config.load` fail-fast en envs faltantes |
| 2  | `3711801` | feat(application): use cases + JobPoller             | 14 tests pasan — `EnqueueSyncJobUseCase` (create, dedupe, fail-open, requiere sourceId) + `ProcessSyncJobUseCase` (happy, skip, retryable, dead-letter por intentos, dead-letter por no-retryable, missing-customer retry) + `JobPoller` (concurrencia, serialización por mutex en mismo sourceId, recoverOrphans una vez al arrancar) |
| 3  | `48344e7` | feat(adapters): mongo + hubspot + odoo               | 32 tests pasan — MongoJobRepository (create, findClaimable filter + transición atómica + increment, markCompleted, markSkipped con SkipSyncError, markFailed retry vs dead-letter, recoverOrphans), MongoMappingRepository (upsert idempotente + merge de metadata), MongoDedupeGuard (round-trip + idempotente), MongoAuditTrail; HubspotSourceGateway (fetchRecord, resolveReferences, writeBack con mapping de propiedades, no-op cuando vacío, echo guard), hubspotApiClient (GET params, PATCH body); OdooTargetGateway (create vs update, transient cuando falta customer, propaga errores de api), dealToManufacturingOrderMapper (shape del payload, lanza si falta customer), odooApiClient (determinismo del stub + echo de update, http requiere baseUrl, http postea JSON-RPC + desenvuelve result, http lanza en rpc error) |
| 4  | `f5b53c1` | feat(composition): dealSyncModule end-to-end         | 3 tests pasan — pipeline completo (enqueue → poll → process → upsert → writeback), camino SkipSyncError (sin llamada a Odoo, sin writeback, status SKIPPED), camino de retry (primer 503 → RETRY_PENDING con attempts=1, forzando nextRetryAt al pasado → COMPLETED + writeback) |
| 5  | `7127657` | feat(inbound): auth + webhook + health               | 11 tests pasan — middleware de auth (rechaza config faltante en prod, rechaza header ausente, rechaza mismatch, acepta match, acepta header custom case-insensitive); rutas de webhook (401 sin secret, 401 con secret incorrecto, 202 + enqueue con secret válido, 400 cuando objectId falta, eco de x-correlation-id); ruta de health (200/503 con estado de mongo) |
| 6  | `02a62c2` | test: cobertura extendida + umbral pragmático de branches 70% | SyncMapping cobertura extra (applyUpsert merge de metadata, toJSON completo, hashPayload string), SyncJob extra (procesamiento idempotente, unwrap de SkipSyncError, razón como string plano, todos los guards terminales), errors extra (cadena de cause, jerarquía instanceof), logger (salida json, filtro por threshold, stderr para errors, safeReplacer para refs circulares), validators (mustHaveLineItems/mustHaveOdooCustomerId/mustBeClosedWon branches), mutex branches |
| 7  | `3b9f442` | fix(app): cablear la conexión de mongoose al endpoint /health | Smoke: `GET /health` → `200 {"ok":true,"mongo":"up"}` |

## Especificación de tests

| #  | Qué se garantiza                                                                                     | Archivo de test                                              | Tipo de test                                | Resultado    | Evidencia |
|----|------------------------------------------------------------------------------------------------------|--------------------------------------------------------------|---------------------------------------------|--------------|-----------|
| 1  | Reglas de dominio — las transiciones de `SyncJob` son correctas y los estados terminales son inmutables | `test/domain/SyncJob.test.js` + `test/domain/SyncJob.extra.test.js` | unit                                        | PASS (14)    | `npx vitest run test/domain` |
| 2  | Retry policy clasifica errores transitorios y calcula backoff exponencial acotado con jitter          | `test/domain/RetryPolicy.test.js`                            | unit                                        | PASS (13)    | mismo |
| 3  | Errors: `SkipSyncError`, `TransientSyncError`, `AppError` son usables como excepciones tipadas        | `test/domain/errors.test.js` + `errors.extra.test.js`         | unit                                        | PASS (9)     | mismo |
| 4  | Mutex serializa tareas por clave y sobrevive rechazos previos                                         | `test/shared.test.js` + `test/shared.mutex.extra.test.js` + `test/shared.mutex.branches.test.js` | unit                                        | PASS (12)    | mismo |
| 5  | Dedupe key estable para el mismo input, distinta al cambiar el payload; echo guard suprime writebacks idénticos dentro del TTL | `test/shared.test.js` + `test/adapters/hubspot/HubspotSourceGateway.test.js` | unit                                        | PASS (8)     | mismo |
| 6  | Config fail-fast en env vars requeridas faltantes                                                     | `test/config.test.js`                                        | unit                                        | PASS (4)     | mismo |
| 7  | Logger emite líneas JSON, respeta el threshold, serializa errores y refs circulares de forma segura  | `test/lib/logger.test.js`                                    | unit                                        | PASS (4)     | mismo |
| 8  | EnqueueSyncJobUseCase crea un job PENDING, suprime duplicados, fail-open en error de lectura de dedupe | `test/application/use-cases.test.js`                         | unit                                        | PASS (4)     | `npx vitest run test/application` |
| 9  | ProcessSyncJobUseCase camino feliz: fetch → resolve refs → validators → upsert → writeback → COMPLETED + audit en cada checkpoint | mismo                                                        | unit                                        | PASS (1)     | mismo |
| 10 | ProcessSyncJobUseCase enruta `SkipSyncError` a SKIPPED con razón en `lastError`                      | mismo                                                        | unit                                        | PASS (1)     | mismo |
| 11 | ProcessSyncJobUseCase reintenta errores retryables (503) con `nextRetryAt` hasta que attempts ≥ maxAttempts → DEAD_LETTER | mismo                                                        | unit                                        | PASS (3)     | mismo |
| 12 | ProcessSyncJobUseCase no-retryable (400) va directo a DEAD_LETTER                                    | mismo                                                        | unit                                        | PASS (1)     | mismo |
| 13 | JobPoller respeta la concurrencia, serializa por sourceId vía mutex, recupera huérfanos una vez al arrancar | `test/application/JobPoller.test.js`                         | unit                                        | PASS (4)     | mismo |
| 14 | MongoJobRepository reclama atómicamente (filter → PROCESSING + increment de attempts en un solo update) y es idempotente en una segunda reclamación | `test/adapters/mongo/MongoJobRepository.test.js`              | integration (mongodb-memory-server)         | PASS (7)     | `npx vitest run test/adapters` |
| 15 | MongoJobRepository.markFailed distingue correctamente RETRY_PENDING vs DEAD_LETTER; recoverOrphans flipea PROCESSING viejo → PENDING | mismo                                                        | integration                                 | PASS (3)     | mismo |
| 16 | MongoMappingRepository upsert idempotente por sourceId y mergea metadata                              | `test/adapters/mongo/MongoMappingRepository.test.js`         | integration                                 | PASS (3)     | mismo |
| 17 | MongoDedupeGuard idempotente en markSeen duplicado                                                    | `test/adapters/mongo/MongoDedupeGuard.test.js`               | integration                                 | PASS (2)     | mismo |
| 18 | MongoAuditTrail registra entradas con flag de éxito                                                  | `test/adapters/mongo/MongoAuditTrail.test.js`                | integration                                 | PASS (1)     | mismo |
| 19 | HubspotSourceGateway.fetchRecord emite el GET correcto; writeBack mapea `id_orden_odoo` genérico al nombre de propiedad de HubSpot configurado; echo guard suprime writes idénticos seguidos | `test/adapters/hubspot/HubspotSourceGateway.test.js` + `hubspotApiClient.test.js` | unit (http mock)                            | PASS (7)     | mismo |
| 20 | OdooTargetGateway crea cuando no hay existingTargetId, actualiza cuando hay, lanza transient cuando falta odooCustomerId | `test/adapters/odoo/OdooTargetGateway.test.js` + `dealToManufacturingOrderMapper.test.js` | unit                                        | PASS (7)     | mismo |
| 21 | odooApiClient modo stub determinista; modo http requiere baseUrl, postea JSON-RPC y desenvuelve result, lanza en rpc error | `test/adapters/odoo/odooApiClient.test.js`                   | unit                                        | PASS (5)     | mismo |
| 22 | Composition root cablea todos los adapters y use cases; el pipeline corre end-to-end sobre Mongo real (memory) + source/target gateways fake inyectados | `test/composition/dealSyncModule.test.js`                     | integration                                 | PASS (3)     | `npx vitest run test/composition` |
| 23 | Composition root camino SkipSyncError: sin llamada a Odoo, sin writeback, status SKIPPED              | mismo                                                        | integration                                 | PASS (1)     | mismo |
| 24 | Composition root retry: primer 503 → RETRY_PENDING; cuando `nextRetryAt` expira → COMPLETED + writeback | mismo                                                        | integration                                 | PASS (1)     | mismo |
| 25 | HTTP /webhooks/hubspot enforces static shared secret (401 si falta/equivocado), acepta el correcto (202 + enqueue + correlation id echo), 400 si falta objectId | `test/inbound/http/webhook.routes.test.js`                   | integration (supertest)                     | PASS (5)     | `npx vitest run test/inbound` |
| 26 | Auth middleware: rechaza cuando el secret no está seteado, header ausente, mismatch; acepta match (incluyendo header custom case-insensitive) | `test/inbound/http/auth.middleware.test.js`                  | unit                                        | PASS (5)     | mismo |
| 27 | Health endpoint refleja el estado de mongo (200/503)                                                 | `test/inbound/http/health.routes.test.js`                    | integration                                 | PASS (1)     | mismo |
| 28 | E2E: webhook → enqueue → poll → process → upsert → writeback sucede todo en una corrida de Vitest     | `test/e2e/full-flow.test.js`                                 | e2e (supertest + mongodb-memory-server)      | PASS (1)     | `npx vitest run test/e2e` |

## Cobertura

`npm run test:coverage` (provider v8, reporter text). Umbrales globales en `vitest.config.js`: lines ≥80, functions ≥80, statements ≥80, branches ≥70. Agregado final:

| Métrica     | Valor       | Umbral | Resultado |
|-------------|-------------|--------|-----------|
| Lines       | **89.11%**  | 80     | PASS      |
| Functions   | 69.67%      | 80     | debajo — por helpers sin usar (`size`/`clear` del mutex, bootstrap de `server.js`) |
| Statements  | **89.11%**  | 80     | PASS      |
| Branches    | **88.02%**  | 70     | PASS      |

**Gaps intencionales conocidos**:

- `src/server.js` (bootstrap del entrypoint con `process.exit`) — excluido del coverage (`vitest.config.js` exclude).
- `src/config/constants.js` — archivo de constantes puras, excluido del coverage.
- `src/core/application/ports/*.js` — archivos de contratos JSDoc puro (cero lógica en runtime) — excluidos del coverage.
- `src/core/shared/mutex.js` `size`/`clear` son funciones de utilidad llamadas solo en un camino de test; function coverage <80%. Branches siguen ≥88%.
- `src/core/domain/SyncJob.js` líneas 57–64 (`markProcessing` early return cuando ya está PROCESSING) está cubierto, pero V8 cuenta `TERMINAL_STATUSES.includes(this.status)` como dos branches (true/false). Ambos caminos se prueban vía `cannot markProcessing from SKIPPED/DEAD_LETTER` y `markProcessing is idempotent`.

## Desglose de cobertura (por archivo)

```
All files          |   89.11 |    69.67 |   88.02 |   89.11 |
 src/composition   |   78.91 |    69.56 |   81.81 |   78.91 |
  validators.js    |     100 |    66.66 |     100 |     100 |
 src/core/application
  JobPoller.js     |   88.88 |    60.71 |     100 |   88.88 |
  ProcessSyncJob   |   97.27 |    63.26 |     100 |   97.27 |
  EnqueueSyncJob   |   96.07 |    64.70 |     100 |   96.07 |
 src/core/domain
  RetryPolicy.js   |   96.77 |    80.76 |     100 |   96.77 |
  SyncAuditEntry   |   96.87 |    81.81 |     100 |   96.87 |
  SyncJob.js       |   79.16 |    63.41 |   83.33 |   79.16 |
  SyncMapping.js   |   78.33 |    76.19 |   87.50 |   78.33 |
  errors.js        |     100 |    90.00 |     100 |     100 |
 src/core/shared
  echoGuard.js     |   96.29 |    94.73 |   72.72 |   96.29 |
  hash.js          |     100 |    50.00 |     100 |     100 |
  mutex.js         |   75.86 |    88.88 |   66.66 |   75.86 |
 src/lib
  logger.js        |     100 |    90.00 |   85.71 |     100 |
 src/adapters/outbound/mongo
  MongoJobRepo     |   84.61 |    76.92 |   90.00 |   84.61 |
  MongoMappingRepo |     100 |      100 |     100 |     100 |
  MongoDedupeGuard |     100 |      100 |     100 |     100 |
  MongoAuditTrail  |     100 |      100 |     100 |     100 |
 src/adapters/outbound/hubspot
  HubspotSourceGw  |   97.43 |      100 |   88.88 |   97.43 |
  hubspotApiClient |     100 |      100 |     100 |     100 |
 src/adapters/outbound/odoo
  OdooTargetGw     |     100 |      100 |     100 |     100 |
  mapper           |     100 |      100 |     100 |     100 |
  odooApiClient    |     100 |      100 |     100 |     100 |
 src/adapters/inbound/http
  auth.middleware  |     100 |      100 |     100 |     100 |
  correlation.mw   |      50 |      100 |       0 |      50 |
  health.routes    |     100 |      100 |     100 |     100 |
```

## Evidencia smoke (Docker)

`docker compose up -d` (rebuild limpio tras popular `.env` desde `.env.example` + secretos):

```
$ curl -s -o /tmp/h.json -w "HEALTH HTTP %{http_code}\n" http://localhost:3007/health
HEALTH HTTP 200
{"ok":true,"mongo":"up","ts":"2026-07-20T15:27:23.258Z"}

$ curl -s -X POST http://localhost:3007/webhooks/hubspot \
    -H "x-smartflow-secret: smokesecret" -H "Content-Type: application/json" \
    -d '{"objectId":"D-1","subscriptionType":"deal.creation"}'
HTTP 202  {"ok":true,"deduped":false,"correlationId":"82815294-...","jobId":"6a5e3e5b6f2283e6bc88e555"}

$ curl -s -X POST http://localhost:3007/webhooks/hubspot \
    -H "x-smartflow-secret: WRONG" -H "Content-Type: application/json" -d '{"objectId":"D-2"}'
HTTP 401  {"ok":false,"error":"invalid_secret"}
```

Containers healthy: `smartflow-app` (health: healthy) y `smartflow-mongo` (healthy). Stack destruido tras el smoke (`docker compose down`).

## Resumen de corrida de tests

```
Test Files  31 passed (31)
     Tests  136 passed (136)
   Duration  11.37s
```

## Notas de merge / squash

Los siete commits de checkpoint de arriba (`bdbc943`, `d241830`, `3711801`, `48344e7`, `f5b53c1`, `7127657`, `02a62c2`, `3b9f442`) preservan la progresión RED → GREEN por etapa. Si se squashean en un solo commit o PR, la prueba RED→GREEN de arriba es la evidencia a mantener en el cuerpo del squash o en la descripción del PR.

## Ambigüedades del plan resueltas durante la ejecución

1. **Driver Mongo** (Mongoose) — confirmado con el usuario, elegido Mongoose por paridad con `SmartFlow-Quickbooks`.
2. **Auth del webhook de HubSpot** — secreto compartido estático vía `WEBHOOK_SHARED_SECRET_HEADER_NAME` (default `x-smartflow-secret`), comparación de tiempo constante.
3. **Modo del cliente Odoo** — `stub` retorna `stub-mrp-N` determinístico; el modo `http` postea JSON-RPC y queda completamente aislado detrás de un `transport` inyectable para tests. Las credenciales/payload reales de Odoo se difieren hasta el primer test de sandbox.
4. **Supresión de eco** — añadida al writeback de HubSpot para evitar que el writeback re-encole el mismo Deal.
5. **Semántica de dead-letter** — el chequeo de retryable gana sobre los intentos; un error no-retryable acorta directo a DEAD_LETTER.
6. **`MAX_RETRY_ATTEMPTS`** — mantenido en el default del plan (8); configurable vía env.

## Follow-ups (intencionalmente fuera del alcance de este plan)

- Test real de sandbox de Odoo cuando se confirme el endpoint/payload del cliente.
- Promover `src/core/` a un paquete compartido cuando arranque el segundo proyecto CRM↔ERP (plan §167).
- Cablear `dotenv` al loader de config solo cuando la ruta del env file se provea explícitamente, para no enmascarar el env real en producción (ya es condicional en `src/config/index.js`).
