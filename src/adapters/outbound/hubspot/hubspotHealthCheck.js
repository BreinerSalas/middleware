'use strict'

const axios = require('axios')

function createDefaultHttpClient({ baseUrl, accessToken, timeoutMs }) {
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

async function hubspotHealthCheck({ baseUrl, accessToken, timeoutMs = 5000, httpClient = null, now = () => Date.now() } = {}) {
  if (!baseUrl) throw new Error('hubspotHealthCheck requires baseUrl')
  if (!accessToken) throw new Error('hubspotHealthCheck requires accessToken')
  const http = httpClient || createDefaultHttpClient({ baseUrl, accessToken, timeoutMs })
  const started = now()
  try {
    await http.get('/crm/v3/objects/deals', { params: { limit: 1 } })
    return { up: true, latencyMs: now() - started, status: 200, error: null }
  } catch (err) {
    const status = (err && err.response && err.response.status) || null
    const code = (err && err.code) || null
    return {
      up: false,
      latencyMs: now() - started,
      status,
      error: status ? `HTTP ${status}` : (code || (err && err.message) || 'unknown error')
    }
  }
}

module.exports = { hubspotHealthCheck, createDefaultHttpClient }
