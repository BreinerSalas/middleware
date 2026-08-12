import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PartnerMapping, buildPartnerMapping, recordSyncSuccess, VALID_ACTIONS } = require('../../../src/core/domain/PartnerMapping.js')

describe('PartnerMapping (domain)', () => {
  it('buildPartnerMapping creates a record with required fields', () => {
    const m = buildPartnerMapping({
      odooId: 123,
      hubspotId: '46034128180',
      action: 'created'
    })
    expect(m.odooId).toBe(123)
    expect(m.odooPartnerId).toBe('123')
    expect(m.hubspotId).toBe('46034128180')
    expect(m.action).toBe('created')
    expect(m.syncedAt).toBeTruthy()
    expect(m.lastSyncedAt).toBe(m.syncedAt)
    expect(m.createdAt).toBe(m.syncedAt)
  })

  it('buildPartnerMapping derives odooPartnerId from String(odooId) so the property value stays in sync', () => {
    const m = buildPartnerMapping({ odooId: 9999, hubspotId: 'H', action: 'updated' })
    expect(m.odooPartnerId).toBe('9999')
  })

  it('buildPartnerMapping coerces non-string hubspotId', () => {
    const m = buildPartnerMapping({ odooId: 1, hubspotId: 46034128180, action: 'updated' })
    expect(typeof m.hubspotId).toBe('string')
    expect(m.hubspotId).toBe('46034128180')
  })

  it('buildPartnerMapping coerces string odooId to Number', () => {
    const m = buildPartnerMapping({ odooId: '42', hubspotId: 'H', action: 'created' })
    expect(m.odooId).toBe(42)
    expect(typeof m.odooId).toBe('number')
  })

  it('buildPartnerMapping rejects null/undefined odooId', () => {
    expect(() => buildPartnerMapping({ hubspotId: 'Y', action: 'created' })).toThrow(/odooId/)
    expect(() => buildPartnerMapping({ odooId: null, hubspotId: 'Y', action: 'created' })).toThrow(/odooId/)
  })

  it('buildPartnerMapping rejects null/undefined hubspotId', () => {
    expect(() => buildPartnerMapping({ odooId: 1, action: 'created' })).toThrow(/hubspotId/)
    expect(() => buildPartnerMapping({ odooId: 1, hubspotId: null, action: 'created' })).toThrow(/hubspotId/)
  })

  it('buildPartnerMapping rejects invalid action', () => {
    expect(() => buildPartnerMapping({ odooId: 1, hubspotId: 'Y', action: 'unknown' })).toThrow(/action/)
    expect(() => buildPartnerMapping({ odooId: 1, hubspotId: 'Y', action: '' })).toThrow(/action/)
  })

  it('buildPartnerMapping only accepts the two documented actions', () => {
    expect(VALID_ACTIONS.has('created')).toBe(true)
    expect(VALID_ACTIONS.has('updated')).toBe(true)
    expect(VALID_ACTIONS.has('backfilled')).toBe(false)
    expect(VALID_ACTIONS.has('attempted')).toBe(false)
  })

  it('buildPartnerMapping uses the injected clock for syncedAt/lastSyncedAt/createdAt', () => {
    const m = buildPartnerMapping({
      odooId: 1, hubspotId: 'H', action: 'created',
      now: () => '2026-01-01T00:00:00.000Z'
    })
    expect(m.syncedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(m.lastSyncedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(m.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('recordSyncSuccess updates lastSyncedAt and applies the new action', () => {
    const original = buildPartnerMapping({ odooId: 1, hubspotId: 'H-1', action: 'created' })
    const originalCreatedAt = original.createdAt
    const originalSyncedAt = original.syncedAt
    const updated = recordSyncSuccess({
      mapping: original,
      action: 'updated',
      now: () => '2026-01-02T00:00:00.000Z'
    })
    expect(updated.action).toBe('updated')
    expect(updated.syncedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(updated.lastSyncedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(updated.createdAt).toBe(originalCreatedAt)
    expect(updated.odooId).toBe(1)
    expect(updated.odooPartnerId).toBe('1')
    expect(updated.hubspotId).toBe('H-1')
    // original is left untouched
    expect(original.createdAt).toBe(originalSyncedAt)
  })

  it('recordSyncSuccess rejects null mapping', () => {
    expect(() => recordSyncSuccess({ mapping: null, action: 'updated' })).toThrow(/mapping/)
  })

  it('recordSyncSuccess rejects invalid action', () => {
    const m = buildPartnerMapping({ odooId: 1, hubspotId: 'H', action: 'created' })
    expect(() => recordSyncSuccess({ mapping: m, action: 'unknown' })).toThrow(/action/)
  })

  it('PartnerMapping class wraps a plain object', () => {
    const m = new PartnerMapping({
      odooId: 1, odooPartnerId: '1', hubspotId: 'H-1', action: 'created', syncedAt: 'T'
    })
    expect(m.odooId).toBe(1)
    expect(m.odooPartnerId).toBe('1')
    expect(m.hubspotId).toBe('H-1')
    expect(m.action).toBe('created')
    expect(m.syncedAt).toBe('T')
  })
})
