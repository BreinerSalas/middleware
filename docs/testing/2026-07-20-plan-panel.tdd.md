# TDD Evidence — Plan `panel-admin` (smartflow-middleware)

## Source

Continuation of `docs/plan-hubspot-odoo.md` (smartflow-middleware). The user requested an admin/debug panel modeled on an existing Asana integration panel (connection cards + sync table + log table).

## User decisions (confirmed before implementation)

- **Stack**: HTML/JS plano estático (sin build step).
- **Auth**: token dedicado vía header `x-panel-token` (configurable via `PANEL_TOKEN_HEADER_NAME`). Fail-closed en prod si no se configura.
- **Acciones destructivas**: DELETE por ID + `POST /clear` con `confirm:true` en el body, más cooldown de 30 s para evitar dobles clear.
- **Chequeo en vivo**: ping real a HubSpot (`GET /crm/v3/objects/deals?limit=1`) y a Odoo (JSON-RPC `common.version`). En modo stub, Odoo se reporta como `STUB` (no se llama).

## Architecture compliance

- Sigue la arquitectura hexagonal: `MongoPanelRepository` es adapter (outbound/mongo); las rutas son adapter (inbound/http); `panel.auth.middleware` es adapter (inbound/http). El core (`src/core/`) no se tocó.
- `app.js` solo añade `if (config.panel) { app.register(createPanelRoutes, ...) }` y un handler `GET /` que sirve `index.html` directamente. Ningún cambio a la lógica existente.
- `server.js` pasa `path.resolve(__dirname, 'panel')` como `staticRoot` para que `@fastify/static` sirva `panel.css` y `panel.js` bajo `/static/`.

## TDD stages (RED → GREEN por hito, un commit por hito cuando fue posible)

| Hito | Contenido | Tests añadidos | Resultado |
|------|-----------|---------------|-----------|
| H8.0 | `MongoPanelRepository` (queries + deletes + counts) | 19 | PASS |
| H8.1 | `hubspotHealthCheck` + `odooHealthCheck` (HTTP mocks) | 9 | PASS |
| H8.2 | `panel.auth.middleware` + config `PANEL_TOKEN` | 8 (auth) + 1 (config) | PASS |
| H8.3 | `panel.routes.js` (supertest contra app in-memory) | 17 | PASS |
| H8.4 | `src/panel/{index.html, static/panel.css, static/panel.js}` | sin tests unitarios | cubierto por H8.5 |
| H8.5 | E2E con `createApp({ staticRoot })` | 5 | PASS |

Total tests después del panel: **194** (subió desde 136 → +58). Total archivos de test: **37**.

## Test specification

| # | What is guaranteed | Test file | Test type | Result |
|---|--------------------|-----------|-----------|--------|
| 1 | `MongoPanelRepository.listMappings` retorna vacío cuando no hay mappings | `test/adapters/mongo/MongoPanelRepository.test.js` | integration (mongodb-memory-server) | PASS |
| 2 | Mappings se ordenan por `updatedAt` desc | mismo | integration | PASS |
| 3 | Paginación con `page`/`pageSize` correcta | mismo | integration | PASS |
| 4 | Filtro `q` busca en `sourceId` y `targetId` (case-insensitive, regex-escaped) | mismo | integration | PASS |
| 5 | `deleteMapping` retorna `false` si id no existe | mismo | integration | PASS |
| 6 | `clearMappings` borra todo y retorna el conteo | mismo | integration | PASS |
| 7 | `listLogs` ordena por `createdAt` desc | mismo | integration | PASS |
| 8 | `listLogs` filtra por `event`, `success`, `sourceId` | mismo | integration | PASS |
| 9 | `getLogById` retorna `null` si no existe | mismo | integration | PASS |
| 10 | `getCounts` retorna counts de mappings, audits y jobs agrupados por status | mismo | integration | PASS |
| 11 | `hubspotHealthCheck` reporta `up=true` en 2xx con `latencyMs` | `test/adapters/hubspot/hubspotHealthCheck.test.js` | unit (http mock) | PASS |
| 12 | `hubspotHealthCheck` reporta `up=false` con `status` en no-2xx | mismo | unit | PASS |
| 13 | `hubspotHealthCheck` reporta error en timeout/ECONNABORTED | mismo | unit | PASS |
| 14 | `odooHealthCheck` parsea `server_version` de la respuesta JSON-RPC | `test/adapters/odoo/odooHealthCheck.test.js` | unit | PASS |
| 15 | `odooHealthCheck` reporta `up=false` en RPC error | mismo | unit | PASS |
| 16 | `odooHealthCheck` modo stub retorna `note` sin llamada remota | mismo | unit | PASS |
| 17 | `panel.auth.middleware` rechaza con 503 `panel_disabled` en prod sin token | `test/inbound/http/panel.auth.middleware.test.js` | unit | PASS |
| 18 | `panel.auth.middleware` permite todo en dev/test sin token | mismo | unit | PASS |
| 19 | `panel.auth.middleware` rechaza 401 con header faltante o mismatch | mismo | unit | PASS |
| 20 | `panel.auth.middleware` usa `crypto.timingSafeEqual` (length-leak safe) | mismo | unit | PASS |
| 21 | `/api/panel/status` sin token → 401 | `test/inbound/http/panel.routes.test.js` | integration (supertest) | PASS |
| 22 | `/api/panel/status` con token válido → 200 con hubspot + odoo + counts | mismo | integration | PASS |
| 23 | `/api/panel/status` reporta `down` cuando HubSpot devuelve 401 | mismo | integration | PASS |
| 24 | `/api/panel/mappings` aplica `q` y paginación | mismo | integration | PASS |
| 25 | `/api/panel/logs` aplica filtros `event`/`success`/`q` | mismo | integration | PASS |
| 26 | `/api/panel/logs/:id` retorna 404 si no existe | mismo | integration | PASS |
| 27 | `DELETE /api/panel/mappings/:id` borra y retorna 200 | mismo | integration | PASS |
| 28 | `DELETE /api/panel/logs/:id` borra y retorna 200 | mismo | integration | PASS |
| 29 | `POST /api/panel/logs/clear` exige `confirm:true` (400 si falta) | mismo | integration | PASS |
| 30 | `POST /api/panel/mappings/clear` con `confirm:true` borra todo | mismo | integration | PASS |
| 31 | `GET /` sirve `index.html` con link a `/static/panel.css` y `/static/panel.js` | `test/e2e/panel.test.js` | e2e | PASS |
| 32 | `/static/panel.css` y `/static/panel.js` se sirven (200) | mismo | e2e | PASS |
| 33 | Flujo completo: status → list → delete 1 mapping → list logs → delete 1 log | mismo | e2e | PASS |
| 34 | `POST /clear` sin confirm → 400; con confirm → borra N registros | mismo | e2e | PASS |
| 35 | En producción sin `PANEL_TOKEN`, panel routes devuelven 503 `panel_disabled` | mismo | e2e | PASS |

## Coverage

`npm run test:coverage` (v8 provider). Umbrales globales en `vitest.config.js`: lines ≥80, statements ≥80, branches ≥70, functions ≥70.

| Metric | Antes del panel | Después del panel | Threshold | Resultado |
|--------|-----------------|-------------------|-----------|-----------|
| Lines | 89.11% | **91.10%** | 80 | PASS |
| Functions | 69.67% | **70.01%** | 70 | PASS |
| Branches | 88.02% | **90.24%** | 70 | PASS |
| Statements | 89.11% | **91.10%** | 80 | PASS |

Archivos excluidos del conteo (sin lógica testeable):
- `src/server.js` (bootstrap con `process.exit`).
- `src/config/**` (constantes y loader simple).
- `src/core/application/ports/**` (JSDoc puro).
- `src/panel/static/**` y `src/panel/index.html` (UI estática — cubierta por smoke E2E).
- `src/adapters/outbound/mongo/connection.js` (helper trivial de mongoose).

Cobertura específica del panel:

```
panel.routes.js        |   93.81 |    51.61 |     100 |   93.81 |
panel.auth.middleware  |     100 |      100 |     100 |     100 |
MongoPanelRepository   |     100 |      100 |     100 |     100 |
hubspotHealthCheck     |      80 |    56.52 |   66.66 |      80 |
odooHealthCheck        |     100 |      100 |     100 |     100 |
```

## Smoke evidence (Docker)

`docker compose up -d` con `.env` poblado de `.env.example` + `PANEL_TOKEN=paneltoken123`:

```
$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3007/health
200

$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3007/
200   (HTML contiene "Panel Integración HubSpot + Odoo")

$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3007/static/panel.css
200

$ curl -s -w "%{http_code}\n" http://localhost:3007/api/panel/status
{"ok":false,"error":"missing_panel_token"}  401

$ curl -s -w "%{http_code}\n" -H "x-panel-token: wrong" http://localhost:3007/api/panel/status
{"ok":false,"error":"invalid_panel_token"}  401

$ curl -s -H "x-panel-token: paneltoken123" http://localhost:3007/api/panel/status
{"ok":true,
 "hubspot":{"up":false,"latencyMs":172,"status":401,"error":"HTTP 401"},
 "odoo":{"up":true,"mode":"stub","latencyMs":0,"error":null,"note":"Odoo client is in stub mode — no remote call performed"},
 "counts":{"mappings":0,"audits":2,"jobsByStatus":{"DEAD_LETTER":1}},
 "ts":"..."}  200

$ curl -s -H "x-panel-token: paneltoken123" "http://localhost:3007/api/panel/logs?pageSize=5"
{"ok":true,"items":[{"_id":"...","event":"job.dead_letter","detail":{"message":"Request failed with status code 401",...}}],...}  200

$ curl -s -X POST -H "x-panel-token: paneltoken123" http://localhost:3007/api/panel/logs/clear
{"ok":false,"error":"confirm_required"}  400

$ curl -s -X POST -H "x-smartflow-secret: smokesecret" http://localhost:3007/webhooks/hubspot -d '{"objectId":"D-PANEL-1"}'
{"ok":true,"deduped":false,"correlationId":"6f6aebc6-...","jobId":"6a5e4f5d..."}  202
```

Containers healthy: `smartflow-app` + `smartflow-mongo`. Stack destruido con `docker compose down`.

## Files added/modified

```
src/
  adapters/inbound/http/
    panel.auth.middleware.js        NEW (panel-auth, timing-safe)
    panel.routes.js                 NEW (fastify-plugin, 9 endpoints + cooldown)
  adapters/outbound/mongo/
    MongoPanelRepository.js         NEW (panel CRUD + counts + filters)
  adapters/outbound/hubspot/
    hubspotHealthCheck.js           NEW (lightweight GET /crm/v3/objects/deals?limit=1)
  adapters/outbound/odoo/
    odooHealthCheck.js              NEW (JSON-RPC common.version + stub bypass)
  panel/
    index.html                      NEW (UI estática, estilo y filtros)
    static/panel.css                NEW
    static/panel.js                 NEW (lógica cliente: fetch, paginación, collapsables, debounce)
  app.js                            MOD (registro del plugin + estáticos + raíz index.html)
  server.js                         MOD (pasa staticRoot al createApp)
  config/index.js                   MOD (PANEL_TOKEN, PANEL_TOKEN_HEADER_NAME)
.env.example                        MOD (PANEL_TOKEN docs)
docker-compose.yml                  MOD (env passthrough para PANEL_TOKEN)
test/
  adapters/mongo/MongoPanelRepository.test.js     NEW (19 tests)
  adapters/hubspot/hubspotHealthCheck.test.js      NEW (4 tests)
  adapters/odoo/odooHealthCheck.test.js            NEW (5 tests)
  inbound/http/panel.auth.middleware.test.js       NEW (8 tests)
  inbound/http/panel.routes.test.js                NEW (17 tests)
  e2e/panel.test.js                                NEW (5 tests)
docs/testing/2026-07-20-plan-panel.tdd.md          NEW (este archivo)
package.json                                       MOD (+ @fastify/static)
```

## Test run summary

```
Test Files  37 passed (37)
     Tests  194 passed (194)
  Duration  13.46s
```

## Plan ambiguities resolved during execution

1. **Scope of `auth` hook**: se cambió de `addHook('preHandler', auth)` (global al plugin) a `preHandler: auth` por ruta. Esto evita que el `addHook` se propague a `@fastify/static` cuando ambos están en la misma app.
2. **Static asset root**: `@fastify/static` con `prefix: '/static/'` toma el root sin prefijar el directorio. Se pasó `staticRoot + '/static'` como root y se sirvió `index.html` a mano con `fs.readFile`. Resultado: `/static/panel.css` resuelve a `<repo>/src/panel/static/panel.css`.
3. **Cooldown de `clear`**: 30 s por endpoint (logs vs mappings) para evitar un clear-all accidental repetido en rápida sucesión. Documentado como `429 cooldown retryInMs`.
4. **Health check timeout**: 5 s por ping. Los pings corren en paralelo (`Promise.all` para HubSpot+Odoo+counts), así que el peor caso es ~5 s para el panel.

## Follow-ups (intentional, out of scope)

- Botón "Reintentar job dead-letter" (movería complejidad de re-encolar + mutex al panel).
- Replay de un job fallido manualmente.
- Streaming de eventos nuevos (Server-Sent Events) para no tener que refrescar manualmente.

## Commits

- `7d387fa` — feat(panel): admin/debug panel with status, mappings, logs + clear-all (H8.0-H8.5)
- `18c4e32` — docs(tdd): TDD evidence report with Hito 0-7 + coverage + smoke (anterior)
- `3b9f442` — fix(app): wire mongoose connection to /health endpoint (anterior)
