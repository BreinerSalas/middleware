'use strict'

const axios = require('axios')

function createOdooApiClient({
  mode = 'stub',
  baseUrl = '',
  db = '',
  login = '',
  apiKey = '',
  timeoutMs = 10000,
  transport = null
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
      async createManufacturingOrder(payload) {
        moCounter += 1
        return { id: `stub-mrp-${moCounter}`, ref: `STUB/${moCounter}`, state: 'draft', raw: payload }
      },
      async updateManufacturingOrder(targetId, payload) {
        return { id: targetId, ref: targetId, state: 'confirmed', raw: payload }
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
    async post(url, body) {
      const res = await axios.post(url, body, {
        baseURL: baseUrl,
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json' }
      })
      return { data: res.data, status: res.status }
    }
  }
  const t = transport || defaultTransport

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

  let uidPromise = null
  function ensureUid() {
    if (!uidPromise) {
      uidPromise = (async () => {
        const result = await rpcCall('common', 'authenticate', [db, login, apiKey, {}])
        if (!result) {
          const e = new Error(`Odoo authenticate failed for db=${db} login=${login}`)
          e.code = 'ODOO_AUTH_FAILED'
          throw e
        }
        return result
      })()
    }
    return uidPromise
  }

  async function executeKw(modelName, opName, opArgs, kwargs = {}) {
    const uid = await ensureUid()
    return rpcCall('object', 'execute_kw', [db, uid, apiKey, modelName, opName, opArgs, kwargs])
  }

  return {
    mode: 'http',
    _transport: t,
    async createSalesOrder(payload) {
      const result = await executeKw('sale.order', 'create', [payload])
      return { id: String(result), ref: null, state: 'draft', raw: payload }
    },
    async updateSalesOrder(targetId, payload) {
      const result = await executeKw('sale.order', 'write', [[Number(targetId)], payload])
      return { id: String(targetId), ref: null, state: 'draft', raw: payload, rpcResult: result }
    },
    async searchSalesOrderByOrigin(origin) {
      const result = await executeKw('sale.order', 'search', [[['origin', '=', String(origin)]]])
      return Array.isArray(result) ? result : []
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
    async createManufacturingOrder(payload) {
      const result = await executeKw('mrp.production', 'create', [payload])
      return { id: String(result), ref: null, state: 'draft', raw: payload }
    },
    async updateManufacturingOrder(targetId, payload) {
      const result = await executeKw('mrp.production', 'write', [[Number(targetId)], payload])
      return { id: String(targetId), ref: null, state: 'confirmed', raw: payload, rpcResult: result }
    }
  }
}

module.exports = { createOdooApiClient }
