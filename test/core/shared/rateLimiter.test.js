import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createRateLimiter } = require('../../../src/core/shared/rateLimiter.js')

function fixedClock(initial) {
  let now = initial
  return {
    get now() { return now },
    advance(ms) { now += ms }
  }
}

describe('createRateLimiter', () => {
  it('starts with `burst` tokens available', () => {
    const c = fixedClock(1_000_000)
    const rl = createRateLimiter({ rps: 10, burst: 5, clock: () => c.now })
    expect(rl.tokens).toBe(5)
  })

  it('take() resolves immediately when tokens are available (fake clock arithmetic)', async () => {
    const c = fixedClock(1_000_000)
    const rl = createRateLimiter({ rps: 10, burst: 3, clock: () => c.now })
    await rl.take()
    await rl.take()
    await rl.take()
    expect(rl.tokens).toBe(0)
  })

  it('refills tokens at the configured rate (rps)', () => {
    const c = fixedClock(1_000_000)
    const rl = createRateLimiter({ rps: 10, burst: 5, clock: () => c.now })
    for (let i = 0; i < 5; i += 1) rl.take()
    expect(rl.tokens).toBe(0)
    c.advance(100)
    expect(rl.tokens).toBe(1)
    c.advance(400)
    expect(rl.tokens).toBe(5)
    c.advance(500)
    expect(rl.tokens).toBe(5)
  })

  it('pause(ms) blocks refill for the given window', () => {
    const c = fixedClock(1_000_000)
    const rl = createRateLimiter({ rps: 10, burst: 5, clock: () => c.now })
    for (let i = 0; i < 5; i += 1) rl.take()
    expect(rl.tokens).toBe(0)
    rl.pause(300)
    c.advance(200)
    expect(rl.tokens).toBe(0)
    c.advance(100)
    expect(rl.tokens).toBe(0)
    c.advance(100)
    expect(rl.tokens).toBe(1)
  })

  it('take() blocks until a token is available (real-time wait)', async () => {
    const rl = createRateLimiter({ rps: 50, burst: 1 })
    await rl.take()
    const start = Date.now()
    await rl.take()
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(15)
  })

  it('honors FIFO order for queued take() calls (real-time)', async () => {
    const rl = createRateLimiter({ rps: 50, burst: 1 })
    await rl.take()
    const order = []
    const a = rl.take().then(() => order.push('a'))
    const b = rl.take().then(() => order.push('b'))
    await a
    await b
    expect(order).toEqual(['a', 'b'])
  })

  it('integrates with real setTimeout for a small window', async () => {
    const rl = createRateLimiter({ rps: 50, burst: 1 })
    await rl.take()
    await rl.take()
    expect(rl.tokens).toBeLessThanOrEqual(1)
  })

  it('does not refill beyond burst capacity', () => {
    const c = fixedClock(1_000_000)
    const rl = createRateLimiter({ rps: 10, burst: 5, clock: () => c.now })
    c.advance(60_000)
    expect(rl.tokens).toBe(5)
  })
})
