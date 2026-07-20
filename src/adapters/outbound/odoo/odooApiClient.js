'use strict'

const axios = require('axios')

function createOdooApiClient({ mode = 'stub', baseUrl = '', apiKey = '', timeoutMs = 10000, transport = null } = {}) {
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
  if (!baseUrl) throw new Error('Odoo http mode requires ODOO_BASE_URL')

  const defaultTransport = {
    async post(url, body) {
      const res = await axios.post(url, body, {
        baseURL: baseUrl,
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', Authorization: apiKey ? `Bearer ${apiKey}` : undefined }
      })
      return { data: res.data, status: res.status }
    }
  }
  const t = transport || defaultTransport

  async function rpcCall(method, params) {
    const body = { jsonrpc: '2.0', method, params, id: Date.now() }
    const res = await t.post('/jsonrpc', body)
    if (res.data && res.data.error) {
      const e = new Error(res.data.error.data && res.data.error.data.message ? res.data.error.data.message : 'Odoo RPC error')
      e.httpStatus = res.status
      e.code = res.data.error.code
      e.cause = res.data.error
      throw e
    }
    return res.data && res.data.result
  }
  return {
    mode: 'http',
    _transport: t,
    async createManufacturingOrder(payload) {
      const result = await rpcCall('call', { service: 'object', method: 'execute_kw', args: ['mrp.production', 'create', [payload]] })
      return { id: String(result), ref: null, state: 'draft', raw: payload }
    },
    async updateManufacturingOrder(targetId, payload) {
      const result = await rpcCall('call', { service: 'object', method: 'execute_kw', args: ['mrp.production', 'write', [[Number(targetId)], payload]] })
      return { id: targetId, ref: null, state: 'confirmed', raw: payload, rpcResult: result }
    }
  }
}

module.exports = { createOdooApiClient }
