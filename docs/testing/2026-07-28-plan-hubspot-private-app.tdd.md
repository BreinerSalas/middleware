# TDD evidence — plan-hubspot-private-app

**Date**: 2026-07-28
**Source plan**: `docs/plan-hubspot-private-app.md`
**Branch**: `main` (linear, 4 checkpoint commits)

## User journeys

1. **Como operador**, quiero que webhooks de HubSpot Private App (firmados con HMAC v3 sobre array de eventos) sean autenticados y procesados, para que los deals que pasan a `closedwon` disparen la sync a Odoo sin intervención manual.
2. **Como operador de seguridad**, quiero que la verificación use HMAC-SHA256 con comparación timing-safe y ventana de tolerancia de 5 min para evitar replay attacks.
3. **Como operador**, quiero que eventos irrelevantes (creación, borrado, otros cambios de propiedad) sean silenciosamente acknowledged con `200`, para que HubSpot no entre en loop de retries.
4. **Como desarrollador**, quiero que el body llegue como array y se filtre por evento (solo `deal.propertyChange(dealstage=closedwon)`), descartando el resto sin encolar jobs innecesarios.

## Checkpoint commits

| # | SHA | Subject | Tests at this commit |
|---|---|---|---|
| 1 | `54c7ad5` | feat(inbound): HMAC v3 signature middleware | 14 new tests pass; suite 365/365 |
| 2 | `cd1d3a5` | feat(config): require HUBSPOT_CLIENT_SECRET, expose signature tolerance | +13 config tests; suite 370/370 |
| 3 | `3516173` | feat(inbound): webhook handles Private App array body + strict event filter | 12 new webhook tests, e2e rewritten; suite 377/377 |
| 4 | `154abb6` | refactor(inbound): drop legacy shared-secret webhook auth | dead middleware deleted; suite 372/372 |

## Task report

### Fase 1 — HMAC middleware

- **RED**: `test/unit/inbound/http/hubspotSignature.middleware.test.js` written with 14 cases. Initial run: `Cannot find module '../../../src/adapters/inbound/http/hubspotSignature.middleware.js'` — module does not exist (RED gate confirmed).
- **GREEN**: implemented `src/adapters/inbound/http/hubspotSignature.middleware.js` using `node:crypto.createHmac('sha256', secret)`. Base string: `METHOD + URL + BODY + TIMESTAMP`. Compare with `crypto.timingSafeEqual` only when buffer lengths match. Replay window: `Math.abs(now() - ts) > toleranceMs` → reject.
- **Refactor**: none needed — single file, single responsibility.
- **Validation**: `npx vitest run test/unit/inbound/http/hubspotSignature.middleware.test.js` → 14/14 PASS. Full suite: 365/365 PASS (no regression).

### Fase 2 — Config

- **RED**: `test/config.test.js` extended with cases for `HUBSPOT_CLIENT_SECRET` as required key, `cfg.hubspot.clientSecret` exposure, `HUBSPOT_WEBHOOK_TS_TOLERANCE_MS` parsing with default 300000ms, and `WEBHOOK_SHARED_SECRET` no longer required. Initial run: 10/13 FAIL (RED confirmed).
- **GREEN**: `src/config/index.js` updated:
  - `REQUIRED_KEYS` swap: `WEBHOOK_SHARED_SECRET` → `HUBSPOT_CLIENT_SECRET`.
  - `OPTIONAL_KEYS` adds `HUBSPOT_WEBHOOK_TS_TOLERANCE_MS` and `WEBHOOK_SHARED_SECRET`.
  - `cfg.hubspot.clientSecret = env.HUBSPOT_CLIENT_SECRET`.
  - `cfg.hubspot.signatureTimestampToleranceMs = Number(env.HUBSPOT_WEBHOOK_TS_TOLERANCE_MS || 300000)`.
  - `cfg.webhook.sharedSecret` defaults to `''` instead of throwing.
- **Validation**: 13/13 config tests PASS. Full suite: 370/370 PASS.

### Fase 3 — Webhook handler + drop registerRoutes

- **RED**: `test/inbound/http/webhook.routes.test.js` rewritten with 12 cases covering HMAC + array body + strict event filter. Initial run: 10/12 FAIL.
- **GREEN**: `src/app.js` webhook route:
  - Replaced `createAuthMiddleware` with `createHubspotSignatureMiddleware`.
  - Iterates `req.body` as array. If not array → 200 with `enqueued:0` (HubSpot retry semantics).
  - For each event: only enqueues when `subscriptionType==='deal.propertyChange'` AND `propertyName==='dealstage'` AND `propertyValue==='closedwon'` AND `objectId` present.
  - Returns 202 with last enqueue result if `enqueued>0`, otherwise 200.
  - `src/composition/dealSyncModule.js` `registerRoutes` removed (dead code).
  - `test/e2e/full-flow.test.js` updated to send signed array body.
- **Validation**: 12/12 webhook tests PASS. Full suite: 377/377 PASS.

### Fase 4 — Cleanup

- **Action**: deleted `src/adapters/inbound/http/auth.middleware.js` and `test/inbound/http/auth.middleware.test.js`. Removed dead `createAuthMiddleware` import and instance from `src/app.js`. Renamed `signatureAuth` → `auth` for the remaining HMAC middleware to keep the route line stable.
- **Validation**: 372/372 PASS (one test file fewer). No coverage regression.

## Test specification

| # | What is guaranteed | Test file or command | Test type | Result |
|---|---|---|---|---|
| 1 | HMAC middleware accepts correct HMAC-SHA256 over `METHOD+URL+BODY+TS` | `test/unit/inbound/http/hubspotSignature.middleware.test.js` | unit | PASS (14/14) |
| 2 | HMAC middleware rejects missing/invalid signature, missing/invalid/old timestamp, length mismatch | mismo | unit | PASS |
| 3 | HMAC middleware fail-closed in production when secret missing; fail-open in dev | mismo | unit | PASS |
| 4 | Config requires `HUBSPOT_CLIENT_SECRET`, exposes `cfg.hubspot.clientSecret` and `signatureTimestampToleranceMs` (default 300000) | `test/config.test.js` | unit | PASS (13/13) |
| 5 | `WEBHOOK_SHARED_SECRET` is no longer required | mismo | unit | PASS |
| 6 | Webhook rejects invalid HMAC with 401 | `test/inbound/http/webhook.routes.test.js` | integration | PASS (12/12) |
| 7 | Webhook enqueues 1 job on `deal.propertyChange(dealstage=closedwon)` | mismo | integration | PASS |
| 8 | Webhook ignores `deal.creation`, `deal.deletion`, other properties, other stages, empty array, missing objectId — returns 200 with `enqueued:0` | mismo | integration | PASS |
| 9 | Webhook returns 202 + 1 enqueue when batch mixes relevant + ignored events | mismo | integration | PASS |
| 10 | Webhook fails closed (500) in production when `HUBSPOT_CLIENT_SECRET` missing | mismo | integration | PASS |
| 11 | E2E: signed webhook → enqueue → poll → upsert → writeback completes within polling window | `test/e2e/full-flow.test.js` | e2e | PASS (1/1) |

## Coverage

Final coverage at HEAD (`npm run test:coverage`):
- Lines: ≥ 80% (threshold maintained)
- Statements: ≥ 80%
- Branches: ≥ 70%
- Functions: ≥ 70%

## Files touched

```
src/adapters/inbound/http/auth.middleware.js                 [deleted]
src/adapters/inbound/http/hubspotSignature.middleware.js     [new]
src/app.js                                                    [modified]
src/composition/dealSyncModule.js                             [modified]
src/config/index.js                                           [modified]
.env.example                                                  [modified]
test/unit/inbound/http/hubspotSignature.middleware.test.js   [new]
test/inbound/http/auth.middleware.test.js                     [deleted]
test/inbound/http/webhook.routes.test.js                      [rewritten]
test/config.test.js                                           [extended]
test/e2e/full-flow.test.js                                    [modified]
docs/plan-hubspot-private-app.md                              [new]
docs/testing/2026-07-28-plan-hubspot-private-app.tdd.md       [new]
```

## Known gaps / follow-ups

- The `dealSyncModule.enqueueWebhook` still accepts a single `objectId` per call. If HubSpot ever batches many `closedwon` events for the same `dealId` in one webhook, the `MongoDedupeGuard` will coalesce them — verified by `test/adapters/mongo/MongoDedupeGuard.test.js`.
- `PANEL_TOKEN_HEADER_NAME` (config) and `WEBHOOK_SHARED_SECRET_HEADER_NAME` (config) remain exposed for backward compat with existing `.env` files. They are not wired into the runtime.
- Auto-detection of HubSpot region (`api.hubapi.com` vs `api.hubapi.eu`) remains a follow-up — outside this plan.