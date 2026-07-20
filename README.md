# smartflow-middleware

Sincronización HubSpot ↔ Odoo de órdenes de fabricación (Fase 2). Construido con arquitectura hexagonal en JavaScript plano (CommonJS).

Cuando un Deal de HubSpot se marca como `closedwon`, este middleware recibe un webhook, consulta el deal completo, crea (o actualiza) una orden de fabricación en Odoo y escribe el ID de Odoo de vuelta en una propiedad del Deal para trazabilidad. Cola persistente con reintentos y dead-letter; idempotente en entrada; seguro ante reinicios.

Incluye un panel de administración/depuración (HTML + JS plano, sin paso de build) para inspeccionar la salud de las conexiones, los mapeos de sincronización y el log de auditoría.

---

## Arquitectura

```
                         ┌─────────────────────────────────┐
   HubSpot Workflow ───► │ POST /webhooks/hubspot          │
   (acción closedwon)    │  secreto compartido estático    │
                         │  (comparación timing-safe)      │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                     core/   (sin imports de frameworks)         │
   │                                                                  │
   │   domain/      SyncJob · SyncMapping · SyncAuditEntry ·         │
   │                RetryPolicy · errors (SkipSyncError, Transient)  │
   │                                                                  │
   │   application/ SyncDealUseCase (orquesta enqueue→process→       │
   │               writeback). ports/ = contratos JSDoc (sin runtime) │
   └──────────────────────────┬───────────────────────────────────────┘
                              │ usa puertos (JobRepository, MappingRepository,
                              │   AuditTrail, DealFetcher, OrderWriter,
                              │   DealWriter, Logger, Clock, HealthCheck,
                              │   PanelRepository, DedupeGuard, Mutex)
                              ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │          adapters/   (implementaciones enchufables)              │
   │                                                                  │
   │   inbound/http/   health.routes · webhook.routes · panel.routes │
   │   outbound/mongo/ MongoJobRepository · MongoMappingRepository · │
   │                    MongoAuditTrail · MongoDedupeGuard ·         │
   │                    MongoPanelRepository                         │
   │   outbound/hubspot/  HubspotApiClient (deal+writeback+health)   │
   │   outbound/odoo/     OdooApiClient stub+http + odooHealthCheck  │
   │   inbound/http/panel.auth.middleware (timing-safe, NODE_ENV)    │
   └──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │  MongoDB (persistencia)│
                  │  HubSpot API (REST)    │
                  │  Odoo (stub o JSON-RPC)│
                  └───────────────────────┘
```

Capas: `adapters → application → domain`. El dominio no conoce Fastify ni Mongoose; los adaptadores tampoco importan tipos cruzados. Los puertos son contratos JSDoc puros (0% runtime) — están excluidos del coverage.

---

## Stack

| Componente       | Versión | Propósito                              |
|------------------|---------|----------------------------------------|
| Node.js          | 20.x    | Runtime LTS                            |
| Fastify          | 5.x     | HTTP server + routing                  |
| @fastify/static  | 7.x     | Servir assets del panel (`/static/*`)  |
| Mongoose         | 8.x     | ODM Mongo (modelado mínimo, driver nativo) |
| Axios            | 1.x     | Cliente HTTP para HubSpot/Odoo          |
| Vitest           | 2.x     | Framework de testing (TDD)             |
| mongodb-memory-server | 10.x | Mongo efímero por test                |
| Docker / docker compose | - | Empaquetado y orquestación local     |

Sin TypeScript, sin ORM pesado, sin step de build. El código se ejecuta tal cual está en el repo.

---

## Inicio rápido

### Local (sin Docker)

```bash
# 1) Instalar dependencias
npm ci

# 2) Configurar entorno
cp .env.example .env
# editar .env y completar MONGODB_URI, HUBSPOT_ACCESS_TOKEN, WEBHOOK_SHARED_SECRET

# 3) Levantar Mongo (o apuntar MONGODB_URI a una instancia existente)
docker compose up -d mongo

# 4) Iniciar el servicio
npm start
# el servidor escucha en http://localhost:3007
```

### Docker Compose (todo-en-uno)

```bash
docker compose up --build
# servicio → http://localhost:3007
# Mongo  → mongodb://localhost:27017/smartflow (interno a la red de compose)
```

Probar que funciona:

```bash
curl -s http://localhost:3007/health
# {"status":"ok","uptime":...}

curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3007/
# 200  (devuelve el HTML del panel)
```

---

## Variables de entorno

### Requeridas (sin valor por defecto)

| Variable                  | Propósito                                                                 |
|---------------------------|---------------------------------------------------------------------------|
| `MONGODB_URI`             | Cadena de conexión Mongo (con DB incluida)                                |
| `HUBSPOT_ACCESS_TOKEN`    | Token de Private App de HubSpot (formato `pat-…`)                          |
| `WEBHOOK_SHARED_SECRET`   | Secreto estático compartido con HubSpot Workflow para validar webhooks   |
| `ODOO_API_KEY`            | Solo si `ODOO_CLIENT_MODE=http` — API key de Odoo                         |

### Opcionales (con defaults razonables)

| Variable                              | Default                              | Propósito                                                                  |
|---------------------------------------|--------------------------------------|----------------------------------------------------------------------------|
| `HUBSPOT_API_BASE`                    | `https://api.hubapi.com`             | Base de la API. Cambiar a `https://api.hubapi.eu` para portal europeo.     |
| `WEBHOOK_SHARED_SECRET_HEADER_NAME`   | `x-smartflow-secret`                 | Nombre del header donde HubSpot Workflow envía el secreto.                 |
| `HS_PROPERTY_ODOO_CUSTOMER_ID`       | `id_cliente_odoo`                    | Propiedad custom del Deal que guarda el ID de cliente Odoo.                |
| `HS_PROPERTY_ODOO_ORDER_ID`          | `id_orden_odoo`                      | Propiedad custom del Deal que guarda el ID de orden Odoo (writeback).      |
| `ODOO_CLIENT_MODE`                    | `stub`                               | `stub` (en memoria, para tests/dev) o `http` (real JSON-RPC).              |
| `ODOO_BASE_URL`                       | _(vacío)_                            | Requerida si `ODOO_CLIENT_MODE=http` (ej. `https://odoo.example.com`).     |
| `PORT`                                | `3007`                               | Puerto HTTP del servicio.                                                  |
| `NODE_ENV`                            | `development`                        | `production` activa fail-closed del panel si `PANEL_TOKEN` no está set.    |
| `LOG_LEVEL`                           | `info`                               | Nivel pino: `fatal`, `error`, `warn`, `info`, `debug`, `trace`.            |
| `WORKER_CONCURRENCY`                  | `3`                                  | Trabajos concurrentes del worker loop.                                     |
| `WORKER_POLL_INTERVAL_MS`             | `5000`                               | Cada cuánto el worker busca jobs pendientes.                              |
| `MAX_RETRY_ATTEMPTS`                  | `8`                                  | Máximo de reintentos antes de mover a dead-letter.                         |
| `RETRY_MAX_DELAY_MS`                  | `300000`                             | Techo del backoff exponencial (5 min).                                     |
| `PANEL_TOKEN`                         | _(vacío)_                            | Token de acceso al panel. **Si está vacío en `production` → 503**         |
| `PANEL_TOKEN_HEADER_NAME`             | `x-panel-token`                      | Nombre del header esperado para el token del panel.                        |

> **Importante**: el archivo `.env` está en `.gitignore`. No commitear secretos.

---

## API

### Healthcheck

```bash
GET /health
# 200 {"status":"ok","uptime":<segundos>}
```

Sirve también como readiness/liveness probe para Kubernetes.

### Webhook de HubSpot

```bash
POST /webhooks/hubspot
Headers:
  x-smartflow-secret: <WEBHOOK_SHARED_SECRET>
Body (ejemplo):
  {
    "subscriptionType": "deal.creation",
    "objectId": "12345"
  }
```

- **200** si el job se encoló correctamente (el procesamiento es asíncrono).
- **401** si falta o no coincide el secreto (chequeo timing-safe, sin leak de longitud).
- **400** si el payload no es válido.
- **422** si el deal existe pero está en estado no elegible (se loguea como `SKIPPED`).

El endpoint **siempre** responde 200 al job bien formado — la lógica de reintento vive en la cola persistente, no en el webhook.

### Panel de administración

Todas las rutas requieren el header `PANEL_TOKEN_HEADER_NAME: $PANEL_TOKEN`.

| Método | Ruta                          | Descripción                                                                          |
|--------|-------------------------------|--------------------------------------------------------------------------------------|
| GET    | `/`                           | Sirve `src/panel/index.html` (UI).                                                   |
| GET    | `/static/*`                   | Assets del panel (CSS, JS).                                                          |
| GET    | `/api/panel/status`           | Ping real a HubSpot + Odoo + counts (mappings/audits/jobs por status).               |
| GET    | `/api/panel/mappings`         | Lista paginada de `SyncMapping` (orden por `updatedAt desc`, búsqueda opcional `q`). |
| DELETE | `/api/panel/mappings/:id`     | Borrado individual.                                                                  |
| POST   | `/api/panel/mappings/clear-all` | Borrado masivo. **Requiere `confirm:true` en body. Cooldown 30 s entre invocaciones.** |
| GET    | `/api/panel/logs`             | Lista paginada de `SyncAuditEntry` (búsqueda opcional `q`).                          |
| GET    | `/api/panel/logs/:id`         | Detalle de una entrada de auditoría (incluye payload completo).                      |
| DELETE | `/api/panel/logs/:id`         | Borrado individual.                                                                  |
| POST   | `/api/panel/logs/clear-all`   | Borrado masivo (mismas reglas que mappings).                                         |
| GET    | `/api/panel/jobs`             | Lista paginada de `SyncJob` (búsqueda opcional `q`).                                |
| DELETE | `/api/panel/jobs/:id`         | Borrado individual.                                                                  |
| POST   | `/api/panel/jobs/clear-all`   | Borrado masivo.                                                                      |

Comportamiento de seguridad:

- `NODE_ENV=production` **y** `PANEL_TOKEN` vacío → **todas las rutas del panel devuelven 503 `panel_disabled`**.
- `NODE_ENV=production` con token seteado → 401 si header ausente/inválido (timing-safe).
- Otros entornos (dev/test) → fail-open: sin token, el panel es accesible (útil para CI).

---

## Configuración de HubSpot

### 1) Crear Private App

Settings → Integrations → **Private Apps** → **Create**. Dar los scopes:

- `crm.objects.deals.read` — leer deals
- `crm.objects.deals.write` — escribir `id_orden_odoo`
- `crm.schemas.deals.read` — leer propiedades custom

Copiar el token generado (empieza con `pat-…`) a `HUBSPOT_ACCESS_TOKEN`.

### 2) Crear las propiedades custom del Deal

Settings → Properties → **Deal properties** → Create property:

- `id_cliente_odoo` (texto)
- `id_orden_odoo` (texto)

Si tu portal usa nombres distintos, sobreescribir con `HS_PROPERTY_ODOO_CUSTOMER_ID` y `HS_PROPERTY_ODOO_ORDER_ID`.

### 3) Crear el Workflow

Trigger: **Deal property changed** = `dealstage is any of "Closed won"`.

Action: **Webhook** → POST a `https://<tu-host>/webhooks/hubspot` con el secreto estático en el header configurado (`x-smartflow-secret` por defecto). Body:

```json
{ "subscriptionType": "deal.creation", "objectId": "{{ deal.id }}" }
```

> **Nota EU**: si tu portal HubSpot es europeo, setear `HUBSPOT_API_BASE=https://api.hubapi.eu`. La detección automática de región **no** está implementada — hay que configurarla explícitamente.

---

## Configuración de Odoo

Por defecto el middleware arranca con `ODOO_CLIENT_MODE=stub`: las órdenes se simulan en memoria (útil para desarrollo local y CI sin instancia Odoo).

Para apuntar a un Odoo real:

```env
ODOO_CLIENT_MODE=http
ODOO_BASE_URL=https://odoo.example.com
ODOO_API_KEY=<key>
```

El adapter usa JSON-RPC contra `/jsonrpc` (`common.version` para healthcheck, `execute_kw` para crear/actualizar órdenes). El mapper `dealToManufacturingOrderMapper` convierte un Deal de HubSpot al shape de `mrp.production` — los mapeos de campos custom se hacen ahí, no en el adapter.

> **Aún no integrado contra un Odoo real** — el sandbox está pendiente. La interfaz `OdooApiClient` está diseñada para que cambiar `stub` → `http` no toque el dominio.

---

## Tests & TDD

```bash
npm test                  # corre toda la suite
npm run test:coverage     # con reporte de coverage
```

- **194 tests** distribuidos en 37 archivos.
- **Coverage** (thresholds enforced en `vitest.config.js`):

  | Métrica      | Umbral | Actual |
  |--------------|--------|--------|
  | Lines        | ≥ 80%  | 91.1%  |
  | Statements   | ≥ 80%  | 91.1%  |
  | Branches     | ≥ 70%  | 90.2%  |
  | Functions    | ≥ 70%  | 70.0%  |

- Excluidos del coverage: `src/server.js` (entrypoint), `src/config/**` (env-driven), `src/core/application/ports/**` (contratos JSDoc), `src/panel/static/**` y `src/panel/index.html` (assets servidos tal cual).

### Evidencia TDD

Cada checkpoint del plan deja un reporte en `docs/testing/`:

- `2026-07-20-plan-hubspot-odoo.tdd.md` — Fase 1 (sync completo HubSpot↔Odoo, 9 commits, 136 tests).
- `2026-07-20-plan-panel.tdd.md` — H8 panel admin (5 commits, 58 tests).

Cada reporte documenta ciclos RED → GREEN con archivos tocados, tests añadidos y resultados.

---

## Estructura del proyecto

```
smartflow-middleware/
├── src/
│   ├── core/
│   │   ├── domain/             # entidades puras (SyncJob, SyncMapping, SyncAuditEntry,
│   │   │                       #   RetryPolicy, errors)
│   │   └── application/        # use cases + ports (JSDoc contracts)
│   │       ├── SyncDealUseCase.js
│   │       └── ports/          # *.js con solo JSDoc (no runtime)
│   ├── adapters/
│   │   ├── inbound/http/       # health.routes, webhook.routes, panel.routes,
│   │   │                       #   panel.auth.middleware
│   │   ├── outbound/mongo/     # MongoJobRepository, MongoMappingRepository,
│   │   │                       #   MongoAuditTrail, MongoDedupeGuard,
│   │   │                       #   MongoPanelRepository, connection.js
│   │   ├── outbound/hubspot/   # HubspotApiClient, hubspotHealthCheck
│   │   └── outbound/odoo/      # OdooApiClient (stub+http), odooHealthCheck
│   ├── panel/
│   │   ├── index.html          # UI del panel (sin build step)
│   │   └── static/             # panel.css, panel.js
│   ├── config/                 # carga y valida env vars
│   ├── app.js                  # createApp(): Fastify instance con plugins
│   └── server.js               # entrypoint (listen)
├── test/
│   ├── unit/                   # tests por archivo de src/
│   ├── integration/            # composición entre adapters reales
│   ├── composition/            # use case end-to-end con mongo efímero
│   └── e2e/                    # HTTP + Mongo contra Fastify app real
├── docs/
│   ├── plan-hubspot-odoo.md
│   └── testing/
│       ├── 2026-07-20-plan-hubspot-odoo.tdd.md
│       └── 2026-07-20-plan-panel.tdd.md
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── vitest.config.js
└── package.json
```

---

## Notas operativas

- **Eco suprimido**: cuando el worker hace writeback a HubSpot, ignora webhooks de HubSpot que resulten de su propio writeback (compara `id_orden_odoo` antes/después). Sin esto, cada sync generaría un loop infinito.
- **Mutex por sourceId**: `shared.mutex` evita que dos workers procesen el mismo deal en paralelo. Garantía de orden dentro de un sourceId.
- **Recuperación de huérfanos**: al boot, jobs en `PROCESSING` por más de 30 min se devuelven a `PENDING` (`recoverOrphans`).
- **Backoff exponencial**: 1s → 2s → 4s → … → `RETRY_MAX_DELAY_MS`. Después de `MAX_RETRY_ATTEMPTS` intentos, el job pasa a `DEAD_LETTER` y deja de reintentarse (visible en el panel).
- **Sin reintento en errores lógicos**: `SkipSyncError` (ej. deal sin cliente) se loguea como `SKIPPED` y no se reencola. Errores transitorios (`Transient`) sí.

---

## Fuera de alcance

Lo siguiente **no** está implementado y queda como trabajo futuro:

- Apps públicas de HubSpot (OAuth flow, refresh tokens). Solo Private Apps por ahora.
- Soporte multi-tenant / multi-portal. Un token = un portal.
- Replica sets de Mongo. Funciona con standalone para el tamaño actual.
- Detección automática de región HubSpot (`api.hubapi.com` vs `api.hubapi.eu`) — ver nota en "Configuración de HubSpot".
- Replay desde el panel (la cola es persistente pero el panel solo expone **delete**, no replay).
- Sandbox de Odoo real: la interfaz está lista pero solo se probó con `stub`.
