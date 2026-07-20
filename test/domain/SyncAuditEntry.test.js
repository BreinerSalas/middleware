import { describe, it, expect } from 'vitest'
import { SyncAuditEntry } from '../../src/core/domain/SyncAuditEntry.js'

describe('SyncAuditEntry', () => {
  it('requires sourceId and event', () => {
    expect(() => new SyncAuditEntry({ event: 'x' })).toThrow(/sourceId/)
    expect(() => new SyncAuditEntry({ sourceId: 'D-1' })).toThrow(/event/)
  })

  it('is frozen (append-only)', () => {
    const e = new SyncAuditEntry({ sourceId: 'D-1', event: 'job.completed' })
    expect(() => { e.event = 'other' }).toThrow()
  })

  it('serializes success=false', () => {
    const e = new SyncAuditEntry({ sourceId: 'D-1', event: 'job.skipped', success: false })
    expect(e.success).toBe(false)
    expect(e.toJSON().success).toBe(false)
  })
})
