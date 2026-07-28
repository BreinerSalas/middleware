# Plan — HubSpot Private App webhooks

## Contexto

El middleware esperaba webhooks al estilo HubSpot **Workflow** (acción
"Send webhook" con body custom `{"objectId":"…"}` y header estático
`x-smartflow-secret`). La integración real corre sobre una **Private App**
con suscripciones de webhook nativas, que:

1. Envía un **array JSON** de eventos (no un objeto).
2. Firma cada request con **HMAC-SHA256 v3** sobre
   `METHOD + URI + BODY + TIMESTAMP` usando el `clientSecret` de la app.
3. Envía headers `X-HubSpot-Signature-v3` y `X-HubSpot-Request-Timestamp`.

El middleware rechazaba los requests reales con `401 invalid_secret` /
`400 objectId required`.

## Decisiones (acordadas con el operador)

| # | Decisión | Resultado |
|---|---|---|
| 1 | Modo de auth | **Private App only** — HMAC v3 único camino |
| 2 | Eventos encolados | **Estricto**: solo `deal.propertyChange` con `dealstage=closedwon` |
| 3 | `dealSyncModule.registerRoutes` (dead code) | **Borrado** |
| 4 | Tolerancia de timestamp | **5 min** (`HUBSPOT_WEBHOOK_TS_TOLERANCE_MS=300000`) |
| 5 | `HUBSPOT_CLIENT_SECRET` | Configurado en `.env` local del operador |

## Cambios

| Archivo | Cambio |
|---|---|
| `src/adapters/inbound/http/hubspotSignature.middleware.js` | **Nuevo**. Factory `createHubspotSignatureMiddleware({clientSecret, toleranceMs, isDev, signatureHeader, timestampHeader, now})`. Usa `node:crypto` (sin nuevas deps). |
| `src/adapters/inbound/http/auth.middleware.js` | **Borrado** (legacy). |
| `src/app.js` | Reemplaza `createAuthMiddleware` por `createHubspotSignatureMiddleware`. Handler del webhook itera `req.body` como array y filtra por `subscriptionType='deal.propertyChange'` + `propertyName='dealstage'` + `propertyValue='closedwon'`. Devuelve 202 si encoló ≥1, 200 con `enqueued:0` si no. |
| `src/composition/dealSyncModule.js` | `registerRoutes` **borrado** (dead code). |
| `src/config/index.js` | `HUBSPOT_CLIENT_SECRET` agregado a `REQUIRED_KEYS`. `WEBHOOK_SHARED_SECRET` movido a opcional. `HUBSPOT_WEBHOOK_TS_TOLERANCE_MS` opcional, default 300000. Expone `cfg.hubspot.clientSecret` y `cfg.hubspot.signatureTimestampToleranceMs`. |
| `.env.example` | Documenta `HUBSPOT_CLIENT_SECRET` y `HUBSPOT_WEBHOOK_TS_TOLERANCE_MS`. |
| `README.md` | Sección "Configuración de HubSpot" reescrita para Private App + HMAC + array body. |
| `test/unit/inbound/http/hubspotSignature.middleware.test.js` | **Nuevo**. 14 casos. |
| `test/inbound/http/webhook.routes.test.js` | **Reescrito**. 12 casos (HMAC + array + strict filter + fail-closed prod). |
| `test/inbound/http/auth.middleware.test.js` | **Borrado**. |
| `test/config.test.js` | Extendido: required-key list, `clientSecret`, tolerance, legacy WEBHOOK_SHARED_SECRET optional. |
| `test/e2e/full-flow.test.js` | Body array firmado con HMAC. |
| `docs/testing/<fecha>-plan-hubspot-private-app.tdd.md` | **Nuevo**. Evidencia TDD. |

## Comportamiento del endpoint `/webhooks/hubspot`

| Caso | Código | Body |
|---|---|---|
| Firma HMAC válida, array con evento(s) `deal.propertyChange(dealstage=closedwon)` | 202 | `{ ok, enqueued: ≥1, deduped, correlationId, jobId }` |
| Firma HMAC válida, array sin eventos relevantes | 200 | `{ ok, enqueued: 0 }` |
| Firma HMAC válida, body no es array | 200 | `{ ok, enqueued: 0 }` (log warning) |
| Firma HMAC válida, evento sin `objectId` | 200 | `{ ok, enqueued: 0 }` (filtrado) |
| Falta `X-HubSpot-Signature-v3` | 401 | `{ ok: false, error: 'missing_signature' }` |
| Falta `X-HubSpot-Request-Timestamp` | 401 | `{ ok: false, error: 'missing_timestamp' }` |
| Timestamp fuera de la ventana | 401 | `{ ok: false, error: 'timestamp_out_of_range' }` |
| Timestamp no numérico | 401 | `{ ok: false, error: 'invalid_timestamp' }` |
| Firma inválida | 401 | `{ ok: false, error: 'invalid_signature' }` |
| `HUBSPOT_CLIENT_SECRET` ausente en producción | 500 | `{ ok: false, error: 'webhook signature secret not configured' }` |
| `HUBSPOT_CLIENT_SECRET` ausente en dev/test | (pasa) | (fail-open para desarrollo local) |

## Comportamiento de HubSpot (referencia)

HubSpot espera `2xx` rápido. Cualquier `4xx/5xx` dispara retry con
backoff. Por eso:

- Eventos no relevantes → `200` con `enqueued:0` (ack rápido, sin retry).
- Errores internos al encolar un evento individual → `200` (no se cae el batch completo).
- Falla de auth → `401` (HubSpot entiende que fue autenticación inválida y no debe reenviar la misma firma).
- Falta de config en producción → `500` (configuración rota → retry sirve hasta corregir).

## Riesgos cubiertos

- **Replay attack**: ventana de 5 min + comparación timing-safe.
- **Length leak**: comparación con `crypto.timingSafeEqual` solo si los buffers tienen igual longitud.
- **Echo loop**: el writeback a HubSpot (`id_orden_odoo`) sigue pasando por el `echoGuard` con TTL de 10s en `HubspotSourceGateway.js` — no se introduce regresión.
- **Carga por batch grande**: el `dedupeGuard` evita reencolar el mismo `objectId` dentro de la ventana corta.