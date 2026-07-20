'use strict'

const { timingSafeEqual } = require('node:crypto')

function createPanelAuthMiddleware({ token = '', headerName = 'x-panel-token', nodeEnv = 'production' } = {}) {
  const expected = Buffer.from(String(token || ''))
  const isProduction = String(nodeEnv || '').toLowerCase() === 'production'
  const header = (headerName || 'x-panel-token').toLowerCase()

  return async function panelAuth(req, reply) {
    if (!token) {
      if (isProduction) {
        reply.code(503).send({ ok: false, error: 'panel_disabled' })
        return reply
      }
      return
    }
    const provided = req.headers && req.headers[header]
    if (!provided) {
      reply.code(401).send({ ok: false, error: 'missing_panel_token' })
      return reply
    }
    const providedBuf = Buffer.from(String(provided))
    if (providedBuf.length !== expected.length) {
      reply.code(401).send({ ok: false, error: 'invalid_panel_token' })
      return reply
    }
    try {
      const ok = timingSafeEqual(providedBuf, expected)
      if (!ok) {
        reply.code(401).send({ ok: false, error: 'invalid_panel_token' })
        return reply
      }
    } catch (_) {
      reply.code(401).send({ ok: false, error: 'invalid_panel_token' })
      return reply
    }
  }
}

module.exports = { createPanelAuthMiddleware }
