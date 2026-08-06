# TDD Evidence — Fase 2: Robustez del cliente de Odoo

**Source plan**: [docs/plan-cambios-2026-08-05.md § Fase 2](../plan-cambios-2026-08-05.md#fase-2--robustez-del-cliente-de-odoo--prerrequisito-de-todo-lo-continuo)

## User journeys / guarantees covered

1. Como el middleware, quiero que un fallo transitorio de autenticación contra Odoo no deje
   el cliente inutilizable para siempre, para que el sync continuo se recupere solo.
2. Como el middleware, quiero distinguir errores transitorios de Odoo (sesión expirada,
   deadlock, serialización, timeout) de errores fatales de negocio (validación, permisos),
   para reintentar solo lo que tiene sentido reintentar.
3. Como el middleware, quiero reintentar automáticamente los errores transitorios con
   backoff exponencial, y nunca reintentar los fatales.
4. Como operador, quiero que las llamadas a Odoo pasen por un rate limiter, para no saturar
   la base de datos de Odoo bajo carga continua.
5. Como operador, quiero timeouts distintos para lecturas (30s) y escrituras (10s), en vez
   de un único timeout genérico para todo.

## Task report

| Tarea | Resumen de ejecución | Comando | Resultado |
|---|---|---|---|
| RED | 15 tests nuevos en `test/adapters/odoo/odooApiClient.hardening.test.js`, ejecutados antes de tocar producción | `npx vitest run test/adapters/odoo/odooApiClient.hardening.test.js` | 13/15 fallando (2 pasaban por coincidencia con el comportamiento buggy actual — ver detalle abajo) |
| GREEN | Implementación en `src/adapters/outbound/odoo/odooApiClient.js`: fix de `ensureUid`, `classifyOdooError`, `executeKw` con retry/backoff, `rateLimiter` inyectado, timeouts por operación | `npx vitest run test/adapters/odoo/odooApiClient.hardening.test.js` | 15/15 pasando |
| Regresión | Suite completa del repo tras el cambio | `npx vitest run` | 673/673 pasando, 70/70 archivos |
| Refactor | Revisado — el código sigue la convención existente (`_variable` para estado privado de composición, igual que `dealSyncModule.js`); no se encontró duplicación ni necesidad de limpieza adicional | — | sin cambios |

## Test specification

| # | Qué garantiza | Test | Tipo | Resultado |
|---|---|---|---|---|
| 1 | Un fallo de autenticación no deja la caché de `uidPromise` envenenada; la siguiente llamada reintenta el login | `odooApiClient.hardening.test.js:re-authenticates on the next call after a failed authenticate...` | unit | PASS |
| 2 | `SessionExpiredException`, `SerializationFailure`, `DeadlockDetected`, `TimeoutError` se marcan `transient=true` | `odooApiClient.hardening.test.js:marks %s as transient=true` (4 casos, `it.each`) | unit | PASS |
| 3 | `ValidationError`, `UserError`, `IntegrityError`, `AccessError` se marcan `transient=false` | `odooApiClient.hardening.test.js:marks %s as transient=false` (4 casos, `it.each`) | unit | PASS |
| 4 | Un nombre de error no reconocido deja `transient` sin definir (no se reintenta por defecto) | `odooApiClient.hardening.test.js:leaves transient unset for an unrecognized Odoo error name` | unit | PASS |
| 5 | `RetryPolicy.isRetryableError` honra `err.transient` producido por el cliente de Odoo, en ambos sentidos | Integrado en los tests 2-4 vía `expect(isRetryableError(caught))` | unit (integración con `RetryPolicy`) | PASS |
| 6 | Un error transitorio se reintenta una vez con backoff (`sleepFn` invocado) y luego tiene éxito | `odooApiClient.hardening.test.js:retries once on a transient error then succeeds...` | unit | PASS |
| 7 | Tras agotar `maxRetries` reintentos transitorios, se lanza el último error | `odooApiClient.hardening.test.js:gives up after maxRetries transient failures...` | unit | PASS |
| 8 | Un error fatal (`transient=false`) nunca se reintenta ni duerme | `odooApiClient.hardening.test.js:does not retry or sleep on a fatal (non-transient) error` | unit | PASS |
| 9 | Cada llamada RPC (incluida la autenticación) espera al rate limiter inyectado antes de ejecutarse | `odooApiClient.hardening.test.js:awaits the injected rate limiter before every RPC call...` | unit | PASS |
| 10 | Las operaciones de lectura (`search`) usan `readTimeoutMs`; las de escritura (`write`) usan `writeTimeoutMs` | `odooApiClient.hardening.test.js:uses the read timeout for search/read operations...` | unit | PASS |

## Coverage y brechas conocidas

`npx vitest run --coverage test/adapters/odoo/odooApiClient.hardening.test.js test/adapters/odoo/odooApiClient.test.js`
→ `odooApiClient.js`: **83.58% líneas, 80.5% ramas, 68.18% funciones**.

Las líneas sin cubrir en esa corrida parcial (`countProductsAll`, `searchProductsAll`) son
métodos preexistentes no tocados por esta fase — sí están cubiertos en la suite completa
(`OdooProductSource.test.js`, etc.). El umbral global del 80% del proyecto **no** se cumple al
correr solo estos dos archivos porque el cálculo es sobre todo `src/`, no por archivo; la
corrida completa (`npx vitest run`, sin `--coverage`) confirma 673/673 pasando, incluyendo todos
los consumidores de `odooApiClient`.

**Fuera de alcance de esta fase, documentado en el plan pero no implementado aquí**:
reintento automático del propio paso de autenticación dentro de la misma llamada (el fix de
esta fase resuelve el envenenamiento de caché; el reintento a nivel de job ya existe en
`ProcessSyncJobUseCase`/`RetryPolicy` y cubre el caso siguiente).

## Merge evidence

Checkpoints en la rama `main`:
- `test: add reproducers for Odoo client robustness (Fase 2)` — commit `5b11638` (RED, 13/15 fallando)
- `fix: harden Odoo client against auth-cache poisoning and non-retryable errors (Fase 2)` — commit `5ad10b2` (GREEN, 15/15 + 673/673 suite completa)
