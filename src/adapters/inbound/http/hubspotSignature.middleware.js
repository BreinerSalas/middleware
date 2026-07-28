'use strict'

const crypto = require('node:crypto')

const DEFAULT_SIGNATURE_HEADER = 'x-hubspot-signature-v3'
const DEFAULT_TIMESTAMP_HEADER = 'x-hubspot-request-timestamp'
const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000

function buildSignatureBase({ method, fullUrl, rawBody, timestamp }) {
  return String(method || '') + String(fullUrl || '') + String(rawBody == null ? '' : rawBody) + String(timestamp)
}

function resolveFullUrl(req) {
  const host = (req.headers && (req.headers.host || req.headers.Host)) || ''
  if (!host) return null
  const proto = (req.headers && (req.headers['x-forwarded-proto'] || req.headers['X-Forwarded-Proto'])) || 'https'
  return `${proto}://${host}${req.url || ''}`
}

function createHubspotSignatureMiddleware({
  clientSecret,
  signatureHeader = DEFAULT_SIGNATURE_HEADER,
  timestampHeader = DEFAULT_TIMESTAMP_HEADER,
  toleranceMs = DEFAULT_TOLERANCE_MS,
  isDev = false,
  now = () => Date.now()
} = {}) {
  const sigHeader = String(signatureHeader || DEFAULT_SIGNATURE_HEADER).toLowerCase()
  const tsHeader = String(timestampHeader || DEFAULT_TIMESTAMP_HEADER).toLowerCase()

  return async function hubspotSignatureMiddleware(req, reply) {
    if (!clientSecret) {
      if (isDev) return
      reply.code(500).send({ ok: false, error: 'webhook signature secret not configured' })
      return reply
    }

    const providedSig = req.headers && req.headers[sigHeader]
    const providedTs = req.headers && req.headers[tsHeader]
    if (!providedSig) {
      reply.code(401).send({ ok: false, error: 'missing_signature' })
      return reply
    }
    if (!providedTs) {
      reply.code(401).send({ ok: false, error: 'missing_timestamp' })
      return reply
    }

    const tsNum = Number(providedTs)
    if (!Number.isFinite(tsNum)) {
      reply.code(401).send({ ok: false, error: 'invalid_timestamp' })
      return reply
    }

    const skew = Math.abs(now() - tsNum)
    if (skew > toleranceMs) {
      reply.code(401).send({ ok: false, error: 'timestamp_out_of_range' })
      return reply
    }

    if (req.rawBody == null) {
      reply.code(400).send({ ok: false, error: 'missing_body' })
      return reply
    }

    const fullUrl = resolveFullUrl(req)
    if (!fullUrl) {
      reply.code(401).send({ ok: false, error: 'invalid_signature' })
      return reply
    }
    const base = buildSignatureBase({
      method: req.method,
      fullUrl,
      rawBody: req.rawBody,
      timestamp: providedTs
    })
    const computed = crypto.createHmac('sha256', clientSecret).update(base).digest('base64')
    const providedBuf = Buffer.from(String(providedSig))
    const computedBuf = Buffer.from(computed)
    if (providedBuf.length !== computedBuf.length) {
      reply.code(401).send({ ok: false, error: 'invalid_signature' })
      return reply
    }
    try {
      if (!crypto.timingSafeEqual(providedBuf, computedBuf)) {
        reply.code(401).send({ ok: false, error: 'invalid_signature' })
        return reply
      }
    } catch (_) {
      reply.code(401).send({ ok: false, error: 'invalid_signature' })
      return reply
    }
  }
}

module.exports = {
  createHubspotSignatureMiddleware,
  buildSignatureBase,
  resolveFullUrl,
  DEFAULT_SIGNATURE_HEADER,
  DEFAULT_TIMESTAMP_HEADER,
  DEFAULT_TOLERANCE_MS
}