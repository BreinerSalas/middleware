import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { SyncAuditEntry } = require('../../src/core/domain/SyncAuditEntry.js')

describe('SyncAuditEntry (extended)', () => {
  it('accepts jobId and correlationId', () => {
    const e = new SyncAuditEntry({ jobId: 'J-1', sourceId: 'D-1', correlationId: 'C-1', event: 'job.completed' })
    expect(e.jobId).toBe('J-1')
    expect(e.correlationId).toBe('C-1')
    expect(e.toJSON().jobId).toBe('J-1')
  })
})
