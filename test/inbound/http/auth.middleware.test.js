import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createAuthMiddleware } = require('../../../src/adapters/inbound/http/auth.middleware.js')

function fakeReply() {
  const r = { code: 200, body: null, sent: false }
  const api = {
    send: (b) => { r.body = b; r.sent = true; return api },
    code: (c) => { r.code = c; return api },
    get sent() { return r.sent },
    get body() { return r.body },
    get statusCode() { return r.code }
  }
  return api
}

function fakeReq(headers = {}) { return { headers } }

describe('auth.middleware (static shared secret)', () => {
  it('rejects when secret is not configured and not in dev', async () => {
    const mw = createAuthMiddleware({ secret: '', headerName: 'x-smartflow-secret' })
    const req = fakeReq({ 'x-smartflow-secret': 'whatever' })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.body.error).toBe('webhook secret not configured')
  })

  it('rejects when header is missing', async () => {
    const mw = createAuthMiddleware({ secret: 's', headerName: 'x-smartflow-secret' })
    const req = fakeReq({})
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.body.error).toBe('missing_secret')
  })

  it('rejects when secret mismatches', async () => {
    const mw = createAuthMiddleware({ secret: 'topsecret', headerName: 'x-smartflow-secret' })
    const req = fakeReq({ 'x-smartflow-secret': 'wrong' })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.body.error).toBe('invalid_secret')
  })

  it('accepts when secret matches', async () => {
    const mw = createAuthMiddleware({ secret: 'topsecret', headerName: 'x-smartflow-secret' })
    const req = fakeReq({ 'x-smartflow-secret': 'topsecret' })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })

  it('accepts when secret matches with custom header name (case-insensitive lookup)', async () => {
    const mw = createAuthMiddleware({ secret: 'topsecret', headerName: 'X-Custom-Auth' })
    const req = fakeReq({ 'x-custom-auth': 'topsecret' })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })
})
