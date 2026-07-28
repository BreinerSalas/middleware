# Plan: Habilitar Odoo real auth (JSON-RPC) en smartflow-middleware

**Fecha:** 2026-07-20
**Estado:** Pendiente de ejecución con OpenCode
**Project root:** `/home/kadejo/smarteamProjects/smartflow-middleware`

## Goal

Reemplazar el `ODOO_CLIENT_MODE=stub` del middleware por un cliente Odoo real
que use JSON-RPC nativo (no REST con Bearer), autentique una vez al construir
el factory y permita crear/actualizar `mrp.production` contra el trial de bsalas.

## Contexto

| | |
|---|---|
| **Stack del proyecto** | Node ≥20, Fastify 5, Mongoose 8, vitest 2, axios 1.7 |
| **Arquitectura** | Hexagonal — puertos en `src/core/application/ports/`, adaptadores en `src/adapters/outbound/` |
| **Adaptador Odoo** | `src/adapters/outbound/odoo/odooApiClient.js` (63 líneas) |
| **Estado actual** | Modo `stub` activo en `.env`. Adapter http usa `Authorization: Bearer *** — Odoo NO usa Bearer |
| **Auth real Odoo** | JSON-RPC: `service: 'common', method: 'authenticate'` → uid; luego `service: 'object', method: 'execute_kw'` con `[db, uid, apiKey, model, method, args, kwargs]` |
| **Credenciales ya validadas** | curl a `/jsonrpc` con `authenticate` devolvió `{"result": 2}` (UID = 2). Las 4 credenciales son correctas |
| **Cambios se aplican con** | OpenCode, no directamente acá |

## Asunciones explícitas

1. **Trial SaaS activo** (`https://TU-EMPRESA.odoo.com`). Si bsalas decide bajar el `.exe` Community, la URL pasa a `http://localhost:8069` y el resto no cambia.
2. **No hay cambio en el modelo `mrp.production`** — el mapper `dealToManufacturingOrderMapper.js` sigue igual. Solo cambia cómo se manda al server.
3. **No se introducen nuevas deps** — axios ya está. La auth se hace con `execute_kw` (no sesiones persistentes con cookies).
4. **Tests existentes de `odooApiClient.test.js` van a romperse** — asumen que el primer POST ya es `execute_kw`. Hay que actualizarlos.
5. **HubSpot adapter NO se toca** — esa parte ya funciona.

## Tareas (bite-sized, 2-5 min c/u)

### Task 1 — Actualizar `.env` con valores reales

**Archivo:** `/home/kadejo/smarteamProjects/smartflow-middleware/.env`

**Cambio:**
```diff
-ODOO_CLIENT_MODE=stub
-ODOO_BASE_URL=
-ODOO_API_KEY=+ODOO_CLIENT_MODE=http
+ODOO_BASE_URL=https://TU-EMPRESA.odoo.com
+ODOO_DB=TU-EMPRESA
+ODOO_LOGIN=tu-email@ejemplo.com
+ODOO_API_KEY=PEGÁ-LOS-40-HEX-CHARS
```

**Acceptance:**
- `grep ^ODOO_ .env` muestra las 5 vars (incluyendo `ODOO_CLIENT_MODE=http`)
- Ningún valor contiene `stub` o queda vacío en producción

⚠️ **Bsalas debe reemplazar los 4 placeholders ANTES de aplicar este patch** (URL, DB, login, API key).

---

### Task 2 — Sincronizar `.env.example`

**Archivo:** `/home/kadejo/smarteamProjects/smartflow-middleware/.env.example`

**Cambio:** agregar las 2 vars nuevas (`ODOO_DB`, `ODOO_LOGIN`) al template.

```diff
-ODOO_CLIENT_MODE=stub
-ODOO_BASE_URL=
-ODOO_API_KEY=+ODOO_CLIENT_MODE=stub
+ODOO_BASE_URL=
+ODOO_DB=
+ODOO_LOGIN=
+ODOO_API_KEY=
```

**Acceptance:** `.env.example` lista las 5 vars con valores vacíos (modo `stub` por default para onboarding).

---

### Task 3 — Cargar nuevas vars en `src/config/index.js`

**Archivo:** `/home/kadejo/smarteamProjects/smartflow-middleware/src/config/index.js`

**Cambio:**
```diff
   'ODOO_CLIENT_MODE',
   'ODOO_BASE_URL',
+  'ODOO_DB',
+  'ODOO_LOGIN',
   'ODOO_API_KEY',
@@
     odoo: {
       mode: (env.ODOO_CLIENT_MODE || 'stub').toLowerCase(),
       baseUrl: env.ODOO_BASE_URL || '',
+      db: env.ODOO_DB || '',
+      login: env.ODOO_LOGIN || '',
       apiKey: *** || ''
     },
```

**Acceptance:**
- `config.odoo.db` y `config.odoo.login` están disponibles
- `test/config.test.js` (si existe) sigue verde

---

### Task 4 — Reescribir `src/adapters/outbound/odoo/odooApiClient.js`

**Archivo:** `/home/kadejo/smarteamProjects/smartflow-middleware/src/adapters/outbound/odoo/odooApiClient.js`

**Cambio:** reescribir la rama `http` para usar JSON-RPC real con `authenticate()` una vez al construir.

**Contrato del factory (nuevo):**
```js
createOdooApiClient({
  mode: 'http',
  baseUrl: 'https://TU-EMPRESA.odoo.com',
  db: 'TU-EMPRESA',
  login: 'tu-email@ejemplo.com',
  apiKey: '***',  // 40 hex
  timeoutMs: 10000,  // opcional, default 10s
  transport: null    // opcional, para tests
})
```

**Comportamiento esperado:**
1. Si `mode === 'stub'` → comportamiento actual (no rompe).
2. Si `mode === 'http'`:
   - Validar `baseUrl`, `db`, `login`, `apiKey` → throw con mensaje específico si falta alguno
   - Al construir, hacer POST `/jsonrpc` con `{ service: 'common', method: 'authenticate', args: [db, login, apiKey, {}] }` → guardar `uid` en closure
   - Si auth devuelve `false` o `error`, throw con `code: 'ODOO_AUTH_FAILED'`
   - `createManufacturingOrder(payload)` → `execute_kw('mrp.production', 'create', [payload])`
   - `updateManufacturingOrder(targetId, payload)` → `execute_kw('mrp.production', 'write', [[Number(targetId)], payload])`
   - Args de `execute_kw`: `[db, uid, apiKey, model, method, args, kwargs]` (orden oficial Odoo)
   - Headers: solo `Content-Type: application/json`. **NO `Authorization`**.

**Reference snippet del código nuevo (key parts):**
```js
async function rpcCall(service, method, args) {
  const body = { jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }
  const res = await t.post('/jsonrpc', body)
  if (res.data && res.data.error) {
    const msg = (res.data.error.data && res.data.error.data.message) || res.data.error.message || 'Odoo RPC error'
    const e = new Error(msg)
    e.httpStatus = res.status
    e.code = res.data.error.code
    e.cause = res.data.error
    throw e
  }
  return res.data && res.data.result
}

let uid = null
const ready = (async () => {
  const result = await rpcCall('common', 'authenticate', [db, login, apiKey, {}])
  if (!result) {
    const e = new Error(`Odoo authenticate failed for db=${db} login=${login}`)
    e.code = 'ODOO_AUTH_FAILED'
    throw e
  }
  uid = result
  return uid
})()

async function executeKw(model, method, args, kwargs = {}) {
  await ready
  return rpcCall('object', 'execute_kw', [db, uid, apiKey, model, method, args, kwargs])
}
```

**Acceptance:**
- Stub mode funciona igual que antes (3 tests de stub verde)
- Http mode requiere las 4 vars (test existente "http mode requires baseUrl" se actualiza, ver Task 5)
- Http mode sin credenciales válidas → `code: 'ODOO_AUTH_FAILED'`
- Http mode con credenciales válidas → uid se cachea, no se vuelve a autenticar

---

### Task 5 — Actualizar `test/adapters/odoo/odooApiClient.test.js`

**Archivo:** `/home/kadejo/smarteamProjects/smartflow-middleware/test/adapters/odoo/odooApiClient.test.js`

**Cambio:** los tests actuales rompen porque asumen 1 sola llamada POST. Ahora el factory hace 2 (auth + execute_kw). Actualizar:

```diff
 it('http mode requires baseUrl', () => {
-  expect(() => createOdooApiClient({ mode: 'http' })).toThrow(/ODOO_BASE_URL/)
+  expect(() => createOdooApiClient({ mode: 'http' })).toThrow(/Odoo http mode requires/)
 })

 it('http mode posts JSON-RPC and unwraps result', async () => {
-  const post = vi.fn(async () => ({ data: { result: 99 }, status: 200 }))
-  const api = createOdooApiClient({ mode: 'http', baseUrl: 'https://odoo.example.com', apiKey: *** transport: { post } })
-  const r = await api.createManufacturingOrder({ partner_id: 1 })
-  expect(r.id).toBe('99')
-  expect(post).toHaveBeenCalledWith('/jsonrpc', expect.objectContaining({ jsonrpc: '2.0', method: 'call' }))
+  // Mock: 1ra llamada = authenticate → uid=2; 2da = execute_kw → id=99
+  const post = vi.fn()
+    .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })        // authenticate
+    .mockResolvedValueOnce({ data: { result: 99 }, status: 200 })       // create mrp.production
+  const api = createOdooApiClient({
+    mode: 'http', baseUrl: 'https://odoo.example.com',
+    db: 'test-db', login: 'test@x.com', apiKey: 'k',
+    transport: { post }
+  })
+  const r = await api.createManufacturingOrder({ partner_id: 1 })
+  expect(r.id).toBe('99')
+  expect(post).toHaveBeenCalledTimes(2)
+  // 1ra: authenticate
+  expect(post.mock.calls[0][1].params).toMatchObject({ service: 'common', method: 'authenticate' })
+  // 2da: execute_kw create
+  expect(post.mock.calls[1][1].params).toMatchObject({ service: 'object', method: 'execute_kw' })
 })
```

**Nuevos tests a agregar:**
- `http mode with invalid auth throws ODOO_AUTH_FAILED` (mock: `result: false`)
- `http mode caches uid after first call` (mock: 1 sola llamada a `authenticate`, luego varias a `execute_kw`)

**Acceptance:**
- `npm test -- test/adapters/odoo/odooApiClient.test.js` → 5/5 verde
- Ningún test de stub se rompe

---

### Task 6 — Verificar end-to-end con el trial real

**Comando:** con `.env` ya con valores reales, levantar el server:
```bash
cd /home/kadejo/smarteamProjects/smartflow-middleware
npm run dev
```

**En otra terminal:**
```bash
# Health check debe mostrar odoo.up: true
curl http://localhost:3007/health | jq

# Disparar manualmente un job de prueba (si existe endpoint admin)
# Si no existe, validar con un script rápido:
node -e "
  const { createOdooApiClient } = require('./src/adapters/outbound/odoo/odooApiClient.js')
  const cfg = require('./src/config').load().odoo
  const api = createOdooApiClient(cfg)
  api.createManufacturingOrder({ product_id: 1, product_qty: 1 })
    .then(r => { console.log('OK', r); process.exit(0) })
    .catch(e => { console.error('FAIL', e.message); process.exit(1) })
"
```

**Acceptance:**
- Health check devuelve `odoo: { up: true, mode: 'http', version: '18.0-...' }`
- Script crea una `mrp.production` real en el trial → log muestra `id: <number>`
- En Odoo UI (Manufacturing → Manufacturing Orders) aparece el registro nuevo
- Si falla: log muestra error con `.message` claro (auth fail / permission denied / etc.)

---

## Orden de aplicación (OpenCode)

```
Task 1  →  Task 2  →  Task 3  →  Task 4  →  Task 5  →  Task 6
.env     .env.ex    config    apiClient   tests     e2e verify
```

> ⚠️ Task 1 requiere acción manual de Bsalas (pegar sus credenciales reales).
> Tasks 2-5 son código puro, OpenCode las puede hacer una tras otra.
> Task 6 es verificación manual.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Bsalas pega mal las credenciales | Task 1 tiene grep de verificación. Si falla, Task 6 muestra error claro de auth |
| Trial SaaS expira en 15 días | Documentar en README que el trial tiene fecha de expiración; si pasa, regenerar |
| Tests existentes rompen antes de fix | Task 4 y Task 5 van juntas; Task 4 sin Task 5 deja tests rojos |
| El mapper genera campos que el trial rechaza (ej: `product_id` requerido) | Task 6 es la validación real. Si falla, ver el error y ajustar el mapper (no en este plan, queda como follow-up) |
| Odoo bloquea por rate limit | El adapter ya tiene `timeoutMs: 10000`. Si pasa, agregar backoff en una v2 |

## Out of scope (no en este plan)

- Reescribir el mapper `dealToManufacturingOrderMapper.js`
- Agregar webhook listener de Odoo (polling vs push)
- Mover auth de `apiKey` en args a session cookie persistente (optimización, no necesario)
- Tests E2E con un Deal real de HubSpot (depende de HubSpot API, otro flujo)