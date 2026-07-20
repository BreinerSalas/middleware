import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { TransientSyncError, AppError, SkipSyncError } = require('../../src/core/domain/errors.js')

describe('errors (extended)', () => {
  it('TransientSyncError stores cause and code', () => {
    const cause = new Error('inner')
    const e = new TransientSyncError('outer', { httpStatus: 502, code: 'BAD_GATEWAY', cause })
    expect(e.transient).toBe(true)
    expect(e.httpStatus).toBe(502)
    expect(e.code).toBe('BAD_GATEWAY')
    expect(e.cause).toBe(cause)
  })

  it('TransientSyncError default code is TRANSIENT_SYNC', () => {
    const e = new TransientSyncError('outer')
    expect(e.code).toBe('TRANSIENT_SYNC')
  })

  it('SkipSyncError instance passes instanceof AppError and Error', () => {
    const e = new SkipSyncError('x')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(SkipSyncError)
  })
})
