import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { SyncMapping, hashPayload } = require('../../src/core/domain/SyncMapping.js')

describe('SyncMapping (extended)', () => {
  it('applyUpsert with no payloadHash keeps previous', () => {
    const m = new SyncMapping({ sourceId: 'D-1', payloadHash: 'orig' })
    m.applyUpsert({ targetId: 'T-2' })
    expect(m.targetId).toBe('T-2')
    expect(m.payloadHash).toBe('orig')
  })

  it('applyUpsert with metadata merges into existing', () => {
    const m = new SyncMapping({ sourceId: 'D-1', metadata: { a: 1 } })
    m.applyUpsert({ targetId: 'T-2', metadata: { b: 2 } })
    expect(m.metadata).toEqual({ a: 1, b: 2 })
  })

  it('toJSON returns expected shape', () => {
    const m = new SyncMapping({ sourceId: 'D-1', targetId: 'T-1', targetRef: 'R', payloadHash: 'h', metadata: { x: 1 } })
    const j = m.toJSON()
    expect(j.sourceId).toBe('D-1')
    expect(j.targetId).toBe('T-1')
    expect(j.targetRef).toBe('R')
    expect(j.payloadHash).toBe('h')
    expect(j.metadata).toEqual({ x: 1 })
  })

  it('hashPayload with string payload is hashed', () => {
    const a = hashPayload('hello')
    const b = hashPayload('hello')
    expect(a).toBe(b)
    expect(a).toHaveLength(32)
  })
})
