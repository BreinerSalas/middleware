import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { runSequentially, size, clear } = require('../src/core/shared/mutex.js')

describe('mutex (extended)', () => {
  it('size and clear report state', () => {
    clear()
    expect(size()).toBe(0)
    runSequentially('a', async () => {})
    expect(size()).toBeGreaterThanOrEqual(1)
    clear()
    expect(size()).toBe(0)
  })

  it('safePrev falls back to Promise.resolve when previous is not a promise', async () => {
    // Run a job under a never-before-used key with no previous chain.
    clear()
    const fn = async () => 'done'
    const p = runSequentially('fresh-key', fn)
    expect(await p).toBe('done')
  })

  it('chains work even when previous rejects synchronously via the swallowed tracker', async () => {
    clear()
    // First throws; second must still run.
    const a = runSequentially('k-chain', async () => { throw new Error('boom') }).catch(() => 'caught')
    const b = runSequentially('k-chain', async () => 'ok')
    const [ar, br] = await Promise.all([a, b])
    expect(ar).toBe('caught')
    expect(br).toBe('ok')
  })
})
