'use strict'

const { timingSafeEqual } = require('node:crypto')

function createAuthMiddleware({ secret, headerName = 'x-smartflow-secret', isDev = false } = {}) {
  const expected = Buffer.from(String(secret || ''))
  return async function authMiddleware(req, reply) {
    if (!secret) {
      if (isDev) return
      reply.code(500).send({ ok: false, error: 'webhook secret not configured' })
      return reply
    }
    const provided = req.headers && req.headers[headerName.toLowerCase()]
    if (!provided) {
      reply.code(401).send({ ok: false, error: 'missing_secret' })
      return reply
    }
    const providedBuf = Buffer.from(String(provided))
    if (providedBuf.length !== expected.length) {
      reply.code(401).send({ ok: false, error: 'invalid_secret' })
      return reply
    }
    try {
      const ok = timingSafeEqual(providedBuf, expected)
      if (!ok) {
        reply.code(401).send({ ok: false, error: 'invalid_secret' })
        return reply
      }
    } catch (_) {
      reply.code(401).send({ ok: false, error: 'invalid_secret' })
      return reply
    }
  }
}

module.exports = { createAuthMiddleware }
