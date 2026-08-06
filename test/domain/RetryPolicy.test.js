import { describe, it, expect } from 'vitest'
import { isRetryableError, isPermanentHttpError, calculateNextRetry, shouldDeadLetter } from '../../src/core/domain/RetryPolicy.js'
import { TransientSyncError } from '../../src/core/domain/errors.js'

describe('RetryPolicy', () => {
  describe('isRetryableError', () => {
    it('returns false for null/undefined', () => {
      expect(isRetryableError(null)).toBe(false)
      expect(isRetryableError(undefined)).toBe(false)
    })

    it('returns true for retryable HTTP statuses', () => {
      for (const s of [408, 409, 425, 429, 500, 502, 503, 504]) {
        expect(isRetryableError({ httpStatus: s })).toBe(true)
      }
    })

    it('returns false for non-retryable HTTP statuses', () => {
      for (const s of [400, 401, 403, 404, 422]) {
        expect(isRetryableError({ httpStatus: s })).toBe(false)
      }
    })

    it('returns true for retryable network codes', () => {
      for (const c of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED']) {
        expect(isRetryableError({ code: c })).toBe(true)
      }
    })

    it('returns true for transient-marked errors', () => {
      expect(isRetryableError({ transient: true })).toBe(true)
      const err = new Error('x')
      err.transient = true
      expect(isRetryableError(err)).toBe(true)
    })

    it('returns true for TransientSyncError', () => {
      const e = new TransientSyncError('boom')
      expect(isRetryableError(e)).toBe(true)
    })

    it('reads status from response.status', () => {
      expect(isRetryableError({ response: { status: 503 } })).toBe(true)
      expect(isRetryableError({ response: { status: 404 } })).toBe(false)
    })
  })

  describe('isPermanentHttpError (Fase 6 — no bloquear el cursor con fallos que nunca se van a resolver)', () => {
    it('returns false for null/undefined', () => {
      expect(isPermanentHttpError(null)).toBe(false)
      expect(isPermanentHttpError(undefined)).toBe(false)
    })

    it('returns true for non-retryable 4xx statuses (404, 400, etc.)', () => {
      for (const s of [400, 401, 403, 404, 422]) {
        expect(isPermanentHttpError({ httpStatus: s })).toBe(true)
      }
    })

    it('returns false for retryable statuses, even though they are 4xx (408, 409, 425, 429)', () => {
      for (const s of [408, 409, 425, 429]) {
        expect(isPermanentHttpError({ httpStatus: s })).toBe(false)
      }
    })

    it('returns false for 5xx server errors', () => {
      for (const s of [500, 502, 503, 504]) {
        expect(isPermanentHttpError({ httpStatus: s })).toBe(false)
      }
    })

    it('returns false for a generic error with no status (safe default: block/retry)', () => {
      expect(isPermanentHttpError(new Error('boom'))).toBe(false)
    })

    it('honors an explicit transient flag over the status', () => {
      expect(isPermanentHttpError({ httpStatus: 404, transient: true })).toBe(false)
      expect(isPermanentHttpError({ httpStatus: 500, transient: false })).toBe(true)
    })
  })

  describe('calculateNextRetry', () => {
    it('grows exponentially within bounds', () => {
      const t0 = calculateNextRetry({ attempts: 0, baseMs: 1000, jitter: false, now: 1_000_000 })
      const t1 = calculateNextRetry({ attempts: 1, baseMs: 1000, jitter: false, now: 1_000_000 })
      const t3 = calculateNextRetry({ attempts: 3, baseMs: 1000, jitter: false, now: 1_000_000 })
      expect(t0.getTime() - 1_000_000).toBe(1000)
      expect(t1.getTime() - 1_000_000).toBe(2000)
      expect(t3.getTime() - 1_000_000).toBe(8000)
    })

    it('respects maxDelayMs', () => {
      const t = calculateNextRetry({ attempts: 20, baseMs: 1000, maxDelayMs: 5000, jitter: false, now: 0 })
      expect(t.getTime()).toBe(5000)
    })

    it('adds jitter inside [0, baseMs)', () => {
      const samples = Array.from({ length: 50 }, () => calculateNextRetry({ attempts: 2, baseMs: 1000, now: 0 }))
      for (const s of samples) {
        const off = s.getTime() - 4000
        expect(off).toBeGreaterThanOrEqual(0)
        expect(off).toBeLessThanOrEqual(1000)
      }
    })
  })

  describe('shouldDeadLetter', () => {
    it('when attempts >= maxAttempts', () => {
      expect(shouldDeadLetter({ attempts: 8, maxAttempts: 8, error: new Error('x') })).toBe(true)
    })

    it('when error is explicitly non-transient', () => {
      const e = new Error('nope')
      e.transient = false
      expect(shouldDeadLetter({ attempts: 0, maxAttempts: 8, error: e })).toBe(true)
    })

    it('false otherwise', () => {
      expect(shouldDeadLetter({ attempts: 2, maxAttempts: 8, error: new Error('x') })).toBe(false)
    })
  })
})
