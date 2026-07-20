'use strict'

async function odooHealthCheck({ mode = 'http', baseUrl = '', timeoutMs = 5000, transport = null, now = () => Date.now() } = {}) {
  const normalizedMode = String(mode || 'http').toLowerCase()
  if (normalizedMode === 'stub') {
    return { up: true, mode: 'stub', latencyMs: 0, error: null, note: 'Odoo client is in stub mode — no remote call performed' }
  }
  if (normalizedMode !== 'http') throw new Error(`Unsupported ODOO_CLIENT_MODE: ${mode}`)
  if (!baseUrl) throw new Error('odooHealthCheck requires baseUrl in http mode')
  const started = now()
  const t = transport || {
    async post(url, body) {
      const axios = require('axios')
      const res = await axios.post(url, body, { baseURL: baseUrl, timeout: timeoutMs })
      return { status: res.status, data: res.data }
    }
  }
  try {
    const res = await t.post('/jsonrpc', { jsonrpc: '2.0', method: 'call', params: { service: 'common', method: 'version', args: [] }, id: Date.now() })
    if (res.data && res.data.error) {
      return { up: false, latencyMs: now() - started, status: res.status, error: res.data.error.data && res.data.error.data.message ? res.data.error.data.message : (res.data.error.message || 'rpc error') }
    }
    const version = (res.data && res.data.result && (res.data.result.server_version || res.data.result)) || null
    return { up: true, latencyMs: now() - started, status: res.status, error: null, version: typeof version === 'string' ? version : null }
  } catch (err) {
    return { up: false, latencyMs: now() - started, status: null, error: (err && err.code) || (err && err.message) || 'connect failed' }
  }
}

module.exports = { odooHealthCheck }
