import { describe, it, expect } from 'vitest'
import { runSequentially } from '../src/core/shared/mutex.js'
import { buildDedupeKey, hashPayload } from '../src/core/shared/hash.js'
import { createEchoGuard } from '../src/core/shared/echoGuard.js'

describe('shared/mutex', () => {
  it('runs tasks under the same key sequentially', async () => {
    const order = []
    const a = runSequentially('k', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a') })
    const b = runSequentially('k', async () => { order.push('b') })
    await Promise.all([a, b])
    expect(order).toEqual(['a', 'b'])
    expect(runSequentially._chains.has('k')).toBe(false)
  })

  it('runs under different keys in parallel', async () => {
    const order = []
    const a = runSequentially('a', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a') })
    const b = runSequentially('b', async () => { order.push('b') })
    await Promise.all([a, b])
    expect(order.sort()).toEqual(['a', 'b'])
  })

  it('keeps chain alive even when previous rejects', async () => {
    let count = 0
    const a = runSequentially('x', async () => { count += 1; throw new Error('boom') }).catch(() => undefined)
    const b = runSequentially('x', async () => { count += 1 })
    await Promise.all([a, b])
    expect(count).toBe(2)
  })
})

describe('shared/hash', () => {
  it('buildDedupeKey is stable for same inputs', () => {
    expect(buildDedupeKey({ sourceId: 'D-1', rawPayload: { x: 1 } })).toBe(buildDedupeKey({ sourceId: 'D-1', rawPayload: { x: 1 } }))
  })
  it('buildDedupeKey differs on payload change', () => {
    expect(buildDedupeKey({ sourceId: 'D-1', rawPayload: { x: 1 } })).not.toBe(buildDedupeKey({ sourceId: 'D-1', rawPayload: { x: 2 } }))
  })
  it('buildDedupeKey requires sourceId', () => {
    expect(() => buildDedupeKey({ rawPayload: {} })).toThrow(/sourceId/)
  })
  it('hashPayload returns null for null', () => {
    expect(hashPayload(null)).toBeNull()
  })
})

describe('shared/echoGuard', () => {
  it('suppresses first write within ttl, allows after', () => {
    let now = 1000
    const clock = () => now
    const g = createEchoGuard({ ttlMs: 500, clock })
    expect(g.shouldSuppress('k1')).toBe(false)
    expect(g.shouldSuppress('k1')).toBe(true)
    now += 600
    expect(g.shouldSuppress('k1')).toBe(false)
  })

  it('clear and size', () => {
    const g = createEchoGuard({ ttlMs: 1000, clock: () => 0 })
    g.shouldSuppress('a')
    expect(g.size()).toBe(1)
    g.clear()
    expect(g.size()).toBe(0)
  })
})
