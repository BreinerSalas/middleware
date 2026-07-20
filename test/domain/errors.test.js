import { describe, it, expect } from 'vitest'
import { AppError, SkipSyncError, TransientSyncError } from '../../src/core/domain/errors.js'

describe('errors', () => {
  it('AppError carries code', () => {
    const e = new AppError('x', { code: 'CUSTOM' })
    expect(e.code).toBe('CUSTOM')
    expect(e).toBeInstanceOf(Error)
  })

  it('SkipSyncError carries reason', () => {
    const e = new SkipSyncError('no items', { detail: { foo: 'bar' } })
    expect(e.reason).toBe('no items')
    expect(e.code).toBe('SKIP_SYNC')
    expect(e.detail).toEqual({ foo: 'bar' })
  })

  it('TransientSyncError is retryable', () => {
    const e = new TransientSyncError('boom', { httpStatus: 503 })
    expect(e.transient).toBe(true)
    expect(e.httpStatus).toBe(503)
  })
})
