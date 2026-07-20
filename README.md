# smartflow-middleware

HubSpot ↔ Odoo manufacturing order sync (Fase 2). Built with hexagonal architecture in plain JavaScript (CommonJS).

When a HubSpot Deal is marked as `closedwon`, this middleware receives a webhook, fetches the full deal, creates (or updates) a manufacturing order in Odoo, and writes the Odoo ID back to the Deal property for traceability. Persistent queue with retry + dead-letter; idempotent on inbound; safe to restart.

Includes a built-in admin/debug panel (HTML + vanilla JS, no build step) to inspect connection health, sync mappings and audit logs.

---

## Architecture

```
                         ┌─────────────────────────────────┐
   HubSpot Workflow ───► │ POST /webhooks/hubspot          │
   (closedwon action)    │  static shared secret (timing- │
                         │  safe compare)                  │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                       core/   (no framework imports)             │
   │                                                                  │
   │   domain/      SyncJob · SyncMapping · SyncAuditEntry ·         │
   │                RetryPolicy · errors (SkipSyncError, Transient)  │
   │                                                                  │
   │   application/ EnqueueSyncJobUseCase                             │
   │                ProcessSyncJobUseCase  (5-step orchestration)     │
   │                JobPoller  (concurrency, mutex by sourceId,      │
   │                            recover orphans on boot)              │
   │                                                                  │
   │   shared/      mutex · dedupe key · echo guard (10s TTL)         │
   │                                                                  │
   │   ports/       JSDoc contracts (JobRepository, MappingRepo,      │
   │                SourceGateway, TargetGateway, …)                  │
   └────────────┬─────────────────────────────────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │              composition/dealSyncModule.js                       │
   │   wires: MongoJobRepo · MongoMappingRepo · MongoDedupeGuard ·   │
   │          MongoAuditTrail · HubspotSourceGateway ·               │
   │          OdooTargetGateway · validators (mustBeClosedWon,       │
   │          mustHaveLineItems, mustHaveOdooCustomerId)             │
   └────┬───────────────────────┬───────────────────────────┬────────┘
        │                       │                           │
        ▼                       ▼                           ▼
   ┌────────┐             ┌──────────────┐            ┌────────────┐
   │ Mongo  │             │   HubSpot    │            │   Odoo     │
   │ standalone│          │ Private App  │            │ mrp.       │
   │ (no     │             │ bearer token │            │ production │
   │ replica │             │ (crm.v3)     │            │ JSON-RPC   │
   │ set)    │             └──────────────┘            └────────────┘
   └────────┘

   ┌──────────────────────────────────────────────────────────────────┐
   │       Panel UI (HTML + vanilla JS, served by Fastify)            │
   │   GET  /             index.html                                  │
   │   GET  /static/*     panel.css · panel.js                        │
   │   GET  /api/panel/status          hubspot + odoo + counts       │
   │   GET  /api/panel/mappings        paginated + filter by q       │
   │   GET  /api/panel/logs            paginated + filter by event/  │
   │                                    success/sourceId              │
   │   GET  /api/panel/logs/:id        full audit with detail        │
   │   DELETE /api/panel/mappings/:id                                   │
   │   DELETE /api/panel/logs/:id                                      │
   │   POST /api/panel/{logs,mappings}/clear   body: { confirm:true }│
   │   auth: header `x-panel-token: <PANEL_TOKEN>`                   │
   └──────────────────────────────────────────────────────────────────┘
```

---

## Stack

- **Runtime**: Node.js 20+
- **Framework**: Fastify 5
- **Database**: MongoDB 7 (standalone, no replica set) via Mongoose 8
- **HTTP client**: Axios 1 (HubSpot + Odoo JSON-RPC over HTTP)
- **Auth webhook**: static shared secret (`WEBHOOK_SHARED_SECRET`)
- **Auth panel**: dedicated token (`PANEL_TOKEN`)
- **Tests**: Vitest 2 + supertest + `mongodb-memory-server`
- **Containers**: Docker single-stage (`node:20-alpine`, `USER node`)

---

## Quick start

### Local dev

```bash
npm install
cp .env.example .env
# edit .env and set HUBSPOT_ACCESS_TOKEN + WEBHOOK_SHARED_SECRET + PANEL_TOKEN
npm test                  # runs vitest once
npm run test:coverage    # same + coverage (≥80% lines/statements, ≥70% branches/functions)
npm run dev               # node --watch src/server.js
```

Server listens on `PORT` (default `3007`).

### Docker

```bash
cp .env.example .env
# edit .env
docker compose up -d
docker compose ps                    # smartflow-app + smartflow-mongo should be healthy
curl http://localhost:3007/health    # → {"ok":true,"mongo":"up","ts":"..."}
```

Panel: open `http://localhost:3007`, paste `PANEL_TOKEN`.

---

## Environment variables

All variables are documented in `.env.example` (committed). The required ones fail-fast on startup:

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `MONGODB_URI` | ✅ | — | `mongodb://localhost:27017/smartflow` |
| `HUBSPOT_ACCESS_TOKEN` | ✅ | — | Private App bearer token |
| `WEBHOOK_SHARED_SECRET` | ✅ | — | Static secret expected on `POST /webhooks/hubspot` |
| `HUBSPOT_API_BASE` | — | `https://api.hubapi.com` | Use `https://api.hubapi.eu` for EU portals |
| `WEBHOOK_SHARED_SECRET_HEADER_NAME` | — | `x-smartflow-secret` | Header the webhook secret is read from |
| `HS_PROPERTY_ODOO_CUSTOMER_ID` | — | `id_cliente_odoo` | Deal property holding the Odoo customer ID |
| `HS_PROPERTY_ODOO_ORDER_ID` | — | `id_orden_odoo` | Deal property written with the Odoo MO ID |
| `ODOO_CLIENT_MODE` | — | `stub` | `stub` returns deterministic ids; `http` posts JSON-RPC |
| `ODOO_BASE_URL` | — (http mode) | — | e.g. `https://odoo.example.com` |
| `ODOO_API_KEY` | — | — | Bearer token sent as `Authorization: Bearer …` |
| `PORT` | — | `3007` | HTTP listen port |
| `NODE_ENV` | — | `development` | `production` enforces auth + fail-closed panel |
| `LOG_LEVEL` | — | `info` | `error`/`warn`/`info`/`debug` |
| `WORKER_CONCURRENCY` | — | `3` | Parallel jobs the poller dispatches |
| `WORKER_POLL_INTERVAL_MS` | — | `5000` | JobPoller tick interval |
| `MAX_RETRY_ATTEMPTS` | — | `8` | After this, job → `DEAD_LETTER` |
| `RETRY_MAX_DELAY_MS` | — | `300000` | Backoff ceiling (2ⁿ × 1000 ms + jitter) |
| `PANEL_TOKEN` | — (prod) | — | Header `x-panel-token` value; empty in `NODE_ENV=production` → panel returns 503 |
| `PANEL_TOKEN_HEADER_NAME` | — | `x-panel-token` | Header the panel token is read from |

---

## API

### Webhook

```bash
curl -X POST http://localhost:3007/webhooks/hubspot \
  -H "x-smartflow-secret: $WEBHOOK_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"objectId":"123456789","subscriptionType":"deal.creation"}'
```

Response 202:

```json
{ "ok": true, "deduped": false, "correlationId": "uuid", "jobId": "..." }
```

Pipeline (5 steps, all checkpointed in `audits`):

1. `source.fetched` — GET deal from HubSpot
2. `source.references.resolved` — fetch associations
3. `validators.passed` — `mustBeClosedWon`, `mustHaveLineItems`, `mustHaveOdooCustomerId`
4. `target.upserted` — create or update MO in Odoo
5. `source.writeback.done` — PATCH `id_orden_odoo` on the HubSpot Deal
6. `job.completed` / `job.skipped` / `job.retry_scheduled` / `job.dead_letter`

### Panel

All panel routes require `x-panel-token: <PANEL_TOKEN>`.

```bash
curl -H "x-panel-token: $PANEL_TOKEN" http://localhost:3007/api/panel/status
```

See `docs/testing/2026-07-20-plan-panel.tdd.md` for the full route table.

---

## HubSpot private app setup

1. HubSpot → **Settings** → **Integrations** → **Private Apps** → **Create**.
2. Grant scopes:
   - `crm.objects.deals.read`
   - `crm.objects.deals.write`
   - `crm.schemas.deals.read`
3. Copy the access token (starts with `pat-…`) into `HUBSPOT_ACCESS_TOKEN`.
4. For EU portals, also set `HUBSPOT_API_BASE=https://api.hubapi.eu`.

---

## Odoo

Until the customer's real Odoo sandbox is connected, use `ODOO_CLIENT_MODE=stub`:

- `createManufacturingOrder` returns `{ id: 'stub-mrp-N', ref: 'STUB/N', state: 'draft' }`.
- `updateManufacturingOrder` echoes the id.
- The Odoo health check on the panel reports `mode: 'stub'`.

When the real endpoint is known, switch to `ODOO_CLIENT_MODE=http` and provide `ODOO_BASE_URL` + `ODOO_API_KEY`. The `OdooTargetGateway` will POST JSON-RPC to `${ODOO_BASE_URL}/jsonrpc` using `common.version` for ping and `mrp.production` for create/update. The mapper (`dealToManufacturingOrderMapper.js`) is the single place to translate the generic `record` + `references` into the Odoo payload.

---

## Tests & TDD

The project follows strict TDD: failing tests first, then minimal implementation, then refactor. Every checkpoint is a Git commit:

```bash
npm test                  # vitest run (one-shot)
npm run test:watch        # watch mode
npm run test:coverage    # + v8 coverage report (text + html + json-summary)
```

Coverage thresholds (enforced by `vitest.config.js`):

| Metric | Threshold |
|--------|-----------|
| Lines | 80% |
| Statements | 80% |
| Branches | 70% |
| Functions | 70% |

Excludes `src/server.js` (bootstrap with `process.exit`), `src/config/**` (loader + constants), `src/core/application/ports/**` (JSDoc-only), `src/panel/static/**` and `src/panel/index.html` (UI; covered by E2E), and `src/adapters/outbound/mongo/connection.js` (trivial mongoose helper).

Test organization:

```
test/
  domain/            unit · no mocks · rules
  application/       unit · use-cases + JobPoller with in-memory fakes
  adapters/
    mongo/           integration · mongodb-memory-server
    hubspot/         unit · http mock
    odoo/            unit · transport injection
  inbound/http/      integration · supertest
  composition/       integration · mongodb-memory-server + fakes
  e2e/               full pipeline · supertest + mongodb-memory-server
docs/testing/        TDD evidence reports
```

Evidence reports committed alongside the code:

- `docs/testing/2026-07-20-plan-hubspot-odoo.tdd.md` — Phase 1 (HubSpot↔Odoo).
- `docs/testing/2026-07-20-plan-panel.tdd.md` — Admin/debug panel.

---

## Project structure

```
smartflow-middleware/
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── docs/
│   ├── plan-hubspot-odoo.md
│   └── testing/
├── src/
│   ├── core/                         ← generic sync engine (no framework imports)
│   │   ├── domain/
│   │   ├── application/
│   │   │   ├── ports/                 JSDoc contracts
│   │   │   ├── use-cases/
│   │   │   └── JobPoller.js
│   │   └── shared/
│   ├── adapters/                     ← project-specific adapters
│   │   ├── inbound/http/
│   │   │   ├── auth.middleware.js
│   │   │   ├── correlation.middleware.js
│   │   │   ├── health.routes.js
│   │   │   ├── panel.auth.middleware.js
│   │   │   └── panel.routes.js
│   │   └── outbound/
│   │       ├── mongo/                schemas + 5 repos
│   │       ├── hubspot/              apiClient + SourceGateway + healthCheck
│   │       └── odoo/                 apiClient + TargetGateway + mapper + healthCheck
│   ├── composition/
│   │   ├── dealSyncModule.js         ← composition root
│   │   └── validators.js
│   ├── panel/
│   │   ├── index.html
│   │   └── static/                   panel.css + panel.js
│   ├── lib/logger.js
│   ├── config/                       constants + load()
│   ├── app.js                        Fastify factory
│   └── server.js                     bootstrap (connect → wire → listen)
└── test/
```

---

## Operational notes

- **Echo guard**: `HubspotSourceGateway.writeBack` suppresses identical back-to-back writes within a 10 s window. Without this, the writeback property change could re-trigger the webhook in a loop.
- **Mutex by sourceId**: `JobPoller` serializes per `sourceId`. Two jobs for the same Deal run strictly sequentially; the second reads the first's `Mapping` and updates Odoo instead of duplicating.
- **Worker recovery**: `JobPoller.start()` calls `recoverOrphans()` once on boot, flipping `PROCESSING` jobs older than 5 minutes back to `PENDING`. Mongo standalone + polling = no Change Streams required.
- **Logging**: structured JSON to stdout (level `info`+) / stderr (level `error`). All log entries carry a safe circular-safe replacer; secrets are never logged.
- **TTL**: completed/skipped/dead-letter jobs auto-expire after 30 days (`partialFilterExpression` on `status`). `dedupes` TTL is 5 min. `audits` are append-only with no TTL.
- **Backoff**: `2^attempts × 1000 ms + jitter(0..1000)`, capped at `RETRY_MAX_DELAY_MS`. Non-retryable HTTP statuses (400/401/403/404/422) skip straight to `DEAD_LETTER`.

---

## Out of scope

- HubSpot **public apps** (OAuth + marketplace): this project uses Private App tokens only.
- Replica sets / Change Streams / Atlas-specific features.
- Multi-tenant: one client per deployment (no `tenantId` model).
- Replay of dead-letter jobs from the panel — easy to add, deliberately deferred.

---

## License

Internal — not published.
