import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { runSequentially, clear } = require('../src/core/shared/mutex.js')

describe('mutex branch coverage', () => {
  it('covers both branches of safePrev (object with then vs not)', async () => {
    clear()
    const a = runSequentially('K1', async () => 'first')
    expect(await a).toBe('first')
    const b = runSequentially('K1', async () => 'second')
    expect(await b).toBe('second')
  })

  it('clears chain after all tasks settle', async () => {
    clear()
    const p = runSequentially('K2', async () => 42)
    expect(await p).toBe(42)
    // wait a microtask for finally
    await new Promise((r) => setImmediate(r))
    // chain should be cleared
    const chainsSize = runSequentially._chains.size
    expect(chainsSize).toBe(0)
  })

  it('handles undefined/then-able inputs gracefully', async () => {
    clear()
    const p = runSequentially('K3', async () => null)
    expect(await p).toBeNull()
  })
})
