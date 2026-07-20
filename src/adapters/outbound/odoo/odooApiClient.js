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
    let counter = 0
    return {
      mode: 'stub',
      async createManufacturingOrder(payload) {
        counter += 1
        return { id: `stub-mrp-${counter}`, ref: `STUB/${counter}`, state: 'draft', raw: payload }
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
