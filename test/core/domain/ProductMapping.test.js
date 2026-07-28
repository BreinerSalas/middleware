import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ProductMapping, buildProductMapping, recordSyncSuccess } = require('../../../src/core/domain/ProductMapping.js')

describe('ProductMapping (domain)', () => {
  it('buildProductMapping creates a record with required fields', () => {
    const m = buildProductMapping({
      odooId: 123,
      hsSku: 'AC-1170',
      hubspotId: '46034128180',
      action: 'created'
    })
    expect(m.odooId).toBe(123)
    expect(m.hsSku).toBe('AC-1170')
    expect(m.hubspotId).toBe('46034128180')
    expect(m.action).toBe('created')
    expect(m.syncedAt).toBeTruthy()
    expect(m.lastSyncedAt).toBe(m.syncedAt)
  })

  it('buildProductMapping coerces non-string hubspotId', () => {
    const m = buildProductMapping({ odooId: 1, hsSku: 'X', hubspotId: 46034128180, action: 'updated' })
    expect(typeof m.hubspotId).toBe('string')
    expect(m.hubspotId).toBe('46034128180')
  })

  it('buildProductMapping rejects missing odooId', () => {
    expect(() => buildProductMapping({ hsSku: 'X', hubspotId: 'Y', action: 'created' })).toThrow(/odooId/)
  })

  it('buildProductMapping rejects missing hsSku', () => {
    expect(() => buildProductMapping({ odooId: 1, hubspotId: 'Y', action: 'created' })).toThrow(/hsSku/)
  })

  it('buildProductMapping rejects missing hubspotId', () => {
    expect(() => buildProductMapping({ odooId: 1, hsSku: 'X', action: 'created' })).toThrow(/hubspotId/)
  })

  it('buildProductMapping rejects invalid action', () => {
    expect(() => buildProductMapping({ odooId: 1, hsSku: 'X', hubspotId: 'Y', action: 'unknown' })).toThrow(/action/)
  })

  it('recordSyncSuccess updates lastSyncedAt and applies action', () => {
    const original = buildProductMapping({ odooId: 1, hsSku: 'X', hubspotId: 'H-1', action: 'created' })
    const originalTime = original.syncedAt
    const updated = recordSyncSuccess({ mapping: original, action: 'updated', now: () => '2026-01-02T00:00:00.000Z' })
    expect(updated.action).toBe('updated')
    expect(updated.syncedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(updated.lastSyncedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(updated.createdAt).toBe(originalTime)
    expect(updated.hubspotId).toBe('H-1')
  })

  it('ProductMapping class wraps a plain object', () => {
    const m = new ProductMapping({ odooId: 1, hsSku: 'X', hubspotId: 'H-1', action: 'created', syncedAt: 'T' })
    expect(m.odooId).toBe(1)
    expect(m.syncedAt).toBe('T')
  })
})
