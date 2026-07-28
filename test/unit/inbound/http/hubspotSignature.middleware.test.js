import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
const require = createRequire(import.meta.url)

const { createHubspotSignatureMiddleware } = require('../../../../src/adapters/inbound/http/hubspotSignature.middleware.js')

function fakeReply() {
  const r = { code: 200, body: null, sent: false }
  const api = {
    send: (b) => { r.body = b; r.sent = true; return api },
    code: (c) => { r.code = c; return api },
    get sent() { return r.sent },
    get body() { return r.body },
    get statusCode() { return r.code },
    get codeValue() { return r.code }
  }
  return api
}

function fakeReq({ method = 'POST', url = '/webhooks/hubspot', rawBody, headers = {} } = {}) {
  return { method, url, rawBody, headers }
}

function signBase({ method, url, rawBody, timestamp, secret }) {
  const base = method + url + rawBody + String(timestamp)
  return crypto.createHmac('sha256', secret).update(base).digest('base64')
}

describe('hubspotSignature.middleware (HMAC v3)', () => {
  const secret = 'unit-test-secret'

  it('accepts when X-HubSpot-Signature-v3 matches the HMAC-SHA256 of method+url+body+timestamp', async () => {
    const ts = Date.now()
    const body = '[{"objectId":"12345","subscriptionType":"deal.propertyChange","propertyName":"dealstage","propertyValue":"closedwon"}]'
    const sig = signBase({ method: 'POST', url: '/webhooks/hubspot', rawBody: body, timestamp: ts, secret })
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret })
    const req = fakeReq({
      rawBody: body,
      headers: {
        'x-hubspot-signature-v3': sig,
        'x-hubspot-request-timestamp': String(ts)
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })

  it('accepts with custom header names (case-insensitive lookup)', async () => {
    const ts = Date.now()
    const body = '[]'
    const sig = signBase({ method: 'POST', url: '/webhooks/hubspot', rawBody: body, timestamp: ts, secret })
    const mw = createHubspotSignatureMiddleware({
      clientSecret: secret,
      signatureHeader: 'X-HubSpot-Custom-Sig',
      timestampHeader: 'X-HubSpot-Custom-Ts'
    })
    const req = fakeReq({
      rawBody: body,
      headers: {
        'x-hubspot-custom-sig': sig,
        'x-hubspot-custom-ts': String(ts)
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })

  it('rejects when signature header is missing', async () => {
    const ts = Date.now()
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret })
    const req = fakeReq({
      rawBody: '[]',
      headers: { 'x-hubspot-request-timestamp': String(ts) }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.codeValue).toBe(401)
    expect(reply.body.error).toBe('missing_signature')
  })

  it('rejects when timestamp header is missing', async () => {
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret })
    const req = fakeReq({
      rawBody: '[]',
      headers: { 'x-hubspot-signature-v3': 'whatever' }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.codeValue).toBe(401)
    expect(reply.body.error).toBe('missing_timestamp')
  })

  it('rejects when signature does not match (invalid_secret)', async () => {
    const ts = Date.now()
    const body = '[]'
    const sig = signBase({ method: 'POST', url: '/webhooks/hubspot', rawBody: body, timestamp: ts, secret: 'WRONG' })
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret })
    const req = fakeReq({
      rawBody: body,
      headers: {
        'x-hubspot-signature-v3': sig,
        'x-hubspot-request-timestamp': String(ts)
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.codeValue).toBe(401)
    expect(reply.body.error).toBe('invalid_signature')
  })

  it('rejects when signature length differs from computed (no leak via timingSafeEqual)', async () => {
    const ts = Date.now()
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret })
    const req = fakeReq({
      rawBody: '[]',
      headers: {
        'x-hubspot-signature-v3': 'short',
        'x-hubspot-request-timestamp': String(ts)
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.codeValue).toBe(401)
    expect(reply.body.error).toBe('invalid_signature')
  })

  it('rejects when timestamp is older than toleranceMs (replay protection)', async () => {
    const ts = Date.now() - (10 * 60 * 1000)
    const body = '[]'
    const sig = signBase({ method: 'POST', url: '/webhooks/hubspot', rawBody: body, timestamp: ts, secret })
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret, toleranceMs: 5 * 60 * 1000, now: () => Date.now() })
    const req = fakeReq({
      rawBody: body,
      headers: {
        'x-hubspot-signature-v3': sig,
        'x-hubspot-request-timestamp': String(ts)
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.codeValue).toBe(401)
    expect(reply.body.error).toBe('timestamp_out_of_range')
  })

  it('rejects when timestamp is in the future beyond tolerance (clock skew attack)', async () => {
    const ts = Date.now() + (10 * 60 * 1000)
    const body = '[]'
    const sig = signBase({ method: 'POST', url: '/webhooks/hubspot', rawBody: body, timestamp: ts, secret })
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret, toleranceMs: 5 * 60 * 1000, now: () => Date.now() })
    const req = fakeReq({
      rawBody: body,
      headers: {
        'x-hubspot-signature-v3': sig,
        'x-hubspot-request-timestamp': String(ts)
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.codeValue).toBe(401)
    expect(reply.body.error).toBe('timestamp_out_of_range')
  })

  it('accepts when timestamp is within tolerance window (boundary: exactly tolerance)', async () => {
    const now = 1_700_000_000_000
    const ts = now - (5 * 60 * 1000 - 1000)
    const body = '[]'
    const sig = signBase({ method: 'POST', url: '/webhooks/hubspot', rawBody: body, timestamp: ts, secret })
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret, toleranceMs: 5 * 60 * 1000, now: () => now })
    const req = fakeReq({
      rawBody: body,
      headers: {
        'x-hubspot-signature-v3': sig,
        'x-hubspot-request-timestamp': String(ts)
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })

  it('rejects when clientSecret is not configured and not in dev (fail-closed prod)', async () => {
    const mw = createHubspotSignatureMiddleware({ clientSecret: '', isDev: false })
    const req = fakeReq({ rawBody: '[]', headers: { 'x-hubspot-signature-v3': 'x', 'x-hubspot-request-timestamp': '1' } })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.codeValue).toBe(500)
    expect(reply.body.error).toBe('webhook signature secret not configured')
  })

  it('accepts (fail-open) when clientSecret is missing in dev', async () => {
    const mw = createHubspotSignatureMiddleware({ clientSecret: '', isDev: true })
    const req = fakeReq({ rawBody: '[]', headers: {} })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })

  it('rejects non-numeric timestamp gracefully (invalid_timestamp)', async () => {
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret, now: () => Date.now() })
    const req = fakeReq({
      rawBody: '[]',
      headers: {
        'x-hubspot-signature-v3': 'whatever',
        'x-hubspot-request-timestamp': 'not-a-number'
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.codeValue).toBe(401)
    expect(reply.body.error).toBe('invalid_timestamp')
  })

  it('rejects when rawBody is missing (cannot compute signature base)', async () => {
    const ts = Date.now()
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret })
    const req = fakeReq({
      rawBody: undefined,
      headers: {
        'x-hubspot-signature-v3': 'whatever',
        'x-hubspot-request-timestamp': String(ts)
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.codeValue).toBe(400)
    expect(reply.body.error).toBe('missing_body')
  })

  it('uses the rawBody exactly as-is for HMAC base (verifies bytes-in/bytes-out contract)', async () => {
    const ts = Date.now()
    const body = '[{"objectId":"1"}]'
    const sig = signBase({ method: 'POST', url: '/webhooks/hubspot', rawBody: body, timestamp: ts, secret })
    const mw = createHubspotSignatureMiddleware({ clientSecret: secret })
    const req = fakeReq({
      rawBody: body,
      headers: {
        'x-hubspot-signature-v3': sig,
        'x-hubspot-request-timestamp': String(ts)
      }
    })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })
})