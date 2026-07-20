import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createPanelAuthMiddleware } = require('../../../src/adapters/inbound/http/panel.auth.middleware.js')

function fakeReply() {
  const r = { code: 200, body: null, sent: false }
  const api = {
    send: (b) => { r.body = b; r.sent = true; return api },
    code: (c) => { r.code = c; return api },
    get sent() { return r.sent },
    get body() { return r.body }
  }
  return api
}

function fakeReq(headers = {}) { return { headers } }

describe('panel.auth.middleware', () => {
  it('rejects all requests in production when PANEL_TOKEN is not configured', async () => {
    const mw = createPanelAuthMiddleware({ token: '', headerName: 'x-panel-token', nodeEnv: 'production' })
    const req = fakeReq({ 'x-panel-token': 'whatever' })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.body.error).toBe('panel_disabled')
  })

  it('allows all requests in development when PANEL_TOKEN is not configured', async () => {
    const mw = createPanelAuthMiddleware({ token: '', headerName: 'x-panel-token', nodeEnv: 'development' })
    const req = fakeReq({})
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })

  it('allows all requests in test env when PANEL_TOKEN is not configured', async () => {
    const mw = createPanelAuthMiddleware({ token: '', headerName: 'x-panel-token', nodeEnv: 'test' })
    const req = fakeReq({})
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })

  it('rejects with 401 when token is configured but header is missing', async () => {
    const mw = createPanelAuthMiddleware({ token: 'topsecret', headerName: 'x-panel-token', nodeEnv: 'production' })
    const req = fakeReq({})
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.body.error).toBe('missing_panel_token')
  })

  it('rejects with 401 when token mismatches', async () => {
    const mw = createPanelAuthMiddleware({ token: 'topsecret', headerName: 'x-panel-token', nodeEnv: 'production' })
    const req = fakeReq({ 'x-panel-token': 'wrong' })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.body.error).toBe('invalid_panel_token')
  })

  it('accepts when token matches', async () => {
    const mw = createPanelAuthMiddleware({ token: 'topsecret', headerName: 'x-panel-token', nodeEnv: 'production' })
    const req = fakeReq({ 'x-panel-token': 'topsecret' })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })

  it('uses lowercase header lookup', async () => {
    const mw = createPanelAuthMiddleware({ token: 'topsecret', headerName: 'X-Panel-Token', nodeEnv: 'production' })
    const req = fakeReq({ 'x-panel-token': 'topsecret' })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(false)
  })

  it('rejects when lengths differ (length-leak safe)', async () => {
    const mw = createPanelAuthMiddleware({ token: 'topsecret', headerName: 'x-panel-token', nodeEnv: 'production' })
    const req = fakeReq({ 'x-panel-token': 'a' })
    const reply = fakeReply()
    await mw(req, reply)
    expect(reply.sent).toBe(true)
    expect(reply.body.error).toBe('invalid_panel_token')
  })
})
