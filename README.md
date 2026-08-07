# smartflow-middleware

Sincronización HubSpot ↔ Odoo de presupuestos (sale.order) que generan órdenes de fabricación (mrp.production) al ser confirmados. Construido con arquitectura hexagonal en JavaScript plano (CommonJS).

Cuando un Deal de HubSpot se marca como Cierre Ganado en el pipeline Comercial Visual Branding, este middleware recibe un webhook, consulta el deal completo, crea (o actualiza) un **presupuesto** en Odoo con su `country_expense` resuelto desde el país del cliente y escribe el nombre del presupuesto (`S06613`, etc.) en la propiedad `id_presupuesto_odoo` del Deal para trazabilidad. Un operador humano confirma el presupuesto en Odoo, que genera las órdenes de fabricación bien vinculadas. Cola persistente con reintentos y dead-letter; idempotente en entrada; seguro ante reinicios.

Incluye un panel de administración/depuración (HTML + JS plano, sin paso de build) para inspeccionar la salud de las conexiones, los mapeos de sincronización y el log de auditoría.

---

## Arquitectura

> 📐 El mapa detallado y actualizado del código —capas, índice de archivos, los cuatro
> flujos, modelo de datos, dónde tocar qué, y qué parte del motor es reutilizable como
> toolkit— está en **[ARQUITECTURA.md](ARQUITECTURA.md)**. El diagrama de abajo es un
> resumen histórico y no refleja los nombres de archivo actuales.

```
                         ┌─────────────────────────────────┐
   HubSpot Private App ─► │ POST /webhooks/hubspot          │
   (deal.propertyChange)  │  HMAC v3 (X-HubSpot-Signature- │
                         │   v3) sobre METHOD+URL+BODY+TS  │
                         │  body = array JSON de eventos   │
                         └────────────────┬────────────────┘
                                          │ (filtra: solo
                                          │  dealstage=closedwon)
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
   │                    hubspotSignature.middleware (HMAC v3)        │
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
# editar .env y completar MONGODB_URI, HUBSPOT_ACCESS_TOKEN, HUBSPOT_CLIENT_SECRET

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
| `HUBSPOT_CLIENT_SECRET`   | Client Secret de la Private App (pestaña "Auth"). Se usa para verificar la firma HMAC v3 de los webhooks entrantes. |
| `ODOO_API_KEY`            | Solo si `ODOO_CLIENT_MODE=http` — API key de Odoo                         |

### Opcionales (con defaults razonables)

| Variable                              | Default                              | Propósito                                                                  |
|---------------------------------------|--------------------------------------|----------------------------------------------------------------------------|
| `HUBSPOT_API_BASE`                    | `https://api.hubapi.com`             | Base de la API. Cambiar a `https://api.hubapi.eu` para portal europeo.     |
| `HUBSPOT_WEBHOOK_TS_TOLERANCE_MS`     | `300000`                             | Ventana de tolerancia del timestamp del webhook (replay protection).       |
| `HS_PROPERTY_ODOO_CUSTOMER_ID`       | `id_cliente_odoo`                    | Propiedad custom del Deal que guarda el ID de cliente Odoo.                |
| `HS_PROPERTY_ODOO_ORDER_ID`          | `id_orden_odoo`                      | Propiedad custom del Deal — **reservada** para un futuro backfill de la MO. El middleware ya no la escribe; ver `HS_PROPERTY_ODOO_QUOTE_ID`. |
| `HS_PROPERTY_ODOO_QUOTE_ID`          | `id_presupuesto_odoo`                | Propiedad custom del Deal que recibe el nombre del presupuesto (`sale.order.name`, ej. `S06613`) creado en Odoo. **Limitación:** los cambios de line items en HubSpot posteriores al primer sync NO se propagan al presupuesto; recrear manualmente en Odoo si hace falta. |
| `ODOO_CLIENT_MODE`                    | `stub`                               | `stub` (en memoria, para tests/dev) o `http` (real JSON-RPC).              |
| `ODOO_BASE_URL`                       | _(vacío)_                            | Requerida si `ODOO_CLIENT_MODE=http` (ej. `https://odoo.example.com`).     |
| `ODOO_DEFAULT_CUSTOMER_ID`            | _(vacío)_                            | `res.partner.id` usado como fallback cuando el deal no tiene `id_cliente_odoo`. Ver sección Odoo. |
| `PORT`                                | `3007`                               | Puerto HTTP del servicio.                                                  |
| `NODE_ENV`                            | `development`                        | `production` activa fail-closed del webhook si `HUBSPOT_CLIENT_SECRET` no está set. |
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
  X-HubSpot-Signature-v3: <base64(HMAC-SHA256(clientSecret, METHOD + URL + BODY + TIMESTAMP))>
  X-HubSpot-Request-Timestamp: <unix_ms>
Body (ejemplo):
  [
    {
      "subscriptionType": "deal.propertyChange",
      "objectId": "12345",
      "propertyName": "dealstage",
      "propertyValue": "closedwon"
    }
  ]
```

El middleware verifica la firma HMAC v3 (timing-safe, sin leak de longitud), aplica una ventana de tolerancia de timestamp de 5 minutos (replay protection), e itera el array de eventos. **Solo encola** cuando un evento cumple:

- `subscriptionType === "deal.propertyChange"`
- `propertyName === "dealstage"`
- `propertyValue === "closedwon"`
- `objectId` presente

Cualquier otro evento (`deal.creation`, `deal.deletion`, otros cambios de propiedad, otros stages) se descarta con `200 enqueued:0` para que HubSpot no entre en loop de retries.

Respuestas:

- **202** si encoló ≥1 job → `{ ok: true, enqueued: N, deduped, correlationId, jobId }`.
- **200** si la firma es válida pero el batch no tiene eventos elegibles → `{ ok: true, enqueued: 0 }`.
- **401** con `missing_signature` / `missing_timestamp` / `invalid_timestamp` / `timestamp_out_of_range` / `invalid_signature` si la auth falla.
- **500** con `webhook signature secret not configured` si `HUBSPOT_CLIENT_SECRET` está ausente y `NODE_ENV=production`.

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
- `crm.objects.deals.write` — escribir `id_presupuesto_odoo`
- `crm.schemas.deals.read` — leer propiedades custom

Copiar el token generado (empieza con `pat-…`) a `HUBSPOT_ACCESS_TOKEN`.

En la pestaña **Auth** de la misma Private App, copiar el **Client Secret** a `HUBSPOT_CLIENT_SECRET`. El Client Secret es distinto del access token y se usa **exclusivamente** para verificar la firma HMAC de los webhooks entrantes.

### 2) Suscribir webhooks de la Private App

En la misma Private App, sección **Webhooks subscriptions** → **Create subscription**:

- Event type: `deal.propertyChange` (necesario — `deal.creation` se ignora por diseño, ver sección API).
- Target URL: `https://<tu-host>/webhooks/hubspot`.

HubSpot enviará un `POST` a esa URL con:

```
X-HubSpot-Signature-v3: base64(HMAC-SHA256(clientSecret, "POST" + "/webhooks/hubspot" + body + timestamp))
X-HubSpot-Request-Timestamp: 1700000000000
Content-Type: application/json

[{ "subscriptionType": "deal.propertyChange", "objectId": "...", "propertyName": "dealstage", "propertyValue": "closedwon", ... }]
```

### 3) Crear las propiedades custom del Deal

Settings → Properties → **Deal properties** → Create property:

- `id_cliente_odoo` (texto) — **opcional si usás `ODOO_DEFAULT_CUSTOMER_ID`**
- `id_presupuesto_odoo` (texto) — writeback automático con el nombre del presupuesto (ej. `S06613`); `id_orden_odoo` queda reservado para un futuro backfill de la MO

Si tu portal usa nombres distintos, sobreescribir con `HS_PROPERTY_ODOO_CUSTOMER_ID` y `HS_PROPERTY_ODOO_ORDER_ID`.

> **Detección de estado `closed won`**: el middleware compara literal `propertyValue === "closedwon"` (sin guion bajo). Si tu portal usa otro internal value, ajustar en el validador `mustBeClosedWon` (`src/composition/validators.js`).

> **Single-tenant shortcut**: si todos tus deals van al mismo partner en Odoo, podés saltearte la creación de `id_cliente_odoo` y setear `ODOO_DEFAULT_CUSTOMER_ID=<partner_id>` en `.env`. Ver sección "Configuración de Odoo" abajo.

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

El adapter usa JSON-RPC contra `/jsonrpc` (`common.version` para healthcheck, `execute_kw` para crear/actualizar presupuestos y consultar costos). El mapper `dealToSaleOrderMapper` convierte un Deal de HubSpot al shape de `sale.order` con `country_expense` resuelto desde `res.partner.country_id` + `operation.costs` (política `DDP <País>` case/accent-insensitive, fallback al id más bajo con `metadata.countryExpense.ambiguous=true`).

El país del gasto se resuelve así: el middleware lee el `res.partner` del deal, obtiene su `country_id` (caminando `parent_id` si el contacto hijo no tiene país), busca entre los registros de `operation.costs` con ese país, y elige el que matchea exactamente `DDP <Country>`. Si no hay match, degrada a `status: 'unresolved'` con `reason: 'no_ddp_exact_match'` y crea el presupuesto sin el campo, agregando un marcador `[smartflow] País no resuelto` a la `note` para visibilidad en Odoo.

> **Aún no integrado contra un Odoo real** — el sandbox está pendiente. La interfaz `OdooApiClient` está diseñada para que cambiar `stub` → `http` no toque el dominio.

### Partner de Odoo: deal property vs env default

Por cada deal que se sincroniza, el middleware necesita el `partner_id` (cliente en `res.partner`) que se setea en el `sale.order` creado en Odoo. Hay dos formas de proveerlo:

| Modo | Configuración | Cuándo usar |
|---|---|---|
| **Por deal** | Crear la propiedad custom `id_cliente_odoo` en HubSpot y setearla por deal con el ID numérico del partner. | Multi-cliente: distintos deals van a distintos partners. |
| **Por entorno** | Setear `ODOO_DEFAULT_CUSTOMER_ID=42` en `.env` (un único partner global). | Single-tenant: todos los deals van al mismo partner (útil para demos y setups simples). |

El orden de resolución es: `references.odooCustomerId` (programático) → `record.properties.id_cliente_odoo` (deal property) → `cfg.odoo.defaultCustomerId` (env). El deal property siempre gana sobre el env default si ambos están seteados.

Si ninguno está configurado, el job falla con `MISSING_ODOO_CUSTOMER_ID` y termina en dead-letter tras los reintentos.

---

## Tests & TDD

```bash
npm test                  # corre toda la suite
npm run test:coverage     # con reporte de coverage
```

- **381 tests** distribuidos en 53 archivos.
- **Coverage** (thresholds enforced en `vitest.config.js`):

  | Métrica      | Umbral | Actual |
  |--------------|--------|--------|
  | Lines        | ≥ 80%  | 92.91% |
  | Statements   | ≥ 80%  | 92.91% |
  | Branches     | ≥ 70%  | 73.23% |
  | Functions    | ≥ 70%  | 86.15% |

- Excluidos del coverage: `src/server.js` (entrypoint), `src/config/**` (env-driven), `src/core/application/ports/**` (contratos JSDoc), `src/panel/static/**` y `src/panel/index.html` (assets servidos tal cual).

### Evidencia TDD

Cada checkpoint del plan deja un reporte en `docs/testing/`:

- `2026-07-20-plan-hubspot-odoo.tdd.md` — Fase 1 (sync completo HubSpot↔Odoo, 9 commits, 136 tests).
- `2026-07-20-plan-panel.tdd.md` — H8 panel admin (5 commits, 58 tests).
- `2026-07-28-plan-hubspot-private-app.tdd.md` — Adaptación a HubSpot Private App (HMAC v3 + array body, 5 commits, 27 tests).
- `2026-07-28-plan-odoo-default-customer.tdd.md` — Default customer por env (1 commit, 9 tests).
- `2026-07-31-quote-country-expense.tdd.md` — Sale.order + `country_expense` + Odoo genera la MO (49 tests; 517 totales). Plan: [`docs/plan-presupuesto-pais-y-mo.md`](docs/plan-presupuesto-pais-y-mo.md). Probes de staging: [`docs/testing/2026-07-31-probe-results.json`](docs/testing/2026-07-31-probe-results.json).

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
│   │   │                       #   panel.auth.middleware, hubspotSignature.middleware
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
│   ├── plan-hubspot-private-app.md
│   └── testing/
│       ├── 2026-07-20-plan-hubspot-odoo.tdd.md
│       ├── 2026-07-20-plan-panel.tdd.md
│       └── 2026-07-28-plan-hubspot-private-app.tdd.md
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── vitest.config.js
└── package.json
```

---

## Notas operativas

- **Eco suprimido**: cuando el worker hace writeback a HubSpot, ignora webhooks de HubSpot que resulten de su propio writeback (compara `id_presupuesto_odoo` antes/después). Sin esto, cada sync generaría un loop infinito.
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
