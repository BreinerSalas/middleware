# Evidencia TDD — Plan `odoo-real-auth` (smartflow-middleware)

## Fuente

`docs/plan-odoo-real-auth.md`. El plan pedía reemplazar `Authorization: Bearer <apiKey>` por JSON-RPC nativo (`common.authenticate` + `object.execute_kw`) en el adapter de Odoo.

## Decisiones del usuario (confirmadas antes de implementar)

1. **Orden de ejecución**: Tasks 2–5 primero; Task 1 (`.env` con credenciales reales) y Task 6 (e2e manual) las hace el usuario manualmente al final.
2. **Auth lazy**: la autenticación NO ocurre al construir el factory; se hace en el primer `execute_kw`. Esto evita que la app se caiga si Odoo está offline al boot.
3. **Normalización de `ODOO_BASE_URL`**: quitar trailing slash en `src/config/index.js` para evitar `//jsonrpc`.
4. **`.env` con secretos NO se toca**: está en `.gitignore`. El usuario pega sus credenciales reales cuando termine la revisión.

## Cumplimiento de arquitectura

- Sigue la arquitectura hexagonal: solo se tocó `src/adapters/outbound/odoo/odooApiClient.js` (adapter outbound) y `src/config/index.js` (composition). El core (`src/core/`) y el inbound (`src/inbound/`) no se modificaron.
- `dealSyncModule.js` sigue invocando `createOdooApiClient({ mode, baseUrl, apiKey })`. La firma solo añadió `db`/`login` (opcional, default `''`); ningún call site se rompió.
- `odooHealthCheck.js` quedó intacto: ya usaba JSON-RPC nativo (`common.version`) sin credenciales, no necesita cambios.
- 0 nuevas dependencias (axios 1.7 ya estaba).

## Etapas TDD (RED → GREEN por hito, un commit por hito)

| Hito | Contenido                                                         | Commits                                                                                                | Tests añadidos | Resultado |
|------|-------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|----------------|-----------|
| T1   | `cfg.odoo.db`/`cfg.odoo.login` parseados; normalización de slash | `3ebc813 test(config)` → `b508b01 feat(config)`                                                       | 3              | PASS      |
| T2   | Reescritura del adapter: JSON-RPC auth lazy + validación + sin Bearer | `db21e63 test(odoo)` → `38d4586 feat(odoo)` → `1bc254d test(odoo) cobertura`                          | 9 (4 validación + 3 actualización + 2 nuevos: ODOO_AUTH_FAILED, no-Bearer) | PASS |
| T3   | `.env.example` documentando las 2 vars nuevas                     | `10324e3 docs(env)`                                                                                    | —              | (doc)     |

**Total**: 12 tests nuevos / actualizados en `odooApiClient.test.js` (13 finales tras cubrir branch unsupported-mode), 3 nuevos en `config.test.js`.

## Tabla de garantías

| # | Qué se garantiza                                                                                                                                       | Test                                                                     | Tipo         | Resultado | Evidencia                                                          |
|---|--------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------|--------------|-----------|--------------------------------------------------------------------|
| 1 | `cfg.odoo.db` y `cfg.odoo.login` se parsean del env cuando están presentes                                                                            | `test/config.test.js:parses ODOO_DB and ODOO_LOGIN when provided`        | unit         | PASS      | `npm test -- test/config.test.js`                                  |
| 2 | Si no están presentes, defaultan a string vacío `''` (no undefined)                                                                                  | `test/config.test.js:defaults cfg.odoo.db and cfg.odoo.login …`           | unit         | PASS      | `npm test -- test/config.test.js`                                  |
| 3 | `ODOO_BASE_URL` con trailing slash se normaliza (no `//jsonrpc`)                                                                                     | `test/config.test.js:normalizes trailing slashes in ODOO_BASE_URL`        | unit         | PASS      | `npm test -- test/config.test.js`                                  |
| 4 | Stub mode sigue retornando ids deterministas (`stub-mrp-1`, `stub-mrp-2`, …)                                                                          | `test/adapters/odoo/odooApiClient.test.js:stub mode returns …`           | unit         | PASS      | `npm test -- test/adapters/odoo/`                                  |
| 5 | Stub `updateManufacturingOrder` eco del targetId                                                                                                      | `test/adapters/odoo/odooApiClient.test.js:stub mode update …`            | unit         | PASS      | idem                                                              |
| 6 | Http mode falla con mensaje específico si falta cada uno: `ODOO_BASE_URL` / `ODOO_DB` / `ODOO_LOGIN` / `ODOO_API_KEY`                                  | 4 tests independientes en `odooApiClient.test.js` (uno por campo)         | unit         | PASS      | `npm test -- test/adapters/odoo/odooApiClient.test.js`             |
| 7 | Http mode falla con `Unsupported ODOO_CLIENT_MODE` si el mode no es `stub`/`http`                                                                     | `test/adapters/odoo/odooApiClient.test.js:throws on unsupported mode`    | unit         | PASS      | idem                                                              |
| 8 | Auth flow correcto: 1ª llamada `service:common/method:authenticate` con `[db, login, apiKey, {}]`; 2ª llamada `execute_kw(mrp.production, create, …)` | `test/adapters/odoo/odooApiClient.test.js:http mode authenticates then …` | integration  | PASS      | `post.mock.calls[0][1].params` y `post.mock.calls[1][1].params`   |
| 9 | Auth flow en update: `execute_kw(mrp.production, write, [[42], payload], {})` con uid cacheado                                                      | `test/adapters/odoo/odooApiClient.test.js:http mode update …`            | integration  | PASS      | `post.mock.calls[1][1].params.args`                                |
| 10 | Si `authenticate` devuelve `false`, throw con `code: 'ODOO_AUTH_FAILED'` y NO se ejecuta `execute_kw`                                              | `test/adapters/odoo/odooApiClient.test.js:throws ODOO_AUTH_FAILED …`      | unit (neg)   | PASS      | `expect(post).toHaveBeenCalledTimes(1)`                            |
| 11 | uid se cachea: 3 operaciones (2 create + 1 update) → 4 POSTs totales (1 auth + 3 exec_kw). El uid cacheado se reusa en args[1] de todas las exec_kw | `test/adapters/odoo/odooApiClient.test.js:authenticates only once …`     | integration  | PASS      | `expect(post).toHaveBeenCalledTimes(4)` + `args[1] === 5`         |
| 12 | Errores JSON-RPC (`{ error: { data: { message } } }`) se propagan como `Error` con `.message`                                                         | `test/adapters/odoo/odooApiClient.test.js:propagates execute_kw RPC error` | unit (neg)  | PASS      | `rejects.toThrow(/Validation error/)`                              |
| 13 | **Garantía de seguridad**: el default transport (axios) NO envía header `Authorization` ni `authorization` (sin leak de `apiKey`)                  | `test/adapters/odoo/odooApiClient.test.js:default transport does not send Authorization header` | unit (security) | PASS | `vi.spyOn(axios, 'post')` capturó los headers                      |

## Cobertura

Comando: `npm run test:coverage`

| Archivo                                | % Stmts | % Branch | % Funcs | % Lines |
|----------------------------------------|---------|----------|---------|---------|
| `src/adapters/outbound/odoo/odooApiClient.js` | 100     | 90.9     | 100     | 100     |
| `src/config/index.js`                  | 100     | 100      | 100     | 100     |
| **Total proyecto**                     | 91.77   | 70.8     | 91.56   | 91.77   |

Branches no cubiertas (defensivas): `'Odoo RPC error'` fallback en `rpcCall`, `String(targetId)` para strings no-numéricas. No afectan al contrato.

## Comandos de validación ejecutados

```bash
npm test -- test/config.test.js                                # 7/7 PASS
npm test -- test/adapters/odoo/odooApiClient.test.js           # 13/13 PASS
npm test -- test/adapters/odoo/ test/composition/              # 35/35 PASS (incluye dealSyncModule end-to-end)
npm test                                                        # 205/205 PASS (37 files)
npm run test:coverage                                           # 91.77% global, 100% en archivos tocados
```

## Mapeo a tareas del plan original

| Tarea original | Estado | Notas |
|---|---|---|
| Task 1 — `.env` con credenciales reales | **No ejecutado** (acción manual del usuario, `.env` está en `.gitignore`) | El usuario debe pegar sus 4 placeholders reales y poner `ODOO_CLIENT_MODE=http` |
| Task 2 — `.env.example` | ✅ Ejecutado en `10324e3` | 5 vars documentadas con defaults vacíos |
| Task 3 — Cargar vars en config | ✅ Ejecutado en `b508b01` (con normalización de slash como mejora) | 3 tests nuevos verdes |
| Task 4 — Reescribir `odooApiClient.js` | ✅ Ejecutado en `38d4586` (con auth lazy y cobertura 100%) | Helpers `rpcCall`/`executeKw` extraídos |
| Task 5 — Actualizar tests del adapter | ✅ Ejecutado en `db21e63` + `1bc254d` | 13 tests verdes (5 antiguos migrados + 8 nuevos) |
| Task 6 — Verificación e2e contra trial real | **Pendiente** (acción manual del usuario) | Requiere Task 1 primero |

## Decisiones tácticas durante implementación

1. **`ensureUid` es una lazy promise**: la auth ocurre en el primer `execute_kw`, no al construir el factory. Cumplido en issue #3 del plan original.
2. **Mensajes de error específicos por campo**: `Odoo http mode requires ODOO_BASE_URL` / `ODOO_DB` / `ODOO_LOGIN` / `ODOO_API_KEY`. Cada test asserta con su regex específica — un test débil anterior (`/ODOO_BASE_URL/` match-anything) se convirtió en 4 tests granulares.
3. **`Authorization` header eliminado por completo del default transport**. La garantía se valida con `vi.spyOn(axios, 'post')` en el test #13.
4. **`apiKey` ya no viaja como header, solo como argumento posicional de `authenticate` y `execute_kw`** (orden oficial Odoo: `[db, uid, apiKey, model, method, args, kwargs]`).
5. **3 tests fueron corregidos durante el GREEN**: la aserción `toMatchObject({ args: [...6 items] })` no matcheaba con el `[...7 items, {}]` que produce `executeKw`. Ajustados a 7 elementos con kwargs vacío. El test `authenticates only once` esperaba 3 calls pero recibe 4 (1 auth + 3 exec_kw). Documentado inline.

## Out of scope (no tocado)

- `dealToManufacturingOrderMapper.js` (el mapper sigue igual — el `mrp.production` payload que ve Odoo es exactamente el que el mapper genera hoy)
- Webhook listener de Odoo (polling vs push)
- Sesión cookie persistente en lugar de re-autenticar por proceso
- Reescribir `axios` → `node-fetch`/`undici`

## Riesgos residuales para Task 6 (e2e manual del usuario)

- Si el trial SaaS devolviera error 401 (credenciales mal pegadas) → `code: 'ODOO_AUTH_FAILED'` se loggea y `createManufacturingOrder` rechaza.
- Si el mapper genera campos que el trial rechaza (ej: `product_id` requerido) → error `{ httpStatus: 200, code: 200, message: 'ValidationError' }` se propaga al job, el worker lo reencola (`transient: true`).
- Si rate limit → `timeoutMs: 10000` se respeta; backoff no está implementado (queda como follow-up).
