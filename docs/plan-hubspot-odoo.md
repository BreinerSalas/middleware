# Plan: smartflow-middleware — HubSpot ↔ Odoo (Fase 2), arquitectura Onion/Hexagonal

**Source**: diagrama de arquitectura "HubSpot ↔ sistema destino" + requisitos adicionales + pivote arquitectónico del supervisor
**Repo**: `/home/kadejo/smarteamProjects/smartflow-middleware`
**Complexity**: Medium-High (sube de Medium por la capa de abstracción adicional, justificada explícitamente abajo)

## Context

El cliente necesita que, al cerrar un Negocio (Deal) en HubSpot como Ganado, se cree automáticamente una orden de fabricación en Odoo, con el ID escrito de vuelta en el Deal para trazabilidad. Esto es la "Fase 2" de una integración híbrida — la Fase 1 (sync base de contactos/empresas/productos) la resuelve un conector de marketplace ya existente, fuera de nuestro alcance. Sobre esto, el usuario pidió explícitamente dos cosas que el diagrama no cubre: un **sistema de retry** y una **base de datos**.

**Pivote de esta revisión**: el supervisor notó un patrón — hay otro proyecto en camino que necesita "casi lo mismo pero con ciertos cambios" (muy probablemente otro par CRM↔ERP, dado que el workspace ya tiene 3 integraciones hermanas del mismo tipo: `SmartFlow-Quickbooks`, `SmartFlow_Wherex`, `smartflow-hubspot-slack`, cada una reimplementando su propia cola de jobs, retry, mapeo de IDs y auditoría desde cero, con variaciones menores entre sí). Se pidió que este proyecto se construya con **arquitectura Onion**, separando las capas de negocio, para que sea reutilizable en ese próximo proyecto.

Se cargó la skill `ecc:hexagonal-architecture` de este entorno para fundamentar esto en un patrón ya soportado aquí en vez de inventar uno propio. Onion y Hexagonal (Ports & Adapters) son variantes del mismo principio — dependencias apuntan hacia adentro, el núcleo de negocio no importa frameworks — y la skill da la convención concreta que usa este entorno (`domain/`, `application/ports`, `application/use-cases`, `adapters/inbound`, `adapters/outbound`, `composition root`). Este plan la aplica tal cual, en vez de mezclar vocabularios.

**Por qué esto no es sobre-ingeniería**: la generalización no es especulativa — hay un segundo proyecto real y ya anunciado. Se traza la línea exactamente donde el propio patrón del workspace ya mostraba dolor (cada hermano reimplementa cola/retry/mapeo/auditoría) y se deja fuera cualquier cosa que no tenga una necesidad concreta hoy (sin monorepo con workspaces, sin publicar un paquete npm todavía — eso se hace *cuando* el segundo proyecto arranque, no antes).

Stack: **Fastify + MongoDB + Docker**, JavaScript plano (CommonJS) — sin TypeScript, igual que los 3 hermanos. Los "ports" en JS plano se documentan como contratos vía JSDoc (forma esperada de cada método) en vez de interfaces compiladas; el cumplimiento se verifica con duck-typing + tests de contrato, no con el compilador.

Decisiones ya confirmadas:
- **Un solo cliente**: credenciales por variables de entorno, sin modelo `Tenant`, sin `tenantId`.
- **Worker por polling** (no Change Streams): Mongo standalone, sin replica set.

## Scope

**Dentro de alcance**: los 4 pasos del diagrama (webhook → enriquecer → UPSERT en Odoo → escribir de vuelta en HubSpot) + retry + persistencia — organizados en un **núcleo genérico reutilizable** (`core/`) más **adaptadores específicos de esta integración** (`adapters/`).
**Fuera de alcance**: Fase 1 (marketplace connector). Tampoco se crea todavía un monorepo/paquete compartido — eso es trabajo del día en que el segundo proyecto arranque, no de este plan.

## La capa "core" — qué es genérico y por qué

`src/core/` no sabe qué es HubSpot ni qué es Odoo — solo sabe "hay un `SourceGateway` de donde leo un registro y a donde escribo de vuelta" y "hay un `TargetGateway` donde hago upsert." Todo lo que hoy vive en `core/` es exactamente lo que los 3 hermanos reimplementan cada vez:

| Pieza genérica (`core/`) | Reemplaza esto, hoy duplicado en cada hermano |
|---|---|
| `domain/SyncJob.js` — entidad con máquina de estados (`markProcessing/markCompleted/markSkipped/markFailed`) | el enum `JOB_STATUS` + los `if` dispersos en `job.service.js` de cada hermano |
| `domain/RetryPolicy.js` — `calculateNextRetry`, `isRetryableError` | `backoff.util.js`, ya sin dependencias — se reubica tal cual |
| `domain/SyncMapping.js` — `{sourceId, targetId, targetRef, payloadHash, lastSyncedAt, metadata}` | `entity_mapping.model.js` (hoy con campos `hsId`/`qbId` hardcodeados al nombre del sistema) |
| `domain/errors.js` — `SkipSyncError` | `SkipJobError` y sus subclases |
| `application/use-cases/EnqueueSyncJobUseCase.js` | `job.service.createJob` (dedup-check + persistir) |
| `application/use-cases/ProcessSyncJobUseCase.js` | la orquestación de 9 pasos que hoy vive mezclada dentro de `invoice.sync.service.js` |
| `application/JobPoller.js` — motor de polling genérico (concurrencia, mutex por `sourceId`, recuperación de huérfanos) | `tasks/worker.js` completo |
| `application/ports/*.js` — contratos (`JobRepositoryPort`, `MappingRepositoryPort`, `DedupeGuardPort`, `AuditTrailPort`, `SourceGatewayPort`, `TargetGatewayPort`) | nada — hoy no existen, las llamadas van directo a Mongoose/axios desde los services |
| `shared/mutex.js`, `shared/hash.js` | `mutex.util.js`, el hash sha256 embebido en `dedupe.service.js` |

**Lo que NO es genérico y vive en `src/adapters/`** (esto es lo que "el próximo proyecto" reescribe): `HubspotSourceGateway`, `OdooTargetGateway`, el mapper de payload Deal→Orden, las validaciones de negocio específicas ("debe tener line items", "debe tener `id_cliente_odoo`"), las rutas HTTP del webhook, y los esquemas Mongoose concretos.

Dirección de dependencias (regla dura, verificada en code review): `adapters → application → domain`. `domain/` y `application/` no importan `mongoose`, `fastify`, `axios` ni nada de `src/adapters/`.

## Riesgos abiertos (heredados del diagrama + el nuevo riesgo de abstracción)

| # | Riesgo | Mitigación |
|---|---|---|
| 1 | API de Odoo (endpoint/versión/auth, posible XML-RPC en vez de REST) sin confirmar | `OdooTargetGateway` es el único archivo que la conoce; modo `stub`/`http` por env var — el resto del sistema no espera a Odoo |
| 2 | Campos de negocio de la orden de fabricación sin confirmar | aislados en el mapper interno de `OdooTargetGateway` |
| 3 | Nombres de las properties custom de HubSpot sin confirmar | configurables por env var |
| 4 | Auth del webhook del Workflow (no es suscripción CRM, es una acción de Workflow — secreto estático, no HMAC) | middleware de secreto compartido, timing-safe; el payload nunca es fuente de verdad, siempre se relee el Deal |
| 5 | `id_cliente_odoo` vacío si Fase 1 no ha sincronizado aún | error reintentable (no `SkipSyncError`), backoff acotado |
| 6 | Los ports son contratos JS no compilados — un adapter puede desviarse silenciosamente de lo que el port espera | tests de contrato por adapter (ver Verificación) que corren la misma suite contra cualquier implementación del port |
| 7 | La capa extra de indirección (ports/composition root) tiene curva de aprendizaje si nadie más en el equipo conoce Hexagonal | mitigado por seguir la convención ya documentada en la skill `ecc:hexagonal-architecture` de este entorno, no un esquema inventado |

## Patrones mirroreados (de `SmartFlow-Quickbooks`, repo hermano en el mismo workspace)

Estructura (`app.js` sin `.listen()` + `server.js` bootstrap), esquema de cola de jobs con TTL parcial, fórmula de backoff (`2^attempts * 1000ms + jitter`), mutex en memoria por entidad, jerarquía de errores con un branch "skip limpio", config fail-fast, forma de orquestación de 9 pasos, logger Winston con `safeReplacer`, Dockerfile single-stage no-root, y stack de testing Vitest+supertest+mongodb-memory-server (de `SmartFlow_Wherex`/`smartflow-hubspot-slack`). Ver detalle de cada patrón en la sección correspondiente del diseño de implementación.

## Estructura de archivos

```
smartflow-middleware/
├── .env.example / .dockerignore / Dockerfile / docker-compose.yml / package.json
├── docs/plan-hubspot-odoo.md
├── src/
│   ├── core/                                     # ← NÚCLEO GENÉRICO — sin imports de mongoose/fastify/axios
│   │   ├── domain/
│   │   │   ├── SyncJob.js                        # entidad + máquina de estados
│   │   │   ├── SyncMapping.js
│   │   │   ├── SyncAuditEntry.js
│   │   │   ├── RetryPolicy.js                    # calculateNextRetry, isRetryableError
│   │   │   └── errors.js                         # SkipSyncError
│   │   ├── application/
│   │   │   ├── ports/
│   │   │   │   ├── JobRepositoryPort.js           # JSDoc: claim, findClaimable, markCompleted/Skipped/Failed, recoverOrphans
│   │   │   │   ├── MappingRepositoryPort.js        # findBySourceId, upsert
│   │   │   │   ├── DedupeGuardPort.js              # isDuplicate, markSeen
│   │   │   │   ├── AuditTrailPort.js               # record
│   │   │   │   ├── SourceGatewayPort.js            # fetchRecord, resolveReferences, writeBack
│   │   │   │   └── TargetGatewayPort.js            # upsert({existingTargetId, record, references})
│   │   │   ├── use-cases/
│   │   │   │   ├── EnqueueSyncJobUseCase.js
│   │   │   │   └── ProcessSyncJobUseCase.js        # la orquestación genérica de 9 pasos
│   │   │   └── JobPoller.js                        # motor de polling genérico
│   │   └── shared/
│   │       ├── mutex.js
│   │       └── hash.js
│   ├── adapters/                                 # ← TODO LO ESPECÍFICO DE ESTA INTEGRACIÓN
│   │   ├── outbound/
│   │   │   ├── mongo/
│   │   │   │   ├── schemas/ (job|mapping|dedupe|audit).schema.js
│   │   │   │   └── Mongo(Job|Mapping|Dedupe|Audit)Repository.js   # implementan los ports
│   │   │   ├── hubspot/
│   │   │   │   ├── hubspotApiClient.js            # axios wrapper delgado
│   │   │   │   └── HubspotSourceGateway.js         # implementa SourceGatewayPort
│   │   │   └── odoo/
│   │   │       ├── odooApiClient.js                # modo stub/http
│   │   │       ├── dealToManufacturingOrderMapper.js  # función pura
│   │   │       └── OdooTargetGateway.js            # implementa TargetGatewayPort
│   │   └── inbound/
│   │       ├── http/
│   │       │   ├── webhook.routes.js / webhook.controller.js
│   │       │   ├── health.routes.js
│   │       │   └── auth.middleware.js / correlation.middleware.js
│   │       └── worker/
│   │           └── syncWorker.js                   # arma el processFn y arranca JobPoller
│   ├── composition/
│   │   ├── dealSyncModule.js                       # COMPOSITION ROOT: instancia adapters, inyecta en use-cases
│   │   └── validators/
│   │       ├── mustHaveLineItems.js
│   │       └── mustHaveOdooCustomerId.js
│   ├── config/{index.js,constants.js}
│   ├── app.js                                      # Fastify + dealSyncModule.registerRoutes(app)
│   └── server.js                                   # connectDB → listen → dealSyncModule.startWorker()
└── test/
    ├── domain/          # sin mocks — reglas de negocio puras
    ├── application/     # use-cases con ports falsos (in-memory)
    ├── adapters/        # mongodb-memory-server + mocks de HTTP (HubSpot/Odoo)
    └── e2e/             # supertest sobre app.js completo
```

## El flujo, a través de los ports

1. **Webhook** (`adapters/inbound/http`) — `auth.middleware` valida secreto compartido → `webhook.controller` extrae `sourceId` (el `hs_object_id`) → llama `EnqueueSyncJobUseCase.execute({sourceId, correlationId, rawPayload})`.
2. **`EnqueueSyncJobUseCase`** — dedupe-check vía `DedupeGuardPort` → crea `SyncJob` (domain entity) → persiste vía `JobRepositoryPort`. Responde 200 de inmediato.
3. **`JobPoller`** (genérico) — cada ~5s reclama jobs `PENDING`/`RETRY_PENDING` vencidos vía `JobRepositoryPort.findClaimable`, respeta concurrencia, ejecuta bajo `mutex` por `sourceId`, llama `processFn` (que en `syncWorker.js` es `ProcessSyncJobUseCase.execute({jobId})`).
4. **`ProcessSyncJobUseCase`** (genérico, inyectado con adapters concretos de este proyecto vía composition root):
   `sourceGateway.fetchRecord(sourceId)` → `sourceGateway.resolveReferences(record)` → corre los `validators` inyectados (lanzan `SkipSyncError` o error reintentable) → `mappingRepository.findBySourceId(sourceId)` → `targetGateway.upsert({existingTargetId, record, references})` (Odoo: crea o actualiza; `dealToManufacturingOrderMapper` da forma al payload dentro del adapter, no en el use-case) → `mappingRepository.upsert(...)` → `sourceGateway.writeBack(sourceId, {[property]: targetId})` → `auditTrail.record(...)` en cada checkpoint → `jobRepository.markCompleted`.
5. Errores: `SkipSyncError` → `markSkipped` (no reintenta). Cualquier otro error → `retryPolicy.isRetryableError` decide `RETRY_PENDING` (con `nextRetryAt` de `calculateNextRetry`) vs `DEAD_LETTER` tras agotar intentos.

El mutex serializando por `sourceId` es lo que hace seguro el UPSERT: si dos jobs del mismo Deal corren casi simultáneos, el segundo — estrictamente después del primero — vuelve a leer el mapping y ve que ya existe, así que actualiza en vez de duplicar.

## Modelo de datos (adapters/outbound/mongo)

- **`jobs`**: `sourceId, correlationId, payload, dedupeKey, status(PENDING|PROCESSING|RETRY_PENDING|COMPLETED|SKIPPED|DEAD_LETTER), attempts, maxAttempts, nextRetryAt, lastError, lastErrorStack, completedAt`. Índices: `{status:1,nextRetryAt:1}`, TTL 30d sobre `completedAt` solo en estados cerrados.
- **`mappings`**: `sourceId(único), targetId, targetRef, payloadHash, lastSyncedAt, metadata` (aquí van `companyId/contactId/odooCustomerId`).
- **`dedupes`**: `dedupeKey(único)`, TTL 5min, fail-open ante error de consulta.
- **`audits`**: append-only, `sourceId, jobId, correlationId, event, detail, success, createdAt`, sin TTL.

## Variables de entorno

`MONGODB_URI`, `HUBSPOT_ACCESS_TOKEN`, `WEBHOOK_SHARED_SECRET` (+ `_HEADER_NAME`), `ODOO_BASE_URL`/`ODOO_API_KEY`/`ODOO_CLIENT_MODE` (stub|http), `HS_PROPERTY_ODOO_CUSTOMER_ID`/`HS_PROPERTY_ODOO_ORDER_ID`, `PORT`/`NODE_ENV`/`LOG_LEVEL`, `WORKER_CONCURRENCY`/`WORKER_POLL_INTERVAL_MS`, `MAX_RETRY_ATTEMPTS`(default 8)/`RETRY_MAX_DELAY_MS`.

## Docker

`Dockerfile` single-stage `node:24-alpine` no-root; `docker-compose.yml` con `app` + `mongodb` standalone (sin replica set, sin `mongo-init`).

## Orden de construcción

1. **`core/domain/`** — `SyncJob`, `SyncMapping`, `RetryPolicy`, `errors.js`. Tests puros, sin mocks.
2. **`core/application/ports/`** — solo los contratos JSDoc, sin implementación.
3. **`core/application/use-cases/`** + **`JobPoller`** — probados con ports falsos en memoria.
4. **Adapters de Mongo** — `schemas/` + los 4 repositorios, probados con `mongodb-memory-server`.
5. **`HubspotSourceGateway`** — de-riesga primero por ser la única API 100% confirmada.
6. **`OdooTargetGateway` en modo stub** — desbloquea todo lo demás sin credenciales reales.
7. **`composition/dealSyncModule.js`** — cablea todo; primer milestone end-to-end.
8. **Adapters inbound** (`http/`, `worker/`) + `app.js`/`server.js`.
9. **Endurecer UPSERT** — test explícito de que el reintento actualiza, no re-crea.
10. **Docker** — `docker compose up`, confirmar healthchecks.
11. **Cobertura hacia 80%** + docs.
12. *(Futuro, fuera de este plan)* — cuando arranque el segundo proyecto: copiar `src/core/` tal cual, escribir sus propios `adapters/` y `composition/`.

## Verificación

1. **Domain** (`test/domain/`): reglas puras, cero mocks.
2. **Application** (`test/application/`): `ProcessSyncJobUseCase` con ports falsos en memoria.
3. **Adapters** (`test/adapters/`): mismos tests de contrato corridos contra implementaciones reales (Mongo vía `mongodb-memory-server`, HubSpot/Odoo con HTTP mockeado).
4. **E2E** (`test/e2e/`): supertest sobre `app.js` completo.
5. `docker compose up` — confirmar healthchecks y `GET /health`.
6. **Smoke manual end-to-end** y **prueba de reintento/dead-letter**.
