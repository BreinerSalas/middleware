'use strict'

const axios = require('axios')
const { normalizeProductName } = require('./productNameKey')
const { createRateLimiter } = require('../../../core/shared/rateLimiter')

const WRITE_OPS = new Set(['create', 'write', 'unlink'])
// Odoo delivers RPC errors inside an HTTP 200 body, so httpStatus/err.code from axios
// never distinguish a transient failure from a real business error. Classify by the
// Odoo-side exception name instead — matched against docs/plan-cambios-2026-08-05.md § Fase 2.
const TRANSIENT_ERROR_NAME_RE = /SessionExpiredException|SerializationFailure|DeadlockDetected|TimeoutError|OperationalError/i
const FATAL_ERROR_NAME_RE = /ValidationError|UserError|IntegrityError|AccessError/i

function classifyOdooError(errorData) {
  const name = errorData && errorData.name ? String(errorData.name) : ''
  if (!name) return undefined
  if (TRANSIENT_ERROR_NAME_RE.test(name)) return true
  if (FATAL_ERROR_NAME_RE.test(name)) return false
  return undefined
}

function createOdooApiClient({
  mode = 'stub',
  baseUrl = '',
  db = '',
  login = '',
  apiKey = '',
  timeoutMs = 10000,
  readTimeoutMs = 30000,
  writeTimeoutMs = 10000,
  transport = null,
  operationCostsTtlMs = 600000,
  now = () => Date.now(),
  rateLimiter = null,
  retry = {}
} = {}) {
  const normalizedMode = String(mode || 'stub').toLowerCase()
  if (normalizedMode === 'stub') {
    let soCounter = 0
    let moCounter = 0
    return {
      mode: 'stub',
      async createSalesOrder(payload) {
        soCounter += 1
        return { id: `stub-so-${soCounter}`, ref: `STUB/SO/${soCounter}`, state: 'draft', raw: payload }
      },
      async updateSalesOrder(targetId, payload) {
        return { id: String(targetId), ref: null, state: 'draft', raw: payload }
      },
      async searchSalesOrderByOrigin(_origin) {
        return []
      },
      async searchProductIdsByDefaultCodes(_codes) {
        return {}
      },
      async searchProductIdsByNames(_names) {
        return {}
      },
      async readProductUoms(_ids) {
        return {}
      },
      async countProductsWithDefaultCode() {
        return 0
      },
      async searchProductsWithDefaultCode({ offset = 0, limit = 100 } = {}) {
        return []
      },
      async countProductsAll() {
        return 0
      },
      async searchProductsAll({ offset = 0, limit = 100 } = {}) {
        return []
      },
      async readPartnerCountries(_ids) {
        return {}
      },
      async listOperationCosts() {
        return []
      },
      async createManufacturingOrder(payload) {
        moCounter += 1
        return { id: `stub-mrp-${moCounter}`, ref: `STUB/${moCounter}`, state: 'draft', raw: payload }
      },
      async updateManufacturingOrder(targetId, payload) {
        return { id: targetId, ref: targetId, state: 'confirmed', raw: payload }
      },
      async searchCountryIdsByCodes(_codes) {
        return {}
      },
      async readProductImage(_odooId) {
        return null
      },
      async searchProductIdsWithImage() {
        return []
      }
    }
  }
  if (normalizedMode !== 'http') {
    throw new Error(`Unsupported ODOO_CLIENT_MODE: ${mode}`)
  }
  const missingOdoo = []
  if (!baseUrl) missingOdoo.push('ODOO_BASE_URL')
  if (!db) missingOdoo.push('ODOO_DB')
  if (!login) missingOdoo.push('ODOO_LOGIN')
  if (!apiKey) missingOdoo.push('ODOO_API_KEY')
  if (missingOdoo.length > 0) {
    throw new Error(`Odoo http mode requires: ${missingOdoo.join(', ')}`)
  }

  const defaultTransport = {
    async post(url, body, opts = {}) {
      const res = await axios.post(url, body, {
        baseURL: baseUrl,
        timeout: (opts && opts.timeoutMs) || timeoutMs,
        headers: { 'Content-Type': 'application/json' }
      })
      return { data: res.data, status: res.status }
    }
  }
  const t = transport || defaultTransport
  const limiter = rateLimiter || createRateLimiter({ rps: 5, burst: 10 })

  async function rpcCall(service, method, args, opts = {}) {
    await limiter.take()
    const body = { jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }
    const res = await t.post('/jsonrpc', body, opts)
    if (res.data && res.data.error) {
      const msg = (res.data.error.data && res.data.error.data.message) || res.data.error.message || 'Odoo RPC error'
      const e = new Error(msg)
      e.httpStatus = res.status
      e.code = res.data.error.code
      e.cause = res.data.error
      e.transient = classifyOdooError(res.data.error.data)
      throw e
    }
    return res.data && res.data.result
  }

  let uidPromise = null
  function ensureUid() {
    if (!uidPromise) {
      uidPromise = (async () => {
        try {
          const result = await rpcCall('common', 'authenticate', [db, login, apiKey, {}], { timeoutMs: readTimeoutMs })
          if (!result) {
            const e = new Error(`Odoo authenticate failed for db=${db} login=${login}`)
            e.code = 'ODOO_AUTH_FAILED'
            throw e
          }
          return result
        } catch (err) {
          // Never cache a rejected auth attempt — a single transient failure would
          // otherwise brick this client until the process restarts (see Fase 2).
          uidPromise = null
          throw err
        }
      })()
    }
    return uidPromise
  }

  const _retryMaxRetries = Number.isFinite(retry.maxRetries) ? retry.maxRetries : 3
  const _retryBaseMs = Number.isFinite(retry.baseMs) ? retry.baseMs : 500
  const _retryMaxDelayMs = Number.isFinite(retry.maxDelayMs) ? retry.maxDelayMs : 5000
  const _sleep = retry.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function executeKwOnce(modelName, opName, opArgs, kwargs) {
    const uid = await ensureUid()
    const opTimeoutMs = WRITE_OPS.has(opName) ? writeTimeoutMs : readTimeoutMs
    return rpcCall('object', 'execute_kw', [db, uid, apiKey, modelName, opName, opArgs, kwargs], { timeoutMs: opTimeoutMs })
  }

  async function executeKw(modelName, opName, opArgs, kwargs = {}) {
    let attempt = 0
    for (;;) {
      try {
        return await executeKwOnce(modelName, opName, opArgs, kwargs)
      } catch (err) {
        if (err.transient !== true || attempt >= _retryMaxRetries) throw err
        attempt += 1
        const delayMs = Math.min(_retryBaseMs * Math.pow(2, attempt - 1), _retryMaxDelayMs)
        await _sleep(delayMs)
      }
    }
  }

  let ocPromise = null
  let ocResult = null
  let ocAt = 0
  async function listOperationCosts() {
    if (ocPromise) return ocPromise
    if (ocResult && (now() - ocAt) < operationCostsTtlMs) return ocResult
    ocPromise = (async () => {
      try {
        const result = await executeKw('operation.costs', 'search_read', [[]],
          { fields: ['id', 'name', 'country_id', 'product_id'] })
        const mapped = (Array.isArray(result) ? result : []).map((r) => ({
          id: Number(r.id),
          name: r.name || null,
          countryId: Array.isArray(r.country_id) ? Number(r.country_id[0]) : null,
          countryName: Array.isArray(r.country_id) ? r.country_id[1] : null,
          productId: Array.isArray(r.product_id) ? Number(r.product_id[0]) : (r.product_id === false ? null : Number(r.product_id))
        }))
        ocResult = mapped
        ocAt = now()
        return mapped
      } finally {
        ocPromise = null
      }
    })()
    return ocPromise
  }

  // countryCache: code -> { entry, at } — each code carries its own TTL stamp.
  // countryInflight: code -> Promise<entry|null> — only codes with no live
  // in-flight request are batched into a fresh RPC; every code (fresh or
  // reused) resolves from ITS OWN derived promise, so a caller asking for GT
  // can never resolve with HN's row even when both are requested concurrently.
  const countryCache = new Map()
  const countryInflight = new Map()
  const countryCacheTtlMs = operationCostsTtlMs

  async function fetchCountryRows(codesToFetch) {
    const result = await executeKw('res.country', 'search_read',
      [[['code', 'in', codesToFetch]]],
      { fields: ['id', 'code', 'name'] }
    )
    const rows = (Array.isArray(result) ? result : [])
    const byCode = new Map()
    for (const r of rows) {
      if (!r || r.code == null || r.id == null) continue
      byCode.set(String(r.code), { id: Number(r.id), name: r.name || null })
    }
    return byCode
  }

  async function searchCountryIdsByCodes(codes) {
    if (!Array.isArray(codes) || codes.length === 0) return {}
    const cleaned = []
    const seen = new Set()
    for (const raw of codes) {
      if (raw == null) continue
      const c = String(raw).trim()
      if (!c || seen.has(c)) continue
      seen.add(c)
      cleaned.push(c)
    }
    if (cleaned.length === 0) return {}

    const nowMs = now()
    const out = {}
    const needsFetch = []
    for (const code of cleaned) {
      const cached = countryCache.get(code)
      if (cached && (nowMs - cached.at) < countryCacheTtlMs) {
        if (cached.entry) out[code] = cached.entry
        continue
      }
      needsFetch.push(code)
    }
    if (needsFetch.length === 0) return out

    const freshCodes = needsFetch.filter((code) => !countryInflight.has(code))
    if (freshCodes.length > 0) {
      const batchPromise = fetchCountryRows(freshCodes)
      for (const code of freshCodes) {
        const codePromise = batchPromise
          .then((rowsByCode) => rowsByCode.get(code) || null)
          .finally(() => {
            if (countryInflight.get(code) === codePromise) countryInflight.delete(code)
          })
        countryInflight.set(code, codePromise)
      }
    }

    // A failed RPC rejects here (never reaching countryCache.set below), so the
    // failure is never cached — the next call retries fresh once the finally()
    // above has cleared the in-flight entries.
    await Promise.all(needsFetch.map(async (code) => {
      const entry = await countryInflight.get(code)
      countryCache.set(code, { entry, at: now() })
      if (entry) out[code] = entry
    }))

    return out
  }

  return {
    mode: 'http',
    _transport: t,
    async createSalesOrder(payload) {
      const result = await executeKw('sale.order', 'create', [payload])
      const soId = Number(result)
      const readBack = await executeKw('sale.order', 'read', [[soId]], { fields: ['name', 'state'] })
      const row = Array.isArray(readBack) && readBack.length > 0 ? readBack[0] : null
      return {
        id: String(result),
        ref: row && row.name ? row.name : null,
        state: row && row.state ? row.state : 'draft',
        raw: payload
      }
    },
    async updateSalesOrder(targetId, payload) {
      const result = await executeKw('sale.order', 'write', [[Number(targetId)], payload])
      return { id: String(targetId), ref: null, state: 'draft', raw: payload, rpcResult: result }
    },
    async searchSalesOrderByOrigin(origin) {
      const result = await executeKw('sale.order', 'search_read',
        [[['origin', '=', String(origin)]]],
        { fields: ['id', 'name', 'state', 'country_expense'] })
      if (!Array.isArray(result)) return []
      return result.map((r) => ({
        id: Number(r.id),
        name: r.name || null,
        state: r.state || null,
        countryExpenseId: Array.isArray(r.country_expense) ? Number(r.country_expense[0]) : null
      }))
    },
    async readPartnerCountries(ids) {
      const cleaned = Array.isArray(ids)
        ? [...new Set(
            ids
              .filter((n) => n != null && Number.isFinite(Number(n)))
              .map(Number)
          )]
        : []
      if (cleaned.length === 0) return {}
      const rows = await executeKw('res.partner', 'read', [cleaned], { fields: ['id', 'country_id', 'parent_id'] })
      const map = {}
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (!r || r.id == null) continue
          map[Number(r.id)] = {
            countryId: Array.isArray(r.country_id) ? Number(r.country_id[0]) : null,
            countryName: Array.isArray(r.country_id) ? r.country_id[1] : null,
            parentId: Array.isArray(r.parent_id) ? Number(r.parent_id[0]) : null
          }
        }
      }
      return map
    },
    async searchProductIdsByDefaultCodes(codes) {
      const cleaned = Array.isArray(codes) ? codes.filter((c) => c != null && String(c).length > 0).map(String) : []
      if (cleaned.length === 0) return {}
      const result = await executeKw('product.product', 'search_read',
        [[['default_code', 'in', cleaned]]],
        { fields: ['id', 'default_code', 'uom_id'] }
      )
      const map = {}
      if (Array.isArray(result)) {
        for (const r of result) {
          if (r && r.default_code != null && r.id != null) {
            map[String(r.default_code)] = {
              id: Number(r.id),
              uomId: Array.isArray(r.uom_id) ? Number(r.uom_id[0]) : null
            }
          }
        }
      }
      return map
    },
    // Fallback cuando no hay hs_sku usable. Usa '=ilike' (exacto pero insensible a
    // mayusculas, sin % implicito) — un 'ilike' con comodines haria match de
    // "...SV_4" contra "...SV_40" y construiria el producto equivocado.
    // Reporta la ambiguedad como dato (matches/ids); la politica la decide el gateway.
    async searchProductIdsByNames(names) {
      const keys = []
      const seen = new Set()
      for (const n of Array.isArray(names) ? names : []) {
        const key = normalizeProductName(n)
        if (!key || seen.has(key)) continue
        seen.add(key)
        keys.push(key)
      }
      if (keys.length === 0) return {}
      const terms = keys.map((k) => ['name', '=ilike', k])
      // notacion polaca: N terminos en OR necesitan N-1 prefijos '|'
      const domain = terms.length === 1
        ? terms
        : [...Array(terms.length - 1).fill('|'), ...terms]
      const result = await executeKw('product.product', 'search_read',
        [domain],
        { fields: ['id', 'name', 'uom_id'] }
      )
      const map = {}
      if (Array.isArray(result)) {
        for (const r of result) {
          if (!r || r.id == null) continue
          const key = normalizeProductName(r.name)
          if (!key) continue
          const existing = map[key]
          if (existing) {
            existing.matches += 1
            existing.ids.push(Number(r.id))
            continue
          }
          map[key] = {
            id: Number(r.id),
            uomId: Array.isArray(r.uom_id) ? Number(r.uom_id[0]) : null,
            matches: 1,
            ids: [Number(r.id)]
          }
        }
      }
      return map
    },
    async readProductUoms(ids) {
      const cleaned = Array.isArray(ids)
        ? [...new Set(ids.map(Number).filter((n) => Number.isFinite(n)))]
        : []
      if (cleaned.length === 0) return {}
      const result = await executeKw('product.product', 'read', [cleaned], { fields: ['id', 'uom_id'] })
      const map = {}
      if (Array.isArray(result)) {
        for (const r of result) {
          if (r && r.id != null && Array.isArray(r.uom_id) && r.uom_id.length > 0) {
            map[Number(r.id)] = Number(r.uom_id[0])
          }
        }
      }
      return map
    },
    async countProductsWithDefaultCode() {
      return executeKw('product.product', 'search_count',
        [[['default_code', '!=', false]]], {})
    },
    async searchProductsWithDefaultCode({ offset = 0, limit = 100 } = {}) {
      return executeKw('product.product', 'search_read',
        [[['default_code', '!=', false]]],
        { fields: ['id', 'name', 'default_code', 'list_price'], offset, limit })
    },
    async countProductsAll() {
      return executeKw('product.product', 'search_count', [[]], {})
    },
    async searchProductsAll({ offset = 0, limit = 100 } = {}) {
      return executeKw('product.product', 'search_read',
        [[]],
        { fields: ['id', 'name', 'default_code', 'list_price'], offset, limit })
    },
    listOperationCosts,
    searchCountryIdsByCodes,

    async createManufacturingOrder(payload) {
      const result = await executeKw('mrp.production', 'create', [payload])
      return { id: String(result), ref: null, state: 'draft', raw: payload }
    },
    async updateManufacturingOrder(targetId, payload) {
      const result = await executeKw('mrp.production', 'write', [[Number(targetId)], payload])
      return { id: String(targetId), ref: null, state: 'confirmed', raw: payload, rpcResult: result }
    },
    async readProductImage(odooId) {
      const id = Number(odooId)
      if (!Number.isFinite(id)) return null
      const rows = await executeKw('product.product', 'read', [[id]], { fields: ['image_512', 'write_date'] })
      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
      if (!row || !row.image_512) return null
      return { base64: row.image_512, writeDate: row.write_date || null }
    },
    // product.product.image_1920/image_512 are computed, non-stored fields (falls back to the
    // template's image when the variant has none) — a domain on them directly matches every
    // record. Traverse the many2one to the template's stored image field instead.
    async searchProductIdsWithImage() {
      const result = await executeKw('product.product', 'search', [[['product_tmpl_id.image_1920', '!=', false]]], {})
      return Array.isArray(result) ? result.map(Number) : []
    }
  }
}

module.exports = { createOdooApiClient }
