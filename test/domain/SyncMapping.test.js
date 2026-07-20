import { describe, it, expect } from 'vitest'
import { SyncMapping, hashPayload } from '../../src/core/domain/SyncMapping.js'

describe('SyncMapping', () => {
  it('requires sourceId', () => {
    expect(() => new SyncMapping({})).toThrow(/requires sourceId/)
  })

  it('applyUpsert is idempotent on sourceId', () => {
    const m = new SyncMapping({ sourceId: 'D-1' })
    m.applyUpsert({ targetId: 'T-1', payloadHash: 'h1' })
    m.applyUpsert({ targetId: 'T-2', payloadHash: 'h2' })
    expect(m.targetId).toBe('T-2')
    expect(m.payloadHash).toBe('h2')
    expect(m.lastSyncedAt).toBeInstanceOf(Date)
  })

  it('hashPayload is stable', () => {
    const a = hashPayload({ x: 1, y: [1, 2] })
    const b = hashPayload({ x: 1, y: [1, 2] })
    const c = hashPayload({ x: 1, y: [1, 3] })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toHaveLength(32)
  })
})
