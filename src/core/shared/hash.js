'use strict'

const { createHash } = require('node:crypto')

function buildDedupeKey({ sourceId, rawPayload }) {
  if (!sourceId) throw new Error('buildDedupeKey requires sourceId')
  const payloadStr = rawPayload == null ? '' : (typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload))
  const h = createHash('sha256').update(payloadStr).digest('hex').slice(0, 16)
  return `${sourceId}:${h}`
}

function hashPayload(payload) {
  if (payload == null) return null
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return createHash('sha256').update(serialized).digest('hex').slice(0, 32)
}

module.exports = { buildDedupeKey, hashPayload }
