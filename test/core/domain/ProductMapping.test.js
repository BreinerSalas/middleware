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
    // (openspec/hubspot-product-odoo-id-key) hsSku is now optional; this case asserts the
    // OLD contract no longer holds — replaced below by the "accepts null/absent hsSku" cases.
    expect(() => buildProductMapping({ odooId: 1, hubspotId: 'Y', action: 'created' })).not.toThrow()
  })

  it('buildProductMapping accepts null hsSku and returns hsSku: null (no-SKU product, openspec/hubspot-product-odoo-id-key)', () => {
    const m = buildProductMapping({ odooId: 42, hsSku: null, hubspotId: 'H-1', action: 'created' })
    expect(m.hsSku).toBe(null)
    expect(m.odooId).toBe(42)
    expect(m.hubspotId).toBe('H-1')
    expect(m.action).toBe('created')
  })

  it('buildProductMapping accepts undefined hsSku (key omitted) and returns hsSku: null', () => {
    const m = buildProductMapping({ odooId: 42, hubspotId: 'H-1', action: 'updated' })
    expect(m.hsSku).toBe(null)
  })

  it('buildProductMapping accepts false hsSku and returns hsSku: null', () => {
    const m = buildProductMapping({ odooId: 42, hsSku: false, hubspotId: 'H-1', action: 'updated' })
    expect(m.hsSku).toBe(null)
  })

  it('buildProductMapping accepts empty-string hsSku and returns hsSku: null', () => {
    const m = buildProductMapping({ odooId: 42, hsSku: '   ', hubspotId: 'H-1', action: 'updated' })
    expect(m.hsSku).toBe(null)
  })

  it('buildProductMapping still requires odooId', () => {
    expect(() => buildProductMapping({ hsSku: null, hubspotId: 'Y', action: 'created' })).toThrow(/odooId/)
  })

  it('buildProductMapping still requires hubspotId', () => {
    expect(() => buildProductMapping({ odooId: 1, hsSku: null, action: 'created' })).toThrow(/hubspotId/)
  })

  it('buildProductMapping still requires a valid action', () => {
    expect(() => buildProductMapping({ odooId: 1, hsSku: null, hubspotId: 'Y', action: 'nope' })).toThrow(/action/)
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
