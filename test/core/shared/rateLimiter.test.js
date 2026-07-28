import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createRateLimiter } = require('../../../src/core/shared/rateLimiter.js')

function flush() { return new Promise((r) => setImmediate(r)) }

describe('createRateLimiter', () => {
  let now
  let clock
  beforeEach(() => {
    now = 1_000_000
    clock = () => now
  })

  it('starts with `burst` tokens available', async () => {
    const rl = createRateLimiter({ rps: 10, burst: 5, clock })
    expect(rl.tokens).toBe(5)
  })

  it('take() resolves immediately when tokens are available', async () => {
    const rl = createRateLimiter({ rps: 10, burst: 3, clock })
    await rl.take()
    await rl.take()
    await rl.take()
    expect(rl.tokens).toBe(0)
  })

  it('take() blocks when tokens are exhausted (with fake clock advance)', async () => {
    const rl = createRateLimiter({ rps: 10, burst: 1, clock })
    await rl.take()
    expect(rl.tokens).toBe(0)
    let resolved = false
    const p = rl.take().then(() => { resolved = true })
    await flush()
    expect(resolved).toBe(false)
    now += 100
    await flush()
    expect(resolved).toBe(true)
    await p
  })

  it('refills tokens at the configured rate (rps)', async () => {
    const rl = createRateLimiter({ rps: 10, burst: 5, clock })
    for (let i = 0; i < 5; i += 1) await rl.take()
    expect(rl.tokens).toBe(0)
    now += 100
    expect(rl.tokens).toBe(1)
    now += 400
    expect(rl.tokens).toBe(5)
    now += 500
    expect(rl.tokens).toBe(5)
  })

  it('pause(ms) blocks refill for the given window', async () => {
    const rl = createRateLimiter({ rps: 10, burst: 5, clock })
    for (let i = 0; i < 5; i += 1) await rl.take()
    rl.pause(300)
    now += 200
    expect(rl.tokens).toBe(0)
    now += 200
    expect(rl.tokens).toBe(0)
    now += 100
    expect(rl.tokens).toBe(1)
  })

  it('honors FIFO order for queued take() calls', async () => {
    const rl = createRateLimiter({ rps: 10, burst: 1, clock })
    await rl.take()
    const order = []
    const a = rl.take().then(() => order.push('a'))
    const b = rl.take().then(() => order.push('b'))
    now += 100
    await flush()
    await a
    await b
    expect(order).toEqual(['a', 'b'])
  })

  it('integrates with real setTimeout for small windows', async () => {
    const rl = createRateLimiter({ rps: 50, burst: 1 })
    await rl.take()
    const start = Date.now()
    await rl.take()
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(15)
    expect(rl.tokens).toBeLessThanOrEqual(1)
  })
})
