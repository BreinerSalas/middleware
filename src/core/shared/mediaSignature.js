'use strict'

const { createHmac, timingSafeEqual } = require('node:crypto')

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sign(payload, secret) {
  return base64url(createHmac('sha256', secret).update(payload).digest())
}

function signProductImageToken(odooId, secret) {
  if (!secret) throw new Error('signProductImageToken requires a non-empty secret')
  const id = Number(odooId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('signProductImageToken requires a positive numeric odooId')
  const payload = String(id)
  const sig = sign(payload, secret)
  return `${base64url(Buffer.from(payload))}.${sig}`
}

function verifyProductImageToken(token, secret) {
  if (!secret || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadPart, sigPart] = parts
  const payloadBuf = Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const payload = payloadBuf.toString('utf8')
  const expectedSig = sign(payload, secret)
  const a = Buffer.from(expectedSig)
  const b = Buffer.from(sigPart)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const id = Number(payload)
  if (!Number.isFinite(id) || id <= 0) return null
  return id
}

module.exports = { signProductImageToken, verifyProductImageToken }
